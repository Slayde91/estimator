"""Editable SWMS content rendered in the supplied landscape template's layout."""
import base64
from datetime import datetime
from html import escape
from io import BytesIO
from zoneinfo import ZoneInfo

from pypdf import PdfReader, PdfWriter, Transformation
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, LongTable, PageBreak, PageTemplate, Paragraph, Spacer, TableStyle

from .company_settings import company_logo, contact_lines
from .pdf_fonts import FONT_BOLD, FONT_REGULAR, register_pdf_fonts
from .swms import template_options, validate_fields

PAGE = landscape(A4)
MARGIN = 39
WIDTH = PAGE[0] - MARGIN * 2
RED = colors.HexColor('#d40000')


def _styles():
    return {
        'body': ParagraphStyle('SwmsBody', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=7.1, leading=9.7, spaceAfter=2),
        'bold': ParagraphStyle('SwmsBold', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=7.1, leading=9.7, spaceAfter=2),
        'head': ParagraphStyle('SwmsHead', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=7.1, leading=9.7, textColor=colors.white),
        'section': ParagraphStyle('SwmsSection', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=8, leading=11, spaceAfter=5, keepWithNext=True),
        'large': ParagraphStyle('SwmsLarge', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=10.5, leading=14, spaceAfter=10),
    }


def _p(text, style, bullets=False):
    lines = str(text or '').splitlines()
    if not lines:
        lines = ['']
    rendered = '<br/>'.join(('&#8226; ' if bullets and line.strip() else '') + escape(line.removeprefix('◦ '), quote=False) for line in lines)
    return Paragraph(rendered or '&#160;', style)


def _emergency_paragraphs(text, style, *, bullets_after_first=False, bold_from=None, first_bold=False, break_before_bold=False):
    """Reproduce the reference's emphasis and hanging bullets with editable text.

    Text is always escaped; formatting comes only from the trusted layout, never
    from HTML supplied in a draft.
    """
    lines = str(text or '').splitlines() or ['']
    result = []
    for index, line in enumerate(lines):
        markup = escape(line, quote=False)
        if index == 0 and bold_from and bold_from.lower() in line.lower():
            position = line.lower().index(bold_from.lower())
            markup = escape(line[:position], quote=False) + ('<br/>' if break_before_bold else '') + '<b>' + escape(line[position:], quote=False) + '</b>'
        elif index == 0 and first_bold:
            markup = '<b>' + markup + '</b>'
        bullet = bullets_after_first and index > 0 and line.strip()
        paragraph_style = ParagraphStyle('EmergencyBullet', parent=style, leftIndent=19, bulletIndent=2) if bullet else style
        result.append(Paragraph(markup or '&#160;', paragraph_style, bulletText='•' if bullet else None))
    return result


