"""Application boundary around the three immutable workbook calculation models."""

from copy import deepcopy
from functools import lru_cache
import json
import math
import re
from threading import RLock

from openpyxl.formula.translate import Translator

from .catalog import ROOT, ValidationError
from .excel_engine import WorkbookEngine, FormulaError, CellRange, coordinates, column_name, column_number, parse_formula, relative_formula
from .workbook_catalog import load_workbook_catalog, list_workbook_catalogs, editable_cells
from .calculator_defaults import default_calculator_inputs, yield_review


# Source table headings outside the main schedules. See the per-page evidence
# in docs/CALCULATOR_PRESENTATION_MAPPING.md; these affect styling only.
_PRESENTATION_HEADERS = {
    'steel_vermiculite': {'CALCULATOR': [28], 'BAGS': [19],
                         'SETTINGS': [35, 54, 68, 86, 100, 123, 177, 196, 233, 259]},
    'steel_board': {'EXTRA BOARDS': [5], 'BOARD SUMMARY': [11], 'SETTINGS': [5]},
    'ductwork': {'SUMMARY': [8, 18, 30, 39],
                 'PRODUCT SETTINGS': [7, 36, 49, 74, 95, 116, 117, 123, 129, 136]},
}
_PRESENTATION_SECTIONS = {
    'steel_vermiculite': {'CALCULATOR': ['A5', 'H5', 'A26'], 'BAGS': ['A17'],
                         'SETTINGS': [f'A{row}' for row in (9, 17, 31, 64, 96, 173, 229, 270, 341, 356, 370)]},
    'steel_board': {'START': [f'A{row}' for row in (8, 15, 21, 25, 30, 34)]},
    'ductwork': {'SUMMARY': ['A17', 'A29', 'A38'],
                 'PRODUCT SETTINGS': ['A6', 'A48', 'A94', 'J94', 'J115', 'A153']},
}

# Presentation exclusions never remove cells from the calculation model or
# report data. In particular, SCHEDULE W still gates complete bag quantities.
_OMITTED_ROWS = {
    'steel_vermiculite': {
        'SETTINGS': [3, 4, 32, 33, 34, 65, 66, 67, 97, 98, 99, 174, 175, 176, 230, 231, 232],
        'SCHEDULE': [1, 2, 3, 8],
        'CALCULATOR': list(range(33, 42)),
    },
    'steel_board': {'START': [3, 5, 6, *range(34, 40)], 'CALCULATOR': [2, 5, 7]},
    'ductwork': {'CALCULATOR': [5, 6, 7, 9], 'PRODUCT SETTINGS': [3, 4, *range(153, 160)]},
}
_OMITTED_COLUMNS = {'steel_vermiculite': {'SCHEDULE': [22, 23, 24]},
                    'steel_board': {'EXTRA BOARDS': [14]},
                    'ductwork': {'CALCULATOR': [37, 38, 42, 43, 44]}}
