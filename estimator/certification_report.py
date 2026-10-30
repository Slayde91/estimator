"""Company-branded installation certificates from explicit user-entered text."""
from datetime import datetime, timezone
from io import BytesIO
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Flowable, HRFlowable, KeepTogether, LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

from .company_settings import company_logo
from .report import _company_header, _register_fonts


ATTESTATION = ('{company} are approved by the manufacturers listed above to supply and install passive fire '
               'products in accordance with tested and certified systems. I am a properly qualified person '
               'and have a good working knowledge of the relevant codes and standards referenced above. '
               'The information contained in this statement is true and accurate to the best of my knowledge.')
EXCLUSIONS_INTRO = 'Certification is strictly limited to works completed by {company}, as per:'
_RED = colors.HexColor('#BD0018')
_LINE = colors.HexColor('#D7D7D7')
_MARGIN = 36
# SimpleDocTemplate's frame has six-point padding on both sides.
_WIDTH = A4[0] - 2 * _MARGIN - 12


class _SignerImage(Flowable):
    def __init__(self, image):
        super().__init__()
        self.image = image
        width, height = image.getSize()
        scale = min((_WIDTH * .2 - 12) / width, 55 / height, 1)
        self.width, self.height = width * scale, height * scale

    def draw(self):
        self.canv.drawImage(self.image, 0, 0, width=self.width, height=self.height, mask='auto')


