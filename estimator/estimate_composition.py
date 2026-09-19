"""Combine independent calculations under the application quote policy.

The source calculators and formulas remain unchanged. This composition result
retains the entered percentages, calculates component cells without them, then
overlays the combined cost summary after each percentage is applied once. The
full Firestopping result and its input/source snapshot remain auditable.
"""

from copy import deepcopy
import math

from .calculator import calculate as calculate_base, normalize_inputs
from .catalog import ValidationError, effective_catalog
from .penetration_calculator import calculate as calculate_firestopping, normalize_draft, source_model


CALCULATION_POLICY_VERSION = 'combined-global-cost-adjustments-v1'


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


def calculate_for_load(inputs=None, configuration=None, penetration=None):
    """Open historical inputs for correction without inventing a valid quote.

    This fallback is used only by project loading. Every input and the complete
    pricing/schedule snapshot still pass validation; no formula executes with
    the missing-team requirement bypassed. Saving and exports remain strict.
    """
    try:
        return calculate(inputs, configuration, penetration)
    except ValidationError as error:
        if str(error) != 'Select Teams':
            raise
    normalized = normalize_inputs({} if inputs is None else inputs, effective_catalog(configuration), require_teams=False)
    result = {'inputs': normalized, 'cells': deepcopy(normalized),
              'errors': {'coverage_teams': 'Select Teams'},
              'summary': dict.fromkeys(('labour', 'material', 'access', 'travel', 'subtotal', 'total', 'rate', 'days')),
              'materials': [], 'notes': normalized.get('B12', ''),
              'labour': {'tasks': [], 'task_days': None, 'masking_days': None,
                         'extra_days': None, 'mobilisation_days': None, 'total_days': None}}
    if penetration is not None:
        snapshot = normalize_penetration(penetration)
        schedule = calculate_firestopping(snapshot['draft'], configuration)
        result['firestopping'] = {**snapshot, 'result': schedule}
        for index, error in enumerate(schedule['errors']):
            result['errors'][f'firestopping:{index}:{error["cell"]}'] = error['message']
    return result


def calculate(inputs=None, configuration=None, penetration=None):
    """Calculate one quote, then apply global percentages once to combined costs.

    The immutable main-estimator formulas remain available through
    ``calculator.calculate``. The application quote policy removes those two
    source percentages while calculating component quantities and days, combines
    Firestopping, then applies each percentage once to its complete cost base.
    """
    normalized = normalize_inputs({} if inputs is None else inputs,
                                  effective_catalog(configuration))
    material_percent, labour_percent = normalized['B26'], normalized['B27']
    source_inputs = deepcopy(normalized)
    source_inputs.update(B26=0, B27=0)
    result = calculate_base(source_inputs, configuration)
    result['inputs'] = deepcopy(normalized)
    result['cells'].update(B26=material_percent, B27=labour_percent)
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
    rate = None if total is None else _computed(lambda: _number(total) / _number(result['inputs']['B8']))
    if isinstance(rate, str):
        result['errors']['composed-summary:rate'] = rate
        rate = None
    result['summary'].update(subtotal=subtotal, total=total, rate=rate)
    result['global_adjustments'] = adjustments
    result['calculation_policy'] = CALCULATION_POLICY_VERSION
    result['cells'].update(F2=result['summary']['labour'], F3=result['summary']['material'],
                           F6=subtotal, F7=total, F8=rate)
    material_adjustment = adjustments['material']['amount']
    if material_adjustment not in (None, 0):
        result['materials'].append({'source': 'global_adjustment',
            'name': 'Global material adjustment', 'quantity': 1,
            'price': material_adjustment, 'total': material_adjustment, 'days': 0})
    return result
