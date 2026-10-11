"""Authoritative automatic Stamp boxes in retained source PDF coordinates."""
from copy import deepcopy
import math
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_graphics import GRAPHIC_MODES, graphic_appearance, graphic_font_size, validate_graphic
from .takeoff_model import object_fields, page_metadata, points, text

FIELDS = {'mode', 'document_id', 'source_sha256', 'page', 'anchor_pdf',
          'display_rotation', 'text', 'appearance', 'stamp_image'}


def _text_width(value, size, physical):
    from reportlab.pdfbase.pdfmetrics import getFont, stringWidth
    from .takeoff_markup_pdf_worker import register_drawing_fonts
    register_drawing_fonts(physical)
    if any(ord(character) not in getFont('ExportVeraBold').face.charToGlyph for character in value):
        raise ValueError('A Stamp contains a character unsupported by the drawing PDF font.')
    return stringWidth(value, 'ExportVeraBold', size)


def stamp_layout(snapshot, value):
    object_fields(value, FIELDS, 'Stamp layout', FIELDS - {'stamp_image'})
    if not isinstance(value['mode'], str) or value['mode'] not in GRAPHIC_MODES:
        raise ValidationError('Choose a supported Stamp drawing workspace.')
    document, page = page_metadata(snapshot, value['document_id'], value['page'])
    if value['source_sha256'] != document['sha256']:
        raise ValidationError('Stamp layout must identify the exact retained source PDF.')
    rotation = value['display_rotation']
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise ValidationError('Stamp layout requires the displayed right-angle page rotation.')
    anchor = points([value['anchor_pdf']], 'Stamp anchor', page, 1, 1)[0]
    plain = text(value['text'], 'Stamp text', 80)
    appearance = graphic_appearance(value['appearance'])
    image = None
    minimum = 10 * page['user_unit']
    if 'stamp_image' in value:
        if plain != '':
            raise ValidationError('An image Stamp requires empty text.')
        from .takeoff_stamp_images import normalize_stamp_image
        image = normalize_stamp_image(value['stamp_image'])
        # A local image initially fits a two-inch frame, retaining its aspect
        # ratio and never enlarging a small raster beyond its intrinsic size.
        ratio = min(1, 144 / max(image['width'], image['height']))
        width = max(minimum, image['width'] * ratio + 12)
        height = max(minimum, image['height'] * ratio + 12)
    else:
        if not plain.strip() or any(character in '\n\r\t' for character in plain):
            raise ValidationError('Enter nonblank Stamp text on one line, up to 80 characters.')
        size = appearance['font_size']
        try:
            width = max(minimum, _text_width(plain, size, value['mode'] in ('defect_reports', 'service_plans')) + 12)
        except ValueError as error:
            raise ValidationError(str(error)) from error
        height = max(minimum, size * 1.25 + 12)
    headroom = max(1e-6, 16 * max(math.ulp(coordinate) for coordinate in page['view']) * page['user_unit'])
    width += headroom; height += headroom
    w, h = width / page['user_unit'], height / page['user_unit']
    if w > 10000 or h > 10000:
        raise ValidationError('The complete Stamp exceeds the supported source box size.')
    horizontal, vertical = {0: ((w, 0), (0, -h)), 90: ((0, w), (h, 0)),
                           180: ((-w, 0), (0, h)), 270: ((0, -w), (-h, 0))}[rotation]
    # Center placement agrees with subsequent pointer-centered Stamp copies.
    origin = [anchor[axis] - (horizontal[axis] + vertical[axis]) / 2 for axis in (0, 1)]
    quad = [origin, [origin[i] + horizontal[i] for i in (0, 1)],
            [origin[i] + horizontal[i] + vertical[i] for i in (0, 1)],
            [origin[i] + vertical[i] for i in (0, 1)]]
    graphic = {key: deepcopy(value[key]) for key in ('mode', 'document_id', 'source_sha256', 'page', 'text')}
    graphic.update(kind='stamp', geometry={'quad_pdf': quad}, appearance=appearance)
    if image is not None:
        graphic['stamp_image'] = image
    validate_graphic({'id': str(uuid4()), 'version': 1, **graphic}, snapshot)
    validate_stamp_fit(graphic, snapshot)
    return {'graphic': graphic, 'layout': {'width_pt': width, 'height_pt': height, 'display_rotation': rotation}}


def validate_stamp_fit(record, snapshot):
    """Automatic creation rejects clipped text; retained manual boxes still load."""
    if record.get('stamp_image'):
        return
    _, page = page_metadata(snapshot, record['document_id'], record['page'])
    quad = record['geometry']['quad_pdf']
    width = math.dist(quad[0], quad[1]) * page['user_unit']
    height = math.dist(quad[0], quad[3]) * page['user_unit']
    size = graphic_font_size(record)
    padding = min(6, width / 8, height / 8)
    try:
        advance = _text_width(record['text'], size, record['mode'] in ('defect_reports', 'service_plans'))
    except ValueError as error:
        raise ValidationError(str(error)) from error
    if advance > width - 2 * padding or size * 1.25 > height - 2 * padding:
        raise ValidationError('The complete Stamp text does not fit its box at the selected font size.')
