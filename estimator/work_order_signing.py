"""Deliberate Work Order signing commands; loading saved ink is never a command."""
from datetime import date
from copy import deepcopy

from .catalog import ValidationError
from .swms import validate_signature


STEPS = {
    'details_by': ('details_date', 'Review'),
    'reviewed_by': ('review_date', 'OHS Docs'),
    'prepared_by': ('prepared_date', 'Client Approval'),
    'client_approved_by': ('client_approval_date', 'In progress'),
    'progress_by': ('progress_date', 'Claim'),
    'claimed_by': ('claim_date', 'Certify'),
    'closed_by': ('closed_date', None),
}
COMPLETIONS = ('Completed', 'Ongoing', 'On hold', 'Not completed')
STATUSES = ('Draft','Review','OHS Docs','Client Approval','In progress','Claim','Certify','Completed','On Hold','Canceled')
CYCLE_FIELDS = ('certification', 'completion', 'closed_by', 'closed_date',
                'progress_by', 'progress_date', 'claimed_by', 'claim_date')


def actions(value, kind):
    if not isinstance(value, list) or len(value) > 32 or (value and kind != 'work_order'):
        raise ValidationError('Invalid Work Order signing actions.')
    result = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get('key'),str) or item['key'] not in STEPS:
            raise ValidationError('Choose a valid Work Order signature.')
        keys = {'key', 'signature', 'name', 'date'}
        if item['key'] == 'closed_by':
            keys |= {'completion', 'certification'}
        optional = {'status_override'}
        if item['key']=='closed_by' and item.get('completion')=='Ongoing':optional.add('after_signing_edits')
        if set(item) - optional != keys:
            raise ValidationError('Include the complete Work Order signing action.')
        signature = validate_signature(item['signature'])
        if not signature or not any(len({tuple(point) for point in stroke}) > 1 for stroke in signature['strokes']):
            raise ValidationError('Add a signature before progressing the Work Order.')
        for key, limit in (('name', 6000), ('date', 10), ('certification', 6000)):
            if key in item and (not isinstance(item[key], str) or len(item[key]) > limit
                                or any(ord(char) < 32 and char not in '\n\r\t' or 0xd800 <= ord(char) <= 0xdfff for char in item[key])):
                raise ValidationError('Include valid Work Order signer details.')
        try:
            if date.fromisoformat(item['date']).isoformat() != item['date']:
                raise ValueError
        except ValueError:
            raise ValidationError('Include a valid signature date.') from None
        if item['key'] == 'closed_by' and item['completion'] not in COMPLETIONS:
            raise ValidationError('Choose a completion status before signing Work Order completion.')
        edits=item.get('after_signing_edits',[])
        if (not isinstance(edits,list) or len(edits)>len(CYCLE_FIELDS)
                or any(not isinstance(key,str) or key not in CYCLE_FIELDS for key in edits) or len(set(edits))!=len(edits)):
            raise ValidationError('Invalid edits after signing Work Order completion.')
        if 'status_override' in item and item['status_override'] not in STATUSES:
            raise ValidationError('Choose a valid commercial document status.')
        result.append({**deepcopy(item), 'signature': signature})
    return result


def apply(fields, status, signed):
    """Apply bounded actions in click order inside the caller's save transaction.

    Each ink snapshot remains in the audit even when an Ongoing closure clears
    the new cycle's fields. Ordinary Save/import/name/date edits carry no actions.
    """
    expected = {}
    completion = None
    clears = set()
    clear_signatures = set()
    for item in signed:
        key = item['key']
        expected[key] = item['signature']
        clears.difference_update((key,STEPS[key][0]))
        clear_signatures.discard(key)
        target = STEPS[key][1]
        if key == 'closed_by':
            completion = item['completion']
            if item['completion'] == 'Completed':
                clears.difference_update(('completion','certification'))
                target = 'Completed'
            elif item['completion'] == 'Ongoing':
                clears.update(CYCLE_FIELDS)
                clears.difference_update(item.get('after_signing_edits',[]))
                for name in ('closed_by', 'progress_by', 'claimed_by'):
                    clear_signatures.add(name)
                    expected[name] = None
                target = 'In progress'
        if target:
            status = target
        if 'status_override' in item:
            status = item['status_override']
    for name in clears:
        fields['order'][name] = ''
    for name in clear_signatures:
        fields.setdefault('signatures', {}).pop(name,None)
    # The current fields must contain the chosen ink unless that same command
    # deliberately cleared it for the next progress/claim cycle.
    for key, signature in expected.items():
        if fields.get('signatures', {}).get(key) != signature:
            raise ValidationError('The Work Order signature changed. Sign it again before saving.')
    if completion and completion != 'Ongoing' and fields['order']['completion'] != completion:
        raise ValidationError('The completion choice changed. Sign Work Order completion again.')
    return status
