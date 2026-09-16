"""Verify PDF content against independent Excel outputs and saved snapshots."""

from copy import deepcopy
from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.calculator import calculate
from estimator.catalog import ROOT
from estimator.report import render_quote_pdf, _number, _Report
from estimator.presentation import calculation_error_details
from estimator.storage import Store


def pdf_text(payload):
    return "\n".join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)


def money_text(amount):
    return "$" + format(Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), ",.2f")


class ReportTests(unittest.TestCase):
    def test_pdf_table_headers_text_and_numbers_are_centered(self):
        report = _Report({})
        table = report.table(['Description', 'Amount'], [[report.p('Material', 'cell'), report.p('123.45', 'numeric')]], [200, 100])
        for row in table._cellvalues:
            for paragraph in row:
                self.assertEqual(paragraph.style.alignment, 1)
        self.assertTrue(all(style.alignment == 'CENTER' and style.valign == 'MIDDLE'
                            for row in table._cellStyles for style in row))

    @classmethod
    def setUpClass(cls):
        oracle = json.loads((ROOT / "tests/fixtures/excel-calculator-oracle.json").read_text(encoding="utf-8-sig"))
        cls.scenario = next(s for s in oracle["scenarios"] if s["id"] == "combined-adjustments")
        with tempfile.TemporaryDirectory() as folder:
            cls.quote = Store(Path(folder) / "test.sqlite3").prepare_quote({
                "title": "PDF reconciliation", "inputs": cls.scenario["inputs"],
                "measurements": "Assessed ductwork: 123.45 m²; all costs included.",
            })
        cls.payload = render_quote_pdf(cls.quote)
        cls.reader = PdfReader(BytesIO(cls.payload))
        cls.text = pdf_text(cls.payload)

    def test_all_cost_lines_and_totals_come_from_excel(self):
        compact = "".join(self.text.split())
        expected = self.scenario["expected"]
        # Actual priced component cells, independently recorded from Excel.
        amounts = [expected[f"F{row}"] for row in (63, 65, 68, 70, 73, 77, 79, 82, 84, 87, 89, 92, 94, 97, 99, 102, 104)]
        amounts += [expected[f"D{row}"] for row in range(112, 120)]
        amounts += [expected["B51"] * expected["B53"], expected["B52"] * expected["B53"], expected["B57"], expected["D27"]]
        for amount in amounts:
            with self.subTest(amount=amount):
                self.assertIn(money_text(amount), compact)
        for cell in ("F2", "F3", "F4", "F5", "F6", "F7", "F8", "D27"):
            self.assertIn(money_text(expected[cell]), compact, cell)
        for label in ("Material breakdown", "Labour and masking", "Pins / clips", "Masking labour", "Masking materials", "Masking material adjustment", "Mobilisation", "Administration", "Material freight", "Access freight", "Access hire", "Travel", "Accommodation", "Extra labour", "Fixed adjustment", "Quote notes"):
            self.assertIn(label, self.text)
        for token in ("1.66", "1.91", "27.59"):
            self.assertIn(token, self.text, "Do not split a priced quantity across lines")
        self.assertIn("unrounded", self.text)
        self.assertIn("123.45 m²", self.text)
        self.assertNotRegex(self.text, r"\b\d[\d,]*\.\d{3,}\b")

    def test_official_logo_and_fonts_are_embedded_on_each_page(self):
        self.assertEqual(sha256((ROOT / "static/ceasefire-logo.png").read_bytes()).hexdigest(), "b390a843144556546558d166207f476d7e2197070ec35a1a23064fbbb7da9ac7")
        self.assertGreaterEqual(len(self.reader.pages), 4)
        for page in self.reader.pages:
            for contact in ("ABN: 50 612 231 562", "Phone: 1300 92 62 88", "Email: sales@ceasefire.com.au"):
                self.assertIn(contact, page.extract_text())
            images = [obj.get_object() for obj in page["/Resources"]["/XObject"].values()]
            self.assertTrue(any(obj.get("/Subtype") == "/Image" and obj.get("/Width") == 5375 and obj.get("/Height") == 1790 for obj in images))
            fonts = [obj.get_object() for obj in page["/Resources"]["/Font"].values()]
            self.assertTrue(any("/FontFile2" in font.get("/FontDescriptor", {}) for font in fonts))
        self.assertEqual(self.reader.metadata.author, "Ceasefire")

    def test_long_notes_markup_and_long_words_survive_pagination(self):
        quote = deepcopy(self.quote)
        quote["title"] = "<b>Literal & quoted title</b> " + "W" * 660 + " TITLE END"
        quote["client"] = "Long client " + "C" * 190 + " CLIENT END"
        quote["site_address"] = "Long address " + "S" * 270 + " SITE END"
        quote["project_no"] = "Long project " + "P" * 90 + " PROJECT END"
        quote["measurements"] = "\n".join(f"Inspection note {i}: <img src='https://example.invalid/tracker'> & site details." for i in range(180)) + "\n" + "X" * 1000 + " FINAL MEASUREMENT"
        quote["inputs"]["B12"] = "<b>Do not interpret as markup</b> & allowances"
        before = deepcopy(quote)
        payload = render_quote_pdf(quote)
        text = pdf_text(payload)
        self.assertGreater(len(PdfReader(BytesIO(payload)).pages), len(self.reader.pages))
        self.assertIn("<b>Literal & quoted title</b>", text)
        for final_token in ("TITLE END", "CLIENT END", "SITE END", "PROJECT END"):
            self.assertIn(final_token.replace(" ", ""), "".join(text.split()))
        self.assertIn("<img src='https://example.invalid/tracker'>", text)
        self.assertIn("Inspection note 179", text)
        self.assertIn("FINAL MEASUREMENT", text)
        self.assertNotIn(quote["source_hashes"]["quote"]["sha256"], "".join(text.split()))
        self.assertEqual(quote, before)

    def test_requested_pdf_blocks_are_omitted_but_quote_details_and_notes_remain(self):
        quote = deepcopy(self.quote)
        quote.update({"client": "Example Client 12.3456", "site_address": "18 Example Road, Suite 3.4567",
                      "project_no": "CF-2026.12345", "work_summary": "Stored work summary: 12.35 m² of coating."})
        text = pdf_text(render_quote_pdf(quote))
        for token in ("Client", "Site Address", "Project No.", "NOTES",
                      quote["client"], quote["site_address"], quote["project_no"], quote["measurements"]):
            self.assertIn(token, text)
        for token in ("Work summary", quote["work_summary"], "Material pricing and quantities",
                      "The material category total on the summary also contains",
                      "Project area / items:", "Coverage and units are entered by the estimator.",
                      "Masking allowance:", "Measurement / technical notes", "Estimator notes"):
            self.assertNotIn(token, text)
        for token in ("Material breakdown", "Material / yield", "Line amount", "Labour and masking",
                      "Masking / cleaning", "Masking labour", "Masking materials", "Masking material adjustment",
                      "Additions and project costs", "Generated material and allowance notes"):
            self.assertIn(token, text)
        quote.pop("work_summary")
        before = deepcopy(quote)
        with patch("estimator.calculator.calculate", side_effect=AssertionError("Report recalculated")), patch("estimator.catalog.baseline", side_effect=AssertionError("Report consulted current prices")):
            fallback = pdf_text(render_quote_pdf(quote))
        self.assertNotIn("Work summary", fallback)
        self.assertIn("Spray", fallback)
        self.assertEqual(quote, before)

    def test_two_decimal_display_never_rewrites_quote_values_or_literal_numbers(self):
        quote = deepcopy(self.quote)
        quote.pop("work_summary", None)
        quote["inputs"]["D15"] = "Special coating 12.34567"
        quote["result"]["inputs"]["D15"] = quote["inputs"]["D15"]
        quote["inputs"]["B12"] = "User measurement 98.76543 remains literal."
        quote["measurements"] = "Plan reference 123.456789; user measurement 98.76543 remains literal."
        quote["result"]["cells"].update({"A63": 2.675, "F63": 12.34567, "B35": 1.234567,
                                          "D27": -2.675, "F7": 100.12345})
        before = deepcopy(quote)
        text = pdf_text(render_quote_pdf(quote))
        for token in ("$2.68", "$12.35", "1.23", "$-2.68", "$100.12"):
            self.assertIn(token, text)
        self.assertNotIn("User measurement 98.76543 remains literal.", text)
        for literal in ("Special coating 12.34567", "Plan reference 123.456789; user measurement 98.76543 remains literal."):
            self.assertIn(literal, text)
            text = text.replace(literal, "literal")
        self.assertNotRegex(text, r"\b\d[\d,]*\.\d{3,}\b")
        self.assertEqual(quote, before)

    def test_removing_duplicate_notes_field_preserves_generated_notes_and_saved_inputs(self):
        quote = deepcopy(self.quote)
        quote['inputs']['B12'] = 'Retained allowance note'
        quote['result']['notes'] = 'Retained allowance note\n\nGenerated board requirement: 7 sheets.'
        before = deepcopy(quote)
        text = pdf_text(render_quote_pdf(quote))
        self.assertNotIn('Estimator notes', text)
        self.assertEqual(text.count('Retained allowance note'), 1)
        self.assertIn('Generated board requirement: 7 sheets.', text)
        self.assertIn('NOTES', text)
        self.assertEqual(quote, before)

    def test_numeric_formatter_handles_rounding_negatives_tiny_and_large_values(self):
        cases = ((2.675, "2.68"), (-2.675, "-2.68"), (0.0049, "0.00"),
                 (-0.0049, "0.00"), (1234567.8912, "1,234,567.89"))
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(_number(value), expected)
        self.assertEqual(_number(.12675, percent=True), "12.68%")
        self.assertEqual(_number(.14505, percent=True), "14.51%")
        self.assertEqual(_number(-.14505, percent=True), "-14.51%")
        self.assertTrue(_number(1e308).endswith(".00"))
        self.assertEqual(_number(float("inf")), "Unavailable: non-finite value")

    def test_errors_are_explicit_and_valid_totals_remain_visible(self):
        for inputs in ({"B8": 0}, {"C15": 0}, {"D15": "Unknown product"}):
            with self.subTest(inputs=inputs):
                quote = deepcopy(self.quote)
                quote["result"] = calculate(inputs)
                quote["inputs"] = quote["result"]["inputs"]
                text = pdf_text(render_quote_pdf(quote))
                self.assertIn("CALCULATION INCOMPLETE", text)
                for error in calculation_error_details(quote["result"]):
                    self.assertIn("".join(error["label"].split()), "".join(text.split()))
                    self.assertIn(error["code"], text)
                self.assertNotIn("Calculator!", text)
                if inputs == {"B8": 0}:
                    self.assertIn("$1,260.00", text)
                    self.assertIn("Unavailable: #DIV/0!", text)

    def test_customer_report_uses_business_labels_without_source_audit_clutter(self):
        self.assertNotRegex(self.text, r"\b[A-F]\d{1,3}\b")
        for technical_label in ("Calculator!", "SHA-256", "Catalogue structure signature", "Reconciliation checks", "Second subtotal", "Affected source cell", "row 15"):
            self.assertNotIn(technical_label, self.text)
        self.assertEqual(self.text.count("Grand total"), 1)
        self.assertIn("Total project days", self.text)
        self.assertIn("Rate per project area / item", self.text)

    def test_older_saved_snapshot_never_reads_current_pricing_or_recalculates(self):
        quote = deepcopy(self.quote)
        quote["result"].pop("masking")
        before = deepcopy(quote)
        with patch("estimator.calculator.calculate", side_effect=AssertionError("Report recalculated")), patch("estimator.catalog.baseline", side_effect=AssertionError("Report consulted current prices")):
            text = pdf_text(render_quote_pdf(quote))
        self.assertNotIn("Unavailable", text)
        self.assertIn("$147,070.68", text)
        self.assertEqual(quote, before)


if __name__ == "__main__":
    unittest.main()
