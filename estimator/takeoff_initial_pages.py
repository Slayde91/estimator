"""One atomic PDF-only batch, expanded into existing text/signature records."""
from copy import deepcopy
import math
from pathlib import Path
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_graphics import GRAPHIC_MODES, graphic_appearance, validate_graphic, visual_record_count, MAX_VISUAL_RECORDS
from .takeoff_model import number, object_fields, page_metadata, text
from .takeoff_signatures import signature_appearance, validate_signature, validate_strokes

FIELDS = {'mode', 'document_id', 'source_sha256', 'page', 'normalized_box', 'display_rotation',
          'text', 'strokes', 'signature_ratio', 'text_appearance', 'signature_appearance'}


def visible_point_pdf(page, x, y, rotation=None):
    """Top-left visible normalized point -> original retained PDF coordinates."""
    x0, y0, x1, y1 = page['view']
    x, y = min(1, max(0, x)), min(1, max(0, y))
    width, height = x1-x0, y1-y0
    rotation = page['rotation'] if rotation is None else rotation
    if rotation == 0:
        return [x0+x*width, y1-y*height]
    if rotation == 90:
        return [x0+y*width, y0+x*height]
    if rotation == 180:
        return [x1-x*width, y0+y*height]
    return [x1-y*width, y1-x*height]


def pdf_point_visible(page, point):
    x0, y0, x1, y1 = page['view']
    width, height = x1-x0, y1-y0
    x, y = point
    if page['rotation'] == 0:
        return [(x-x0)/width, (y1-y)/height]
    if page['rotation'] == 90:
        return [(y-y0)/height, (x-x0)/width]
    if page['rotation'] == 180:
        return [(x1-x)/width, (y-y0)/height]
    return [(y1-y)/height, (x1-x)/width]


def visible_size(page):
    x0, y0, x1, y1 = page['view']
    width, height = (x1-x0)*page['user_unit'], (y1-y0)*page['user_unit']
    return (height, width) if page['rotation'] in (90, 270) else (width, height)


def box_quad(page, box):
    x, y, width, height = box
    return [visible_point_pdf(page, px, py) for px, py in
            ((x, y), (x+width, y), (x+width, y+height), (x, y+height))]


def natural_box(page, box, display_rotation):
    x, y, width, height = box
    points = [pdf_point_visible(page, visible_point_pdf(page, px, py, display_rotation))
              for px, py in ((x, y), (x+width, y), (x+width, y+height), (x, y+height))]
    left, top = min(point[0] for point in points), min(point[1] for point in points)
    right, bottom = max(point[0] for point in points), max(point[1] for point in points)
    # Right-angle transforms can introduce only tiny floating point edge error.
    return [max(0, left), max(0, top), min(1, right)-max(0, left), min(1, bottom)-max(0, top)]


def fitted_signature_box(page, box, ratio, stroke_width):
    page_width, page_height = visible_size(page)
    width, height = box[2]*page_width-stroke_width, box[3]*page_height-stroke_width
    if width <= 0 or height <= 0:
        raise ValidationError('The Initial Pages rectangle is too small for the signature line width.')
    ink_width, ink_height = min(width, height*ratio), min(height, width/ratio)
    return [box[0]+(box[2]-ink_width/page_width)/2, box[1]+(box[3]-ink_height/page_height)/2,
            ink_width/page_width, ink_height/page_height]


def _fit_text(value, width, height, maximum):
    import reportlab
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    font = 'InitialPagesVera'
    if font not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font, str(Path(reportlab.__file__).parent / 'fonts/Vera.ttf')))
    if any(ord(character) not in pdfmetrics.getFont(font).face.charToGlyph for character in value):
        raise ValidationError('The entered initials contain a character unsupported by the PDF font.')
    padding = min(6, width/8, height/8)
    unit_width = pdfmetrics.stringWidth(value, font, 1)
    if unit_width <= 0:
        raise ValidationError('Initial Pages requires a visible name with positive text width.')
    size = min(maximum, (width-2*padding)/unit_width, (height-2*padding)/1.25)
    if size < 4:
        raise ValidationError('The Initial Pages rectangle is too small for the entered name. Enlarge it or shorten the name.')
    # Leave a deterministic tiny margin below the calculated maximum.
    return max(4, size*(1-1e-10))


