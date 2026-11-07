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
from .company_settings import DEFAULTS as COMPANY_DEFAULTS
from .evidence_files import _directory

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
ORDER_FIELDS = ('start_date', 'end_date', 'urgency', 'quote_id', 'work_order_id', 'quote_reference', 'work_order_reference',
                'description', 'estimated_cost', 'attachments', 'review_date', 'approval', 'justification',
                'reviewed_by', 'swms', 'sds', 'sop', 'other_documents', 'prepared_by', 'client_approval',
                'client_approved_by', 'client_approval_date', 'progress', 'claim', 'certification', 'completion',
                'closed_by', 'supplier', 'supplier_email', 'supplier_contact', 'payment_terms', 'ship_to_name',
                'ship_to_address', 'delivery_date', 'expense_type', 'delivery_method', 'requested_by',
                'requested_date', 'sent_by', 'sent_date', 'verified_by', 'verified_date', 'verification')
FIELD_KEYS = {'title', 'details', 'introduction', 'lines', 'scope', 'scope_tables', 'sources', 'allowances', 'terms', 'order', 'company_reference'}
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_PDF_BYTES = 64 * 1024 * 1024
RATE_DEFAULTS = {'ordinary_time': '130', 'time_and_half': '160', 'double_time': '190',
                 'site_remobilisation': '1000', 'access_equipment_transport': '400',
                 'equipment': '20', 'materials': '20'}
RATE_INTRODUCTION = ('If additional work, or rectification work that is not the result of defective workmanship, '
                     'is directed by the client or their representatives, either verbally or in writing, the '
                     'following rates shall apply when calculating the value of such work:')


def default_rate_schedule():
    return {'introduction': RATE_INTRODUCTION, 'rates': dict(RATE_DEFAULTS),
            'acceptance': {key: '' for key in ('accepted_by', 'title', 'signature', 'date')}}


