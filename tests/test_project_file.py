"""Portable project round trips and untrusted-file boundaries on disposable DBs."""

import base64
from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from estimator.calculator import fields
from estimator.calculator_defaults import default_calculator_inputs
from estimator.schedule_rows import empty_schedule_inputs
from estimator.catalog import ValidationError, baseline, effective_catalog
from estimator.project_file import (
    CALCULATOR_IDS, ESTIMATE_FIELDS, PROJECT_FILENAME, export_project, import_project,
)
from estimator.server import create_server
from estimator.storage import Store
from estimator.workbook_calculators import source_model


def upload(payload):
    return {"filename": PROJECT_FILENAME, "content_base64": base64.b64encode(payload).decode("ascii")}


def stored_rows(store):
    with store.connect() as db:
        return {table: db.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                for table in ("quotes", "settings", "calculator_states")}


class ProjectFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.sender = Store(Path(cls.temp.name) / "sender.sqlite3")
        cls.receiver = Store(Path(cls.temp.name) / "receiver.sqlite3")
        cls.original = export_project(cls.sender, {"estimate": {"project_no": "CF-1000", "client": "Client & Co", "site_address": "1 Main Street"}})

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        for store in (self.sender, self.receiver):
            with store.connect() as db:
                for table in ("quotes", "settings", "calculator_states"):
                    db.execute(f"DELETE FROM {table}")

    def load(self, payload):
        return import_project(self.receiver, **upload(payload))

    def altered(self, edit):
        snapshot = json.loads(self.original)
        edit(snapshot)
        return json.dumps(snapshot).encode()

    def test_round_trip_keeps_pricing_precision_settings_all_schedules_and_extra_boards(self):
        rate = baseline()["rate_groups"]["labour_rates"][0]["id"]
        self.sender.save_configuration({"rates": {rate: {"price": 876.5432109876543}}})
        estimate = {"project_no": " CF-1000 ", "client": "Client & Co", "site_address": "1 Main Street",
                    "measurements": "Existing measurement notes", "inputs": {"B15": 432.123456789}}
        drafts = {
            "steel_vermiculite": {"inputs": {**default_calculator_inputs("steel_vermiculite"),
                                             "SCHEDULE": {"AA1009": "Level 12 / Zone A", "J1009": 12.3456789012345}}},
            "steel_board": {"inputs": {"CALCULATOR": {"B1008": "Level 15", "F1008": 2.123456789},
                                       "EXTRA BOARDS": {"A45": "Keep allowance"}}},
            "ductwork": {"inputs": {"CALCULATOR": {"B1010": "1200x450", "D1010": 9.876543210987},
                                    "PRODUCT SETTINGS": {"B97": 1.22}}},
        }
        original_drafts = deepcopy(drafts)
        before_sender = stored_rows(self.sender)
        payload = export_project(self.sender, {"estimate": estimate, "calculators": drafts})
        self.receiver.save_configuration({"rates": {rate: {"price": 22}}})
        self.receiver.save_quote({"title": "Existing local quote"})
        self.receiver.save_calculator_state("ductwork", {"CALCULATOR": {"B11": "Existing local schedule"}})
        before_receiver = stored_rows(self.receiver)
        loaded = self.load(payload)
        self.assertEqual(stored_rows(self.sender), before_sender)
        self.assertEqual(stored_rows(self.receiver), before_receiver)
        self.assertEqual(loaded["project_details"], {"project_no": "CF-1000", "client": "Client & Co", "site_address": "1 Main Street"})
        self.assertIsNone(loaded["estimate"]["id"])
        self.assertEqual(loaded["estimate"]["configuration"]["rates"][rate]["price"], 876.5432109876543)
        self.assertEqual(loaded["estimate"]["result"], self.sender.prepare_quote(estimate)["result"])
        self.assertEqual(loaded["fields"], fields(effective_catalog(loaded["estimate"]["configuration"])))
        for identity, draft in drafts.items():
            expected_inputs = draft["inputs"]
            if identity == "ductwork":
                # The untouched source example keeps its row and becomes the
                # approved Both orientation; all supplied values stay exact.
                expected_inputs = {**expected_inputs, "CALCULATOR": {**expected_inputs["CALCULATOR"], "I13": "Both"}}
            self.assertEqual(loaded["calculators"][identity]["inputs"], expected_inputs)
            self.assertEqual(loaded["calculators"][identity]["source_sha256"], source_model(identity)["source"]["sha256"])
        self.assertEqual(drafts, original_drafts)
        second = export_project(self.receiver, {"estimate": {key: loaded["estimate"][key] for key in ESTIMATE_FIELDS},
                                               "calculators": {key: {"inputs": value["inputs"]} for key, value in loaded["calculators"].items()}})
        self.assertEqual(json.loads(second), json.loads(payload))

    def test_export_includes_unopened_saved_calculators_and_reviewed_defaults(self):
        saved = {"CALCULATOR": {"B1010": "saved last row"}}
        self.sender.save_calculator_state("ductwork", saved)
        before = stored_rows(self.sender)
        snapshot = json.loads(export_project(self.sender, {"estimate": {}}))
        self.assertEqual(set(snapshot["calculators"]), set(CALCULATOR_IDS))
        self.assertEqual(snapshot["calculators"]["ductwork"]["inputs"],
                         {"CALCULATOR": {"B1010": "saved last row", "I13": "Both"}})
        self.assertEqual(saved, {"CALCULATOR": {"B1010": "saved last row"}})
        self.assertEqual(snapshot["calculators"]["steel_vermiculite"]["inputs"], empty_schedule_inputs("steel_vermiculite"))
        self.assertEqual(stored_rows(self.sender), before)
        self.assertNotIn("result", snapshot["estimate"])
        self.assertNotIn("id", snapshot["estimate"])

    def test_standalone_product_service_survives_quote_and_project_snapshots(self):
        catalog = baseline()
        service = catalog["rate_groups"]["primers"][0]
        service.update(inventory_id=None, price_mode="override")
        identity, lookup_name = service["id"], service["name"]
        label = "Standalone primer service; <literal>"
        patch = {"product_service": label, "price": 401.1234567890123, "yield": 71.9876543210987}
        configuration = {"catalog": catalog, "inventory": {}, "rates": {identity: patch}}
        self.sender.save_configuration(configuration)
        estimate = {"title": "Standalone service project", "inputs": {"D20": lookup_name, "B20": 142}}
        saved_quote = self.sender.save_quote(estimate)
        reopened_quote = self.sender.quote(saved_quote["id"])
        self.assertEqual(reopened_quote["configuration"]["rates"][identity], patch)
        self.assertEqual(reopened_quote["inputs"]["D20"], lookup_name)
        self.assertEqual(reopened_quote["result"]["cells"]["A87"], patch["price"])
        self.assertEqual(reopened_quote["result"]["cells"]["F20"], patch["yield"])
        before_sender = stored_rows(self.sender)
        payload = export_project(self.sender, {"estimate": {key: reopened_quote[key] for key in ESTIMATE_FIELDS}})
        self.receiver.save_configuration({"rates": {identity: {"price": 22, "product_service": "Current shared label"}}})
        before_receiver = stored_rows(self.receiver)
        loaded = self.load(payload)
        self.assertEqual(stored_rows(self.sender), before_sender)
        self.assertEqual(stored_rows(self.receiver), before_receiver)
        self.assertEqual(loaded["estimate"]["configuration"]["rates"][identity], patch)
        self.assertEqual(loaded["estimate"]["result"], reopened_quote["result"])
        loaded_rate = next(rate for rate in effective_catalog(loaded["estimate"]["configuration"])["rate_groups"]["primers"]
                           if rate["id"] == identity)
        self.assertEqual((loaded_rate["name"], loaded_rate["display_name"], loaded_rate["inventory_id"]),
                         (lookup_name, label, None))
        primer_field = next(field for field in loaded["fields"] if field["cell"] == "D20")
        self.assertEqual(primer_field["option_labels"][lookup_name], label)
        second = export_project(self.receiver, {"estimate": {key: loaded["estimate"][key] for key in ESTIMATE_FIELDS},
                                               "calculators": {key: {"inputs": value["inputs"]}
                                                               for key, value in loaded["calculators"].items()}})
        self.assertEqual(json.loads(second), json.loads(payload))

    def test_import_rejects_tampering_before_any_database_write(self):
        cases = {
            "format": lambda data: data.update(format="other"),
            "version": lambda data: data.update(version=2),
            "boolean version": lambda data: data.update(version=True),
            "fractional version": lambda data: data.update(version=1.0),
            "extra root field": lambda data: data.update(result={"grand_total": 1}),
            "saved quote identity": lambda data: data["estimate"].update(id="local-quote"),
            "fake result": lambda data: data["estimate"].update(result={"grand_total": 1}),
            "missing snapshot": lambda data: data["estimate"]["configuration"].pop("catalog"),
            "calculated estimate cell": lambda data: data["estimate"]["inputs"].update(F9=1),
            "missing calculator": lambda data: data["calculators"].pop("ductwork"),
            "unknown calculator": lambda data: data["calculators"].update(fake={}),
            "source version": lambda data: data["calculators"]["ductwork"].update(source_sha256="0" * 64),
            "fake calculator output": lambda data: data["calculators"]["ductwork"].update(results={}),
            "calculated calculator cell": lambda data: data["calculators"]["ductwork"].update(inputs={"CALCULATOR": {"K11": 2}}),
            "readonly line": lambda data: data["calculators"]["steel_vermiculite"].update(inputs={"SCHEDULE": {"Z1009": 1}}),
            "out of bounds": lambda data: data["calculators"]["steel_board"].update(inputs={"CALCULATOR": {"F1009": 2}}),
            "reference text": lambda data: data["calculators"]["steel_vermiculite"].update(inputs={"SETTINGS": {"D42": "Forged evidence"}}),
            "numeric formula": lambda data: data["calculators"]["ductwork"].update(inputs={"CALCULATOR": {"D11": "=1+1"}}),
            "nonfinite": lambda data: data["calculators"]["ductwork"].update(inputs={"CALCULATOR": {"D11": float("inf")}}),
            "invalid pricing": lambda data: data["estimate"]["configuration"].update(rates={"fake": {"price": 2}}),
            "invalid project details": lambda data: data["estimate"].update(client="x\x00y"),
        }
        before = stored_rows(self.receiver)
        for label, edit in cases.items():
            with self.subTest(label=label), self.assertRaises(ValidationError):
                self.load(self.altered(edit))
            self.assertEqual(stored_rows(self.receiver), before)

    def test_file_parse_limits_duplicate_keys_and_invalid_utf8(self):
        for payload in (b"", b"\xff", b"{}", b"[]", b'{"format":"first","format":"second"}',
                        b"[" * 1000 + b"]" * 1000, b'{"value":1e999}', b'{"value":NaN}',
                        b'{"value":"\\ud800"}', b'{"value":' + b"9" * 5000 + b'}'):
            with self.subTest(payload=payload[:60]), self.assertRaises(ValidationError):
                self.load(payload)
        # Both would otherwise be valid snapshots if a decoder silently kept
        # the last duplicate, so the duplicate-key boundary is exercised.
        for payload in (self.original.replace(b'"version": 1,', b'"version": 2, "version": 1,', 1),
                        self.original.replace(b'"project_no": "CF-1000",', b'"project_no": "other", "project_no": "CF-1000",', 1)):
            self.assertNotEqual(payload, self.original)
            with self.assertRaises(ValidationError):
                self.load(payload)
        with self.assertRaises(ValidationError):
            import_project(self.receiver, "project.xlsx", "AA==")
        with self.assertRaises(ValidationError):
            import_project(self.receiver, PROJECT_FILENAME, "not base64")
        with patch("estimator.project_file.MAX_PROJECT_FILE", 100):
            with self.assertRaises(ValidationError):
                self.load(self.original)
            with self.assertRaises(ValidationError):
                export_project(self.sender, {"estimate": {}})

    def test_valid_project_can_be_renamed_or_have_a_browser_download_suffix(self):
        encoded = upload(self.original)["content_base64"]
        before = stored_rows(self.receiver)
        for filename in ("CEASEFIRE-Project.ceasefire-project (1).json", "Colleague project.json", "PROJECT.JSON"):
            with self.subTest(filename=filename):
                imported = import_project(self.receiver, filename, encoded)
                self.assertEqual(imported["project_details"]["project_no"], "CF-1000")
                self.assertIsNone(imported["estimate"]["id"])
        self.assertEqual(stored_rows(self.receiver), before)

    def test_portable_reference_policy_accepts_source_and_reviewed_but_not_saved_exceptions(self):
        model = source_model("steel_vermiculite")
        settings = next(sheet for sheet in model["sheets"] if sheet["name"] == "SETTINGS")["cells"]
        for value in (settings["D42"]["value"], default_calculator_inputs("steel_vermiculite")["SETTINGS"]["D42"]):
            inputs = {"SETTINGS": {"D42": value}}
            payload = export_project(self.sender, {"estimate": {}, "calculators": {"steel_vermiculite": {"inputs": inputs}}})
            self.assertEqual(self.load(payload)["calculators"]["steel_vermiculite"]["inputs"], inputs)
        # A locally retained historical reference must not become an authority
        # exception merely because an external file repeats its text.
        malicious = {"inputs": {"SETTINGS": {"D42": "Historical custom reference"}},
                     "source_sha256": model["source"]["sha256"]}
        with self.receiver.connect() as db:
            db.execute("INSERT INTO calculator_states VALUES(?,?,?)", ("steel_vermiculite", json.dumps(malicious), "earlier"))
        payload = self.altered(lambda data: data["calculators"].update(steel_vermiculite=malicious))
        with self.assertRaises(ValidationError):
            self.load(payload)
        with self.assertRaises(ValidationError):
            export_project(self.receiver, {"estimate": {}})


class ProjectFileApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.store = Store(Path(cls.temp.name) / "project-api.sqlite3")
        cls.server = create_server(0, cls.store.path)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, path, body, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=60)
        try:
            connection.request("POST", path, json.dumps(body), {"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_download_and_load_round_trip_without_local_save(self):
        before = stored_rows(self.store)
        status, headers, payload = self.request("/api/project/export", {"estimate": {"project_no": "Project 17"}})
        self.assertEqual(status, 200)
        self.assertIn('filename="Project 17.json"', headers["Content-Disposition"])
        status, _, loaded = self.request("/api/project/import", upload(payload))
        self.assertEqual(status, 200, loaded)
        self.assertEqual(json.loads(loaded)["estimate"]["project_no"], "Project 17")
        self.assertEqual(stored_rows(self.store), before)

    def test_unknown_fields_and_cross_origin_uploads_rejected(self):
        for path, body in (("/api/project/export", {}), ("/api/project/export", {"estimate": {}, "unknown": 1}),
                           ("/api/project/import", {}), ("/api/project/import", {"filename": PROJECT_FILENAME, "content_base64": "bad"})):
            with self.subTest(path=path, body=body):
                self.assertEqual(self.request(path, body)[0], 400)
        self.assertEqual(self.request("/api/project/export", {"estimate": {}}, {"Origin": "https://elsewhere.example"})[0], 403)

    def test_both_pdf_routes_validate_and_forward_project_identity_only(self):
        details = {"project_no": " P-1 ", "client": "Client", "site_address": "Site"}
        for action, builder in (("report.pdf", "build_calculator_report"), ("summary.pdf", "build_calculator_summary_report")):
            for identity in CALCULATOR_IDS:
                with self.subTest(action=action, identity=identity), patch(f"estimator.calculator_report.{builder}", return_value=b"%PDF-test") as build:
                    self.assertEqual(self.request(f"/api/calculators/{identity}/{action}", {"inputs": {}, "project_details": details})[0], 200)
                    self.assertEqual(build.call_args.kwargs["project_details"], {**details, "project_no": "P-1"})
                    for invalid in ({"client": "x" * 201}, {"client": "x\ny"}, {"fake": "value"}, []):
                        self.assertEqual(self.request(f"/api/calculators/{identity}/{action}", {"project_details": invalid})[0], 400)


if __name__ == "__main__":
    unittest.main()
