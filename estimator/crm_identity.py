"""Directory identity decisions. Source records and document references retain their IDs."""

import hashlib
import json
import re
from itertools import chain
from uuid import UUID

from .catalog import ValidationError


KINDS = {'accounts': 'crm_account_merges', 'contacts': 'crm_contact_merges'}
UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
PERSON = "SELECT c.*,coalesce(a.company,'') AS company FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id"
COMPANY = "SELECT id,company,billing_address,abn_acn FROM accounts"


class IdentityConflict(ValidationError):
    pass


class DuplicateReview(IdentityConflict):
    def __init__(self, decision):
        self.decision = decision
        super().__init__('Review possible duplicate records before saving.')


def fold(value):
    return ' '.join((value or '').split()).casefold()


def keys(kind, data):
    if kind == 'accounts':
        name = fold(data.get('company'))
        legal = re.sub(r'[^\w]+', ' ', name).strip()
        legal = re.sub(r'\s+(?:(?:pty|proprietary)\s+)?(?:ltd|limited)$', '', legal)
        registration = re.sub(r'^(?:abn|acn)\s*[:#]?\s*', '', fold(data.get('abn_acn')))
        registration = re.sub(r'[\s.-]', '', registration)
        return {'Company name': name, 'Similar company name': legal,
                'ABN/ACN': registration if re.fullmatch(r'[0-9]{9}|[0-9]{11}', registration) else ''}
    raw_phone = data.get('phone') or ''
    phone = re.sub(r'[\s()+.-]', '', raw_phone)
    if not re.fullmatch(r'[0-9]{7,15}', phone):
        phone = ''
    return {'Name': fold(data.get('name')), 'Email': fold(data.get('email')), 'Phone': phone}


def initialize(db):
    new_index = not db.execute("SELECT 1 FROM sqlite_master WHERE name='crm_identity_keys'").fetchone()
    db.execute("""CREATE TABLE IF NOT EXISTS crm_identity_keys (
        kind TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(kind,record_id,field))""")
    db.execute("CREATE INDEX IF NOT EXISTS crm_identity_values ON crm_identity_keys(kind,field,value)")
    db.execute("""CREATE TABLE IF NOT EXISTS crm_identity_dirty (
        kind TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(kind,record_id))""")
    for kind, table in KINDS.items():
        db.execute(f"""CREATE TABLE IF NOT EXISTS {table} (
            operation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES {kind}(id),
            survivor_id TEXT NOT NULL REFERENCES {kind}(id), reason TEXT NOT NULL,
            actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, merged_at TEXT NOT NULL DEFAULT ({UTC}),
            request_hash TEXT NOT NULL, merge_revision INTEGER NOT NULL, undo_id TEXT UNIQUE, undo_hash TEXT, undone_at TEXT, undo_revision INTEGER,
            undo_actor_id TEXT, undo_actor_name TEXT, CHECK(source_id<>survivor_id))""")
        db.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS {table}_source ON {table}(source_id) WHERE undone_at IS NULL")
        db.execute(f"CREATE INDEX IF NOT EXISTS {table}_survivor ON {table}(survivor_id) WHERE undone_at IS NULL")
        # Plain SQLite triggers also see writes from older compatible versions.
        for action, prefix in [('INSERT','NEW'), ('UPDATE','NEW'), ('DELETE','OLD')]:
            db.execute(f"""CREATE TRIGGER IF NOT EXISTS crm_keys_{kind}_{action} AFTER {action} ON {kind}
                BEGIN INSERT INTO crm_identity_dirty VALUES ('{kind}',{prefix}.id)
                ON CONFLICT(kind,record_id) DO NOTHING; END""")
        if new_index:
            db.execute(f"INSERT OR IGNORE INTO crm_identity_dirty SELECT ?,id FROM {kind}", (kind,))
    index_changes(db)


def index_changes(db):
    for kind, ident in db.execute('SELECT kind,record_id FROM crm_identity_dirty').fetchall():
        db.execute('DELETE FROM crm_identity_keys WHERE kind=? AND record_id=?', (kind, ident))
        row = db.execute(f'SELECT * FROM {kind} WHERE id=?', (ident,)).fetchone()
        if row:
            db.executemany('INSERT INTO crm_identity_keys VALUES (?,?,?,?)',
                           [(kind, ident, key, value) for key, value in keys(kind, dict(row)).items() if value])
        db.execute('DELETE FROM crm_identity_dirty WHERE kind=? AND record_id=?', (kind, ident))