def _emergency_table(fields, styles):
    body = ParagraphStyle('EmergencyRequirements', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=8.2, leading=9.2,
                          textColor=colors.HexColor('#17365d'))
    head = ParagraphStyle('EmergencyHeader', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=9, leading=10,
                          textColor=colors.white, alignment=1)
    table = _table(None, [[_p('EMERGENCY RESPONSE - CALL 000 IMMEDIATELY.', head), ''],
                         [_emergency_paragraphs(fields[key], body, bullets_after_first=True)
                          for key in ('emergency_requirements', 'emergency_access')]], [WIDTH / 2] * 2, styles)
    table.setStyle(TableStyle([('SPAN', (0, 0), (1, 0)), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e52000')),
                               ('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
                               ('LINEBEFORE', (1, 1), (1, 1), .45, RED)]))
    return table


class Signature(Flowable):
    def __init__(self, value, width=75, height=28):
        super().__init__()
        self.value, self.width, self.height = value, width, height

    def draw(self):
        if not self.value:
            return
        ratio = self.value['ratio']
        width = min(self.width, self.height * ratio)
        height = width / ratio
        x, y = (self.width - width) / 2, (self.height - height) / 2
        self.canv.setStrokeColor(colors.black)
        self.canv.setLineWidth(.7)
        for stroke in self.value['strokes']:
            path = self.canv.beginPath()
            path.moveTo(x + stroke[0][0] * width, y + (1 - stroke[0][1]) * height)
            for px, py in stroke[1:]:
                path.lineTo(x + px * width, y + (1 - py) * height)
            if len(stroke) == 1:
                path.lineTo(x + stroke[0][0] * width + .1, y + (1 - stroke[0][1]) * height)
            self.canv.drawPath(path)


class SwmsTable(LongTable):
    def split(self, available_width, available_height):
        parts = super().split(available_width, available_height)
        if not parts and self.splitInRow and available_height > 2 * self.splitInRow:
            # ReportLab rejects a row that barely exceeds the frame when its
            # remaining tail would be shorter than splitInRow. Move the split
            # up once so the continuation has a readable minimum-sized tail.
            parts = super().split(available_width, available_height - self.splitInRow)
        headers = getattr(self, '_swms_headers', None)
        if headers:
            for part in parts:
                part._swms_headers = headers
                part._swms_header_style = self._swms_header_style
            for part in parts[1:]:
                # ReportLab may consume a wrapped Paragraph when the same
                # repeating header passes through several split fragments.
                part._cellvalues[0] = [_p(label, self._swms_header_style) for label in headers]
        return parts


def _table(headers, rows, widths, styles, *, repeated=True, grid=True, row_heights=None):
    head_style = styles['head']
    data = [[_p(label, head_style) for label in headers]] if headers else []
    for row in rows:
        data.append([value if isinstance(value, (Flowable, list)) else _p(value, styles['body']) for value in row])
    table = SwmsTable(data, colWidths=widths, rowHeights=row_heights, repeatRows=1 if headers and repeated else 0, hAlign='LEFT')
    if headers and repeated:
        table._swms_headers, table._swms_header_style = headers, head_style
    table.splitInRow = 30
    commands = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 4),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4), ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]
    if headers:
        commands.append(('BACKGROUND', (0, 0), (-1, 0), RED))
    if grid:
        commands.append(('GRID', (0, 0), (-1, -1), .45, RED))
    table.setStyle(TableStyle(commands))
    return table


