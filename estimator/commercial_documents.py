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

from .catalog import ValidationError
from .commercial_files import WorkOrderFiles, validate_files
from .document_numbers import DocumentNumbers, valid_reference, validated_counters
from .company_settings import DEFAULTS as COMPANY_DEFAULTS
from .evidence_files import _directory
from .commercial_requirements import require_ready, requirements

KINDS = {'quote': 'Quote', 'work_order': 'Work Order', 'purchase_order': 'Purchase Order'}
STATUSES = {
    'quote': ('Draft', 'Review', 'Presented', 'Accepted', 'Lost'),
    'work_order': ('Draft', 'Review', 'OHS Docs', 'Client Approval', 'In progress', 'Claim', 'Certify', 'Completed', 'On Hold', 'Canceled'),
    'purchase_order': ('Draft', 'Requested', 'Reviewed', 'Sent', 'Verified'),
}
INTRODUCTION = ('We have the pleasure in providing you with the following quotation for our passive fire protection products and services, '
                'which will be supplied, installed and certified to comply with the National Construction Code and the relevant Australian '
                'Standards AS1530.4 and AS4072.1.')
DETAIL_FIELDS = ('project_no', 'client', 'site_address', 'contact', 'phone', 'email', 'date')
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
WORK_ORDER_OPTIONAL_FIELDS = ('progress_by', 'progress_date', 'closed_date', 'claimed_by', 'claim_date')
PURCHASE_PARTY_LABELS = {'supplier_account_id':'supplier', 'supplier_contact_id':'supplier_contact', 'site_contact_id':'ship_to_name'}
PURCHASE_ORDER_OPTIONAL_FIELDS = ('site_contact_number', 'delivery_time', 'rejection_reason', *PURCHASE_PARTY_LABELS)
WORK_ORDER_SIGNATURE_FIELDS = {'reviewed_by', 'prepared_by', 'client_approved_by', 'progress_by', 'closed_by', 'claimed_by'}
PURCHASE_ORDER_SIGNATURE_FIELDS = {'requested_by', 'reviewed_by', 'sent_by', 'verified_by'}
CERTIFICATION_CHOICES = ('Certification issued', 'Certification not issued')
COMPLETION_CHOICES = ('Completed', 'Ongoing', 'On hold', 'Not completed')
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_PDF_BYTES = 64 * 1024 * 1024
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


def project_document_details(value):
    """Copy bounded Project-owned identity, including explicit empty clears."""
    from .quote_details import QUOTE_DETAIL_LIMITS, validate_quote_details
    if not isinstance(value, dict):
        raise ValidationError('Include valid Project details for this document.')
    details = validate_quote_details({key: value.get(key, '') for key in QUOTE_DETAIL_LIMITS})
    return {document_key: details[project_key] for document_key, project_key in PROJECT_DETAIL_FIELDS.items()}


def detail_override_keys(value):
    """Explicit document-only edits never override the canonical Project number."""
    if (not isinstance(value, list) or len(value) > len(DETAIL_OVERRIDE_KEYS)
            or any(not isinstance(key, str) or key not in DETAIL_OVERRIDE_KEYS for key in value)
            or len(set(value)) != len(value)):
        raise ValidationError('Choose valid document detail overrides.')
    return [key for key in DETAIL_OVERRIDE_KEYS if key in value]


def apply_project_document_details(fields, details):
    # Validate legacy override metadata before retiring it from the editable
    # draft. Historical snapshots and already issued PDFs are never rewritten.
    detail_override_keys(fields.get('detail_overrides', []))
    fields['details'].update(details)
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
        if not result.is_finite() or not minimum <= result <= Decimal('1000000000') or result.as_tuple().exponent < -6:
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
            'order': {key: '' for key in (*ORDER_FIELDS, *(WORK_ORDER_OPTIONAL_FIELDS if kind=='work_order' else PURCHASE_ORDER_OPTIONAL_FIELDS if kind=='purchase_order' else ()))},
            'rate_schedule': schedule,
            'company_reference': {key: company.get(key, '') for key in ('name', 'abn')}}
    if kind == 'purchase_order':
        fields['order']['ship_to_address'] = fields['details']['site_address']
    return fields