# Duct AJ is followed by the still-calculated AN/AO volume and yield outputs.
# Column identities remain source coordinates; this order is browser-only.
_DISPLAY_COLUMN_ORDER = {'ductwork': {'CALCULATOR': [*range(1, 37), 40, 41, 37, 38, 39, 42, 43, 44]}}
_DISPLAY_TEXT = {
    'steel_vermiculite': {'BAGS': {'A1': 'MATERIAL QUANTITIES'}},
    'steel_board': {'CALCULATOR': {'A1': 'STRUCTURAL STEEL BOARD SCHEDULE'}},
    'ductwork': {'CALCULATOR': {'A1': 'DUCT PROTECTION CALCULATOR'},
                 'SUMMARY': {'A1': 'DUCT PROTECTION SUMMARY'}},
}
# Browser-only spans and semantic corrections. Merged children are decorative
# blanks; source formulas, input identities and source merge records stay intact.
_DISPLAY_CELLS = {
    'steel_vermiculite': {'BAGS': {'G10': {'merge': 'G10:N10', 'role': 'spacer'}}},
    'ductwork': {
        'CALCULATOR': {'A3': {'role': 'note'}},
        'SUMMARY': {'A17': {'merge': 'A17:L17'}, 'A29': {'merge': 'A29:L29'}},
        'PRODUCT SETTINGS': {f'J{row}': {'merge': f'J{row}:Q{row}'} for row in (105, 108, 111, 131, 136)},
    },
}
# SUMMARY has independent tables sharing source column letters. Their browser
# columns must be scoped to each table so hiding prose cannot hide quantities
# in a different table. Widths are presentation pixels, not business constants.
_PRESENTATION_TABLES = {
    'steel_vermiculite': {
        'CALCULATOR': [
            {'first_row': 5, 'last_row': 24, 'columns': list(range(1, 7)),
             'column_widths': [1, 1, 1, 1, 1, 1], 'width_mode': 'fit',
             'table_kind': 'form', 'title_address': 'A5', 'label': '01 INPUTS'},
            {'first_row': 5, 'last_row': 24, 'columns': list(range(8, 15)),
             'column_widths': [1, 1, 1, 1, 1, 1, 1], 'width_mode': 'fit',
             'table_kind': 'form', 'title_address': 'H5', 'label': '02 THICKNESS & QUANTITIES'},
            {'first_row': 26, 'last_row': 30, 'columns': list(range(1, 10)),
             'column_widths': [190, *([115] * 8)], 'table_kind': 'comparison',
             'title_address': 'A26', 'header_row': 28, 'label': '03 ALL PUBLISHED PERIODS FOR THIS INPUT'},
        ],
        'BAGS': [
            {'first_row': 6, 'last_row': 15, 'columns': list(range(1, 15)),
             'column_widths': [1, 1, 1, 1, 1, 1, .12, 1, 1, 1, 1, 1, 1, 1],
             'width_mode': 'fit', 'table_kind': 'form', 'label': 'Manual material quantity'},
            {'first_row': 17, 'last_row': 24, 'columns': list(range(1, 10)),
             'column_widths': [19, 7, 9, 10, 8, 7, 11, 9, 20], 'width_mode': 'fit',
             'table_kind': 'order', 'title_address': 'A17', 'header_row': 19, 'label': 'PRODUCT ORDER SUMMARY'},
        ],
    },
    'steel_board': {'BOARD SUMMARY': [
        # Keep the overview totals at A6/E6/I6; hide intermediate quantities
        # and source identifiers only in the stock purchasing table.
        {'first_row': 11, 'last_row': 29, 'columns': [1, 2, 3, 4, 9, 10],
         'column_widths': [240, 150, 150, 150, 150, 150], 'label': 'Board purchasing totals'},
    ], 'SETTINGS': [
        {'first_row': 5, 'last_row': 34, 'columns': [1, 2, 3],
         'column_widths': [460, 180, 140], 'label': 'General settings'},
        {'first_row': 5, 'last_row': 10, 'columns': list(range(7, 15)),
         'column_widths': [140] * 8, 'label': 'Fire periods and temperatures'},
        {'first_row': 5, 'last_row': 51, 'columns': [16, 17],
         'column_widths': [360, 620], 'label': 'Diagnostic messages'},
    ]},
    'ductwork': {'PRODUCT SETTINGS': [
        {'first_row': 94, 'last_row': 151, 'columns': list(range(1, 9)),
         'column_widths': [25, 14, 10, 10, 10, 10, 10, 11], 'width_mode': 'fit',
         'table_kind': 'form', 'title_address': 'A94', 'label': 'FYREWRAP'},
        {'first_row': 94, 'last_row': 113, 'columns': list(range(10, 18)),
         'column_widths': [196, 280, 133, 112, 161, 161, 84, 273],
         'table_kind': 'comparison', 'title_address': 'J94', 'header_row': 95, 'label': 'FYREWRAP APPLICATION TABLE'},
        {'first_row': 115, 'last_row': 149, 'columns': list(range(10, 18)),
         'column_widths': [30, 18, 12, 8, 8, 8, 8, 8], 'width_mode': 'fit',
         'table_kind': 'comparison', 'title_address': 'J115', 'header_row': 116,
         'label': 'PENETRATION TAKEOFF — STANDARD FOUR-SIDED DETAILS'},
    ], 'SUMMARY': [
        {'first_row': 8, 'last_row': 11, 'columns': list(range(1, 11)),
         'column_widths': [200, *([125] * 9)], 'label': 'Product totals'},
        {'first_row': 18, 'last_row': 26, 'columns': list(range(1, 7)),
         'column_widths': [200, 160, 160, 125, 200, 360], 'label': 'Penetration angle totals'},
        {'first_row': 30, 'last_row': 32, 'columns': [1, 2, 3],
         'column_widths': [200, 125, 180], 'label': 'Working yields'},
        {'first_row': 39, 'last_row': 41, 'columns': list(range(1, 8)),
         'column_widths': [200, *([125] * 6)], 'label': 'Maxilite cutting totals'},
    ]},
}
_OMITTED_RANGES = {'steel_vermiculite': {'CALCULATOR': ['J28:N30']},
                   'ductwork': {'PRODUCT SETTINGS': ['J6:Q21']},
                   'steel_board': {'SETTINGS': ['D5:D34', 'G12:N13'],
                                   'CALCULATOR': ['Y1:AI1', 'A6:L6']}}
