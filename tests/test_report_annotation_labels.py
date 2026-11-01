"""Requested report captions stay in the footer on every page."""
from io import BytesIO
import unittest

from pypdf import PdfReader

from estimator.calculator_report import build_calculator_report, build_calculator_summary_report
from estimator.schedule_rows import blank_schedule_defaults


class ReportAnnotationLabelsTests(unittest.TestCase):
    def test_standalone_titles_and_footers_do_not_reintroduce_header_captions(self):
        scopes = {
            'steel_vermiculite': 'STRUCTURAL STEEL | SPRAY',
            'steel_board': 'STRUCTURAL STEEL | BOARD',
            'steel_intumescent': 'STRUCTURAL STEEL | INTUMESCENT PAINT',
            'ductwork': 'DUCTWORK | WRAP / SPRAY',
        }
        for identity, scope in scopes.items():
            for materials, builder in ((False, build_calculator_report), (True, build_calculator_summary_report)):
                with self.subTest(identity=identity, materials=materials):
                    if materials and identity == 'ductwork':
                        scope = 'DUCT | SPRAY / WRAP'
                    expected = scope + (' | PRODUCT SUMMARY' if materials else ' | FULL SCHEDULE')
                    reader = PdfReader(BytesIO(builder(identity, blank_schedule_defaults(identity, {}))))
                    for page in reader.pages:
                        text = page.extract_text()
                        self.assertNotIn('CALCULATORS |', text)
                        self.assertNotIn('CLASSIFIRE ESTIMATOR |', text)
                        footer = []
                        page.extract_text(visitor_text=lambda value, cm, tm, font, size:
                                          footer.append((tm[4], tm[5])) if expected in value and size == 7 else None)
                        self.assertEqual(footer, [(32.0, 20.0)])
                    if materials:
                        self.assertIn(expected, reader.pages[0].extract_text())
