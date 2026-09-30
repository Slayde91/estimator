"""Static vector drawing/markup composition; untrusted PDFs stay in this child."""
from copy import copy
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path
import sys
import tempfile
from xml.sax.saxutils import escape

if __package__:
    from . import takeoff_pdf_worker as limits
else:
    import importlib.util
    _spec = importlib.util.spec_from_file_location('_ceasefire_pdf_limits', Path(__file__).with_name('takeoff_pdf_worker.py'))
    limits = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(limits)

MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_CONTENT_BYTES = 32 * 1024 * 1024
MAX_PAGE_SIDE = 14400


def page_transform(metadata, bottom=0, left=0):
    """Original unrotated PDF space -> upright physical points, no resampling."""
    x0, y0, x1, y1 = metadata['view']; u = metadata['user_unit']; rotation = metadata['rotation']
    if rotation == 0: matrix = (u, 0, 0, u, -x0*u+left, -y0*u+bottom)
    elif rotation == 90: matrix = (0, -u, u, 0, -y0*u+left, x1*u+bottom)
    elif rotation == 180: matrix = (-u, 0, 0, -u, x1*u+left, y1*u+bottom)
    else: matrix = (0, u, -u, 0, y1*u+left, -x0*u+bottom)
    width, height = (x1-x0)*u, (y1-y0)*u
    if rotation in (90, 270): width, height = height, width
    return matrix, width, height


def transform(point, matrix):
    a, b, c, d, e, f = matrix
    return a*point[0]+c*point[1]+e, b*point[0]+d*point[1]+f


def _text(value):
    text = str(value) if value is not None else ''
    text = ''.join(character if ord(character) >= 32 or character in '\n\t' else ' ' for character in text)
    return escape(text)


def _legend_rows(items, width, style):
    from reportlab.platypus import Paragraph
    rows = []
    for item in items:
        if item['mode'] == 'steel': detail = item.get('section') or 'Section unavailable'
        elif item['mode'] == 'duct':
            if item.get('shape') == 'circular': detail = f"Circular duct, diameter {item.get('diameter_mm') or 'unavailable'} mm"
            else: detail = f"Duct {item.get('width_mm') or 'unavailable'} x {item.get('height_mm') or 'unavailable'} mm"
        else: detail = item['mode'].title() + ' treatment surface'
        value = item.get('total_length_m')
        quantity = f'{value:.2f} m total' if isinstance(value, (int, float)) and math.isfinite(value) else 'Total length unavailable'
        if item['mode'] in ('wall', 'slab'):
            value = item.get('net_area_m2'); quantity = f'{value:.2f} m2 net' if isinstance(value, (int, float)) and math.isfinite(value) else 'Net area unavailable'
        text = (f"<b>{item['legend_number']}. {_text(item['mark'])}</b> | {_text(detail)} | {quantity} | "
                + ('Confirmed' if item['confirmed'] else '<b>Unconfirmed</b>')
                + f"<br/>{_text(item['linked_result'])}<br/><font size='6'>{item['id']}</font>")
        paragraph = Paragraph(text, style); _, height = paragraph.wrap(width-48, 1000)
        rows.append((item, paragraph, height+12))
    return rows


def _filename_heading(spec, width):
    from reportlab.platypus import Paragraph
    from reportlab.lib.styles import ParagraphStyle
    paragraph = Paragraph(_text(spec['document']['name']), ParagraphStyle('Source', fontName='ExportVera', fontSize=7, leading=9))
    _, height = paragraph.wrap(width-36, 1000)
    return paragraph, height