_READ_ONLY_REFERENCES = frozenset({'D42', 'D75', 'D107', 'D184', 'D240'})


@lru_cache(maxsize=3)
def source_model(calculator_id):
    # Caller-owned model is private to this module and never mutated or exposed.
    return load_workbook_catalog(calculator_id)


@lru_cache(maxsize=3)
def approved_formula_overrides(calculator_id):
    if calculator_id != 'ductwork':
        return {}
    model = source_model(calculator_id)
    sheet = next(sheet for sheet in model['sheets'] if sheet['name'] == 'CALCULATOR')
    master = '=' + sheet['cells']['AL11']['formula']
    # Explicit user-approved exception: translated references, unchanged fixed
    # wording. Original formulas stay intact in the imported source package.
    return {'CALCULATOR': {f'AL{row}': Translator(master, origin='AL11').translate_formula(f'AL{row}').lstrip('=')
                           for row in range(12, 311)}}


def calculator_list():
    return {'calculators': list_workbook_catalogs()}


def _bounds(reference):
    parts = reference.split(':')
    return (*coordinates(parts[0]), *coordinates(parts[-1]))


def _contains(reference, row, column):
    r1, c1, r2, c2 = _bounds(reference)
    return r1 <= row <= r2 and c1 <= column <= c2


def _validation(sheet, address):
    row, column = coordinates(address)
    for validation in sheet.get('validations', []):
        if any(_contains(reference, row, column) for reference in validation.get('sqref', '').split()):
            return validation
    return None


@lru_cache(maxsize=3)
def _field_maps(calculator_id):
    model = source_model(calculator_id)
    return {(sheet, field['cell']): field for sheet, fields in model.get('fields', {}).items() for field in fields}


def input_field(calculator_id, sheet, address):
    model = source_model(calculator_id)
    found = _field_maps(calculator_id).get((sheet['name'], address))
    if found:
        if calculator_id == 'steel_vermiculite' and sheet['name'] == 'SETTINGS' and address in _READ_ONLY_REFERENCES:
            return {**found, 'multiline': True, 'read_only': True}
        return found
    row, column = coordinates(address)
    schedule = model['schedule']
    if sheet['name'] == schedule['sheet'] and schedule['first_row'] <= row <= schedule['last_row']:
        found = next((field for field in schedule['columns'] if column_number(field['column']) == column), None)
        if found:
            return found
    validation = _validation(sheet, address)
    cell = sheet['cells'].get(address, {})
    value = cell.get('value')
    kind = 'select' if validation and validation.get('type') == 'list' else 'number' if validation and validation.get('type') in ('decimal', 'whole') or isinstance(value, (int, float)) else 'text'
    header_row = 5 if sheet['name'] == 'EXTRA BOARDS' else 1
    label = sheet['cells'].get(column_name(column) + str(header_row), {}).get('value')
    return {'type': kind, 'label': label or 'Input', 'validation': validation}


