"""Combine independent source calculations once, without changing their formulas.

The main estimator cells remain its original workbook values. Combined quote
totals, material rows and labour days live in the presentation result; the full
Firestopping result and its input/source snapshot remain independently auditable.
"""

from copy import deepcopy
import math

from .calculator import calculate as calculate_base, normalize_inputs
from .catalog import ValidationError, effective_catalog
from .penetration_calculator import calculate as calculate_firestopping, normalize_draft, source_model


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
    """Calculate a main estimate and, when supplied, its saved schedule only."""
    result = calculate_base(inputs, configuration)
    if penetration is None:
        return result
    snapshot = normalize_penetration(penetration)
    firestopping = calculate_firestopping(snapshot['draft'], configuration)
    result['base_summary'] = deepcopy(result['summary'])
    result['firestopping'] = {**snapshot, 'result': firestopping}
    result['materials'].extend(deepcopy(firestopping['material_breakdown']))

    for index, error in enumerate(firestopping['errors']):
        result['errors'][f'firestopping:{index}:{error["cell"]}'] = error['message']

    summary = firestopping['summary']
    mapping = {'labour': 'labour', 'material': 'materials', 'access': 'access',
               'travel': 'travel_lafha', 'subtotal': 'grand_total',
               'total': 'grand_total', 'days': 'total_days'}
    for key, source_key in mapping.items():
        base_value = result['base_summary'][key]
        combined = None if base_value is None else _computed(
            lambda: _number(base_value) + _number(summary[source_key]))
        if isinstance(combined, str):
            result['errors']['firestopping-summary:' + key] = combined
            combined = None
        result['summary'][key] = combined
    total = result['summary']['total']
    rate = None if total is None else _computed(lambda: total / _number(result['inputs']['B8']))
    if isinstance(rate, str):
        result['errors']['composed-summary:rate'] = rate
        rate = None
    result['summary']['rate'] = rate

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
    return result
