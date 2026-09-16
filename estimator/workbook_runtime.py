"""Application schedule capacity layered over immutable workbook evidence.

The packaged catalog, its source hash, and the extraction specifications are
unchanged. Only this derived model expands the existing per-row rules and their
schedule-wide references. Existing input addresses keep their meanings.
"""

from copy import deepcopy
from functools import lru_cache
import re

from openpyxl.formula.translate import Translator

from .workbook_catalog import load_workbook_catalog, list_workbook_catalogs, range_addresses


SCHEDULE_CAPACITY = 1000
APPLICATION_TITLES = {
    'steel_vermiculite': 'Steel (spray)',
    'steel_board': 'Steel (board)',
    'ductwork': 'Ductwork (spray/wrap)',
}
_STRINGS = re.compile(r'("(?:[^"]|"")*")')
_RANGE = re.compile(
    r"(?<![A-Za-z0-9_.])(?:(?P<sheet>'(?:[^']|'')+'|[A-Za-z_][A-Za-z_0-9.]*)!)?"
    r'(?P<first>\$?[A-Z]{1,3}\$?(?P<start>[1-9]\d*)):'
    r'(?P<lastcol>\$?[A-Z]{1,3})(?P<absolute>\$?)(?P<end>[1-9]\d*)'
    r'(?![A-Za-z0-9_.])')


def extend_schedule_references(formula, context_sheet, schedule_sheet, first_row, old_last, new_last):
    """Extend complete schedule ranges, never row-local or lookup ranges.

Quoted Excel strings are literal data. A sheet-qualified range is changed only
when it targets the schedule; an unqualified range uses its current worksheet.
The start-row guard prevents A208:X208 from becoming A208:X1008.
"""
    def replace(match):
        target = match['sheet']
        target = target[1:-1].replace("''", "'") if target and target.startswith("'") else target
        if ((target or context_sheet or '').casefold() != schedule_sheet.casefold()
                or int(match['start']) > first_row or int(match['end']) != old_last):
            return match[0]
        return match[0][:-len(match['end'])] + str(new_last)
    return ''.join(part if index % 2 else _RANGE.sub(replace, part)
                   for index, part in enumerate(_STRINGS.split(formula)))


def _extend_metadata(node, rewrite):
    """Keep derived OOXML-shaped metadata aligned with runtime table bounds."""
    attributes = node.get('attributes', {})
    for key in ('ref', 'sqref'):
        if key in attributes:
            attributes[key] = rewrite(attributes[key])
    if node.get('tag') in ('formula', 'formula1', 'formula2', 'calculatedColumnFormula', 'totalsRowFormula') and node.get('text'):
        node['text'] = rewrite(node['text'])
    for child in node.get('children', []):
        _extend_metadata(child, rewrite)


def _expand_schedule(model, new_last):
    schedule = model['schedule']
    name, first, old_last = schedule['sheet'], schedule['first_row'], schedule['last_row']
    source_sheet = next(sheet for sheet in model['sheets'] if sheet['name'] == name)
    for sheet in model['sheets']:
        def rewrite(value):
            return extend_schedule_references(value, sheet['name'], name, first, old_last, new_last)
        for cell in sheet['cells'].values():
            if 'formula' in cell:
                cell['formula'] = rewrite(cell['formula'])
        for validation in sheet['validations']:
            for key in ('sqref', 'formula1', 'formula2'):
                if isinstance(validation.get(key), str):
                    validation[key] = rewrite(validation[key])
        for node in sheet.get('metadata', []):
            _extend_metadata(node, rewrite)
        if sheet['name'] == name:
            for key in ('page_range', 'dimension'):
                sheet[key] = rewrite(sheet[key])
    for table in model['tables'].values():
        def rewrite(value):
            return extend_schedule_references(value, table['sheet'], name, first, old_last, new_last)
        table['ref'] = rewrite(table['ref'])
        _extend_metadata(table['metadata'], rewrite)
    for key, value in model['defined_names'].items():
        model['defined_names'][key] = extend_schedule_references(value, None, name, first, old_last, new_last)
    for record in model.get('defined_name_records', []):
        scope = record.get('attributes', {}).get('localSheetId')
        context = model['sheets'][int(scope)]['name'] if scope is not None else None
        record['formula'] = extend_schedule_references(record['formula'], context, name, first, old_last, new_last)
    model['input_ranges'][name] = [extend_schedule_references(value, name, name, first, old_last, new_last)
                                   for value in model['input_ranges'][name]]
    for field in schedule['columns']:
        for key in ('sqref', 'formula1', 'formula2'):
            validation = field.get('validation', {})
            if isinstance(validation.get(key), str):
                validation[key] = extend_schedule_references(validation[key], name, name, first, old_last, new_last)

    template = [(address.rstrip('0123456789'), cell) for address, cell in source_sheet['cells'].items()
                if int(re.search(r'\d+$', address)[0]) == old_last]
    translators = {column: Translator('=' + cell['formula'], origin=f'{column}{old_last}')
                   for column, cell in template if 'formula' in cell}
    editable_columns = {field['column'] for field in schedule['columns'] if field['editable']}
    for row in range(old_last + 1, new_last + 1):
        source_sheet['rows'][str(row)] = {**source_sheet['rows'].get(str(old_last), {}), 'r': str(row)}
        for column, original in template:
            cell = deepcopy(original)
            cell.pop('cached_value', None)
            cell.pop('source_value', None)
            if column in translators:
                cell['formula'] = translators[column].translate_formula(f'{column}{row}').lstrip('=')
            elif column in editable_columns:
                cell.pop('value', None)
            elif column == schedule.get('line_id_column'):
                cell['value'] = row - first + 1
            source_sheet['cells'][f'{column}{row}'] = cell
    schedule['last_row'] = new_last