def validate_fields(value, *, kind=None):
    if not isinstance(value, dict) or set(value) - {'rate_schedule', 'notes', 'signatures', 'files', 'work_tracking', 'detail_overrides'} != FIELD_KEYS:
        raise ValidationError('Commercial document fields use an unsupported format.')
    result = {'title': _text(value['title'], 'Title', 300)}
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
                      WORK_ORDER_SIGNATURE_FIELDS | PURCHASE_ORDER_SIGNATURE_FIELDS if kind is None else set())
    if not isinstance(signatures, dict) or set(signatures) - signature_keys:
        raise ValidationError('Invalid commercial document signatures.')
    if signatures:
        result['signatures'] = {key: validate_signature(signature) for key, signature in signatures.items()}
    if 'work_tracking' in value:
        if kind not in ('work_order', None):
            raise ValidationError('Work tracking belongs to a Work Order.')
        from .work_order_tracking import validate, has_completion
        result['work_tracking'] = validate(value['work_tracking'])
    if signatures.get('progress_by'):
        from .work_order_tracking import has_completion
        if not has_completion(result.get('work_tracking')):
            raise ValidationError('Record a completed percentage before signing work progress.')
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
                     else (*WORK_ORDER_OPTIONAL_FIELDS,*PURCHASE_ORDER_OPTIONAL_FIELDS) if kind is None else ()) if key=='order' else ())
        if not isinstance(fields, dict) or set(fields) - set(keys) - set(optional):
            raise ValidationError('Commercial document details contain unsupported fields.')
        result[key] = {name: _text(fields.get(name, ''), name, 6000 if key == 'order' else 1000) for name in keys}
        result[key].update({name:_text(fields[name], 'Site contact number' if name=='site_contact_number' else name,
                                      60 if name=='site_contact_number' else 1000) for name in optional if name in fields})
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
                                'unit_price': _number(line.get('unit_price', '0'), 'Unit price', -1000000000),
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
        if document['kind'] not in KINDS or document['status'] not in STATUSES[document['kind']] or type(document['version']) is not int or document['version'] < 1:
            raise ValidationError('Commercial document kind, status or version is invalid.')
        row = deepcopy(document)
        row['fields'] = validate_fields(document['fields'], kind=row['kind'])
        if row['fields'].get('work_tracking', {}).get('project_id', value['project_id']) != value['project_id']:
            raise ValidationError('Work tracking belongs to a different project.')
        for key in ('created_at', 'updated_at', 'last_number'):
            row[key] = _text(row[key], key, 100)
        if row['last_number'] and not valid_reference(row['last_number']):
            raise ValidationError('The last commercial document number is invalid.')
        if 'reference' in row and (row['kind'] == 'quote' or not valid_reference(row['reference'])):
            raise ValidationError('The saved order number is invalid.')
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


