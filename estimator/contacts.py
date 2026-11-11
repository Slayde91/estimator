"""Company-wide leads, people and accounts in the local application database."""

from contextlib import closing, contextmanager
from datetime import date
import json
from pathlib import Path
import re
import sqlite3
import unicodedata
from uuid import uuid4

from .catalog import ValidationError
from . import crm_identity
from . import crm_activity


ACTIVE_LEAD_STATUSES = ("New", "Qualified", "Disqualified")
LEAD_STATUSES = (*ACTIVE_LEAD_STATUSES, "Converted")
PERSON_FIELDS = ("name", "phone", "company", "title", "email")
ACCOUNT_FIELDS = ("company", "billing_address", "abn_acn")
LEAD_FIELDS = (*PERSON_FIELDS, "site_address", "billing_address", "description", "status", "abn_acn", "next_action", "follow_up_date")
CONVERSION_REQUIRED_FIELDS = ("name", "phone", "company", "email", "site_address")
CONVERSION_REQUIRED_MESSAGE = "Complete Name, Phone, Company, Email and Site address before converting this Lead."
CONTACT_CREATION_REQUIRED_FIELDS = ("name", "phone", "company", "email")
CONTACT_CREATION_REQUIRED_MESSAGE = "Complete Name, Phone, Company and Email before creating this Contact."
LINK_KINDS = ("contacts", "projects", "quotes", "work_orders", "purchase_orders")
FIELDS = {"leads": LEAD_FIELDS, "contacts": PERSON_FIELDS, "accounts": ACCOUNT_FIELDS}
LIMITS = {"name": 160, "phone": 60, "company": 240, "title": 160, "email": 254,
          "site_address": 1200, "billing_address": 1200, "description": 8000, "status": 100, "abn_acn": 80,
          "next_action": 500, "follow_up_date": 10}


def active_lead_status(status, fields, *, selected_contact=False):
    """Classify active enquiries, including stages stored by earlier versions."""
    if status in ("Disqualified", "Lost", "Not Applicable"):
        return "Disqualified"
    if status in ("Qualified", "Contacted", "Quoting", "Negotiating", "Won") or selected_contact or fields["phone"] or fields["email"]:
        return "Qualified"
    return "New"


def checked_fields(kind, values):
    if kind not in FIELDS or not isinstance(values, dict) or set(values) - set(FIELDS[kind]):
        raise ValidationError("Use the fields provided on this form.")
    clean = {}
    for field in FIELDS[kind]:
        raw = values.get(field, "")
        if (not isinstance(raw, str) or len(raw) > LIMITS[field]
                or any(0xd800 <= ord(char) <= 0xdfff or (ord(char) < 32 and char not in "\t\n\r") for char in raw)):
            raise ValidationError(f"Check {field.replace('_', ' ')} (maximum {LIMITS[field]} characters).")
        clean[field] = raw.strip()
    if kind != "accounts" and not clean["name"]:
        raise ValidationError("Enter a name.")
    if kind != "contacts" and not clean["company"]:
        raise ValidationError("Enter a company.")
    if clean.get("email") and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", clean["email"]):
        raise ValidationError("Enter a valid email address.")
    if kind == "leads":
        if clean["follow_up_date"]:
            try:
                if date.fromisoformat(clean["follow_up_date"]).isoformat() != clean["follow_up_date"]:
                    raise ValueError
            except ValueError:
                raise ValidationError("Enter a valid follow-up date.") from None
        clean["status"] = clean["status"] or LEAD_STATUSES[0]
        if clean["status"] not in ACTIVE_LEAD_STATUSES:
            raise ValidationError("Choose a status from the lead board.")
    return clean


class ContactsConflict(Exception):
    """A concurrent change needs to be reviewed before retrying."""


class PossibleDuplicateContact(ValidationError):
    def __init__(self, contact_ids):
        super().__init__("A Contact at this Company already has this name and email.")
        self.contact_ids = contact_ids


class PossibleDuplicateLead(ValidationError):
    def __init__(self, lead_ids):
        super().__init__("This Contact already has a lead that may match.")
        self.lead_ids = lead_ids


def company_key(name):
    return " ".join(name.split()).casefold()


def complete_contact_identity(data):
    return all(''.join(char for char in data[key] if unicodedata.category(char) != 'Cf').strip()
               for key in CONTACT_CREATION_REQUIRED_FIELDS)


_LEAD_COLUMNS = """id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id),
    site_address TEXT NOT NULL, billing_address TEXT NOT NULL, description TEXT NOT NULL,
    status TEXT NOT NULL, person_snapshot TEXT"""

