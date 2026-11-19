"""A printable details panel beside selected inspection photos."""
from base64 import b64decode
from io import BytesIO

from reportlab.platypus import Image, Spacer, Table

from .report import table_outline


def inspection_detail_width(content):
    return content * .61


def _photo_table(report, photos, width, color, *, columns, image_height, table_height=None):
    column_width = width / columns
    horizontal_padding, vertical_padding = 6, 3
    inner_width = column_width - 2 * horizontal_padding
    row_height = table_height / len(photos) if table_height is not None else None
    cells = []
    for caption, photo in photos:
        label = report.p(caption, 'photo_caption')
        height = image_height
        if row_height is not None:
            _, caption_height = label.wrap(inner_width, row_height)
            height = row_height - caption_height - label.getSpaceAfter() - 2 * vertical_padding
        image = Image(BytesIO(b64decode(photo.split(',', 1)[1])))
        image._restrictSize(inner_width, height)
        cells.append([label, image])
    rows = [cells[index:index + columns] for index in range(0, len(cells), columns)]
    styles = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
              ('LEFTPADDING', (0, 0), (-1, -1), horizontal_padding),
              ('RIGHTPADDING', (0, 0), (-1, -1), horizontal_padding),
              ('TOPPADDING', (0, 0), (-1, -1), vertical_padding),
              ('BOTTOMPADDING', (0, 0), (-1, -1), vertical_padding),
              ('INNERGRID', (0, 0), (-1, -1), .35, color)]
    if len(rows[-1]) < columns:
        rows[-1].append('')
        styles.append(('SPAN', (0, -1), (-1, -1)))
    return Table(rows, colWidths=[column_width] * columns, rowHeights=row_height, hAlign='LEFT',
                 style=styles, renderCB=table_outline(color))


def inspection_photo_grid(report, photos, content, color):
    return _photo_table(report, photos, content, color, columns=2, image_height=124)


def inspection_photo_layout(report, detail_table, side_photos, remaining_photos, content, color, *, page_height=None):
    """Keep selected pictures beside the details and flow the rest across pages."""
    facts_width = inspection_detail_width(content)
    gutter = 10
    photo_width = content - facts_width - gutter
    beside = ''
    if side_photos:
        fit_height = None
        if page_height is not None:
            _, detail_height = detail_table.wrap(facts_width, page_height)
            fit_height = min(detail_height, page_height)
        beside = _photo_table(report, side_photos, photo_width, color, columns=1, image_height=100,
                              table_height=fit_height)
    layout = Table([[detail_table, '', beside]], colWidths=[facts_width, gutter, photo_width],
                   hAlign='LEFT', splitInRow=1,
                   style=[('VALIGN', (0, 0), (-1, -1), 'TOP'),
                          ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                          ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)])
    pieces = [layout]
    if remaining_photos:
        pieces.extend((Spacer(1, 6), inspection_photo_grid(report, remaining_photos, content, color)))
    return pieces
