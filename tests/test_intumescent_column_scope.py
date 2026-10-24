"""Three-sided columns retain inputs without borrowing beam/table authority."""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from estimator.excel_engine import WorkbookEngine
from estimator.intumescent import (CASES, CASE_CHOICES, PRODUCTS, PRODUCT,
                                  IntumescentEngine, model)
from estimator.workbook_calculators import normalize_calculator_inputs


COLUMN = 'I/H column - 3 sides'
ASSESSMENT = SimpleNamespace(digest='test', report_sha256='report', error='')


def inputs(product_name=PRODUCT, **schedule):
    return {'SCHEDULE': {'B10': product_name, 'C10': COLUMN, 'D10': 550,
                         'E10': 'A/V', 'G10': 100, 'H10': 60, 'L10': 10,
                         **schedule},
            'SETTINGS': {'D17': 8000, 'F40': 8000, 'H70': 8000}}


def engine(values):
    return IntumescentEngine(model(), values, assessment=ASSESSMENT,
                             firetex_assessments=(ASSESSMENT, ASSESSMENT))


class IntumescentColumnScopeTests(unittest.TestCase):
    def test_column_is_selectable_and_distinct_from_saved_beam_and_column_aliases(self):
        self.assertIn(COLUMN, CASE_CHOICES)
        self.assertEqual(CASES[COLUMN], 'R3C')
        self.assertEqual(CASES['I/H beam - 3 sides'], 'R3')
        self.assertEqual(CASES['I/H column - 4 sides'], 'R4C')
        self.assertEqual(CASES['I/H beam/column - 4 sides'], 'R4')
        self.assertEqual(normalize_calculator_inputs('steel_intumescent', inputs())
                         ['SCHEDULE']['C10'], COLUMN)

    def test_all_products_hold_dft_and_orders_without_calling_other_case_tables(self):
        with patch('estimator.sc902_assessment.lookup') as sc902, \
                patch('estimator.firetex_assessment.lookup') as firetex:
            for product_name in PRODUCTS:
                with self.subTest(product=product_name):
                    calculated = engine(inputs(product_name))
                    row = calculated.row_result(10)
                    self.assertEqual(row['V'], 'CONFIRM ASSESSMENT')
                    self.assertIn('assessment confirmation required', row['Y'])
                    self.assertEqual(row['M'], 100)
                    self.assertEqual(row['R'], 10)
                    self.assertEqual(row['W'], 'DFT unavailable')
                    for column in ('N', 'O', 'P', 'S', 'T', 'U', 'X'):
                        self.assertEqual(row[column], '')
                    total = calculated.product_totals(product_name)
                    self.assertEqual(total['pending'], 1)
                    self.assertEqual(total['whole'], '')
                    self.assertEqual(total['part_a'], '')
                    self.assertEqual(total['part_b'], '')
            sc902.assert_not_called()
            firetex.assert_not_called()

    def test_held_column_does_not_offer_temperatures_from_a_different_member_table(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                self.assertEqual(engine(inputs(product_name)).temperature_options(10), ())

    def test_geometry_uses_the_three_sided_perimeter_but_still_withholds_dft(self):
        # Retained 310UB40.4 geometry: 3-side girth 1.0908 m, A/V 211.95 m-1.
        # The 4-side girth is 1.2558 m and must not be used for this case.
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name, E10='Section', F10='310UB40.4',
                                    G10=None, I10=2, J10=5, L10=None)).row_result(10)
                self.assertAlmostEqual(row['M'], 211.95)
                self.assertAlmostEqual(row['Q'], 1.0908)
                self.assertAlmostEqual(row['R'], 10.908)
                self.assertEqual(row['O'], '')
                self.assertEqual(row['V'], 'CONFIRM ASSESSMENT')

    def test_three_sided_geometry_hold_and_hollow_family_mismatch_are_respected(self):
        calculated = engine(inputs())
        self.assertIsNone(calculated._geometry('100X100X4SHS', 'R3C')[0])
        original = WorkbookEngine.value

        def held(instance, sheet, address):
            return 1 if sheet == 'SECTIONS' and address == 'BA363' else original(instance, sheet, address)

        with patch.object(WorkbookEngine, 'value', held):
            self.assertIsNone(calculated._geometry('310UB40.4', 'R3C')[0])

    def test_esa_conversion_remains_available_without_releasing_a_thickness(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name, E10='ESA/M', G10=12.5)).row_result(10)
                self.assertEqual(row['M'], 100)
                self.assertEqual(row['O'], '')
                self.assertEqual(row['V'], 'CONFIRM ASSESSMENT')


if __name__ == '__main__':
    unittest.main()
