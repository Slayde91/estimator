"""Inspection PDFs with the existing project header, evidence layout and plan pins."""
from io import BytesIO
from itertools import zip_longest

from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.platypus import PageBreak, SimpleDocTemplate, Spacer

from .assessment_references import UNAVAILABLE_RESULT
from .calculator_inspections import PHOTOS, inspection_number, normalize_inspection_register, recorded_thickness
from .catalog import ValidationError
from .company_settings import company_logo
from .documentation_catalog import CALCULATORS, CALCULATOR_INSPECTIONS, CALCULATOR_REGISTERS
from .inspection_register_report import register_photo_cells, render_register_table
from .passive_fire_register import _append_evidence, _INSPECTION_RED
from .pdf_fonts import FONT_REGULAR
from .register_plans import append_plan_pages
from .report import _Report, _company_header, _register_fonts, _LINE, _MUTED


_SOURCE_FIELDS = {
    'duct': (('location', 'Location'), ('duct_size', 'Duct Size (mm)')),
    'steel': (('location', 'Location'), ('section_id', 'Section ID'), ('critical_temp', 'Critical Temp (°C)')),
}
_COMMON_FIELDS = (
    ('product', 'Product'), ('frl', 'FRL'), ('quantity', 'Qty'), ('length', 'Length (m)'),
    ('report', 'Report'), ('required_thickness', 'Required Thickness (mm)'),
)
_REGISTER_COLUMNS = (
    ('Product', 89), ('FRL', 64), ('Qty', 24), ('Length (m)', 47), ('Report', 63),
    ('Required Thickness (mm)', 54), ('Recorded Thickness (mm)', 54), ('Number of Readings', 51),
)
_REGISTER_SOURCE = {
    'duct': (('Duct Size (mm)', 48),),
    'steel': (('Section ID', 48), ('Critical Temp (°C)', 40)),
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
    missing.extend(label for phase, label in PHOTOS.items() if not entry[phase])
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


def _summary_rows(report, entries, kind, labels, widths):
    rows = []
    for entry in entries:
        facts = dict(_rows(entry, kind))
        detail = [report.p(str(facts[label]) if facts[label] not in (None, '') else '—', 'cell')
                  for label in labels]
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
    columns = (('Location', 58), ('Inspection ID', 58), ('Calculator Register', 63),
               *_REGISTER_SOURCE[kind], *_REGISTER_COLUMNS)
    labels, weights = zip(*columns)
    payload = render_register_table(
        title, details, company, labels + tuple(PHOTOS.values()), weights + (45,) * len(PHOTOS),
        lambda report, widths: _summary_rows(report, completed, kind, labels, widths),
    )
    if any(entry['plan_pins'] for entry in completed):
        return append_plan_pages(payload, completed, plan_sessions, takeoffs,
                                 allow_unused_sessions=True, entry_label=inspection_number)
    return payload


def render_calculator_inspections(register, details, kind, *, company, plan_sessions=None, takeoffs=None):
    entries = normalize_inspection_register(register, kind)['entries']
    if not entries:
        raise ValidationError('Add an inspection before downloading its PDF.')
    for entry in entries:
        _ready(entry)
    title, _ = CALCULATOR_INSPECTIONS[kind]
    _register_fonts()
    report = _Report({})
    report.styles['photo_caption'] = report.styles['subheading'].clone('CalculatorInspectionPhotoCaption', alignment=TA_CENTER)
    logo = company_logo(company)
    output = BytesIO()
    width, height = A4
    margin = 36
    content = width - 2 * margin - 12
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=margin, rightMargin=margin,
                                 topMargin=90, bottomMargin=43, title=title, author=company.get('name') or 'CLASSIFIRE')

    def field_table(rows):
        cells = [[report.p(label, 'head'), report.p(str(value) if value not in (None, '') else '—', 'cell')]
                 for label, value in rows]
        return report.table(None, cells, [content * .34, content * .66], compact=True,
                            row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED)

    report.story.append(report.p(title, 'title'))
    project_rows = [(label, details[key]) for key, label in
                    (('project_no', 'Project number'), ('client', 'Client'), ('site_address', 'Site address'))
                    if details.get(key)]
    if project_rows:
        report.story.extend((field_table(project_rows), Spacer(1, 10)))
    for index, entry in enumerate(entries):
        if index:
            report.story.append(PageBreak())
        report.story.extend((field_table(_rows(entry, kind)), Spacer(1, 6)))
        _append_evidence(report, f'Inspection {inspection_number(entry)}',
                         ((label, entry[phase]) for phase, label in PHOTOS.items()), content)

    def decorate(canvas, doc):
        canvas.saveState()
        _company_header(canvas, logo, width, height, margin, title, company=company)
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
