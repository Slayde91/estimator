"""Company-wide leads, people and accounts in the local application database."""

from contextlib import closing, contextmanager
import json
from pathlib import Path
import re
import sqlite3
from uuid import uuid4

from .catalog import ValidationError


LEAD_STATUSES = ("New", "Assisting", "Interstate", "Qualified", "Disqualified", "Not Applicable")
PERSON_FIELDS = ("name", "phone", "company", "title", "email")
ACCOUNT_FIELDS = ("company", "billing_address", "abn_acn")
LEAD_FIELDS = (*PERSON_FIELDS, "site_address", "billing_address", "description", "status", "abn_acn")
CONVERSION_REQUIRED_FIELDS = ("name", "phone", "company", "email", "site_address")
CONVERSION_REQUIRED_MESSAGE = "Complete Name, Phone, Company, Email and Site address before converting this Lead."
LINK_KINDS = ("contacts", "projects", "quotes", "work_orders", "purchase_orders")
FIELDS = {"leads": LEAD_FIELDS, "contacts": PERSON_FIELDS, "accounts": ACCOUNT_FIELDS}
LIMITS = {"name": 160, "phone": 60, "company": 240, "title": 160, "email": 254,
          "site_address": 1200, "billing_address": 1200, "description": 8000, "status": 100, "abn_acn": 80}


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
        clean["status"] = clean["status"] or LEAD_STATUSES[0]
        if clean["status"] not in LEAD_STATUSES:
            raise ValidationError("Choose a status from the lead board.")
    return clean


class ContactsConflict(Exception):
    """A concurrent change needs to be reviewed before retrying."""


def company_key(name):
    return " ".join(name.split()).casefold()


