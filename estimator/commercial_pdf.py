"""White-paper commercial documents with exact Full Schedule PDF appendices."""
from html import escape, unescape
from html.parser import HTMLParser
from io import BytesIO
from decimal import Decimal
from hashlib import sha256
import re

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Frame, HRFlowable, KeepTogether, LongTable,
                               PageTemplate, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

from .commercial_documents import KINDS, format_terms, totals, validate_fields
from .company_settings import company_logo, contact_lines
from .report import _company_header
from .pdf_fonts import FONT_BOLD, FONT_REGULAR, register_pdf_fonts
from .swms_pdf import Signature

RED = colors.HexColor('#bd0018')
WIDTH = A4[0] - 72


class _Paragraphs(HTMLParser):
    """Convert validated editor HTML into bounded ReportLab paragraph markup."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraphs = []
        self.current = []
        self.styles = []
        self.lists = []

    def flush(self):
        if self.current:
            self.paragraphs.append(''.join(self.current) + ''.join('</' + tag + '>' for tag in reversed(self.styles)))
        self.current = ['<' + tag + '>' for tag in self.styles]

    def handle_starttag(self, tag, attrs):
        mapped = {'strong': 'b', 'em': 'i'}.get(tag, tag)
        if mapped in {'b', 'i', 'u'}:
            self.styles.append(mapped)
            self.current.append('<' + mapped + '>')
        elif tag in {'ul', 'ol'}:
            self.flush()
            self.lists.append({'tag': tag, 'counter': 0})
        elif tag in {'p', 'div', 'li'}:
            self.flush()
            if tag == 'li':
                prefix = '&#8226; '
                if self.lists and self.lists[-1]['tag'] == 'ol':
                    self.lists[-1]['counter'] += 1
                    prefix = str(self.lists[-1]['counter']) + '. '
                self.current.append('&#160;' * max(0, 3 * (len(self.lists) - 1)) + prefix)
        elif tag == 'br':
            self.flush()

    def handle_endtag(self, tag):
        mapped = {'strong': 'b', 'em': 'i'}.get(tag, tag)
        if mapped in {'b', 'i', 'u'}:
            self.current.append('</' + mapped + '>')
            self.styles.pop()
        elif tag in {'p', 'div', 'li'}:
            self.flush()
        elif tag in {'ul', 'ol'}:
            self.flush()
            self.lists.pop()

    def handle_data(self, data):
        self.current.append(escape(data, quote=False))


def _styles(*, quote=False, work_order=False):
    return {
        'quote': quote,
        'red_tables': quote or work_order,
        'body': ParagraphStyle('CommercialBody', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=8.5, leading=12, spaceAfter=6),
        'small': ParagraphStyle('CommercialSmall', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=7, leading=10, spaceAfter=3),
        'title': ParagraphStyle('CommercialTitle', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=18, leading=22, textColor=RED, spaceAfter=14),
        'section': ParagraphStyle('CommercialSection', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=11, leading=15, textColor=RED, spaceBefore=14, spaceAfter=8, keepWithNext=True),
        'terms': ParagraphStyle('CommercialTerms', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=8, leading=11.5, spaceAfter=5),
        'head': ParagraphStyle('CommercialHead', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=8, leading=11,
                               textColor=colors.white if quote or work_order else colors.black),
        'field': ParagraphStyle('CommercialField', fontName=FONT_BOLD, bulletFontName=FONT_BOLD, fontSize=7, leading=10,
                                textColor=colors.white if quote or work_order else colors.black),
    }


def _paragraph(text, style):
    return Paragraph(escape(str(text or ''), quote=False).replace('\n', '<br/>'), style)


def _rich(text, style, *, keep_headings=False):
    parser = _Paragraphs()
    parser.feed(text)
    parser.flush()
    paragraphs = [Paragraph(item, style) for item in parser.paragraphs if item.strip()]
    if keep_headings:
        for paragraph in paragraphs:
            plain = paragraph.getPlainText()
            if plain in {'TERMS OF TRADE', 'Our Disclosures:'} or re.fullmatch(r'\d+\. [A-Za-z /&]+', plain):
                paragraph.keepWithNext = True
    return paragraphs


def _table(headers, rows, styles, widths=None):
    data = [[_paragraph(value, styles['head']) for value in headers]] if headers else []
    data.extend([[value if isinstance(value, Signature) else _paragraph(value, styles['field'] if headers is None and index == 0 else styles['small'])
                  for index, value in enumerate(row)] for row in rows])
    count = len(headers) if headers else len(rows[0])
    result = LongTable(data, colWidths=widths or [WIDTH / count] * count, repeatRows=1 if headers else 0, hAlign='LEFT')
    commands = [
        ('GRID', (0, 0), (-1, -1), .4, RED if styles['red_tables'] else colors.HexColor('#cccccc')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]
    if headers:
        commands.append(('BACKGROUND', (0, 0), (-1, 0), RED if styles['red_tables'] else colors.HexColor('#eeeeee')))
    elif styles['red_tables']:
        commands.append(('BACKGROUND', (0, 0), (0, -1), RED))
    result.setStyle(TableStyle(commands))
    return result


def _section(story, title, styles, *, splittable=False):
    style = styles['section']
    if splittable:
        # Keep room for the heading, column labels and first text line rather
        # than keeping an entire multi-page tracking table with its heading.
        story.append(CondPageBreak(90))
        style = style.clone('CommercialTrackingSection', keepWithNext=False)
    story.append(_paragraph(title, style))
    if styles['quote'] and title in {'QUOTE SUMMARY', 'SCHEDULE OF RATES', 'SCOPE OF WORKS', 'ALLOWANCES'}:
        rule = HRFlowable(width=WIDTH, thickness=1, color=RED, spaceAfter=8)
        rule.keepWithNext = True
        story.append(rule)


def _fields(story, pairs, styles, *, keep_together=False):
    rows = [(label, value or '—') for label, value in pairs]
    table = _table(None if styles['red_tables'] else ('Field', 'Details'), rows, styles, [125, WIDTH - 125])
    story.append(KeepTogether([table]) if keep_together else table)


def _money(value):
    amount = Decimal(value)
    return ('-' if amount < 0 else '') + f'${abs(amount):,.2f}'


def _summary(story, fields, styles):
    amounts = totals(fields)
    _section(story, 'QUOTE SUMMARY', styles)
    rows = [(line['description'], line['quantity'], _money(line['unit_price']), _money(amount)) for line, amount in zip(fields['lines'], amounts['lines'])]
    story.append(_table(('Product / Service', 'Quantity', 'Unit Price', 'Total Price'), rows, styles, [WIDTH * .55, WIDTH * .12, WIDTH * .16, WIDTH * .17]))


def _totals(story, fields, styles):
    amounts = totals(fields)
    story.append(Spacer(1, 12))
    _fields(story, [('Subtotal', _money(amounts['subtotal'])), ('GST (10%)', _money(amounts['gst'])), ('Grand total', _money(amounts['grand_total']))], styles)


def _rates(story, schedule, styles):
    _section(story, 'SCHEDULE OF RATES', styles)
    story.append(_paragraph(schedule['introduction'], styles['body']))
    rates = schedule['rates']
    for key, label, suffix in [
        ('ordinary_time', 'Ordinary time', 'per hour (7:00am to 3:30pm)'),
        ('time_and_half', 'Time and a half', 'per hour (3:30pm to 5:30pm and night shifts)'),
        ('double_time', 'Double time', 'per hour (After 5:30pm and weekends)'),
        ('site_remobilisation', 'Mobilisation', 'per occasion'),
        ('equipment', 'Equipment', ''), ('materials', 'Materials', '')
    ]:
        amount = (_money(rates[key]) + ' ' + suffix if suffix else
                  ('Hire Rate' if key == 'equipment' else 'Cost Rate') + ' + ' + format(Decimal(rates[key]).normalize(), 'f') + '%')
        story.append(Paragraph('<b>' + label + '</b> - ' + escape(amount), styles['body']))
    acceptance = schedule['acceptance']
    cells = []
    for labels in [(('accepted_by', 'Accepted by'), ('title', 'Title')), (('signature', 'Signature'), ('date', 'Date'))]:
        cells.append([[Paragraph('<b>' + label + '</b>', styles['small']),
                       _paragraph(acceptance[key], styles['body']), Spacer(1, 13),
                       HRFlowable(width=WIDTH / 2 - 18, thickness=.5, color=RED)]
                      for key, label in labels])
    table = Table(cells, colWidths=[WIDTH / 2] * 2)
    table.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), .4, RED),
                              ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                              ('TOPPADDING', (0, 0), (-1, -1), 8),
                              ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
                              ('LEFTPADDING', (0, 0), (-1, -1), 8)]))
    story.append(KeepTogether([Spacer(1, 14), table]))


def _terms_pdf(text, document, number, company):
    """The supplied quote's compact two-column Montserrat terms layout.

    Only presentation changes: the validated editor wording and inline emphasis
    remain authoritative, including custom terms. Clause labels occupy their
    own hanging gutter and paragraphs can continue into the next column.
    """
    register_pdf_fonts()
    base = ParagraphStyle('TradeTerms', fontName=FONT_REGULAR, bulletFontName=FONT_REGULAR, fontSize=8,
                          leading=10, spaceAfter=4, allowWidows=0, allowOrphans=0)
    parser = _Paragraphs()
    parser.feed(format_terms(text))
    parser.flush()
    story = []
    disclosure = False
    disclosure_heading = False
    for markup in parser.paragraphs:
        plain = unescape(re.sub('<[^>]+>', '', markup)).strip()
        if not plain:
            continue
        style = ParagraphStyle('TradeClause', parent=base)
        bullet = None
        if plain == 'TERMS OF TRADE':
            markup = '<u><b>-TERMS OF TRADE-</b></u>'
            style.keepWithNext = True
        elif plain == 'Our Disclosures:':
            disclosure = True
            disclosure_heading = True
            continue
        else:
            heading = re.match(r'^(\d+\.)\s+[A-Za-z /&]+$', plain)
            clause = re.match(r'^(\d+\.\d+(?:\.\d+)*|\([a-z]\)|\(\d+\))\s+', plain)
            label = (heading or clause)
            if label:
                disclosure = False
                label = label[1]
                markup = re.sub(r'^(\s*(?:<(?:b|i|u)>\s*)*)' + re.escape(label) + r'\s*', r'\1', markup, count=1)
                level = 3 if re.fullmatch(r'\(\d+\)', label) else 2 if label.startswith('(') else 1
                style.leftIndent, style.bulletIndent = 28.3 * level, 28.3 * (level - 1)
                style.bulletFontName, style.bulletFontSize = FONT_BOLD, base.fontSize
                bullet = label
                if heading:
                    style.textColor = RED
                    style.fontName = FONT_BOLD
                    style.keepWithNext = True
                    style.spaceBefore = 4
            elif disclosure and plain.startswith(('subject to your', 'additional charges')):
                style.leftIndent, style.bulletIndent = 14, 0
                style.bulletFontName, style.bulletFontSize = FONT_REGULAR, base.fontSize
                bullet = '\u2022'
        if disclosure_heading:
            markup = '<font color="#bd0018"><b>Our Disclosures:</b></font> ' + markup
            disclosure_heading = False
        story.append(Paragraph(markup, style, bulletText=bullet))
    if disclosure_heading:
        story.append(Paragraph('<font color="#bd0018"><b>Our Disclosures:</b></font>', base))
    if not story:
        return None
    output = BytesIO()
    margin, gap, top, bottom = 40.6, 8.7, 96, 48
    column = (A4[0] - margin * 2 - gap) / 2
    frames = [Frame(margin + index * (column + gap), bottom, column, A4[1] - top - bottom,
                    leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id=f'terms-{index}') for index in range(2)]
    logo = company_logo(company)
    def header(page, doc):
        _company_header(page, logo, A4[0], A4[1], 36, '', company=company)
    pdf = BaseDocTemplate(output, pagesize=A4, title='Terms and Conditions ' + number, author=company.get('name', ''))
    pdf.addPageTemplates(PageTemplate(id='trade-terms', frames=frames, onPage=header))
    pdf.build(story)
    return output.getvalue()


def _quotation_header(page, logo, company, title='QUOTATION'):
    """Reserve a true centre column for the first-page document heading."""
    width, height, margin = A4[0], A4[1], 36
    image_width, image_height = logo.getSize()
    scale = min(146 / image_width, 35 / image_height)
    page.drawImage(logo, margin, height - 22 - image_height * scale,
                   width=image_width * scale, height=image_height * scale, mask='auto')
    page.setFillColor(colors.HexColor('#555555'))
    # The right column cannot cross the centred heading, including long company
    # names or contact details. This does not alter the saved company values.
    for offset, value in [(15, company.get('name', '')), *zip((40, 51, 62), contact_lines(company))]:
        size = min(7.5, (width / 2 - 100) / max(1, stringWidth(value, FONT_REGULAR, 1)))
        page.setFont(FONT_REGULAR, size)
        page.drawRightString(width - margin, height - offset, value)
    page.setFont(FONT_BOLD, 16)
    page.setFillColor(RED)
    page.drawCentredString(width / 2, height - 43, title)
    page.setStrokeColor(RED)
    page.setLineWidth(1.1)
    page.line(margin, height - 78, width - margin, height - 78)


def _build(story, document, number, company, *, first_part=False):
    output = BytesIO()
    frame_margin = 30 if document['kind'] in {'quote', 'work_order'} else 36
    pdf = SimpleDocTemplate(output, pagesize=A4, leftMargin=frame_margin, rightMargin=frame_margin, topMargin=90, bottomMargin=32,
                            title=KINDS[document['kind']] + ' ' + number, author=company.get('name', ''))
    logo = company_logo(company)
    def decorate(page, doc):
        if document['kind'] == 'quote':
            if first_part and doc.page == 1:
                _quotation_header(page, logo, company)
            else:
                _company_header(page, logo, A4[0], A4[1], 36, '', company=company)
        elif document['kind'] == 'work_order' and first_part and doc.page == 1:
            _quotation_header(page, logo, company, 'WORK ORDER')
        else:
            _company_header(page, logo, A4[0], A4[1], 36, KINDS[document['kind']].upper() + ' ' + number, company=company)
    pdf.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()


def render_commercial_pdf(document, number, *, company, scope_documents=None, append_files=None):
    register_pdf_fonts()
    fields = validate_fields(document['fields'])
    kind = document['kind']
    styles = _styles(quote=kind == 'quote', work_order=kind == 'work_order')
    details, order = fields['details'], fields['order']
    story = [] if kind in {'quote', 'work_order'} else [_paragraph(KINDS[kind].upper(), styles['title'])]
    number_label = {'work_order':'Work order reference', 'purchase_order':'Purchase Order No.'}.get(kind, 'Document number')
    _fields(story, [(number_label, number), ('Date', details['date']), ('Customer', details['client']),
                   ('Contact', details['contact']), ('Site address', details['site_address']), ('Project number', details['project_no'])], styles)
    story.append(Spacer(1, 12))
    if fields['introduction']:
        story.append(_paragraph(fields['introduction'], styles['body']))
    parts = []
    if kind == 'quote':
        _summary(story, fields, styles)
        _totals(story, fields, styles)
        _rates(story, fields['rate_schedule'], styles)
        if scope_documents:
            scope_hash = sha256(fields['scope'].encode('utf-8')).hexdigest()
            embedded_scope = PdfReader(BytesIO(scope_documents[0])).metadata or {}
            if fields['scope'] and embedded_scope.get('/ClassifireScopeSHA256') != scope_hash:
                # Arbitrary supplied PDFs cannot be reflowed. Preserve the
                # caller's custom scope before them rather than dropping it.
                # App-generated scopes already include it with their table.
                _section(story, 'SCOPE OF WORKS', styles)
                story.extend(_rich(fields['scope'], styles['body']))
            # Generated schedules carry their own scope heading and estimate
            # name. A separate introductory PDF would force a blank remainder
            # of the page before the first schedule.
            parts.append(_build(story, document, number, company, first_part=True))
            parts.extend(scope_documents)
            story = []
        else:
            _section(story, 'SCOPE OF WORKS', styles)
            story.extend(_rich(fields['scope'], styles['body']))
            for table in fields['scope_tables']:
                columns = [index for index, header in enumerate(table['headers'])
                           if header.strip().casefold() not in {'calculation notes', 'status / estimating basis'}]
                if not columns:
                    continue
                _section(story, table['title'], styles)
                story.append(_table([table['headers'][index] for index in columns],
                                    [[row[index] for index in columns] for row in table['rows']], styles))
        _section(story, 'ALLOWANCES', styles)
        story.extend(_rich(fields['allowances'], styles['body']) or [_paragraph('—', styles['body'])])
        reference = fields['company_reference']
        previous_company = escape(f"{reference['name']} (ABN {reference['abn']})", quote=False)
        current_company = escape(f"{company.get('name', '')} (ABN {company.get('abn', '')})", quote=False)
        parts.append(_build(story, document, number, company, first_part=not parts))
        story = []
        terms = _terms_pdf(fields['terms'].replace(previous_company, current_company), document, number, company)
        if terms:
            parts.append(terms)
    elif kind == 'work_order':
        _section(story, 'WORK ORDER DETAILS', styles)
        _fields(story, [('Proposed start date', order['start_date']), ('Proposed end date', order['end_date']),
                       ('Category / urgency', order['urgency']), ('Quote reference', order['quote_reference']),
                       ('Client phone', details['phone']), ('Client email', details['email'])], styles)
        _section(story, 'WORK REQUESTED', styles)
        story.append(_paragraph(order['description'], styles['body']))
        cost = order['estimated_cost']
        try:
            cost = _money(cost) if cost else ''
        except ArithmeticError:
            pass  # Historical work orders could contain a free-text cost.
        _fields(story, [('Estimated cost (AUD)', cost)], styles)
        signatures = fields.get('signatures', {})
        for title, pairs in [
            ('WORK ORDER REVIEW', [('Review date', 'review_date'), ('Approval', 'approval'), ('Justification', 'justification'), ('Reviewed by', 'reviewed_by'), ('Name', 'reviewed_by')]),
            ('OHS DOCUMENTATION', [('Prepared by', 'prepared_by'), ('Name', 'prepared_by'), ('Date', 'prepared_date')]),
            ('CLIENT APPROVAL', [('Approved by', 'client_approved_by'), ('Name', 'client_approved_by'), ('Approval date', 'client_approval_date')]),
            ('WORKS IN PROGRESS', [('Progress signed by', 'progress_by'), ('Name', 'progress_by'), ('Date', 'progress_date')]),
            ('WORK ORDER CLAIM', []),
            ('WORK ORDER COMPLETION', [('Certification details', 'certification'), ('Completion', 'completion'), ('Closed by', 'closed_by'), ('Name', 'closed_by'), ('Date', 'closed_date')]),
        ]:
            _section(story, title, styles, splittable=title in {'WORKS IN PROGRESS', 'WORK ORDER CLAIM'})
            if title in ('WORKS IN PROGRESS','WORK ORDER CLAIM'):
                tracking = fields.get('work_tracking')
                key = 'completed_percent' if title=='WORKS IN PROGRESS' else 'claimed_percent'
                label = '% completed' if title=='WORKS IN PROGRESS' else '% claimed'
                if tracking is not None:
                    progress = key == 'completed_percent'
                    table = _table(('Product / Service','Quantity','Notes' if progress else 'Unit price',label),
                                   [(row['description'],row['quantity'],row.get('notes', '') if progress else _money(row['unit_price']),row[key]) for row in tracking['rows']],
                                   styles,[WIDTH*.55,WIDTH*.15,WIDTH*.15,WIDTH*.15])
                    table.splitInRow = 1
                    story.append(table)
                legacy = order['progress' if key=='completed_percent' else 'claim']
                if legacy:
                    _fields(story,[('Previous notes',legacy)],styles)
            if pairs:
                _fields(story, [(label, (Signature(signatures[key], 160, 52) if signatures.get(key) else '')
                                if label in ('Reviewed by', 'Prepared by', 'Approved by','Progress signed by','Closed by') else order.get(key, ''))
                               for label, key in pairs], styles, keep_together=True)
    else:
        _section(story, 'PURCHASE ORDER DETAILS', styles)
        _fields(story, [('Work order reference', order['work_order_reference']), ('Status', document['status']),
                       ('Supplier', order['supplier']), ('Supplier email', order['supplier_email']), ('Supplier contact', order['supplier_contact']),
                       ('Payment terms', order['payment_terms']), ('Site contact', order['ship_to_name']),
                       ('Site contact number', order.get('site_contact_number', '')), ('Delivery address', order['ship_to_address']),
                       ('Delivery date', order['delivery_date']), ('Type of expense', order['expense_type']), ('Delivery or pickup', order['delivery_method'])], styles)
        _section(story, 'REQUEST SUMMARY', styles)
        rows = [(line['description'], line['quantity'], line['size'], line['comments'], _money(line['unit_price'])) for line in fields['lines']]
        story.append(_table(('Item', 'Quantity', 'Size', 'Comments', 'Unit price'), rows, styles, [WIDTH*.28, WIDTH*.12, WIDTH*.18, WIDTH*.28, WIDTH*.14]))
        _totals(story, fields, styles)
        for title, pairs in [
            ('REQUESTED BY', [('Name', 'requested_by'), ('Date', 'requested_date')]),
            ('PURCHASE ORDER APPROVAL', [('Approval', 'approval'), ('Reviewed by', 'reviewed_by'), ('Review date', 'review_date')]),
            ('PROCUREMENT VERIFICATION', [('Verification method, specification, result and actions', 'verification'), ('Sent by', 'sent_by'), ('Sent date', 'sent_date'), ('Verified by', 'verified_by'), ('Verification date', 'verified_date')]),
        ]:
            _section(story, title, styles)
            _fields(story, [(label, order[key]) for label, key in pairs], styles)
    if story:
        parts.append(_build(story, document, number, company, first_part=not parts))
    writer = PdfWriter()
    for part in parts:
        writer.append(PdfReader(BytesIO(part)))
    original_pages = append_files(writer) if append_files else set()
    count = len(writer.pages)
    for index, page in enumerate(writer.pages, 1):
        if index - 1 in original_pages:
            continue
        footer = BytesIO()
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        overlay = canvas.Canvas(footer, pagesize=(width, height))
        overlay.setFont(FONT_REGULAR, 7)
        overlay.setFillColor(colors.HexColor('#555555'))
        overlay.drawCentredString(width / 2, 20, f'{KINDS[kind]} {number}  |  Page {index} of {count}')
        overlay.save()
        page.merge_page(PdfReader(BytesIO(footer.getvalue())).pages[0])
    writer.add_metadata({'/Title': KINDS[kind] + ' ' + number, '/Author': company.get('name', '')})
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
