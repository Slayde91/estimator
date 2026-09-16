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
from estimator.excel_engine import coordinates
from estimator.schedule_workbook import export_schedule_template
from estimator.server import create_server
from estimator.storage import Store
from estimator.workbook_calculators import _contains, source_model, validate_calculator_edits
from estimator.workbook_runtime import application_editable_cells as editable_cells


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
            ("POST", "/summary.pdf", {"inputs": inputs}),
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
        self.assertTrue(self.request("POST", "/summary.pdf", {"inputs": legacy}).startswith(b"%PDF-"))
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
        expected_rows = {"SETTINGS": [3, 4, 32, 33, 34, 65, 66, 67, 97, 98, 99, 174, 175, 176, 230, 231, 232,
                                     *range(304, 308), *range(316, 320)],
                         "CALCULATOR": [3, *range(33, 42)], "SCHEDULE": [1, 2, 3, 8], "BAGS": []}
        definition = self.request("GET")
        for sheet in definition["sheets"]:
            self.assertEqual(sheet["omitted_rows"], expected_rows[sheet["name"]])
            self.assertEqual(sheet["omitted_columns"], [22, 23, 24] if sheet["name"] == "SCHEDULE" else [])
            self.assertEqual(sheet["omitted_ranges"], ["J28:N30", "B28:B30", "D28:D30", "H23:N24"] if sheet["name"] == "CALCULATOR" else [])
            aliases = {"BAGS": {"A1": "MATERIAL QUANTITIES"},
                       "CALCULATOR": {"A1": "QUICK CALCULATOR", "L6": "PUBLISHED VALUE"},
                       "SETTINGS": {"A9": "GLOBAL SETTINGS", "A17": "COMMON CALCULATION RULES",
                                    "A31": "CAFCO 300", "A64": "MANDOLITE CP2", "A96": "FENDOLITE MII",
                                    "A173": "PERLIFOC HP ECO+", "A229": "MONOKOTE MK-6 HY",
                                    "A270": "COMPLETE WORKBOOK OPERATING RULES",
                                    "A356": "IDEALISED HOLLOW GEOMETRY", "A370": "FENDOLITE CASTELLATED SECTION"},
                       "SCHEDULE": {"Z9": "Line", "A4": "TOTAL ENTERED SPRAY AREA (m²)", "G4": "COATING VOLUME QUANTIFIED (m³)"}}
            self.assertEqual(sheet["display_text"], aliases.get(sheet["name"], {}))
            for address in editable_cells(IDENTITY, sheet["name"]):
                row, column = coordinates(address)
                self.assertNotIn(row, sheet["omitted_rows"])
                self.assertNotIn(column, sheet["omitted_columns"])
                self.assertFalse(any(_contains(region, row, column) for region in sheet["omitted_ranges"]))
        for identity in ("steel_board", "ductwork"):
            for sheet in self.request("GET", identity=identity)["sheets"]:
                expected_other_rows = {("steel_board", "START"): [3, 5, 6, *range(34, 40)],
                                       ("steel_board", "CALCULATOR"): [2, 5, 7],
                                       ("ductwork", "CALCULATOR"): [5, 6, 7, 9],
                                       ("ductwork", "PRODUCT SETTINGS"): [3, 4, *range(153, 160)]}
                self.assertEqual(sheet["omitted_rows"], expected_other_rows.get((identity, sheet["name"]), []))
                expected_columns = {("ductwork", "CALCULATOR"): [37, 38, 42, 43, 44],
                                    ("steel_board", "EXTRA BOARDS"): [14]}
                self.assertEqual(sheet["omitted_columns"], expected_columns.get((identity, sheet["name"]), []))
                expected_ranges = {("ductwork", "PRODUCT SETTINGS"): ["J6:Q21"],
                                   ("steel_board", "SETTINGS"): ["D5:D34", "G12:N13"],
                                   ("steel_board", "CALCULATOR"): ["Y1:AI1", "A6:L6"]}
                self.assertEqual(sheet["omitted_ranges"], expected_ranges.get((identity, sheet["name"]), []))
                expected_titles = {("steel_board", "CALCULATOR"): "STRUCTURAL STEEL BOARD SCHEDULE",
                                   ("steel_board", "BOARD SUMMARY"): "BOARD SUMMARY",
                                   ("steel_board", "EXTRA BOARDS"): "EXTRA BOARDS",
                                   ("ductwork", "CALCULATOR"): "DUCT PROTECTION CALCULATOR",
                                   ("ductwork", "SUMMARY"): "DUCT PROTECTION SUMMARY"}
                title = expected_titles.get((identity, sheet["name"]))
                aliases = {"A1": title} if title else {}
                if identity == "steel_board" and sheet["name"] == "START":
                    aliases = {
                        "D9": "Replace or clear the demonstration rows. Enter one member, or one group of identical members, per row. 1,000 prepared rows: 9-1008. Enter the TOTAL lineal length for that row.",
                        "A28": "Capacity is 1,000 prepared rows. All prepared rows are included in the calculation formulas, dropdowns and purchasing totals.",
                    }
                if identity == "ductwork" and sheet["name"] == "PRODUCT SETTINGS":
                    aliases["J94"] = "FYREWRAP APPLICATION TABLE"
                self.assertEqual(sheet["display_text"], aliases)
                expected_order = [*range(1, 37), 40, 41, 37, 38, 39, 42, 43, 44] if identity == "ductwork" and sheet["name"] == "CALCULATOR" else []
                self.assertEqual(sheet["display_column_order"], expected_order)
                self.assertEqual(len(sheet["display_column_order"]), len(set(sheet["display_column_order"])))
                if identity == "ductwork" and sheet["name"] == "SUMMARY":
                    tables = sheet["presentation_tables"]
                    self.assertEqual([(table["first_row"], table["last_row"], table["columns"]) for table in tables],
                                     [(8, 11, list(range(1, 11))), (18, 26, list(range(1, 7))),
                                      (30, 32, [1, 2, 3]), (39, 41, list(range(1, 8)))])
                    self.assertEqual(len(set(tables[0]["column_widths"][1:])), 1)
                elif identity == "steel_board" and sheet["name"] == "BOARD SUMMARY":
                    self.assertEqual(sheet["table_layout"], "inline")
                    self.assertEqual([(table["first_row"], table["last_row"], table["columns"]) for table in sheet["presentation_tables"]],
                                     [(11, 29, [1, 2, 3, 4, 9, 10])])
                elif identity == "steel_board" and sheet["name"] == "SETTINGS":
                    self.assertEqual(sheet["table_layout"], "stacked")
                    self.assertEqual([(table["first_row"], table["last_row"], table["columns"]) for table in sheet["presentation_tables"]],
                                     [(5, 34, [1, 2, 3]), (5, 10, list(range(7, 15))), (5, 51, [16, 17])])
                elif identity == "ductwork" and sheet["name"] == "PRODUCT SETTINGS":
                    self.assertEqual(sheet["table_layout"], "projected")
                    self.assertEqual([table["title_address"] for table in sheet["presentation_tables"]], ["A94", "J94", "J115"])
                else:
                    self.assertEqual(sheet["presentation_tables"], [])
                # The user explicitly requested hiding Evidence reference.
                # No other editable cells may be omitted accidentally.
                for address in editable_cells(identity, sheet["name"]):
                    row, column = coordinates(address)
                    self.assertNotIn(address, sheet["display_text"])
                    self.assertNotIn(row, sheet["omitted_rows"])
                    evidence = identity == "steel_board" and sheet["name"] == "EXTRA BOARDS" and column == 14 and 6 <= row <= 45
                    if evidence:
                        self.assertIn(column, sheet["omitted_columns"])
                    else:
                        self.assertNotIn(column, sheet["omitted_columns"])
                    self.assertFalse(any(_contains(region, row, column) for region in sheet["omitted_ranges"]))
                    tables = [table for table in sheet["presentation_tables"] if table["first_row"] <= row <= table["last_row"]]
                    if tables:
                        self.assertTrue(any(column in table["columns"] for table in tables), address)
        self.assertEqual({path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in (ROOT / "data/calculators").glob("*.json.gz")}, self.package_hashes)

    def test_display_spans_cover_only_decorative_children_and_notes_omission_has_no_inputs(self):
        expected = {
            (IDENTITY, "BAGS"): {"H6": {"merge": "H6:N10"}},
            (IDENTITY, "SETTINGS"): {
                **{f"A{row}": {"role": "column_header"} for row in (48, 81, 113, 190, 246)},
                **{f"D{row}": {"merge": f"D{row}:G{row}"} for row in (*range(346, 353), *range(358, 369), *range(372, 375))},
                "A371": {"merge": "A371:G371", "role": "collapsed_spacer"}},
            ("ductwork", "CALCULATOR"): {"A3": {"role": "note"}},
            ("ductwork", "SUMMARY"): {"A17": {"merge": "A17:L17"}, "A29": {"merge": "A29:L29"}},
            ("ductwork", "PRODUCT SETTINGS"): {f"J{row}": {"merge": f"J{row}:Q{row}"} for row in (105, 108, 111, 131, 136)},
        }
        for (identity, name), overrides in expected.items():
            source = next(sheet for sheet in source_model(identity)["sheets"] if sheet["name"] == name)
            page = next(sheet for sheet in self.request("GET", identity=identity)["sheets"] if sheet["name"] == name)
            self.assertEqual({anchor: {key: value for key, value in override.items() if key in ("merge", "role")}
                              for anchor, override in page["display_cells"].items() if "merge" in override or "role" in override}, overrides)
            self.assertEqual(page["merges"], source["merges"], "Source merge metadata must remain intact")
            inputs = editable_cells(identity, name)
            for anchor, override in overrides.items():
                if "merge" not in override:
                    self.assertNotIn(anchor, inputs)
                    continue
                start, end = override["merge"].split(":")
                self.assertEqual(start, anchor)
                first_row, first_column = coordinates(start)
                last_row, last_column = coordinates(end)
                for address, cell in source["cells"].items():
                    row, column = coordinates(address)
                    if first_row <= row <= last_row and first_column <= column <= last_column and address != anchor:
                        self.assertNotIn(address, inputs, address)
                        self.assertNotIn("formula", cell, address)
                        self.assertIn(cell.get("value"), (None, ""), address)
            if name == "PRODUCT SETTINGS":
                for address, cell in source["cells"].items():
                    row, _ = coordinates(address)
                    if 153 <= row <= 159:
                        self.assertNotIn(address, inputs)
                        self.assertNotIn("formula", cell)
                self.assertTrue(set(range(153, 160)) <= set(page["omitted_rows"]))
                for row in (105, 108, 111, 131, 136):
                    self.assertNotIn(row, page["omitted_rows"], "Retain the main FyreWrap table on the same source rows")

    def test_hidden_board_evidence_and_advanced_inputs_survive_visible_edits_and_save(self):
        identity = "steel_board"
        draft = {"EXTRA BOARDS": {"N6": "Retained evidence first row", "N45": "Retained evidence last row"},
                 "CALCULATOR": {"X9": "Retained design reference"}}
        self.request("PUT", "/state", {"inputs": draft}, identity=identity)
        loaded = self.request("GET", identity=identity)["inputs"]
        self.assertEqual(loaded, draft)
        before = self.cells(self.request("POST", "/worksheet", {"sheet": "BOARD SUMMARY", "inputs": loaded}, identity=identity))
        loaded["CALCULATOR"]["A9"] = "Renamed visible item"
        extras = self.request("POST", "/worksheet", {"sheet": "EXTRA BOARDS", "inputs": loaded}, identity=identity)
        cells = self.cells(extras)
        self.assertEqual(extras["omitted_columns"], [14])
        for address in ("N6", "N45"):
            self.assertTrue(cells[address]["editable"])
            self.assertEqual(cells[address]["value"], draft["EXTRA BOARDS"][address])
        self.assertEqual(cells["M6"]["value"], "", "Evidence alone must not activate an allowance")
        self.assertEqual(cells["M45"]["value"], "")
        advanced = self.cells(self.request("POST", "/worksheet", {"sheet": "CALCULATOR", "inputs": loaded, "include_advanced": True}, identity=identity))
        self.assertEqual(advanced["X9"]["value"], draft["CALCULATOR"]["X9"])
        self.assertTrue(advanced["X9"]["editable"])
        after = self.cells(self.request("POST", "/worksheet", {"sheet": "BOARD SUMMARY", "inputs": loaded}, identity=identity))
        for address in ("A6", "E6", "I6", *(f"{column}{row}" for row in range(12, 30) for column in "EFGHIJKL")):
            self.assertEqual(after[address]["value"], before[address]["value"], address)
        self.assertEqual(self.request("PUT", "/state", {"inputs": loaded}, identity=identity)["inputs"], loaded)
        self.assertEqual(self.request("GET", identity=identity)["inputs"], loaded)

    def test_projected_sections_cover_original_inputs_once_and_keep_lookup_tail(self):
        expected = {
            (IDENTITY, "CALCULATOR"): [(5, 24, list(range(1, 7)), "A5"),
                                      (5, 24, list(range(8, 15)), "H5"),
                                      (26, 30, [1, 3, 5, 6, 7, 8, 9], "A26")],
            (IDENTITY, "BAGS"): [(1, 15, [*range(1, 7), *range(8, 15)], "A1"), (17, 24, list(range(1, 10)), "A17")],
            ("ductwork", "PRODUCT SETTINGS"): [(94, 151, list(range(1, 9)), "A94"),
                                               (94, 113, list(range(10, 18)), "J94"),
                                               (115, 149, list(range(10, 18)), "J115")],
        }
        for (identity, name), extents in expected.items():
            page = next(sheet for sheet in self.request("GET", identity=identity)["sheets"] if sheet["name"] == name)
            tables = page["presentation_tables"]
            self.assertEqual(page["table_layout"], "projected")
            self.assertEqual([(table["first_row"], table["last_row"], table["columns"], table.get("title_address")) for table in tables], extents)
            covered = set()
            for table in tables:
                area = {(row, column) for row in range(table["first_row"], table["last_row"] + 1) for column in table["columns"]}
                self.assertFalse(covered & area, "An input or output must not be rendered twice")
                covered |= area
                self.assertEqual(len(table["columns"]), len(table["column_widths"]))
                self.assertNotIn(table.get("title_address"), editable_cells(identity, name))
            if identity == IDENTITY:
                self.assertTrue({coordinates(address) for address in editable_cells(identity, name)} <= covered)
                if name == "CALCULATOR":
                    source = next(sheet for sheet in source_model(identity)["sheets"] if sheet["name"] == name)
                    for table in tables:
                        for row, layout in table.get("row_layouts", {}).items():
                            anchors = [item["address"] for item in layout]
                            self.assertEqual(len(anchors), len(set(anchors)))
                            self.assertEqual(sum(item["span"] for item in layout), len(table["columns"]))
                            populated = {address for address, cell in source["cells"].items()
                                         if coordinates(address)[0] == int(row) and coordinates(address)[1] in table["columns"]
                                         and (cell.get("value") not in (None, "") or "formula" in cell)}
                            self.assertEqual(set(anchors), populated, "Row reordering must retain every source value exactly once")
                            self.assertTrue(all(coordinates(address) in covered for address in anchors))
                if name == "BAGS":
                    source = next(sheet for sheet in source_model(identity)["sheets"] if sheet["name"] == name)
                    for row in range(6, 16):
                        divider = source["cells"].get(f"G{row}", {})
                        self.assertIn(divider.get("value"), (None, ""))
                        self.assertNotIn("formula", divider)
                        self.assertNotIn((row, 7), covered)
                    self.assertIn((20, 7), covered, "Preserve whole-bag order quantities below the manual form")
            else:
                self.assertTrue({(row, 10) for row in range(137, 150)} <= covered, "Retain the H-selection lookup tail")

    def test_roll_width_and_small_joint_gap_recalculate_and_save_exact_values(self):
        identity, sheet = "ductwork", "PRODUCT SETTINGS"
        draft = {sheet: {"B97": 1.22, "B100": 0.007}}
        page = self.request("POST", "/worksheet", {"sheet": sheet, "inputs": draft}, identity=identity)
        cells = self.cells(page)
        for address, value in draft[sheet].items():
            self.assertTrue(cells[address]["editable"])
            self.assertTrue(cells[address]["allow_other"])
            self.assertEqual(cells[address]["value"], value)
        saved = self.request("PUT", "/state", {"inputs": draft}, identity=identity)
        self.assertEqual(saved["inputs"], draft)
        self.assertEqual(self.request("GET", identity=identity)["inputs"], draft)
        self.assertFalse(cells["B96"]["editable"])
        self.request("PUT", "/state", {"inputs": {sheet: {"B96": .05}}}, identity=identity, expected=400)

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
