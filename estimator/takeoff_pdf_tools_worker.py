"""Isolated, bounded page copying. The original streams are never modified."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile

if __package__:
    from . import takeoff_pdf_worker as limits
else:
    import importlib.util
    _spec = importlib.util.spec_from_file_location('_ceasefire_pdf_limits', Path(__file__).with_name('takeoff_pdf_worker.py'))
    limits = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(limits)

MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_CONTENT_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = limits.MAX_DOCUMENT_SIZE
MAX_ANNOTATIONS = 10000
STATIC_ANNOTATIONS = {'/Text', '/FreeText', '/Line', '/Square', '/Circle', '/Polygon', '/PolyLine',
                      '/Highlight', '/Underline', '/Squiggly', '/StrikeOut', '/Stamp', '/Caret',
                      '/Ink', '/Popup', '/Link', '/Redact'}


def _static_plan_appearance(writer, annotation):
    """Print the source's normal appearance as an inert stamp, without widget or media actions."""
    from pypdf.generic import DictionaryObject, NameObject, NumberObject, StreamObject
    flags = int(annotation.get('/F', 0))
    if flags & 3:  # Invisible or hidden annotations have no plan appearance.
        return None
    appearance = annotation.get('/AP')
    appearance = appearance.get_object().get('/N') if appearance else None
    appearance = appearance.get_object() if appearance else None
    if isinstance(appearance, dict) and not isinstance(appearance, StreamObject):
        state = annotation.get('/AS')
        appearance = appearance.get(state) if state in appearance else None
        appearance = appearance.get_object() if appearance else None
    if not isinstance(appearance, StreamObject):
        raise ValueError('A visible interactive element has no saved appearance. Save a print-ready copy of the drawing.')
    return DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Stamp'),
        NameObject('/Rect'): annotation['/Rect'].clone(writer), NameObject('/F'): NumberObject(4),
        NameObject('/AP'): DictionaryObject({NameObject('/N'): appearance.clone(writer).indirect_reference})})


def _copy_annotations(writer, original, page, *, static_plan=False):
    """Keep static comment/markup appearances; never copy executable actions.

    A new /AcroForm would need a complete field-tree reconstruction and review.
    Widgets and dynamic media are declined instead of leaving orphaned fields.
    """
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject
    values = original.get('/Annots', [])
    values = values.get_object() if hasattr(values, 'get_object') else values
    if not isinstance(values, list) or len(values) > MAX_ANNOTATIONS:
        raise ValueError('The source page has too many or invalid annotations.')
    originals, copies, references = [], [], {}
    ignored = {'/A', '/AA', '/Dest', '/P', '/Parent', '/Popup', '/IRT', '/FS', '/EF', '/AF'}
    for value in values:
        annotation = value.get_object()
        if not isinstance(annotation, dict):
            raise ValueError('The source page contains an invalid annotation.')
        if annotation.get('/Subtype') in STATIC_ANNOTATIONS:
            clean = DictionaryObject({key: item for key, item in annotation.items() if key not in ignored}).clone(writer)
        elif static_plan:
            clean = _static_plan_appearance(writer, annotation)
            if clean is None:
                continue
        else:
            raise ValueError('Form widgets, attachments and dynamic PDF annotations cannot be copied safely. Use a plain drawing PDF; originals are unchanged.')
        reference = writer._add_object(clean)
        clean[NameObject('/P')] = page.indirect_reference
        # A widget's /Parent is a form field, not a page annotation relationship.
        originals.append(annotation if annotation.get('/Subtype') in STATIC_ANNOTATIONS else {})
        copies.append(clean)
        identity = getattr(value, 'indirect_reference', None) or value
        if hasattr(identity, 'idnum'):
            references[(identity.idnum, identity.generation)] = reference
    for annotation, clean in zip(originals, copies):
        for key in ('/Parent', '/Popup', '/IRT'):
            relation = annotation.get(key)
            if relation is not None:
                identity = getattr(relation, 'indirect_reference', None) or relation
                target = references.get((getattr(identity, 'idnum', None), getattr(identity, 'generation', None)))
                if target is None:
                    raise ValueError('A PDF comment relationship points outside its copied page.')
                clean[NameObject(key)] = target
    if copies: page[NameObject('/Annots')] = ArrayObject([value.indirect_reference for value in copies])
    return len(values)


