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


def _addition_label(addition):
    value = addition['length_mm']
    length = str(int(value)) if value == int(value) else repr(value)
    return f'{"Rise" if addition["kind"] == "riser" else "Drop"} {length} mm'


def _legend_rows(items, width, style):
    from reportlab.platypus import Paragraph
    rows = []
    for item in items:
        if item['mode'] == 'penetrations':
            lines = item['physical_summary']
            for line_index, line in enumerate(lines):
                # Bound each paragraph so long descriptions use continuation
                # rows rather than clipping source facts or overflowing a page.
                for start in range(0, len(line), 600):
                    prefix = (f"<b>{item['legend_number']}. {_text(item['mark'])} - Unapproved draft</b>"
                              + f"<br/><font size='6'>{item['id']}</font><br/>") if line_index == 0 and start == 0 else ''
                    paragraph = Paragraph(prefix + _text(line[start:start+600]), style)
                    _, height = paragraph.wrap(width-48, 1000)
                    rows.append((item, paragraph, height+12))
            continue
        if item.get('purpose') == 'count-only': detail = 'Count-only item; no calculator transfer'
        elif item.get('purpose') == 'length-only': detail = 'Length measurement; no calculator transfer'
        elif item['mode'] == 'steel': detail = item.get('section') or 'Section unavailable'
        elif item['mode'] == 'duct':
            if item.get('shape') == 'circular': detail = f"Circular duct, diameter {item.get('diameter_mm') or 'unavailable'} mm"
            else: detail = f"Duct {item.get('width_mm') or 'unavailable'} x {item.get('height_mm') or 'unavailable'} mm"
        else: detail = item['mode'].title() + ' treatment surface'
        value = item.get('total_length_m')
        quantity = f'{value:.2f} m total' if isinstance(value, (int, float)) and math.isfinite(value) else 'Total length unavailable'
        if item['geometry'].get('kind') == 'count':
            length = item.get('manual_length_m')
            entered = f'{length:.2f} m manual length each' if isinstance(length, (int, float)) else 'Manual length unavailable'
            additions = item.get('additions_length_m', 0)
            if isinstance(additions, (int, float)) and additions > 0 and isinstance(length, (int, float)):
                entered = f'{length:.2f} m manual base + {additions:.2f} m explicit additions each'
            quantity = f"{item['quantity']} markers x {entered}; {quantity}"
        if item.get('purpose') == 'count-only':
            quantity = f"{item['quantity']} markers counted"
        if item['mode'] in ('wall', 'slab') and item.get('purpose') != 'length-only':
            value = item.get('net_area_m2'); quantity = f'{value:.2f} m2 net' if isinstance(value, (int, float)) and math.isfinite(value) else 'Net area unavailable'
            if 'layers' in item:
                total = item.get('total_area_m2')
                quantity += f" x {item['layers']} layers; " + (f'{total:.2f} m2 total' if isinstance(total, (int, float)) and math.isfinite(total) else 'Total area unavailable')
        text = (f"<b>{item['legend_number']}. {_text(item['mark'])}</b> | {_text(detail)} | {quantity} | "
                + ('Confirmed' if item['confirmed'] else '<b>Unconfirmed</b>')
                + f"<br/>{_text(item['linked_result'])}<br/><font size='6'>{item['id']}</font>")
        paragraph = Paragraph(text, style); _, height = paragraph.wrap(width-48, 1000)
        rows.append((item, paragraph, height+12))
        additions = item.get('length_additions', [])
        # Separate bounded paragraphs let the ordinary continuation-page flow
        # retain every explicit addition without creating one oversized row.
        for start in range(0, len(additions), 4):
            details = []
            for index, addition in enumerate(additions[start:start+4], start+1):
                anchor = addition.get('anchor')
                source = (f'control point {anchor["point_index"]+1}, PDF {anchor["point"]}' if anchor
                          else f'source {addition["document_id"]}, page {addition["page"]}, unanchored')
                details.append(f'{index}. {_addition_label(addition)}; {source}')
            text = (f'<b>{item["legend_number"]}. Rise/Drop additions per member</b><br/>'
                    + '<br/>'.join(_text(value) for value in details))
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
    annotation_count = sum(annotation['page'] == page_number for annotation in spec.get('annotations', []))
    signature_count = sum(signature['page'] == page_number for signature in spec.get('signatures', []))
    has_marks = any(item['geometry']['page'] == page_number for item in spec['items'])
    annotation_label = f"{annotation_count} free Call-out{'s' if annotation_count != 1 else ''} (drawing notes only)"
    signature_label = f"{signature_count} signature{'s' if signature_count != 1 else ''} (visual marks only)"
    visual_label = '; '.join(label for count, label in ((annotation_count, annotation_label), (signature_count, signature_label)) if count)
    if not rows:
        pdf.drawString(20, y-10, 'Markup details continue on the following legend page.' if has_marks
                       else visual_label + '; no measurement markups.' if visual_label
                       else 'No visible markups of the selected takeoff type on this page.')
    for item, paragraph, row_height in rows:
        color = HexColor(item['appearance']['stroke_color']); pdf.setStrokeColor(color); pdf.setLineWidth(3)
        pdf.line(20, y-8, 34, y-8)
        paragraph.drawOn(pdf, 42, y-(row_height-12))
        y -= row_height
    if visual_label and has_marks:
        pdf.setFont('ExportVera', 7); pdf.setFillColor(HexColor('#202831'))
        pdf.drawString(18, 26, visual_label + '; excluded from measurement register.')
    pdf.setFont('ExportVera', 6); pdf.setFillColor(Color(.32, .36, .4))
    pdf.drawString(18, 14, 'Derived marked drawing. Original PDF retained unchanged. Unconfirmed marks are drafts; technical suitability requires separate assessment.')


