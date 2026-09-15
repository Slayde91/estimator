"""Complete worksheet and calculator PDF HTTP boundaries on an isolated store."""

from copy import deepcopy
import hashlib
import http.client
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest

from pypdf import PdfReader
from openpyxl import load_workbook

from estimator.catalog import ROOT
from estimator.server import create_server
from estimator.storage import Store
from estimator.workbook_calculators import source_model


EXTENTS = {
    "steel_vermiculite": {"CALCULATOR": (41, 14), "SCHEDULE": (1009, 25), "BAGS": (29, 14), "SETTINGS": (558, 65)},
    "ductwork": {"CALCULATOR": (310, 90), "SUMMARY": (45, 12), "PRODUCT SETTINGS": (160, 17)},
    "steel_board": {"START": (100, 12), "CALCULATOR": (208, 35), "BOARD SUMMARY": (38, 12), "EXTRA BOARDS": (45, 14), "SETTINGS": (51, 17)},
}


class CalculatorPresentationApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.database = Path(cls.temp.name) / "presentation-api.sqlite3"
        cls.server = create_server(0, cls.database)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.source_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
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

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=120)
        try:
            connection.request(method, path, body=json.dumps(body) if isinstance(body, dict) else body,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def json_request(self, method, path, body=None, expected=200):
        status, _, payload = self.request(method, path, body)
        self.assertEqual(status, expected, payload.decode("utf-8", errors="replace")[:1000])
        return json.loads(payload)

    def worksheet(self, identity, sheet, **options):
        return self.json_request("POST", f"/api/calculators/{identity}/worksheet", {"sheet": sheet, **options})

    @staticmethod
    def cells(worksheet):
        return {cell["address"]: cell for row in worksheet["rows"] for cell in row["cells"]}

    def stored_rows(self):
        with self.store.connect() as db:
            return {table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                    for table in ("calculator_states", "quotes", "settings")}

    def test_all_twelve_worksheets_return_every_source_row_without_saving(self):
        before = self.stored_rows()
        page_count = 0
        for identity, pages in EXTENTS.items():
            for name, (max_row, max_column) in pages.items():
                with self.subTest(identity=identity, page=name):
                    result = self.worksheet(identity, name)
                    self.assertEqual((result["sheet"], result["start_row"], result["end_row"]), (name, 1, max_row))
                    self.assertEqual((result["max_row"], result["max_column"]), (max_row, max_column))
                    self.assertEqual([row["row"] for row in result["rows"]], list(range(1, max_row + 1)))
                    self.assertTrue(all([cell["column"] for cell in row["cells"]] == result["visible_columns"] for row in result["rows"]))
                    self.assertFalse(set(result["visible_columns"]) & set(result["hidden_columns"]))
                    self.assertTrue(all(isinstance(cell["presentation"]["bold"], bool) and isinstance(cell["presentation"]["role"], str)
                                        for row in result["rows"] for cell in row["cells"]))
                    for row in result["rows"]:
                        for cell in row["cells"]:
                            if "options_ref" in cell:
                                self.assertIn(cell["options_ref"], result["option_sets"])
                                self.assertNotIn("options", cell, "Shared options must not also be repeated in every cell")
                    page_count += 1
        self.assertEqual(page_count, 12)
        self.assertEqual(self.stored_rows(), before)
        self.assertEqual({path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in (ROOT / "data/calculators").glob("*.json.gz")}, self.source_hashes)

    def test_final_prepared_rows_remain_editable_and_preserve_raw_precision(self):
        before = self.stored_rows()
        precision = 12.345678901234567
        cases = [("ductwork", "CALCULATOR", "D310"), ("steel_board", "CALCULATOR", "F208"),
                 ("steel_vermiculite", "SCHEDULE", "J1009"), ("steel_board", "EXTRA BOARDS", "G45")]
        for identity, sheet, address in cases:
            with self.subTest(identity=identity, sheet=sheet):
                result = self.worksheet(identity, sheet, inputs={sheet: {address: precision}})
                last = self.cells(result)[address]
                self.assertTrue(last["editable"])
                self.assertFalse(last["calculated"])
                self.assertEqual(last["value"], precision)
                self.assertEqual(result["inputs"][sheet][address], precision)
        self.assertEqual(self.stored_rows(), before)

    def test_section_controls_and_text_aliases_leave_raw_worksheet_values_intact(self):
        before = self.stored_rows()
        calculator = self.worksheet('steel_vermiculite', 'CALCULATOR')
        cells = self.cells(calculator)
        self.assertEqual(calculator['navigation_mode'], 'hidden')
        self.assertEqual(calculator['display_text']['L6'], 'PUBLISHED VALUE')
        self.assertIn('mm', cells['L6']['value'])
        self.assertIsInstance(cells['H6']['value'], (int, float))
        self.assertEqual(calculator['display_cells']['H6']['suffix'], ' mm')
        bags = self.worksheet('steel_vermiculite', 'BAGS')
        self.assertEqual(bags['display_table_order'], [1, 0])
        self.assertEqual(bags['navigation_mode'], 'hidden')
        for row in range(20, 25):
            self.assertTrue(bags['display_cells'][f'A{row}']['bold'])
        for identity, sheet, count, field in (
                ('steel_vermiculite', 'SETTINGS', 11, 'D42'),
                ('ductwork', 'PRODUCT SETTINGS', 5, 'B96'),
                ('steel_board', 'SETTINGS', 3, 'B34')):
            page = self.worksheet(identity, sheet)
            self.assertEqual(page['navigation_mode'], 'select')
            self.assertEqual(len(page['settings_sections']), count)
            self.assertEqual(len(page['rows']), page['max_row'])
            self.assertIn(field, self.cells(page))
            if identity == 'steel_vermiculite':
                self.assertFalse(page['display_cells']['D42']['bold'])
                self.assertFalse(self.cells(page)['D42']['editable'])
            elif identity == 'ductwork':
                self.assertEqual(page['display_text']['J94'], 'FYREWRAP APPLICATION TABLE')
                self.assertIn('MANUAL', self.cells(page)['J94']['value'])
                self.assertTrue(any('copied fixing instructions' in warning for warning in page['warnings']))
        self.assertEqual(self.stored_rows(), before)

    def test_dropdowns_share_full_lists_and_keep_dependent_numeric_choices(self):
        inputs = {"CALCULATOR": {"C9": "TRAFALGAR COREX", "C10": "PROMATECT 250", "I9": "Beam", "I10": "Column"}}
        result = self.worksheet("steel_board", "CALCULATOR", inputs=inputs)
        cells = self.cells(result)
        choices = lambda address: result["option_sets"][cells[address]["options_ref"]]
        self.assertEqual(choices("C9"), ["TRAFALGAR COREX", "PROMATECT 250", "PROMATECT 100", "PROMATECT-XS"])
        self.assertEqual(cells["C9"]["options_ref"], cells["C208"]["options_ref"])
        self.assertEqual(cells["D9"]["options_ref"], cells["D208"]["options_ref"])
        self.assertEqual(len(choices("D9")), 1342)
        self.assertEqual(choices("H9"), [30, 60, 90, 120, 180])
        self.assertEqual(choices("H10"), [60, 90, 120, 180])
        self.assertTrue(all(type(value) in (int, float) for value in choices("H9")))
        self.assertEqual(choices("J9"), [620])
        self.assertEqual(choices("J10"), [550])
        self.assertTrue(cells["H9"]["allow_other"])
        self.assertEqual(cells["H9"]["error_style"], "warning")
        self.assertFalse(cells["C9"]["allow_other"])
        self.assertEqual(cells["C9"]["error_style"], "stop")
        self.assertEqual(result["inputs"], inputs)

    def test_advanced_columns_preserve_hidden_inputs_and_readonly_helpers(self):
        normal = self.worksheet("steel_board", "CALCULATOR")
        advanced = self.worksheet("steel_board", "CALCULATOR", include_advanced=True)
        self.assertNotIn("M9", self.cells(normal))
        self.assertNotIn("X208", self.cells(normal))
        self.assertEqual(advanced["visible_columns"], list(range(1, 36)))
        self.assertTrue(self.cells(advanced)["X208"]["editable"])
        self.assertFalse(self.cells(advanced)["AI208"]["editable"])
        duct = self.worksheet("ductwork", "CALCULATOR", include_advanced=True)
        self.assertEqual(duct["visible_columns"], list(range(1, 91)))
        self.assertFalse(self.cells(duct)["CL310"]["editable"])
        self.assertTrue(self.cells(duct)["CL310"]["calculated"])

    def test_current_draft_and_saved_inputs_are_separate(self):
        saved = self.store.save_calculator_state("ductwork", {"CALCULATOR": {"D11": 3}})
        before = self.stored_rows()
        draft = {"CALCULATOR": {"D11": 12.345678901234567}, "PRODUCT SETTINGS": {"B46": 20}}
        changed = self.worksheet("ductwork", "CALCULATOR", inputs=draft)
        self.assertEqual(changed["inputs"], draft)
        self.assertEqual(self.cells(changed)["K11"]["value"], 12.345678901234567)
        current = self.worksheet("ductwork", "CALCULATOR")
        self.assertEqual(current["inputs"], saved["inputs"])
        self.assertEqual(self.cells(current)["K11"]["value"], 3)
        self.assertEqual(self.stored_rows(), before)

    def test_formula_backed_settings_remain_formulas_until_explicitly_overridden(self):
        initial_state = self.store.calculator_state("steel_vermiculite")
        initial_rows = self.stored_rows()
        # An explicit empty input snapshot uses the retained source formulas;
        # a new unsaved state separately carries reviewed application defaults.
        page = self.worksheet("steel_vermiculite", "SETTINGS", inputs={})
        cells = self.cells(page)
        for address in ("D70", "D102", "D179", "D235"):
            self.assertTrue(cells[address]["editable"])
            self.assertTrue(cells[address]["calculated"])
            self.assertIsInstance(cells[address]["value"], (int, float))
        self.assertEqual(page["inputs"], {})
        changed = self.worksheet("steel_vermiculite", "SETTINGS", inputs={"SETTINGS": {"D70": 0.012345678901234567}})
        self.assertEqual(self.cells(changed)["D70"]["value"], 0.012345678901234567)
        self.assertEqual(self.store.calculator_state("steel_vermiculite"), initial_state)
        self.assertEqual(self.stored_rows(), initial_rows)

    def test_source_titles_sections_and_secondary_table_headers_are_distinguished(self):
        cases = [
            ("steel_vermiculite", "CALCULATOR", {"A1": "title", "A5": "section", "H5": "section", "B28": "column_header", "K16": "output"}),
            ("steel_vermiculite", "BAGS", {"A17": "section", "A19": "column_header", "D10": "output", "H10": "spacer"}),
            ("ductwork", "CALCULATOR", {"A1": "title", "A3": "note"}),
            ("ductwork", "SUMMARY", {"A8": "column_header", "A18": "column_header", "A30": "column_header", "A39": "column_header"}),
            ("steel_board", "START", {"A1": "title", "A8": "section"}),
            ("steel_board", "EXTRA BOARDS", {"A5": "column_header", "M5": "column_header"}),
        ]
        for identity, sheet, roles in cases:
            with self.subTest(identity=identity, page=sheet):
                cells = self.cells(self.worksheet(identity, sheet))
                for address, role in roles.items():
                    self.assertEqual(cells[address]["presentation"]["role"], role, address)

    def test_worksheet_rejects_invalid_shapes_hidden_pages_and_caller_extents(self):
        before = self.stored_rows()
        invalid = [{"include_advanced": value} for value in (None, 0, 1, "true", [], {})]
        invalid += [{"sheet": value} for value in ([], {}, False, 0, "STEEL LIBRARY", "missing")]
        invalid += [{"start_row": 1}, {"row_count": 100000}, {"max_row": 1}, {"formula_overrides": {}},
                    {"inputs": []}, {"inputs": True}, {"inputs": {"CALCULATOR": {"K11": 10}}}]
        for body in invalid:
            with self.subTest(body=body):
                self.json_request("POST", "/api/calculators/ductwork/worksheet", body, expected=400)
        self.json_request("PUT", "/api/calculators/ductwork/worksheet", {}, expected=405)
        self.json_request("POST", "/api/calculators/missing/worksheet", {}, expected=400)
        self.assertEqual(self.stored_rows(), before)

    @staticmethod
    def single_row_draft(identity, marker):
        model = source_model(identity)
        schedule = model["schedule"]
        sheet = next(sheet for sheet in model["sheets"] if sheet["name"] == schedule["sheet"])
        columns = [field["column"] for field in schedule["columns"] if field["editable"]]
        cells = {f"{column}{row}": None for row in range(schedule["first_row"], schedule["last_row"] + 1) for column in columns}
        for column in columns:
            address = column + str(schedule["first_row"])
            cells[address] = sheet["cells"].get(address, {}).get("value")
        row = schedule["first_row"]
        if identity == "ductwork":
            cells[f"B{row}"] = "333x222"
            cells[f"D{row}"] = 12.345678901234567
        else:
            cells[f"A{row}"] = marker
            cells[f"F{row}" if identity == "steel_board" else f"J{row}"] = 12.345678901234567
        return {schedule["sheet"]: cells}

    def test_all_three_pdf_downloads_use_the_current_draft_without_saving(self):
        for identity in EXTENTS:
            with self.subTest(identity=identity):
                draft = self.single_row_draft(identity, f"CURRENT DRAFT {identity}")
                pristine = deepcopy(draft)
                model = source_model(identity)
                sheet = model["schedule"]["sheet"]
                marker_cell = "B11" if identity == "ductwork" else "A9" if identity == "steel_board" else "A10"
                self.store.save_calculator_state(identity, {sheet: {marker_cell: "SAVED VALUE EXCLUDED FROM DRAFT"}})
                before = self.stored_rows()
                status, headers, payload = self.request("POST", f"/api/calculators/{identity}/report.pdf", {"inputs": draft})
                self.assertEqual(status, 200, payload[:300])
                self.assertEqual(headers["Content-Type"], "application/pdf")
                self.assertEqual(headers["Content-Disposition"], f'attachment; filename="ceasefire-{identity}-schedule.pdf"')
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(int(headers["Content-Length"]), len(payload))
                reader = PdfReader(BytesIO(payload))
                text = "\n".join(page.extract_text() for page in reader.pages)
                self.assertIn("Full schedule", text)
                self.assertIn("Current calculator snapshot", text)
                for heading in ("Schedule inputs, calculations and complete notes",
                                "Single-member calculator - separate from the schedule",
                                "Manual bag calculation - separate from the schedule",
                                "Settings used for this report"):
                    self.assertNotIn(heading, text)
                self.assertIn("Final product and material summary", text)
                self.assertIn("Overall schedule totals", reader.pages[-1].extract_text())
                if identity != "steel_board":
                    self.assertIn("12.35", text)
                else:
                    # Board length was shown in the removed input-detail
                    # section; its retained schedule reports calculated areas.
                    self.assertIn("Net board", text)
                    self.assertIn("EXTRA BOARDS", text)
                marker = "333x222" if identity == "ductwork" else f"CURRENT DRAFT {identity}"
                self.assertIn("".join(marker.split()), "".join(text.split()))
                self.assertNotIn("SAVED VALUE EXCLUDED FROM DRAFT", text)
                self.assertGreaterEqual(len(reader.pages), 3)
                self.assertTrue(any(obj.get_object().get("/Subtype") == "/Image"
                                    for obj in reader.pages[0]["/Resources"]["/XObject"].values()))
                self.assertEqual(self.stored_rows(), before)
                self.assertEqual(draft, pristine)

    def test_pdf_request_boundaries_reject_invalid_inputs_without_writes(self):
        self.store.save_calculator_state("ductwork", {"CALCULATOR": {"D11": 5}})
        before = self.stored_rows()
        invalid = [{"sheet": "SUMMARY"}, {"include_advanced": True}, {"title": "Unsupported"},
                   {"inputs": []}, {"inputs": True}, {"inputs": {"CALCULATOR": {"M11": 123}}},
                   {"inputs": {"CALCULATOR": {"D11": float("inf")}}}]
        for body in invalid:
            with self.subTest(body=body):
                self.json_request("POST", "/api/calculators/ductwork/report.pdf", body, expected=400)
        self.json_request("PUT", "/api/calculators/ductwork/report.pdf", {}, expected=405)
        self.json_request("POST", "/api/calculators/missing/report.pdf", {}, expected=400)
        self.assertEqual(self.stored_rows(), before)

    def test_all_excel_registers_use_the_current_draft_without_saving(self):
        for identity in EXTENTS:
            with self.subTest(identity=identity):
                draft = self.single_row_draft(identity, f'CURRENT REGISTER {identity}')
                sheet = source_model(identity)['schedule']['sheet']
                marker_cell = 'B11' if identity == 'ductwork' else 'A9' if identity == 'steel_board' else 'A10'
                self.store.save_calculator_state(identity, {sheet: {marker_cell: 'SAVED VALUE EXCLUDED FROM REGISTER'}})
                before = self.stored_rows()
                pristine = deepcopy(draft)
                status, headers, payload = self.request('POST', f'/api/calculators/{identity}/register.xlsx', {'inputs': draft})
                self.assertEqual(status, 200, payload[:300])
                self.assertEqual(headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                self.assertEqual(headers['Content-Disposition'], f'attachment; filename="ceasefire-{identity}-register.xlsx"')
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertEqual(int(headers['Content-Length']), len(payload))
                workbook = load_workbook(BytesIO(payload))
                values = [cell.value for worksheet in workbook for row in worksheet for cell in row]
                marker = '333x222' if identity == 'ductwork' else f'CURRENT REGISTER {identity}'
                self.assertIn(marker, values)
                self.assertNotIn('SAVED VALUE EXCLUDED FROM REGISTER', values)
                if identity != 'steel_board':
                    self.assertIn(12.345678901234567, values)
                self.assertEqual(workbook['Schedule'].max_row, 6)
                self.assertEqual(self.stored_rows(), before)
                self.assertEqual(draft, pristine)

    def test_excel_register_saved_fallback_and_request_boundaries(self):
        self.store.save_calculator_state('ductwork', {'CALCULATOR': {'B11': '700x500', 'D11': 5}})
        before = self.stored_rows()
        status, _, payload = self.request('POST', '/api/calculators/ductwork/register.xlsx', {})
        self.assertEqual(status, 200, payload[:300])
        workbook = load_workbook(BytesIO(payload))
        self.assertEqual(workbook['Schedule']['C6'].value, '700x500')
        self.assertEqual(workbook['Schedule']['D6'].value, 5)
        invalid = [{'sheet': 'SUMMARY'}, {'include_advanced': True}, {'title': 'Unsupported'},
                   {'inputs': []}, {'inputs': True}, {'inputs': {'CALCULATOR': {'M11': 123}}},
                   {'inputs': {'CALCULATOR': {'D11': float('inf')}}}]
        for body in invalid:
            with self.subTest(body=body):
                self.json_request('POST', '/api/calculators/ductwork/register.xlsx', body, expected=400)
        self.json_request('PUT', '/api/calculators/ductwork/register.xlsx', {}, expected=405)
        self.json_request('POST', '/api/calculators/missing/register.xlsx', {}, expected=400)
        self.assertEqual(self.stored_rows(), before)

    def test_pdf_retains_zero_and_incomplete_items_at_the_last_schedule_row(self):
        inputs = self.single_row_draft("steel_board", "ZERO LENGTH REVIEW")
        inputs["CALCULATOR"]["F9"] = 0
        inputs["CALCULATOR"]["A208"] = "LAST ITEM REVIEW"
        inputs["CALCULATOR"]["C208"] = "PROMATECT 250"
        inputs["CALCULATOR"]["F208"] = 0
        before = self.stored_rows()
        status, _, payload = self.request("POST", "/api/calculators/steel_board/report.pdf", {"inputs": inputs})
        self.assertEqual(status, 200, payload[:300])
        text = " ".join(" ".join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages).split())
        self.assertIn("ZERO LENGTH REVIEW", text)
        self.assertIn("LAST ITEM REVIEW", text)
        self.assertIn("2 used schedule items", text)
        self.assertIn("2 item(s) have incomplete or unavailable primary quantities", text)
        self.assertIn("Not available", text)
        self.assertEqual(self.stored_rows(), before)

    def test_worksheet_and_report_keep_a_stale_saved_source_untouched(self):
        stale = {"inputs": {"CALCULATOR": {"D11": 12}}, "source_sha256": "prior-version", "updated_at": "original-time"}
        with self.store.connect() as db:
            db.execute("INSERT INTO calculator_states VALUES(?,?,?)", ("ductwork", json.dumps(stale), "original-time"))
        before = self.stored_rows()
        for route in ("worksheet", "report.pdf", "register.xlsx"):
            with self.subTest(route=route):
                error = self.json_request("POST", f"/api/calculators/ductwork/{route}", {"inputs": {}}, expected=400)
                self.assertIn("version", error["error"])
                self.assertEqual(self.stored_rows(), before)


if __name__ == "__main__":
    unittest.main()
