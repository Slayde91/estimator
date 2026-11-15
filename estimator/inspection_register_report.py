"""Tabular PDF of completed Passive Fire Inspections in the current project."""
import base64
from io import BytesIO
from itertools import zip_longest

from reportlab.lib.pagesizes import A4, landscape
from reportlab.platypus import Image, LongTable, PageBreak, SimpleDocTemplate, Spacer

from .catalog import ValidationError
from .company_settings import company_logo
from .documentation_catalog import register_options
from .passive_fire_register import JPEG_PREFIX, PHASES, _INSPECTION_RED, _ready, normalize_register
from .pdf_fonts import FONT_REGULAR
from .reference_library import ReferenceNotFound
from .register_plans import append_plan_pages
from .report import _Report, _company_header, _register_fonts, _LINE, _MUTED
from .technical_item_exports import prepare_technical_item, technical_pdf_rows


TITLE = 'Passive Fire Registers'
HEADINGS = ('Level/Location', 'Penetration ID', 'Substrate', 'Orientation', 'Category', 'Services',
            'Manufacturer', 'FRL', 'Report Numbers', *PHASES.values())
FACETS = ('substrate', 'orientation', 'category', 'services', 'manufacturer', 'frl')


class _RegisterTable(LongTable):
    def split(self, availWidth, availHeight):
        parts = super().split(availWidth, availHeight)
        # A tall next row can split into the space below the first fragment.
        # Start its continuation on a fresh page so the heading occurs only once.
        if len(parts) == 2:
            return [parts[0], PageBreak(), parts[1]]
        return parts


def _system_cells(report, entry, library):
    key = entry.get('technical_item_id')
    if not key:
        legacy = [entry['substrate'], entry['orientation'], '', ', '.join(entry['service_types']),
                  entry['manufacturer'], entry['frl'], entry['report']]
        return [report.p(value or '—', 'cell') for value in legacy]
    selected = entry.get('technical_filters', {})
    try:
        item = prepare_technical_item({'id': key}, library=library, include_diagrams=False, inspection_filters=selected)
    except ReferenceNotFound as error:
        raise ValidationError(f"The Technical Library item for entry {entry['number']} is unavailable. Select a replacement before downloading.") from error

    # The inspection exporter resolves ambiguous historical facets explicitly and
    # preserves links on individual report numbers. Use those same source values.
    fields = {}
    for name, cell in technical_pdf_rows(report, item):
        label = name.casefold()
        if label == 'service':
            label = 'services'
        if label in FACETS or label == 'report number':
            fields.setdefault(label, []).append(cell)
    cells = []
    for facet in FACETS:
        values = fields.get(facet, [])
        if selected.get(facet):
            cells.append(report.p(selected[facet], 'cell'))
        else:
            cells.append(values[0] if values else report.p('—', 'cell'))
    return cells + [fields.get('report number') or report.p('—', 'cell')]


def _register_rows(report, entries, library, widths):
    rows = []
    for entry in entries:
        system = _system_cells(report, entry, library)
        for side in ('side1', 'side2') if entry['access'] == 'Yes' else ('side1',):
            record = entry[side]
            # Keep photos from the two sides independently identifiable and allow
            # additional photos in any phase to flow across page boundaries.
            for index, photos in enumerate(zip_longest(*(record[phase] for phase in PHASES))):
                row = [report.p(entry['location'], 'cell'), report.p(record['id_number'], 'cell')]
                row.extend(system if index == 0 else [''] * len(system))
                for value, width in zip(photos, widths[-4:]):
                    if value is None:
                        row.append('')
                    else:
                        image = Image(BytesIO(base64.b64decode(value[len(JPEG_PREFIX):])))
                        image._restrictSize(width - 12, 48)
                        image.hAlign = 'CENTER'
                        row.append(image)
                rows.append(row)
    return rows


def render_inspection_register(register, details, *, library, company, plan_sessions=None, takeoffs=None):
    options = register_options()
    completed = []
    for entry in normalize_register(register)['entries']:
        try:
            _ready(entry, entry['number'], options)
        except ValidationError:
            continue
        completed.append(entry)
    if not completed:
        raise ValidationError('There are no completed passive fire inspections.')

    _register_fonts()
    output = BytesIO()
    report = _Report({})
    width, height = landscape(A4)
    margin = 24
    document = SimpleDocTemplate(output, pagesize=(width, height), leftMargin=margin, rightMargin=margin,
                                 topMargin=90, bottomMargin=36, title=TITLE, author=company.get('name') or 'CLASSIFIRE')
    content = document.width - 12
    report.story.append(report.p('Project Details', 'subheading'))
    project_rows = [[report.p(label, 'head'), report.p(details.get(key) or '—', 'cell')]
                    for key, label in [('project_no', 'Project No.'), ('client', 'Client'), ('site_address', 'Site Address')]]
    report.story.append(report.table(None, project_rows, [content * .18, content * .82],
                                     compact=True, row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED))
    report.story.append(Spacer(1, 10))
    weights = (72, 67, 84, 61, 69, 71, 70, 48, 70, 49, 49, 49, 49)
    widths = [content * weight / sum(weights) for weight in weights]
    grid = report.table(HEADINGS, _register_rows(report, completed, library, widths), widths,
                        compact=True, grid_color=_INSPECTION_RED, table_type=_RegisterTable)
    grid.setStyle([('LEFTPADDING', (0, 0), (-1, -1), 3), ('RIGHTPADDING', (0, 0), (-1, -1), 3)])
    report.story.append(grid)

    logo = company_logo(company)
    def decorate(canvas, doc):
        canvas.saveState()
        first_page = doc.page == 1
        _company_header(canvas, logo, width, height, margin, 'PASSIVE FIRE REGISTER' if first_page else '',
                        company=company, centered_title_color=_INSPECTION_RED if first_page else None)
        canvas.setStrokeColor(_LINE)
        canvas.line(margin, 30, width - margin, 30)
        canvas.setFillColor(_MUTED)
        canvas.setFont(FONT_REGULAR, 7.5)
        canvas.drawString(margin, 19, TITLE)
        canvas.drawRightString(width - margin, 19, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    if any(entry.get('plan_pins') for entry in completed):
        # The client captures sessions before the server checks which inspections are complete.
        return append_plan_pages(output.getvalue(), completed, plan_sessions, takeoffs, allow_unused_sessions=True)
    return output.getvalue()
