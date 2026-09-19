"""Adjusted line-detail presentation over existing workbook results.

This module never evaluates or replaces workbook formulas. Raw inputs, outputs
and summaries remain intact; footer values come directly from G, F and DK.
"""

import math
import re

from .excel_engine import column_name, column_number


TASKS = (
    ('Board', 'CX', 'DM', 'DE', (('CJ', 'Substrate'), ('CQ', 'Bulkhead'))),
    ('Collars', 'CY', 'DN', 'DF', (('AN', 'Collars'),)),
    ('Mastic', 'CZ', 'DO', 'DG', (('AC', 'Mastic Qty'),)),
    ('Framing', 'DA', 'DP', 'DH', (('CU', 'Bulkhead'),)),
    ('Wrap', 'DB', 'DQ', 'DI', (('BS', 'Pipes'), ('CB', 'Cabletrays'))),
    ('Other', 'DC', 'DR', 'DJ', (('AF', 'Additional material'),)),
)
NOTE = ('Quantities, costs and task hours use this line’s Item QTY. '
        'Labour includes setup/register time and the labour adjustment; Other includes the material adjustment. '
        'Project allowances and substrate, access and complexity multipliers are excluded.')
HOURS_PER_DAY = 8
PRODUCT_COLUMNS = {'Labour': 'W', 'Board': 'X', 'Collars': 'Y', 'Mastic': 'AB',
                   'Framing': 'Z', 'Wrap': 'AA', 'Other': 'AE'}


class _Unavailable(Exception):
    def __init__(self, code):
        self.code = code


def _number(value):
    """Excel N semantics for these calculated components, retaining errors."""
    if isinstance(value, str) and value.startswith('#'):
        raise _Unavailable(value)
    if not isinstance(value, (int, float)):
        return 0
    try:
        if not math.isfinite(value):
            raise _Unavailable('#NUM!')
    except OverflowError:
        raise _Unavailable('#NUM!') from None
    return value


def _compute(operation):
    try:
        value = operation()
        _number(value)
        return value
    except _Unavailable as error:
        return error.code
    except OverflowError:
        return '#NUM!'


def _source_value(value):
    # Preserve canonical blanks/errors exactly. Nonfinite values cannot safely
    # be serialized or displayed as money; expose an error instead of zero.
    return _compute(lambda: value)


def _miscellaneous_hours(model):
    """Read the literal second column of the source's misc_labour named range."""
    match = re.fullmatch(r"('?[^!]+?'?)!\$([A-Z]+)\$(\d+):\$([A-Z]+)\$(\d+)",
                         model['defined_names']['misc_labour'])
    if not match or column_number(match[4]) < column_number(match[2]) + 1:
        return '#REF!'
    sheet_name = match[1].strip("'")
    sheet = next((sheet for sheet in model['sheets'] if sheet['name'] == sheet_name), None)
    if sheet is None:
        return '#REF!'
    column = column_name(column_number(match[2]) + 1)
    values = [sheet['cells'].get(column + str(row), {})
              for row in range(int(match[3]), int(match[5]) + 1)]
    if any('formula' in cell for cell in values):
        return '#VALUE!'  # A changed source requires review, not a second evaluator.
    return _compute(lambda: sum(_number(cell.get('value')) for cell in values))


