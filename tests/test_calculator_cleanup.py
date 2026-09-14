"""Read-only references and presentation cleanup at the application boundary."""

import base64
from copy import deepcopy
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.calculator_defaults import default_calculator_inputs
from estimator.catalog import ROOT, ValidationError
from estimator.schedule_workbook import export_schedule_template
from estimator.server import create_server
from estimator.storage import Store
from estimator.workbook_calculators import source_model, validate_calculator_edits


IDENTITY = "steel_vermiculite"
REFERENCES = ("D42", "D75", "D107", "D184", "D240")
YIELD_FIELDS = (("D36", "D37", "D38", "D40"), ("D69", "D70", "D71", "D73"),
                ("D101", "D102", "D103", "D105"), ("D178", "D179", "D180", "D182"),
                ("D234", "D235", "D236", "D238"))


class CalculatorCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.database = Path(cls.temp.name) / "cleanup.sqlite3"
        cls.server = create_server(0, cls.database)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.template = base64.b64encode(export_schedule_template(IDENTITY)).decode("ascii")
        cls.model = source_model(IDENTITY)
        cls.source_settings = next(sheet for sheet in cls.model["sheets"] if sheet["name"] == "SETTINGS")["cells"]
        cls.package_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in (ROOT / "data/calculators").glob("*.json.gz")}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def setUp(self):
        self.store = Store(self.database)
        with self.store.connect() as db:
            db.execute("DELETE FROM calculator_states")

    def request(self, method, action="", payload=None, expected=200, identity=IDENTITY):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=120)
        try:
            connection.request(method, f"/api/calculators/{identity}{action}",
                               None if payload is None else json.dumps(payload),
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, expected, body[:800])
            if response.getheader("Content-Type").startswith("application/json"):
                return json.loads(body)
            return body
        finally:
            connection.close()

    def rows(self):
        with self.store.connect() as db:
            return {table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                    for table in ("calculator_states", "quotes", "settings")}

    def seed_legacy(self, inputs, source_hash=None):
        saved = {"inputs": deepcopy(inputs), "source_sha256": source_hash or self.model["source"]["sha256"],
                 "updated_at": "2026-09-01T00:00:00+00:00"}
        # Simulate a legitimate record written by the former editable-reference
        # application, without using the new validation boundary to create it.
        with self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO calculator_states VALUES(?,?,?)",
                       (IDENTITY, json.dumps(saved), saved["updated_at"]))
        return saved

    def action_payloads(self, inputs):
        return (
            ("POST", "/calculate", {"sheet": "SETTINGS", "start_row": 40, "row_count": 3, "inputs": inputs}),
            ("POST", "/worksheet", {"sheet": "SETTINGS", "inputs": inputs}),
            ("POST", "/report.pdf", {"inputs": inputs}),
            ("POST", "/import", {"filename": "schedule.xlsx", "content_base64": self.template, "inputs": inputs}),
            ("PUT", "/state", {"inputs": inputs}),
        )

    @staticmethod
    def cells(page):
        return {cell["address"]: cell for row in page["rows"] for cell in row["cells"]}

    def test_validation_accepts_exact_saved_source_and_reviewed_references_only(self):
        defaults = default_calculator_inputs(IDENTITY)
        saved = {"SETTINGS": {address: f"Retained project evidence {address}\nOriginal second line" for address in REFERENCES}}
        for address in REFERENCES:
            for permitted in (saved["SETTINGS"][address], self.source_settings[address]["value"], defaults["SETTINGS"][address]):
                inputs = {"SETTINGS": {address: permitted}}
                self.assertEqual(validate_calculator_edits(IDENTITY, inputs, saved), inputs)
            for replacement in ("Unapproved replacement", None, "", saved["SETTINGS"][address] + " "):
                with self.subTest(address=address, replacement=replacement):
                    with self.assertRaisesRegex(ValidationError, "read-only"):
                        validate_calculator_edits(IDENTITY, {"SETTINGS": {address: replacement}}, saved)
        self.assertEqual(validate_calculator_edits(IDENTITY, {}, saved), {})

    def test_every_http_edit_boundary_rejects_all_five_changed_or_cleared_references_without_writes(self):
        saved = default_calculator_inputs(IDENTITY)
        self.store.save_calculator_state(IDENTITY, saved)
        before = self.rows()
        for address in REFERENCES:
            for replacement in ("New evidence cannot be entered here", None):
                draft = deepcopy(saved)
                draft["SETTINGS"][address] = replacement
                for method, endpoint, payload in self.action_payloads(draft):
                    with self.subTest(address=address, replacement=replacement, endpoint=endpoint):
                        error = self.request(method, endpoint, payload, expected=400)
                        self.assertIn("read-only", error["error"])
                        self.assertEqual(self.rows(), before)

    def test_store_also_rejects_changed_references_before_updating_the_saved_state(self):
        saved = default_calculator_inputs(IDENTITY)
        self.store.save_calculator_state(IDENTITY, saved)
        before = self.rows()
        for address in REFERENCES:
            draft = deepcopy(saved)
            draft["SETTINGS"][address] = "Replaced through direct Store call"
            with self.assertRaisesRegex(ValidationError, "read-only"):
                self.store.save_calculator_state(IDENTITY, draft)
            self.assertEqual(self.rows(), before)

    def test_trusted_legacy_references_load_render_import_report_and_save_unchanged(self):
        legacy = default_calculator_inputs(IDENTITY)
        legacy["SETTINGS"].update({address: f"Historical {address}\nSecond line\r\nThird line" for address in REFERENCES})
        self.seed_legacy(legacy)
        before = self.rows()
        self.assertEqual(self.request("GET")["inputs"], legacy)
        page = self.request("POST", "/worksheet", {"sheet": "SETTINGS"})
        cells = self.cells(page)
        for address in REFERENCES:
            self.assertEqual(cells[address]["value"], legacy["SETTINGS"][address])
            self.assertFalse(cells[address]["editable"])
            self.assertTrue(cells[address]["read_only"] and cells[address]["output"] and cells[address]["multiline"])
        preview = self.request("POST", "/calculate", {"sheet": "SETTINGS", "start_row": 40, "row_count": 3})
        self.assertEqual(self.cells(preview)["D42"]["value"], legacy["SETTINGS"]["D42"])
        self.assertTrue(self.request("POST", "/report.pdf", {"inputs": legacy}).startswith(b"%PDF-"))
        imported = self.request("POST", "/import", {"filename": "schedule.xlsx", "content_base64": self.template, "inputs": legacy})
        self.assertEqual(imported["inputs"]["SETTINGS"], legacy["SETTINGS"])
        self.assertEqual(self.rows(), before)
        result = self.request("PUT", "/state", {"inputs": imported["inputs"]})
        self.assertEqual(result["inputs"]["SETTINGS"], legacy["SETTINGS"])
        self.assertEqual(self.request("GET")["inputs"], imported["inputs"])

    def test_historical_blank_and_original_or_reviewed_reset_stay_supported(self):
        legacy = {"SETTINGS": {address: None for address in REFERENCES}}
        self.seed_legacy(legacy)
        self.assertEqual(self.request("PUT", "/state", {"inputs": legacy})["inputs"], legacy)
        original = {"SETTINGS": {address: self.source_settings[address]["value"] for address in REFERENCES}}
        for reset in (original, default_calculator_inputs(IDENTITY), {}):
            with self.subTest(reset_kind="source" if reset is original else "reviewed" if reset else "empty"):
                self.assertEqual(self.request("PUT", "/state", {"inputs": reset})["inputs"], reset)
                self.assertEqual(self.request("GET")["inputs"], reset)

    def test_numeric_settings_stay_editable_and_keep_exact_user_precision(self):
        draft = default_calculator_inputs(IDENTITY)
        for index, (mass, direct, density, _used) in enumerate(YIELD_FIELDS):
            draft["SETTINGS"].update({mass: 20.123456789 + index, direct: .05123456789 + index * .001,
                                      density: 345.678912345 + index})
        before = self.rows()
        cells = self.cells(self.request("POST", "/worksheet", {"sheet": "SETTINGS", "inputs": draft}))
        for mass, direct, density, used in YIELD_FIELDS:
            for address in (mass, direct, density):
                self.assertTrue(cells[address]["editable"])
                self.assertEqual(cells[address]["value"], draft["SETTINGS"][address])
            self.assertEqual(cells[used]["value"], draft["SETTINGS"][direct])
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.request("PUT", "/state", {"inputs": draft})["inputs"], draft)
        self.assertEqual(self.request("GET")["inputs"], draft)

    def test_presentation_metadata_omits_only_requested_cells_and_preserves_source_packages(self):
        expected_rows = {"SETTINGS": [32, 33, 34, 65, 66, 67, 97, 98, 99, 174, 175, 176, 230, 231, 232],
                         "CALCULATOR": list(range(33, 42)), "SCHEDULE": [1, 2, 3, 8], "BAGS": []}
        definition = self.request("GET")
        for sheet in definition["sheets"]:
            self.assertEqual(sheet["omitted_rows"], expected_rows[sheet["name"]])
            self.assertEqual(sheet["omitted_columns"], [22, 23, 24] if sheet["name"] == "SCHEDULE" else [])
        for identity in ("steel_board", "ductwork"):
            for sheet in self.request("GET", identity=identity)["sheets"]:
                self.assertEqual(sheet["omitted_rows"], [])
                self.assertEqual(sheet["omitted_columns"], [37] if identity == "ductwork" and sheet["name"] == "CALCULATOR" else [])
        self.assertEqual({path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in (ROOT / "data/calculators").glob("*.json.gz")}, self.package_hashes)

    def test_hidden_quantity_status_and_visible_review_note_still_block_incomplete_orders(self):
        draft = default_calculator_inputs(IDENTITY)
        before = self.rows()
        valid = self.cells(self.request("POST", "/calculate", {"sheet": "SCHEDULE", "start_row": 10, "row_count": 1, "inputs": draft}))
        self.assertEqual(valid["W10"]["value"], "QUANTIFIED - ESTIMATE")
        draft["SETTINGS"]["D37"] = 0
        page = self.request("POST", "/worksheet", {"sheet": "SCHEDULE", "inputs": draft})
        cells = self.cells(page)
        self.assertEqual(page["omitted_columns"], [22, 23, 24])
        self.assertEqual(cells["W10"]["value"], "ENTER VERIFIED YIELD")
        self.assertTrue(cells["V10"]["value"])
        self.assertTrue(cells["X10"]["value"])
        self.assertTrue(cells["Y10"]["value"])
        self.assertIn("yield", cells["Y10"]["value"].lower())
        self.assertNotIn(25, page["omitted_columns"])
        bags = self.cells(self.request("POST", "/calculate", {"sheet": "BAGS", "start_row": 20, "row_count": 1, "inputs": draft}))
        self.assertEqual(bags["H20"]["value"], 1)
        self.assertEqual(bags["G20"]["value"], "INCOMPLETE")
        self.assertEqual(bags["I20"]["value"], "INCOMPLETE - CHECK SCHEDULE")
        self.assertEqual(page["product_totals"][0]["whole_bags"], "INCOMPLETE")
        self.assertEqual(self.rows(), before)

    def test_mismatched_saved_source_version_is_never_replaced_or_silently_loaded(self):
        self.seed_legacy(default_calculator_inputs(IDENTITY), source_hash="different-source-version")
        before = self.rows()
        error = self.request("GET", expected=400)
        self.assertIn("different source workbook version", error["error"])
        for method, endpoint, payload in self.action_payloads(default_calculator_inputs(IDENTITY)):
            with self.subTest(endpoint=endpoint):
                error = self.request(method, endpoint, payload, expected=400)
                self.assertIn("different source workbook version", error["error"])
                self.assertEqual(self.rows(), before)


if __name__ == "__main__":
    unittest.main()
