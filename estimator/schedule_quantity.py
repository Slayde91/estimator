"""Application quantity inputs layered over unchanged workbook coordinates.

Legacy omitted inputs mean one. Explicit blanks remain incomplete, and neither
the source length input nor stored project inputs are rewritten.
"""

from copy import deepcopy
import math
import re

from .catalog import ValidationError
from .excel_engine import column_name, column_number


SPECS = {
    'steel_board': {'quantity': 'CJ', 'length': 'F', 'total': 'CK'},
    'ductwork': {'quantity': 'CM', 'length': 'D', 'total': 'CN'},
}
_DUCT_QUANTITY_ROOTS = ('K', 'V', 'W', 'X', 'CH', 'CI', 'CJ', 'AE', 'AG', 'AI', 'Z', 'AA')
_STRINGS = re.compile(r'("(?:[^"]|"")*")')
_REFERENCE = re.compile(
    r"(?<![A-Za-z0-9_.])(?:(?P<sheet>'(?:[^']|'')+'|[A-Za-z_][A-Za-z_0-9.]*)!)?"
    r'(?P<absolute>\$?)(?P<column>[A-Z]{1,3})(?P<row_absolute>\$?)(?P<row>[1-9]\d*)'
    r'(?::(?P<last_absolute>\$?)(?P<last_column>[A-Z]{1,3})(?P<last_row_absolute>\$?)(?P<last_row>[1-9]\d*))?'
    r'(?![A-Za-z0-9_.])')


def add_quantity_inputs(model):
    spec = SPECS.get(model['id'])
    if spec is None:
        return
    schedule = model['schedule']
    sheet = next(item for item in model['sheets'] if item['name'] == schedule['sheet'])
    first, last, header = schedule['first_row'], schedule['last_row'], schedule['header_row']
    quantity_column, total_column = spec['quantity'], spec['total']
    original_display_last = column_number(re.search(r':([A-Z]+)[1-9]\d*$', sheet['page_range'])[1])
    # Evaluation spans include private helpers; display spans retain the old
    # worksheet columns plus the new input, even when Advanced is enabled.
    sheet['application_display_columns'] = [*range(1, original_display_last + 1), column_number(quantity_column)]
    scale_columns = ({column: column_name(column_number(total_column) + index)
                      for index, column in enumerate(_DUCT_QUANTITY_ROOTS, 1)}
                     if model['id'] == 'ductwork' else {})
    last_helper = list(scale_columns.values())[-1] if scale_columns else total_column
    assert not any(re.fullmatch(r'(?:' + quantity_column + '|' + total_column + r')[1-9]\d*', address)
                   for address in sheet['cells'])
    source_header = sheet['cells'][f"{spec['length']}{header}"]
    sheet['cells'][f'{quantity_column}{header}'] = {**deepcopy(source_header), 'value': 'Quantity'}
    for row in range(first, last + 1):
        original = sheet['cells'].get(f"{spec['length']}{row}", {})
        sheet['cells'][f'{quantity_column}{row}'] = {'data_type': 'n', 'style': original.get('style', 0)}
        sheet['cells'][f'{total_column}{row}'] = {
            'data_type': 'n', 'style': original.get('style', 0),
            'formula': (f'IF(AND(ISNUMBER({spec["length"]}{row}),{spec["length"]}{row}>0,'
                        f'ISNUMBER({quantity_column}{row}),{quantity_column}{row}>0,'
                        f'MOD({quantity_column}{row},1)=0),{spec["length"]}{row}*{quantity_column}{row},"")'),
        }
        for source_column, helper_column in scale_columns.items():
            sheet['cells'][f'{helper_column}{row}'] = deepcopy(sheet['cells'][f'{source_column}{row}'])
            sheet['cells'][f'{helper_column}{row}'].pop('cached_value', None)
    validation = {'type': 'whole', 'operator': 'greaterThan', 'allowBlank': '1',
                  'sqref': f'{quantity_column}{first}:{quantity_column}{last}', 'formula1': '0'}
    sheet['validations'].append(validation)
    schedule['columns'].append({'column': quantity_column, 'label': 'Quantity', 'type': 'number',
                                'editable': True, 'quantity': True, 'validation': validation})
    schedule.update(quantity_column=quantity_column, quantity_length_column=spec['length'],
                    total_length_column=total_column, quantity_scale_columns=scale_columns,
                    last_column=quantity_column)
    model['input_ranges'][schedule['sheet']].append(f'{quantity_column}{first}:{quantity_column}{last}')
    sheet['columns'] += [
        {'min': str(column_number(quantity_column)), 'max': str(column_number(quantity_column)), 'width': '14', 'hidden': '0'},
        {'min': str(column_number(total_column)), 'max': str(column_number(last_helper)), 'width': '14', 'hidden': '1'},
    ]
    sheet['page_range'] = re.sub(r':[A-Z]+([1-9]\d*)$', ':' + quantity_column + r'\1', sheet['page_range'])
    sheet['dimension'] = re.sub(r':[A-Z]+([1-9]\d*)$', ':' + last_helper + r'\1', sheet['dimension'])