def _paint_legend(pdf, rows, width, height, spec, page_number, *, continuation=False):
    from reportlab.lib.colors import HexColor, Color
    from reportlab.lib.utils import ImageReader
    logo = spec.get('_logo_image')
    if logo is None:
        from PIL import Image
        # This fixed branding asset is rendered at print resolution, once. No
        # source PDF images are resized, and the installed logo stays untouched.
        with Image.open(spec['logo']) as original_logo:
            rendered_logo = original_logo.convert('RGBA')
        rendered_logo.thumbnail((500, 167), Image.Resampling.LANCZOS)
        logo = spec['_logo_image'] = ImageReader(rendered_logo)
    lw, lh = logo.getSize(); ratio = min(120/lw, 28/lh)
    pdf.setFillColor(HexColor('#FFFFFF')); pdf.rect(0, 0, width, height, stroke=0, fill=1)
    pdf.drawImage(logo, 18, height-40, width=lw*ratio, height=lh*ratio, mask='auto')
    pdf.setFont('ExportVeraBold', 9); pdf.setFillColor(HexColor('#202831'))
    pdf.drawString(155, height-22, 'TAKEOFF LEGEND' + (' - CONTINUED' if continuation else ''))
    pdf.setFont('ExportVera', 7)
    pdf.drawString(155, height-35, f"Source page {page_number} of {len(spec['document']['pages'])} | {spec['mode'].title()} | Revision {spec['revision']}")
    filename, heading_height = _filename_heading(spec, width)
    filename.drawOn(pdf, 18, height-45-heading_height)
    separator = height-53-heading_height
    pdf.setStrokeColor(HexColor('#C62828')); pdf.setLineWidth(1); pdf.line(18, separator, width-18, separator)
    y = separator-10
    if not rows:
        has_marks = any(item['geometry']['page'] == page_number for item in spec['items'])
        pdf.drawString(20, y-10, 'Markup details continue on the following legend page.' if has_marks
                       else 'No visible markups of the selected takeoff type on this page.')
    for item, paragraph, row_height in rows:
        color = HexColor(item['appearance']['stroke_color']); pdf.setStrokeColor(color); pdf.setLineWidth(3)
        pdf.line(20, y-8, 34, y-8)
        paragraph.drawOn(pdf, 42, y-(row_height-12))
        y -= row_height
    pdf.setFont('ExportVera', 6); pdf.setFillColor(Color(.32, .36, .4))
    pdf.drawString(18, 14, 'Derived marked drawing. Original PDF retained unchanged. Unconfirmed marks are drafts; technical suitability requires separate assessment.')


def _paint_markups(pdf, items, matrix):
    from reportlab.lib.colors import HexColor
    for item in items:
        geometry, style = item['geometry'], item['appearance']; points = geometry['points']
        area = geometry.get('kind') == 'polygon'
        if item.get('cited_region'):
            x0, y0 = points[0]; x1, y1 = points[-1]
            points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
            area = True
        pdf.saveState(); pdf.setStrokeColor(HexColor(style['stroke_color'])); pdf.setFillColor(HexColor(style['fill_color']))
        pdf.setLineWidth(style['stroke_width']); pdf.setLineCap(1); pdf.setLineJoin(1)
        pdf.setStrokeAlpha(style['opacity']); pdf.setFillAlpha(style['opacity']*.12)
        path = pdf.beginPath()
        for index, point in enumerate(points):
            xy = transform(point, matrix); path.moveTo(*xy) if index == 0 else path.lineTo(*xy)
        if area:
            path.close()
            for exclusion in geometry.get('exclusions', []):
                for index, point in enumerate(exclusion['points']):
                    xy = transform(point, matrix); path.moveTo(*xy) if index == 0 else path.lineTo(*xy)
                path.close()
        pdf.drawPath(path, stroke=1, fill=int(area and style['fill_enabled']), fillMode=0)
        x, y = transform(points[0], matrix)
        pdf.setFillAlpha(style['opacity']); pdf.setFillColor(HexColor(style['stroke_color'])); pdf.setFont('ExportVeraBold', 8)
        # The complete human identifier remains in the wrapped legend. A compact
        # ordinal on the drawing avoids obscuring geometry with long identifiers.
        pdf.drawString(x+4, y+4, str(item['legend_number']))
        pdf.restoreState()