def normalize_calculator_inputs(calculator_id, inputs=None):
    model = source_model(calculator_id)
    if inputs is None:
        inputs = {}
    if not isinstance(inputs, dict) or len(inputs) > len(model['sheets']):
        raise ValidationError('Calculator inputs must contain worksheet input values.')
    sheets = {sheet['name']: sheet for sheet in model['sheets']}
    normalized = {}
    for name, cells in inputs.items():
        if name not in sheets or not isinstance(cells, dict):
            raise ValidationError('Choose an available input worksheet.')
        allowed = editable_cells(calculator_id, name)
        if set(cells) - allowed:
            raise ValidationError('Only the workbook input and setting fields can be changed; calculated values and reference databases are read-only.')
        normalized[name] = {}
        for address, value in cells.items():
            # Clearing an input is an actual Excel blank, not a text formula "".
            if value is None or value == '':
                normalized[name][address] = None
                continue
            field = input_field(calculator_id, sheets[name], address)
            if isinstance(value, bool) or not isinstance(value, (str, int, float)):
                raise ValidationError(f"{field['label']}: enter text or a finite number.")
            if isinstance(value, (int, float)) and (abs(value) > 1e100 or not math.isfinite(value)):
                raise ValidationError(f"{field['label']}: enter a finite number within the supported range.")
            permitted_controls = '\r\n' if field.get('multiline') else ''
            if isinstance(value, str) and (len(value) > 2000 or any(ord(character) < 32 and character not in permitted_controls for character in value)):
                raise ValidationError(f"{field['label']}: text must be at most 2,000 characters without control characters.")
            if field['type'] == 'number' and not isinstance(value, (int, float)):
                raise ValidationError(f"{field['label']}: enter a number or leave the input blank.")
            normalized[name][address] = value
    return normalized


def validate_calculator_edits(calculator_id, inputs, saved_inputs):
    """Enforce read-only references at user-facing calculation/save boundaries.

    The source evaluator must still reproduce historical saved inputs. Accept
    their exact references and the two known baselines (source and reviewed)
    so loading and resetting a calculator need no data migration.
    """
    normalized = normalize_calculator_inputs(calculator_id, inputs)
    if calculator_id != 'steel_vermiculite':
        return normalized
    source = next(sheet for sheet in source_model(calculator_id)['sheets'] if sheet['name'] == 'SETTINGS')['cells']
    defaults = default_calculator_inputs(calculator_id)['SETTINGS']
    saved = saved_inputs.get('SETTINGS', {})
    for address in _READ_ONLY_REFERENCES & normalized.get('SETTINGS', {}).keys():
        original = source.get(address, {}).get('value')
        allowed = (original, defaults[address], saved.get(address, original))
        if normalized['SETTINGS'][address] not in allowed:
            raise ValidationError('Material basis/reference is read-only. Retain the saved reference or reset to the product defaults.')
    return normalized


@lru_cache(maxsize=6)
def _session(calculator_id, serialized_inputs):
    return WorkbookEngine(source_model(calculator_id), json.loads(serialized_inputs), approved_formula_overrides(calculator_id)), RLock()


def calculator_session(calculator_id, inputs):
    normalized = normalize_calculator_inputs(calculator_id, inputs)
    engine, lock = _session(calculator_id, json.dumps(normalized, sort_keys=True, ensure_ascii=False, allow_nan=False))
    return normalized, engine, lock


def validation_options(engine, sheet, address, validation, cache=None):
    if not validation or validation.get('type') != 'list':
        return []
    formula = validation.get('formula1', '').lstrip('=')
    if formula.startswith('"') and formula.endswith('"'):
        items = formula[1:-1].replace('""', '"').split(',')
        return [float(value) if re.fullmatch(r'[+-]?\d+(?:\.\d+)?', value) else value for value in items]
    first = validation['sqref'].split()[0].split(':')[0].replace('$', '')
    translated = Translator('=' + formula, origin=first).translate_formula(address).lstrip('=')
    key = (sheet, translated)
    if cache is not None and key in cache:
        return cache[key]
    row, column = coordinates(address)
    result = engine.evaluate(parse_formula(relative_formula(translated, row, column)), sheet, row, column)
    items = list(result.values()) if isinstance(result, CellRange) else [result]
    unique = []
    for value in items:
        if value not in (None, '') and value not in unique:
            unique.append(value)
    if cache is not None:
        cache[key] = unique
    return unique