def aliases(db):
    return {kind: dict(db.execute(f'SELECT source_id,survivor_id FROM {table} WHERE undone_at IS NULL'))
            for kind, table in KINDS.items()}


def group_ids(mapping, ident):
    if not ident:
        return set()
    root = mapping.get(ident, ident)
    return {root, *(source for source, survivor in mapping.items() if survivor == root)}


def record(db, kind, ident, *, optional=False):
    if not isinstance(kind, str) or kind not in KINDS or not isinstance(ident, str):
        raise ValidationError('Choose an existing directory record.')
    query = PERSON + ' WHERE c.id=?' if kind == 'contacts' else COMPANY + ' WHERE id=?'
    result = db.execute(query, (ident,)).fetchone()
    if not result:
        if optional:
            return None
        raise ValidationError('Choose an existing directory record.')
    return dict(result)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def company_name_candidates(db, name):
    """Find whole-name extensions, using the existing normalized-name index in both directions."""
    words = name.split()
    generic = {'a','an','the','and','group','services','service','company','australia','australian','pty','ltd'}
    prefixes = [' '.join(words[:end]) for end in range(1, len(words))
                if any(len(word) >= 3 and word not in generic for word in words[:end])]
    if not any(len(word) >= 3 and word not in generic for word in words):
        return
    query = "SELECT record_id FROM crm_identity_keys WHERE kind='accounts' AND field='Similar company name' AND "
    if prefixes:
        yield from db.execute(query + 'value IN ('+','.join('?' for _ in prefixes)+')', prefixes)
    # '!' sorts immediately after the space separating the base name from its extra words.
    yield from db.execute(query + 'value>=? AND value<?', (name+' ',name+'!'))


def suggestions(db, kind, data, ident=None, account_id=None):
    if ident is not None:
        record(db, kind, ident)
    signals = keys(kind, data)
    mapping = aliases(db)
    excluded = group_ids(mapping[kind], ident)
    found = {}
    for field, value in signals.items():
        if not value:
            continue
        candidates = db.execute('SELECT record_id FROM crm_identity_keys WHERE kind=? AND field=? AND value=?',
                                (kind, field, value))
        if kind == 'accounts' and field == 'Similar company name':
            candidates = chain(candidates, company_name_candidates(db, value))
        for (candidate,) in candidates:
            if candidate not in excluded:
                root = mapping[kind].get(candidate, candidate)
                found.setdefault(root, {}).setdefault(candidate, set()).add(field)
    options = []
    for root, evidence in found.items():
        # Separate people may share a mailbox, switchboard or surname. Strong reasons
        # must come from the same original row, including after an administrator merge.
        strong = False
        for candidate, reasons in evidence.items():
            if kind == 'accounts':
                strong |= 'ABN/ACN' in reasons
            elif 'Name' in reasons and ('Email' in reasons or 'Phone' in reasons) and account_id:
                owner = record(db, kind, candidate)['account_id']
                strong |= mapping['accounts'].get(owner, owner) == mapping['accounts'].get(account_id, account_id)
        reasons = sorted(set.union(*evidence.values()))
        if 'Company name' in reasons and 'Similar company name' in reasons:
            reasons.remove('Similar company name')
        options.append({'id':root, 'fields':record(db, kind, root), 'reasons':reasons, 'strong':strong})
    options.sort(key=lambda item: (not item['strong'], -len(item['reasons']), item['id']))
    version = db.execute('SELECT version FROM revision WHERE id=1').fetchone()[0]
    return {'kind':kind, 'version':version, 'matches':options[:20], 'total':len(options),
            'review_token':digest([kind, ident, account_id, data, version,
                                   [(item['id'], item['reasons'], item['strong']) for item in options]])}


def check_save(db, kind, data, ident, body, account_id=None):
    if ident:
        old = record(db, kind, ident)
        if keys(kind, old) == keys(kind, data) and (kind == 'accounts' or old['account_id'] == account_id):
            return
    decision = suggestions(db, kind, data, ident, account_id)
    reviews = body.get('identity_reviews')
    token = reviews.get(kind) if isinstance(reviews, dict) else body.get('review_token')
    if any(item['strong'] for item in decision['matches']) and token != decision['review_token']:
        raise DuplicateReview(decision)


