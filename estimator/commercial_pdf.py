"""White-paper commercial documents with exact Full Schedule PDF appendices."""
from html import escape
from html.parser import HTMLParser
from io import BytesIO
from decimal import Decimal
import re

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

from .commercial_documents import KINDS, format_terms, totals, validate_fields
from .company_settings import company_logo
from .report import _company_header, _register_fonts

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


def _styles():
    return {
        'body': ParagraphStyle('CommercialBody', fontName='CeasefireVera', fontSize=8.5, leading=12, spaceAfter=6),
        'small': ParagraphStyle('CommercialSmall', fontName='CeasefireVera', fontSize=7, leading=10, spaceAfter=3),
        'title': ParagraphStyle('CommercialTitle', fontName='CeasefireVeraBold', fontSize=18, leading=22, textColor=RED, spaceAfter=14),
        'section': ParagraphStyle('CommercialSection', fontName='CeasefireVeraBold', fontSize=11, leading=15, textColor=RED, spaceBefore=14, spaceAfter=8, keepWithNext=True),
        'terms': ParagraphStyle('CommercialTerms', fontName='CeasefireVera', fontSize=8, leading=11.5, spaceAfter=5),
        'head': ParagraphStyle('CommercialHead', fontName='CeasefireVeraBold', fontSize=8, leading=11),
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
    data = [[_paragraph(value, styles['head']) for value in headers]]
    data.extend([[_paragraph(value, styles['small']) for value in row] for row in rows])
    result = LongTable(data, colWidths=widths or [WIDTH / len(headers)] * len(headers), repeatRows=1, hAlign='LEFT')
    result.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eeeeee')),
        ('GRID', (0, 0), (-1, -1), .4, colors.HexColor('#cccccc')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return result


def _section(story, title, styles):
    story.append(_paragraph(title, styles['section']))


def _fields(story, pairs, styles):
    rows = [(label, value or '—') for label, value in pairs]
    story.append(_table(('Field', 'Details'), rows, styles, [125, WIDTH - 125]))


def _money(value):
    return f'${Decimal(value):,.2f}'


def _summary(story, fields, styles):
    amounts = totals(fields)
    _section(story, 'QUOTE SUMMARY', styles)
    rows = [(line['description'], line['quantity'], _money(line['unit_price']), _money(amount)) for line, amount in zip(fields['lines'], amounts['lines'])]
    story.append(_table(('Product / Service', 'Quantity', 'Unit Price', 'Total Price'), rows, styles, [WIDTH * .55, WIDTH * .12, WIDTH * .16, WIDTH * .17]))


def _totals(story, fields, styles):
    amounts = totals(fields)
    story.append(Spacer(1, 12))
    _fields(story, [('Subtotal', _money(amounts['subtotal'])), ('GST (10%)', _money(amounts['gst'])), ('Grand total', _money(amounts['grand_total']))], styles)


def _build(story, document, number, company):
    output = BytesIO()
    pdf = SimpleDocTemplate(output, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=90, bottomMargin=32,
                            title=KINDS[document['kind']] + ' ' + number, author=company.get('name', ''))
    logo = company_logo(company)
    def decorate(page, doc):
        _company_header(page, logo, A4[0], A4[1], 36, KINDS[document['kind']].upper() + ' ' + number, company=company)
    pdf.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()


def render_commercial_pdf(document, number, *, company, scope_documents=None):
    _register_fonts()
    fields = validate_fields(document['fields'])
    styles = _styles()
    kind = document['kind']
    details, order = fields['details'], fields['order']
    story = [_paragraph(KINDS[kind].upper(), styles['title'])]
    _fields(story, [('Document number', number), ('Date', details['date']), ('Customer', details['client']),
                   ('Contact', details['contact']), ('Site address', details['site_address']), ('Project number', details['project_no'])], styles)
    story.append(Spacer(1, 12))
    if fields['introduction']:
        story.append(_paragraph(fields['introduction'], styles['body']))
    parts = []
    if kind == 'quote':
        _summary(story, fields, styles)
        _section(story, 'SCOPE OF WORKS', styles)
        story.extend(_rich(fields['scope'], styles['body']))
        if scope_documents:
            story.append(_paragraph('The following Full Schedules form the Scope of Works for this quotation.', styles['body']))
            parts.append(_build(story, document, number, company))
            parts.extend(scope_documents)
            story = []
        else:
            for table in fields['scope_tables']:
                _section(story, table['title'], styles)
                story.append(_table(table['headers'], table['rows'], styles))
        _section(story, 'ALLOWANCES', styles)
        story.extend(_rich(fields['allowances'], styles['body']) or [_paragraph('—', styles['body'])])
        _totals(story, fields, styles)
        _section(story, 'TERMS & CONDITIONS', styles)
        reference = fields['company_reference']
        previous_company = escape(f"{reference['name']} (ABN {reference['abn']})", quote=False)
        current_company = escape(f"{company.get('name', '')} (ABN {company.get('abn', '')})", quote=False)
        story.extend(_rich(format_terms(fields['terms'].replace(previous_company, current_company)), styles['terms'], keep_headings=True))
    elif kind == 'work_order':
        _section(story, 'WORK ORDER DETAILS', styles)
        _fields(story, [('Proposed start date', order['start_date']), ('Proposed end date', order['end_date']),
                       ('Category / urgency', order['urgency']), ('Quote reference', order['quote_reference']),
                       ('Client phone', details['phone']), ('Client email', details['email'])], styles)
        _section(story, 'WORK REQUESTED', styles)
        story.append(_paragraph(order['description'], styles['body']))
        _fields(story, [('Estimated cost (AUD)', order['estimated_cost']), ('Image / video references', order['attachments'])], styles)
        for title, pairs in [
            ('WORK ORDER REVIEW', [('Review date', 'review_date'), ('Approval', 'approval'), ('Justification', 'justification'), ('Reviewed by', 'reviewed_by')]),
            ('OHS DOCUMENTATION', [('SWMS', 'swms'), ('SDS', 'sds'), ('SOP', 'sop'), ('Other documents', 'other_documents'), ('Prepared by', 'prepared_by')]),
            ('CLIENT APPROVAL', [('Safety documentation approval', 'client_approval'), ('Approved by', 'client_approved_by'), ('Approval date', 'client_approval_date')]),
            ('WORKS IN PROGRESS', [('Progress', 'progress')]),
            ('WORK ORDER CLAIM', [('Products and services charged', 'claim')]),
            ('CERTIFICATION', [('Certification details', 'certification')]),
            ('WORK ORDER COMPLETION', [('Completion', 'completion'), ('Closed by', 'closed_by')]),
        ]:
            _section(story, title, styles)
            _fields(story, [(label, order[key]) for label, key in pairs], styles)
    else:
        _section(story, 'PURCHASE ORDER DETAILS', styles)
        _fields(story, [('Work order reference', order['work_order_reference']), ('Status', document['status']),
                       ('Supplier', order['supplier']), ('Supplier email', order['supplier_email']), ('Supplier contact', order['supplier_contact']),
                       ('Payment terms', order['payment_terms']), ('Ship to', order['ship_to_name']), ('Delivery address', order['ship_to_address']),
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
    parts.append(_build(story, document, number, company))
    writer = PdfWriter()
    for part in parts:
        writer.append(PdfReader(BytesIO(part)))
    count = len(writer.pages)
    for index, page in enumerate(writer.pages, 1):
        footer = BytesIO()
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        overlay = canvas.Canvas(footer, pagesize=(width, height))
        overlay.setFont('CeasefireVera', 7)
        overlay.setFillColor(colors.HexColor('#555555'))
        overlay.drawCentredString(width / 2, 9, f'{KINDS[kind]} {number}  |  Page {index} of {count}')
        overlay.save()
        page.merge_page(PdfReader(BytesIO(footer.getvalue())).pages[0])
    writer.add_metadata({'/Title': KINDS[kind] + ' ' + number, '/Author': company.get('name', '')})
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
