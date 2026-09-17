"""Schedule display rows, separate from the immutable calculation capacity.

Rows keep their workbook addresses. Visibility can never hide entered values;
removal clears input overrides rather than moving formulas or reference cells.
"""

from functools import lru_cache
import re

from .catalog import ValidationError
from .calculator_defaults import default_calculator_inputs
from .workbook_runtime import _application_catalog


@lru_cache(maxsize=3)
def _shape(calculator_id):
    model = _application_catalog(calculator_id)
    schedule = model['schedule']
    source = next(sheet for sheet in model['sheets'] if sheet['name'] == schedule['sheet'])
    columns = {field['column'] for field in schedule['columns']
               if field.get('editable') and not field.get('generated')}
    literals = {}
    for address, cell in source['cells'].items():
        match = re.fullmatch(r'([A-Z]+)([1-9]\d*)', address)
        if (match and match[1] in columns and schedule['first_row'] <= int(match[2]) <= schedule['last_row']
                and 'formula' not in cell and cell.get('value') not in (None, '')):
            literals[address] = cell['value']
    return schedule, columns, literals


def empty_schedule_inputs(calculator_id):
    """New/reset inputs explicitly blank every source example, preserving settings."""
    schedule, _, literals = _shape(calculator_id)
    inputs = default_calculator_inputs(calculator_id)
    inputs[schedule['sheet']] = {address: None for address in literals}
    return inputs


def populated_schedule_rows(calculator_id, inputs=None):
    """Include partial rows, zero values and advanced input; ignore line labels."""
    schedule, columns, literals = _shape(calculator_id)
    values = dict(literals)
    for address, value in (inputs or {}).get(schedule['sheet'], {}).items():
        match = re.fullmatch(r'([A-Z]+)([1-9]\d*)', address)
        if match and match[1] in columns and schedule['first_row'] <= int(match[2]) <= schedule['last_row']:
            values[address] = value
    return {int(re.search(r'\d+$', address)[0]) for address, value in values.items()
            if value not in (None, '')}


def normalize_schedule_rows(calculator_id, inputs=None, rows=None):
    """Derive legacy extents, or preserve explicitly added and removed rows.

    Populated rows omitted from stale metadata are restored to the display. This
    never changes the input map or suppresses data from calculations/reports.
    """
    schedule, _, _ = _shape(calculator_id)
    first, last = schedule['first_row'], schedule['last_row']
    populated = populated_schedule_rows(calculator_id, inputs)
    if rows is None:
        return list(range(first, max(populated, default=first) + 1))
    if (not isinstance(rows, list) or not 1 <= len(rows) <= last - first + 1
            or any(type(row) is not int or not first <= row <= last for row in rows)
            or len(set(rows)) != len(rows) or rows != sorted(rows)):
        raise ValidationError('Schedule rows must be an ordered list of unique available row numbers, with at least one row.')
    return sorted(set(rows) | populated)


def schedule_window(calculator_id, inputs, view):
    schedule, _, _ = _shape(calculator_id)
    if not isinstance(view, dict) or set(view) - {'rows', 'offset', 'limit'}:
        raise ValidationError('Schedule view must contain rows and bounded window options only.')
    rows = normalize_schedule_rows(calculator_id, inputs, view.get('rows'))
    offset, limit = view.get('offset', 0), view.get('limit', 60)
    if (type(offset) is not int or offset < 0 or offset >= len(rows)
            or type(limit) is not int or not 1 <= limit <= 100):
        raise ValidationError('Schedule window must start within the schedule and contain 1 to 100 rows.')
    return {'rows': rows, 'offset': offset, 'limit': limit, 'total_rows': len(rows),
            'capacity': schedule['last_row'] - schedule['first_row'] + 1,
            'first_row': schedule['first_row'], 'last_row': schedule['last_row']}
