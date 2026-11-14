"""Project-owned commercial drafts and atomic, replayable document numbers."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from hashlib import sha256
from html import escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sqlite3
import uuid

from . import record_activity
from .catalog import ValidationError
from .commercial_files import MAX_FILES, WorkOrderFiles, validate_files
from .document_numbers import DocumentNumbers, valid_reference, validated_counters
from .company_settings import DEFAULTS as COMPANY_DEFAULTS
from .evidence_files import _directory
from .commercial_requirements import require_ready, requirements
from .work_order_signing import QUOTE_SIGNERS, SECTION_INPUTS, reconciled_status, require_purchase_rollback_clear, validate_quote_signers

KINDS = {'quote': 'Quote', 'work_order': 'Work Order', 'purchase_order': 'Purchase Order'}
STATUSES = {
    'quote': ('Draft', 'Review', 'Presented', 'Accepted', 'Lost'),
    'work_order': ('Draft', 'Review', 'OHS Docs', 'Client Approval', 'In progress', 'Claim', 'Certify', 'Completed', 'On Hold', 'Cancelled'),
    'purchase_order': ('Draft', 'Requested', 'Reviewed', 'Sent', 'Completed', 'Cancelled'),
}
INTRODUCTION = ('We have the pleasure in providing you with the following quotation for our passive fire protection products and services, '
                'which will be supplied, installed and certified to comply with the National Construction Code and the relevant Australian '
                'Standards AS1530.4 and AS4072.1.')
DETAIL_FIELDS = ('project_no', 'client', 'site_address', 'contact', 'phone', 'email', 'date')
RECIPIENT_FIELDS = ('client', 'contact', 'phone', 'email')
RECIPIENT_DIRECTORY_FIELDS = ('account_id', 'contact_id', 'billing_address', 'abn_acn')
PROJECT_DETAIL_FIELDS = {'project_no':'project_no', 'client':'client', 'site_address':'site_address',
                        'contact':'contact_name', 'phone':'contact_phone', 'email':'contact_email'}
ORDER_FIELDS = ('start_date', 'end_date', 'urgency', 'quote_id', 'work_order_id', 'quote_reference', 'work_order_reference',
                'description', 'estimated_cost', 'attachments', 'review_date', 'approval', 'justification',
                'reviewed_by', 'swms', 'sds', 'sop', 'other_documents', 'prepared_by', 'client_approval',
                'client_approved_by', 'client_approval_date', 'progress', 'claim', 'certification', 'completion',
                'closed_by', 'supplier', 'supplier_email', 'supplier_contact', 'payment_terms', 'ship_to_name',
                'ship_to_address', 'delivery_date', 'expense_type', 'delivery_method', 'requested_by',
                'requested_date', 'sent_by', 'sent_date', 'verified_by', 'verified_date', 'verification', 'prepared_date')
FIELD_KEYS = {'title', 'details', 'introduction', 'lines', 'scope', 'scope_tables', 'sources', 'allowances', 'terms', 'order', 'company_reference'}
QUOTE_OPTIONAL_FIELDS = ('quoted_by', 'quoted_date')
WORK_ORDER_OPTIONAL_FIELDS = ('progress_by', 'progress_date', 'closed_date', 'claimed_by', 'claim_date', 'details_by', 'details_date')
PURCHASE_PARTY_LABELS = {'supplier_account_id':'supplier', 'supplier_contact_id':'supplier_contact', 'site_contact_id':'ship_to_name'}
PURCHASE_ORDER_OPTIONAL_DEFAULTS = ('site_contact_number', 'delivery_time', 'rejection_reason')
PURCHASE_ORDER_OPTIONAL_FIELDS = (*PURCHASE_ORDER_OPTIONAL_DEFAULTS, *PURCHASE_PARTY_LABELS)
WORK_ORDER_SIGNATURE_FIELDS = {'details_by', 'reviewed_by', 'prepared_by', 'client_approved_by', 'progress_by', 'closed_by', 'claimed_by'}
PURCHASE_ORDER_SIGNATURE_FIELDS = {'requested_by', 'reviewed_by', 'sent_by', 'verified_by'}
CERTIFICATION_CHOICES = ('Certification issued', 'Certification not issued')
COMPLETION_CHOICES = ('Completed', 'Ongoing', 'On hold', 'Not completed')
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_PDF_BYTES = 64 * 1024 * 1024
MAX_DOCUMENT_AMOUNT = 1_000_000_000
RATE_DEFAULTS = {'ordinary_time': '130', 'time_and_half': '160', 'double_time': '190',
                 'site_remobilisation': '1000', 'access_equipment_transport': '400',
                 'equipment': '20', 'materials': '20'}
PURCHASE_EXPENSE_TYPES = ('Labour', 'Materials', 'Services', 'Hire', 'Other')
PURCHASE_DELIVERY_METHODS = ('Delivery', 'Pickup')
PURCHASE_APPROVAL_CHOICES = ('Approved', 'Rejected')
DETAIL_OVERRIDE_KEYS = ('client', 'contact', 'phone', 'email', 'site_address')
RATE_INTRODUCTION = ('If additional work, or rectification work that is not the result of defective workmanship, '
                     'is directed by the client or their representatives, either verbally or in writing, the '
                     'following rates shall apply when calculating the value of such work:')


def default_rate_schedule():
    return {'introduction': RATE_INTRODUCTION, 'rates': dict(RATE_DEFAULTS),
            'acceptance': {key: '' for key in ('accepted_by', 'title', 'signature', 'date')}}


def project_document_details(value, *, with_recipient=False):
    """Copy bounded Project metadata, optionally seeding a new document's recipient."""
    from .quote_details import QUOTE_DETAIL_LIMITS, validate_quote_details
    if not isinstance(value, dict):
        raise ValidationError('Include valid Project details for this document.')
    details = validate_quote_details({key: value.get(key, '') for key in QUOTE_DETAIL_LIMITS})
    result = {document_key: details[project_key] for document_key, project_key in PROJECT_DETAIL_FIELDS.items()}
    if with_recipient:
        result.update({key: details[key] for key in RECIPIENT_DIRECTORY_FIELDS})
    return result


def detail_override_keys(value):
    """Explicit document-only edits never override the canonical Project number."""
    if (not isinstance(value, list) or len(value) > len(DETAIL_OVERRIDE_KEYS)
            or any(not isinstance(key, str) or key not in DETAIL_OVERRIDE_KEYS for key in value)
            or len(set(value)) != len(value)):
        raise ValidationError('Choose valid document detail overrides.')
    return [key for key in DETAIL_OVERRIDE_KEYS if key in value]


def apply_project_document_details(fields, details):
    overrides = detail_override_keys(fields.get('detail_overrides', []))
    # New recipient snapshots include directory IDs even when a field was
    # deliberately cleared. Older files may only identify individual overrides.
    keep = RECIPIENT_FIELDS if 'account_id' in fields['details'] else overrides
    fields['details'].update({key: value for key, value in details.items()
                              if key not in keep or key == 'site_address'})
    if 'account_id' not in fields['details'] and overrides:
        fields['detail_overrides'] = [key for key in overrides if key in RECIPIENT_FIELDS]
        return
    fields.pop('detail_overrides', None)


def validate_rate_schedule(value, *, allow_blank=False):
    if not isinstance(value, dict) or set(value) != {'introduction', 'rates', 'acceptance'}:
        raise ValidationError('Schedule of Rates uses an unsupported format.')
    if not isinstance(value['rates'], dict) or set(value['rates']) != set(RATE_DEFAULTS):
        raise ValidationError('Include each Schedule of Rates amount.')
    if not isinstance(value['acceptance'], dict) or set(value['acceptance']) != {'accepted_by', 'title', 'signature', 'date'}:
        raise ValidationError('Include the Schedule of Rates acceptance fields.')
    return {'introduction': _text(value['introduction'], 'Schedule of Rates introduction', 20000),
            'rates': {key: '' if allow_blank and amount == '' else _number(amount, 'Schedule of Rates amount')
                      for key, amount in value['rates'].items()},
            'acceptance': {key: _text(text, 'Acceptance', 1000) for key, text in value['acceptance'].items()}}


class CommercialConflict(ValidationError):
    pass


