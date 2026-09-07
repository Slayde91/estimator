"""SQLite persistence: baseline, live settings, and per-quote pricing snapshots."""

from datetime import datetime, timezone
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import uuid

from .calculator import calculate
from .catalog import baseline, catalog_signature, effective_catalog, validate_configuration, ValidationError

WORKFLOWS = (
    "Intumescent spray to ductwork", "Intumescent spray to structural steel",
    "Intumescent spray to slabs", "Intumescent spray to walls",
    "Vermiculite spray", "Fire wrap to ductwork",
)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS quotes (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
                );
                PRAGMA user_version=1;
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def configuration(self):
        with self.connect() as db:
            row = db.execute("SELECT data FROM settings WHERE id=1").fetchone()
        return json.loads(row[0]) if row else {"inventory": {}, "rates": {}}

    def save_configuration(self, value):
        value = validate_configuration(value)
        with self.connect() as db:
            db.execute("INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (json.dumps(value, allow_nan=False),))
        return value

    def list_quotes(self):
        with self.connect() as db:
            return [dict(zip(("id", "title", "updated_at"), row)) for row in db.execute("SELECT id,title,updated_at FROM quotes ORDER BY updated_at DESC,id")]

    def quote(self, quote_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM quotes WHERE id=?", (quote_id,)).fetchone()
        if row is None:
            raise KeyError(quote_id)
        return json.loads(row[0])

    def prepare_quote(self, data, quote_id=None):
        """Validate and calculate a pricing snapshot without writing a quote."""
        if not isinstance(data, dict) or set(data) - {"title", "inputs", "configuration", "workflow", "measurements"}:
            raise ValidationError("Quote contains unknown fields.")
        previous = self.quote(quote_id) if quote_id else None
        title = data.get("title", "Untitled quote")
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValidationError("Quote title must contain 1 to 200 characters.")
        workflow = data.get("workflow", WORKFLOWS[0])
        if not isinstance(workflow, str) or len(workflow) > 200:
            raise ValidationError("Workflow must be text of at most 200 characters.")
        measurements = data.get("measurements", "")
        if not isinstance(measurements, str) or len(measurements) > 20000:
            raise ValidationError("Measurement notes must be text of at most 20000 characters.")
        configuration = validate_configuration(data.get("configuration", previous["configuration"] if previous else self.configuration()))
        pricing_changed = previous is None or configuration != previous["configuration"]
        # Freeze all effective lookup prices/yields, including unchanged defaults.
        # Storing only user overrides would let a future baseline price refresh
        # silently change an old quote when it is reopened and recalculated.
        catalog = effective_catalog(configuration)
        configuration["rates"] = {
            rate["id"]: {"price": rate["price"], **({"yield": rate["yield"]} if rate["source"].get("yield") else {})}
            for rates in catalog["rate_groups"].values() for rate in rates
        }
        configuration["catalog_signature"] = catalog_signature(catalog)
        result = calculate(data.get("inputs", {}), configuration)
        quote = {"id": quote_id or str(uuid.uuid4()), "title": title.strip(),
                 "updated_at": datetime.now(timezone.utc).isoformat(), "workflow": workflow,
                 "measurements": measurements, "inputs": result["inputs"],
                 "configuration": configuration, "result": result,
                 "source_hashes": baseline()["sources"] if pricing_changed else previous["source_hashes"], "schema_version": 1}
        return quote

    def save_quote(self, data, quote_id=None):
        quote = self.prepare_quote(data, quote_id)
        with self.connect() as db:
            db.execute("INSERT INTO quotes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, data=excluded.data",
                       (quote["id"], quote["title"], quote["updated_at"], json.dumps(quote, ensure_ascii=False, allow_nan=False)))
        return quote