def _invisible_link(annotation):
    """Only discard links whose normal appearance is explicitly empty."""
    annotation = annotation.get_object()
    if annotation.get('/Subtype') != '/Link' or annotation.get('/AP'):
        return False
    border = annotation.get('/Border', [0, 0, 1])
    if hasattr(border, 'get_object'): border = border.get_object()
    style = annotation.get('/BS')
    if hasattr(style, 'get_object'): style = style.get_object()
    width = style.get('/W', 1) if style else border[2] if len(border) >= 3 else 1
    return isinstance(width, (int, float)) and width == 0


def render_document(source, spec, output):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, RectangleObject
    import reportlab
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.colors import HexColor
    font_dir = Path(reportlab.__file__).resolve().parent / 'fonts'
    for name, filename in (('ExportVera', 'Vera.ttf'), ('ExportVeraBold', 'VeraBd.ttf')):
        if name not in pdfmetrics.getRegisteredFontNames(): pdfmetrics.registerFont(TTFont(name, str(font_dir / filename)))
    pdfmetrics.registerFontFamily('ExportVera', normal='ExportVera', bold='ExportVeraBold')
    style = ParagraphStyle('Legend', fontName='ExportVera', fontSize=8, leading=10, textColor=HexColor('#202831'))
    reader = PdfReader(source, strict=True); writer = PdfWriter(); total_content = 0
    if reader.is_encrypted: raise ValueError('Encrypted source PDFs cannot be exported.')
    if len(reader.pages) != len(spec['document']['pages']): raise ValueError('Source PDF page count changed.')
    for index, original in enumerate(reader.pages):
        annotations = original.get('/Annots', [])
        if hasattr(annotations, 'get_object'): annotations = annotations.get_object()
        if any(not _invisible_link(annotation) for annotation in annotations):
            raise ValueError('Source annotations or form widgets cannot yet be flattened faithfully. Export a plain drawing PDF; the original is unchanged.')
        metadata = spec['document']['pages'][index]; _, drawing_width, drawing_height = page_transform(metadata)
        if not 1 <= drawing_width <= MAX_PAGE_SIDE or not 1 <= drawing_height <= MAX_PAGE_SIDE-800:
            raise ValueError('This PDF page is outside the supported physical drawing export size.')
        contents = original.get_contents(); count = len(contents.get_data()) if contents is not None else 0
        total_content += count
        if count > MAX_CONTENT_BYTES or total_content > MAX_OUTPUT_BYTES:
            raise ValueError('Decoded PDF drawing content exceeds the safe export limit.')
        page_items = [item for item in spec['items'] if item['geometry']['page'] == index+1]
        for number, item in enumerate(page_items, 1): item['legend_number'] = number
        width = max(595, drawing_width); rows = _legend_rows(page_items, width, style)
        _, heading_height = _filename_heading(spec, width)
        first_rows, remaining, used = [], list(rows), 95+heading_height
        while remaining and used + remaining[0][2] <= 380:
            row = remaining.pop(0); first_rows.append(row); used += row[2]
        legend_height = max(125, used+15); height = drawing_height + legend_height
        matrix, _, _ = page_transform(metadata, legend_height, (width-drawing_width)/2)
        page = writer.add_blank_page(width=width, height=height)
        drawing = copy(original)
        # The visible PDF.js box is the verified crop/media intersection. Keep
        # both merge clipping conventions tied to that view, never a print trim.
        for key in ('/CropBox', '/TrimBox'):
            drawing[NameObject(key)] = RectangleObject(metadata['view'])
        # Only page painting/resources are merged. Original page actions,
        # annotations, form widgets, JavaScript and document names are not
        # carried into this static derivative or connected to its new catalog.
        for key in ('/Annots', '/AA', '/OpenAction', '/Metadata', '/Rotate', '/UserUnit'):
            drawing.pop(NameObject(key), None)
        page.merge_transformed_page(drawing, matrix, over=True, expand=False)
        overlay = BytesIO(); pdf = canvas.Canvas(overlay, pagesize=(width, height), pageCompression=1, invariant=True)
        _paint_markups(pdf, page_items, matrix); _paint_legend(pdf, first_rows, width, legend_height, spec, index+1)
        pdf.save(); overlay.seek(0); page.merge_page(PdfReader(overlay).pages[0])
        page.compress_content_streams(level=9)
        while remaining:
            group, used = [], 95+heading_height
            while remaining and used+remaining[0][2] <= 810:
                row = remaining.pop(0); group.append(row); used += row[2]
            if not group: raise ValueError('A markup legend row is too long to fit safely.')
            overlay = BytesIO(); pdf = canvas.Canvas(overlay, pagesize=(width, 842), pageCompression=1, invariant=True)
            _paint_legend(pdf, group, width, 842, spec, index+1, continuation=True); pdf.save(); overlay.seek(0)
            extra = writer.add_page(PdfReader(overlay).pages[0]); extra.compress_content_streams(level=9)
        if len(writer.pages) > 4000: raise ValueError('The marked PDF exceeds its output page limit.')
    # Clone only the optional-content configuration, using the same writer
    # translation table as merged resources so ON/OFF groups keep their identity.
    # The source document catalog, actions and embedded files are never cloned.
    layers = reader.trailer['/Root'].get('/OCProperties')
    if layers:
        writer._root_object[NameObject('/OCProperties')] = layers.get_object().clone(writer)
    writer.add_metadata({'/Title': 'CEASEFIRE marked drawing', '/Subject': 'Static Takeoffs derivative; originals retained unchanged',
                         '/Creator': 'CEASEFIRE ESTIMATOR'})
    # Reuse repeated fonts/branding only when optional-content identity is not
    # involved. Distinct OCGs may have byte-identical dictionaries but different
    # ON/OFF membership; generic deduplication would change drawing visibility.
    # All page streams remain losslessly compressed in either case.
    writer.compress_identical_objects(remove_duplicates=not bool(layers), remove_unreferenced=True)
    class BoundedOutput:
        def __init__(self, stream): self.stream = stream
        def write(self, value):
            if self.stream.tell()+len(value) > MAX_OUTPUT_BYTES:
                raise ValueError('Marked PDF output exceeds its resource limit.')
            return self.stream.write(value)
        def __getattr__(self, name): return getattr(self.stream, name)
    with Path(output).open('xb') as stream:
        writer.write(BoundedOutput(stream))


