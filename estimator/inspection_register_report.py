"""Tabular PDF of completed Passive Fire Inspections in the current project."""
import base64
from io import BytesIO
from itertools import zip_longest

from reportlab.lib.pagesizes import A4, landscape
from reportlab.platypus import Image, LongTable, PageBreak, SimpleDocTemplate, Spacer

from .catalog import ValidationError
from .company_settings import company_logo
from .date_display import pdf_download_date
from .documentation_catalog import register_options
from .passive_fire_register import JPEG_PREFIX, PHASES, _INSPECTION_RED, _ready, normalize_register
from .pdf_fonts import FONT_REGULAR
from .reference_library import ReferenceNotFound
from .register_plans import append_plan_pages, penetration_ids
from .report import _Report, _company_header, _register_fonts, _LINE, _MUTED
from .technical_item_exports import prepare_technical_item, technical_export_rows, technical_pdf_cell


TITLE = 'Passive Fire Register'
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


def _system_fields(entry, library):
    key = entry.get('technical_item_id')
    if entry.get('custom_entry'):
        values = [entry['technical_filters'][facet] for facet in FACETS]
        return [(value, None) for value in values], [(entry['report'], None)]
    if not key:
        legacy = [entry['substrate'], entry['orientation'], '', ', '.join(entry['service_types']),
                  entry['manufacturer'], entry['frl'], entry['report']]
        return [(value, None) for value in legacy[:-1]], [(legacy[-1], None)]
    selected = entry.get('technical_filters', {})
    try:
        item = prepare_technical_item({'id': key}, library=library, include_diagrams=False, inspection_filters=selected)
    except ReferenceNotFound as error:
        raise ValidationError(f'Penetration ID {penetration_ids(entry)}: the Technical Library item is unavailable. Select a replacement before downloading.') from error

    # The inspection exporter resolves ambiguous historical facets explicitly and
    # preserves links on individual report numbers. Use those same source values.
    fields = {}
    for name, value, url in technical_export_rows(item):
        label = name.casefold()
        if label == 'service':
            label = 'services'
        if label in FACETS or label == 'report number':
            fields.setdefault(label, []).append((value, url))
    values = [(selected[facet], None) if selected.get(facet) else fields.get(facet, [('', None)])[0]
              for facet in FACETS]
    return values, fields.get('report number', [])


def passive_register_rows(entries, library):
    """Yield the two sides and additional photo rows used by each export."""
    for entry in entries:
        system, report_numbers = _system_fields(entry, library)
        for side in ('side1', 'side2') if entry['access'] == 'Yes' else ('side1',):
            record = entry[side]
            # Keep photos from the two sides independently identifiable and allow
            # additional photos in any phase to flow across page boundaries.
            for index, photos in enumerate(zip_longest(*(record[phase] for phase in PHASES))):
                identity = (entry['location'], record['id_number'])
                yield identity, system if index == 0 else None, report_numbers if index == 0 else [], photos


def _register_rows(report, entries, library, widths):
    rows = []
    for identity, system, report_numbers, photos in passive_register_rows(entries, library):
        row = [report.p(value, 'cell') for value in identity]
        if system is None:
            row.extend([''] * (len(FACETS) + 1))
        else:
            row.extend(technical_pdf_cell(report, value or '—', url) for value, url in system)
            row.append([technical_pdf_cell(report, value, url) for value, url in report_numbers if value]
                       or report.p('—', 'cell'))
        row.extend(register_photo_cells(photos, widths[-len(PHASES):]))
        rows.append(row)
    return rows


def register_photo_cells(photos, widths):
    cells = []
    for value, width in zip(photos, widths):
        if value is None:
            cells.append('')
        else:
            image = Image(BytesIO(base64.b64decode(value[len(JPEG_PREFIX):])))
            image._restrictSize(width - 12, 48)
            image.hAlign = 'CENTER'
            cells.append(image)
    return cells


def render_register_table(title, details, company, headings, weights, rows):
    """Match the project header, pagination, and evidence-grid layout for registers."""
    _register_fonts()
    output = BytesIO()
    report = _Report({})
    width, height = landscape(A4)
    margin = 24
    document = SimpleDocTemplate(output, pagesize=(width, height), leftMargin=margin, rightMargin=margin,
                                 topMargin=90, bottomMargin=36, title=title, author=company.get('name') or 'CLASSIFIRE')
    content = document.width - 12
    report.story.append(report.p('Project Details', 'subheading'))
    project_rows = [[report.p(label, 'head'), report.p(details.get(key) or '—', 'cell')]
                    for key, label in [('project_no', 'Project No.'), ('client', 'Client'), ('site_address', 'Site Address')]]
    project_rows.append([report.p('Date', 'head'), report.p(pdf_download_date(), 'cell')])
    report.story.append(report.table(None, project_rows, [content * .18, content * .82],
                                     compact=True, row_header_color=_INSPECTION_RED, grid_color=_INSPECTION_RED))
    report.story.append(Spacer(1, 10))
    widths = [content * weight / sum(weights) for weight in weights]
    grid = report.table(headings, rows(report, widths), widths,
                        compact=True, grid_color=_INSPECTION_RED, table_type=_RegisterTable)
    grid.setStyle([('LEFTPADDING', (0, 0), (-1, -1), 3), ('RIGHTPADDING', (0, 0), (-1, -1), 3)])
    report.story.append(grid)

    logo = company_logo(company)
    def decorate(canvas, doc):
        canvas.saveState()
        first_page = doc.page == 1
        _company_header(canvas, logo, width, height, margin, title.upper() if first_page else '',
                        company=company, centered_title_color=_INSPECTION_RED if first_page else None)
        canvas.setStrokeColor(_LINE)
        canvas.line(margin, 30, width - margin, 30)
        canvas.setFillColor(_MUTED)
        canvas.setFont(FONT_REGULAR, 7.5)
        canvas.drawString(margin, 19, title)
        canvas.drawRightString(width - margin, 19, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()


def completed_passive_inspections(register):
    options = register_options()
    completed = []
    for entry in normalize_register(register)['entries']:
        try:
            _ready(entry, options)
        except ValidationError:
            continue
        completed.append(entry)
    if not completed:
        raise ValidationError('There are no completed passive fire inspections.')
    return completed


def render_inspection_register(register, details, *, library, company, plan_sessions=None, takeoffs=None):
    completed = completed_passive_inspections(register)
    weights = (72, 67, 84, 61, 69, 71, 70, 48, 70, 49, 49, 49, 49)
    payload = render_register_table(TITLE, details, company, HEADINGS, weights,
                                    lambda report, widths: _register_rows(report, completed, library, widths))
    if any(entry.get('plan_pins') for entry in completed):
        # The client captures sessions before the server checks which inspections are complete.
        return append_plan_pages(payload, completed, plan_sessions, takeoffs, allow_unused_sessions=True)
    return payload