def _layer_configuration(writer, reader):
    """Clone with the page translation table, keeping OCG resource identities."""
    layers = reader.trailer['/Root'].get('/OCProperties')
    return layers.get_object().clone(writer) if layers else None


def _combine_layers(configurations):
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject
    if not configurations:
        return None
    if len(configurations) == 1:
        return configurations[0]
    groups, on, off, order, locked, radios, automatic, intents = [], [], [], [], [], [], [], []
    for config in configurations:
        if config.get('/Configs'):
            raise ValueError('PDFs with alternate layer configurations cannot be merged faithfully. Use default drawing layers or prepare a plain PDF.')
        current = list(config.get('/OCGs', [])); default = config.get('/D')
        default = default.get_object() if hasattr(default, 'get_object') else default or {}
        state = default.get('/BaseState', '/ON')
        if state not in ('/ON', '/OFF'):
            raise ValueError('This PDF has an unsupported default layer state.')
        enabled = set(default.get('/ON', [])); disabled = set(default.get('/OFF', []))
        if enabled & disabled or (enabled | disabled) - set(current):
            raise ValueError('The PDF layer configuration does not identify its drawing groups exactly.')
        groups.extend(current)
        for group in current:
            (off if group in disabled or state == '/OFF' and group not in enabled else on).append(group)
        if default.get('/Order'): order.append(ArrayObject([TextStringObject('Source drawing layers'), *default['/Order']]))
        locked.extend(default.get('/Locked', [])); radios.extend(default.get('/RBGroups', [])); automatic.extend(default.get('/AS', []))
        intent = default.get('/Intent', NameObject('/View'))
        for value in intent if isinstance(intent, list) else [intent]:
            if value not in intents: intents.append(value)
    default = DictionaryObject({NameObject('/Name'): TextStringObject('Merged drawing layers'),
        NameObject('/BaseState'): NameObject('/ON'), NameObject('/ON'): ArrayObject(on), NameObject('/OFF'): ArrayObject(off),
        NameObject('/Order'): ArrayObject(order), NameObject('/Intent'): ArrayObject(intents)})
    for key, values in (('/Locked', locked), ('/RBGroups', radios), ('/AS', automatic)):
        if values: default[NameObject(key)] = ArrayObject(values)
    return DictionaryObject({NameObject('/OCGs'): ArrayObject(groups), NameObject('/D'): default})


def _draw_pins(page, info, marks):
    """Draw in the same upright, cropped coordinate system as the PDF.js viewport."""
    from pypdf import PdfReader
    from reportlab.pdfgen.canvas import Canvas
    x0, y0, x1, y1 = info['view']
    rotation = info['rotation']
    width, height = x1 - x0, y1 - y0
    if rotation in (90, 270):
        width, height = height, width
    # Inverse viewport transform, from upright bottom-left to source PDF units.
    transforms = {0: (1, 0, 0, 1, x0, y0), 90: (0, 1, -1, 0, x1, y0),
                  180: (-1, 0, 0, -1, x1, y1), 270: (0, -1, 1, 0, x0, y1)}
    stream = BytesIO()
    canvas = Canvas(stream, pagesize=(width, height), invariant=True)
    # Each label reserves one slot. For crowded sheets size the grid for all
    # pins first, then look up an unused slot without scanning prior labels.
    longest = max(canvas.stringWidth(mark['label'], 'Helvetica-Bold', 9) for mark in marks)
    scale = min(width, height) / 550
    def slots():
        return max(1, int(width / ((longest + 10) * scale))), max(1, int(height / (16 * scale)))
    columns, rows = slots()
    while columns * rows < len(marks):
        scale *= min(.9, (columns * rows / len(marks)) ** .5)
        columns, rows = slots()
    slot_width, slot_height = width / columns, height / rows
    taken = {}
    def next_free(index):
        root = index
        while root in taken:
            root = taken[root]
        while index in taken:
            old = taken[index]
            taken[index] = root
            index = old
        return root
    # First try nearby slots, then the next available slot in reading order.
    offsets = sorted(((dx, dy) for dx in range(-2, 3) for dy in range(-2, 3)),
                     key=lambda delta: delta[0]**2 + delta[1]**2)
    for mark in marks:
        x, y = mark['x'] * width, (1 - mark['y']) * height
        size = min(9 * scale, width / 18)
        text = mark['label']
        box_w = canvas.stringWidth(text, 'Helvetica-Bold', size) + 6 * scale
        box_h = 14 * scale
        left = x + 8 * scale if x + 8 * scale + box_w <= width else x - 8 * scale - box_w
        col = max(0, min(columns - 1, int(left / slot_width)))
        row = max(0, min(rows - 1, int((y + 6 * scale) / slot_height)))
        slot = next(((row + dy) * columns + col + dx for dx, dy in offsets
                     if 0 <= col + dx < columns and 0 <= row + dy < rows
                     and (row + dy) * columns + col + dx not in taken), None)
        if slot is None:
            slot = next_free(row * columns + col)
            if slot >= columns * rows:
                slot = next_free(0)
        taken[slot] = next_free(slot + 1)
        left_edge, bottom_edge = slot % columns * slot_width, slot // columns * slot_height
        left = max(left_edge, min(left_edge + slot_width - box_w, left))
        bottom = max(bottom_edge, min(bottom_edge + slot_height - box_h, y + 6 * scale))
        canvas.setStrokeColorRGB(.78, 0, .12)
        canvas.setLineWidth(1.3 * scale)
        canvas.line(x, y, min(max(x, left), left + box_w), min(max(y, bottom), bottom + box_h))
        canvas.setFillColorRGB(.78, 0, .12)
        canvas.setStrokeColorRGB(1, 1, 1)
        canvas.circle(x, y, 3.5 * scale, stroke=1, fill=1)
        canvas.roundRect(left, bottom, box_w, box_h, 2 * scale, fill=1, stroke=1)
        canvas.setFillColorRGB(1, 1, 1)
        canvas.setFont('Helvetica-Bold', size)
        canvas.drawString(left + 3 * scale, bottom + (box_h - size) / 2 + size * .16, text)
    canvas.save()
    stream.seek(0)
    page.merge_transformed_page(PdfReader(stream).pages[0], transforms[rotation], expand=False)


