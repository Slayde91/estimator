"""Adjusted line-detail presentation over existing workbook results.

This module never evaluates or replaces workbook formulas. Raw inputs, outputs
and summaries remain intact; footer values come directly from G, F and DK.
"""

import math
import re

from .excel_engine import column_name, column_number


TASKS = (
    ('Board', 'CX', 'DM', 'DE', (('CJ', 'Substrate'), ('CQ', 'Bulkhead'))),
    ('Collars', 'CY', 'DN', 'DF', ()),
    ('Mastic', 'CZ', 'DO', 'DG', ()),
    ('Framing', 'DA', 'DP', 'DH', (('CU', 'Bulkhead'),)),
    ('Wrap', 'DB', 'DQ', 'DI', (('BS', 'Pipes'), ('CB', 'Cabletrays'))),
    ('Other', 'DC', 'DR', 'DJ', ()),
)
NOTE = ('Quantities use this line’s Item QTY. Costs and task hours include the applicable allowances. '
        'Labour includes setup/register time and the labour adjustment; Other includes the material adjustment. '
        'Substrate, complexity, access and travel/LAFHA are shown separately.')


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


def line_breakdown(row, globals_, miscellaneous_hours):
    inputs, outputs = row['inputs'], row['outputs']
    quantity = inputs.get('O')
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
            value = outputs.get(column)
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


def add_breakdowns(result, source):
    """Attach view data only after the source calculation has completed."""
    miscellaneous = _miscellaneous_hours(source)
    for row in result['rows']:
        row['breakdown'] = line_breakdown(row, result['draft']['globals'], miscellaneous)
    return result