def _add_spray_location(model):
    schedule = model['schedule']
    sheet = next(sheet for sheet in model['sheets'] if sheet['name'] == schedule['sheet'])
    # Z is the authoritative engine row link. AA is unused in the source and
    # adds descriptive text without shifting any existing input or formula.
    assert not any(address.startswith('AA') for address in sheet['cells'])
    sheet['cells']['AA9'] = {**deepcopy(sheet['cells']['A9']), 'value': 'Location'}
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        sheet['cells'][f'AA{row}'] = {'data_type': 'n', 'style': sheet['cells'][f'A{row}'].get('style', 0)}
    sheet['dimension'] = f"A1:AA{schedule['last_row']}"
    sheet['page_range'] = sheet['dimension']
    # Later column entries override the source-hidden Z helper in presentation.
    sheet['columns'] += [{'min': '26', 'max': '26', 'width': '8', 'hidden': '0'},
                         {'min': '27', 'max': '27', 'width': '24', 'hidden': '0'}]
    schedule['last_column'] = 'AA'
    schedule['location_column'] = 'AA'
    schedule['columns'] += [{'column': 'Z', 'label': 'Line', 'type': 'number', 'editable': False},
                            {'column': 'AA', 'label': 'Location', 'type': 'text', 'editable': True}]
    model['input_ranges']['SCHEDULE'].append(f"AA{schedule['first_row']}:AA{schedule['last_row']}")
    table = model['tables']['Tbl_10']
    table['ref'] = f"A9:AA{schedule['last_row']}"
    table['columns'].append({'id': 27, 'name': 'Location'})
    table['metadata']['attributes']['ref'] = table['ref']
    for node in table['metadata']['children']:
        if node['tag'] == 'autoFilter':
            node['attributes']['ref'] = table['ref']
        elif node['tag'] == 'tableColumns':
            node['attributes']['count'] = '27'
            node['children'].append({'tag': 'tableColumn', 'attributes': {'id': '27', 'name': 'Location'},
                                     'text': None, 'children': []})


@lru_cache(maxsize=3)
def _application_catalog(calculator_id):
    """Private, shared model; consumers must treat it as immutable."""
    model = load_workbook_catalog(calculator_id)
    schedule = model['schedule']
    original_last = schedule['last_row']
    target_last = schedule['first_row'] + SCHEDULE_CAPACITY - 1
    if target_last != original_last:
        _expand_schedule(model, target_last)
    model['title'] = APPLICATION_TITLES[calculator_id]
    model['application'] = {'schedule_capacity': SCHEDULE_CAPACITY,
                            'source_schedule_last_row': original_last,
                            'source_schedule_capacity': original_last - schedule['first_row'] + 1}
    if calculator_id == 'steel_vermiculite':
        _add_spray_location(model)
    elif calculator_id == 'steel_board':
        schedule['line_numbers'] = True
        schedule['location_column'] = 'B'
    return model


def load_application_catalog(calculator_id):
    """Return caller-owned runtime data; raw workbook loaders remain unchanged."""
    return deepcopy(_application_catalog(calculator_id))


def list_application_catalogs():
    raw = {entry['id']: entry for entry in list_workbook_catalogs()}
    return [{**raw[identity], 'title': title, 'schedule_capacity': SCHEDULE_CAPACITY}
            for identity, title in APPLICATION_TITLES.items()]


@lru_cache(maxsize=32)
def application_editable_cells(calculator_id, sheet):
    model = _application_catalog(calculator_id)
    references = model['input_ranges'].get(sheet, []) + model['setting_ranges'].get(sheet, [])
    return frozenset(address for reference in references for address in range_addresses(reference))
