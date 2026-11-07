"""Company-wide leads, people and accounts in the local application database."""

from contextlib import closing, contextmanager
from pathlib import Path
import re
import sqlite3
from uuid import uuid4

from .catalog import ValidationError


LEAD_STATUSES = ("New", "Assisting", "Interstate", "Qualified", "Disqualified", "Not Applicable")
PERSON_FIELDS = ("name", "phone", "company", "title", "email")
ACCOUNT_FIELDS = ("company", "billing_address")
LEAD_FIELDS = (*PERSON_FIELDS, "site_address", "billing_address", "description", "status")
FIELDS = {"leads": LEAD_FIELDS, "contacts": PERSON_FIELDS, "accounts": ACCOUNT_FIELDS}
LIMITS = {"name": 160, "phone": 60, "company": 240, "title": 160, "email": 254,
          "site_address": 1200, "billing_address": 1200, "description": 8000, "status": 100}


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
                    billing_address TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS contacts (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, title TEXT NOT NULL,
                    email TEXT NOT NULL, account_id TEXT REFERENCES accounts(id));
                CREATE INDEX IF NOT EXISTS contact_account ON contacts(account_id);
                CREATE INDEX IF NOT EXISTS contact_identity ON contacts(account_id,name COLLATE NOCASE);
                CREATE TABLE IF NOT EXISTS leads (
                    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id),
                    site_address TEXT NOT NULL, billing_address TEXT NOT NULL,
                    description TEXT NOT NULL, status TEXT NOT NULL);
            """)

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
                       coalesce(a.company,'') AS company
                FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id
            """
            return {
                "version": self._version(db), "statuses": LEAD_STATUSES,
                "accounts": [dict(row) for row in db.execute("SELECT id,company,billing_address FROM accounts ORDER BY lookup_key")],
                "contacts": [dict(row) for row in db.execute(contacts + " ORDER BY c.name COLLATE NOCASE,c.id")],
                "leads": [dict(row) for row in db.execute(f"""
                    SELECT l.*, p.name, p.phone, p.title, p.email, p.company, p.account_id
                    FROM leads l JOIN ({contacts}) p ON p.id=l.contact_id
                    ORDER BY p.name COLLATE NOCASE,l.id
                """)],
            }

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
    def _account(db, company, billing_address=""):
        if not company:
            return None
        key = company_key(company)
        found = db.execute("SELECT id,billing_address FROM accounts WHERE lookup_key=?", (key,)).fetchone()
        if found:
            if billing_address and not found["billing_address"]:
                db.execute("UPDATE accounts SET billing_address=? WHERE id=?", (billing_address, found["id"]))
            return found["id"]
        ident = str(uuid4())
        db.execute("INSERT INTO accounts VALUES (?,?,?,?)", (ident, company, key, billing_address))
        return ident

    def _person(self, db, person_id, data):
        account = self._account(db, data["company"], data.get("billing_address", ""))
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

    def save(self, kind, body):
        data = checked_fields(kind, body.get("fields"))
        with self.writing(body.get("version")) as db:
            prior_id = body.get("id")
            ident = self._id(db, kind, prior_id)
            if kind == "leads":
                person_id = db.execute("SELECT contact_id FROM leads WHERE id=?", (ident,)).fetchone()[0] if prior_id else str(uuid4())
                self._person(db, person_id, data)
                db.execute("""INSERT INTO leads VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                              site_address=excluded.site_address,billing_address=excluded.billing_address,
                              description=excluded.description,status=excluded.status""",
                           (ident, person_id, data["site_address"], data["billing_address"], data["description"], data["status"]))
            elif kind == "contacts":
                if not data["company"] and db.execute("SELECT 1 FROM leads WHERE contact_id=?", (ident,)).fetchone():
                    raise ValidationError("A contact linked to a lead must have a company.")
                self._person(db, ident, data)
            else:
                key = company_key(data["company"])
                conflict = db.execute("SELECT id FROM accounts WHERE lookup_key=? AND id<>?", (key, ident)).fetchone()
                if conflict:
                    raise ValidationError("An account with this company name already exists.")
                db.execute("""INSERT INTO accounts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                              company=excluded.company,lookup_key=excluded.lookup_key,billing_address=excluded.billing_address""",
                           (ident, data["company"], key, data["billing_address"]))
        return {"id": ident}

    def import_rows(self, kind, records, version):
        if kind not in {"accounts", "contacts"}:
            raise ValidationError("Select the Contacts or Accounts template.")
        added = skipped = 0
        with self.writing(version) as db:
            for row_number, raw in records:
                try:
                    data = checked_fields(kind, raw)
                    if kind == "accounts":
                        existing = db.execute("SELECT billing_address FROM accounts WHERE lookup_key=?",
                                              (company_key(data["company"]),)).fetchone()
                        if existing and existing[0] and data["billing_address"] and existing[0] != data["billing_address"]:
                            raise ValidationError("Company already has a different billing address. Edit its account first.")
                        self._account(db, data["company"], data["billing_address"])
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
