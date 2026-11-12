"""Ordered commercial signatures are validated inside the document save transaction."""
from copy import deepcopy
from datetime import date

from .catalog import ValidationError
from .commercial_requirements import meaningful
from .swms import validate_signature


STEPS = {
    'details_by': ('details_date', 'Review'),
    'reviewed_by': ('review_date', 'OHS Docs'),
    'prepared_by': ('prepared_date', 'Client Approval'),
    'client_approved_by': ('client_approval_date', 'In progress'),
    'progress_by': ('progress_date', 'Claim'),
    'claimed_by': ('claim_date', 'Certify'),
    'closed_by': ('closed_date', 'Completed'),
}
PURCHASE_STEPS = {
    'requested_by': ('requested_date', 'Requested'),
    'reviewed_by': ('review_date', 'Reviewed'),
    'sent_by': ('sent_date', 'Sent'),
    'verified_by': ('verified_date', 'Completed'),
}
WORKFLOWS = {'work_order': STEPS, 'purchase_order': PURCHASE_STEPS}
COMPLETIONS = ('Completed', 'Ongoing', 'On hold', 'Not completed')
CYCLE_SIGNERS = ('progress_by', 'claimed_by', 'closed_by')
# Additional inputs owned by each signed section. Tracking rows and claim
# billing belong to the ongoing job and survive a sign-off being withdrawn.
SECTION_INPUTS = {
    'work_order': {
        'details_by': ('start_date', 'end_date', 'urgency', 'description', 'estimated_cost', 'attachments'),
        'reviewed_by': ('approval', 'justification'),
        'prepared_by': ('swms', 'sds', 'sop', 'other_documents'),
        'client_approved_by': ('client_approval',),
        'claimed_by': ('claim',),
        'closed_by': ('certification', 'completion'),
    },
    'purchase_order': {
        'reviewed_by': ('approval', 'rejection_reason'),
        'verified_by': ('verification',),
    },
}


def _valid_date(value):
    try:
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _ink(signature):
    return bool(signature and any(len({tuple(point) for point in stroke}) > 1 for stroke in signature['strokes']))


def actions(value, kind):
    if not isinstance(value, list) or len(value) > 1 or (value and kind not in WORKFLOWS):
        raise ValidationError('Invalid commercial document signing actions.')
    result = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get('key'), str) or item['key'] not in WORKFLOWS[kind]:
            raise ValidationError('Choose a valid commercial document signature.')
        if set(item) == {'key', 'clear'} and item['clear'] is True:
            result.append({'key': item['key'], 'clear': True})
            continue
        keys = {'key', 'signature', 'name', 'date'}
        if item['key'] == 'closed_by':
            keys.update(('completion', 'certification'))
        if set(item) != keys:
            raise ValidationError('Include the complete signing action.')
        signature = validate_signature(item['signature'])
        if not _ink(signature):
            raise ValidationError('Add a signature before saving this step.')
        if not meaningful(item['name']) or len(item['name']) > 6000:
            raise ValidationError('Enter the signer name and date before signing.')
        if not _valid_date(item['date']):
            raise ValidationError('Enter the signer name and date before signing.')
        if item['key'] == 'closed_by' and item['completion'] not in COMPLETIONS:
            raise ValidationError('Choose a completion status before signing Work Order completion.')
        result.append({**deepcopy(item), 'signature': signature})
    return result


def _outcome(kind, key, order):
    if key == 'reviewed_by':
        rejection = 'Denied' if kind == 'work_order' else 'Rejected'
        if order.get('approval') == rejection:
            return 'Cancelled'
        if order.get('approval') != 'Approved':
            raise ValidationError('Choose an approval decision before signing.')
    if key == 'closed_by':
        if order['completion'] == 'On hold':
            return 'On Hold'
        if order['completion'] in ('Ongoing', 'Not completed'):
            return 'In progress'
        if order['completion'] != 'Completed':
            raise ValidationError('Choose a completion status before signing Work Order completion.')
    return WORKFLOWS[kind][key][1]


