"""Inspection PDFs with the existing project header, evidence layout and plan pins."""
from io import BytesIO
from itertools import zip_longest

from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.platypus import PageBreak, SimpleDocTemplate, Spacer

from .assessment_references import UNAVAILABLE_RESULT, saved_report_references
from .calculator_inspections import PHOTOS, inspection_number, normalize_inspection_register, recorded_thickness
from .catalog import ValidationError
from .company_settings import company_logo
from .date_display import display_date, pdf_download_date
from .documentation_catalog import CALCULATORS, CALCULATOR_INSPECTIONS, CALCULATOR_REGISTERS
from .inspection_photo_layout import inspection_detail_width, inspection_photo_layout
from .inspection_register_report import register_photo_cells, render_register_table
from .passive_fire_register import _INSPECTION_RED
from .pdf_fonts import FONT_REGULAR
from .register_plans import append_plan_pages
from .report import _Report, _company_header, _register_fonts, _LINE, _MUTED
from .swms_pdf import Signature


_SOURCE_FIELDS = {
    'duct': (('location', 'Location'), ('duct_size', 'Duct Size (mm)')),
    'steel': (('location', 'Location'), ('section_id', 'Section ID'), ('critical_temp', 'Critical Temp (°C)')),
}
_COMMON_FIELDS = (
    ('product', 'Product'), ('frl', 'FRL'), ('quantity', 'Qty'), ('length', 'Length (m)'),
    ('report', 'Report'), ('required_thickness', 'Required Thickness (mm)'),
)
_REGISTER_COLUMNS = (
    ('Product', 89), ('FRL', 64), ('Qty', 24), ('Length (m)', 47), ('Report', 73),
    ('Required Thickness (mm)', 54), ('Recorded Thickness (mm)', 54), ('Number of Readings', 51),
)
_REGISTER_SOURCE = {
    'duct': (('Duct Size (mm)', 48),),
    'steel': (('Section ID', 52), ('Critical Temp (°C)', 40)),
}


def _ready(entry):
    row = entry['row']
    missing = []
    if row is None:
        missing.append('calculator register row')
    elif row['required_thickness'] in ('', UNAVAILABLE_RESULT):
        source = CALCULATORS[row['calculator_id']]
        raise ValidationError(
            f"Inspection {inspection_number(entry)}: {source}, line {row['line']}, "
            'has no calculated required thickness. Review the calculation, then refresh '
            'the inspection register and select the updated row.'
        )
    if not entry['readings']:
        missing.append('Recorded Thickness (mm)')
    missing.extend(label for phase, label in PHOTOS.items() if phase != 'gauge' and not entry[phase])
    if missing:
        raise ValidationError(f"Inspection {inspection_number(entry)}: complete " + ', '.join(missing) + '.')


def _rows(entry, kind):
    row = entry['row']
    source = f"{CALCULATORS[row['calculator_id']]} | line {row['line']}"
    readings = entry['readings']
    return [
        ('Inspection ID', inspection_number(entry)),
        ('Calculator Register', source),
        *((label, row[field]) for field, label in (*_SOURCE_FIELDS[kind], *_COMMON_FIELDS)),
        ('Recorded Thickness (mm)', recorded_thickness(readings)),
        ('Number of Readings', len(readings)),
    ]


def _field_cell(report, label, value, calculator_id=None):
    if label == 'Report' and value:
        return report.report_links(saved_report_references(calculator_id, value))
    return report.p(str(value) if value not in (None, '') else '—', 'cell')


def _summary_rows(report, entries, kind, labels, widths):
    rows = []
    for entry in entries:
        facts = dict(_rows(entry, kind))
        detail = [_field_cell(report, label, facts[label], entry['row']['calculator_id']) for label in labels]
        for index, photos in enumerate(zip_longest(*(entry[phase] for phase in PHOTOS))):
            cells = detail if index == 0 else detail[:2] + [''] * (len(detail) - 2)
            rows.append(cells + register_photo_cells(photos, widths[-len(PHOTOS):]))
    return rows


