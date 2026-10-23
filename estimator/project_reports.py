"""Combined project PDFs from captured drafts, using the existing report engines."""

from io import BytesIO

from pypdf import PdfReader, PdfWriter

from .calculator_report import build_calculator_report, build_calculator_summary_report
from .catalog import ValidationError
from .penetration_calculator import calculate as calculate_penetration, definition
from .penetration_report import render_penetration_pdf, render_penetration_summary_pdf
from .project_file import CALCULATOR_IDS
from .schedule_rows import blank_schedule_defaults, populated_schedule_rows
from .workbook_calculators import validate_calculator_edits


CALCULATORS = CALCULATOR_IDS
TITLES = {'steel_vermiculite': 'Steel spray', 'steel_board': 'Steel board',
          'ductwork': 'Ductwork', 'steel_intumescent': 'Steel intumescent'}


def build_project_report(calculators, penetration, configuration, project_details, *, materials=False, library=None, company=None, saved_calculators=None):
    """Include entered schedules, even partial ones; never include source examples."""
    if not isinstance(calculators, dict) or set(calculators) - set(CALCULATORS):
        raise ValidationError('Choose the available project calculators.')
    parts = []
    report_title = 'Full Product Summary' if materials else 'Fire Protection Schedule'
    builder = build_calculator_summary_report if materials else build_calculator_report
    for key in CALCULATORS:
        supplied = calculators.get(key, {})
        if not isinstance(supplied, dict) or set(supplied) - {'inputs'}:
            raise ValidationError('Include only the calculator input snapshots.')
        inputs = validate_calculator_edits(key, blank_schedule_defaults(key, supplied.get('inputs', {})), (saved_calculators or {}).get(key, {}))
        if populated_schedule_rows(key, inputs):
            options = {'include_project_details': not parts, 'project_report_title': report_title if not parts else None}
            parts.append((TITLES[key], builder(key, inputs, project_details=project_details, company=company, **options)))
    if penetration is not None:
        result = calculate_penetration(penetration, configuration)
        if result['rows']:
            fire_builder = render_penetration_summary_pdf if materials else render_penetration_pdf
            options = {'include_project_details': not parts, 'project_report_title': report_title if not parts else None}
            parts.append(('Firestopping', fire_builder(result, definition(configuration), project_details, library=library, company=company, **options)))
    if not parts:
        raise ValidationError('Enter at least one schedule row before downloading this report.')
    writer = PdfWriter()
    for title, payload in parts:
        writer.append(PdfReader(BytesIO(payload)), outline_item=title)
    writer.add_metadata({'/Title': report_title, '/Author': 'CLASSIFIRE'})
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
