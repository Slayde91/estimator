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


def _copy_annotations(writer, original, page):
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
        if not isinstance(annotation, dict) or annotation.get('/Subtype') not in STATIC_ANNOTATIONS:
            raise ValueError('Form widgets, attachments and dynamic PDF annotations cannot be copied safely. Use a plain drawing PDF; originals are unchanged.')
        clean = DictionaryObject({key: item for key, item in annotation.items() if key not in ignored}).clone(writer)
        reference = writer._add_object(clean)
        clean[NameObject('/P')] = page.indirect_reference
        originals.append(annotation); copies.append(clean)
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
    return len(copies)


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


def compose(spec, output):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject, FloatObject, RectangleObject
    if not isinstance(spec, dict) or set(spec) != {'sources', 'page_order'}:
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
                annotation_count += _copy_annotations(writer, original, page)
                if annotation_count > MAX_ANNOTATIONS:
                    raise ValueError('The selected PDF annotations exceed their bounded copy limit.')
                cloned[(index, number)] = page
            layers = _layer_configuration(writer, reader)
            if layers: configurations.append(layers)
    # add_page above populated this writer's reference translation tables. Keep
    # those same objects and rewrite only the new page tree ordering.
    pages_root = writer._pages.get_object()
    from pypdf.generic import ArrayObject
    pages_root[NameObject('/Kids')] = ArrayObject([cloned[(value['source'], value['page'])].indirect_reference for value in order])
    pages_root[NameObject('/Count')] = NumberObject(len(order))
    layers = _combine_layers(configurations)
    if layers: writer._root_object[NameObject('/OCProperties')] = layers
    writer.add_metadata({'/Title': 'CEASEFIRE PDF page tools', '/Creator': 'CEASEFIRE ESTIMATOR',
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
    expected = [{**sources[value['source']]['pages'][value['page']-1], 'page': index} for index, value in enumerate(order, 1)]
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