def _paint_count_marker(pdf, center, style):
    """Independent physical-point symbols; no line can connect two members."""
    x, y = center
    radius = style['marker_size'] / 2
    fill = int(style['fill_enabled'])
    shape = style['marker_shape']
    if shape == 'circle':
        pdf.circle(x, y, radius, stroke=1, fill=fill)
    elif shape == 'square':
        pdf.rect(x-radius, y-radius, 2*radius, 2*radius, stroke=1, fill=fill)
    else:
        vertices = ([(x, y+radius), (x+radius, y-radius), (x-radius, y-radius)] if shape == 'triangle'
                    else [(x, y+radius), (x+radius, y), (x, y-radius), (x-radius, y)])
        path = pdf.beginPath()
        for index, vertex in enumerate(vertices):
            path.moveTo(*vertex) if index == 0 else path.lineTo(*vertex)
        path.close()
        pdf.drawPath(path, stroke=1, fill=fill)


def _paint_length_additions(pdf, item, matrix, drawing_bounds):
    """Label entered vertical lengths at transformed source anchors, never infer them."""
    from reportlab.pdfbase.pdfmetrics import stringWidth
    grouped = {}
    for addition in item.get('length_additions', []):
        if 'anchor' not in addition:
            continue
        grouped.setdefault(tuple(addition['anchor']['point']), []).append(_addition_label(addition))
    pdf.setLineWidth(.7); pdf.setFont('ExportVera', 7)
    for point, labels in grouped.items():
        x, y = transform(point, matrix)
        label_x, label_y = x+10, y-14
        if len(labels) > 4 or drawing_bounds and 11*len(labels)+18 > drawing_bounds[3]-drawing_bounds[1]:
            labels = [f'{len(labels)} Rise/Drop additions (see legend)']
        if drawing_bounds:
            left, bottom, right, top = drawing_bounds
            width = max(stringWidth(label, 'ExportVera', 7) for label in labels)
            label_x = max(left+4, min(label_x, right-width-4))
            if label_y-11*(len(labels)-1) < bottom+4:
                label_y = min(top-9, y+12+11*(len(labels)-1))
        pdf.circle(x, y, 2, stroke=1, fill=1)
        pdf.line(x, y, label_x-3, label_y+2)
        for index, label in enumerate(labels):
            pdf.drawString(label_x, label_y-11*index, label)


