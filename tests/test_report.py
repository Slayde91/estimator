"""Verify PDF content against independent Excel outputs and saved snapshots."""

from copy import deepcopy
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
from estimator.report import render_quote_pdf
from estimator.storage import Store


def pdf_text(payload):
    return "\n".join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)


class ReportTests(unittest.TestCase):
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
                self.assertIn("$" + f"{amount:,.8f}".rstrip("0").rstrip("."), compact)
        for cell in ("F2", "F3", "F4", "F5", "F6", "F7", "F8", "D27"):
            self.assertIn(f"${expected[cell]:,.2f}", compact, cell)
        for label in ("Material breakdown", "Labour and masking", "Pins / clips", "Masking labour", "Masking materials", "Masking material adjustment", "Mobilisation", "Administration", "Material freight", "Access freight", "Access hire", "Travel", "Accommodation", "Extra labour", "Fixed adjustment", "Notes and traceability"):
            self.assertIn(label, self.text)
        for token in ("1.66458333", "1.91427083", "27.58802083"):
            self.assertIn(token, self.text, "Do not split a priced quantity across lines")
        self.assertIn("unrounded", self.text)
        self.assertIn("123.45 m²", self.text)

    def test_official_logo_and_fonts_are_embedded_on_each_page(self):
        self.assertEqual(sha256((ROOT / "static/ceasefire-logo.png").read_bytes()).hexdigest(), "b390a843144556546558d166207f476d7e2197070ec35a1a23064fbbb7da9ac7")
        self.assertGreaterEqual(len(self.reader.pages), 4)
        for page in self.reader.pages:
            images = [obj.get_object() for obj in page["/Resources"]["/XObject"].values()]
            self.assertTrue(any(obj.get("/Subtype") == "/Image" and obj.get("/Width") == 5375 and obj.get("/Height") == 1790 for obj in images))
            fonts = [obj.get_object() for obj in page["/Resources"]["/Font"].values()]
            self.assertTrue(any("/FontFile2" in font.get("/FontDescriptor", {}) for font in fonts))
        self.assertEqual(self.reader.metadata.author, "Ceasefire")

    def test_long_notes_markup_and_long_words_survive_pagination(self):
        quote = deepcopy(self.quote)
        quote["title"] = "<b>Literal & quoted title</b> " + "W" * 170
        quote["measurements"] = "\n".join(f"Inspection note {i}: <img src='https://example.invalid/tracker'> & site details." for i in range(180)) + "\n" + "X" * 1000 + " FINAL MEASUREMENT"
        quote["inputs"]["B12"] = "<b>Do not interpret as markup</b> & allowances"
        before = deepcopy(quote)
        payload = render_quote_pdf(quote)
        text = pdf_text(payload)
        self.assertGreater(len(PdfReader(BytesIO(payload)).pages), len(self.reader.pages))
        self.assertIn("<b>Literal & quoted title</b>", text)
        self.assertIn("<img src='https://example.invalid/tracker'>", text)
        self.assertIn("Inspection note 179", text)
        self.assertIn("FINAL MEASUREMENT", text)
        self.assertIn(quote["source_hashes"]["quote"]["sha256"], "".join(text.split()))
        self.assertEqual(quote, before)

    def test_errors_are_explicit_and_valid_totals_remain_visible(self):
        for inputs in ({"B8": 0}, {"C15": 0}, {"D15": "Unknown product"}):
            with self.subTest(inputs=inputs):
                quote = deepcopy(self.quote)
                quote["result"] = calculate(inputs)
                quote["inputs"] = quote["result"]["inputs"]
                text = pdf_text(render_quote_pdf(quote))
                self.assertIn("CALCULATION INCOMPLETE", text)
                for cell, error in quote["result"]["errors"].items():
                    self.assertIn("Calculator!" + cell, text)
                    self.assertIn(error, text)
                if inputs == {"B8": 0}:
                    self.assertIn("$1,260.00", text)
                    self.assertIn("Unavailable: #DIV/0!", text)

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
