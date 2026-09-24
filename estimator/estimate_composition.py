"""Combine independent calculations under the application quote policy.

The source calculators and formulas remain unchanged. This composition result
retains the entered percentages, calculates component cells without them, then
overlays the combined cost summary after each percentage is applied once. The
full Firestopping result and its input/source snapshot remain auditable.
"""

from copy import deepcopy
import math

from .calculator import LINES, calculate as calculate_base, normalize_inputs
from .catalog import ValidationError, effective_catalog
from .penetration_calculator import calculate as calculate_firestopping, normalize_draft, source_model
from .presentation import MATERIAL_NAMES


CALCULATION_POLICY_VERSION = 'combined-global-cost-adjustments-v1'
MAX_DUPLICATE_WORK_ITEMS = 100


def normalize_work_items(value, inputs, catalog, *, require_teams=True):
    """Validate extra material rows without changing the workbook input grid.

    Each duplicate carries only the four editable values from its source row.
    The source row continues to supply the applicable labour team from the
    estimate, so duplicate output follows the same workbook formula and rate.
    """
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_DUPLICATE_WORK_ITEMS:
        raise ValidationError(f'Work items must be a list of at most {MAX_DUPLICATE_WORK_ITEMS} rows.')
    normalized = []
    seen = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {'id', 'source_row', 'inputs'}:
            raise ValidationError('Each duplicated work item must contain its id, source row and inputs only.')
        item_id, source_row, item_inputs = item['id'], item['source_row'], item['inputs']
        if not isinstance(item_id, str) or not item_id or len(item_id) > 100 or item_id in seen:
            raise ValidationError('Each duplicated work item must have a unique id of at most 100 characters.')
        if type(source_row) is not int or source_row not in range(15, 24):
            raise ValidationError('A duplicated work item must use a material row from 15 to 23.')
        if not isinstance(item_inputs, dict) or set(item_inputs) != {'B', 'C', 'D', 'E'}:
            raise ValidationError('Duplicated work item inputs must contain B, C, D and E values only.')
        candidate = dict(inputs)
        for row in range(15, 24):
            candidate[f'B{row}'] = 0
        for column in ('B', 'C', 'D', 'E'):
            candidate[f'{column}{source_row}'] = item_inputs[column]
        checked = normalize_inputs(candidate, catalog, require_teams=require_teams)
        normalized.append({'id': item_id, 'source_row': source_row,
                           'inputs': {column: checked[f'{column}{source_row}'] for column in ('B', 'C', 'D', 'E')}})
        seen.add(item_id)
    return normalized


def _duplicate_result(item, normalized_inputs, configuration):
    source_row = item['source_row']
    duplicate_inputs = deepcopy(normalized_inputs)
    for row in range(15, 24):
        duplicate_inputs[f'B{row}'] = 0
    duplicate_inputs.update(B9=0, B26=0, B27=0, B28=0, F26=0, F27=0, F28=0)
    for column, value in item['inputs'].items():
        duplicate_inputs[f'{column}{source_row}'] = value
    calculated = calculate_base(duplicate_inputs, configuration)
    line_index = source_row - 15
    line = LINES[line_index]
    requirement_row, labour_row = line[2], line[3]
    material = deepcopy(calculated['materials'][line_index])
    material.update(source=f'duplicate_work_item:{item["id"]}', work_item_id=item['id'],
                    work_item_label=f'{MATERIAL_NAMES[line_index]} (duplicate)')
    labour = None if labour_row is None else {
        'source': 'duplicate_work_item', 'work_item_id': item['id'],
        'name': MATERIAL_NAMES[line_index],
        'days': calculated['cells'].get(f'B{requirement_row}'),
        'total': calculated['cells'].get(f'F{labour_row}'),
    }
    return {'item': deepcopy(item), 'material': material, 'labour': labour,
            'yield': calculated['cells'].get(f'F{source_row}'),
            'summary': deepcopy(calculated['summary']), 'errors': deepcopy(calculated['errors'])}


