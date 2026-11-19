"""A printable details panel beside selected inspection photos."""
from base64 import b64decode
from io import BytesIO

from reportlab.platypus import Flowable, Image, Spacer, Table

from .report import table_outline


def inspection_detail_width(content):
    return content * .61


def _photo_table(report, photos, width, color, *, columns, table_height=None):
    column_width = width / columns
    horizontal_padding, vertical_padding = 6, 3
    inner_width = column_width - 2 * horizontal_padding
    row_height = table_height / len(photos) if table_height is not None else None
    cells = []
    for caption, photo in photos:
        label = report.p(caption, 'photo_caption')
        height = 124
        if row_height is not None:
            _, caption_height = label.wrap(inner_width, row_height)
            height = row_height - caption_height - label.getSpaceAfter() - 2 * vertical_padding
            if height <= 0:
                return None
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
    return _photo_table(report, photos, content, color, columns=2)


class _InspectionDetailsWithPhotos(Flowable):
    def __init__(self, report, details, photos, content, color):
        super().__init__()
        self.report = report
        self.details = details
        self.photos = photos
        self.content = content
        self.color = color
        self.details_width = inspection_detail_width(content)

    def _paired_table(self, details, height):
        gutter = 10
        photo_width = self.content - self.details_width - gutter
        photos = _photo_table(self.report, self.photos, photo_width, self.color, columns=1, table_height=height)
        if photos is None:
            return None
        return Table([[details, '', photos]], colWidths=[self.details_width, gutter, photo_width], hAlign='LEFT',
                     style=[('VALIGN', (0, 0), (-1, -1), 'TOP'),
                            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)])

    def wrap(self, available_width, available_height):
        _, height = self.details.wrapOn(self.canv, self.details_width, available_height)
        if height > available_height:
            return self.content, height
        self.layout = self._paired_table(self.details, height)
        if self.layout is None:
            return self.content, available_height + 1
        return self.layout.wrapOn(self.canv, available_width, available_height)

    def split(self, available_width, available_height):
        # Let the detail table break at its own rows. The photos fit within the
        # first fragment and the remaining details continue through the frame.
        self.details.splitByRow = 0
        fragments = self.details.splitOn(self.canv, self.details_width, available_height)
        if not fragments:
            return []
        first, *remaining = fragments
        for fragment in remaining:
            fragment.hAlign = 'LEFT'
        _, height = first.wrapOn(self.canv, self.details_width, available_height)
        layout = self._paired_table(first, height)
        return [layout, *remaining] if layout is not None else []

    def draw(self):
        self.layout.drawOn(self.canv, 0, 0)


def inspection_photo_layout(report, detail_table, side_photos, remaining_photos, content, color):
    """Keep selected pictures beside the details and flow the rest across pages."""
    layout = (_InspectionDetailsWithPhotos(report, detail_table, side_photos, content, color)
              if side_photos else detail_table)
    pieces = [layout]
    if remaining_photos:
        pieces.extend((Spacer(1, 6), inspection_photo_grid(report, remaining_photos, content, color)))
    return pieces
