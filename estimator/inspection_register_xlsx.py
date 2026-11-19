"""Excel copies of the completed inspection registers."""
from base64 import b64decode
from io import BytesIO
from itertools import zip_longest
from math import ceil, isfinite

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.drawing.image import Image
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.utils.exceptions import IllegalCharacterError

from .assessment_references import saved_report_references
from .calculator_inspection_report import (calculator_inspection_facts, calculator_register_columns,
                                           completed_calculator_inspections)
from .calculator_inspections import PHOTOS, inspection_row
from .catalog import ValidationError
from .date_display import pdf_download_date
from .documentation_catalog import CALCULATOR_REGISTERS
from .document_theme import THEMES
from .inspection_register_report import (HEADINGS, TITLE, completed_passive_inspections,
                                          passive_register_rows)
from .passive_fire_register import JPEG_PREFIX
from .pricing_workbook import _serialize_exact


_NUMERIC = {'Critical Temp (°C)', 'Qty', 'Length (m)', 'Required Thickness (mm)',
            'Recorded Thickness (mm)', 'Number of Readings'}
_RED = THEMES['ceasefire'][1:]
_PHOTO_WIDTH = 135
_PHOTO_HEIGHT = 88


def _cell(sheet, row, column, value):
    try:
        if isinstance(value, str):
            if len(value.encode('utf-16-le')) // 2 > 32767:
                raise ValidationError('Register text exceeds the Excel cell limit. Shorten the affected field before downloading.')
            if '\ufffe' in value or '\uffff' in value:
                raise IllegalCharacterError()
        cell = sheet.cell(row, column, value)
    except (IllegalCharacterError, UnicodeEncodeError) as error:
        raise ValidationError('Register text contains a character Excel cannot display.') from error
    if isinstance(value, str):
        cell.data_type = 's'
    return cell


def _calculator_rows(entries, kind, headings):
    for entry in entries:
        facts = dict(calculator_inspection_facts(entry, kind))
        values = [facts[label] for label in headings]
        calculator_id = inspection_row(entry).get('calculator_id')
        caption = facts['Report']
        references = [(caption, None)]
        if calculator_id and caption:
            references = [(ref['label'], ref['url']) for ref in saved_report_references(calculator_id, caption)]
        for index, photos in enumerate(zip_longest(*(entry[phase] for phase in PHOTOS))):
            yield (values if index == 0 else values[:2] + [None] * (len(values) - 2),
                   references if index == 0 else [], photos)


def _passive_rows(entries, library, headings):
    for identity, system, references, photos in passive_register_rows(entries, library):
        values = [value for value, _ in system] + [None] if system is not None else [None] * (len(headings) - 2)
        yield [*identity, *values], references, photos


def _number(value, heading):
    if heading not in _NUMERIC or not isinstance(value, str) or not value:
        return value
    try:
        parsed = float(value)
    except ValueError:
        return value  # Preserve layer specifications such as "2 x 38mm".
    return parsed if isfinite(parsed) else value


def _report_cell(cell, references):
    links = {url for _, url in references if url}
    if len(links) == 1 and all(url in links for _, url in references):
        cell.hyperlink = next(iter(links))
        cell.font = Font(name='Arial', size=10, color='0645AD', underline='single')
    elif links:
        cell.comment = Comment('\n'.join(f'{label}: {url}' for label, url in references if url), 'CLASSIFIRE')


def _render_register_xlsx(title, details, headings, photos_labels, rows):
    workbook = Workbook()
    workbook.properties.creator = 'CLASSIFIRE'
    workbook.properties.title = title
    sheet = workbook.active
    sheet.title = title
    sheet.sheet_view.showGridLines = False
    sheet.freeze_panes = 'C8'
    sheet.sheet_properties.tabColor = _RED
    columns = [*headings, *photos_labels]
    widths = [max(16, min(39, len(label) + 6)) for label in headings] + [21] * len(photos_labels)
    header_font = Font(name='Arial', size=10, bold=True, color='FFFFFF')
    header_fill = PatternFill('solid', fgColor=_RED)
    body_font = Font(name='Arial', size=10)
    report_column = headings.index('Report' if 'Report' in headings else 'Report Numbers') + 1

    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(columns))
    title_cell = _cell(sheet, 1, 1, title)
    title_cell.font = Font(name='Arial', size=16, bold=True, color=_RED)
    sheet.row_dimensions[1].height = 25
    for row, (label, value) in enumerate((('Project No.', details.get('project_no')),
                                         ('Client', details.get('client')),
                                         ('Site Address', details.get('site_address')),
                                         ('Date', pdf_download_date())), 2):
        _cell(sheet, row, 1, label).font = Font(name='Arial', size=10, bold=True)
        sheet.merge_cells(start_row=row, start_column=2, end_row=row, end_column=len(columns))
        _cell(sheet, row, 2, value).font = body_font
    sheet.row_dimensions[7].height = 29
    for index, (heading, width) in enumerate(zip(columns, widths), 1):
        cell = _cell(sheet, 7, index, heading)
        cell.font, cell.fill = header_font, header_fill
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        sheet.column_dimensions[get_column_letter(index)].width = width

    try:
        for row, (facts, references, photos) in enumerate(rows, 8):
            height = 18
            for index, (heading, value, width) in enumerate(zip(headings, facts, widths), 1):
                if index == report_column:
                    value = '\n'.join(label for label, _ in references if label)
                cell = _cell(sheet, row, index, _number(value, heading))
                cell.font = body_font
                cell.alignment = Alignment(wrap_text=True, vertical='top')
                if index == report_column:
                    _report_cell(cell, references)
                if isinstance(value, str):
                    lines = sum(max(1, ceil(len(line) / (width - 2))) for line in value.split('\n'))
                    height = max(height, min(409, lines * 13 + 6))
            for index, photo in enumerate(photos, len(headings) + 1):
                if not photo:
                    continue
                image = Image(BytesIO(b64decode(photo[len(JPEG_PREFIX):])))
                scale = min(1, _PHOTO_WIDTH / image.width, _PHOTO_HEIGHT / image.height)
                image.width = max(1, round(image.width * scale))
                image.height = max(1, round(image.height * scale))
                sheet.add_image(image, f'{get_column_letter(index)}{row}')
                height = max(height, image.height * .75 + 5)
            sheet.row_dimensions[row].height = height
        sheet.auto_filter.ref = f'A7:{get_column_letter(len(columns))}{sheet.max_row}'
        return _serialize_exact(workbook, escape_text=True)
    finally:
        workbook.close()


def render_passive_register_xlsx(register, details, *, library):
    entries = completed_passive_inspections(register)
    headings = HEADINGS[:-4]
    return _render_register_xlsx(TITLE, details, headings, HEADINGS[-4:],
                                 _passive_rows(entries, library, headings))


def render_calculator_register_xlsx(register, details, kind):
    entries = completed_calculator_inspections(register, kind)
    headings = [label for label, _ in calculator_register_columns(kind)]
    return _render_register_xlsx(CALCULATOR_REGISTERS[kind][0], details, headings, tuple(PHOTOS.values()),
                                 _calculator_rows(entries, kind, headings))