def _add_duplicate_work_items(result, work_items, normalized_inputs, configuration):
    calculated_items = []
    for item in work_items:
        duplicate = _duplicate_result(item, normalized_inputs, configuration)
        calculated_items.append({**duplicate['item'], 'yield': duplicate['yield']})
        result['materials'].append(duplicate['material'])
        if duplicate['labour'] is not None:
            labour = duplicate['labour']
            task = next((candidate for candidate in result['labour']['tasks']
                         if candidate.get('name') == labour['name']), None)
            if task is None:
                task = {'name': labour['name'], 'days': 0}
                result['labour']['tasks'].append(task)
            task['days'] = _computed(
                lambda task=task, labour=labour: _number(task.get('days')) + _number(labour.get('days')))
            task.setdefault('work_item_ids', []).append(item['id'])
        for cell, error in duplicate['errors'].items():
            result['errors'][f'duplicate:{item["id"]}:{cell}'] = error
        for key in ('material', 'labour', 'days'):
            base, addition = result['summary'][key], duplicate['summary'][key]
            combined = None if base is None or addition is None else _computed(
                lambda base=base, addition=addition: _number(base) + _number(addition))
            if isinstance(combined, str):
                result['errors'][f'duplicate:{item["id"]}:{key}'] = combined
                combined = None
            result['summary'][key] = combined
        duplicate_days = duplicate['summary']['days']
        task_days = result['labour'].get('task_days')
        result['labour']['task_days'] = None if task_days is None or duplicate_days is None else _computed(
            lambda task_days=task_days, duplicate_days=duplicate_days: _number(task_days) + _number(duplicate_days))
        result['labour']['total_days'] = result['summary']['days']
    result['work_items'] = calculated_items


def normalize_penetration(value):
    if (not isinstance(value, dict) or 'draft' not in value
            or set(value) - {'draft', 'source_sha256'}):
        raise ValidationError('Include the Firestopping schedule draft only in the estimate.')
    source_hash = source_model()['source']['sha256']
    if 'source_sha256' in value and value['source_sha256'] != source_hash:
        raise ValidationError('The quote uses a different Firestopping Estimator workbook version.')
    return {'source_sha256': source_hash, 'draft': normalize_draft(value['draft'])}