def _paint_drawing_legends(pdf, legends, matrix):
    from reportlab.lib.colors import HexColor
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph
    scale = math.hypot(matrix[0], matrix[1])
    for legend in legends:
        x, top = transform(legend['point'], matrix)
        width, height = legend['width'] * scale, legend['height'] * scale
        style = {'stroke_color': '#404040', 'fill_color': '#FFFFFF', 'font_color': '#202020',
                 'fill_enabled': True, 'stroke_width': 1, 'opacity': .94, **legend['appearance']}
        pdf.saveState(); pdf.setStrokeColor(HexColor(style['stroke_color']))
        pdf.setLineWidth(style['stroke_width']); pdf.setFillColor(HexColor(style['fill_color']))
        pdf.setFillAlpha(style['opacity']); pdf.rect(x, top-height, width, height, stroke=1, fill=int(style['fill_enabled']))
        groups = {}
        for row in legend['rows']:
            groups.setdefault(row['colour'], []).append(row['text'])
        lines = [(colour, '; '.join(texts)) for colour, texts in groups.items()]
        font_size = 9 * scale; padding = min(8 * scale, width/10, height/10)
        for _ in range(40):
            paragraphs = [Paragraph(_text(text), ParagraphStyle('DrawingLegend', fontName='ExportVera',
                fontSize=font_size, leading=font_size*1.3, textColor=HexColor(style['font_color']))) for _, text in lines]
            sizes = [paragraph.wrap(max(.1, width-3*padding-font_size), height)[1] for paragraph in paragraphs]
            if sum(sizes) + font_size*2 + max(0, len(lines)-1)*font_size*.3 + padding*2 <= height:
                break
            font_size *= .9
        pdf.setFillAlpha(1); pdf.setFillColor(HexColor(style['font_color'])); pdf.setFont('ExportVeraBold', font_size)
        pdf.drawString(x+padding, top-padding-font_size, legend['mode'].title() + ' Legend')
        y = top-padding-font_size*2
        for (colour, _), paragraph, needed in zip(lines, paragraphs, sizes):
            pdf.setFillColor(HexColor(colour)); pdf.rect(x+padding, y-font_size, font_size, font_size, stroke=0, fill=1)
            paragraph.drawOn(pdf, x+2*padding+font_size, y-needed); y -= needed+font_size*.3
        pdf.restoreState()


def _physical_lines(summary, width, font_size):
    """Same word/character wrapping and first-line emphasis as the viewer."""
    from reportlab.pdfbase.pdfmetrics import stringWidth
    lines = []
    for paragraph in summary:
        if not paragraph:
            continue
        line = ''; font = 'ExportVera' if lines else 'ExportVeraBold'
        for word in paragraph.split():
            candidate = f'{line} {word}' if line else word
            if line and stringWidth(candidate, font, font_size) > width:
                lines.append(line); line = ''; font = 'ExportVera'
            part = ''
            for character in word:
                if part and stringWidth(part+character, font, font_size) > width:
                    if line:
                        lines.append(line); line = ''
                    lines.append(part); part = ''
                part += character
            line += (' ' if line else '') + part
        if line:
            lines.append(line)
    return lines