def validate_rate_schedule(value):
    if not isinstance(value, dict) or set(value) != {'introduction', 'rates', 'acceptance'}:
        raise ValidationError('Schedule of Rates uses an unsupported format.')
    if not isinstance(value['rates'], dict) or set(value['rates']) != set(RATE_DEFAULTS):
        raise ValidationError('Include each Schedule of Rates amount.')
    if not isinstance(value['acceptance'], dict) or set(value['acceptance']) != {'accepted_by', 'title', 'signature', 'date'}:
        raise ValidationError('Include the Schedule of Rates acceptance fields.')
    return {'introduction': _text(value['introduction'], 'Schedule of Rates introduction', 20000),
            'rates': {key: _number(amount, 'Schedule of Rates amount') for key, amount in value['rates'].items()},
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


def default_fields(kind, details=None, company=None):
    if kind not in KINDS:
        raise ValidationError('Choose Quote, Work Order or Purchase Order.')
    supplied = details or {}
    company = company or COMPANY_DEFAULTS
    return {'title': KINDS[kind], 'details': {key: supplied.get(key, '') for key in DETAIL_FIELDS},
            'introduction': INTRODUCTION if kind == 'quote' else '', 'lines': [], 'scope': '',
            'scope_tables': [], 'sources': [], 'allowances': '', 'terms': default_terms(company) if kind == 'quote' else '',
            'order': {key: '' for key in ORDER_FIELDS},
            'rate_schedule': default_rate_schedule(),
            'company_reference': {key: company.get(key, '') for key in ('name', 'abn')}}


def validate_fields(value, *, kind=None):
    if not isinstance(value, dict) or set(value) - {'rate_schedule'} != FIELD_KEYS:
        raise ValidationError('Commercial document fields use an unsupported format.')
    result = {'title': _text(value['title'], 'Title', 300)}
    result['rate_schedule'] = validate_rate_schedule(value.get('rate_schedule', default_rate_schedule()))
    company = value['company_reference']
    if not isinstance(company, dict) or set(company) != {'name', 'abn'}:
        raise ValidationError('Commercial document company reference is invalid.')
    result['company_reference'] = {key: _text(company[key], 'Company reference', 120) for key in company}
    for key, keys in (('details', DETAIL_FIELDS), ('order', ORDER_FIELDS)):
        fields = value[key]
        if not isinstance(fields, dict) or set(fields) - set(keys):
            raise ValidationError('Commercial document details contain unsupported fields.')
        result[key] = {name: _text(fields.get(name, ''), name, 6000 if key == 'order' else 1000) for name in keys}
    for name in ('quote_id', 'work_order_id'):
        if result['order'][name]:
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
    legacy = re.fullmatch(r'(.+)-(Q-[0-9]{6,10})-([0-9]{2,10})', order['work_order_reference'])
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
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {'work_order_counters'} or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('Commercial documents use an unsupported project format.')
    _identity(value['project_id'])
    counters = value['number_counters']
    if not isinstance(counters, dict) or set(counters) != set(KINDS) or any(type(number) is not int or not 0 <= number <= 9999999999 for number in counters.values()):
        raise ValidationError('Commercial document number counters are invalid.')
    work_order_counters = deepcopy(value.get('work_order_counters', {}))
    if (not isinstance(work_order_counters, dict) or len(work_order_counters) > 10000
            or any(not isinstance(label, str) or not re.fullmatch(r'Q-\d{6,10}', label)
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
        if not isinstance(document, dict) or set(document) != {'id', 'kind', 'version', 'status', 'fields', 'created_at', 'updated_at', 'last_number'}:
            raise ValidationError('A commercial document has unsupported fields.')
        identity = _identity(document['id'])
        if identity in identities:
            raise ValidationError('Commercial document identities must be unique.')
        identities.add(identity)
        if document['kind'] not in KINDS or document['status'] not in STATUSES[document['kind']] or type(document['version']) is not int or document['version'] < 1:
            raise ValidationError('Commercial document kind, status or version is invalid.')
        row = deepcopy(document)
        row['fields'] = validate_fields(document['fields'], kind=row['kind'])
        for key in ('created_at', 'updated_at', 'last_number'):
            row[key] = _text(row[key], key, 100)
        prefix = {'quote': 'Q', 'work_order': 'WO', 'purchase_order': 'PO'}[row['kind']]
        if row['last_number'] and not re.fullmatch(re.escape(prefix) + r'-\d{6,10}', row['last_number']):
            raise ValidationError('The last commercial document number is invalid.')
        if row['kind'] == 'work_order' and row['fields']['order']['quote_id']:
            quote_number, sequence = _work_order_sequence(row['fields'])
            work_order_counters[quote_number] = max(work_order_counters.get(quote_number, 0), sequence)
        documents.append(row)
    return {'version': 1, 'project_id': value['project_id'], 'documents': documents,
            'number_counters': deepcopy(counters), 'work_order_counters': work_order_counters}


def _work_order_sequence(fields):
    """Validate the saved reference without requiring a still-existing source Quote."""
    project_no = fields['details']['project_no']
    order = fields['order']
    quote_number = order['quote_reference']
    if not project_no.strip() or any(char in project_no for char in '\r\n\t') or not re.fullmatch(r'Q-\d{6,10}', quote_number):
        raise ValidationError('A work order requires a project number and an issued Quote number.')
    prefix = _work_order_prefix(project_no, quote_number)
    reference = order['work_order_reference']
    suffix = reference[len(prefix):] if reference.startswith(prefix) else ''
    if not re.fullmatch(r'\d{2,10}', suffix) or not 1 <= int(suffix) <= 9999999999 or suffix != f'{int(suffix):02d}':
        raise ValidationError('The work order reference does not match its project and Quote.')
    return quote_number, int(suffix)


def quote_cards(snapshot):
    """Keep the folder index small even when quotes contain large schedules."""
    if not snapshot:
        return []
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('documents'), list) or len(snapshot['documents']) > 100:
        raise ValidationError('Invalid saved commercial document collection.')
    cards = []
    for document in snapshot['documents']:
        try:
            if document['kind'] != 'quote':
                continue
            _identity(document['id'])
            if document['status'] not in STATUSES['quote'] or type(document['version']) is not int or document['version'] < 1:
                raise ValidationError('Invalid saved Quote status or version.')
            details = document['fields']['details']
            cards.append({'id': document['id'], 'kind': 'quote', 'version': document['version'], 'status': document['status'],
                          'updated_at': _text(document['updated_at'], 'Quote date', 100),
                          'last_number': _text(document['last_number'], 'Quote number', 100),
                          'fields': {'title': _text(document['fields']['title'], 'Quote title', 300), 'order': {},
                                     'details': {key: _text(details[key], key, 1000) for key in ('project_no', 'client', 'site_address')}}})
        except (TypeError, KeyError) as error:
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
    def __init__(self, certifications, root=None, renderer=None):
        self.certifications = certifications
        self.root = _directory(Path(root) if root else certifications.root.parent / 'commercial-documents', create=True)
        self.path = self.root / 'documents.sqlite3'
        self.renderer = renderer
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS commercial_workspaces (workspace TEXT PRIMARY KEY, project_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_drafts (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id));
                CREATE TABLE IF NOT EXISTS commercial_sequences (kind TEXT PRIMARY KEY, number INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_work_order_sequences (project_id TEXT NOT NULL, quote_number TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY(project_id,quote_number));
                CREATE TABLE IF NOT EXISTS commercial_issued (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_id TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, number TEXT NOT NULL, filename TEXT NOT NULL, pdf BLOB NOT NULL, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS commercial_audit (sequence INTEGER PRIMARY KEY, workspace TEXT NOT NULL, document_id TEXT NOT NULL, action TEXT NOT NULL, before_data TEXT, after_data TEXT, created_at TEXT NOT NULL);
            ''')

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
        return {'version': 1, 'project_id': project, 'documents': [_stored_document(row[0]) for row in rows],
                'number_counters': counters, 'work_order_counters': work_order_counters}

    def capture(self, workspace, expected_snapshot=None):
        with self._connect() as db:
            project = self._workspace(db, workspace)
            snapshot = self._snapshot(db, workspace, project)
        if expected_snapshot is not None and validate_commercial_documents(expected_snapshot) != snapshot:
            raise CommercialConflict('Commercial documents changed while the project was being saved. Refresh and save again.')
        return snapshot

    def view(self, workspace):
        snapshot = self.capture(workspace)
        return {'workspace_id': workspace, 'project_id': snapshot['project_id'], 'documents': snapshot['documents'], 'snapshot': snapshot, 'statuses': STATUSES}

    def restore(self, workspace, snapshot):
        snapshot = validate_commercial_documents(snapshot)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            if snapshot is not None and snapshot['project_id'] != project:
                raise CommercialConflict('Commercial documents belong to a different project.')
            current = self._snapshot(db, workspace, project)
            if current['documents']:
                if snapshot != current:
                    raise CommercialConflict('This commercial workspace already has drafts. Reopen the project to restore another snapshot.')
            elif snapshot:
                for document in snapshot['documents']:
                    db.execute('INSERT INTO commercial_drafts VALUES(?,?,?)', (workspace, document['id'], _json(document)))
                    if document['last_number']:
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
        db.execute('INSERT INTO commercial_audit(workspace,document_id,action,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)',
                   (workspace, identity, action, _json(before) if before else None, _json(after) if after else None, datetime.now(timezone.utc).isoformat()))

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
                    _work_order_sequence(fields)
                    if create_retry and not order['estimated_cost']:
                        order['estimated_cost'] = prior['estimated_cost']
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
            row = db.execute('SELECT number FROM commercial_work_order_sequences WHERE project_id=? AND quote_number=?', (project, quote_number)).fetchone()
            number = (row[0] if row else 0) + 1
            if number > 9999999999:
                raise ValidationError('The work order reference sequence is exhausted.')
            order['quote_reference'] = quote_number
            order['work_order_reference'] = _work_order_prefix(project_no, quote_number) + f'{number:02d}'
            if not order['estimated_cost']:
                order['estimated_cost'] = totals(quote['fields'])['grand_total']
            db.execute('INSERT INTO commercial_work_order_sequences VALUES(?,?,?) ON CONFLICT(project_id,quote_number) DO UPDATE SET number=excluded.number', (project, quote_number, number))
        elif kind == 'purchase_order':
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

    def save(self, workspace, payload):
        if not isinstance(payload, dict) or set(payload) - {'id', 'version', 'kind', 'status', 'fields'}:
            raise ValidationError('Commercial document save contains unsupported fields.')
        kind = payload.get('kind')
        if kind not in KINDS or payload.get('status') not in STATUSES[kind]:
            raise ValidationError('Choose a valid commercial document status.')
        fields = validate_fields(payload.get('fields'), kind=kind)
        with self._connect() as db:
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
            self._relationships(db, workspace, project, kind, fields, previous, create_retry=payload.get('version') == 0)
            if payload.get('version') == 0 and previous:
                if previous['fields'] == fields and previous['status'] == payload['status']:
                    return previous
                raise CommercialConflict('This new document was already saved with different content. Reopen it before editing.')
            now = datetime.now(timezone.utc).isoformat()
            document = {'id': previous['id'] if previous else payload.get('id') or str(uuid.uuid4()), 'kind': kind,
                        'version': previous['version'] + 1 if previous else 1, 'status': payload['status'], 'fields': fields,
                        'created_at': previous['created_at'] if previous else now, 'updated_at': now,
                        'last_number': previous['last_number'] if previous else ''}
            snapshot = self._snapshot(db, workspace, project)
            snapshot['documents'] = [row for row in snapshot['documents'] if row['id'] != document['id']] + [document]
            validate_commercial_documents(snapshot)
            db.execute('INSERT INTO commercial_drafts VALUES(?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET data=excluded.data', (workspace, document['id'], _json(document)))
            self._audit(db, workspace, document['id'], 'save', previous, document)
        return document

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
            self._workspace(db, workspace)
            previous = self._record(db, workspace, identity)
            self._version(previous, version)
            if status not in STATUSES[previous['kind']]:
                raise ValidationError('Choose a valid document status.')
            document = deepcopy(previous)
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
            project = self._workspace(db, workspace)
            row = db.execute('SELECT * FROM commercial_issued WHERE request_id=?', (request_id,)).fetchone()
            if row is None:
                return None
            if row['project_id'] != project or row['fingerprint'] != signature:
                raise CommercialConflict('This download request was already used for different document content.')
            document = _stored_document(row['document'])
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
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            replay = db.execute('SELECT * FROM commercial_issued WHERE request_id=?', (request_id,)).fetchone()
            if replay:
                if replay['project_id'] != project or replay['fingerprint'] != signature:
                    raise CommercialConflict('This download request was already used for different document content.')
                return {**dict(replay), 'document': _stored_document(replay['document']), 'pdf': bytes(replay['pdf'])}
            document = self._record(db, workspace, identity)
            self._version(document, version)
            kind = document['kind']
            row = db.execute('SELECT number FROM commercial_sequences WHERE kind=?', (kind,)).fetchone()
            number = (row[0] if row else 0) + 1
            if number > 9999999999:
                raise ValidationError('The commercial document number sequence is exhausted.')
            label = {'quote': 'Q', 'work_order': 'WO', 'purchase_order': 'PO'}[kind] + f'-{number:06d}'
            if self.renderer is None:
                from .commercial_pdf import render_commercial_pdf
                renderer = render_commercial_pdf
            else:
                renderer = self.renderer
            displayed_number = (document['fields']['order']['work_order_reference']
                                if kind == 'work_order' and document['fields']['order']['quote_id'] else label)
            pdf = renderer(document, displayed_number, company=company, scope_documents=scopes)
            if not isinstance(pdf, bytes) or not pdf.startswith(b'%PDF-') or len(pdf) > MAX_PDF_BYTES:
                raise ValidationError('Generated commercial PDF is invalid or exceeds 64 MiB.')
            previous = deepcopy(document)
            document['last_number'] = label
            document['version'] += 1
            document['updated_at'] = datetime.now(timezone.utc).isoformat()
            issued_id = str(uuid.uuid4())
            filename = KINDS[kind].replace(' ', '-') + '-' + label + '.pdf'
            db.execute('INSERT INTO commercial_sequences VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET number=excluded.number', (kind, number))
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
