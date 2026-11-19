"""A printable details panel beside selected inspection photos."""
from base64 import b64decode
from io import BytesIO

from reportlab.platypus import Image, Spacer, Table

from .report import table_outline


def inspection_detail_width(content):
    return content * .61


def _photo_table(report, photos, width, color, *, columns, image_height):
    column_width = width / columns
    cells = []
    for caption, photo in photos:
        image = Image(BytesIO(b64decode(photo.split(',', 1)[1])))
        image._restrictSize(column_width - 12, image_height)
        cells.append([report.p(caption, 'photo_caption'), image])
    rows = [cells[index:index + columns] for index in range(0, len(cells), columns)]
    styles = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
              ('INNERGRID', (0, 0), (-1, -1), .35, color)]
    if len(rows[-1]) < columns:
        rows[-1].append('')
        styles.append(('SPAN', (0, -1), (-1, -1)))
    return Table(rows, colWidths=[column_width] * columns, hAlign='LEFT',
                 style=styles, renderCB=table_outline(color))


def inspection_photo_grid(report, photos, content, color):
    return _photo_table(report, photos, content, color, columns=2, image_height=124)


def inspection_photo_layout(report, detail_tables, side_photos, remaining_photos, content, color):
    """Keep selected pictures beside the details and flow the rest across pages."""
    facts_width = inspection_detail_width(content)
    gutter = 10
    photo_width = content - facts_width - gutter
    beside = _photo_table(report, side_photos, photo_width, color, columns=1, image_height=100) if side_photos else ''
    layout = Table([[detail_tables, '', beside]], colWidths=[facts_width, gutter, photo_width],
                   hAlign='LEFT', splitInRow=1,
                   style=[('VALIGN', (0, 0), (-1, -1), 'TOP'),
                          ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                          ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)])
    pieces = [layout]
    if remaining_photos:
        pieces.extend((Spacer(1, 6), inspection_photo_grid(report, remaining_photos, content, color)))
    return pieces
