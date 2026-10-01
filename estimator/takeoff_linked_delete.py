"""Input-only, reversible removal of locally verified takeoff schedule rows."""

from copy import deepcopy

from .catalog import ValidationError
from .schedule_rows import normalize_schedule_rows
from .takeoff_model import digest, object_fields
from .takeoff_transfer import row_values
from .workbook_calculators import source_model, validate_calculator_edits


def _drafts(calculators, ids):
    if not isinstance(calculators, dict) or set(calculators) != set(ids):
        raise ValidationError('Include every linked calculator draft, and no unrelated calculators.')
    result = deepcopy(calculators)
    for calculator_id, draft in result.items():
        object_fields(draft, {'inputs', 'schedule_rows'}, 'Linked calculator draft', {'inputs', 'schedule_rows'})
        validate_calculator_edits(calculator_id, draft['inputs'], draft['inputs'])
        draft['schedule_rows'] = normalize_schedule_rows(calculator_id, draft['inputs'], draft['schedule_rows'])
    return result


def prepare_delete(bindings, calculators):
    """Validate the entire batch before returning any changed input maps."""
    result = _drafts(calculators, {binding['calculator_id'] for binding in bindings})
    receipt = {}
    for binding in bindings:
        calculator_id = binding['calculator_id']
        model = source_model(calculator_id)
        schedule = model['schedule']
        draft = result[calculator_id]
        row = binding['row']
        current = row_values(draft['inputs'], schedule, row)
        if (binding['status'] not in ('current', 'stale') or binding['source_sha256'] != model['source']['sha256']
                or binding['sheet'] != schedule['sheet']):
            raise ValidationError('A linked schedule source is unverified or changed. Resolve its source link before deleting.')
        # A separately removed/cleared row is already absent; never infer that a
        # different populated row at its address belongs to this takeoff.
        if any(value not in (None, '') for value in current.values()) and digest(current) != binding['input_hash']:
            raise ValidationError('A linked schedule row was edited. Your edits were preserved; resolve the row before deleting this item.')
        retained = receipt.setdefault(calculator_id, {'source_sha256': model['source']['sha256'],
            'sheet': schedule['sheet'], 'had_sheet': schedule['sheet'] in draft['inputs'],
            'before_rows': deepcopy(draft['schedule_rows']), 'rows': []})
        cells = draft['inputs'].setdefault(schedule['sheet'], {})
        patch = {address: {'present': address in cells, 'value': deepcopy(cells.get(address))} for address in current}
        for address in current:
            cells[address] = None
        retained['rows'].append({'row': row, 'before': patch,
                                 'cleared_hash': digest(row_values(draft['inputs'], schedule, row))})
        draft['schedule_rows'] = [value for value in draft['schedule_rows'] if value != row]
    for calculator_id, draft in result.items():
        schedule = source_model(calculator_id)['schedule']
        if not draft['schedule_rows']:
            draft['schedule_rows'] = [schedule['first_row']]
        receipt[calculator_id]['after_rows'] = deepcopy(draft['schedule_rows'])
        validate_calculator_edits(calculator_id, draft['inputs'], calculators[calculator_id]['inputs'])
    return result, receipt


def prepare_undo(receipt, calculators):
    """Restore exact removed literals while preserving unrelated later edits."""
    result = _drafts(calculators, receipt)
    for calculator_id, retained in receipt.items():
        model = source_model(calculator_id)
        schedule = model['schedule']
        draft = result[calculator_id]
        if retained['source_sha256'] != model['source']['sha256'] or draft['schedule_rows'] != retained['after_rows']:
            raise ValidationError('The linked schedule rows changed after deletion. Undo cannot overwrite the current schedule.')
        for removed in retained['rows']:
            if digest(row_values(draft['inputs'], schedule, removed['row'])) != removed['cleared_hash']:
                raise ValidationError('A deleted schedule row now contains changes. Undo cannot overwrite those values.')
        cells = draft['inputs'].setdefault(schedule['sheet'], {})
        for removed in retained['rows']:
            for address, value in removed['before'].items():
                if value['present']:
                    cells[address] = deepcopy(value['value'])
                else:
                    cells.pop(address, None)
        if not cells and not retained['had_sheet']:
            draft['inputs'].pop(schedule['sheet'], None)
        draft['schedule_rows'] = deepcopy(retained['before_rows'])
        validate_calculator_edits(calculator_id, draft['inputs'], calculators[calculator_id]['inputs'])
    return result