def _sheet_metadata(model, sheet):
    r1, c1, r2, c2 = _bounds(sheet['page_range'])
    widths, hidden = {}, []
    for item in sheet['columns']:
        for column in range(int(item['min']), min(int(item['max']), c2) + 1):
            widths[column] = float(item.get('width', 12))
            if item.get('hidden') in ('1', True) or widths[column] <= 0:
                hidden.append(column)
    schedule = model['schedule']
    labels = [{'column': column_number(field['column']), 'label': field['label']} for field in schedule['columns']] if sheet['name'] == schedule['sheet'] else []
    return {'name': sheet['name'], 'max_row': r2, 'max_column': c2,
            'omitted_rows': list(_OMITTED_ROWS.get(model['id'], {}).get(sheet['name'], [])),
            'omitted_columns': list(_OMITTED_COLUMNS.get(model['id'], {}).get(sheet['name'], [])),
            'omitted_ranges': list(_OMITTED_RANGES.get(model['id'], {}).get(sheet['name'], [])),
            'display_column_order': list(_DISPLAY_COLUMN_ORDER.get(model['id'], {}).get(sheet['name'], [])),
            'display_text': dict(_DISPLAY_TEXT.get(model['id'], {}).get(sheet['name'], {})),
            'display_cells': deepcopy(_DISPLAY_CELLS.get(model['id'], {}).get(sheet['name'], {})),
            'presentation_tables': deepcopy(_PRESENTATION_TABLES.get(model['id'], {}).get(sheet['name'], [])),
            'table_layout': ('projected' if (model['id'], sheet['name']) in {
                ('steel_vermiculite', 'CALCULATOR'), ('steel_vermiculite', 'BAGS'), ('ductwork', 'PRODUCT SETTINGS')}
                else 'stacked' if model['id'] == 'steel_board' and sheet['name'] == 'SETTINGS' else 'inline'),
            'hidden_columns': hidden, 'hidden_rows': [int(row) for row, data in sheet['rows'].items()
                if data.get('hidden') in ('1', True) or float(data.get('ht', 15)) <= 0],
            'column_widths': widths, 'columns': labels, 'merges': sheet['merges'],
            'header_rows': [schedule['header_row']] if sheet['name'] == schedule['sheet'] else
                _PRESENTATION_HEADERS.get(model['id'], {}).get(sheet['name'], []),
            'section_cells': _PRESENTATION_SECTIONS.get(model['id'], {}).get(sheet['name'], []),
            'source_state': sheet['state']}


def calculator_definition(calculator_id, inputs=None):
    model = source_model(calculator_id)
    documents_path = ROOT / 'data' / 'calculator_documents.json'
    documents = json.loads(documents_path.read_text(encoding='utf-8'))['sections'].get(calculator_id, []) if documents_path.exists() else []
    return {'id': calculator_id, 'title': model['title'], 'pages': model['pages'],
            'source': model['source'], 'schedule': deepcopy(model['schedule']),
            'sheets': [_sheet_metadata(model, sheet) for sheet in model['sheets'] if sheet['name'] in model['pages']],
            'inputs': normalize_calculator_inputs(calculator_id, inputs), 'documents': documents,
            'defaults': default_calculator_inputs(calculator_id), 'yield_review': yield_review(calculator_id)}


def calculate_page(calculator_id, inputs=None, sheet=None, start_row=1, row_count=25):
    model = source_model(calculator_id)
    if sheet is not None and not isinstance(sheet, str):
        raise ValidationError('Choose an available calculator page.')
    sheet = model['pages'][0] if sheet is None else sheet
    if sheet not in model['pages']:
        raise ValidationError('Choose an available calculator page.')
    for value in (start_row, row_count):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValidationError('Page bounds must be whole numbers.')
    if start_row < 1 or not 1 <= row_count <= 50:
        raise ValidationError('A calculator page can contain 1 to 50 rows.')
    source = next(item for item in model['sheets'] if item['name'] == sheet)
    metadata = _sheet_metadata(model, source)
    if start_row > metadata['max_row']:
        raise ValidationError('The requested row is outside this worksheet.')
    return _render_sheet(calculator_id, inputs, source, metadata, start_row,
                         min(metadata['max_row'], start_row + row_count - 1))