def _number(value):
    # Workbook blank outputs have no charge. Error strings must not become zero.
    if value in (None, ''):
        return 0
    if isinstance(value, str) and value.startswith('#'):
        raise ValueError(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('#VALUE!')
    if not math.isfinite(value):
        raise ValueError('#NUM!')
    return value


def _computed(expression):
    try:
        value = expression()
        return value if math.isfinite(value) else '#NUM!'
    except ValueError as error:
        return str(error)
    except ZeroDivisionError:
        return '#DIV/0!'


def calculate_for_load(inputs=None, configuration=None, penetration=None, work_items=None):
    """Open historical inputs for correction without inventing a valid quote.

    This fallback is used only by project loading. Every input and the complete
    pricing/schedule snapshot still pass validation; no formula executes with
    the missing-team requirement bypassed. Saving and exports remain strict.
    """
    try:
        return calculate(inputs, configuration, penetration, work_items)
    except ValidationError as error:
        if str(error) != 'Select Teams':
            raise
    normalized = normalize_inputs({} if inputs is None else inputs, effective_catalog(configuration), require_teams=False)
    normalized_work_items = normalize_work_items(work_items, normalized, effective_catalog(configuration), require_teams=False)
    result = {'inputs': normalized, 'cells': deepcopy(normalized),
              'errors': {'coverage_teams': 'Select Teams'},
              'summary': dict.fromkeys(('labour', 'material', 'access', 'travel', 'subtotal', 'total', 'rate', 'days')),
              'materials': [], 'notes': normalized.get('B12', ''),
              'labour': {'tasks': [], 'task_days': None, 'masking_days': None,
                         'extra_days': None, 'mobilisation_days': None, 'total_days': None},
              'work_items': [{**item, 'yield': None} for item in normalized_work_items]}
    if penetration is not None:
        snapshot = normalize_penetration(penetration)
        schedule = calculate_firestopping(snapshot['draft'], configuration)
        result['firestopping'] = {**snapshot, 'result': schedule}
        for index, error in enumerate(schedule['errors']):
            result['errors'][f'firestopping:{index}:{error["cell"]}'] = error['message']
    return result


def calculate(inputs=None, configuration=None, penetration=None, work_items=None):
    """Calculate one quote, then apply global percentages once to combined costs.

    The immutable main-estimator formulas remain available through
    ``calculator.calculate``. The application quote policy removes those two
    source percentages while calculating component quantities and days, combines
    Firestopping, then applies each percentage once to its complete cost base.
    """
    catalog = effective_catalog(configuration)
    normalized = normalize_inputs({} if inputs is None else inputs, catalog)
    normalized_work_items = normalize_work_items(work_items, normalized, catalog)
    material_percent, labour_percent = normalized['B26'], normalized['B27']
    source_inputs = deepcopy(normalized)
    source_inputs.update(B26=0, B27=0)
    result = calculate_base(source_inputs, configuration)
    result['inputs'] = deepcopy(normalized)
    result['cells'].update(B26=material_percent, B27=labour_percent)
    _add_duplicate_work_items(result, normalized_work_items, normalized, configuration)
    if penetration is not None:
        snapshot = normalize_penetration(penetration)
        firestopping = calculate_firestopping(snapshot['draft'], configuration)
        result['base_summary'] = deepcopy(result['summary'])
        result['firestopping'] = {**snapshot, 'result': firestopping}
        result['materials'].extend(deepcopy(firestopping['material_breakdown']))

        for index, error in enumerate(firestopping['errors']):
            result['errors'][f'firestopping:{index}:{error["cell"]}'] = error['message']

        summary = firestopping['summary']
        mapping = {'labour': 'labour', 'material': 'materials', 'access': 'access',
                   'travel': 'travel_lafha', 'days': 'total_days'}
        for key, source_key in mapping.items():
            base_value = result['base_summary'][key]
            combined = None if base_value is None else _computed(
                lambda: _number(base_value) + _number(summary[source_key]))
            if isinstance(combined, str):
                result['errors']['firestopping-summary:' + key] = combined
                combined = None
            result['summary'][key] = combined

        labour = result['labour']
        firestopping_tasks = []
        for row in firestopping['schedule_breakdown']['rows']:
            firestopping_tasks.append({'source': 'firestopping', 'name': 'Firestopping · ' + row['label'],
                'task_hours': row['task_hours'],
                'days': _computed(lambda: _number(row['task_hours']) / 8),
                'total': row['labour_costs']})
        labour['tasks'].extend(firestopping_tasks)
        labour['firestopping_tasks'] = deepcopy(firestopping_tasks)
        labour['firestopping_days'] = _computed(lambda: _number(summary['labour_hours']) / 8)
        labour['task_days'] = _computed(lambda: _number(labour['task_days']) + _number(labour['firestopping_days']))
        labour['total_days'] = result['summary']['days']

    bases = {'material': result['summary']['material'], 'labour': result['summary']['labour']}
    adjustments = {}
    for key, percent in (('material', material_percent), ('labour', labour_percent)):
        base = bases[key]
        amount = None if base is None else _computed(lambda base=base, percent=percent:
                                                     _number(base) * _number(percent))
        if isinstance(amount, str):
            result['errors'][f'global-{key}-adjustment'] = amount
            amount = None
        adjusted = None if base is None or amount is None else _computed(
            lambda base=base, amount=amount: _number(base) + _number(amount))
        if isinstance(adjusted, str):
            result['errors'][f'global-{key}-total'] = adjusted
            adjusted = None
        adjustments[key] = {'percent': percent, 'base': base, 'amount': amount,
                            'total': adjusted}
        result['summary'][key] = adjusted

    components = [result['summary'][key] for key in ('labour', 'material', 'access', 'travel')]
    subtotal = None if any(value is None for value in components) else _computed(
        lambda: sum(_number(value) for value in components))
    if isinstance(subtotal, str):
        result['errors']['composed-summary:subtotal'] = subtotal
        subtotal = None
    fixed = result['cells'].get('D27', result['inputs'].get('B28'))
    total = None if subtotal is None else _computed(lambda: _number(subtotal) + _number(fixed))
    if isinstance(total, str):
        result['errors']['composed-summary:total'] = total
        total = None
    measure = result['inputs'].get('B8')
    rate = None if total is None or measure in (None, '', 0) else _computed(
        lambda: _number(total) / _number(measure))
    if isinstance(rate, str):
        result['errors']['composed-summary:rate'] = rate
        rate = None
    result['summary'].update(subtotal=subtotal, total=total, rate=rate)
    result['global_adjustments'] = adjustments
    result['calculation_policy'] = CALCULATION_POLICY_VERSION
    result['cells'].update(F2=result['summary']['labour'], F3=result['summary']['material'],
                           F6=subtotal, F7=total)
    # Retain the original Excel F8 error for source parity when the optional
    # denominator is blank or zero. User-facing summaries and errors use the
    # neutral unavailable rate above.
    if measure not in (None, '', 0):
        result['cells']['F8'] = rate
    material_adjustment = adjustments['material']['amount']
    if material_adjustment not in (None, 0):
        result['materials'].append({'source': 'global_adjustment',
            'name': 'Global material adjustment', 'quantity': 1,
            'price': material_adjustment, 'total': material_adjustment, 'days': 0})
    return result