def _identity(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise ValidationError('Choose a valid commercial document identity.') from error
    return value


def _text(value, label, maximum=2000):
    if not isinstance(value, str) or len(value) > maximum or any(ord(char) < 32 and char not in '\n\r\t' or 0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValidationError(f'{label} must be text of at most {maximum} characters.')
    return value


def _number(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValidationError(f'{label} must be a number.')
    try:
        result = Decimal(str(value))
        if not result.is_finite() or not minimum <= result <= MAX_DOCUMENT_AMOUNT or result.as_tuple().exponent < -6:
            raise ValueError
    except (InvalidOperation, ValueError) as error:
        raise ValidationError(f'{label} must be between {minimum} and one billion with at most six decimal places.') from error
    return format(result, 'f')


class _RichText(HTMLParser):
    allowed = {'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag not in self.allowed or attrs:
            raise ValidationError('Rich text supports paragraphs, lists, bold, italic and underline only.')
        self.output.append('<br>' if tag == 'br' else '<' + tag + '>')
        if tag != 'br':
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag != 'br':
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == 'br':
            return
        if not self.stack or self.stack.pop() != tag:
            raise ValidationError('Rich text formatting is incomplete. Reapply the affected formatting.')
        self.output.append('</' + tag + '>')

    def handle_data(self, data):
        self.output.append(escape(data, quote=False))

    def handle_decl(self, decl):
        raise ValidationError('Rich text cannot contain document declarations.')


def validate_rich_text(value, label='Rich text'):
    parser = _RichText()
    parser.feed(_text(value, label, 120000))
    parser.close()
    if parser.stack:
        raise ValidationError('Rich text formatting is incomplete.')
    return ''.join(parser.output)


_TERMS_OPENING_PREFIX = 'These terms and conditions are between '
_TERMS_OPENING_SUFFIX = (', (we, us or our) and you, the person or entity stated in the Quote (you or your), '
                         'together the Parties and each a Party. Together, these terms and conditions and the Quote '
                         '(attached to these Terms or the Quote) form the entire agreement under which we will provide '
                         'the Goods and Services to you (Terms).')


def _is_terms_opening(text):
    """Recognise only the unchanged opening boilerplate, with a variable company."""
    plain = ' '.join(text.split())
    return (plain.startswith(_TERMS_OPENING_PREFIX) and plain.endswith(_TERMS_OPENING_SUFFIX)
            and len(plain) > len(_TERMS_OPENING_PREFIX) + len(_TERMS_OPENING_SUFFIX))


class _TermsFormatting(HTMLParser):
    """Emphasise clause labels and definition names without changing the wording."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.block = []
        self.bold_depth = 0
        self.definitions = False

    def flush(self):
        text = ''.join(value for kind, value, _ in self.block if kind == 'text')
        heading = re.match(r'^\s*\d+\.\s+(\w+)', text)
        if heading:
            self.definitions = heading[1] == 'Definitions'
        ranges = []
        if _is_terms_opening(text):
            ranges.append((0, len(text)))
        else:
            label = re.match(r'^\s*(\d+(?:\.\d+)*\.?)(?=\s)', text)
            if label:
                ranges.append(label.span(1))
            ranges.extend(match.span() for match in re.finditer(r'(?<!\S)\((?:[a-z]|\d+)\)(?=\s)', text))
            if self.definitions:
                ranges.extend(match.span(1) for match in re.finditer(
                    r'(?:^|(?<=\. ))([A-Z][A-Za-z ]+?) (?=means\b|has the meaning\b|refers to\b)', text))
        ranges.sort()
        offset = 0
        for kind, value, bold in self.block:
            if kind == 'markup':
                self.output.append(value)
                continue
            end = offset + len(value)
            position = 0
            for start, stop in ranges:
                if bold or stop <= offset or start >= end:
                    continue
                left, right = max(start - offset, 0), min(stop - offset, len(value))
                self.output.append(escape(value[position:left], quote=False))
                self.output.append('<b>' + escape(value[left:right], quote=False) + '</b>')
                position = right
            self.output.append(escape(value[position:], quote=False))
            offset = end
        self.block = []

    def handle_starttag(self, tag, attrs):
        if tag in {'p', 'div', 'li', 'br', 'ul', 'ol'}:
            self.flush()
        self.block.append(('markup', '<' + tag + '>', False))
        if tag in {'b', 'strong'}:
            self.bold_depth += 1

    def handle_endtag(self, tag):
        self.block.append(('markup', '</' + tag + '>', False))
        if tag in {'b', 'strong'}:
            self.bold_depth -= 1
        if tag in {'p', 'div', 'li', 'ul', 'ol'}:
            self.flush()

    def handle_data(self, data):
        self.block.append(('text', data, self.bold_depth > 0))


def format_terms(value):
    parser = _TermsFormatting()
    parser.feed(validate_rich_text(value, 'Terms and Conditions'))
    parser.close()
    parser.flush()
    return ''.join(parser.output)


def default_terms(company=None):
    company = company or COMPANY_DEFAULTS
    source = (Path(__file__).resolve().parent.parent / 'data' / 'commercial-quote-terms.txt').read_text(encoding='utf-8-sig')
    source = source.split('\nCeasefire Passive Fire Protection', 1)[0]
    source = source.replace('Ceasefire PFP Pty Ltd (ACN 612 231 562)', f"{company.get('name', '')} (ABN {company.get('abn', '')})")
    # PDF extraction wraps sentences. Keep clause boundaries and every source word.
    paragraphs = []
    for line in source.splitlines():
        line = line.strip()
        if not line:
            continue
        if (not paragraphs or paragraphs[-1] in {'TERMS OF TRADE', 'Our Disclosures:'}
                or re.fullmatch(r'\d+\. [A-Za-z /&]+', paragraphs[-1])
                or re.match(r'^(?:\d+\.|\([a-z]\)|TERMS OF TRADE|Our Disclosures:|subject to your|additional charges|[A-Z][A-Za-z ]+ (?:means|has the meaning|refers to))', line)):
            paragraphs.append(line)
        else:
            paragraphs[-1] += ' ' + line
    result = []
    for paragraph in paragraphs:
        text = escape(paragraph, quote=False)
        if paragraph in {'TERMS OF TRADE', 'Our Disclosures:'} or re.fullmatch(r'\d+\. [A-Za-z /&]+', paragraph):
            text = '<b>' + text + '</b>'
        result.append('<p>' + text + '</p>')
    return format_terms(''.join(result))


def default_fields(kind, details=None, company=None, *, rates=None):
    if kind not in KINDS:
        raise ValidationError('Choose Quote, Work Order or Purchase Order.')
    supplied = details or {}
    company = company or COMPANY_DEFAULTS
    schedule = default_rate_schedule()
    if rates is not None:
        schedule = validate_rate_schedule({**schedule, 'rates': rates})
    fields = {'title': KINDS[kind], 'details': {key: supplied.get(key, '') for key in DETAIL_FIELDS},
            'introduction': INTRODUCTION if kind == 'quote' else '', 'lines': [], 'scope': '',
            'scope_tables': [], 'sources': [], 'allowances': '<ul><li>N / A</li></ul>' if kind == 'quote' else '', 'terms': default_terms(company) if kind == 'quote' else '',
            'order': {key: '' for key in (*ORDER_FIELDS, *(WORK_ORDER_OPTIONAL_FIELDS if kind=='work_order' else PURCHASE_ORDER_OPTIONAL_DEFAULTS if kind=='purchase_order' else QUOTE_OPTIONAL_FIELDS if kind=='quote' else ()))},
            'rate_schedule': schedule,
            'company_reference': {key: company.get(key, '') for key in ('name', 'abn')}}
    if kind == 'purchase_order':
        fields['order']['ship_to_address'] = fields['details']['site_address']
    return fields


def validate_fields(value, *, kind=None):
    if not isinstance(value, dict) or set(value) - {'rate_schedule', 'notes', 'signatures', 'files', 'work_tracking', 'detail_overrides', 'billing', 'estimated_cost_cleared', 'excluded_quote_files'} != FIELD_KEYS:
        raise ValidationError('Commercial document fields use an unsupported format.')
    result = {'title': _text(value['title'], 'Title', 300)}
    if 'billing' in value:
        from .work_order_billing import normalized
        if kind not in ('work_order',None):
            raise ValidationError('Billing details belong to a Work Order.')
        billing = normalized(value['billing'])
        if billing:
            result['billing'] = billing
    if 'detail_overrides' in value:
        result['detail_overrides'] = detail_override_keys(value['detail_overrides'])
    result['rate_schedule'] = validate_rate_schedule(value.get('rate_schedule', default_rate_schedule()), allow_blank=True)
    files = validate_files(value.get('files', []))
    if files:
        if kind not in (*KINDS, None):
            raise ValidationError('Choose a supported commercial document for file attachments.')
        result['files'] = files
    from .swms import validate_signature
    signatures = value.get('signatures', {})
    signature_keys = (WORK_ORDER_SIGNATURE_FIELDS if kind == 'work_order' else
                      PURCHASE_ORDER_SIGNATURE_FIELDS if kind == 'purchase_order' else
                      QUOTE_SIGNERS.keys() if kind == 'quote' else
                      WORK_ORDER_SIGNATURE_FIELDS | PURCHASE_ORDER_SIGNATURE_FIELDS | QUOTE_SIGNERS.keys() if kind is None else set())
    if not isinstance(signatures, dict) or set(signatures) - signature_keys:
        raise ValidationError('Invalid commercial document signatures.')
    if signatures:
        result['signatures'] = {key: validate_signature(signature) for key, signature in signatures.items()}
    if 'work_tracking' in value:
        if kind not in ('work_order', None):
            raise ValidationError('Work tracking belongs to a Work Order.')
        from .work_order_tracking import validate
        result['work_tracking'] = validate(value['work_tracking'])
    notes = value.get('notes', [])
    if not isinstance(notes, list) or len(notes) > 200 or (notes and kind not in (*KINDS, None)):
        raise ValidationError('Commercial documents support up to 200 notes.')
    if notes:
        result['notes'] = []
        seen = set()
        for note in notes:
            if not isinstance(note, dict) or set(note) != {'id','title','body','author','updated_at'}:
                raise ValidationError('Invalid document note.')
            identity = _identity(note['id'])
            if identity in seen:
                raise ValidationError('A note ID must be unique.')
            seen.add(identity)
            title = _text(note['title'],'Note title',300).strip()
            if not title:
                raise ValidationError('Enter a title for the note.')
            result['notes'].append({'id': identity, 'title': title,
                                    'body': validate_rich_text(note['body'], 'Note text'),
                                    'author': _text(note['author'],'Note author',160),
                                    'updated_at': _text(note['updated_at'],'Note timestamp',60)})
    company = value['company_reference']
    if not isinstance(company, dict) or set(company) != {'name', 'abn'}:
        raise ValidationError('Commercial document company reference is invalid.')
    result['company_reference'] = {key: _text(company[key], 'Company reference', 120) for key in company}
    for key, keys in (('details', DETAIL_FIELDS), ('order', ORDER_FIELDS)):
        fields = value[key]
        optional = ((WORK_ORDER_OPTIONAL_FIELDS if kind=='work_order' else PURCHASE_ORDER_OPTIONAL_FIELDS if kind=='purchase_order'
                     else QUOTE_OPTIONAL_FIELDS if kind=='quote'
                     else (*WORK_ORDER_OPTIONAL_FIELDS,*PURCHASE_ORDER_OPTIONAL_FIELDS,*QUOTE_OPTIONAL_FIELDS) if kind is None else ()) if key=='order'
                    else RECIPIENT_DIRECTORY_FIELDS if kind in ('quote','work_order',None) else ())
        if not isinstance(fields, dict) or set(fields) - set(keys) - set(optional):
            raise ValidationError('Commercial document details contain unsupported fields.')
        result[key] = {name: _text(fields.get(name, ''), name, 6000 if key == 'order' else 1000) for name in keys}
        result[key].update({name:_text(fields[name], 'Site contact number' if name=='site_contact_number' else name,
                                      60 if name=='site_contact_number' else 1200 if name=='billing_address' else 1000) for name in optional if name in fields})
    for name in ('account_id', 'contact_id'):
        if result['details'].get(name):
            _identity(result['details'][name])
    delivery_time = result['order'].get('delivery_time', '')
    if delivery_time and not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', delivery_time):
        raise ValidationError('Use a delivery time in HH:MM format.')
    for name in ('quote_id', 'work_order_id', *PURCHASE_PARTY_LABELS):
        if result['order'].get(name):
            _identity(result['order'][name])
    result['introduction'] = _text(value['introduction'], 'Introduction', 20000)
    for key in ('scope', 'allowances', 'terms'):
        result[key] = validate_rich_text(value[key], key)
    lines = value['lines']
    if not isinstance(lines, list) or len(lines) > 500:
        raise ValidationError('A commercial document supports up to 500 summary items.')
    result['lines'] = []
    for line in lines:
        if not isinstance(line, dict) or set(line) - {'estimate_id', 'description', 'quantity', 'unit_price', 'size', 'comments'}:
            raise ValidationError('Summary items contain unsupported fields.')
        result['lines'].append({'estimate_id': _text(line.get('estimate_id', ''), 'Estimate identity', 100),
                                'description': _text(line.get('description', ''), 'Description', 6000),
                                'quantity': _number(line.get('quantity', '1'), 'Quantity'),
                                'unit_price': _number(line.get('unit_price', '0'), 'Unit price', -MAX_DOCUMENT_AMOUNT),
                                'size': _text(line.get('size', ''), 'Size', 1000),
                                'comments': _text(line.get('comments', ''), 'Comments', 2000)})
    tables = value['scope_tables']
    if not isinstance(tables, list) or len(tables) > 1000:
        raise ValidationError('Too many scope schedules.')
    result['scope_tables'] = []
    for table in tables:
        if not isinstance(table, dict) or set(table) != {'title', 'headers', 'rows'} or not isinstance(table['headers'], list) or not 1 <= len(table['headers']) <= 100 or not isinstance(table['rows'], list) or len(table['rows']) > 2000:
            raise ValidationError('Scope schedules contain invalid tables.')
        headers = [_text(text, 'Scope heading', 1000) for text in table['headers']]
        rows = []
        for row in table['rows']:
            if not isinstance(row, list) or len(row) != len(headers):
                raise ValidationError('Scope schedule rows must match their headers.')
            rows.append([_text(str(text), 'Scope value', 6000) for text in row])
        result['scope_tables'].append({'title': _text(table['title'], 'Scope title', 300), 'headers': headers, 'rows': rows})
    sources = value['sources']
    if not isinstance(sources, list) or len(sources) > 100:
        raise ValidationError('Too many linked estimate sources.')
    result['sources'] = []
    for source in sources:
        if not isinstance(source, dict) or set(source) != {'estimate_id', 'sha256'} or not re.fullmatch('[0-9a-f]{64}', source.get('sha256', '')):
            raise ValidationError('Linked estimate fingerprints are invalid.')
        result['sources'].append({'estimate_id': _text(source['estimate_id'], 'Estimate identity', 100), 'sha256': source['sha256']})
    if kind in ('work_order', 'purchase_order'):
        _normalise_legacy_reference(kind, result)
    if kind == 'quote':
        validate_quote_signers(result)
    if 'excluded_quote_files' in value:
        excluded = value['excluded_quote_files']
        if (kind not in ('work_order', None) or not isinstance(excluded, list) or len(excluded) > MAX_FILES
                or any(not isinstance(key, str) or not re.fullmatch('[a-f0-9]{64}', key) for key in excluded)):
            raise ValidationError('Invalid excluded Quote attachment.')
        if excluded:
            result['excluded_quote_files'] = sorted(set(excluded))
    if 'estimated_cost_cleared' in value:
        if kind not in ('work_order', None) or value['estimated_cost_cleared'] is not True:
            raise ValidationError('Invalid Work Order cost override.')
        if not result['order']['estimated_cost']:
            result['estimated_cost_cleared'] = True
    tracking = result.get('work_tracking')
    if tracking and (tracking['quote_id'],tracking['quote_reference']) != (result['order']['quote_id'],result['order']['quote_reference']):
        raise ValidationError("Work tracking must use this Work Order's linked issued Quote.")
    return result


def _work_order_prefix(project_no, quote_number):
    # Remove padding from each numeric component before joining the identifiers.
    parts = re.sub(r'[0-9]+', lambda match: match[0].lstrip('0') or '0', project_no + '-' + quote_number)
    return parts.replace('-', '') + '-'


def _normalise_legacy_reference(kind, fields):
    """Translate linked draft references on read without changing historic PDF bytes."""
    order = fields['order']
    if not order['quote_id' if kind == 'work_order' else 'work_order_id']:
        return
    legacy = re.fullmatch(r'(.+)-(Q-[0-9]{2,10})-([0-9]{2,10})', order['work_order_reference'])
    if not legacy:
        return
    project_no, quote_number, suffix = legacy.groups()
    if kind == 'work_order' and (project_no, quote_number) != (fields['details']['project_no'], order['quote_reference']):
        return
    order['work_order_reference'] = _work_order_prefix(project_no, quote_number) + suffix


def totals(fields):
    values = [(Decimal(line['quantity']) * Decimal(line['unit_price'])).quantize(Decimal('.01'), rounding=ROUND_HALF_UP) for line in fields['lines']]
    subtotal = sum(values, Decimal('0'))
    gst = (subtotal * Decimal('.10')).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    return {'lines': [str(value) for value in values], 'subtotal': str(subtotal), 'gst': str(gst), 'grand_total': str(subtotal + gst)}


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def _canonical_status(kind, status):
    if kind == 'purchase_order' and status == 'Verified':
        return 'Completed'
    if kind == 'work_order' and status == 'Canceled':
        return 'Cancelled'
    return status


def validate_commercial_documents(value):
    if value is None:
        return None
    required = {'version', 'project_id', 'documents', 'number_counters'}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {'work_order_counters','reference_counters','short_quote_counters'} or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('Commercial documents use an unsupported project format.')
    _identity(value['project_id'])
    counters = value['number_counters']
    if not isinstance(counters, dict) or set(counters) != set(KINDS) or any(type(number) is not int or not 0 <= number <= 9999999999 for number in counters.values()):
        raise ValidationError('Commercial document number counters are invalid.')
    work_order_counters = deepcopy(value.get('work_order_counters', {}))
    if (not isinstance(work_order_counters, dict) or len(work_order_counters) > 10000
            or any(not isinstance(label, str) or not re.fullmatch(r'Q-\d{2,10}', label)
                   or type(number) is not int or not 0 <= number <= 9999999999
                   for label, number in work_order_counters.items())):
        raise ValidationError('Work order number counters are invalid.')
    if not isinstance(value['documents'], list) or len(value['documents']) > 100:
        raise ValidationError('A project supports at most 100 commercial documents.')
    try:
        encoded = _json(value).encode('utf-8')
    except (TypeError, ValueError, UnicodeError) as error:
        raise ValidationError('Commercial document data contains invalid values.') from error
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise ValidationError('Commercial document drafts exceed the 8 MiB project limit.')
    documents = []
    identities = set()
    for document in value['documents']:
        if not isinstance(document, dict) or set(document) - {'reference'} != {'id', 'kind', 'version', 'status', 'fields', 'created_at', 'updated_at', 'last_number'}:
            raise ValidationError('A commercial document has unsupported fields.')
        identity = _identity(document['id'])
        if identity in identities:
            raise ValidationError('Commercial document identities must be unique.')
        identities.add(identity)
        status = _canonical_status(document['kind'], document['status'])
        if document['kind'] not in KINDS or status not in STATUSES[document['kind']] or type(document['version']) is not int or document['version'] < 1:
            raise ValidationError('Commercial document kind, status or version is invalid.')
        row = deepcopy(document)
        row['status'] = status
        row['fields'] = validate_fields(document['fields'], kind=row['kind'])
        if row['fields'].get('work_tracking', {}).get('project_id', value['project_id']) != value['project_id']:
            raise ValidationError('Work tracking belongs to a different project.')
        for key in ('created_at', 'updated_at', 'last_number'):
            row[key] = _text(row[key], key, 100)
        if row['last_number'] and not valid_reference(row['last_number']):
            raise ValidationError('The last commercial document number is invalid.')
        if 'reference' in row and not valid_reference(row['reference']):
            raise ValidationError('The saved document number is invalid.')
        if row.get('reference') and row['kind'] == 'work_order' and row['fields']['order']['work_order_reference'] != row['reference']:
            raise ValidationError('The work order reference differs from its assigned number.')
        if row['kind'] == 'work_order' and row['fields']['order']['quote_id'] and not row.get('reference'):
            quote_number, sequence = _work_order_sequence(row['fields'])
            work_order_counters[quote_number] = max(work_order_counters.get(quote_number, 0), sequence)
        documents.append(row)
    series = validated_counters(value.get('reference_counters', {}), KINDS)
    short_quotes = validated_counters({'quote': value.get('short_quote_counters', {})}, {'quote'})['quote']
    return {'version': 1, 'project_id': value['project_id'], 'documents': documents, **({'reference_counters':series} if series else {}),
            **({'short_quote_counters':short_quotes} if short_quotes else {}),
            'number_counters': deepcopy(counters), 'work_order_counters': work_order_counters}


def _work_order_sequence(fields):
    """Validate the saved reference without requiring a still-existing source Quote."""
    project_no = fields['details']['project_no']
    order = fields['order']
    quote_number = order['quote_reference']
    if not project_no.strip() or any(char in project_no for char in '\r\n\t') or not re.fullmatch(r'Q-\d{2,10}', quote_number):
        raise ValidationError('A work order requires a project number and an issued Quote number.')
    prefix = _work_order_prefix(project_no, quote_number)
    reference = order['work_order_reference']
    suffix = reference[len(prefix):] if reference.startswith(prefix) else ''
    if not re.fullmatch(r'\d{2,10}', suffix) or not 1 <= int(suffix) <= 9999999999 or suffix != f'{int(suffix):02d}':
        raise ValidationError('The work order reference does not match its project and Quote.')
    return quote_number, int(suffix)


def commercial_cards(snapshot, *, include_quote_files=False):
    """Index board fields without loading large scopes or editable document content."""
    if not snapshot:
        return []
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('documents'), list) or len(snapshot['documents']) > 100:
        raise ValidationError('Invalid saved commercial document collection.')
    cards = []
    for document in snapshot['documents']:
        try:
            kind = document['kind']
            status = _canonical_status(kind, document['status'])
            if kind not in KINDS or status not in STATUSES[kind] or type(document['version']) is not int or document['version'] < 1:
                raise ValidationError('Invalid saved commercial document status or version.')
            if kind == 'quote' and any(
                document.get(key) and not valid_reference(document[key]) for key in ('reference', 'last_number')
            ):
                raise ValidationError('Invalid saved Quote number.')
            fields = document['fields']
            details = {key: _text(fields['details'].get(key, ''), key, 1000) for key in ('project_no', 'client', 'site_address', 'contact', 'phone', 'email')}
            if kind in ('quote', 'work_order'):
                details.update({key: _text(fields['details'][key],key,1200) for key in RECIPIENT_DIRECTORY_FIELDS if key in fields['details']})
            order = {key: _text(fields['order'].get(key, ''), key, 6000) for key in
                     ('work_order_reference', 'quote_id', 'quote_reference', 'work_order_id', 'estimated_cost', 'supplier', 'supplier_contact')}
            if kind == 'purchase_order':
                order.update({key: _identity(fields['order'][key]) for key in PURCHASE_PARTY_LABELS if fields['order'].get(key)})
            if kind == 'work_order' and fields.get('billing'):
                from .work_order_billing import normalized, contact_id
                billing = normalized(fields['billing'])
                if billing.get('account_id'):
                    order['billing_account_id'] = billing['account_id']
                if contact_id(billing):
                    order['billing_contact_id'] = contact_id(billing)
            lines = fields['lines']
            if not isinstance(lines, list) or len(lines) > 2000:
                raise ValidationError('Invalid saved commercial lines.')
            if kind == 'work_order':
                grand_total = order['estimated_cost']
            else:
                amounts = [{'quantity': _number(line['quantity'], 'Quantity'), 'unit_price': _number(line['unit_price'], 'Unit price', -MAX_DOCUMENT_AMOUNT)} for line in lines]
                grand_total = totals({'lines': amounts})['grand_total']
            cards.append({'id': _identity(document['id']), 'project_id': snapshot['project_id'], 'kind': kind,
                          'version': document['version'], 'status': status, 'grand_total': grand_total,
                          'created_at': _text(document['created_at'], 'Creation date', 100),
                          'updated_at': _text(document['updated_at'], 'Last updated', 100),
                          'last_number': _text(document['last_number'], 'Document number', 100),
                          'reference': _text(document.get('reference', ''), 'Reference', 300),
                          'fields': {'title': _text(fields['title'], 'Document title', 300), 'order': order, 'details': details,
                                     **({'files': validate_files(fields['files'])} if include_quote_files and kind == 'quote' and fields.get('files') else {}),
                                     **({'estimated_cost_cleared': True} if fields.get('estimated_cost_cleared') is True else {}),
                                     **({'detail_overrides':detail_override_keys(fields['detail_overrides'])} if 'detail_overrides' in fields else {})}})
        except (TypeError, KeyError, AttributeError) as error:
            raise ValidationError('Invalid saved commercial document details.') from error
    return cards


def linked_estimate_ids(lines):
    if not isinstance(lines, list) or any(not isinstance(line, dict) or not isinstance(line.get('estimate_id', ''), str) for line in lines):
        raise ValidationError('Include valid linked estimates or custom quote rows.')
    return [line['estimate_id'] for line in lines if line.get('estimate_id')]


def _stored_document(value):
    document = json.loads(value)
    document['status'] = _canonical_status(document['kind'], document['status'])
    # Older drafts did not contain relationship identities. Normalise them on read
    # so opening an existing project does not require rewriting its saved data.
    document['fields'] = validate_fields(document['fields'], kind=document['kind'])
    return document


class CommercialDocuments:
    def __init__(self, certifications, root=None, renderer=None, *, validate_purchase_parties=None):
        self.certifications = certifications
        self.covers = getattr(getattr(certifications, 'legacy', None), 'covers', None)
        self.root = _directory(Path(root) if root else certifications.root.parent / 'commercial-documents', create=True)
        self.numbering = getattr(certifications, 'numbering', None) or DocumentNumbers(self.root.parent / 'document-numbers.sqlite3')
        self.path = self.root / 'documents.sqlite3'
        self.files = WorkOrderFiles(self.root / "files")
        self.renderer = renderer
        self.validate_purchase_parties = validate_purchase_parties
        self._validated_draft_sizes = {}
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS commercial_workspaces (workspace TEXT PRIMARY KEY, project_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_drafts (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id));
                CREATE TABLE IF NOT EXISTS commercial_sequences (kind TEXT PRIMARY KEY, number INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_work_order_sequences (project_id TEXT NOT NULL, quote_number TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY(project_id,quote_number));
                CREATE TABLE IF NOT EXISTS commercial_issued (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_id TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, number TEXT NOT NULL, filename TEXT NOT NULL, pdf BLOB NOT NULL, document TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS commercial_issued_document_number ON commercial_issued(project_id,document_id,number);
                CREATE TABLE IF NOT EXISTS commercial_audit (sequence INTEGER PRIMARY KEY, workspace TEXT NOT NULL, document_id TEXT NOT NULL, action TEXT NOT NULL, before_data TEXT, after_data TEXT, created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS commercial_audit_document ON commercial_audit(document_id,sequence);
                CREATE TABLE IF NOT EXISTS pending_quote_project_stages(workspace TEXT PRIMARY KEY, stage TEXT NOT NULL);
            ''')
            record_activity.schema(db)
            from .unfiled_commercial import UnfiledCommercial
            self.unfiled = UnfiledCommercial(self, db)
            self.numbering.attach(db)
            self.numbering.initialize_history(db)
            db.execute('BEGIN IMMEDIATE')
            counter = db.execute("SELECT number FROM commercial_sequences WHERE kind='quote'").fetchone()
            if counter:
                self.numbering.observe(db, 'quote', 'Q', counter[0])
            for kind, reference in db.execute("SELECT json_extract(document,'$.kind'),number FROM commercial_issued"):
                if valid_reference(reference):
                    self.numbering.observe_reference(db, kind, reference)
            # Old draft rows can exist in several sessions for the same portable project.
            legacy = []
            for workspace, project, raw in db.execute("SELECT d.workspace,w.project_id,d.data FROM commercial_drafts d "
                    "JOIN commercial_workspaces w ON w.workspace=d.workspace WHERE json_extract(d.data,'$.kind') IN ('work_order','purchase_order') "
                    "AND json_extract(d.data,'$.reference') IS NULL"):
                legacy.append((workspace, project, _stored_document(raw)))
            self._number_orders(db, [(project, doc) for _,project,doc in legacy])
            for workspace, _, doc in legacy:
                db.execute('UPDATE commercial_drafts SET data=? WHERE workspace=? AND id=?', (_json(doc),workspace,doc['id']))

    def _number_orders(self, db, entries):
        # Reserve imported explicit numbers first, then deterministically assign older orders.
        orders = sorted(((project, doc) for project, doc in entries if doc['kind'] in ('work_order','purchase_order')),
                        key=lambda pair: (not bool(pair[1].get('reference')), pair[1].get('created_at',''), pair[0], pair[1]['id']))
        for _, doc in orders:
            if doc.get('reference'):
                if not valid_reference(doc['reference']):
                    raise ValidationError('Invalid imported order number.')
                prefix, serial = doc['reference'].rsplit('-',1)
                self.numbering.observe(db,doc['kind'],prefix,int(serial))
        for project, doc in orders:
            doc['reference'] = self.numbering.assign(db, doc['kind'], project + ':' + doc['id'], doc.get('reference',''), reconcile=True)
            if doc['kind'] == 'work_order':
                doc['fields']['order']['work_order_reference'] = doc['reference']
        for project, doc in orders:
            order = doc['fields']['order']
            if doc['kind'] == 'purchase_order' and order.get('work_order_id'):
                related = db.execute("SELECT reference FROM numbook.assignments WHERE kind='work_order' AND owner=?",
                                     (project + ':' + order['work_order_id'],)).fetchone()
                if related:
                    order['work_order_reference'] = related[0]

    def issued_source_labels(self):
        # An issued receipt can identify a former project but never supplies its
        # editable documents. Only a present, validated project file does that.
        with self._connect() as db:
            rows = db.execute("""SELECT i.project_id,
                json_extract(i.document,'$.fields.details.project_no') AS number,
                json_extract(i.document,'$.fields.details.client') AS client
                FROM commercial_issued i JOIN
                    (SELECT project_id,MAX(rowid) AS last_row FROM commercial_issued GROUP BY project_id) latest
                ON i.rowid=latest.last_row""").fetchall()
        return [(r['project_id'], ' · '.join(s for s in (r['number'],r['client']) if s))
                for r in rows if r['number'] and r['number'].strip()]

    def _restore_quote_numbers(self, db, project, quote):
        if quote['last_number']:
            self.numbering.observe_reference(db, 'quote', quote['last_number'])
        if quote.get('reference'):
            # An independently copied project can contain the same document ID
            # and reference. Give its new owner a number while preserving its receipts.
            quote['reference'] = self.numbering.assign(db, 'quote', project + ':' + quote['id'],
                                                      quote['reference'], reconcile=True)

    def apply_register_numbers(self, cards):
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            self._number_orders(db, [(card['project_id'],card) for card in cards if card['kind'] in ('work_order','purchase_order')])
            # A linked project's issued quotes also reserve their numbers before
            # anyone opens that project on this computer.
            for card in cards:
                card['status'] = _canonical_status(card['kind'], card['status'])
                if card['kind'] == 'quote':
                    self._restore_quote_numbers(db, card['project_id'], card)
            # Old work orders can have no cost until opened. Display the issued
            # quote amount on their cards, using the same portable fallback as the editor.
            quotes = {(c['source_file'], c['id'], c['last_number']): c['grand_total']
                      for c in cards if c['kind'] == 'quote' and c.get('source_file') and c['last_number']}
            for card in cards:
                if (card['kind'] == 'work_order' and not card.get('grand_total') and card.get('source_file')
                        and not card['fields'].get('estimated_cost_cleared')):
                    order = card['fields']['order']
                    if order.get('quote_id') and order.get('quote_reference'):
                        amount = self._linked_quote_total(db, '', card['project_id'], order['quote_id'], order['quote_reference'])
                        card['grand_total'] = amount or quotes.get((card['source_file'], order['quote_id'], order['quote_reference']), '')

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _workspace(self, db, workspace):
        local_project = self.unfiled.verified_project(db, workspace)
        if local_project is not None:
            return local_project
        project = self.certifications.project_id(workspace)
        row = db.execute('SELECT project_id FROM commercial_workspaces WHERE workspace=?', (workspace,)).fetchone()
        if row is None:
            db.execute('INSERT OR IGNORE INTO commercial_workspaces VALUES (?,?)', (workspace, project))
            row = db.execute('SELECT project_id FROM commercial_workspaces WHERE workspace=?', (workspace,)).fetchone()
        elif not db.in_transaction:
            # Capture the drafts and their counters from one read transaction.
            # Existing workspaces need no write lock to load a document or board.
            db.execute('BEGIN')
        if row[0] != project:
            raise CommercialConflict('The commercial document workspace changed projects.')
        return project

    @staticmethod
    def _snapshot(db, workspace, project, documents=None):
        if documents is None:
            documents = [_stored_document(row[0]) for row in db.execute(
                'SELECT data FROM commercial_drafts WHERE workspace=? ORDER BY id', (workspace,))]
        counters = dict.fromkeys(KINDS, 0)
        counters.update(dict(db.execute('SELECT kind,number FROM commercial_sequences').fetchall()))
        work_order_counters = dict(db.execute('SELECT quote_number,number FROM commercial_work_order_sequences WHERE project_id=?', (project,)).fetchall())
        series = DocumentNumbers.history(db,project)
        short_quotes = DocumentNumbers.short_quote_history(db,project)
        return {'version': 1, 'project_id': project, 'documents': documents, **({'reference_counters': series} if series else {}),
                **({'short_quote_counters': short_quotes} if short_quotes else {}),
                'number_counters': counters, 'work_order_counters': work_order_counters}

    def capture(self, workspace, expected_snapshot=None):
        snapshot, _ = self.capture_project(workspace, expected_snapshot)
        return snapshot

    def capture_project(self, workspace, expected_snapshot=None):
        """Read the documents and their most recent unpublished Quote stage in one transaction."""
        with self._connect() as db:
            db.execute('BEGIN')
            project = self._workspace(db, workspace)
            snapshot = self._snapshot(db, workspace, project)
            pending = db.execute('SELECT stage FROM pending_quote_project_stages WHERE workspace=?', (workspace,)).fetchone()
        if expected_snapshot is not None and validate_commercial_documents(expected_snapshot) != snapshot:
            raise CommercialConflict('Commercial documents changed while the project was being saved. Refresh and save again.')
        return snapshot, pending[0] if pending else None

    def document_context(self, workspace, identity=None):
        """Resolve the workspace capability and the selected draft, if present."""
        with self._connect() as db:
            project = self._workspace(db, workspace)
            if not identity:
                return project, None
            row = db.execute('SELECT data FROM commercial_drafts WHERE workspace=? AND id=?',
                             (workspace, identity)).fetchone()
            return project, _stored_document(row[0]) if row is not None else None

    @staticmethod
    def _linked_quote_total(db, workspace, project, quote_id, quote_number):
        # The receipt fixes the price of this issue even when the draft changes.
        row = db.execute("SELECT json_extract(document,'$.fields.lines') FROM commercial_issued "
                         "WHERE project_id=? AND document_id=? AND number=?", (project, quote_id, quote_number)).fetchone()
        if row is None:
            # Portable projects may carry the quote draft without the original receipt.
            row = db.execute("SELECT json_extract(data,'$.fields.lines') FROM commercial_drafts "
                             "WHERE workspace=? AND id=? AND json_extract(data,'$.kind')='quote' "
                             "AND json_extract(data,'$.last_number')=?", (workspace, quote_id, quote_number)).fetchone()
        return totals({'lines': json.loads(row[0])})['grand_total'] if row is not None else ''

    @staticmethod
    def _quote_tracking(db, project, quote_id, reference, previous=None):
        from .work_order_tracking import template, baseline
        issued = db.execute('SELECT document FROM commercial_issued WHERE project_id=? AND document_id=? AND number=?',
                            (project, quote_id, reference)).fetchone()
        if issued is not None:
            document = _stored_document(issued[0])
            if document['kind'] != 'quote':
                return None
            return template(project, quote_id, reference, document['fields']['lines'])
        # A portable Work Order retains its original issued-row snapshot. Only
        # the server-owned previous record can supply this cold-cache baseline.
        stored = previous and previous['fields'].get('work_tracking')
        if stored and (stored['project_id'],stored['quote_id'],stored['quote_reference']) == (project,quote_id,reference):
            return baseline(stored)
        return None

    def _validate_tracking(self, db, project, fields, previous=None):
        from .work_order_tracking import baseline
        value = fields.get('work_tracking')
        if value is None:
            if previous and previous['fields'].get('work_tracking'):
                raise ValidationError('Reload this application before editing tracked work.')
            return
        order = fields['order']
        if (value['project_id'],value['quote_id'],value['quote_reference']) != (project,order['quote_id'],order['quote_reference']):
            raise ValidationError("Work tracking must use this Work Order's linked issued Quote.")
        expected = self._quote_tracking(db, project, order['quote_id'], order['quote_reference'], previous)
        if expected is None or baseline(value) != expected:
            raise ValidationError('The original issued Quote rows are unavailable or changed. Reopen this Work Order.')

    def view(self, workspace, *, include_quote_totals=False):
        with self._connect() as db:
            project = self._workspace(db, workspace)
            snapshot = self._snapshot(db, workspace, project)
            documents = snapshot['documents']
            result = {'workspace_id': workspace, 'project_id': project, 'documents': documents, 'snapshot': snapshot, 'statuses': STATUSES,
                      'requirements': requirements(STATUSES), 'signature_section_inputs': SECTION_INPUTS}
            if include_quote_totals:
                links = {(doc['id'], doc['last_number']) for doc in documents if doc['kind'] == 'quote' and doc['last_number']}
                for doc in documents:
                    order = doc['fields']['order']
                    if doc['kind'] == 'work_order' and order['quote_id']:
                        links.add((order['quote_id'], order['quote_reference']))
                result['quote_totals'] = {}
                result['quote_rows'] = {}
                for identity, number in sorted(links):
                    result['quote_totals'].setdefault(identity, {})[number] = self._linked_quote_total(db, workspace, project, identity, number)
                    tracking = self._quote_tracking(db, project, identity, number)
                    result['quote_rows'].setdefault(identity,{})[number] = tracking
            return result

    def restore(self, workspace, snapshot, *, return_view=True):
        snapshot = validate_commercial_documents(snapshot)
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            if snapshot is not None and snapshot['project_id'] != project:
                raise CommercialConflict('Commercial documents belong to a different project.')
            if snapshot:
                self.numbering.restore_history(db, project, snapshot.get('reference_counters',{}))
                self.numbering.restore_history(db, project, {'quote_short': snapshot.get('short_quote_counters', {})})
                self._number_orders(db, [(project,doc) for doc in snapshot['documents']])
                self.numbering.observe(db, 'quote', 'Q', snapshot['number_counters']['quote'])
                for doc in snapshot['documents']:
                    if doc['kind'] == 'quote':
                        self._restore_quote_numbers(db, project, doc)
            current = self._snapshot(db, workspace, project)
            if current['documents']:
                if snapshot != current:
                    raise CommercialConflict('This commercial workspace already has drafts. Reopen the project to restore another snapshot.')
            elif snapshot:
                for document in snapshot['documents']:
                    db.execute('INSERT INTO commercial_drafts VALUES(?,?,?)', (workspace, document['id'], _json(document)))
                    if document['last_number'] and (document['kind'] != 'quote' or document['last_number'].startswith('Q-')):
                        number = int(document['last_number'].rsplit('-', 1)[1])
                        db.execute('INSERT INTO commercial_sequences VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET number=max(number,excluded.number)', (document['kind'], number))
            if snapshot:
                for kind, number in snapshot['number_counters'].items():
                    db.execute('INSERT INTO commercial_sequences VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET number=max(number,excluded.number)', (kind, number))
                for quote_number, number in snapshot['work_order_counters'].items():
                    db.execute('INSERT INTO commercial_work_order_sequences VALUES(?,?,?) ON CONFLICT(project_id,quote_number) DO UPDATE SET number=max(number,excluded.number)', (project, quote_number, number))
        if return_view:
            return self.view(workspace)

    @staticmethod
    def _record(db, workspace, identity):
        _identity(identity)
        row = db.execute('SELECT data FROM commercial_drafts WHERE workspace=? AND id=?', (workspace, identity)).fetchone()
        if row is None:
            raise ValidationError('This commercial document is unavailable in the current project.')
        return _stored_document(row[0])

    @staticmethod
    def _version(previous, version):
        if type(version) is not int or previous['version'] != version:
            raise CommercialConflict('This commercial document changed. Reopen it before saving.')

    @staticmethod
    def _audit(db, workspace, identity, action, before=None, after=None):
        # A confirmed local edit supersedes a pending file image from before
        # a failed rename. Those stale bytes can no longer claim this document.
        db.execute('DELETE FROM local_commercial_publications WHERE workspace=?', (workspace,))
        db.execute('INSERT INTO commercial_audit(workspace,document_id,action,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)',
                   (workspace, identity, action, _json(before) if before else None, _json(after) if after else None, datetime.now(timezone.utc).isoformat()))
        if (action in ('save','status') and after['kind'] == 'quote'
                and after['status'] != (before['status'] if before else 'Draft')):
            from .project_file import validate_project_status
            db.execute('''INSERT INTO pending_quote_project_stages VALUES(?,?)
                ON CONFLICT(workspace) DO UPDATE SET stage=excluded.stage''',
                (workspace, validate_project_status(after['status'])))

    def _activity_source(self, db, workspace):
        bound = db.execute('SELECT source FROM commercial_activity_sources WHERE workspace=?', (workspace,)).fetchone()
        if bound:
            return bound[0]
        return 'workspace:' + workspace

    def activity(self, workspace, identity, *, entry=None, actor=None, staff=None, version=None):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE' if entry is not None else 'BEGIN')
            project = self._workspace(db, workspace)
            if not self.unfiled.permits_document(db, workspace, identity):
                raise ValidationError('This commercial document is unavailable in the current project.')
            doc = self._record(db, workspace, identity)
            if entry is not None:
                self._version(doc, version)
                return record_activity.append(db, self._activity_source(db,workspace), project+':'+doc['id'],
                                              entry, actor, staff, CommercialConflict)
            return self._document_activity(db, project, doc, self._activity_source(db,workspace))

    def saved_activity(self, snapshot, identity, source=None):
        identity = _identity(identity)
        document = next((row for row in (snapshot or {}).get('documents', []) if row['id'] == identity), None)
        if document is None:
            raise ValidationError('This commercial document is unavailable in the current project.')
        with self._connect() as db:
            return self._document_activity(db, snapshot['project_id'], document, source)

    @staticmethod
    def _document_activity(db, project, document, source=None):
        # Workspace IDs change on reopen. Save As copies may share both the
        # portable project ID and document ID. Follow only the exact before /
        # after snapshots leading to the selected version, including across
        # workspaces. Never expose an audit payload to the browser.
        expected = _json(document)
        events = record_activity.events(db, source, project+':'+document['id']) if source else []
        rows = db.execute("""
            SELECT a.action,a.created_at,a.before_data,a.after_data,s.created_at AS signed_at
            FROM commercial_audit a JOIN commercial_workspaces w ON w.workspace=a.workspace
            LEFT JOIN commercial_audit s ON s.sequence=a.sequence+1 AND s.action='signatures'
                AND s.workspace=a.workspace AND s.document_id=a.document_id
            WHERE a.document_id=? AND w.project_id=? AND a.action IN ('save','status','issue')
            ORDER BY a.sequence DESC""", (document['id'], project))
        for row in rows:
            if row['after_data'] != expected:
                continue
            before = json.loads(row['before_data']) if row['before_data'] else None
            after = json.loads(expected)
            transition = before and before['status'] != after['status']
            label = ('PDF issued' if row['action'] == 'issue' else 'Stage changed' if transition
                     else 'Updated' if before else 'Created')
            if row['signed_at']:
                events.append({'label':'Signatures updated', 'at':row['signed_at']})
            event = {'label':label, 'at':row['created_at']}
            if transition:
                event.update(previous_status=before['status'], status=after['status'])
            if row['action'] == 'issue':
                event['subject'] = after['last_number']
            events.append(event)
            expected = row['before_data']
            if not expected:
                break
        # Imported or older portable records can predate this machine's log.
        if expected:
            earliest = json.loads(expected)
            if earliest['updated_at'] and earliest['updated_at'] != earliest['created_at']:
                events.append({'label':'Updated', 'at':earliest['updated_at']})
            if earliest['created_at']:
                events.append({'label':'Created', 'at':earliest['created_at']})
        return {'events':events}

    def purchase_order_defaults(self, workspace, work_order_id, version, *, company=None, rates=None):
        """Prepare a linked draft from a saved Work Order without saving or numbering it."""
        with self._connect() as db:
            self._workspace(db, workspace)
            work_order = self._record(db, workspace, _identity(work_order_id))
            self._version(work_order, version)
            if work_order['kind'] != 'work_order':
                raise ValidationError('Select a saved Work Order from this project.')
            reference = work_order['fields']['order']['work_order_reference']
            if not reference:
                raise ValidationError('Save this Work Order before creating a Purchase Order.')
            fields = default_fields('purchase_order', work_order['fields']['details'], company, rates=rates)
            fields['order'].update(work_order_id=work_order['id'], work_order_reference=reference)
            # A customer's sale price is not a supplier purchase price. Carry
            # procurement descriptions/quantities forward, leaving prices for entry.
            fields['lines'] = [{**deepcopy(line), 'estimate_id': '', 'unit_price': '0'}
                               for line in work_order['fields']['lines']]
            return fields

    def _purchase_parties(self, order, prior):
        # Older clients can omit optional IDs. Keep them only if their associated
        # labels still match. A supplier change also invalidates the old contact.
        prior = prior or {}
        for key, label in PURCHASE_PARTY_LABELS.items():
            if key in order or key not in prior or order[label] != prior[label]:
                continue
            if key == 'supplier_contact_id' and (order['supplier'] != prior['supplier']
                    or order.get('supplier_account_id') != prior.get('supplier_account_id')):
                continue
            order[key] = prior[key]
        changed = {key for key, label in PURCHASE_PARTY_LABELS.items() if order.get(key)
                   and (order[key] != prior.get(key) or order[label] != prior.get(label))}
        if order.get('supplier_contact_id') and order.get('supplier_account_id') != prior.get('supplier_account_id'):
            changed.add('supplier_contact_id')
        if changed:
            if self.validate_purchase_parties is None:
                raise ValidationError('The contact directory is unavailable. Reopen the purchase order.')
            self.validate_purchase_parties(order, changed)
        # An explicit empty ID clears a previous link. Once resolved, an
        # unlinked party uses the same saved format as a manually entered PO.
        for key in PURCHASE_PARTY_LABELS:
            if not order.get(key):
                order.pop(key, None)

    def _validate_recipient(self, details, prior):
        # Use the same directory and membership checks as a purchase order.
        # A saved recipient keeps its historical name when reopened.
        changed = set()
        if details.get('account_id') and any(details.get(k) != prior.get(k) for k in ('account_id', 'client')):
            changed.add('supplier_account_id')
        if details.get('contact_id') and any(details.get(k) != prior.get(k) for k in ('account_id', 'contact_id', 'contact')):
            changed.add('supplier_contact_id')
        if changed:
            if self.validate_purchase_parties is None:
                raise ValidationError('The contact directory is unavailable. Reopen the document.')
            self.validate_purchase_parties({'supplier_account_id':details.get('account_id',''), 'supplier':details['client'],
                                            'supplier_contact_id':details.get('contact_id',''), 'supplier_contact':details['contact']}, changed)

    def _relationships(self, db, workspace, project, kind, fields, previous, *, create_retry=False):
        order = fields['order']
        prior = previous['fields']['order'] if previous else None
        if kind == 'quote' or kind == 'work_order' and previous:
            self._validate_recipient(fields['details'], previous['fields']['details'] if previous else {})
        if kind == 'work_order':
            if order['work_order_id']:
                raise ValidationError('A work order cannot link to another work order.')
            project_no = fields['details']['project_no']
            if any(char in project_no for char in '\r\n\t'):
                raise ValidationError('Enter a valid project number.')
            fields['details']['project_no'] = project_no.strip()
            prior_ref = prior['work_order_reference'] if prior else ''
            if order['work_order_reference'] != prior_ref and not (create_retry and not order['work_order_reference']):
                raise ValidationError('Work order and Quote references are assigned automatically and cannot be edited.')
            order['work_order_reference'] = prior_ref
            if previous:
                bound_no = previous['fields']['details']['project_no']
                if bound_no and bound_no != fields['details']['project_no']:
                    if create_retry and not fields['details']['project_no']:
                        fields['details']['project_no'] = bound_no
                    else:
                        raise ValidationError('The project number cannot change after a work order reference is assigned.')
                if prior['quote_id']:
                    if order['quote_id'] != prior['quote_id']:
                        raise ValidationError('The linked Quote cannot change after a work order is created.')
                    if order['quote_reference'] != prior['quote_reference'] and not (create_retry and not order['quote_reference']):
                        raise ValidationError('Work order and Quote references are assigned automatically and cannot be edited.')
                    order['quote_reference'] = prior['quote_reference']
                    if create_retry and not order['estimated_cost']:
                        order['estimated_cost'] = prior['estimated_cost']
                    elif not prior['estimated_cost'] and not order['estimated_cost'] and not fields.get('estimated_cost_cleared'):
                        order['estimated_cost'] = self._linked_quote_total(db, workspace, project, order['quote_id'], order['quote_reference'])
                    return
            if not order['quote_id']:
                if order['quote_reference'] != (prior['quote_reference'] if prior else ''):
                    raise ValidationError('Select an issued Quote to set its reference automatically.')
                if not previous:
                    self._validate_recipient(fields['details'], {})
                return
            if not self.unfiled.permits_document(db, workspace, order['quote_id']):
                raise ValidationError('Choose a saved Quote from this project.')
            quote = self._record(db, workspace, order['quote_id'])
            if quote['kind'] != 'quote' or not quote['last_number']:
                raise ValidationError('Download the linked Quote PDF before creating a work order.')
            recipient = quote['fields']['details']
            if previous and previous['fields']['details']['project_no'] and recipient['project_no'] and fields['details']['project_no'] != recipient['project_no']:
                raise ValidationError('Choose an issued Quote from this Project.')
            if ('account_id' not in fields['details'] and not fields.get('detail_overrides')
                    and 'account_id' in recipient):
                fields['details'].update({key: recipient.get(key, '') for key in (*RECIPIENT_FIELDS, *RECIPIENT_DIRECTORY_FIELDS)})
            self._validate_recipient(fields['details'], recipient)
            if not fields['details']['project_no']:
                if any(char in recipient['project_no'] for char in '\r\n\t'):
                    raise ValidationError('Enter a valid project number.')
                fields['details']['project_no'] = recipient['project_no'].strip()
            quote_number = quote['last_number']
            if order['quote_reference'] not in ('', quote_number):
                raise ValidationError('Work order references are assigned automatically when first saved.')
            order['quote_reference'] = quote_number
            if not order['estimated_cost'] and not fields.get('estimated_cost_cleared'):
                order['estimated_cost'] = self._linked_quote_total(db, workspace, project, quote['id'], quote_number)
        elif kind == 'purchase_order':
            self._purchase_parties(order, prior)
            approval = order['approval']
            if approval and approval not in PURCHASE_APPROVAL_CHOICES and (not prior or approval != prior['approval']):
                raise ValidationError('Choose Approved or Rejected for the purchase order approval.')
            method = order['delivery_method']
            if method and method not in PURCHASE_DELIVERY_METHODS and (not prior or method != prior['delivery_method']):
                raise ValidationError('Choose Delivery or Pickup for the delivery method.')
            expense = order['expense_type']
            if expense and expense not in PURCHASE_EXPENSE_TYPES and (not prior or expense != prior['expense_type']):
                raise ValidationError('Choose Labour, Materials, Services, Hire or Other for the type of expense.')
            work_order_id = order['work_order_id']
            if not work_order_id:
                # Preserve historical unlinked references, but never allow a new
                # manually entered reference to impersonate a linked work order.
                allowed = prior['work_order_reference'] if prior and not prior['work_order_id'] else ''
                if order['work_order_reference'] not in ('', allowed):
                    raise ValidationError('Select a work order to set its reference automatically.')
                return
            try:
                work_order = self._record(db, workspace, work_order_id)
            except ValidationError:
                if not prior or work_order_id != prior['work_order_id']:
                    raise
                # Deleting a source draft does not erase the historical PO link.
                reference = prior['work_order_reference']
            else:
                if work_order['kind'] != 'work_order':
                    raise ValidationError('Select a work order from this project.')
                reference = work_order['fields']['order']['work_order_reference'] or work_order['last_number']
                if not reference:
                    raise ValidationError('The selected work order does not yet have a reference.')
            if order['work_order_reference'] not in ('', reference):
                raise ValidationError('The linked work order reference is automatic and cannot be edited.')
            order['work_order_reference'] = reference

    def _inherit_quote_files(self, db, workspace, fields, previous=None):
        quote_id = fields['order']['quote_id']
        if not quote_id or not self.unfiled.permits_document(db, workspace, quote_id):
            return
        row = db.execute("""SELECT json_extract(data, '$.fields.files') FROM commercial_drafts
                            WHERE workspace=? AND id=? AND json_extract(data, '$.kind')='quote'""",
                         (workspace, quote_id)).fetchone()
        if not row or not row[0]:
            return
        source = validate_files(json.loads(row[0]))
        source_ids = {item['id'] for item in source}
        attached = fields.get('files', [])
        attached_ids = {item['id'] for item in attached}
        excluded = set(fields.get('excluded_quote_files', []))
        if previous and previous['fields']['order']['quote_id'] == quote_id:
            old = previous['fields']
            excluded.update(old.get('excluded_quote_files', []))
            excluded.update(item['id'] for item in old.get('files', []) if item['id'] not in attached_ids)
        excluded = (excluded & source_ids) - attached_ids
        if excluded:
            fields['excluded_quote_files'] = sorted(excluded)
        else:
            fields.pop('excluded_quote_files', None)
        retained_ids = attached_ids | excluded
        combined = attached + [item for item in source if item['id'] not in retained_ids]
        if combined:
            fields['files'] = validate_files(combined)

    def read_attachment(self, workspace, document_id, file_id):
        with self._connect() as db:
            project = self._workspace(db, workspace)
            document = self._record(db, workspace, document_id)
            if document['kind'] not in KINDS:
                raise ValidationError('Choose an attachment from this document.')
            item = next((item for item in document['fields'].get('files', []) if item['id'] == file_id), None)
            if item is None:
                raise ValidationError('Attachment not found on this document.')
            return item, self.files.read(project, item)

    def _validate_draft_save(self, db, workspace, project, document):
        """Enforce the portable collection limits while holding the same write transaction as the save."""
        snapshot = self._snapshot(db, workspace, project, [document])
        validate_commercial_documents(snapshot)
        size = len(_json(snapshot).encode('utf-8'))
        rows = db.execute('SELECT id,CAST(data AS BLOB) FROM commercial_drafts WHERE workspace=? AND id<>?',
                          (workspace, document['id']))
        for count, (identity, raw) in enumerate(rows, start=2):
            if count > 100:
                raise ValidationError('A project supports at most 100 commercial documents.')
            key = (project, identity, sha256(raw).digest())
            length = self._validated_draft_sizes.get(key)
            if length is None:
                # Historical drafts gain default fields when read. Count the normalized
                # UTF-8 bytes, including for old files, and never cache the document itself.
                stored = _stored_document(raw)
                if stored['id'] != identity:
                    raise ValidationError('Commercial document identities must be unique.')
                validate_commercial_documents({**snapshot, 'documents': [stored]})
                length = len(_json(stored).encode('utf-8'))
                if len(self._validated_draft_sizes) >= 2048:
                    self._validated_draft_sizes.clear()
                self._validated_draft_sizes[key] = length
            size += 1 + length  # Serialized comma between documents.
            if size > MAX_SNAPSHOT_BYTES:
                raise ValidationError('Commercial document drafts exceed the 8 MiB project limit.')

    def save(self, workspace, payload, *, unfiled_context=None, linked_quote_transition=None):
        if not isinstance(payload, dict) or set(payload) - {'id', 'version', 'kind', 'status', 'fields', 'signature_actions'}:
            raise ValidationError('Commercial document save contains unsupported fields.')
        kind = payload.get('kind')
        status = _canonical_status(kind, payload.get('status'))
        if kind not in KINDS or status not in STATUSES[kind]:
            raise ValidationError('Choose a valid commercial document status.')
        fields = validate_fields(payload.get('fields'), kind=kind)
        from .work_order_signing import actions, apply as apply_signing
        signed = actions(payload.get('signature_actions', []), kind)
        transition = None
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            previous = None
            if payload.get('id'):
                _identity(payload['id'])
                row = db.execute('SELECT data FROM commercial_drafts WHERE workspace=? AND id=?', (workspace, payload['id'])).fetchone()
                previous = _stored_document(row[0]) if row else None
                if previous is None and payload.get('version') != 0:
                    raise CommercialConflict('This document is unavailable. Reopen the project.')
                if previous is None and db.execute('SELECT 1 FROM commercial_audit WHERE workspace=? AND document_id=? LIMIT 1', (workspace, payload['id'])).fetchone():
                    raise CommercialConflict('This document was deleted. Create a new document instead of retrying its original save.')
            if previous:
                if previous['kind'] != kind:
                    raise ValidationError('A commercial document cannot change its kind.')
                if payload.get('version') != 0:
                    self._version(previous, payload.get('version'))
                if kind == 'work_order' and 'files' not in payload['fields'] and previous['fields'].get('files'):
                    fields['files'] = deepcopy(previous['fields']['files'])
                if kind == 'work_order' and not fields['order']['estimated_cost']:
                    explicitly_cleared = (payload.get('version') != 0 and 'estimated_cost' in payload['fields']['order']
                                          and previous['fields']['order']['estimated_cost'])
                    if explicitly_cleared or previous['fields'].get('estimated_cost_cleared'):
                        fields['estimated_cost_cleared'] = True
                if kind in ('work_order', 'purchase_order') and 'signatures' not in payload['fields'] and previous['fields'].get('signatures'):
                    fields['signatures'] = deepcopy(previous['fields']['signatures'])
                # Older open windows omit new editable fields. Preserve them
                # unless the current client deliberately sends an empty clear.
                if kind=='purchase_order':
                    for key in PURCHASE_ORDER_OPTIONAL_DEFAULTS:
                        if key not in fields['order'] and key in previous['fields']['order']:
                            fields['order'][key]=previous['fields']['order'][key]
                if kind=='work_order' and not any(key in payload['fields']['order'] for key in ('claimed_by','claim_date')):
                    for key in ('claimed_by','claim_date'):
                        if key in previous['fields']['order']:
                            fields['order'][key]=previous['fields']['order'][key]
                    if previous['fields'].get('signatures',{}).get('claimed_by'):
                        fields.setdefault('signatures',{})['claimed_by']=deepcopy(previous['fields']['signatures']['claimed_by'])
                if kind=='work_order' and 'billing' not in payload['fields'] and previous['fields'].get('billing'):
                    fields['billing'] = deepcopy(previous['fields']['billing'])
                if kind=='work_order' and not any(key in payload['fields']['order'] for key in ('details_by','details_date')):
                    for key in ('details_by','details_date'):
                        if key in previous['fields']['order']:
                            fields['order'][key]=previous['fields']['order'][key]
                    if previous['fields'].get('signatures',{}).get('details_by'):
                        fields.setdefault('signatures',{})['details_by']=deepcopy(previous['fields']['signatures']['details_by'])
                if kind=='work_order' and fields.get('work_tracking') and previous['fields'].get('work_tracking'):
                    previous_rows={row['line_id']:row for row in previous['fields']['work_tracking']['rows']}
                    for raw, row in zip(payload['fields']['work_tracking']['rows'],fields['work_tracking']['rows']):
                        if 'notes' not in raw and row['line_id'] in previous_rows:
                            row['notes']=previous_rows[row['line_id']].get('notes','')
            self._relationships(db, workspace, project, kind, fields, previous, create_retry=payload.get('version') == 0)
            if kind == 'work_order':
                self._inherit_quote_files(db, workspace, fields, previous if payload.get('version') else None)
            for item in fields.get('files', []):
                self.files.read(project, item)
            legacy_details = (kind=='work_order' and previous is not None
                              and not any(key in previous['fields']['order'] for key in ('details_by','details_date'))
                              and not any(item['key']=='details_by' for item in signed))
            if kind=='work_order' and previous is None:
                for key in ('details_by','details_date'):
                    fields['order'].setdefault(key,'')
            if kind=='work_order':
                for key, choices in (('certification',CERTIFICATION_CHOICES),('completion',COMPLETION_CHOICES)):
                    if fields['order'][key] and fields['order'][key] not in choices and (previous is None or fields['order'][key]!=previous['fields']['order'][key]):
                        raise ValidationError('Choose a listed certification or completion status.')
                self._validate_tracking(db, project, fields, previous)
            status = apply_signing(kind, fields, status, signed, previous, legacy_details=legacy_details,
                                   create_retry=payload.get('version') == 0)
            if payload.get('version') == 0 and previous:
                if previous['fields'] == fields and previous['status'] == status:
                    if unfiled_context is not None:
                        self.unfiled.enroll(db, workspace, previous['id'], unfiled_context)
                    return previous
                raise CommercialConflict('This new document was already saved with different content. Reopen it before editing.')
            withdrawing_ink = bool(signed and signed[0].get('clear') and previous
                                   and previous['fields'].get('signatures', {}).get(signed[0]['key']))
            if (kind != 'work_order' or signed and not signed[0].get('clear')) and not (kind == 'quote' and withdrawing_ink):
                require_ready(kind, status, fields, legacy_details=legacy_details)
            now = datetime.now(timezone.utc).isoformat()
            document = {'id': previous['id'] if previous else payload.get('id') or str(uuid.uuid4()), 'kind': kind,
                        'version': previous['version'] + 1 if previous else 1, 'status': status, 'fields': fields,
                        'created_at': previous['created_at'] if previous else now, 'updated_at': now,
                        'last_number': previous['last_number'] if previous else ''}
            # Older issued Quotes have immutable issue numbers but no separate draft reference.
            prior_reference = (previous or {}).get('reference', '')
            if kind != 'quote' or not document['last_number'] or prior_reference:
                document['reference'] = self.numbering.assign(db, kind, project + ':' + document['id'], prior_reference)
                if kind == 'work_order':
                    fields['order']['work_order_reference'] = document['reference']
            if kind == 'work_order' and signed and signed[0]['key'] == 'details_by':
                cleared = signed[0].get('clear', False)
                if not cleared or withdrawing_ink:
                    transition = self._set_linked_quote_status(db, workspace, project, fields['order']['quote_id'],
                                                               'Presented' if cleared else 'Accepted')
            self._validate_draft_save(db, workspace, project, document)
            db.execute('INSERT INTO commercial_drafts VALUES(?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET data=excluded.data', (workspace, document['id'], _json(document)))
            self._audit(db, workspace, document['id'], 'save', previous, document)
            if signed:
                self._audit(db, workspace, document['id'], 'signatures', None,
                            {'document_version':document['version'], 'actions':signed, 'status':status})
            if unfiled_context is not None:
                self.unfiled.enroll(db, workspace, document['id'], unfiled_context)
        if linked_quote_transition is not None and transition:
            linked_quote_transition.update(transition)
        return document

    @contextmanager
    def publishing(self, workspace, snapshot, project_status=None, *, path=None):
        """Exclude concurrent board writes across processes during the atomic file takeover."""
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT filed FROM local_commercial_owners WHERE workspace=?', (workspace,)).fetchone()
            pending = db.execute('SELECT stage FROM pending_quote_project_stages WHERE workspace=?', (workspace,)).fetchone()
            if pending and pending[0] != project_status:
                raise CommercialConflict('Commercial documents changed during this project save. Save the project again.')
            # A second writer can finish publishing between capture and this
            # lock, consuming the pending stage. Verify the documents even
            # when the stage has already been consumed by another publisher.
            if snapshot is not None:
                matches = self._snapshot(db, workspace, self.certifications.project_id(workspace))['documents'] == snapshot['documents']
            else:
                matches = not pending and not (row and not row['filed'])
            if not matches:
                raise CommercialConflict('Commercial documents changed during this project save. Save the project again.')
            yield
            db.execute('DELETE FROM pending_quote_project_stages WHERE workspace=?', (workspace,))
            self.unfiled.bind_file(db, workspace, path)


    def delete(self, workspace, identity, version):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._workspace(db, workspace)
            previous = self._record(db, workspace, identity)
            self._version(previous, version)
            db.execute('DELETE FROM commercial_drafts WHERE workspace=? AND id=?', (workspace, identity))
            self._audit(db, workspace, identity, 'delete', previous)
        return {'deleted': True}

    def _set_linked_quote_status(self, db, workspace, project, quote_id, status):
        if not quote_id or not self.unfiled.permits_document(db, workspace, quote_id):
            return
        # A historical Work Order can retain the reference of a deleted Quote.
        # Never resolve that reference against a different file or workspace.
        row = db.execute("""SELECT data FROM commercial_drafts WHERE workspace=? AND id=?
                            AND json_extract(data, '$.kind')='quote'""", (workspace, quote_id)).fetchone()
        if row:
            quote = _stored_document(row[0])
            if quote['status'] != status:
                self._set_status(db, workspace, project, quote, status, withdrawing_signature=(status == 'Presented'))
                return {'id': quote_id, 'previous_status': quote['status'], 'status': status}

    def status(self, workspace, identity, version, status):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            previous = self._record(db, workspace, identity)
            self._version(previous, version)
            status = _canonical_status(previous['kind'], status)
            if status not in STATUSES[previous['kind']]:
                raise ValidationError('Choose a valid document status.')
            return self._set_status(db, workspace, project, previous, status)

    def _set_status(self, db, workspace, project, previous, status, *, withdrawing_signature=False):
        require_purchase_rollback_clear(previous, status)
        document = deepcopy(previous)
        if document['kind'] == 'work_order' and status != 'Draft':
            self._relationships(db, workspace, project, document['kind'], document['fields'], previous)
            self._validate_tracking(db, project, document['fields'], previous)
        if not withdrawing_signature:
            require_ready(document['kind'], status, document['fields'],
                          legacy_details=document['kind']=='work_order' and not any(key in document['fields']['order'] for key in ('details_by','details_date')))
        document.update(status=status, version=previous['version'] + 1, updated_at=datetime.now(timezone.utc).isoformat())
        db.execute('UPDATE commercial_drafts SET data=? WHERE workspace=? AND id=?', (_json(document), workspace, document['id']))
        self._audit(db, workspace, document['id'], 'status', previous, document)
        return document

    @staticmethod
    def _signature(workspace, identity, version, company, request_fingerprint):
        return sha256(_json({'workspace': workspace, 'id': identity, 'version': version, 'company': company,
                             'request_fingerprint': request_fingerprint}).encode('utf-8')).hexdigest()

    def replay(self, workspace, request_id, identity, version, company=None, request_fingerprint='', *, owner_key=None):
        _identity(request_id)
        company = deepcopy(company or COMPANY_DEFAULTS)
        signature = self._signature(owner_key or workspace, identity, version, company, request_fingerprint)
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            row = db.execute('SELECT * FROM commercial_issued WHERE request_id=?', (request_id,)).fetchone()
            if row is None:
                return None
            if row['project_id'] != project or row['fingerprint'] != signature:
                raise CommercialConflict('This download request was already used for different document content.')
            document = _stored_document(row['document'])
            self._number_orders(db, [(project,document)])
            if owner_key:
                # A file write may have failed after the PDF was issued. A fresh
                # workspace for the exact same source file/revision can resume
                # the immutable receipt without issuing another number.
                prior = self._record(db, workspace, identity)
                if prior['version'] == version:
                    db.execute('UPDATE commercial_drafts SET data=? WHERE workspace=? AND id=?', (_json(document), workspace, identity))
                elif prior != document:
                    raise CommercialConflict('The linked Quote changed before its download could be retried.')
            return {**dict(row), 'document': document, 'pdf': bytes(row['pdf'])}

    def issue(self, workspace, identity, version, request_id, company=None, scope_documents=None, request_fingerprint='', *, owner_key=None):
        _identity(request_id)
        company = deepcopy(company or COMPANY_DEFAULTS)
        scopes = scope_documents or []
        # The saved version fixes fields and source fingerprints. Generated source
        # PDFs may contain fresh metadata, which must not defeat a safe retry.
        signature = self._signature(owner_key or workspace, identity, version, company, request_fingerprint)
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            replay = db.execute('SELECT * FROM commercial_issued WHERE request_id=?', (request_id,)).fetchone()
            if replay:
                if replay['project_id'] != project or replay['fingerprint'] != signature:
                    raise CommercialConflict('This download request was already used for different document content.')
                document = _stored_document(replay['document'])
                self._number_orders(db, [(project,document)])
                return {**dict(replay), 'document': document, 'pdf': bytes(replay['pdf'])}
            document = self._record(db, workspace, identity)
            self._version(document, version)
            kind = document['kind']
            previous = deepcopy(document)
            order = document['fields']['order']
            if kind=='work_order':
                self._inherit_quote_files(db, workspace, document['fields'])
                if 'work_tracking' not in document['fields'] and order['quote_id']:
                    tracking = self._quote_tracking(db, project, order['quote_id'],order['quote_reference'],document)
                    if tracking is not None:
                        document['fields']['work_tracking'] = tracking
                self._validate_tracking(db, project, document['fields'], previous)
            if kind == 'work_order' and order['quote_id'] and not order['estimated_cost'] and not document['fields'].get('estimated_cost_cleared'):
                order['estimated_cost'] = self._linked_quote_total(db, workspace, project, order['quote_id'], order['quote_reference'])
            if kind == 'work_order':
                document['status'] = reconciled_status(document['status'], document['fields'],
                    legacy_details=not any(key in order for key in ('details_by','details_date')))
            else:
                require_ready(kind, document['status'], document['fields'], operation='issue')
            label = document.get('reference')
            if kind == 'quote':
                if not document['last_number']:
                    # This also handles a pre-existing unnumbered draft downloaded before its next save.
                    label = document['reference'] = self.numbering.assign(db, kind, project + ':' + identity, label)
                # Another session may have issued the first PDF from the same portable draft.
                # Each later receipt needs a distinct number for Work Orders pinned to that revision.
                if document['last_number'] or db.execute(
                    'SELECT 1 FROM commercial_issued WHERE project_id=? AND document_id=? AND number=?',
                    (project, identity, label)
                ).fetchone():
                    label = self.numbering.assign(db, kind, project + ':issue:' + request_id)
            if self.renderer is None:
                from .commercial_pdf import render_commercial_pdf
                renderer = render_commercial_pdf
            else:
                renderer = self.renderer
            render_options = {'company': company, 'scope_documents': scopes}
            files = document['fields'].get('files', [])
            if files:
                render_options['append_files'] = lambda writer: self.files.append_to(writer, project, files)
            cover = self.covers.get(kind) if self.covers else None
            pdf = renderer(document, label, **render_options)
            from .pdf_cover import prepend_cover_pdf
            pdf = prepend_cover_pdf(pdf, company, cover)
            if not isinstance(pdf, bytes) or not pdf.startswith(b'%PDF-') or len(pdf) > MAX_PDF_BYTES:
                raise ValidationError('Generated commercial PDF is invalid or exceeds 64 MiB.')
            document['last_number'] = label
            document['version'] += 1
            document['updated_at'] = datetime.now(timezone.utc).isoformat()
            issued_id = str(uuid.uuid4())
            revision = '' if kind == 'quote' else '-R' + str(document['version'])
            filename = KINDS[kind].replace(' ', '-') + '-' + label + revision + '.pdf'
            if kind != 'quote' or label.startswith('Q-'):
                value = int(label.rsplit('-',1)[1])
                db.execute('INSERT INTO commercial_sequences VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET number=max(number,excluded.number)', (kind,value))
            db.execute('UPDATE commercial_drafts SET data=? WHERE workspace=? AND id=?', (_json(document), workspace, identity))
            db.execute('INSERT INTO commercial_issued VALUES(?,?,?,?,?,?,?,?,?)', (issued_id, project, identity, request_id, signature, label, filename, pdf, _json(document)))
            self._audit(db, workspace, identity, 'issue', previous, document)
        return {'id': issued_id, 'number': label, 'filename': filename, 'pdf': pdf, 'document': document}

    def read_pdf(self, workspace, issued_id):
        _identity(issued_id)
        with self._connect() as db:
            project = self._workspace(db, workspace)
            row = db.execute('SELECT filename,pdf FROM commercial_issued WHERE id=? AND project_id=?', (issued_id, project)).fetchone()
            if row is None:
                raise ValidationError('This PDF is unavailable in the current project.')
            return row['filename'], bytes(row['pdf'])