class ContactsStore:
    def __init__(self, path):
        self.path = Path(path)
        with self.connection() as db:
            db.executescript("""
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
                CREATE TABLE IF NOT EXISTS leads (
                    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id),
                    site_address TEXT NOT NULL, billing_address TEXT NOT NULL,
                    description TEXT NOT NULL, status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS converted_leads (
                    lead_id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id),
                    account_id TEXT NOT NULL REFERENCES accounts(id), project_no TEXT NOT NULL, path TEXT NOT NULL);
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

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db

    def list(self):
        with self.connection() as db:
            db.execute("BEGIN")
            contacts = """
                SELECT c.id, c.name, c.phone, c.title, c.email, c.account_id,
                       coalesce(a.company,'') AS company, coalesce(a.abn_acn,'') AS abn_acn
                FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id
            """
            return {
                "version": self._version(db), "statuses": LEAD_STATUSES,
                "accounts": [dict(row) for row in db.execute("SELECT id,company,billing_address,abn_acn FROM accounts ORDER BY lookup_key")],
                "contacts": [dict(row) for row in db.execute(contacts + " ORDER BY c.name COLLATE NOCASE,c.id")],
                "leads": [self._lead_record(row) for row in db.execute(f"""
                    SELECT l.*, p.name, p.phone, p.title, p.email, p.company, p.account_id, p.abn_acn
                    FROM leads l JOIN ({contacts}) p ON p.id=l.contact_id
                    ORDER BY p.name COLLATE NOCASE,l.id
                """)],
            }

    @staticmethod
    def _lead_record(row):
        value = dict(row)
        snapshot = value.pop('person_snapshot', None)
        if snapshot is not None:
            value.update(json.loads(snapshot))
        return value

    @staticmethod
    def _version(db):
        return db.execute("SELECT version FROM revision WHERE id=1").fetchone()[0]

    @contextmanager
    def writing(self, version):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if type(version) is not int or self._version(db) != version:
                raise ContactsConflict("Contacts have changed. Reopen the form to review the latest values.")
            yield db
            db.execute("UPDATE revision SET version=version+1 WHERE id=1")

    @staticmethod
    def _account(db, company, billing_address="", abn_acn=""):
        if not company:
            return None
        key = company_key(company)
        found = db.execute("SELECT id,billing_address,abn_acn FROM accounts WHERE lookup_key=?", (key,)).fetchone()
        if found:
            if abn_acn and found["abn_acn"] and abn_acn != found["abn_acn"]:
                raise ValidationError("Company already has a different ABN/ACN. Edit its company details first.")
            if billing_address and not found["billing_address"]:
                db.execute("UPDATE accounts SET billing_address=? WHERE id=?", (billing_address, found["id"]))
            if abn_acn and not found["abn_acn"]:
                db.execute("UPDATE accounts SET abn_acn=? WHERE id=?", (abn_acn, found["id"]))
            return found["id"]
        ident = str(uuid4())
        db.execute("INSERT INTO accounts(id,company,lookup_key,billing_address,abn_acn) VALUES (?,?,?,?,?)",
                   (ident, company, key, billing_address, abn_acn))
        return ident

    def _person(self, db, person_id, data):
        account = self._account(db, data["company"], data.get("billing_address", ""), data.get("abn_acn", ""))
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
                if any(value not in known for value in values):
                    raise ValidationError("A selected contact is no longer available. Reopen the company.")
                selected = set(values)
                omitted_lead = db.execute("""SELECT c.id FROM contacts c JOIN leads l ON l.contact_id=c.id
                    WHERE c.account_id=?""", (ident,)).fetchall()
                if any(row[0] not in selected for row in omitted_lead):
                    raise ValidationError("A contact linked to a lead must keep a company. Reassign it to another company instead.")
                checked[kind] = values
                continue
            choices = {entry["id"]: entry for entry in catalog["choices"][kind]}
            automatic = {entry["id"] for entry in catalog["linked"][kind] if entry.get("automatic")}
            entries = []
            for value in values:
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
        for row in db.execute("SELECT id FROM contacts WHERE account_id=?", (ident,)).fetchall():
            if row[0] not in selected:
                db.execute("UPDATE contacts SET account_id=NULL WHERE id=?", (row[0],))
        db.executemany("UPDATE contacts SET account_id=? WHERE id=?", ((ident, person) for person in selected))
        db.execute("DELETE FROM account_links WHERE account_id=?", (ident,))
        db.executemany("INSERT INTO account_links(account_id,kind,target_id,label) VALUES(?,?,?,?)",
                       ((ident, kind, target, label) for kind in LINK_KINDS if kind != "contacts"
                        for target, label in links[kind]))

    def save(self, kind, body, *, link_catalog=None):
        if not isinstance(body, dict):
            raise ValidationError("Use the fields provided on this form.")
        data = checked_fields(kind, body.get("fields"))
        if "links" in body and kind != "accounts":
            raise ValidationError("Related records can only be changed from a company.")
        with self.writing(body.get("version")) as db:
            prior_id = body.get("id")
            ident = self._id(db, kind, prior_id)
            links = self._checked_links(db, ident, body["links"], link_catalog) if "links" in body else None
            if kind == "leads":
                previous = db.execute("SELECT contact_id FROM leads WHERE id=?", (ident,)).fetchone() if prior_id else None
                person_id = body.get('contact_id', previous['contact_id'] if previous else '')
                if person_id:
                    self._id(db, 'contacts', person_id)
                    if db.execute('SELECT 1 FROM leads WHERE contact_id=? AND id<>?', (person_id, ident)).fetchone():
                        raise ValidationError('This Contact already has a lead. Open that lead instead.')
                elif person_id != '' and person_id is not None:
                    raise ValidationError('Choose a valid Contact.')
                else:
                    person_id = str(uuid4())
                    self._person(db, person_id, data)
                account = body.get('account_id')
                if account:
                    self._id(db, 'accounts', account)
                    company = db.execute('SELECT company FROM accounts WHERE id=?', (account,)).fetchone()['company']
                    if company_key(company) != company_key(data['company']):
                        raise ValidationError('Choose the matching Company.')
                elif account != '' and account is not None:
                    raise ValidationError('Choose a valid Company.')
                account = self._account(db, data['company'], data['billing_address'], data['abn_acn'])
                snapshot = {key: data[key] for key in (*PERSON_FIELDS, 'abn_acn')}
                account_values = db.execute('SELECT company,abn_acn FROM accounts WHERE id=?', (account,)).fetchone()
                snapshot.update(company=account_values['company'], abn_acn=account_values['abn_acn'])
                snapshot['account_id'] = account
                db.execute("""INSERT INTO leads(id,contact_id,site_address,billing_address,description,status,person_snapshot)
                              VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contact_id=excluded.contact_id,
                              site_address=excluded.site_address,billing_address=excluded.billing_address,
                              description=excluded.description,status=excluded.status,person_snapshot=excluded.person_snapshot""",
                           (ident, person_id, data["site_address"], data["billing_address"], data["description"], data["status"],
                            json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))))
            elif kind == "contacts":
                if not data["company"] and db.execute("SELECT 1 FROM leads WHERE contact_id=?", (ident,)).fetchone():
                    raise ValidationError("A contact linked to a lead must have a company.")
                self._person(db, ident, data)
            else:
                key = company_key(data["company"])
                conflict = db.execute("SELECT id FROM accounts WHERE lookup_key=? AND id<>?", (key, ident)).fetchone()
                if conflict:
                    raise ValidationError("A company with this name already exists.")
                if prior_id and "abn_acn" not in body["fields"]:
                    data["abn_acn"] = db.execute("SELECT abn_acn FROM accounts WHERE id=?", (ident,)).fetchone()[0]
                db.execute("""INSERT INTO accounts(id,company,lookup_key,billing_address,abn_acn) VALUES(?,?,?,?,?)
                              ON CONFLICT(id) DO UPDATE SET company=excluded.company,lookup_key=excluded.lookup_key,
                              billing_address=excluded.billing_address,abn_acn=excluded.abn_acn""",
                           (ident, data["company"], key, data["billing_address"], data["abn_acn"]))
                if links is not None:
                    self._replace_links(db, ident, links)
            version = self._version(db) + 1
            contact = None
            if kind == 'contacts':
                contact = dict(db.execute('''SELECT c.id,c.name,c.phone,c.title,c.email,c.account_id,
                    coalesce(a.company,'') AS company,coalesce(a.abn_acn,'') AS abn_acn
                    FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.id=?''', (ident,)).fetchone())
        result = {"id": ident, "version": version}
        if kind == "accounts":
            result["account"] = {"id": ident, **data}
        if contact is not None:
            result['contact'] = contact
        return result

    def convert(self, body, create_project):
        if not isinstance(body, dict) or set(body) != {'id', 'version'} or not isinstance(body['id'], str):
            raise ValidationError('Choose a saved lead to convert.')
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute('SELECT project_no,path FROM converted_leads WHERE lead_id=?', (body['id'],)).fetchone()
            if receipt:
                return dict(receipt)
            if type(body['version']) is not int or self._version(db) != body['version']:
                raise ContactsConflict('The lead changed. Reopen the directory before converting it.')
            lead = db.execute('''SELECT l.*,c.name,c.phone,c.title,c.email,c.account_id,a.company,a.abn_acn
                FROM leads l JOIN contacts c ON l.contact_id=c.id LEFT JOIN accounts a ON a.id=c.account_id
                WHERE l.id=?''', (body['id'],)).fetchone()
            if lead is None:
                raise ValidationError('This lead could not be found.')
            lead = self._lead_record(lead)
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
            db.execute('DELETE FROM leads WHERE id=?', (lead['id'],))
            db.execute('UPDATE revision SET version=version+1 WHERE id=1')
            return result

    def import_rows(self, kind, records, version):
        if kind not in {"accounts", "contacts"}:
            raise ValidationError("Select the Contacts or Companies template.")
        added = skipped = 0
        with self.writing(version) as db:
            for row_number, raw in records:
                try:
                    data = checked_fields(kind, raw)
                    if kind == "accounts":
                        existing = db.execute("SELECT billing_address FROM accounts WHERE lookup_key=?",
                                              (company_key(data["company"]),)).fetchone()
                        if existing and existing[0] and data["billing_address"] and existing[0] != data["billing_address"]:
                            raise ValidationError("Company already has a different billing address. Edit its company details first.")
                        self._account(db, data["company"], data["billing_address"], data["abn_acn"])
                        duplicate = existing is not None
                    else:
                        account = self._account(db, data["company"])
                        duplicate = db.execute("""SELECT 1 FROM contacts WHERE name=? COLLATE NOCASE
                            AND phone=? AND title=? AND email=? COLLATE NOCASE AND account_id IS ?""",
                            (data["name"], data["phone"], data["title"], data["email"], account)).fetchone() is not None
                        if not duplicate:
                            self._person(db, str(uuid4()), data)
                    skipped += int(duplicate)
                    added += int(not duplicate)
                except ValidationError as exc:
                    raise ValidationError(f"Row {row_number}: {exc}") from exc
        return {"added": added, "matched": skipped}