def _paint_physical_callout(pdf, item, point, center, matrix, bounds, zoom):
    from reportlab.lib.colors import HexColor
    factor = max(zoom, 1.2)/zoom
    layout = item.get('callout')
    style = {'stroke_color':'#FF3300','fill_color':'#FFDD33','font_color':'#000000',
             'fill_enabled':True,'stroke_width':4,'opacity':.75,
             **(layout.get('appearance',{}) if layout else {})}
    if layout and 'offset' in layout:
        anchor = transform([point[0]+layout['offset'][0],point[1]+layout['offset'][1]],matrix)
        source_scale = math.hypot(matrix[0],matrix[1])
        width, height = layout['width']*source_scale, layout['height']*source_scale
        x,y = anchor[0],anchor[1]-height
    else:
        left,bottom,right,top = bounds
        width = min(238*factor, right-left)
        padding = min(6*factor, width/12)
        height = min((min(len(_physical_lines(item['physical_summary'],width-2*padding,9*factor)),30)*12+12)*factor,
                     top-bottom)
        x = max(left,min(center[0]+17*factor,right-width))
        y = center[1]-18*factor-height if center[1]-18*factor-height >= bottom else min(top-height,center[1]+18*factor)
    padding = min(6*factor,width/12,height/8)
    font_size = 9*factor
    lines = _physical_lines(item['physical_summary'],width-2*padding,font_size)
    for _ in range(30):
        if len(lines)*font_size*1.3 <= height-2*padding:
            break
        font_size *= .9
        lines = _physical_lines(item['physical_summary'],width-2*padding,font_size)
    if not (layout and 'offset' in layout) and (len(lines)*font_size*1.3 > height-2*padding):
        raise ValueError('The automatic physical call-out cannot display every line within the source drawing. Reduce its displayed details before exporting.')
    pdf.setStrokeAlpha(1);pdf.setFillAlpha(1)
    pdf.setStrokeColor(HexColor(style['stroke_color']));pdf.setLineWidth(style['stroke_width'])
    pdf.line(center[0],center[1],max(x,min(center[0],x+width)),max(y,min(center[1],y+height)))
    pdf.setFillColor(HexColor(style['fill_color']));pdf.setFillAlpha(style['opacity'])
    pdf.roundRect(x,y,width,height,3*factor,stroke=1,fill=int(style['fill_enabled']))
    pdf.setFillAlpha(1);pdf.setFillColor(HexColor(style['font_color']))
    for index,line in enumerate(lines):
        pdf.setFont('ExportVeraBold' if index == 0 else 'ExportVera',font_size)
        pdf.drawString(x+padding,y+height-padding-font_size-index*font_size*1.3,line)


def _annotation_lines(content, width, font_size):
    """Wrap every literal character and retain supported marks without HTML."""
    from reportlab.pdfbase.pdfmetrics import getFont, stringWidth
    lines, widths, numbered = [], {}, 0
    for block in content['blocks']:
        numbered = numbered + 1 if block['kind'] == 'number' else 0
        prefix = '\u2022 ' if block['kind'] == 'bullet' else (f'{numbered}. ' if numbered else '')
        styled = [(character, False, False, False) for character in prefix]
        for run in block['runs']:
            styled.extend((character, run.get('bold', False), run.get('italic', False), run.get('underline', False))
                          for character in run['text'].replace('\r\n', '\n').replace('\r', '\n').replace('\t', '    '))
        line, used = [], 0
        for character, bold, italic, underline in styled:
            if character == '\n':
                lines.append(line); line, used = [], 0
                continue
            font = 'ExportVeraBold' if bold else 'ExportVera'
            if ord(character) not in getFont(font).face.charToGlyph:
                raise ValueError('A free call-out contains a character unsupported by the drawing PDF font. Edit that character before exporting; its original text is retained.')
            key = (character, font)
            advance = widths.setdefault(key, stringWidth(character, font, font_size))
            if advance > width:
                return None
            if line and used + advance > width:
                lines.append(line); line, used = [], 0
            line.append((character, font, italic, underline, advance)); used += advance
        lines.append(line)
    return lines