def line_breakdown(row, globals_, miscellaneous_hours, *, effective=True):
    inputs, outputs = row['inputs'], row['outputs']
    quantity = inputs.get('O')
    # Legacy globals are retained in saved inputs, but no longer affect pricing.
    labour_factor = material_factor = _source_value(quantity)
    if not effective:  # Source-oracle verification only; never an application path.
        labour_factor = _compute(lambda: (1 + _number(globals_.get('L'))) * _number(quantity))
        material_factor = _compute(lambda: (1 + _number(globals_.get('M'))) * _number(quantity))
    total_hours = outputs.get('DK')

    def hours(value):
        def adjusted():
            _number(total_hours)
            if total_hours in (None, ''):
                # Use the already evaluated source gate. Re-summing raw tasks
                # could disagree at floating-point cancellation boundaries.
                return ''
            if value in (None, ''):
                return ''
            return _number(value) * _number(labour_factor)
        return _compute(adjusted)

    def labour_cost(value, adjustment=0):
        def adjusted():
            if value in (None, '') and not _number(adjustment):
                return ''
            return _number(value) * _number(outputs.get('CW')) + _number(adjustment)
        return _compute(adjusted)

    def material_cost(column, additional=False):
        def adjusted():
            value = outputs.get(column)
            adjustment = inputs.get('AI') if additional else 0
            if value in (None, '') and not _number(adjustment):
                return ''
            return (_number(value) + _number(adjustment)) * _number(material_factor)
        return _compute(adjusted)

    def unit_price(column):
        return [{'column': column, 'value': _source_value(outputs.get(column)), 'format': 'currency'}]

    miscellaneous = hours(miscellaneous_hours)
    rows = [{'label': 'Labour', 'unit_prices': unit_price('CW'), 'material_quantities': [],
             'material_costs': '', 'labour_costs': labour_cost(miscellaneous, inputs.get('AJ')),
             'task_hours': miscellaneous}]
    for label, price, material, task, quantities in TASKS:
        task_hours = hours(outputs.get(task))
        quantity_values = []
        for column, context in quantities:
            # AC is the source Mastic Qty input; DO prices AC and G applies O.
            # Like the source-derived quantities, its display uses Item QTY once.
            value = inputs.get(column) if column in ('AC', 'AN', 'AF') else outputs.get(column)
            if column == 'AF' and value not in (None, ''):
                value = _compute(lambda: _number(value) * (1 + _number(inputs.get('AG'))))
            scaled = value if value in (None, '') else _compute(lambda: _number(value) * _number(quantity))
            quantity_values.append({'column': column, 'label': context, 'value': scaled,
                                    'format': 'number', 'units': ''})
        rows.append({'label': label, 'unit_prices': unit_price(price), 'material_quantities': quantity_values,
                     'material_costs': material_cost(material, label == 'Other'),
                     'labour_costs': labour_cost(task_hours), 'task_hours': task_hours})
    note = NOTE
    if (total_hours in (None, '')
            and any(isinstance(outputs.get(task[3]), (int, float)) and outputs[task[3]] != 0 for task in TASKS)):
        note += ' The source omits task hours when the base task-hour total is zero or negative.'
    return {'basis': 'adjusted_line', 'rows': rows,
            'totals': {'material_costs': _source_value(outputs.get('G')),
                       'labour_costs': _source_value(outputs.get('F')),
                       'task_hours': _source_value(outputs.get('DK'))}, 'note': note}


def add_breakdowns(result, source, *, effective=True):
    """Attach view data only after the source calculation has completed."""
    miscellaneous = _miscellaneous_hours(source)
    for row in result['rows']:
        row['breakdown'] = line_breakdown(row, result['draft']['globals'], miscellaneous, effective=effective)
    return result


def schedule_breakdown(result):
    """Aggregate compatible quantities and deduplicate identical product rates.

    Quantities retain product, source context and unit; prices also retain rate.
    Entries without a selected product keep their individual line identities.
    The footer is the canonical calculation summary, not a rounded re-sum.
    """
    products = PRODUCT_COLUMNS
    rows = []
    for task, product_column in products.items():
        entries = [(index, row, next(item for item in row['breakdown']['rows'] if item['label'] == task))
                   for index, row in enumerate(result['rows'], 1)]
        combined = {'label': task, 'unit_prices': [], 'material_quantities': []}
        grouped = {'unit_prices': {}, 'material_quantities': {}}
        for index, row, item in entries:
            product = row['inputs'].get(product_column)
            for key in ('unit_prices', 'material_quantities'):
                for value in item[key]:
                    if value['value'] in (None, ''):
                        continue
                    context = value.get('label')
                    identity = (product, value['column'], context, value.get('format'), value.get('units', ''),
                                _source_value(value['value']) if key == 'unit_prices' else None,
                                row['id'] if product in (None, '') else None)
                    if identity not in grouped[key]:
                        label = ' · '.join(str(part) for part in
                                           (f'Line {index}' if product in (None, '') else None,
                                            product, context) if part not in (None, ''))
                        group = {**value, 'label': label, 'row_ids': [],
                                 'product_column': product_column, 'product': product}
                        grouped[key][identity] = group
                        combined[key].append(group)
                    group = grouped[key][identity]
                    if key == 'material_quantities' and group['row_ids']:
                        group['value'] = _compute(lambda: _number(group['value']) + _number(value['value']))
                    else:
                        group['value'] = _source_value(value['value'])
                    group['row_ids'].append(row['id'])
        for key in ('material_costs', 'labour_costs', 'task_hours'):
            combined[key] = _compute(lambda: sum(_number(item[key]) for _, _, item in entries))
        rows.append(combined)

    source_groups = []
    for group in ('Summary',):
        fields = [field for field in result['definition']['output_fields']
                  if field['group'] == group and field['column'] not in ('B', 'C', 'D', 'E')]
        source_rows = []
        for index, row in enumerate(result['rows'], 1):
            values = [{key: field.get(key, '') for key in ('column', 'label', 'format', 'units')}
                      | {'value': _source_value(row['outputs'][field['column']])}
                      for field in fields if row['outputs'].get(field['column']) not in (None, '')]
            if values:
                source_rows.append({'row_id': row['id'], 'label': f'Line {index}', 'values': values})
        source_groups.append({'label': group, 'rows': source_rows})
    summary = result['summary']
    return {'basis': 'adjusted_schedule', 'rows': rows,
            'totals': {'material_costs': _source_value(summary['materials']),
                       'labour_costs': _source_value(summary['labour']),
                       'task_hours': _source_value(summary['labour_hours'])},
            'source_groups': source_groups,
            'note': ('Costs and task hours include schedule quantities. '
                     'Matching product unit prices are shown once; quantities total matching products, contexts and units. '
                     'Project allowances and substrate, access and complexity multipliers are excluded.')}