def main():
    try:
        limits.CPU_SECONDS = 60; limits.restrict_process()
        if len(sys.argv) != 4: raise ValueError('A retained PDF, bounded request and private output are required.')
        raw = Path(sys.argv[2]).read_bytes()
        if len(raw) > 16*1024*1024: raise ValueError('The marked PDF request exceeds its resource limit.')
        spec = json.loads(raw); checksum = sha256(); size = 0
        with tempfile.TemporaryFile(mode='w+b') as source:
            with Path(sys.argv[1]).open('rb') as original:
                while chunk := original.read(1024*1024):
                    size += len(chunk)
                    if size > limits.MAX_DOCUMENT_SIZE: raise ValueError('Source PDF exceeds its export limit.')
                    checksum.update(chunk); source.write(chunk)
            if size != spec['document']['size'] or checksum.hexdigest() != spec['document']['sha256']:
                raise ValueError('The retained PDF changed before export.')
            source.seek(0)
            metadata = limits.parse_pdf_stream(source)
            if metadata['pages'] != spec['document']['pages']: raise ValueError('Source page geometry changed before export.')
            source.seek(0); render_document(source, spec, sys.argv[3])
        output = Path(sys.argv[3])
        if not 0 < output.stat().st_size <= MAX_OUTPUT_BYTES: raise ValueError('Marked PDF output exceeds its resource limit.')
        from pypdf import PdfReader
        pages = len(PdfReader(output, strict=True).pages)
        result = {'sha256': sha256(output.read_bytes()).hexdigest(), 'size': output.stat().st_size, 'pages': pages}
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else 'The marked PDF could not be composed safely.'
        result = {'error': message[:300]}
    sys.stdout.write(json.dumps(result, allow_nan=False, separators=(',', ':')))


if __name__ == '__main__': main()
