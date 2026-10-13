"""Combined reports include current entered schedules without saving them."""
from copy import deepcopy
from io import BytesIO
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.project_reports import build_project_report
from tests.test_penetration_labour_exports import draft


class ProjectReportTests(unittest.TestCase):
    def test_empty_and_settings_only_schedules_do_not_export_examples(self):
        for calculators in ({}, {'steel_vermiculite': {'inputs': {'SETTINGS': {'D10': 7850}}}}):
            with self.subTest(calculators=calculators), self.assertRaisesRegex(ValidationError, 'at least one schedule row'):
                build_project_report(calculators, {'globals': {}, 'rows': []}, {}, {})

    def test_partial_and_zero_rows_are_included_and_other_calculators_skipped(self):
        for value in ('Partial member', 0):
            calculators = {'steel_board': {'inputs': {'CALCULATOR': {'A9': value}}}}
            payload = build_project_report(calculators, None, {}, {})
            reader = PdfReader(BytesIO(payload))
            self.assertEqual([entry.title for entry in reader.outline], ['Steel board'])
            self.assertTrue(reader.pages)

    def test_schedule_and_product_summary_include_all_four_sections_and_branding(self):
        calculators = {
            'steel_vermiculite': {'inputs': {'SCHEDULE': {'A10': 'Spray fixture', 'B10': 'CAFCO 300', 'C10': 'Re-entrant - 3 sides', 'D10': 620, 'E10': 'Section', 'F10': '410UB54', 'H10': 120, 'I10': 2, 'J10': 3}}},
            'steel_board': {'inputs': {'CALCULATOR': {'A9': 'Board fixture', 'C9': 'PROMATECT-XS', 'D9': '200UC46', 'F9': 10, 'G9': 4, 'H9': 120, 'I9': 'Column', 'J9': 550}}},
            'ductwork': {'inputs': {'CALCULATOR': {'B11': '250x250', 'C11': 'CAFCO 300', 'D11': 10, 'E11': '120/120/120', 'F11': 1, 'G11': 0, 'H11': 'External', 'I11': 'Horizontal'}}}}
        fire = draft()
        before = deepcopy((calculators, fire))
        company = {**DEFAULTS, 'name': 'Combined Fixture', 'email': 'combined@example.test'}
        for materials in (False, True):
            with self.subTest(materials=materials):
                result = build_project_report(calculators, fire, {}, {'project_no': 'FULL-TEST'}, materials=materials, company=company)
                reader = PdfReader(BytesIO(result))
                self.assertEqual([entry.title for entry in reader.outline], ['Steel spray', 'Steel board', 'Ductwork', 'Firestopping'])
                text = '\n'.join(page.extract_text() for page in reader.pages)
                for page in reader.pages:
                    self.assertIn('Combined Fixture', page.extract_text())
                    self.assertIn('combined@example.test', page.extract_text())
                    body = []
                    page.extract_text(visitor_text=lambda text, cm, tm, font, size: body.append(text)
                                      if 43 < tm[4] * cm[1] + tm[5] * cm[3] + cm[5] < 500 else None)
                    self.assertTrue(''.join(body).strip(), 'Every combined PDF page includes report content')
                self.assertIn('FULL-TEST', text)
                self.assertIn('Firestopping product summary' if materials else 'Firestopping schedule', text)
                if not materials:
                    self.assertEqual(text.count('FULL-TEST'), 1)
                    self.assertEqual(text.count('Project details'), 1)
                    for pricing in ('$', 'Grand total', 'Item total', 'Amount / quantity', 'Unit price'):
                        self.assertNotIn(pricing, text)
                self.assertEqual((calculators, fire), before)

    def test_first_nonempty_section_owns_the_only_project_details(self):
        for calculators, fire in (
                ({'steel_board': {'inputs': {'CALCULATOR': {'A9': 'Partial board'}}}}, draft()),
                ({}, draft())):
            with self.subTest(calculators=calculators):
                reader = PdfReader(BytesIO(build_project_report(calculators, fire, {}, {'client': 'ONCE-CLIENT'})))
                texts = [page.extract_text() for page in reader.pages]
                self.assertIn('ONCE-CLIENT', texts[0])
                self.assertEqual('\n'.join(texts).count('ONCE-CLIENT'), 1)

    def test_untrusted_calculated_cells_and_unknown_calculators_are_rejected(self):
        for calculators in ({'unknown': {}}, {'steel_board': {'inputs': {'CALCULATOR': {'AR9': 2}}}}):
            with self.subTest(calculators=calculators), self.assertRaises(ValidationError):
                build_project_report(calculators, None, {}, {})

    def test_firestopping_product_summary_uses_captured_calculation_rates(self):
        from estimator.penetration_calculator import calculate, definition
        from estimator.penetration_report import render_penetration_summary_pdf
        result = calculate(draft())
        result['material_breakdown'] = [{'name': 'Frozen product', 'context': 'Collars', 'quantity': 2.5,
            'units': 'each', 'price': 123.45, 'total': 308.625}]
        snapshot = deepcopy(result)
        text = '\n'.join(p.extract_text() for p in PdfReader(BytesIO(render_penetration_summary_pdf(result, definition(), {}))).pages)
        for value in ('Frozen product', '2.50', '$123.45', '$308.63'):
            self.assertIn(value, text)
        self.assertEqual(result, snapshot)