def apply_initial_pages(snapshot, value):
    object_fields(value, FIELDS, 'Initial Pages', FIELDS)
    document, source_page = page_metadata(snapshot, value['document_id'], value['page'])
    if not isinstance(value['mode'], str) or value['mode'] not in GRAPHIC_MODES or value['source_sha256'] != document['sha256']:
        raise ValidationError('Initial Pages must identify the current drawing workspace and exact retained PDF.')
    if type(value['display_rotation']) is not int or value['display_rotation'] not in (0, 90, 180, 270):
        raise ValidationError('Initial Pages requires the displayed right-angle page rotation.')
    box = value['normalized_box']
    if not isinstance(box, list) or len(box) != 4:
        raise ValidationError('Initial Pages requires one normalized visible-page rectangle.')
    x, y, width, height = [number(coordinate, 'Initial Pages normalized rectangle') for coordinate in box]
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x+width > 1 or y+height > 1:
        raise ValidationError('The Initial Pages rectangle must stay inside the visible page.')
    name = text(value['text'], 'Initial Pages name or initials', 80)
    if any(character in '\r\n\t' or ord(character) in (0x007F, 0x061C, 0x200E, 0x200F,
            *range(0x202A, 0x202F), *range(0x2066, 0x206A)) for character in name):
        raise ValidationError('Enter one visible line for the Initial Pages name or initials.')
    has_text, has_signature = bool(name.strip()), value['strokes'] != []
    if not has_text and name != '' or not has_text and not has_signature:
        raise ValidationError('Enter a nonblank name or draw a signature for Initial Pages.')
    if has_signature:
        validate_strokes(value['strokes'])
        ratio = number(value['signature_ratio'], 'Initial Pages signature aspect ratio')
        if not .1 <= ratio <= 20:
            raise ValidationError('The Initial Pages signature aspect ratio must be between 0.1 and 20.')
    elif value['signature_ratio'] is not None:
        raise ValidationError('An Initial Pages name without ink must have no signature aspect ratio.')
    if visual_record_count(snapshot) + len(document['pages'])*(has_text+has_signature) > MAX_VISUAL_RECORDS:
        raise ValidationError(f'Initial Pages exceeds the project limit of {MAX_VISUAL_RECORDS} combined PDF-only visual records.')
    entered_style = graphic_appearance(value['text_appearance'])
    text_style = {**entered_style, **{'stroke_color': '#000000', 'stroke_width': .25}, **value['text_appearance']}
    ink_style = signature_appearance(value['signature_appearance'])
    x, y, width, height = natural_box(source_page, box, value['display_rotation'])
    graphics, signatures = [], []
    group_id = str(uuid4())
    for page in document['pages']:
        page_width, page_height = visible_size(page)
        binding = {'id': str(uuid4()), 'version': 1, 'mode': value['mode'], 'document_id': document['id'],
                   'source_sha256': document['sha256'], 'page': page['page']}
        if has_text:
            text_box = [x, y+height*.7, width, height*.3] if has_signature else [x, y, width, height]
            style = deepcopy(text_style)
            style['font_size'] = _fit_text(name, text_box[2]*page_width, text_box[3]*page_height, min(12, style['font_size']))
            record = {**binding, 'kind': 'textbox', 'geometry': {'quad_pdf': box_quad(page, text_box)},
                      'text': name, 'appearance': style,
                      'initial_pages': {'version': 1, 'group_id': group_id, 'role': 'text'}}
            validate_graphic(record, snapshot)
            graphics.append(record)
        if has_signature:
            ink_box = [x, y, width, height*.7] if has_text else [x, y, width, height]
            fitted = fitted_signature_box(page, ink_box, ratio, ink_style['stroke_width'])
            record = {**binding, 'id': str(uuid4()), 'quad_pdf': box_quad(page, fitted),
                      'strokes': deepcopy(value['strokes']), 'appearance': deepcopy(ink_style),
                      'initial_pages': {'version': 1, 'group_id': group_id, 'role': 'signature'}}
            validate_signature(record, snapshot)
            signatures.append(record)
    # Publish the fully validated lists together; the workspace owns one audit/revision.
    if graphics:
        snapshot.setdefault('graphics', {'version': 1, 'records': []})['records'].extend(graphics)
    if signatures:
        snapshot.setdefault('signatures', {'version': 1, 'records': []})['records'].extend(signatures)
    return {'created_graphic_ids': [record['id'] for record in graphics],
            'created_signature_ids': [record['id'] for record in signatures], 'initial_pages_count': len(document['pages'])}


def _normalized_record_box(record, snapshot, key):
    _, page = page_metadata(snapshot, record['document_id'], record['page'])
    quad = [pdf_point_visible(page, point) for point in record[key]]
    x, y = quad[0]
    width, height = quad[1][0]-x, quad[3][1]-y
    expected = [[x, y], [x+width, y], [x+width, y+height], [x, y+height]]
    if width <= 0 or height <= 0 or any(not math.isclose(a, b, abs_tol=1e-8)
            for point, target in zip(quad, expected) for a, b in zip(point, target)):
        raise ValidationError('Initial Pages marks must follow each page natural upright rectangle axes.')
    return page, [x, y, width, height]


def _same_box(a, b):
    return all(math.isclose(x, y, rel_tol=1e-8, abs_tol=1e-8) for x, y in zip(a, b))


