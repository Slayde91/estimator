"""SQLite persistence: baseline, live settings, and per-quote pricing snapshots."""

from datetime import datetime, timezone
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import uuid

from .calculator import calculate
from .catalog import catalog_signature, configuration_catalog, effective_catalog, has_yield, validate_catalog, validate_configuration, ValidationError
from .quote_details import QUOTE_DETAIL_LIMITS, compile_work_summary, compose_quote_title, validate_quote_details

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
                CREATE TABLE IF NOT EXISTS calculator_states (
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                PRAGMA user_version=2;
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

    def calculator_state(self, calculator_id):
        from .workbook_calculators import source_model
        from .calculator_defaults import default_calculator_inputs
        model = source_model(calculator_id)
        with self.connect() as db:
            row = db.execute('SELECT data FROM calculator_states WHERE id=?', (calculator_id,)).fetchone()
        if row is None:
            return {'inputs': default_calculator_inputs(calculator_id), 'source_sha256': model['source']['sha256']}
        state = json.loads(row[0])
        if state.get('source_sha256') != model['source']['sha256']:
            raise ValidationError('The saved calculator uses a different source workbook version. Its saved inputs have been retained; an explicit version migration is required.')
        return state

    def save_calculator_state(self, calculator_id, inputs):
        from .workbook_calculators import normalize_calculator_inputs, source_model
        if not isinstance(inputs, dict):
            raise ValidationError('Include a worksheet input object to save the calculator.')
        self.calculator_state(calculator_id)  # Never overwrite a different source version silently.
        state = {'inputs': normalize_calculator_inputs(calculator_id, inputs),
                 'source_sha256': source_model(calculator_id)['source']['sha256'],
                 'updated_at': datetime.now(timezone.utc).isoformat()}
        with self.connect() as db:
            db.execute('INSERT INTO calculator_states VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
                       (calculator_id, json.dumps(state, allow_nan=False), state['updated_at']))
        return state

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
        if not isinstance(data, dict) or set(data) - {"title", "inputs", "configuration", "workflow", "measurements", *QUOTE_DETAIL_LIMITS}:
            raise ValidationError("Quote contains unknown fields.")
        previous = self.quote(quote_id) if quote_id else None
        details = validate_quote_details(data, previous)
        prior = previous or {}
        legacy_title = prior.get("title", "Untitled quote") if not any(prior.get(key) for key in QUOTE_DETAIL_LIMITS) else "Untitled quote"
        fallback = data.get("title", legacy_title)
        if not any(details.values()) and (not isinstance(fallback, str) or not fallback.strip() or len(fallback) > 200):
            raise ValidationError("Quote title must contain 1 to 200 characters.")
        title = compose_quote_title(**details, fallback=fallback)
        workflow = data.get("workflow", prior.get("workflow", WORKFLOWS[0]))
        if not isinstance(workflow, str) or len(workflow) > 200:
            raise ValidationError("Workflow must be text of at most 200 characters.")
        measurements = data.get("measurements", prior.get("measurements", ""))
        if not isinstance(measurements, str) or len(measurements) > 20000:
            raise ValidationError("Measurement notes must be text of at most 20000 characters.")
        configuration = validate_configuration(data.get("configuration", previous["configuration"] if previous else self.configuration()))
        pricing_changed = previous is None or configuration != previous["configuration"]
        # Freeze all effective lookup prices/yields, including unchanged defaults.
        # Storing only user overrides would let a future baseline price refresh
        # silently change an old quote when it is reopened and recalculated.
        catalog = effective_catalog(configuration)
        # A quote owns its product identities as well as its prices. Replacing
        # the live library may remove or rename products without rewriting it.
        if "catalog" not in configuration:
            configuration["catalog"] = validate_catalog(configuration_catalog(configuration))
        configuration["rates"] = {
            rate["id"]: {"price": rate["price"], **({"yield": rate["yield"]} if has_yield(rate) else {})}
            for rates in catalog["rate_groups"].values() for rate in rates
        }
        configuration["catalog_signature"] = catalog_signature(catalog)
        result = calculate(data.get("inputs", prior.get("inputs", {})), configuration)
        quote = {"id": quote_id or str(uuid.uuid4()), "title": title.strip(),
                 **details, "work_summary": compile_work_summary(workflow, result),
                 "updated_at": datetime.now(timezone.utc).isoformat(), "workflow": workflow,
                 "measurements": measurements, "inputs": result["inputs"],
                 "configuration": configuration, "result": result,
                 "source_hashes": catalog["sources"] if pricing_changed else previous["source_hashes"], "schema_version": 1}
        return quote

    def save_quote(self, data, quote_id=None):
        quote = self.prepare_quote(data, quote_id)
        with self.connect() as db:
            db.execute("INSERT INTO quotes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, data=excluded.data",
                       (quote["id"], quote["title"], quote["updated_at"], json.dumps(quote, ensure_ascii=False, allow_nan=False)))
        return quote