def public_merges(db):
    result = {}
    for kind, table in KINDS.items():
        items = []
        for row in db.execute(f'''SELECT operation_id,source_id,survivor_id,reason,actor_name,merged_at
                FROM {table} WHERE undone_at IS NULL ORDER BY merged_at,operation_id'''):
            original = record(db, kind, row['source_id'])
            items.append({**dict(row), 'source_label':original.get('name') or original['company'], 'source_fields':original})
        result[kind] = items
    return result


def project_directory(db, result, raw):
    mappings = aliases(db)
    result['identity_aliases'] = mappings
    result['identity_merges'] = public_merges(db)
    if raw:
        return
    result['accounts'] = [row for row in result['accounts'] if row['id'] not in mappings['accounts']]
    result['contacts'] = [row for row in result['contacts'] if row['id'] not in mappings['contacts']]
    companies = {row['id']: row for row in result['accounts']}
    for person in result['contacts']:
        owner = mappings['accounts'].get(person['account_id'])
        if owner:
            person.update(account_id=owner, company=companies[owner]['company'], abn_acn=companies[owner]['abn_acn'])


class IdentityService:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _validate_pair(db, kind, source, survivor):
        first, second = record(db, kind, source), record(db, kind, survivor)
        mapping = aliases(db)[kind]
        if source == survivor or source in mapping or survivor in mapping or source in mapping.values():
            raise IdentityConflict('Choose two active records. Undo earlier merges into the source first.')
        return {'source':first,'survivor':second,'source_ids':sorted(group_ids(mapping, source)),
                'survivor_ids':sorted(group_ids(mapping, survivor))}

    def preview(self, body):
        with self.store.connection() as db:
            db.execute('BEGIN')
            pair = self._validate_pair(db, body.get('kind'), body.get('source_id'), body.get('survivor_id'))
            version = self.store._version(db)
            return {**pair, 'version':version, 'preview_token':digest([body['kind'], pair, version])}

    def apply(self, action, body, actor=None):
        kind = body.get('kind')
        table = KINDS.get(kind) if isinstance(kind, str) else None
        request = body.get('request_id')
        try:
            valid = isinstance(request, str) and str(UUID(request)) == request
        except ValueError:
            valid = False
        if not table or not valid or action not in ('merge', 'undo'):
            raise ValidationError('Choose a valid identity action.')
        actor = actor or {}
        owner, name = str(actor.get('id') or ''), str(actor.get('name') or '')
        fingerprint = digest([action, body, owner])
        with self.store.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            # Allow a lost success response to be retried with the original revision.
            column, digest_key = ('operation_id', 'request_hash') if action == 'merge' else ('undo_id', 'undo_hash')
            old = db.execute(f'SELECT * FROM {table} WHERE {column}=?', (request,)).fetchone()
            if old:
                if old[digest_key] != fingerprint:
                    raise IdentityConflict('This request has already been used for another identity decision.')
                revision = old['merge_revision'] if action == 'merge' else old['undo_revision']
                return {'operation_id':old['operation_id'], 'version':revision}
            version = self.store._version(db)
            if type(body.get('version')) is not int or body['version'] != version:
                raise IdentityConflict('Contacts have changed. Reopen the form to review the latest values.')
            if action == 'merge':
                source, survivor = body.get('source_id'), body.get('survivor_id')
                pair = self._validate_pair(db, kind, source, survivor)
                reason = body.get('reason')
                if (not isinstance(reason, str) or not reason.strip() or len(reason) > 500
                        or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]', reason)):
                    raise ValidationError('Enter a reason for merging the records (up to 500 characters).')
                if body.get('preview_token') != digest([kind, pair, version]):
                    raise IdentityConflict('Review the source and surviving record before merging.')
                db.execute(f'''INSERT INTO {table}
                    (operation_id,source_id,survivor_id,reason,actor_id,actor_name,request_hash,merge_revision)
                    VALUES (?,?,?,?,?,?,?,?)''', (request, source, survivor, reason.strip(), owner, name, fingerprint, version+1))
                operation = request
            else:
                operation = body.get('operation_id')
                if not isinstance(operation, str) or not db.execute(f'''UPDATE {table} SET undo_id=?,undo_hash=?,
                    undone_at=({UTC}),undo_actor_id=?,undo_actor_name=?,undo_revision=? WHERE operation_id=? AND undone_at IS NULL''',
                    (request, fingerprint, owner, name, version+1, operation)).rowcount:
                    raise IdentityConflict('This merge is no longer active.')
            db.execute('UPDATE revision SET version=version+1 WHERE id=1')
            return {'operation_id':operation, 'version':version+1}