def validate_initial_pages_history(event):
    if event['op'] != 'initial_pages':
        return
    before, after = event['before'], event['after']
    projection = lambda state: {key: value for key, value in state.items() if key not in ('graphics', 'signatures', 'revision')}
    if projection(before) != projection(after):
        raise ValidationError('Initial Pages may change only PDF-only graphics, signatures and one revision.')
    batches = []
    for key in ('graphics', 'signatures'):
        old = {record['id']: record for record in before.get(key, {}).get('records', [])}
        new = {record['id']: record for record in after.get(key, {}).get('records', [])}
        if not old.keys() <= new.keys() or any(new[identifier] != record for identifier, record in old.items()):
            raise ValidationError('Initial Pages cannot replace, remove or edit existing visual identities.')
        added = [record for identifier, record in new.items() if identifier not in old]
        if added:
            if any(record['version'] != 1 for record in added):
                raise ValidationError('Initial Pages creates fresh visual identities at version one.')
            if key == 'graphics' and any(record['kind'] != 'textbox' or 'text_content' in record or 'stamp_image' in record for record in added):
                raise ValidationError('Initial Pages text must use plain PDF-only Textbox records.')
            content_key = 'text' if key == 'graphics' else 'strokes'
            if any(record[content_key] != added[0][content_key] for record in added):
                raise ValidationError('Initial Pages must repeat the same entered text or vector ink on all source pages.')
            batches.append(added)
    if not batches:
        raise ValidationError('Initial Pages must create a bounded text or signature batch.')
    links = [record.get('initial_pages') for batch in batches for record in batch]
    if any(link is not None for link in links):
        from .takeoff_initial_links import validate_link
        for batch in batches:
            for record in batch:
                validate_link(record, 'graphics' if 'kind' in record else 'signatures')
        group_id = next(link['group_id'] for link in links if link is not None)
        existing_groups = {record['initial_pages']['group_id'] for key in ('graphics', 'signatures')
                           for record in before.get(key, {}).get('records', []) if 'initial_pages' in record}
        if group_id in existing_groups or any(link is None or link['group_id'] != group_id for link in links):
            raise ValidationError('Initial Pages must create one fresh group shared by its complete birth batch.')
    first = batches[0][0]
    document, _ = page_metadata(after, first['document_id'], first['page'])
    binding = (first['mode'], first['document_id'], first['source_sha256'])
    expected_pages = sorted(page['page'] for page in document['pages'])
    for batch in batches:
        if sorted(record['page'] for record in batch) != expected_pages or any(
                (record['mode'], record['document_id'], record['source_sha256']) != binding for record in batch):
            raise ValidationError('Initial Pages must create one visual record of each chosen type on every exact source page.')
    graphics = next((batch for batch in batches if 'kind' in batch[0]), [])
    signatures = next((batch for batch in batches if 'strokes' in batch[0]), [])
    text_box = None
    for record in graphics:
        page, box = _normalized_record_box({**record, 'quad_pdf': record['geometry']['quad_pdf']}, after, 'quad_pdf')
        if text_box is None:
            text_box = box
        style = {key: value for key, value in record['appearance'].items() if key != 'font_size'}
        first_style = {key: value for key, value in graphics[0]['appearance'].items() if key != 'font_size'}
        if not _same_box(box, text_box) or style != first_style:
            raise ValidationError('Initial Pages text must retain the same normalized placement and style on every page.')
        name = record['text']
        if not name.strip() or len(name) > 80 or any(character in '\r\n\t' for character in name):
            raise ValidationError('Initial Pages history requires one bounded visible name line.')
        width, height = visible_size(page)
        size = record['appearance']['font_size']
        if size > 12 or not math.isclose(size, _fit_text(name, box[2]*width, box[3]*height, size), rel_tol=1e-8, abs_tol=1e-8):
            raise ValidationError('Initial Pages text must fit inside its retained page rectangle.')
    ink_boxes, ratio = [], None
    for record in signatures:
        page, box = _normalized_record_box(record, after, 'quad_pdf')
        width, height = visible_size(page)
        current_ratio = box[2]*width/(box[3]*height)
        if ratio is None:
            ratio = current_ratio
        if not .1-1e-8 <= current_ratio <= 20+1e-8 or not math.isclose(current_ratio, ratio, rel_tol=1e-8, abs_tol=1e-8) or record['appearance'] != signatures[0]['appearance']:
            raise ValidationError('Initial Pages signature aspect ratio and style must remain consistent on every page.')
        ink_boxes.append((page, box))
    if ink_boxes:
        line_width = signatures[0]['appearance']['stroke_width']
        if text_box is not None:
            full_height = text_box[3]/.3
            envelope = [text_box[0], text_box[1]-.7*full_height, text_box[2], .7*full_height]
        else:
            # The smallest common rectangle also produces the same contain-fit
            # when an original selected edge was larger than every ink edge.
            center = [ink_boxes[0][1][0]+ink_boxes[0][1][2]/2, ink_boxes[0][1][1]+ink_boxes[0][1][3]/2]
            width = max(box[2]+line_width/visible_size(page)[0] for page, box in ink_boxes)
            height = max(box[3]+line_width/visible_size(page)[1] for page, box in ink_boxes)
            envelope = [center[0]-width/2, center[1]-height/2, width, height]
        if any(not _same_box(box, fitted_signature_box(page, envelope, ratio, line_width)) for page, box in ink_boxes):
            raise ValidationError('Initial Pages signatures must retain the same centered contain-fit placement on every page.')