def commercial_cards(snapshot):
    """Index board fields without loading large scopes or editable document content."""
    if not snapshot:
        return []
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('documents'), list) or len(snapshot['documents']) > 100:
        raise ValidationError('Invalid saved commercial document collection.')
    cards = []
    for document in snapshot['documents']:
        try:
            kind = document['kind']
            if kind not in KINDS or document['status'] not in STATUSES[kind] or type(document['version']) is not int or document['version'] < 1:
                raise ValidationError('Invalid saved commercial document status or version.')
            fields = document['fields']
            details = {key: _text(fields['details'].get(key, ''), key, 1000) for key in ('project_no', 'client', 'site_address', 'contact')}
            order = {key: _text(fields['order'].get(key, ''), key, 6000) for key in
                     ('work_order_reference', 'quote_id', 'quote_reference', 'work_order_id', 'estimated_cost', 'supplier', 'supplier_contact')}
            if kind == 'purchase_order':
                order.update({key: _identity(fields['order'][key]) for key in PURCHASE_PARTY_LABELS if fields['order'].get(key)})
            lines = fields['lines']
            if not isinstance(lines, list) or len(lines) > 2000:
                raise ValidationError('Invalid saved commercial lines.')
            if kind == 'work_order':
                grand_total = order['estimated_cost']
            else:
                amounts = [{'quantity': _number(line['quantity'], 'Quantity'), 'unit_price': _number(line['unit_price'], 'Unit price', -1000000000)} for line in lines]
                grand_total = totals({'lines': amounts})['grand_total']
            cards.append({'id': _identity(document['id']), 'project_id': snapshot['project_id'], 'kind': kind,
                          'version': document['version'], 'status': document['status'], 'grand_total': grand_total,
                          'created_at': _text(document['created_at'], 'Creation date', 100),
                          'updated_at': _text(document['updated_at'], 'Last updated', 100),
                          'last_number': _text(document['last_number'], 'Document number', 100),
                          'reference': _text(document.get('reference', ''), 'Reference', 300),
                          'fields': {'title': _text(fields['title'], 'Document title', 300), 'order': order, 'details': details,
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
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS commercial_workspaces (workspace TEXT PRIMARY KEY, project_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_drafts (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id));
                CREATE TABLE IF NOT EXISTS commercial_sequences (kind TEXT PRIMARY KEY, number INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_work_order_sequences (project_id TEXT NOT NULL, quote_number TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY(project_id,quote_number));
                CREATE TABLE IF NOT EXISTS commercial_issued (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_id TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, number TEXT NOT NULL, filename TEXT NOT NULL, pdf BLOB NOT NULL, document TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS commercial_issued_document_number ON commercial_issued(project_id,document_id,number);
                CREATE TABLE IF NOT EXISTS commercial_audit (sequence INTEGER PRIMARY KEY, workspace TEXT NOT NULL, document_id TEXT NOT NULL, action TEXT NOT NULL, before_data TEXT, after_data TEXT, created_at TEXT NOT NULL);
            ''')
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

    def apply_register_numbers(self, cards):
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            self._number_orders(db, [(card['project_id'],card) for card in cards if card['kind'] in ('work_order','purchase_order')])
            # A linked project's issued quotes also reserve their numbers before
            # anyone opens that project on this computer.
            for card in cards:
                if card['kind'] == 'quote' and valid_reference(card.get('last_number', '')):
                    self.numbering.observe_reference(db, 'quote', card['last_number'])
            # Old work orders can have no cost until opened. Display the issued
            # quote amount on their cards, using the same portable fallback as the editor.
            quotes = {(c['source_file'], c['id'], c['last_number']): c['grand_total']
                      for c in cards if c['kind'] == 'quote' and c.get('source_file') and c['last_number']}
            for card in cards:
                if card['kind'] == 'work_order' and not card.get('grand_total') and card.get('source_file'):
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
        db.execute('INSERT OR IGNORE INTO commercial_workspaces VALUES (?,?)', (workspace, project))
        if db.execute('SELECT project_id FROM commercial_workspaces WHERE workspace=?', (workspace,)).fetchone()[0] != project:
            raise CommercialConflict('The commercial document workspace changed projects.')
        return project

    @staticmethod
    def _snapshot(db, workspace, project):
        rows = db.execute('SELECT data FROM commercial_drafts WHERE workspace=? ORDER BY id', (workspace,)).fetchall()
        counters = dict.fromkeys(KINDS, 0)
        counters.update(dict(db.execute('SELECT kind,number FROM commercial_sequences').fetchall()))
        work_order_counters = dict(db.execute('SELECT quote_number,number FROM commercial_work_order_sequences WHERE project_id=?', (project,)).fetchall())
        series = DocumentNumbers.history(db,project)
        short_quotes = DocumentNumbers.short_quote_history(db,project)
        return {'version': 1, 'project_id': project, 'documents': [_stored_document(row[0]) for row in rows], **({'reference_counters': series} if series else {}),
                **({'short_quote_counters': short_quotes} if short_quotes else {}),
                'number_counters': counters, 'work_order_counters': work_order_counters}

    def capture(self, workspace, expected_snapshot=None):
        with self._connect() as db:
            project = self._workspace(db, workspace)
            snapshot = self._snapshot(db, workspace, project)
        if expected_snapshot is not None and validate_commercial_documents(expected_snapshot) != snapshot:
            raise CommercialConflict('Commercial documents changed while the project was being saved. Refresh and save again.')
        return snapshot

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
                      'requirements': requirements(STATUSES)}
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

    def restore(self, workspace, snapshot):
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
                    if doc['kind'] == 'quote' and doc['last_number']:
                        self.numbering.observe_reference(db, 'quote', doc['last_number'])
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
            fields['order'].update(work_order_id=work_order['id'], work_order_reference=reference,
                                   ship_to_name=fields['details']['contact'], site_contact_number=fields['details']['phone'],
                                   ship_to_address=fields['details']['site_address'])
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

    def _relationships(self, db, workspace, project, kind, fields, previous, *, create_retry=False):
        order = fields['order']
        prior = previous['fields']['order'] if previous else None
        if kind == 'work_order':
            if order['work_order_id']:
                raise ValidationError('A work order cannot link to another work order.')
            if not previous or prior['quote_id']:
                fields['details']['project_no'] = fields['details']['project_no'].strip()
            if previous:
                if order['quote_id'] != prior['quote_id']:
                    raise ValidationError('The linked Quote cannot change after a work order is created.')
                if prior['quote_id']:
                    if fields['details']['project_no'] != previous['fields']['details']['project_no']:
                        raise ValidationError('The project number cannot change after a work order reference is assigned.')
                    for key in ('quote_reference', 'work_order_reference'):
                        if order[key] != prior[key] and not (create_retry and not order[key]):
                            raise ValidationError('Work order and Quote references are assigned automatically and cannot be edited.')
                        order[key] = prior[key]
                    if create_retry and not order['estimated_cost']:
                        order['estimated_cost'] = prior['estimated_cost']
                    elif not prior['estimated_cost'] and not order['estimated_cost']:
                        order['estimated_cost'] = self._linked_quote_total(db, workspace, project, order['quote_id'], order['quote_reference'])
                return
            if not order['quote_id']:
                raise ValidationError('Select an issued Quote before creating a work order.')
            quote = self._record(db, workspace, order['quote_id'])
            if quote['kind'] != 'quote' or not quote['last_number']:
                raise ValidationError('Download the linked Quote PDF before creating a work order.')
            project_no = fields['details']['project_no'].strip()
            if not project_no or any(char in project_no for char in '\r\n\t'):
                raise ValidationError('Enter a project number before creating a work order.')
            fields['details']['project_no'] = project_no
            quote_number = quote['last_number']
            if order['quote_reference'] not in ('', quote_number) or order['work_order_reference']:
                raise ValidationError('Work order references are assigned automatically when first saved.')
            order['quote_reference'] = quote_number
            if not order['estimated_cost']:
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

    def save(self, workspace, payload, *, unfiled_context=None):
        if not isinstance(payload, dict) or set(payload) - {'id', 'version', 'kind', 'status', 'fields'}:
            raise ValidationError('Commercial document save contains unsupported fields.')
        kind = payload.get('kind')
        if kind not in KINDS or payload.get('status') not in STATUSES[kind]:
            raise ValidationError('Choose a valid commercial document status.')
        fields = validate_fields(payload.get('fields'), kind=kind)
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            for item in fields.get('files', []):
                self.files.read(project, item)
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
                # Older open windows omit new editable fields. Preserve them
                # unless the current client deliberately sends an empty clear.
                if kind=='purchase_order':
                    for key in PURCHASE_ORDER_OPTIONAL_FIELDS:
                        if key not in PURCHASE_PARTY_LABELS and key not in fields['order'] and key in previous['fields']['order']:
                            fields['order'][key]=previous['fields']['order'][key]
                    # Older PO editors do not know vector signatures. Absence
                    # preserves saved ink; an explicit empty map clears it.
                    if 'signatures' not in payload['fields'] and previous['fields'].get('signatures'):
                        fields['signatures']=deepcopy(previous['fields']['signatures'])
                if kind=='work_order' and not any(key in payload['fields']['order'] for key in ('claimed_by','claim_date')):
                    for key in ('claimed_by','claim_date'):
                        if key in previous['fields']['order']:
                            fields['order'][key]=previous['fields']['order'][key]
                    if previous['fields'].get('signatures',{}).get('claimed_by'):
                        fields.setdefault('signatures',{})['claimed_by']=deepcopy(previous['fields']['signatures']['claimed_by'])
                if kind=='work_order' and fields.get('work_tracking') and previous['fields'].get('work_tracking'):
                    previous_rows={row['line_id']:row for row in previous['fields']['work_tracking']['rows']}
                    for raw, row in zip(payload['fields']['work_tracking']['rows'],fields['work_tracking']['rows']):
                        if 'notes' not in raw and row['line_id'] in previous_rows:
                            row['notes']=previous_rows[row['line_id']].get('notes','')
            self._relationships(db, workspace, project, kind, fields, previous, create_retry=payload.get('version') == 0)
            if kind=='work_order':
                for key, choices in (('certification',CERTIFICATION_CHOICES),('completion',COMPLETION_CHOICES)):
                    if fields['order'][key] and fields['order'][key] not in choices and (previous is None or fields['order'][key]!=previous['fields']['order'][key]):
                        raise ValidationError('Choose a listed certification or completion status.')
                self._validate_tracking(db, project, fields, previous)
            if payload.get('version') == 0 and previous:
                if previous['fields'] == fields and previous['status'] == payload['status']:
                    if unfiled_context is not None:
                        self.unfiled.enroll(db, workspace, previous['id'], unfiled_context)
                    return previous
                raise CommercialConflict('This new document was already saved with different content. Reopen it before editing.')
            require_ready(kind, payload['status'], fields)
            now = datetime.now(timezone.utc).isoformat()
            document = {'id': previous['id'] if previous else payload.get('id') or str(uuid.uuid4()), 'kind': kind,
                        'version': previous['version'] + 1 if previous else 1, 'status': payload['status'], 'fields': fields,
                        'created_at': previous['created_at'] if previous else now, 'updated_at': now,
                        'last_number': previous['last_number'] if previous else ''}
            if kind in ('work_order','purchase_order'):
                document['reference'] = self.numbering.assign(db, kind, project + ':' + document['id'], (previous or {}).get('reference',''))
                if kind == 'work_order':
                    fields['order']['work_order_reference'] = document['reference']
            snapshot = self._snapshot(db, workspace, project)
            snapshot['documents'] = [row for row in snapshot['documents'] if row['id'] != document['id']] + [document]
            validate_commercial_documents(snapshot)
            db.execute('INSERT INTO commercial_drafts VALUES(?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET data=excluded.data', (workspace, document['id'], _json(document)))
            self._audit(db, workspace, document['id'], 'save', previous, document)
            if unfiled_context is not None:
                self.unfiled.enroll(db, workspace, document['id'], unfiled_context)
        return document

    @contextmanager
    def publishing(self, workspace, snapshot):
        """Exclude concurrent board writes across processes during the atomic file takeover."""
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT filed FROM local_commercial_owners WHERE workspace=?', (workspace,)).fetchone()
            if row and not row['filed']:
                project = self.certifications.project_id(workspace)
                if snapshot is None or self._snapshot(db, workspace, project)['documents'] != snapshot['documents']:
                    raise CommercialConflict('Commercial documents changed during this project save. Save the project again.')
            yield
            self.unfiled.bind_file(db, workspace)


    def delete(self, workspace, identity, version):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._workspace(db, workspace)
            previous = self._record(db, workspace, identity)
            self._version(previous, version)
            db.execute('DELETE FROM commercial_drafts WHERE workspace=? AND id=?', (workspace, identity))
            self._audit(db, workspace, identity, 'delete', previous)
        return {'deleted': True}

    def status(self, workspace, identity, version, status):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            previous = self._record(db, workspace, identity)
            self._version(previous, version)
            if status not in STATUSES[previous['kind']]:
                raise ValidationError('Choose a valid document status.')
            document = deepcopy(previous)
            if document['kind'] == 'work_order' and status != 'Draft':
                self._relationships(db, workspace, project, document['kind'], document['fields'], previous)
                self._validate_tracking(db, project, document['fields'], previous)
            require_ready(document['kind'], status, document['fields'])
            document.update(status=status, version=version + 1, updated_at=datetime.now(timezone.utc).isoformat())
            db.execute('UPDATE commercial_drafts SET data=? WHERE workspace=? AND id=?', (_json(document), workspace, identity))
            self._audit(db, workspace, identity, 'status', previous, document)
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
                if 'work_tracking' not in document['fields'] and order['quote_id']:
                    tracking = self._quote_tracking(db, project, order['quote_id'],order['quote_reference'],document)
                    if tracking is not None:
                        document['fields']['work_tracking'] = tracking
                self._validate_tracking(db, project, document['fields'], previous)
            if kind == 'work_order' and order['quote_id'] and not order['estimated_cost']:
                order['estimated_cost'] = self._linked_quote_total(db, workspace, project, order['quote_id'], order['quote_reference'])
            require_ready(kind, document['status'], document['fields'], operation='issue')
            label = (self.numbering.assign(db, kind, project + ':issue:' + request_id) if kind == 'quote' else document['reference'])
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
