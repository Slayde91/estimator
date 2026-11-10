"""Stage readiness for explicit commercial writes; legacy snapshots stay loadable."""
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import unicodedata

from .catalog import ValidationError


def _entry(path, label, kind='text'):
    return {'path': path, 'label': label, 'type': kind}


DETAILS = [_entry('details.' + key, label) for key, label in (
    ('date', 'Document date'), ('project_no', 'Project number'), ('client', 'Client'),
    ('contact', 'Client contact'), ('site_address', 'Site address'),
    ('phone', 'Client phone'), ('email', 'Client email'))]
QUOTE = [*DETAILS, _entry('rate_schedule.introduction', 'Schedule of Rates introduction'),
         *[_entry('rate_schedule.rates.' + key, label, 'number') for key, label in (
             ('ordinary_time', 'Ordinary time'), ('time_and_half', 'Time and a half'),
             ('double_time', 'Double time'), ('site_remobilisation', 'Mobilisation'),
             ('equipment', 'Equipment'), ('materials', 'Materials'))],
         _entry('allowances', 'Allowances', 'rich'), _entry('terms', 'Terms & Conditions', 'rich')]
WORK = [*DETAILS, _entry('order.start_date', 'Proposed start date'),
        _entry('order.urgency', 'Category / urgency'),
        _entry('order.description', 'Description of works'),
        _entry('order.estimated_cost', 'Estimated cost (AUD)', 'number')]


def _signer(key, label, date_key, date_label):
    return [_entry('signatures.' + key, label, 'signature'),
            _entry('order.' + key, label + ' name'), _entry('order.' + date_key, date_label)]


WORK_STAGES = (
    ('Review', _signer('details_by', 'Work order details reviewed by', 'details_date', 'Details review date')),
    ('OHS Docs', [_entry('order.approval', 'Approval'),
                *_signer('reviewed_by', 'Reviewed by', 'review_date', 'Review date')]),
    ('Client Approval', _signer('prepared_by', 'Prepared by', 'prepared_date', 'Date')),
    ('In progress', _signer('client_approved_by', 'Approved by', 'client_approval_date', 'Approval date')),
    ('Claim', [_entry('order.quote_id', 'Linked Quote'),
                     _entry('work_tracking.completed_percent', '% completed', 'completed'),
                     *_signer('progress_by', 'Progress signed by', 'progress_date', 'Date')]),
    ('Certify', [_entry('work_tracking.claimed_percent', '% claimed', 'claimed'),
               *_signer('claimed_by', 'Claim signed by', 'claim_date', 'Date')]),
    ('Completed', [_entry('order.certification', 'Certification details'), _entry('order.completion', 'Completion'),
                 *_signer('closed_by', 'Closed by', 'closed_date', 'Date')]),
)


def entries(kind, status, operation='save'):
    if operation == 'save' and status == 'Draft':
        return []
    if kind == 'quote':
        return deepcopy(QUOTE)
    if kind != 'work_order':
        return []
    result = deepcopy(WORK)
    stage = status
    if stage in dict(WORK_STAGES):
        for current, additions in WORK_STAGES:
            result.extend(deepcopy(additions))
            if current == stage:
                break
    return result


def requirements(statuses):
    """Publish the same paths/labels that govern every explicit stage boundary."""
    return {operation: {kind: {status: entries(kind, status, operation) for status in values}
                        for kind, values in statuses.items()} for operation in ('save', 'issue')}


class _VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text = []

    def handle_data(self, value):
        self.text.append(value)


def meaningful(value, *, rich=False):
    if not isinstance(value, str):
        return False
    if rich:
        parser = _VisibleText()
        parser.feed(value)
        value = ''.join(parser.text)
    return bool(''.join(char for char in value if unicodedata.category(char) != 'Cf').strip())


def _value(fields, path):
    value = fields
    for part in path.split('.'):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _number(value, *, positive=False):
    if not meaningful(value):
        return False
    try:
        amount = Decimal(value)
        return amount.is_finite() and (amount > 0 if positive else amount >= 0)
    except InvalidOperation:
        return False


def _ink(value):
    from .swms import validate_signature
    try:
        signature = validate_signature(value)
    except ValidationError:
        return False
    return bool(signature and any(len({tuple(point) for point in stroke}) > 1 for stroke in signature['strokes']))


def missing(kind, status, fields, operation='save', *, legacy_details=False):
    absent = []
    for entry in entries(kind, status, operation):
        if legacy_details and entry['path'] in ('signatures.details_by','order.details_by','order.details_date'):
            continue
        value, item_type = _value(fields, entry['path']), entry['type']
        if item_type in ('completed', 'claimed'):
            rows = fields.get('work_tracking', {}).get('rows', [])
            key = item_type + '_percent'
            present = any(_number(row.get(key), positive=True) for row in rows)
        elif item_type == 'signature':
            present = _ink(value)
        elif item_type == 'number':
            present = _number(value)
        else:
            present = meaningful(value, rich=item_type == 'rich')
        if not present:
            absent.append(entry)
    return absent


def require_ready(kind, status, fields, operation='save', *, legacy_details=False):
    absent = missing(kind, status, fields, operation, legacy_details=legacy_details)
    if absent:
        label = {'quote': 'Quote', 'work_order': 'Work Order'}[kind]
        raise ValidationError('Complete required ' + label + ' fields: ' + ', '.join(entry['label'] for entry in absent) + '.')