def _pair(label, text, styles, *, bullets=False):
    table = _table(None, [[_p(label, styles['bold']), _p(text, styles['body'], bullets=bullets)]], [WIDTH * .27, WIDTH * .73], styles, grid=False)
    table.setStyle(TableStyle([('LINEABOVE', (0, 0), (-1, 0), .35, RED),
                               ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
    return table


def _people(rows, styles):
    pairs = []
    for index in range(0, len(rows), 2):
        row = []
        for person in rows[index:index + 2]:
            row.extend([_p(person['name'], styles['bold']), person['position'], Signature(person['signature'], 91, 28)])
        row += [''] * (6 - len(row))
        pairs.append(row)
    return _table(['Name', 'Position', 'Signature'] * 2, pairs or [[''] * 6], [WIDTH * .135, WIDTH * .20, WIDTH * .165] * 2, styles)


def _matrix(styles):
    descriptions = [
        'Potential death, permanent disability, or major structural failure/damage. Off-site environmental discharge/release not contained and significant long-term environmental harm.',
        'Potential temporary disability or minor structural failure/damage. On-site environmental discharge/release contained, minor remediation required, short-term environmental harm.',
        'Incident that has the potential to cause persons to require first aid. On-site environmental discharge/release immediately contained, minor level clean up with no short-term environmental harm.'
    ]
    rows = []
    for index, (label, levels) in enumerate([('H (1)\n(High level of harm)', ['1', '1', '2']), ('M (2)\n(Medium level of harm)', ['1', '2', '3']), ('L (3)\n(Low level of harm)', ['2', '3', '3'])]):
        rows.append([label, descriptions[index], ('H (1)\n(High)', 'M (2)\n(Medium)', 'L (3)\n(Low)')[index], *levels])
    table = _table(['Level', 'Description of Consequence or Impact', 'Consequence', 'Likely', 'Moderate', 'Unlikely'], rows,
                   [WIDTH * fraction for fraction in (.13, .52, .12, .077, .077, .076)], styles)
    colours = {'1': '#ff2600', '2': '#ffd43b', '3': '#a3ce36'}
    commands = [('BACKGROUND', (0, 0), (-1, 0), RED), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white), ('GRID', (0, 0), (-1, -1), .6, RED)]
    for row, values in enumerate(rows, 1):
        for column in range(3, 6):
            commands.extend([('BACKGROUND', (column, row), (column, row), colors.HexColor(colours[values[column]])), ('ALIGN', (column, row), (column, row), 'CENTER')])
    table.setStyle(TableStyle(commands))
    legend = _table(['Level', 'Likelihood / Probability'], [['Likely', 'Could happen frequently'], ['Moderate', 'Could happen occasionally'], ['Unlikely', 'May occur only in exceptional circumstances']], [WIDTH * .13, WIDTH * .87], styles)
    return [table, legend]


class EmergencyPlan(Flowable):
    def __init__(self, fields, styles):
        super().__init__()
        self.fields, self.styles, self.width, self.height = fields, styles, WIDTH, 425

    def _boxes(self):
        f, w = self.fields, self.width
        style = ParagraphStyle('EmergencyPlanBody', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=8.2, leading=9.9)
        notify = _emergency_paragraphs(f['emergency_notify'], style, bold_from='immediately', break_before_bold=True)
        notify += [Spacer(1, 10), *_emergency_paragraphs(f['emergency_contacts'], style)]
        call = _emergency_paragraphs(f['emergency_call'], style, bullets_after_first=True)
        first_line = f['emergency_call'].splitlines()[0] if f['emergency_call'] else ''
        if first_line.startswith('Call 000'):
            call[0] = Paragraph('<b>Call 000</b>' + escape(first_line[8:]), style)
        return [(w * .344, 290, w * .311, 97, notify),
                (w * .017, 231, w * .276, 40, _emergency_paragraphs(f['emergency_supervisor'], style, bold_from='immediately')),
                (w * .361, 116, w * .311, 153, call),
                (w * .732, 171, w * .242, 100, [Spacer(1, 20), *_emergency_paragraphs(f['emergency_stop'].replace('\n', '\n\n', 1), style, first_bold=True)]),
                (w * .358, 19, w * .276, 52, _emergency_paragraphs(f['emergency_follow'], ParagraphStyle('EmergencyFollow', parent=style, fontName=FONT_BOLD)))]

    def has_overflow(self):
        return any(sum(part.wrap(width - 10, height)[1] for part in paragraphs) > height - 10
                   for _, _, width, height, paragraphs in self._boxes())

    def draw(self):
        c, f, w = self.canv, self.fields, self.width
        c.setFont(FONT_BOLD, 18)
        c.drawCentredString(w / 2, 404, 'EMERGENCY RESPONSE PLAN')
        def box(x, y, width, height, paragraphs):
            c.setStrokeColor(colors.black)
            c.setLineWidth(.75)
            c.rect(x, y, width, height)
            measurements = [part.wrap(width - 10, height)[1] for part in paragraphs]
            if sum(measurements) > height - 10:
                # Long editable text is also printed in the following overflow table.
                paragraphs = [_p('See the emergency response details below.', self.styles['body'])]
                measurements = [paragraphs[0].wrap(width - 10, height)[1]]
            top = y + height - 5
            for part, measured in zip(paragraphs, measurements):
                top -= measured
                part.drawOn(c, x + 5, top)
        for coordinates in self._boxes():
            box(*coordinates)
        c.setStrokeColor(colors.HexColor('#386fc1'))
        c.setFillColor(colors.HexColor('#386fc1'))
        c.setLineWidth(1.1)
        def arrow(points):
            path = c.beginPath(); path.moveTo(*points[0])
            for point in points[1:]: path.lineTo(*point)
            c.drawPath(path)
            x, y = points[-1]; previous_x, previous_y = points[-2]
            if x == previous_x:
                direction = 1 if previous_y > y else -1
                triangle = [x - 3, y + 6 * direction, x + 3, y + 6 * direction]
            else:
                direction = 1 if previous_x > x else -1
                triangle = [x + 6 * direction, y - 3, x + 6 * direction, y + 3]
            path = c.beginPath(); path.moveTo(x, y); path.lineTo(*triangle[:2]); path.lineTo(*triangle[2:]); path.close(); c.drawPath(path, fill=1)
        arrow([(w * .50, 290), (w * .50, 271)])
        arrow([(w * .344, 360), (w * .148, 360), (w * .148, 273)])
        arrow([(w * .655, 360), (w * .851, 360), (w * .851, 273)])
        arrow([(w * .496, 116), (w * .496, 73)])
        arrow([(w * .148, 231), (w * .148, 45), (w * .356, 45)])
        arrow([(w * .851, 171), (w * .851, 43), (w * .636, 43)])


def render_swms_pdf(document, *, company):
    register_pdf_fonts()
    fields = validate_fields(document['fields'])
    styles, details = _styles(), fields['details']
    story = []
    story.append(_table(['Job Reference', 'SWMS Reference', 'Contact Person', 'Position', 'Phone:'],
                        [[details['job_reference'], document.get('reference', ''), details['contact_person'], details['position'], details['phone']]],
                        [WIDTH * fraction for fraction in (.21, .18, .23, .21, .17)], styles))
    story.append(Spacer(1, 10))
    story.append(_table(['Principal Contractor (PC)', 'Project Name', 'Date:', 'Project Address', 'Project Manager (PM)', 'Signature:', 'Contact'],
                        [[details['principal_contractor'], details['project_name'], details['date'], details['project_address'], details['project_manager'], Signature(fields['manager_signature'], 40, 25), details['manager_contact']]],
                        [WIDTH * fraction for fraction in (.20, .20, .067, .20, .13, .07, .133)], styles))
    story.extend([Spacer(1, 6), _p(fields['communication'], styles['bold']), Spacer(1, 6), _p(fields['toolbox'], styles['body']), Spacer(1, 6)])
    story.extend([_p('Person/s responsible for ensuring compliance with SWMS:', styles['bold']), _p(fields['compliance'], styles['body']), Spacer(1, 6)])
    for label, key in [('Person/s responsible for reviewing SWMS:', 'reviewers'), ('This SWMS has been developed in consultation with:', 'consultation')]:
        story.extend([_p(label, styles['section']), _people(fields[key], styles), Spacer(1, 7)])
    story.append(_table(['Qualifications/Competency Required to complete tasks', 'Personnel/Duties and Responsibilities (Supervisory Staff and others)', 'Additional training required to complete task'],
                        [[_p(fields[key], styles['body'], bullets=True) for key in ('qualifications', 'duties', 'training')]], [WIDTH / 3] * 3, styles))
    story.extend([PageBreak(), _p(fields['requirements'], styles['body'], bullets=True), Spacer(1, 10)])
    for label, key, bullets in [('Activity', 'activity', False), ('OHS/Environmental Legislation', 'legislation', True), ('Codes of Practice', 'codes', True), ('Resources/Trades Involved', 'resources', True), ('Equipment/Plant/Materials Used', 'equipment', False)]:
        story.append(_pair(label, fields[key], styles, bullets=bullets))
    # Continue related content in the same frame when it fits. Long editable
    # fields still split naturally instead of reserving mostly empty pages.
    story.extend([_pair('Maintenance Checks Required', fields['maintenance'], styles), PageBreak(), _p('Risk Matrix', styles['section']), *_matrix(styles), _pair('High Risk Work involves', fields['high_risk_work'], styles)])
    def step_table(title, steps):
        rows = []
        for index, row in enumerate(steps, 1):
            controls = '\n'.join(line.strip().removeprefix('- ') for line in row['controls'].splitlines() if line.strip())
            rows.append([str(index), _p(row['job_step'], styles['bold']), row['hazards'], row['initial_risk'], _p(controls, styles['body'], bullets=True), row['residual_risk'], row['responsible']])
        heading = _p(title, styles['section'])
        heading.keepWithNext = False
        table = _table(['Item', 'Job Steps', 'Hazards', 'Risk Rating', 'Controls to Eliminate/Reduce Hazard', 'Retained Risk', 'Responsible Person'], rows,
                       [WIDTH * fraction for fraction in (.055, .13, .255, .065, .255, .065, .175)], styles)
        table.wrap(WIDTH, 100000)
        # Keep normal job steps together; allow an exceptionally long editable
        # row to continue across pages instead of failing or dropping its text.
        table.splitInRow = 30 if max(table._rowHeights) > 400 else 0
        return [heading, table]
    high_risk_tables = fields.get('high_risk_steps', template_options()['high_risk_tables'])
    for choice in fields['high_risk_work'].splitlines():
        if high_risk_tables.get(choice):
            story.extend(step_table(choice, high_risk_tables[choice]))
    story.extend([PageBreak(), _pair('Type of Works', '\n'.join(fields['work_types']), styles)])
    for index, kind in enumerate(fields['work_types']):
        if index:
            story.append(PageBreak())
        story.extend(step_table(kind, fields['steps'][kind]))
    story.append(_pair('Additional Job Steps', 'Are there additional job steps to consider? ' + ('Yes' if fields['additional_steps'] else 'No'), styles))
    if fields['additional_steps'] and fields['additional_rows']:
        story.extend(step_table('Additional Job Steps', fields['additional_rows']))
    story.extend([PageBreak(), _p(fields['acknowledgement'], styles['large']), _p('Reviews', styles['section'])])
    story.append(_table(['Review No.', *map(str, range(1, 11))], [['Initials', *fields['reviews']]], [WIDTH / 3, *([WIDTH / 15] * 10)], styles))
    story.extend([Spacer(1, 16), _emergency_table(fields, styles)])
    story.extend([PageBreak(), _p('Site Sign-Off', styles['section'])])
    signoffs = fields['site_signoffs']
    site_rows = []
    for index in range(0, max(32, len(signoffs)), 2):
        row = []
        for person in signoffs[index:index + 2]:
            row.extend([person['name'], Signature(person['signature'], 110, 18)])
        row += [''] * (4 - len(row))
        site_rows.append(row)
    site_table = _table(['NAME', 'SIGNATURE', 'NAME', 'SIGNATURE'], site_rows, [WIDTH / 3, WIDTH / 6] * 2, styles)
    site_table.setStyle(TableStyle([('TOPPADDING', (0, 1), (-1, -1), 8), ('BOTTOMPADDING', (0, 1), (-1, -1), 8)]))
    emergency = EmergencyPlan(fields, styles)
    story.extend([site_table, PageBreak(), emergency])
    # Preserve all user-entered emergency text even when it outgrows the diagram.
    if emergency.has_overflow():
        story.extend([PageBreak(), _p('Emergency response details', styles['large'])])
        for label, key in [('Notify', 'emergency_notify'), ('Contacts', 'emergency_contacts'), ('Supervisor', 'emergency_supervisor'), ('Emergency call', 'emergency_call'), ('Stop work', 'emergency_stop'), ('Follow instructions', 'emergency_follow')]:
            story.append(_pair(label, fields[key], styles))
    created = datetime.now(ZoneInfo('Australia/Sydney')).strftime('%a, %d %b %Y, %I:%M %p')
    logo = company_logo(company)
    output = BytesIO()
    doc = BaseDocTemplate(output, pagesize=PAGE, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=76, bottomMargin=49,
                            title=fields['title'], author=company.get('name', ''), allowSplitting=True)
    def decorate(c, document):
        c.saveState()
        c.drawImage(logo, MARGIN, PAGE[1] - 47, width=98, height=32, preserveAspectRatio=True, anchor='sw', mask='auto')
        text = '\n'.join([company.get('name', ''), *contact_lines(company)])
        for size in (7, 6.5, 6, 5.5, 5, 4.5):
            text_style = ParagraphStyle('SwmsCompany', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=size, leading=size * 1.25, alignment=2)
            paragraph = _p(text, text_style)
            _, company_height = paragraph.wrap(WIDTH * .72, 48)
            if company_height <= 44:
                break
        paragraph.drawOn(c, MARGIN + WIDTH * .28, PAGE[1] - 12 - company_height)
        c.setStrokeColor(RED); c.setLineWidth(.6)
        c.line(MARGIN, PAGE[1] - 60, PAGE[0] - MARGIN, PAGE[1] - 60)
        c.line(MARGIN, 39, PAGE[0] - MARGIN, 39)
        c.setFont(FONT_REGULAR, 6.2); c.setFillColor(colors.HexColor('#333333'))
        c.drawString(MARGIN + WIDTH * .69, 26, 'This PDF was created at')
        c.drawString(MARGIN + WIDTH * .69, 17, created)
        c.restoreState()
    frame = Frame(MARGIN, 49, WIDTH, PAGE[1] - 76 - 49, leftPadding=0, bottomPadding=0, rightPadding=0, topPadding=0)
    doc.addPageTemplates(PageTemplate('SWMS', frames=frame, onPage=decorate))
    doc.build(story)
    reader, writer = PdfReader(BytesIO(output.getvalue())), PdfWriter()
    pages = list(reader.pages)
    for attachment in fields['attachments']:
        data = base64.b64decode(attachment['data'].split(',', 1)[1])
        if attachment['media_type'] == 'application/pdf':
            for source in PdfReader(BytesIO(data)).pages:
                attachment_writer = PdfWriter()
                page = attachment_writer.add_blank_page(*PAGE)
                source.transfer_rotation_to_content()
                scale = min(WIDTH / float(source.mediabox.width), 430 / float(source.mediabox.height))
                page.merge_transformed_page(source, Transformation().translate(-float(source.mediabox.left), -float(source.mediabox.bottom)).scale(scale).translate(MARGIN + (WIDTH - float(source.mediabox.width) * scale) / 2, 52 + (430 - float(source.mediabox.height) * scale) / 2))
                header = BytesIO(); c = canvas.Canvas(header, pagesize=PAGE); decorate(c, doc)
                c.setFont(FONT_BOLD, 8); c.drawString(MARGIN, PAGE[1] - 75, attachment['name']); c.save()
                page.merge_page(PdfReader(BytesIO(header.getvalue())).pages[0]); pages.append(page)
        else:
            header = BytesIO(); c = canvas.Canvas(header, pagesize=PAGE); decorate(c, doc)
            c.setFont(FONT_BOLD, 8); c.drawString(MARGIN, PAGE[1] - 75, attachment['name'])
            c.drawImage(ImageReader(BytesIO(data)), MARGIN, 52, width=WIDTH, height=430, preserveAspectRatio=True, anchor='c', mask='auto')
            c.save(); pages.extend(PdfReader(BytesIO(header.getvalue())).pages)
    count = len(pages)
    for index, page in enumerate(pages, 1):
        overlay = BytesIO(); c = canvas.Canvas(overlay, pagesize=PAGE)
        c.setFont(FONT_REGULAR, 6.2); c.setFillColor(colors.HexColor('#333333'))
        c.drawString(MARGIN, 26, f'Page {index} of {count}')
        c.save(); page.merge_page(PdfReader(BytesIO(overlay.getvalue())).pages[0]); writer.add_page(page)
    writer.add_metadata({'/Title': fields['title'], '/Author': company.get('name', '')})
    output = BytesIO(); writer.write(output)
    return output.getvalue()