def _paint_annotations(pdf, annotations, matrix, bounds):
    from reportlab.lib.colors import HexColor
    scale = math.hypot(matrix[0], matrix[1])
    left, bottom, right, top = bounds
    for annotation in annotations:
        style = annotation['appearance']
        width, height = annotation['width'] * scale, annotation['height'] * scale
        if width > right-left or height > top-bottom:
            raise ValueError('A free call-out box exceeds the drawing bounds. Resize it before exporting.')
        anchor = transform(annotation['label_position'], matrix)
        x, y = max(left, min(anchor[0], right-width)), max(bottom, min(anchor[1]-height, top-height))
        padding = min(6 * scale, width / 12, height / 8)
        font_size = 10 * scale
        while True:
            lines = _annotation_lines(annotation['content'], width-2*padding, font_size)
            if lines is not None and len(lines) * font_size * 1.3 <= height-2*padding:
                break
            if font_size <= 4 * scale:
                if lines is None:
                    raise ValueError('A free call-out box is too narrow to display every character safely.')
                raise ValueError('A free call-out contains more text than its box can display safely. Enlarge the box or shorten the text before exporting.')
            font_size = max(4 * scale, font_size * .9)
        pdf.saveState()
        pdf.setStrokeColor(HexColor(style['stroke_color'])); pdf.setLineWidth(style['stroke_width'])
        pdf.setStrokeAlpha(1); pdf.setFillAlpha(1)
        center = transform(annotation['point'], matrix)
        pdf.line(center[0], center[1], max(x, min(center[0], x+width)), max(y, min(center[1], y+height)))
        pdf.setFillColor(HexColor(style['fill_color'])); pdf.setFillAlpha(style['opacity'])
        pdf.roundRect(x, y, width, height, min(3*scale, height/8), stroke=1, fill=int(style['fill_enabled']))
        pdf.setFillAlpha(1); pdf.setFillColor(HexColor(style['font_color']))
        for index, line in enumerate(lines):
            cursor, baseline = x+padding, y+height-padding-font_size-index*font_size*1.3
            for character, font, italic, underline, advance in line:
                pdf.saveState(); pdf.setFont(font, font_size)
                if italic:
                    pdf.translate(cursor, baseline); pdf.transform(1, 0, .18, 1, 0, 0)
                    pdf.drawString(0, 0, character)
                else:
                    pdf.drawString(cursor, baseline, character)
                pdf.restoreState()
                if underline:
                    pdf.setStrokeColor(HexColor(style['font_color'])); pdf.setLineWidth(max(.25, font_size/18))
                    pdf.line(cursor, baseline-font_size*.12, cursor+advance, baseline-font_size*.12)
                cursor += advance
        # The original-coordinate point is a presentation anchor, not a Count.
        pdf.setFillColor(HexColor(style['stroke_color'])); pdf.circle(center[0], center[1], 3*scale, stroke=0, fill=1)
        pdf.restoreState()


def _paint_signatures(pdf, signatures, matrix):
    """Project original-PDF quad axes; source/view rotation never moves ink."""
    from reportlab.lib.colors import HexColor
    for signature in signatures:
        q0, q1, _, q3 = signature['quad_pdf']
        style = signature['appearance']
        pdf.saveState()
        pdf.setStrokeColor(HexColor(style['stroke_color']))
        pdf.setFillColor(HexColor(style['stroke_color']))
        pdf.setLineWidth(style['stroke_width'])
        pdf.setStrokeAlpha(style['opacity']); pdf.setFillAlpha(style['opacity'])
        pdf.setLineCap(1); pdf.setLineJoin(1)
        for stroke in signature['strokes']:
            placed = [transform([q0[axis] + x * (q1[axis] - q0[axis]) + y * (q3[axis] - q0[axis])
                                 for axis in (0, 1)], matrix) for x, y in stroke]
            if len(placed) == 1:
                pdf.circle(*placed[0], style['stroke_width'] / 2, stroke=0, fill=1)
                continue
            path = pdf.beginPath(); path.moveTo(*placed[0])
            for point in placed[1:]:
                path.lineTo(*point)
            pdf.drawPath(path, stroke=1, fill=0)
        pdf.restoreState()