def calculate_worksheet(calculator_id, inputs=None, sheet=None, include_advanced=False):
    """Return one complete source page with bounded, shared dropdown metadata.

    The extent comes from the imported workbook, never a caller-supplied size.
    This is a presentation projection; values still come from WorkbookEngine.
    """
    model = source_model(calculator_id)
    if sheet is not None and not isinstance(sheet, str):
        raise ValidationError('Choose an available calculator page.')
    sheet = model['pages'][0] if sheet is None else sheet
    if sheet not in model['pages']:
        raise ValidationError('Choose an available calculator page.')
    if not isinstance(include_advanced, bool):
        raise ValidationError('Advanced columns must be enabled or disabled.')
    source = next(item for item in model['sheets'] if item['name'] == sheet)
    metadata = _sheet_metadata(model, source)
    return _render_sheet(calculator_id, inputs, source, metadata, 1,
                         metadata['max_row'], shared_options=True,
                         include_advanced=include_advanced)


def _presentation(style, original, value, row, column, metadata, editable):
    """Translate source emphasis into semantic styling, without changing text."""
    font = {child['tag']: child.get('attributes', {}) for child in style.get('font', {}).get('children', [])}
    bold = 'b' in font and font['b'].get('val', '1') not in ('0', 'false')
    size = float(font.get('sz', {}).get('val', 11))
    white_heading = bold and font.get('color', {}).get('rgb', '').upper().endswith('FFFFFF')
    role = 'body'
    if row in metadata['header_rows']:
        role = 'column_header'
    elif isinstance(value, str) and value:
        if not editable and (row == 1 or row <= 3 and size >= 16):
            role = 'title'
        elif not editable and (column_name(column) + str(row) in metadata['section_cells'] or white_heading or bold and size >= 12):
            role = 'section'
        elif len(value) > 110 or '\n' in value:
            role = 'note'
        elif bold and not editable:
            role = 'label'
    elif 'formula' in original and not editable:
        role = 'output'
    role = metadata['display_cells'].get(column_name(column) + str(row), {}).get('role', role)
    return {'role': role, 'bold': bold}


def _board_product_totals(engine):
    """Read-only grouping of the source box areas and pooled stock quantities.

    AD is bare box girth times length, not steel-profile surface. BOARD SUMMARY
    G/I already include every board layer, valid extras, waste and stock-line
    rounding. Summing per-member AG would overstate the pooled sheet order.
    Reuse Excel SUMIF/COUNTIFS so case matching, blanks and errors follow the
    same semantics as the workbook. These expressions do not alter its graph.
    """
    products = list(dict.fromkeys(engine.value('BOARD SUMMARY', f'A{row}') for row in range(12, 30)))

    def evaluate(formula):
        try:
            return engine.evaluate(parse_formula(relative_formula(formula, 1, 1)), 'CALCULATOR', 1, 1)
        except FormulaError as error:
            return error.code

    totals = []
    for product in products:
        # Product names come from the retained stock table; quote criteria as
        # literal Excel text, including wildcard characters if a source adds any.
        criterion = '"' + product.replace('~', '~~').replace('*', '~*').replace('?', '~?').replace('"', '""') + '"'
        totals.append({
            'product': product,
            'box_reference_area': evaluate(f'SUMIF(CALCULATOR!$C$9:$C$208,{criterion},CALCULATOR!$AD$9:$AD$208)'),
            'net_board_area': evaluate(f'SUMIF(\'BOARD SUMMARY\'!$A$12:$A$29,{criterion},\'BOARD SUMMARY\'!$G$12:$G$29)'),
            'whole_sheets': evaluate(f'SUMIF(\'BOARD SUMMARY\'!$A$12:$A$29,{criterion},\'BOARD SUMMARY\'!$I$12:$I$29)'),
            'incomplete_rows': evaluate(f'COUNTIFS(CALCULATOR!$C$9:$C$208,{criterion},CALCULATOR!$BD$9:$BD$208,1,CALCULATOR!$AR$9:$AR$208,"<>CLADDING ESTIMATE")'),
            'incomplete_extra_rows': evaluate(f'COUNTIFS(\'EXTRA BOARDS\'!$B$6:$B$45,{criterion},\'EXTRA BOARDS\'!$M$6:$M$45,"<>ENTERED ALLOWANCE",\'EXTRA BOARDS\'!$M$6:$M$45,"<>")'),
        })
    return totals