# SQLite lower() handles ASCII only. Keep international addresses in one
# per-company index bucket, then compare candidates with Python's casefold().
_EMAIL_BUCKET = "CASE WHEN email GLOB '*[^ -~]*' THEN '' ELSE lower(email) END"


def _migrate_lead_contact_index(db):
    # Older directories allowed one opportunity per person. SQLite cannot
    # drop an inline UNIQUE constraint, so copy its rows inside the schema transaction.
    unique_contact = db.execute("""SELECT 1 FROM pragma_index_list('leads') i
        WHERE i.origin='u' AND (SELECT group_concat(name) FROM pragma_index_info(i.name))='contact_id'""").fetchone()
    if unique_contact:
        columns = 'id,contact_id,site_address,billing_address,description,status,person_snapshot'
        if {row['name'] for row in db.execute('PRAGMA table_info(leads)')} != set(columns.split(',')):
            raise ValidationError("The leads table has an unsupported schema.")
        if db.execute("""SELECT 1 FROM sqlite_schema s, pragma_foreign_key_list(s.name) fk
                WHERE s.type='table' AND lower(fk.[table])='leads'""").fetchone():
            raise ValidationError("The leads table has an unexpected dependent table.")
        definitions = [row[0] for row in db.execute(
            "SELECT sql FROM sqlite_schema WHERE tbl_name='leads' AND type IN ('index','trigger') AND sql IS NOT NULL")]
        db.execute(f"CREATE TABLE leads_migration ({_LEAD_COLUMNS})")
        db.execute(f"INSERT INTO leads_migration(rowid,{columns}) SELECT rowid,{columns} FROM leads")
        db.execute("DROP TABLE leads")
        db.execute("ALTER TABLE leads_migration RENAME TO leads")
        for statement in definitions:
            db.execute(statement)
        if db.execute("PRAGMA foreign_key_check(leads)").fetchone():
            raise ValidationError("The leads table contains a broken contact link.")
    db.execute("CREATE INDEX IF NOT EXISTS lead_contact ON leads(contact_id)")


