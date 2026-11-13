"""Ordered commercial signatures are validated inside the document save transaction."""
from copy import deepcopy
from datetime import date

from .catalog import ValidationError
from .commercial_requirements import WORK_STAGES, meaningful, missing, require_ready
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
PURCHASE_STAGE_ORDER = ('Draft', *(target for _, target in PURCHASE_STEPS.values()))
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


def require_purchase_rollback_clear(previous, target, proposed_fields=None):
    if previous['kind'] != 'purchase_order' or target not in PURCHASE_STAGE_ORDER:
        return
    reached = 'Reviewed' if previous['status'] == 'Cancelled' else previous['status']
    start = PURCHASE_STAGE_ORDER.index(target)
    if start >= PURCHASE_STAGE_ORDER.index(reached):
        return
    # Old orders may record a stage without ever having populated its sign-off sections.
    for fields in (previous['fields'], proposed_fields):
        if fields is None:
            continue
        for signer, (date_key, _) in tuple(PURCHASE_STEPS.items())[start:]:
            inputs = (signer, date_key, *SECTION_INPUTS['purchase_order'].get(signer, ()))
            if fields.get('signatures', {}).get(signer) or any(fields['order'].get(key) for key in inputs):
                raise ValidationError('Clear the relevant signature section before moving this Purchase Order back.')


def reconciled_status(status, fields, *, legacy_details=False):
    """Cap the recorded stage at the first incomplete sign-off, without signing or clearing anything."""
    if status == 'Draft' or status in ('On Hold', 'Cancelled'):
        return status
    absent = {entry['path'] for entry in missing('work_order', status, fields, legacy_details=legacy_details)}
    current = 'Draft'
    order = fields['order']
    by_stage = dict(WORK_STAGES)
    for signer, (date_key, target) in STEPS.items():
        if not (legacy_details and signer == 'details_by'):
            if any(field['path'] in absent for field in by_stage[target]) or not _valid_date(order.get(date_key)):
                return current
            if signer == 'reviewed_by' and order.get('approval') != 'Approved':
                return 'Cancelled' if order.get('approval') == 'Denied' else current
            if signer == 'closed_by':
                return _outcome('work_order', signer, order) if order.get('completion') in COMPLETIONS else current
        current = target
        if current == status:
            break
    return current


def apply(kind, fields, status, signed, previous, *, legacy_details=False, create_retry=False):
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
    elif kind == 'purchase_order' and cleared and signed:
        raise ValidationError('Clear the relevant signature section before moving this Purchase Order back.')
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
        restored = _clear_from(kind, reset, fields, previous['status'])
        return reconciled_status(restored, fields, legacy_details=legacy_details) if kind == 'work_order' else restored
    if previous and not create_retry and not signed:
        require_purchase_rollback_clear(previous, status, fields)
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
        if key == 'progress_by':
            from .work_order_tracking import has_completion
            if not has_completion(fields.get('work_tracking')):
                raise ValidationError('Record a completed percentage before signing work progress.')
        target = _outcome(kind, key, order)
        active.add(key)
        if signed:
            status = target
            if key == 'closed_by' and target == 'In progress':
                for signer in CYCLE_SIGNERS:
                    ink.pop(signer, None)
                    order[signer] = order[steps[signer][0]] = ''
                    active.discard(signer)
    if kind == 'work_order' and not signed:
        stages = ('Draft', *(target for _, target in steps.values()))
        if events and status != (previous['status'] if previous else 'Draft'):
            # An older editor can still submit a new signature and its outgoing stage together.
            require_ready(kind, status, fields, legacy_details=legacy_details)
        if previous and not create_retry and not events and status in stages:
            saved = previous['status']
            if saved not in stages or stages.index(saved) < stages.index(status):
                status = saved
        return reconciled_status(status, fields, legacy_details=legacy_details)
    return status