def _clear_from(kind, key, fields, status):
    steps = WORKFLOWS[kind]
    sequence = list(steps)
    start = sequence.index(key)
    for signer in sequence[start:]:
        fields.get('signatures', {}).pop(signer, None)
        for name in (signer, steps[signer][0], *SECTION_INPUTS[kind].get(signer, ())):
            if name in fields['order']:
                fields['order'][name] = ''
    if not fields.get('signatures'):
        fields.pop('signatures', None)
    if key == 'details_by':
        fields['estimated_cost_cleared'] = True
        fields['order'].update(details_by='', details_date='')
    stages = ['Draft', *(target for _, target in steps.values())]
    reached = (sequence.index('reviewed_by') + 1 if status == 'Cancelled' else
               len(sequence) if status == 'On Hold' else stages.index(status))
    return stages[start] if start < reached else status


def apply(kind, fields, status, signed, previous, *, legacy_details=False):
    """Advance only deliberate actions; unchanged historical signoffs remain readable."""
    if kind not in WORKFLOWS:
        return status
    steps = WORKFLOWS[kind]
    sequence = tuple(steps)
    prior = previous['fields'] if previous else {}
    old_ink = prior.get('signatures', {})
    ink = fields.get('signatures', {})
    order = fields['order']
    changed = {key for key, value in ink.items() if value and value != old_ink.get(key)}
    active = {key for key in steps if _ink(old_ink.get(key)) and ink.get(key) == old_ink[key]}
    clear_action = signed and signed[0].get('clear')
    reset = signed[0]['key'] if clear_action else None
    action_keys = {item['key'] for item in signed}
    if signed and (changed if clear_action else changed - action_keys):
        raise ValidationError('Save each signature using its signing button.')
    cleared = {key for key in steps if old_ink.get(key) and not ink.get(key)}
    if clear_action:
        if not previous or cleared.intersection(sequence[:sequence.index(reset)]):
            raise ValidationError('The signature changed. Sign it again before saving.')
    elif cleared and not signed and not changed:
        # Older clients send the edited ink map without a signing action.
        reset = next(key for key in sequence if key in cleared)
    rollback_keys = set(sequence[sequence.index(reset):]) if reset else set()
    for key in active - action_keys - rollback_keys:
        evidence = [key, steps[key][0]]
        if key == 'reviewed_by':
            evidence.append('approval')
        if key == 'closed_by':
            evidence.extend(('completion', 'certification'))
        if any(prior['order'].get(field) != order.get(field) for field in evidence):
            raise ValidationError('Sign this section again or clear its signature to change its signing details.')
    if reset:
        return _clear_from(kind, reset, fields, previous['status'])
    for key in cleared:
        if any(ink.get(later) for later in sequence[sequence.index(key) + 1:]):
            raise ValidationError('Clear the later signatures before changing this signature.')

    # Older editors can save newly drawn ink without an action envelope. Check
    # their order and metadata too; ordinary saves of existing ink do not sign again.
    events = signed or [{'key': key, 'signature': ink[key], 'name': order.get(key, ''),
                         'date': order.get(steps[key][0], '')} for key in steps if key in changed]
    for item in events:
        key = item['key']
        date_key = steps[key][0]
        position = sequence.index(key)
        predecessors = sequence[:position]
        if legacy_details:
            predecessors = tuple(name for name in predecessors if name != 'details_by')
        if any(name not in active or not meaningful(order.get(name)) or not _valid_date(order.get(steps[name][0]))
               for name in predecessors):
            raise ValidationError('Sign the preceding sections first.')
        if 'reviewed_by' in predecessors and order.get('approval') != 'Approved':
            raise ValidationError('An approved review is required before signing this section.')
        if old_ink.get(key) and any(name in active for name in sequence[position + 1:]):
            raise ValidationError('Clear the later signatures before changing this signature.')
        if not meaningful(item['name']) or not _valid_date(item['date']):
            raise ValidationError('Enter the signer name and date before signing.')
        if ink.get(key) != item['signature'] or not _ink(ink.get(key)):
            raise ValidationError('The signature changed. Sign it again before saving.')
        if (order.get(key) != item['name'] or order.get(date_key) != item['date']
                or key == 'closed_by' and signed and
                (order['completion'] != item['completion'] or order['certification'] != item['certification'])):
            raise ValidationError('The signing details changed. Sign this section again.')
        target = _outcome(kind, key, order)
        active.add(key)
        if signed:
            status = target
            if key == 'closed_by' and target == 'In progress':
                for signer in CYCLE_SIGNERS:
                    ink.pop(signer, None)
                    order[signer] = order[steps[signer][0]] = ''
                    active.discard(signer)
    return status