def render_calculator_register(register, details, kind, *, company, plan_sessions=None, takeoffs=None):
    """Export completed inspections as a landscape register with evidence thumbnails."""
    completed = []
    for entry in normalize_inspection_register(register, kind)['entries']:
        try:
            _ready(entry)
        except ValidationError:
            continue
        completed.append(entry)
    if not completed:
        raise ValidationError(f'There are no completed {CALCULATOR_INSPECTIONS[kind][0].lower()}.')

    title, _ = CALCULATOR_REGISTERS[kind]
    columns = (('Location', 58), ('Inspection ID', 58), *_REGISTER_SOURCE[kind], *_REGISTER_COLUMNS)
    labels, weights = zip(*columns)
    payload = render_register_table(
        title, details, company, labels + tuple(PHOTOS.values()), weights + (45,) * len(PHOTOS),
        lambda report, widths: _summary_rows(report, completed, kind, labels, widths),
    )
    if any(entry['plan_pins'] for entry in completed):
        return append_plan_pages(payload, completed, plan_sessions, takeoffs,
                                 allow_unused_sessions=True, entry_label=inspection_number)
    return payload


def _inspection_photos(entry):
    # The phase order in each selection is the order beside the details.
    limits = (
        {'before': 1, 'during': 1, 'after': 1},
        {'gauge': 1, 'before': 1, 'after': 1},
        {'gauge': 2, 'before': 1},
        {'gauge': 3},
    )[min(len(entry['gauge']), 3)]
    promoted = {phase: [] for phase in limits}
    remaining = []
    title = f'Inspection {inspection_number(entry)}'
    for phase, label in PHOTOS.items():
        photos = entry[phase]
        for index, photo in enumerate(photos):
            caption = f'{title} - {label}'
            if len(photos) > 1:
                caption += f' ({index + 1}/{len(photos)})'
            destination = promoted[phase] if index < limits.get(phase, 0) else remaining
            destination.append((caption, photo))
    return [photo for photos in promoted.values() for photo in photos], remaining


def render_calculator_inspections(register, details, kind, *, company, plan_sessions=None, takeoffs=None):
    entries = normalize_inspection_register(register, kind)['entries']
    if not entries:
        raise ValidationError('Add an inspection before downloading its PDF.')
    for entry in entries:
        _ready(entry)
    title, _ = CALCULATOR_INSPECTIONS[kind]
    _register_fonts()
    report = _Report({})
    report.styles['photo_caption'] = report.styles['subheading'].clone(
        'CalculatorInspectionPhotoCaption', alignment=TA_CENTER, fontSize=9, leading=11, spaceBefore=0, spaceAfter=4)
    logo = company_logo(company)
    output = BytesIO()
    width, height = A4
    margin = 36
    content = width - 2 * margin - 12
    facts_width = inspection_detail_width(content)
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=margin, rightMargin=margin,
                                 topMargin=90, bottomMargin=43, title=title, author=company.get('name') or 'CLASSIFIRE')

    def field_table(rows, widths, calculator_id=None):
        cells = [[report.p(label, 'head'), value if isinstance(value, Signature)
                  else _field_cell(report, label, value, calculator_id)]
                 for label, value in rows]
        return report.table(None, cells, widths, compact=True,
                            row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED)

    project_rows = [(label, details[key]) for key, label in
                    (('project_no', 'Project number'), ('client', 'Client'), ('site_address', 'Site address'))
                    if details.get(key)]
    if kind == 'duct':
        project_rows.append(('Date', pdf_download_date()))
    if project_rows:
        report.story.extend((field_table(project_rows, [content * .30, content * .70]), Spacer(1, 8)))

    for index, entry in enumerate(entries):
        if index:
            report.story.append(PageBreak())
        facts = _rows(entry, kind)
        facts.insert(1, ('Date', display_date(entry.get('inspection_date'))))
        if signature := entry.get('signature'):
            signer = entry.get('signature_details') or {}
            facts.extend((('Name', signer.get('name')), ('Date signed', display_date(signer.get('date'))),
                          ('Signature', Signature(signature, 144, 36))))
        table = field_table(facts, [facts_width * .42, facts_width * .58], entry['row']['calculator_id'])
        promoted, remaining = _inspection_photos(entry)
        report.story.extend(inspection_photo_layout(report, table, promoted, remaining, content, _INSPECTION_RED,
                                                    page_height=document.height - 12))

    def decorate(canvas, doc):
        canvas.saveState()
        first_page = doc.page == 1
        _company_header(canvas, logo, width, height, margin, title.upper() if first_page else '',
                        company=company, centered_title_color=_INSPECTION_RED if first_page else None)
        canvas.setStrokeColor(_LINE)
        canvas.line(margin, 32, width - margin, 32)
        canvas.setFillColor(_MUTED)
        canvas.setFont(FONT_REGULAR, 7.5)
        canvas.drawString(margin, 20, title)
        canvas.drawRightString(width - margin, 20, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    payload = output.getvalue()
    if any(entry['plan_pins'] for entry in entries):
        return append_plan_pages(payload, entries, plan_sessions, takeoffs, entry_label=inspection_number)
    return payload