def material_breakdown(result):
    """Project schedule products into the quote's material and labour-day rows.

    Board and Wrap share one source task per line. Their hours are allocated
    proportionally to that line's calculated quantities, before aggregation.
    Never round quantities, prices or hours before the display/export boundary.
    """
    materials, grouped = [], {}
    for index, row in enumerate(result['rows'], 1):
        for task in row['breakdown']['rows']:
            quantities = [value for value in task['material_quantities']
                          if value['value'] not in (None, '')]
            if not quantities:
                continue
            total_quantity = _compute(lambda: sum(_number(value['value']) for value in quantities))
            hours = task['task_hours']
            allocated = 0
            for position, value in enumerate(quantities):
                quantity = _source_value(value['value'])
                if total_quantity == 0 or hours in (None, ''):
                    share = 0
                elif position == len(quantities) - 1:
                    share = _compute(lambda: _number(hours) - _number(allocated))
                else:
                    share = _compute(lambda: _number(hours) * _number(quantity) / _number(total_quantity))
                allocated = _compute(lambda: _number(allocated) + _number(share))
                product = row['inputs'].get(PRODUCT_COLUMNS[task['label']])
                price = _source_value(task['unit_prices'][0]['value'])
                context = value.get('label', '')
                key = (product, task['label'], value['column'], context, value.get('units', ''), price,
                       row['id'] if product in (None, '') else None)
                if key not in grouped:
                    item = {'source': 'firestopping', 'name': ' · '.join(str(part) for part in
                            (product or f"Line {index} {task['label']}", context) if part),
                            'product': product, 'context': context, 'quantity': quantity,
                            'price': price, 'task_hours': share, 'row_ids': [],
                            'quantity_column': value['column'], 'units': value.get('units', '')}
                    grouped[key] = item
                    materials.append(item)
                else:
                    item = grouped[key]
                    item['quantity'] = _compute(lambda: _number(item['quantity']) + _number(quantity))
                    item['task_hours'] = _compute(lambda: _number(item['task_hours']) + _number(share))
                item['row_ids'].append(row['id'])
        adjustment = row['inputs'].get('AI')
        if adjustment not in (None, '', 0):
            amount = _compute(lambda: _number(adjustment) * _number(row['inputs'].get('O')))
            materials.append({'source': 'firestopping', 'name': f'Line {index} · Material adjustment',
                              'product': None, 'context': 'Material adjustment', 'quantity': 1,
                              'price': amount, 'task_hours': 0, 'row_ids': [row['id']], 'units': ''})
    for item in materials:
        item['total'] = _compute(lambda: _number(item['quantity']) * _number(item['price']))
        item['days'] = _compute(lambda: _number(item['task_hours']) / HOURS_PER_DAY)
    return materials