def compose(spec, output):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject, FloatObject, RectangleObject
    if not isinstance(spec, dict) or set(spec) not in ({'sources', 'page_order'}, {'sources', 'page_order', 'register', 'pins'}):
        raise ValueError('Invalid PDF page-tools specification.')
    sources, order = spec['sources'], spec['page_order']
    if (not isinstance(sources, list) or not 1 <= len(sources) <= 100
            or not isinstance(order, list) or not 1 <= len(order) <= limits.MAX_PAGES):
        raise ValueError('PDF source or output page limit exceeded.')
    for value in order:
        if (not isinstance(value, dict) or set(value) != {'source', 'page'}
                or type(value['source']) is not int or not 0 <= value['source'] < len(sources)
                or type(value['page']) is not int or not 1 <= value['page'] <= len(sources[value['source']]['pages'])):
            raise ValueError('Choose existing source pages in the required output order.')
    if len({(value['source'], value['page']) for value in order}) != len(order):
        raise ValueError('Choose each source page once.')
    # Process each source once, closing handles before opening the next source.
    # Cloned pages are later assembled in the exact requested order.
    writer = PdfWriter(); cloned = {}; configurations = []; source_bytes = content_bytes = annotation_count = 0
    prefix, prefix_refs, marks = [], [], {}
    if 'register' in spec:
        if not isinstance(spec['pins'], list) or len(spec['pins']) != len(order):
            raise ValueError('Each selected plan page must contain register pins.')
        with Path(spec['register']).open('rb') as stream:
            prefix = limits.parse_pdf_stream(stream)['pages']
            stream.seek(0)
            reader = PdfReader(stream, strict=True)
            for page in reader.pages:
                prefix_refs.append(writer.add_page(page).indirect_reference)
        marks = {(value['source'], value['page']): pins for value, pins in zip(order, spec['pins'])}
    for index, spec_source in enumerate(sources):
        if not isinstance(spec_source, dict) or set(spec_source) != {'path', 'sha256', 'size', 'pages'}:
            raise ValueError('Invalid retained PDF source specification.')
        with tempfile.TemporaryFile(mode='w+b') as source:
            checksum = sha256(); size = 0
            with Path(spec_source['path']).open('rb') as original:
                while chunk := original.read(1024*1024):
                    size += len(chunk); source_bytes += len(chunk)
                    if size > limits.MAX_DOCUMENT_SIZE or source_bytes > limits.MAX_DOCUMENT_SIZE:
                        raise ValueError('Selected source PDFs exceed the combined 250 MiB limit.')
                    checksum.update(chunk); source.write(chunk)
            if size != spec_source['size'] or checksum.hexdigest() != spec_source['sha256']:
                raise ValueError('A retained source PDF changed before the page operation.')
            source.seek(0); metadata = limits.parse_pdf_stream(source)
            if metadata['pages'] != spec_source['pages']:
                raise ValueError('Retained source page geometry changed before the page operation.')
            source.seek(0); reader = PdfReader(source, strict=True)
            for number in [value['page'] for value in order if value['source'] == index]:
                original = reader.pages[number-1]
                contents = original.get_contents(); count = len(contents.get_data()) if contents is not None else 0
                content_bytes += count
                if count > MAX_CONTENT_BYTES or content_bytes > MAX_OUTPUT_BYTES:
                    raise ValueError('Decoded drawing content exceeds the safe PDF page-tools limit.')
                page = writer.add_page(original, excluded_keys=('/Annots', '/AA', '/Metadata', '/PieceInfo'))
                # Explicit inherited geometry survives a new /Pages parent.
                info = spec_source['pages'][number-1]
                page[NameObject('/MediaBox')] = RectangleObject(info['media_box'])
                page[NameObject('/CropBox')] = RectangleObject(info['crop_box'])
                page[NameObject('/Rotate')] = NumberObject(info['rotation'])
                page[NameObject('/UserUnit')] = FloatObject(info['user_unit'])
                annotation_count += _copy_annotations(writer, original, page, static_plan=bool(prefix))
                if (index, number) in marks:
                    _draw_pins(page, info, marks[index, number])
                if annotation_count > MAX_ANNOTATIONS:
                    raise ValueError('The selected PDF annotations exceed their bounded copy limit.')
                cloned[(index, number)] = page
            layers = _layer_configuration(writer, reader)
            if layers: configurations.append(layers)
    # add_page above populated this writer's reference translation tables. Keep
    # those same objects and rewrite only the new page tree ordering.
    pages_root = writer._pages.get_object()
    from pypdf.generic import ArrayObject
    pages_root[NameObject('/Kids')] = ArrayObject(prefix_refs + [cloned[(value['source'], value['page'])].indirect_reference for value in order])
    pages_root[NameObject('/Count')] = NumberObject(len(prefix) + len(order))
    layers = _combine_layers(configurations)
    if layers: writer._root_object[NameObject('/OCProperties')] = layers
    writer.add_metadata({'/Title': 'Passive Fire Register' if prefix else 'CEASEFIRE PDF page tools',
                         '/Creator': 'CLASSIFIRE' if prefix else 'CEASEFIRE ESTIMATOR',
                         '/Subject': 'New PDF derivative; original source documents and Takeoff records retained unchanged'})
    class BoundedOutput:
        def __init__(self, stream): self.stream = stream
        def write(self, value):
            if self.stream.tell()+len(value) > MAX_OUTPUT_BYTES:
                raise ValueError('The derived PDF exceeds the 250 MiB output limit.')
            return self.stream.write(value)
        def __getattr__(self, name): return getattr(self.stream, name)
    with Path(output).open('xb') as stream: writer.write(BoundedOutput(stream))
    with Path(output).open('rb') as stream:
        actual = limits.parse_pdf_stream(stream)['pages']
    expected = prefix + [{**sources[value['source']]['pages'][value['page']-1], 'page': index}
                         for index, value in enumerate(order, len(prefix) + 1)]
    if actual != expected:
        raise ValueError('The derived PDF did not preserve its source page geometry exactly.')
    return actual


def main():
    try:
        limits.CPU_SECONDS = 60; limits.restrict_process()
        if len(sys.argv) != 3: raise ValueError('A bounded page request and private output are required.')
        with Path(sys.argv[1]).open('rb') as stream: raw = stream.read(MAX_SPEC_BYTES+1)
        if len(raw) > MAX_SPEC_BYTES: raise ValueError('PDF page-tools request exceeds its resource limit.')
        metadata = compose(json.loads(raw), sys.argv[2])
        output = Path(sys.argv[2]); size = output.stat().st_size
        if not 0 < size <= MAX_OUTPUT_BYTES: raise ValueError('PDF output exceeds its resource limit.')
        result = {'sha256': sha256(output.read_bytes()).hexdigest(), 'size': size, 'pages': len(metadata), 'metadata': metadata}
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else 'The PDF pages could not be prepared safely.'
        result = {'error': message[:300]}
    sys.stdout.write(json.dumps(result, allow_nan=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