def quantity_engine_inputs(model, inputs):
    """Supply legacy fallback only in the private engine copy, never a project."""
    spec = SPECS.get(model['id'])
    if spec is None:
        return inputs
    result = deepcopy(inputs)
    schedule = model['schedule']
    values = result.setdefault(schedule['sheet'], {})
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        values.setdefault(f"{spec['quantity']}{row}", 1)
    return result


def validate_quantity(value):
    if value not in (None, '') and (type(value) not in (int, float) or not math.isfinite(value)
                                  or value <= 0 or value != int(value)):
        raise ValidationError('Quantity: enter a positive whole number.')


def quantity(engine, row):
    spec = SPECS.get(engine.model['id'])
    if spec is None:
        return 1
    schedule = engine.model['schedule']
    values = engine.inputs.get(schedule['sheet'], {})
    value = values.get(f"{spec['quantity']}{row}", 1)
    return value if type(value) in (int, float) and math.isfinite(value) and value > 0 and value == int(value) else None


def total_length(engine, row):
    spec = SPECS.get(engine.model['id'])
    length = engine.value(engine.model['schedule']['sheet'], f"{spec['length']}{row}") if spec else None
    count = quantity(engine, row)
    total = length * count if type(length) in (int, float) and length > 0 and count is not None else None
    return total if total is not None and math.isfinite(total) else None


def application_formula_overrides(model, overrides=None):
    """Repeat row quantities without shifting inputs or combining duct overlaps."""
    result = deepcopy(overrides or {})
    if model['id'] == 'ductwork':
        schedule, spec = model['schedule'], SPECS[model['id']]
        sheet = next(item for item in model['sheets'] if item['name'] == schedule['sheet'])
        target = result.setdefault(schedule['sheet'], {})
        for row in range(schedule['first_row'], schedule['last_row'] + 1):
            count = f"{spec['quantity']}{row}"
            valid = f'AND(ISNUMBER({count}),{count}>0,MOD({count},1)=0)'
            for source_column, helper_column in schedule['quantity_scale_columns'].items():
                address, helper = f'{source_column}{row}', f'{helper_column}{row}'
                # Each helper evaluates one complete run, including its own
                # axial overlaps and penetration counts. Scale each root once;
                # downstream volume, bags, roll equivalents and totals follow.
                target[helper] = target.get(address, sheet['cells'][address]['formula'])
                target[address] = f'IF({valid},IF(ISNUMBER({helper}),{helper}*{count},{helper}),"")'
            target[f'BB{row}'] = f'AND({target.get(f"BB{row}", sheet["cells"][f"BB{row}"]["formula"])},{valid})'
            status = target.get(f'J{row}', sheet['cells'][f'J{row}']['formula'])
            target[f'J{row}'] = f'IF(AND(AS{row},NOT({valid})),"Enter a positive whole Quantity",{status})'
        return result
    if model['id'] != 'steel_board':
        return result
    schedule, spec = model['schedule'], SPECS[model['id']]
    for sheet in model['sheets']:
        for address, cell in sheet['cells'].items():
            if 'formula' not in cell or sheet['name'] == schedule['sheet'] and address.startswith(spec['total']):
                continue
            formula = result.get(sheet['name'], {}).get(address, cell['formula'])
            def replace(match):
                target = match['sheet']
                target = target[1:-1].replace("''", "'") if target and target.startswith("'") else target
                if ((target or sheet['name']).casefold() != schedule['sheet'].casefold()
                        or match['column'] != spec['length']
                        or not schedule['first_row'] <= int(match['row']) <= schedule['last_row']):
                    return match[0]
                if match['last_column'] and (match['last_column'] != spec['length']
                        or not schedule['first_row'] <= int(match['last_row']) <= schedule['last_row']):
                    return match[0]
                prefix = match['sheet'] + '!' if match['sheet'] else ''
                result = prefix + match['absolute'] + spec['total'] + match['row_absolute'] + match['row']
                if match['last_column']:
                    result += ':' + match['last_absolute'] + spec['total'] + match['last_row_absolute'] + match['last_row']
                return result
            updated = ''.join(part if index % 2 else _REFERENCE.sub(replace, part)
                              for index, part in enumerate(_STRINGS.split(formula)))
            if updated != formula:
                result.setdefault(sheet['name'], {})[address] = updated
    target = result.setdefault(schedule['sheet'], {})
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        count = f"{spec['quantity']}{row}"
        valid = f'AND(ISNUMBER({count}),{count}>0,MOD({count},1)=0)'
        status = target.get(f'AI{row}', next(sheet for sheet in model['sheets'] if sheet['name'] == schedule['sheet'])['cells'][f'AI{row}']['formula'])
        target[f'AI{row}'] = f'IF(AND(BD{row}>0,NOT({valid})),"Enter a positive whole Quantity",{status})'
    return result