def _render_sheet(calculator_id, inputs, source, metadata, start_row, end_row,
                  shared_options=False, include_advanced=True):
    model = source_model(calculator_id)
    sheet = source['name']
    normalized, engine, lock = calculator_session(calculator_id, inputs)
    rows, warnings = [], []
    styles = model['styles']['cell_styles']
    allowed = editable_cells(calculator_id, sheet)
    columns = [column for column in range(1, metadata['max_column'] + 1)
               if include_advanced or column not in metadata['hidden_columns']]
    option_sets, option_keys, option_cache = {}, {}, {}
    if calculator_id == 'ductwork':
        warnings.append('The copied fixing instructions use the first schedule row’s fixed technical references on every row. This is the approved correction to the source workbook; quantity formulas are unchanged.')
    with lock:
        for row in range(start_row, end_row + 1):
            cells = []
            for column in columns:
                address = column_name(column) + str(row)
                original = source['cells'].get(address, {})
                value = engine.value(sheet, address)
                field = input_field(calculator_id, source, address) if address in allowed else {}
                editable = address in allowed and not field.get('read_only')
                style = styles[int(original.get('style', 0))]
                cell = {'column': column, 'address': address, 'value': value, 'editable': editable,
                        'type': field.get('type', 'number' if isinstance(value, (int, float)) else 'text'),
                        'number_format': style.get('number_format', 'General'), 'calculated': 'formula' in original}
                if shared_options:
                    cell['presentation'] = _presentation(style, original, value, row, column, metadata, editable)
                if field.get('read_only'):
                    cell.update(read_only=True, output=True)
                if field:
                    cell['label'] = field.get('label', 'Input')
                    if field.get('multiline'):
                        cell['multiline'] = True
                    validation = _validation(source, address)
                    if validation:
                        cell['validation'] = {key: validation[key] for key in ('type', 'operator', 'formula1', 'formula2', 'errorStyle', 'allowBlank') if key in validation}
                        cell['error_style'] = validation.get('errorStyle', 'stop')
                        cell['allow_other'] = cell['error_style'] in ('warning', 'information') or validation.get('showErrorMessage') not in ('1', True)
                        try:
                            options = validation_options(engine, sheet, address, validation, option_cache)
                            if shared_options:
                                key = json.dumps(options, ensure_ascii=False, allow_nan=False)
                                if key not in option_keys:
                                    option_keys[key] = f'choices-{len(option_sets) + 1}'
                                    option_sets[option_keys[key]] = options
                                cell['options_ref'] = option_keys[key]
                            else:
                                cell['options'] = options
                        except FormulaError as error:
                            cell['options'] = []
                            cell['validation_issue'] = error.code
                if isinstance(value, str) and value in {'#N/A', '#VALUE!', '#DIV/0!', '#REF!', '#NUM!', '#NAME?', '#NULL!'}:
                    cell['error'] = value
                cells.append(cell)
            rows.append({'row': row, 'cells': cells})
        # Read the workbook's existing pooled product totals, including its
        # blocked/invalid status and whole-bag rounding. Never sum rounded rows.
        product_totals = [
            {'product': engine.value('BAGS', f'A{row}'),
             'net_bags': engine.value('BAGS', f'E{row}'),
             'whole_bags': engine.value('BAGS', f'G{row}'),
             'status': engine.value('BAGS', f'I{row}')}
            for row in range(20, 25)
        ] if shared_options and calculator_id == 'steel_vermiculite' and sheet == 'SCHEDULE' else None
        board_product_totals = _board_product_totals(engine) if shared_options and calculator_id == 'steel_board' and sheet == 'CALCULATOR' else None
    return {**metadata, 'sheet': sheet, 'start_row': start_row, 'end_row': end_row,
            'rows': rows, 'inputs': normalized, 'warnings': warnings,
            **({'product_totals': product_totals} if product_totals is not None else {}),
            **({'board_product_totals': board_product_totals} if board_product_totals is not None else {}),
            **({'visible_columns': columns, 'option_sets': option_sets} if shared_options else {})}