def render_certificate_pdf(fields, *, company, certificate_id, revision, created_at, signature=None):
    """Render one immutable revision; covers are applied by the revision service."""
    _register_fonts()
    company_name = company.get('name', '')
    styles = {
        'title': ParagraphStyle('CertificateTitle', fontName='CeasefireVeraBold', fontSize=15,
                                leading=19, textColor=_RED, spaceAfter=9, keepWithNext=True),
        'heading': ParagraphStyle('CertificateHeading', fontName='CeasefireVeraBold', fontSize=10.5,
                                  leading=14, textColor=_RED, spaceBefore=8, spaceAfter=5, keepWithNext=True),
        'body': ParagraphStyle('CertificateBody', fontName='CeasefireVera', fontSize=8.5,
                               leading=11.5, spaceAfter=5, splitLongWords=True),
        'declaration': ParagraphStyle('CertificateDeclaration', fontName='CeasefireVeraBold', fontSize=8.5,
                                      leading=11.5, spaceAfter=5, splitLongWords=True),
        'label': ParagraphStyle('CertificateLabel', fontName='CeasefireVera', fontSize=8.5,
                                leading=11.5, textColor=_RED, spaceBefore=6, spaceAfter=2,
                                keepWithNext=True, splitLongWords=True),
        'cell_label': ParagraphStyle('CertificateCellLabel', fontName='CeasefireVeraBold', fontSize=8,
                                    leading=11, textColor=_RED, spaceAfter=5, splitLongWords=True),
        'cell': ParagraphStyle('CertificateCell', fontName='CeasefireVera', fontSize=8.2,
                              leading=11.5, splitLongWords=True),
        'head': ParagraphStyle('CertificateHead', fontName='CeasefireVera', fontSize=8,
                              leading=11, textColor=colors.white, splitLongWords=True),
    }
    def p(value, style='body'):
        return Paragraph(escape(value or '').replace('\n', '<br/>') or '&#160;', styles[style])
    def details(rows):
        # Each value uses the whole text width. Independent paragraphs allow
        # long user entries to continue naturally across certificate pages.
        blocks = []
        for label, value in rows:
            blocks.extend((p(label, 'label'), p(value, 'body'),
                           HRFlowable(width='100%', thickness=.4, color=_LINE)))
        return blocks
    output = BytesIO()
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=_MARGIN, rightMargin=_MARGIN,
                                 topMargin=92, bottomMargin=44, title='Installation Certificate',
                                 author=company_name, creator='CLASSIFIRE',
                                 subject=f'Certificate {certificate_id} - Revision {revision}')
    issued = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    # A revision's issue date is frozen at generation. Explicit timezone data
    # keeps Sydney daylight saving correct on Windows and during later reads.
    if issued.tzinfo is None:
        issued = issued.replace(tzinfo=timezone.utc)
    timestamp = issued.astimezone(timezone.utc).strftime('%d %b %Y, %H:%M UTC')
    issue_date = issued.astimezone(ZoneInfo('Australia/Sydney')).strftime('%d %B %Y')
    short_id = certificate_id[:8].upper()
    logo = company_logo(company)
    def page(canvas, doc):
        _company_header(canvas, logo, A4[0], A4[1], _MARGIN, '', company=company)
        canvas.saveState()
        canvas.setStrokeColor(_LINE); canvas.setLineWidth(.4)
        canvas.line(_MARGIN, 33, A4[0] - _MARGIN, 33)
        canvas.setFillColor(colors.HexColor('#555555')); canvas.setFont('CeasefireVera', 7)
        canvas.drawString(_MARGIN, 22, f'Certificate {short_id} | Revision {revision} | {timestamp}')
        canvas.drawRightString(A4[0] - _MARGIN, 22, f'Page {doc.page}')
        canvas.restoreState()
    identity = LongTable([[[p(label, 'cell_label'), p(value, 'cell')] for label, value in (
        ('Client', fields['client']), ('Project', fields['project']), ('Address', fields['address']),
        ('Location/Area', fields['location_area']),
    )]], colWidths=[_WIDTH / 4] * 4, hAlign='LEFT', splitByRow=1, splitInRow=1)
    identity.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('GRID', (0, 0), (-1, -1), .4, _LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ]))
    story = [p('Installation Certificate', 'title'), identity,
        p('Statement of Compliance', 'heading'), p(fields['statement_of_compliance'], 'declaration'), *details([
        ('The relevant Australian Standards listed in the NCC as follows:', fields['australian_standards']),
        ('The relevant clauses of the NCC, as follows:', fields['ncc_clauses']),
        ('The design detail submitted at the construction approval stage:', fields['approved_design']),
        ('The following additional Australian Standards (if applicable)', fields['additional_standards']),
        ('Other practices, standards, or reports (such as Fire Safety or Disabled Access reports) relied '
         'upon or that modify the BCA or Australian standards for this certification', fields['other_references']),
        ('Exclusions - ' + EXCLUSIONS_INTRO.format(company=company_name), fields['exclusions']),
        ('Materials/Manufacturers:', fields['materials_manufacturers']),
        ('Fire Resistance Level:', fields['fire_resistance_level']),
    ]), Spacer(1, 12), p(ATTESTATION.format(company=company_name), 'declaration'), Spacer(1, 5)]
    signer_values = [p(fields[key], 'cell') for key in ('name', 'position', 'qualification', 'accreditation')]
    if signature:
        from .certification_signature import signature_reader
        # Validated, orientation-correct artwork remains with the person's name
        # inside the same four-column signer table.
        signer_values[0] = [signer_values[0], Spacer(1, 5), _SignerImage(signature_reader(signature))]
    signatories = LongTable([[p(label, 'head') for label in ('Name', 'Position', 'Qualification', 'Accreditation')],
                            signer_values,
                            [Paragraph('<font color="#BD0018">Date:</font> ' + escape(issue_date), styles['cell']), '', '', '']],
                           colWidths=[_WIDTH * .2, _WIDTH * .2, _WIDTH * .3, _WIDTH * .3],
                           repeatRows=1, hAlign='LEFT', splitByRow=1, splitInRow=1)
    signatories.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), _RED), ('GRID', (0, 0), (-1, -1), .4, _RED),
        ('SPAN', (0, -1), (-1, -1)),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6), ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    # Keep ordinary signer details, artwork and their issue date together. A
    # genuinely page-long qualification can still split without losing text.
    story.append(KeepTogether([signatories]))
    document.build(story, onFirstPage=page, onLaterPages=page)
    return output.getvalue()