class ContactsStore:
    def __init__(self, path, staff_provider=None):
        self.path = Path(path)
        self.staff_provider = staff_provider or (lambda: [])
        with self.connection() as db:
            db.executescript(f"""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL);
                INSERT OR IGNORE INTO revision VALUES (1,0);
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, company TEXT NOT NULL, lookup_key TEXT NOT NULL UNIQUE,
                    billing_address TEXT NOT NULL, abn_acn TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS contacts (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, title TEXT NOT NULL,
                    email TEXT NOT NULL, account_id TEXT REFERENCES accounts(id));
                CREATE INDEX IF NOT EXISTS contact_account ON contacts(account_id);
                CREATE INDEX IF NOT EXISTS contact_identity ON contacts(account_id,name COLLATE NOCASE);
                CREATE INDEX IF NOT EXISTS contact_email_bucket ON contacts(account_id,{_EMAIL_BUCKET});
                CREATE TABLE IF NOT EXISTS leads ({_LEAD_COLUMNS});
                CREATE TABLE IF NOT EXISTS converted_leads (
                    lead_id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id),
                    account_id TEXT NOT NULL REFERENCES accounts(id), project_no TEXT NOT NULL, path TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS conversion_contact ON converted_leads(contact_id);
                CREATE INDEX IF NOT EXISTS conversion_account ON converted_leads(account_id);
                CREATE TABLE IF NOT EXISTS lead_conversion_details (
                    lead_id TEXT PRIMARY KEY REFERENCES converted_leads(lead_id),
                    converted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    snapshot TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS account_links (
                    account_id TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL,
                    target_id TEXT NOT NULL, label TEXT NOT NULL,
                    PRIMARY KEY(account_id,kind,target_id));
            """)
            if "abn_acn" not in {row[1] for row in db.execute("PRAGMA table_info(accounts)")}:
                db.execute("ALTER TABLE accounts ADD COLUMN abn_acn TEXT NOT NULL DEFAULT ''")
            if "person_snapshot" not in {row[1] for row in db.execute("PRAGMA table_info(leads)")}:
                # Old leads retain their exact join-based behaviour until edited.
                db.execute("ALTER TABLE leads ADD COLUMN person_snapshot TEXT")
            _migrate_lead_contact_index(db)
            db.execute("""CREATE TABLE IF NOT EXISTS lead_followups (
                lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
                next_action TEXT NOT NULL, follow_up_date TEXT NOT NULL)""")
            crm_identity.initialize(db)
            crm_activity.schema(db)

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db

    def validate_purchase_parties(self, order, changed):
        """Check new directory selections without changing historical document labels."""
        with self.connection() as db:
            db.execute("BEGIN")
            if 'supplier_account_id' in changed:
                row = db.execute("SELECT company FROM accounts WHERE id=?", (order['supplier_account_id'],)).fetchone()
                if not row or row['company'] != order['supplier'] or order['supplier_account_id'] in crm_identity.aliases(db)['accounts']:
                    raise ValidationError('Choose the matching Company.')
            if 'supplier_contact_id' in changed:
                row = db.execute("SELECT name,account_id FROM contacts WHERE id=?", (order['supplier_contact_id'],)).fetchone()
                mappings = crm_identity.aliases(db)
                owner = (row['account_id'] or '') if row else ''
                supplier = order.get('supplier_account_id', '')
                if (not row or row['name'] != order['supplier_contact']
                        or order['supplier_contact_id'] in mappings['contacts']
                        or mappings['accounts'].get(owner, owner) != mappings['accounts'].get(supplier, supplier)):
                    raise ValidationError('Choose an existing Contact linked to this Company.')
            if 'site_contact_id' in changed:
                row = db.execute("SELECT name FROM contacts WHERE id=?", (order['site_contact_id'],)).fetchone()
                if not row or row['name'] != order['ship_to_name'] or order['site_contact_id'] in crm_identity.aliases(db)['contacts']:
                    raise ValidationError('Choose an existing Contact for this name, or enter the name without a Contact link.')

    def list(self, *, history_contact_id=None, history_account_id=None, raw_identities=False, lead_board=False):
        with self.connection() as db:
            db.execute("BEGIN")
            contacts = """
                SELECT c.id, c.name, c.phone, c.title, c.email, c.account_id,
                       coalesce(a.company,'') AS company, coalesce(a.abn_acn,'') AS abn_acn
                FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id
            """
            result = {
                "version": self._version(db), "statuses": LEAD_STATUSES,
                "accounts": [dict(row) for row in db.execute("SELECT id,company,billing_address,abn_acn FROM accounts ORDER BY lookup_key")],
                "contacts": [dict(row) for row in db.execute(contacts + " ORDER BY c.name COLLATE NOCASE,c.id")],
                "leads": [self._lead_record(row) for row in db.execute(f"""
                    SELECT l.*, p.name, p.phone, p.title, p.email, p.company, p.account_id, p.abn_acn,
                           coalesce(f.next_action,'') AS next_action, coalesce(f.follow_up_date,'') AS follow_up_date
                    FROM leads l JOIN ({contacts}) p ON p.id=l.contact_id
                    LEFT JOIN lead_followups f ON f.lead_id=l.id
                    ORDER BY p.name COLLATE NOCASE,l.id
                """)],
            }
            crm_activity.add_metadata(db,result)
            result['sales_stages'] = ACTIVE_LEAD_STATUSES
            if lead_board:
                result['converted_leads'] = self._converted_lead_history(db, None, None)
            if history_contact_id or history_account_id:
                result['converted_leads'] = self._converted_lead_history(db, history_contact_id, history_account_id)
            crm_identity.project_directory(db, result, raw_identities)
            return result

    @staticmethod
    def _lead_record(row):
        value = dict(row)
        snapshot = value.pop('person_snapshot', None)
        if snapshot is not None:
            value.update(json.loads(snapshot))
        value['status'] = active_lead_status(value['status'], value)
        return value

    @staticmethod
    def _version(db):
        return db.execute("SELECT version FROM revision WHERE id=1").fetchone()[0]

    @contextmanager
    def writing(self, version, actor=None):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if type(version) is not int or self._version(db) != version:
                raise ContactsConflict("Contacts have changed. Reopen the form to review the latest values.")
            crm_activity.begin_tracking(db)
            yield db
            crm_activity.finish_tracking(db, actor)
            crm_identity.index_changes(db)
            db.execute("UPDATE revision SET version=version+1 WHERE id=1")

    @staticmethod
    def _account(db, company, billing_address="", abn_acn="", identity_review=None):
        if not company:
            return None
        key = company_key(company)
        found = db.execute("SELECT id,company,billing_address,abn_acn FROM accounts WHERE lookup_key=?", (key,)).fetchone()
        if found:
            if found['id'] in crm_identity.aliases(db)['accounts']:
                raise crm_identity.IdentityConflict('This company was merged. Select its current directory entry.')
            if abn_acn and found["abn_acn"] and abn_acn != found["abn_acn"]:
                prior = crm_identity.keys('accounts',dict(found))['ABN/ACN']
                if not prior or prior != crm_identity.keys('accounts',{'abn_acn':abn_acn})['ABN/ACN']:
                    raise ValidationError("Company already has a different ABN/ACN. Edit its company details first.")
            if abn_acn and not found["abn_acn"]:
                crm_identity.check_save(db,'accounts',{'company':found['company'],'billing_address':billing_address or found['billing_address'],
                    'abn_acn':abn_acn},found['id'],identity_review or {})
            if billing_address and not found["billing_address"]:
                db.execute("UPDATE accounts SET billing_address=? WHERE id=?", (billing_address, found["id"]))
            if abn_acn and not found["abn_acn"]:
                db.execute("UPDATE accounts SET abn_acn=? WHERE id=?", (abn_acn, found["id"]))
            return found["id"]
        ident = str(uuid4())
        db.execute("INSERT INTO accounts(id,company,lookup_key,billing_address,abn_acn) VALUES (?,?,?,?,?)",
                   (ident, company, key, billing_address, abn_acn))
        return ident

    def _person(self, db, person_id, data, *, check_duplicate=False, account_id=None):
        account = account_id or self._account(db, data["company"], data.get("billing_address", ""), data.get("abn_acn", ""))
        if check_duplicate and account and data["email"]:
            # Account and email narrow the search to a small indexed set.
            # A shared mailbox by itself does not identify an individual.
            email = data["email"].casefold()
            candidates = db.execute(f"""SELECT id,name,email FROM contacts WHERE account_id=?
                AND {_EMAIL_BUCKET} IN (?, '') ORDER BY id""", (account, email))
            name = " ".join(data["name"].split()).casefold()
            matches = [row["id"] for row in candidates if row["email"].casefold() == email
                       and " ".join(row["name"].split()).casefold() == name]
            if matches:
                raise PossibleDuplicateContact(matches)
        db.execute("""INSERT INTO contacts(id,name,phone,title,email,account_id) VALUES(?,?,?,?,?,?)
                      ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,
                      title=excluded.title,email=excluded.email,account_id=excluded.account_id""",
                   (person_id, data["name"], data["phone"], data["title"], data["email"], account))

    @staticmethod
    def _id(db, table, ident):
        if ident is None:
            return str(uuid4())
        if (not isinstance(ident, str) or not re.fullmatch(r"[a-f0-9-]{36}", ident)
                or not db.execute(f"SELECT 1 FROM {table} WHERE id=?", (ident,)).fetchone()):
            raise ValidationError("This record could not be found. Reload the directory.")
        return ident

    def saved_links(self, account_id):
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT kind,target_id,label FROM account_links WHERE account_id=? ORDER BY kind,label,target_id", (account_id,))]

    @staticmethod
    def _converted_lead_history(db, contact_id, account_id):
        # Read history and active leads from the same directory revision.
        where, values = '', ()
        if contact_id or account_id:
            column, value = ('contact_id', contact_id) if contact_id else ('account_id', account_id)
            group = crm_identity.group_ids(crm_identity.aliases(db)['contacts' if contact_id else 'accounts'], value)
            placeholders = ','.join('?' for _ in group)
            where, values = f'WHERE r.{column} IN ({placeholders})', tuple(group)
        rows = db.execute(f"""SELECT r.lead_id,r.project_no,d.converted_at,d.snapshot,e.actor_id,e.actor_name
            FROM converted_leads r LEFT JOIN lead_conversion_details d ON d.lead_id=r.lead_id
            LEFT JOIN crm_events e ON e.lead_id=r.lead_id AND e.event_type='Converted'
            {where} ORDER BY d.converted_at DESC,r.project_no,r.lead_id""", values)
        return [{key:val for key,val in {**dict(row),'snapshot':json.loads(row['snapshot']) if row['snapshot'] else None}.items()
                 if val is not None or key not in ('actor_id','actor_name')} for row in rows]

    @staticmethod
    def _checked_links(db, ident, raw, catalog):
        if (not isinstance(raw, dict) or set(raw) != set(LINK_KINDS)
                or not isinstance(catalog, dict)):
            raise ValidationError("Choose related records from the company form.")
        checked = {}
        prior = {(row["kind"], row["target_id"]): row["label"] for row in db.execute(
            "SELECT kind,target_id,label FROM account_links WHERE account_id=?", (ident,))}
        for kind in LINK_KINDS:
            values = raw[kind]
            if (not isinstance(values, list) or len(values) > 1000
                    or any(not isinstance(value, str) or len(value) > 80 for value in values)
                    or len(set(values)) != len(values)):
                raise ValidationError("Choose each related record once (maximum 1,000 per section).")
            if kind == "contacts":
                known = {row[0] for row in db.execute("SELECT id FROM contacts")}
                mappings = crm_identity.aliases(db)
                if any(value not in known or value in mappings['contacts'] for value in values):
                    raise ValidationError("A selected contact is no longer available. Reopen the company.")
                selected = set(values)
                inherited = {row['id'] for row in catalog['linked']['contacts'] if row.get('inherited')}
                selected -= inherited
                omitted_lead = db.execute("""SELECT c.id FROM contacts c JOIN leads l ON l.contact_id=c.id
                    WHERE c.account_id=?""", (ident,)).fetchall()
                if any(row[0] not in selected and row[0] not in mappings['contacts'] for row in omitted_lead):
                    raise ValidationError("A contact linked to a lead must keep a company. Reassign it to another company instead.")
                checked[kind] = sorted(selected)
                continue
            choices = {entry["id"]: entry for entry in catalog["choices"][kind]}
            automatic = {entry["id"] for entry in catalog["linked"][kind] if entry.get("automatic")}
            inherited = {entry['id'] for entry in catalog['linked'][kind] if entry.get('inherited')}
            entries = []
            for value in values:
                if value in inherited:
                    continue
                entry = choices.get(value)
                if entry is None and (kind, value) not in prior:
                    raise ValidationError("A selected related record is no longer available. Reload the list before linking it.")
                if value not in automatic or (kind, value) in prior:
                    entries.append((value, entry["label"] if entry else prior[kind, value]))
            checked[kind] = entries
        return checked

    @staticmethod
    def _replace_links(db, ident, links):
        selected = set(links["contacts"])
        merged_people = crm_identity.aliases(db)['contacts']
        for row in db.execute("SELECT id FROM contacts WHERE account_id=?", (ident,)).fetchall():
            if row[0] not in selected and row[0] not in merged_people:
                db.execute("UPDATE contacts SET account_id=NULL WHERE id=?", (row[0],))
        db.executemany("UPDATE contacts SET account_id=? WHERE id=?", ((ident, person) for person in selected))
        wanted = {(kind, target):label for kind in LINK_KINDS if kind != 'contacts' for target,label in links[kind]}
        prior = {(row['kind'],row['target_id']):row['label'] for row in db.execute(
            'SELECT kind,target_id,label FROM account_links WHERE account_id=?',(ident,))}
        db.executemany("DELETE FROM account_links WHERE account_id=? AND kind=? AND target_id=?",
                       ((ident,*key) for key in prior.keys()-wanted.keys()))
        db.executemany("""INSERT INTO account_links(account_id,kind,target_id,label) VALUES(?,?,?,?)
            ON CONFLICT(account_id,kind,target_id) DO UPDATE SET label=excluded.label""",
            ((ident,*key,label) for key,label in wanted.items() if prior.get(key)!=label))

    def save(self, kind, body, *, link_catalog=None, actor=None):
        if not isinstance(body, dict):
            raise ValidationError("Use the fields provided on this form.")
        data = checked_fields(kind, body.get("fields"))
        # Explicit New Contact actions have minimum identity details. Legacy
        # imports and edits retain their existing, more permissive contract.
        if kind == "contacts" and not body.get("id") and not complete_contact_identity(data):
            raise ValidationError(CONTACT_CREATION_REQUIRED_MESSAGE)
        if "links" in body and kind != "accounts":
            raise ValidationError("Related records can only be changed from a company.")
        with self.writing(body.get("version"), actor) as db:
            prior_id = body.get("id")
            ident = self._id(db, kind, prior_id)
            mappings = crm_identity.aliases(db)
            if ident in mappings.get(kind, {}):
                raise crm_identity.IdentityConflict('This record was merged. Open its current directory entry.')
            if kind == 'accounts' and "links" in body and (ident in mappings['accounts'].values()
                    or any(row.get('inherited') for rows in (link_catalog or {}).get('linked', {}).values() for row in rows)
                    or db.execute("""SELECT 1 FROM contacts c JOIN crm_contact_merges m ON m.source_id=c.id
                         WHERE c.account_id=? AND m.undone_at IS NULL LIMIT 1""", (ident,)).fetchone()):
                if body.get('identity_version') != 1 or (link_catalog or {}).get('version') != body.get('version'):
                    raise crm_identity.IdentityConflict('Reopen the company to review links from merged records.')
            links = self._checked_links(db, ident, body["links"], link_catalog) if "links" in body else None
            if kind == "leads":
                previous = db.execute("""SELECT l.contact_id,l.person_snapshot,l.site_address,l.status,c.account_id,c.phone,c.email
                    FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?""", (ident,)).fetchone() if prior_id else None
                person_id = body.get('contact_id', previous['contact_id'] if previous else '')
                prior_snapshot = json.loads(previous['person_snapshot']) if previous and previous['person_snapshot'] else {}
                prior_stage = active_lead_status(previous['status'], prior_snapshot or previous) if previous else 'New'
                if 'status' not in body['fields']:
                    data['status'] = prior_stage
                selected_contact = person_id and (not previous or person_id != previous['contact_id'])
                data['status'] = active_lead_status(data['status'], data, selected_contact=selected_contact)
                # Keep historic spellings on unrelated edits so the activity timeline
                # only records a stage change when the board actually changes stage.
                if previous and prior_stage == data['status'] == active_lead_status(previous['status'], data):
                    data['status'] = previous['status']
                if person_id:
                    self._id(db, 'contacts', person_id)
                    if person_id in mappings['contacts'] and not (previous and previous['contact_id'] == person_id):
                        raise crm_identity.IdentityConflict('This contact was merged. Select its current directory entry.')
                elif person_id != '' and person_id is not None:
                    raise ValidationError('Choose a valid Contact.')
                if previous and not prior_snapshot and previous['account_id'] in mappings['accounts']:
                    # Preserve the raw employer behind a legacy lead's documented
                    # join fallback when saving an otherwise unchanged enquiry.
                    old = db.execute('SELECT company,abn_acn FROM accounts WHERE id=?', (previous['account_id'],)).fetchone()
                    prior_snapshot = {**dict(old), 'account_id':previous['account_id']}
                # An unchanged lead snapshot stays linked even after the Company is renamed
                # or its ABN changes. A new selection must match today's directory.
                same_snapshot = (prior_snapshot and company_key(prior_snapshot['company']) == company_key(data['company'])
                                 and prior_snapshot['abn_acn'] == data['abn_acn']
                                 and body.get('account_id', prior_snapshot['account_id']) == prior_snapshot['account_id'])
                if same_snapshot:
                    account = prior_snapshot['account_id']
                else:
                    account = body.get('account_id')
                    if account:
                        self._id(db, 'accounts', account)
                        company = db.execute('SELECT company FROM accounts WHERE id=?', (account,)).fetchone()['company']
                        if company_key(company) != company_key(data['company']):
                            raise ValidationError('Choose the matching Company.')
                    elif account != '' and account is not None:
                        raise ValidationError('Choose a valid Company.')
                    if not db.execute('SELECT 1 FROM accounts WHERE lookup_key=?', (company_key(data['company']),)).fetchone():
                        crm_identity.check_save(db, 'accounts', {key:data[key] for key in ACCOUNT_FIELDS}, None, body)
                    account = self._account(db, data['company'], data['billing_address'], data['abn_acn'], body)
                if not person_id:
                    person_id = str(uuid4())
                    crm_identity.check_save(db, 'contacts', data, None, body, account)
                    self._person(db, person_id, data, account_id=account)
                site = company_key(data['site_address'])
                prior_account = prior_snapshot.get('account_id') or (previous['account_id'] if previous else None)
                same_opportunity = (previous and person_id == previous['contact_id'] and account == prior_account
                                    and site == company_key(previous['site_address']))
                if not same_opportunity and body.get('keep_separate_lead') is not True:
                    matches = []
                    person_ids = crm_identity.group_ids(mappings['contacts'], person_id)
                    company_ids = crm_identity.group_ids(mappings['accounts'], account)
                    placeholders = ','.join('?' for _ in person_ids)
                    related = db.execute(f"""SELECT l.id,l.site_address,l.description,l.person_snapshot,c.account_id
                        FROM leads l JOIN contacts c ON c.id=l.contact_id
                        WHERE l.contact_id IN ({placeholders}) AND l.id<>? ORDER BY l.id""", (*person_ids, ident))
                    for other in related:
                        other_account = json.loads(other['person_snapshot'])['account_id'] if other['person_snapshot'] else other['account_id']
                        if other_account not in company_ids or (site and site != company_key(other['site_address'])):
                            continue
                        if data['description'] and other['description'] and company_key(data['description']) != company_key(other['description']):
                            continue
                        matches.append(other['id'])
                    if matches:
                        raise PossibleDuplicateLead(matches)
                snapshot = {key: data[key] for key in (*PERSON_FIELDS, 'abn_acn')}
                account_values = prior_snapshot if same_snapshot else db.execute(
                    'SELECT company,abn_acn FROM accounts WHERE id=?', (account,)).fetchone()
                snapshot.update(company=account_values['company'], abn_acn=account_values['abn_acn'])
                snapshot['account_id'] = account
                db.execute("""INSERT INTO leads(id,contact_id,site_address,billing_address,description,status,person_snapshot)
                              VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contact_id=excluded.contact_id,
                              site_address=excluded.site_address,billing_address=excluded.billing_address,
                              description=excluded.description,status=excluded.status,person_snapshot=excluded.person_snapshot""",
                           (ident, person_id, data["site_address"], data["billing_address"], data["description"], data["status"],
                            json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))))
                # Older forms and stage-only updates omit both fields. Keep the
                # saved follow-up unless the caller explicitly edits it.
                if {"next_action", "follow_up_date"} & body["fields"].keys():
                    prior = db.execute("SELECT next_action,follow_up_date FROM lead_followups WHERE lead_id=?", (ident,)).fetchone()
                    action, due = (data[key] if key in body["fields"] else prior[key] if prior else ""
                                   for key in ("next_action", "follow_up_date"))
                    if action or due:
                        db.execute("""INSERT INTO lead_followups(lead_id,next_action,follow_up_date) VALUES(?,?,?)
                                   ON CONFLICT(lead_id) DO UPDATE SET next_action=excluded.next_action,
                                   follow_up_date=excluded.follow_up_date""", (ident, action, due))
                    else:
                        db.execute("DELETE FROM lead_followups WHERE lead_id=?", (ident,))
            elif kind == "contacts":
                if not data['company']:
                    person_ids = crm_identity.group_ids(mappings['contacts'], ident)
                    placeholders = ','.join('?' for _ in person_ids)
                    if db.execute(f'SELECT 1 FROM leads WHERE contact_id IN ({placeholders})', tuple(person_ids)).fetchone():
                        raise ValidationError("A contact linked to a lead must have a company.")
                account = self._account(db, data['company'])
                crm_identity.check_save(db, 'contacts', data, prior_id, body, account)
                if prior_id:
                    old_owner = db.execute('SELECT account_id FROM contacts WHERE id=?', (prior_id,)).fetchone()[0]
                    if old_owner in mappings['accounts'] and mappings['accounts'][old_owner] == account:
                        account = old_owner
                self._person(db, ident, data, account_id=account)
            else:
                key = company_key(data["company"])
                conflict = db.execute("SELECT id FROM accounts WHERE lookup_key=? AND id<>?", (key, ident)).fetchone()
                if conflict:
                    raise ValidationError("A company with this name already exists.")
                if prior_id and "abn_acn" not in body["fields"]:
                    data["abn_acn"] = db.execute("SELECT abn_acn FROM accounts WHERE id=?", (ident,)).fetchone()[0]
                crm_identity.check_save(db, 'accounts', data, prior_id, body)
                db.execute("""INSERT INTO accounts(id,company,lookup_key,billing_address,abn_acn) VALUES(?,?,?,?,?)
                              ON CONFLICT(id) DO UPDATE SET company=excluded.company,lookup_key=excluded.lookup_key,
                              billing_address=excluded.billing_address,abn_acn=excluded.abn_acn""",
                           (ident, data["company"], key, data["billing_address"], data["abn_acn"]))
                if links is not None:
                    self._replace_links(db, ident, links)
            crm_activity.assign(db,kind,ident,body,self.staff_provider)
            version = self._version(db) + 1
            contact = None
            if kind == 'contacts':
                contact = dict(db.execute('''SELECT c.id,c.name,c.phone,c.title,c.email,c.account_id,
                    coalesce(a.company,'') AS company,coalesce(a.abn_acn,'') AS abn_acn
                    FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.id=?''', (ident,)).fetchone())
                if contact['account_id'] in mappings['accounts']:
                    owner = mappings['accounts'][contact['account_id']]
                    account = db.execute('SELECT company,abn_acn FROM accounts WHERE id=?', (owner,)).fetchone()
                    contact.update(account_id=owner, **dict(account))
        result = {"id": ident, "version": version}
        if kind == "accounts":
            result["account"] = {"id": ident, **data}
        if contact is not None:
            result['contact'] = contact
        return result

    def convert(self, body, create_project, *, actor=None):
        if not isinstance(body, dict) or set(body) != {'id', 'version'} or not isinstance(body['id'], str):
            raise ValidationError('Choose a saved lead to convert.')
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute('SELECT project_no,path FROM converted_leads WHERE lead_id=?', (body['id'],)).fetchone()
            if receipt:
                return dict(receipt)
            if type(body['version']) is not int or self._version(db) != body['version']:
                raise ContactsConflict('The lead changed. Reopen the directory before converting it.')
            lead = db.execute('''SELECT l.*,c.name,c.phone,c.title,c.email,c.account_id,a.company,a.abn_acn,
                coalesce(f.next_action,'') AS next_action,coalesce(f.follow_up_date,'') AS follow_up_date
                FROM leads l JOIN contacts c ON l.contact_id=c.id LEFT JOIN accounts a ON a.id=c.account_id
                LEFT JOIN lead_followups f ON f.lead_id=l.id
                WHERE l.id=?''', (body['id'],)).fetchone()
            if lead is None:
                raise ValidationError('This lead could not be found.')
            lead = self._lead_record(lead)
            lead.update(crm_activity.record_metadata(db,'leads',lead['id']))
            # Validate the saved Lead snapshot before the numbered file save can
            # allocate a Project number or write a conversion replay receipt.
            # Existing conversion receipts above remain idempotent, including
            # receipts created before these minimum details were required.
            if any(not isinstance(lead.get(key), str) or not lead[key].strip()
                   for key in CONVERSION_REQUIRED_FIELDS):
                raise ValidationError(CONVERSION_REQUIRED_MESSAGE)
            # The numbered file save uses this lead's stable ID as its replay
            # key. A retry after a lost response or DB rollback reuses the file.
            result = create_project(lead)
            db.execute('INSERT INTO converted_leads VALUES (?,?,?,?,?)',
                       (lead['id'], lead['contact_id'], lead['account_id'], result['project_no'], result['path']))
            db.execute('INSERT INTO lead_conversion_details(lead_id,snapshot) VALUES (?,?)',
                       (lead['id'], json.dumps(lead, ensure_ascii=False, separators=(',', ':'))))
            crm_activity.event(db,'leads',lead['id'],'Converted',{'project_no':result['project_no'],'status':lead['status']},actor)
            db.execute('DELETE FROM leads WHERE id=?', (lead['id'],))
            db.execute('UPDATE revision SET version=version+1 WHERE id=1')
            return result

    def import_rows(self, kind, records, version, *, actor=None):
        if kind not in {"accounts", "contacts"}:
            raise ValidationError("Select the Contacts or Companies template.")
        added = skipped = 0
        with self.writing(version, actor) as db:
            for row_number, raw in records:
                try:
                    data = checked_fields(kind, raw)
                    if kind == "accounts":
                        existing = db.execute("SELECT billing_address FROM accounts WHERE lookup_key=?",
                                              (company_key(data["company"]),)).fetchone()
                        if existing and existing[0] and data["billing_address"] and existing[0] != data["billing_address"]:
                            raise ValidationError("Company already has a different billing address. Edit its company details first.")
                        if not existing:
                            crm_identity.check_save(db, 'accounts', data, None, {})
                        self._account(db, data["company"], data["billing_address"], data["abn_acn"])
                        duplicate = existing is not None
                    else:
                        account = self._account(db, data["company"])
                        duplicate = db.execute("""SELECT 1 FROM contacts WHERE name=? COLLATE NOCASE
                            AND phone=? AND title=? AND email=? COLLATE NOCASE AND account_id IS ?""",
                            (data["name"], data["phone"], data["title"], data["email"], account)).fetchone() is not None
                        if not duplicate:
                            crm_identity.check_save(db, 'contacts', data, None, {}, account)
                            self._person(db, str(uuid4()), data, check_duplicate=True)
                    skipped += int(duplicate)
                    added += int(not duplicate)
                    crm_identity.index_changes(db)
                except crm_identity.DuplicateReview as exc:
                    first = exc.decision['matches'][0]
                    reasons = ', '.join(first['reasons'])
                    raise ValidationError(f'Row {row_number}: review the possible duplicate ({reasons}) in the directory before importing.') from exc
                except ValidationError as exc:
                    raise ValidationError(f"Row {row_number}: {exc}") from exc
        return {"added": added, "matched": skipped}