def _paint_markups(pdf, items, matrix, drawing_bounds=None, physical_zoom=None):
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
        if geometry.get('kind') in ('count', 'count-only'):
            pdf.setFillAlpha(style['opacity'])
            for point in points:
                center = transform(point, matrix)
                if item['mode'] == 'penetrations' and physical_zoom is not None:
                    physical_style = {**style,'marker_shape':'circle','marker_size':max(style['marker_size'],8/physical_zoom)}
                    pdf.saveState()
                    _paint_physical_callout(pdf,item,point,center,matrix,drawing_bounds,physical_zoom)
                    pdf.restoreState()
                    # The viewer paints the point in front of the callout.
                    _paint_count_marker(pdf,center,physical_style)
                    continue
                _paint_count_marker(pdf, center, style)
                pdf.setFillColor(HexColor(style['stroke_color'])); pdf.setFont('ExportVeraBold', 8)
                if item['mode'] == 'penetrations':
                    from reportlab.pdfbase.pdfmetrics import stringWidth
                    summary = item['physical_summary']
                    labels = list(summary)
                    layout = item.get('callout')
                    if layout and 'offset' in layout:
                        callout_style = {'stroke_color': '#FF3300', 'fill_color': '#FFDD33',
                            'font_color': '#000000', 'fill_enabled': True, 'stroke_width': 4, 'opacity': .75,
                            **layout.get('appearance', {})}
                        from reportlab.platypus import Paragraph
                        from reportlab.lib.styles import ParagraphStyle
                        offset = layout['offset']
                        anchor = transform([point[0]+offset[0], point[1]+offset[1]], matrix)
                        # The box stays upright, as it does in the viewer. Its
                        # stored dimensions are visual axes in PDF units;
                        # rotation affects the source anchor, not these axes.
                        source_scale = math.hypot(matrix[0], matrix[1])
                        width = source_scale*layout['width']
                        height = source_scale*layout['height']
                        left, bottom, right, top = drawing_bounds
                        width, height = min(width, right-left), min(height, top-bottom)
                        x = max(left, min(anchor[0], right-width))
                        y = max(bottom, min(anchor[1]-height, top-height))
                        padding = min(5, width/8, height/8)
                        font_size = 7
                        for _ in range(20):
                            paragraph = Paragraph('<br/>'.join(_text(label) for label in labels),
                                ParagraphStyle('PhysicalCallout', fontName='ExportVera', fontSize=font_size,
                                    leading=font_size*1.25, textColor=HexColor(callout_style['font_color'])))
                            _, needed = paragraph.wrap(max(.1, width-2*padding), max(.1, height-2*padding))
                            if needed <= height-2*padding:
                                break
                            font_size *= .75
                        pdf.setStrokeColor(HexColor(callout_style['stroke_color'])); pdf.setLineWidth(callout_style['stroke_width'])
                        pdf.setFillColor(HexColor(callout_style['fill_color'])); pdf.setFillAlpha(callout_style['opacity'])
                        pdf.roundRect(x, y, width, height, min(3, width/8, height/8), stroke=1, fill=int(callout_style['fill_enabled']))
                        pdf.setFillAlpha(style['opacity'])
                        pdf.line(center[0], center[1], x, y+height)
                        paragraph.drawOn(pdf, x+padding, y+height-padding-needed)
                        pdf.setFillColor(HexColor(style['fill_color']))
                        continue
                    # Full descriptions remain in the legend. Keep the drawing
                    # callout inside the original drawing's visible bounds.
                    left, bottom, right, top = drawing_bounds
                    available = max(20, min(240, right-left-12))
                    fitted = []
                    for label in labels:
                        while label and stringWidth(label, 'ExportVera', 7) > available:
                            label = label[:-1]
                        fitted.append(label)
                    label_x = max(left+4, min(center[0]+12, right-available-4))
                    label_y = max(bottom+10*len(fitted), min(center[1]+12, top-12))
                    pdf.line(center[0], center[1], label_x, label_y)
                    pdf.setFont('ExportVera', 7)
                    for line_index, label in enumerate(fitted):
                        pdf.drawString(label_x, label_y-10*line_index, label)
                else:
                    pdf.drawString(center[0]+style['marker_size']/2+3, center[1]+3, str(item['legend_number']))
                pdf.setFillColor(HexColor(style['fill_color']))
            _paint_value_labels(pdf, item, matrix, drawing_bounds)
            pdf.restoreState()
            continue
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
        _paint_length_additions(pdf, item, matrix, drawing_bounds)
        _paint_value_labels(pdf, item, matrix, drawing_bounds)
        pdf.restoreState()


