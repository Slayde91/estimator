"""Authoritative, fixed-font Textbox fit in original PDF coordinates."""
from copy import deepcopy
import math

from .catalog import ValidationError
from .takeoff_annotations import validate_content
from .takeoff_graphics import GRAPHIC_MODES, graphic_appearance, validate_graphic
from .takeoff_model import object_fields, page_metadata, points, text

FIELDS = {'mode', 'document_id', 'source_sha256', 'page', 'anchor_pdf',
          'display_rotation', 'text', 'text_content', 'appearance'}


def _content(value):
    plain = text(value['text'], 'Textbox text', 4000)
    if not plain.strip():
        raise ValidationError('Enter nonblank Textbox text.')
    content = validate_content(value['text_content']) if 'text_content' in value else {
        'version': 1, 'blocks': [{'kind': 'paragraph', 'runs': [{'text': plain}]}]}
    if '\n'.join(''.join(run['text'] for run in block['runs']) for block in content['blocks']) != plain:
        raise ValidationError('Textbox text must exactly match its formatted text blocks.')
    return content


def _lines(content, width, size, physical):
    from .takeoff_markup_pdf_worker import _annotation_lines, register_drawing_fonts
    register_drawing_fonts(physical)
    try:
        return _annotation_lines(content, width, size, 'PDF markup')
    except ValueError as error:
        raise ValidationError(str(error)) from error


def textbox_layout(snapshot, value):
    object_fields(value, FIELDS, 'Textbox layout', FIELDS - {'text_content'})
    if not isinstance(value['mode'], str) or value['mode'] not in GRAPHIC_MODES:
        raise ValidationError('Choose a supported Textbox drawing workspace.')
    document, page = page_metadata(snapshot, value['document_id'], value['page'])
    if value['source_sha256'] != document['sha256']:
        raise ValidationError('Textbox layout must identify the exact retained source PDF.')
    rotation = value['display_rotation']
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise ValidationError('Textbox layout requires the displayed right-angle page rotation.')
    anchor = points([value['anchor_pdf']], 'Textbox anchor', page, 1, 1)[0]
    content = _content(value)
    appearance = graphic_appearance(value['appearance'])
    size = appearance['font_size']
    x0, y0, x1, y1 = page['view']
    x, y = anchor
    # Subtract source coordinates directly; (1-normalized_anchor)*extent loses
    # precision at an otherwise exactly fitting page edge.
    available_width, available_height = {0: (x1-x, y-y0), 90: (y1-y, x1-x),
        180: (x-x0, y1-y), 270: (y-y0, x-x0)}[rotation]
    available_width *= page['user_unit']; available_height *= page['user_unit']
    minimum = 10*page['user_unit']
    if available_width < minimum or available_height < minimum:
        raise ValidationError('There is not enough visible page space at this anchor for a Textbox. Choose a point farther from the edge.')
    physical = value['mode'] in ('defect_reports', 'service_plans')
    unwrapped = _lines(content, 1e20, size, physical)
    natural_width = max((math.fsum(run[4] for run in line) for line in unwrapped), default=0)
    # Twelve points provide the same maximum six-point export padding. Reserve
    # the explicit italic shear overhang in addition to glyph advances.
    italic_margin = size*.18 if any(run.get('italic') for block in content['blocks'] for run in block['runs']) else 0
    box_width = min(available_width, 10000*page['user_unit'], max(minimum, natural_width+12+italic_margin))
    maximum_padding = min(6, box_width/8)
    lines = _lines(content, box_width-2*maximum_padding, size, physical)
    if lines is None:
        raise ValidationError('A Textbox character cannot fit in the remaining page width at the selected font size.')
    # Solve h = text_height + 2*min(maximum_padding, h/8) exactly.
    # Starting at maximum padding makes line counts monotonically decrease.
    # Only text heights below 36pt can change padding; font sizes >=4pt give
    # at most seven such lines, so ten passes bound every possible decrease.
    for _ in range(10):
        text_height = len(lines)*size*1.25
        box_height = max(minimum, text_height+2*min(maximum_padding, text_height/6))
        padding = min(maximum_padding, box_height/8)
        fitted = _lines(content, box_width-2*padding, size, physical)
        if fitted is None or len(fitted) > len(lines):
            raise ValidationError('The Textbox layout could not preserve its bounded fit calculation.')
        if len(fitted) == len(lines):
            lines = fitted
            break
        lines = fitted
    else:
        raise ValidationError('The Textbox layout could not settle within its bounded fit calculation.')
    if box_height > available_height or box_width/page['user_unit'] > 10000 or box_height/page['user_unit'] > 10000:
        raise ValidationError('The complete Textbox does not fit below this anchor at the selected font size. Choose another point or shorten the text.')
    # Newly created boxes reserve bounded numeric headroom for subsequent PDF
    # matrix/clipboard translations. The strict exporter is unchanged. At an
    # exact page edge the final strict fit check decides whether ink still fits.
    headroom = max(1e-6, 16*max(math.ulp(coordinate) for coordinate in page['view'])*page['user_unit'])
    box_width = min(available_width, 10000*page['user_unit'], box_width+headroom)
    box_height = min(available_height, 10000*page['user_unit'], box_height+headroom)
    w, h = box_width/page['user_unit'], box_height/page['user_unit']
    axes = {0: ((w, 0), (0, -h)), 90: ((0, w), (h, 0)),
            180: ((-w, 0), (0, h)), 270: ((0, -w), (-h, 0))}
    horizontal, vertical = axes[rotation]
    quad = [deepcopy(anchor), [x+horizontal[0], y+horizontal[1]],
            [x+horizontal[0]+vertical[0], y+horizontal[1]+vertical[1]],
            [x+vertical[0], y+vertical[1]]]
    box_width, box_height = math.dist(quad[0], quad[1])*page['user_unit'], math.dist(quad[0], quad[3])*page['user_unit']
    padding = min(6, box_width/8, box_height/8)
    lines = _lines(content, box_width-2*padding, size, physical)
    graphic = {key: deepcopy(value[key]) for key in ('mode', 'document_id', 'source_sha256', 'page', 'text')}
    graphic.update(kind='textbox', geometry={'quad_pdf': quad}, appearance=appearance)
    if 'text_content' in value: graphic['text_content'] = deepcopy(content)
    from uuid import uuid4
    validate_graphic({'id': str(uuid4()), 'version': 1, **graphic}, snapshot)
    validate_textbox_fit(graphic, snapshot)
    return {'graphic': graphic, 'layout': {'width_pt': box_width, 'height_pt': box_height,
        'line_count': len(lines), 'font_size': size, 'display_rotation': rotation}}


def validate_textbox_fit(record, snapshot):
    """Creation check; legacy stored manual boxes stay structurally loadable."""
    _, page = page_metadata(snapshot, record['document_id'], record['page'])
    quad = record['geometry']['quad_pdf']
    width, height = math.dist(quad[0], quad[1])*page['user_unit'], math.dist(quad[0], quad[3])*page['user_unit']
    size = record['appearance']['font_size']
    padding = min(6, width/8, height/8)
    content = _content(record)
    lines = _lines(content, width-2*padding, size, record['mode'] in ('defect_reports', 'service_plans'))
    if lines is None or len(lines)*size*1.25 > height-2*padding:
        raise ValidationError('The complete Textbox does not fit its box at the selected font size.')
    for line in lines:
        cursor = 0
        for _, _, italic, _, advance in line:
            cursor += advance
            if cursor+(size*.18 if italic else 0) > width-padding+1e-7:
                raise ValidationError('The complete italic Textbox ink does not fit below this anchor at the selected font size.')