def _paint_value_labels(pdf, item, matrix, bounds):
    from decimal import Decimal, localcontext, ROUND_HALF_UP
    from reportlab.lib.colors import HexColor
    from reportlab.pdfbase.pdfmetrics import stringWidth
    for label in item.get('value_labels', []):
        value = Decimal(str(label['value']))
        with localcontext() as context:
            context.prec = max(28, value.adjusted()+8)
            text = format(value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP), ',f') + ' ' + label['unit']
        x, y = transform(label['point'], matrix)
        width = stringWidth(text, 'ExportVeraBold', 8)
        x += item['appearance'].get('marker_size', 12)/2+5 if label['kind'] == 'cited-count' else -width/2
        y += 9
        if bounds:
            left, bottom, right, top = bounds
            x, y = max(left+2, min(x, right-width-2)), max(bottom+2, min(y, top-10))
        pdf.setFillAlpha(1); pdf.setFillColor(HexColor('#FFFFFF'))
        pdf.rect(x-1, y-1, width+2, 10, stroke=0, fill=1)
        pdf.setFillColor(HexColor(item['appearance'].get('font_color', item['appearance']['stroke_color']))); pdf.setFont('ExportVeraBold', 8)
        pdf.drawString(x, y, text)


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
    physical = bool(spec.get('physical_drawing'))
    font_dir = Path(__file__).resolve().parent.parent / 'static' / 'fonts' if physical else Path(reportlab.__file__).resolve().parent / 'fonts'
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
        metadata = dict(spec['document']['pages'][index])
        if physical:
            metadata['rotation'] = (metadata['rotation']+spec['physical_rendering']['rotations'].get(str(index+1),0))%360
        _, drawing_width, drawing_height = page_transform(metadata)
        if not 1 <= drawing_width <= MAX_PAGE_SIDE or not 1 <= drawing_height <= (MAX_PAGE_SIDE if physical else MAX_PAGE_SIDE-800):
            raise ValueError('This PDF page is outside the supported physical drawing export size.')
        contents = original.get_contents(); count = len(contents.get_data()) if contents is not None else 0
        total_content += count
        if count > MAX_CONTENT_BYTES or total_content > MAX_OUTPUT_BYTES:
            raise ValueError('Decoded PDF drawing content exceeds the safe export limit.')
        page_items = [item for item in spec['items'] if item['geometry']['page'] == index+1]
        for number, item in enumerate(page_items, 1): item['legend_number'] = number
        width = drawing_width if physical else max(595, drawing_width)
        first_rows, remaining, heading_height, legend_height = [], [], 0, 0
        if not physical:
            rows = _legend_rows(page_items,width,style)
            _,heading_height = _filename_heading(spec,width)
            remaining,used = list(rows),95+heading_height
            while remaining and used+remaining[0][2] <= 380:
                row = remaining.pop(0);first_rows.append(row);used += row[2]
            legend_height = max(125,used+15)
        height = drawing_height + legend_height
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
        drawing_left = (width-drawing_width)/2
        _paint_markups(pdf, page_items, matrix,
                       (drawing_left, legend_height, drawing_left+drawing_width, height),
                       spec['physical_rendering']['zoom'] if physical else None)
        _paint_drawing_legends(pdf, [legend for legend in spec.get('drawing_legends', []) if legend['page'] == index+1], matrix)
        _paint_annotations(pdf, [annotation for annotation in spec.get('annotations', []) if annotation['page'] == index+1], matrix,
                           (drawing_left, legend_height, drawing_left+drawing_width, height))
        _paint_signatures(pdf, [signature for signature in spec.get('signatures', []) if signature['page'] == index+1], matrix)
        if not physical:
            _paint_legend(pdf, first_rows, width, legend_height, spec, index+1)
        # Blank physical pages still need one overlay page after legends are removed.
        pdf.showPage(); pdf.save(); overlay.seek(0); page.merge_page(PdfReader(overlay).pages[0])
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
