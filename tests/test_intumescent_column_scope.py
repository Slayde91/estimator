"""User-selected column-table DFT estimates retain three-sided coating geometry."""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from estimator.excel_engine import WorkbookEngine
from estimator.intumescent import (CASES, CASE_CHOICES, PRODUCTS, PRODUCT,
                                  IntumescentEngine, model)
from estimator.workbook_calculators import normalize_calculator_inputs
from estimator.sc902_assessment import lookup as native_sc902_lookup
from estimator.firetex_assessment import lookup as native_firetex_lookup


COLUMN = 'I/H column - 3 sides'
ASSESSMENT = SimpleNamespace(digest='test', report_sha256='report', error='')
ESTIMATE_STATUS = 'ESTIMATE - FOUR-SIDED COLUMN TABLE'
DFT_RESULT = {'dft': 1000, 'factor': 100, 'status': 'PUBLISHED - ASSESSMENT TABLE',
              'source': 'Synthetic four-sided column report p20 Table 14; A/V 100; 550C; 60 min',
              'note': 'Original column-table selection and conditions.'}


def inputs(product_name=PRODUCT, **schedule):
    return {'SCHEDULE': {'B10': product_name, 'C10': COLUMN, 'D10': 550,
                         'E10': 'A/V', 'G10': 100, 'H10': 60, 'L10': 10,
                         **schedule},
            'SETTINGS': {'D17': 8000, 'F40': 8000, 'H70': 8000}}


def engine(values):
    return IntumescentEngine(model(), values, assessment=ASSESSMENT,
                             firetex_assessments=(ASSESSMENT, ASSESSMENT))


class IntumescentColumnScopeTests(unittest.TestCase):
    def setUp(self):
        self.sc902 = patch('estimator.sc902_assessment.lookup', return_value=DFT_RESULT).start()
        self.firetex = patch('estimator.firetex_assessment.lookup', return_value=DFT_RESULT).start()
        self.addCleanup(patch.stopall)

    def test_column_is_selectable_and_distinct_from_saved_beam_and_column_aliases(self):
        self.assertIn(COLUMN, CASE_CHOICES)
        self.assertEqual(CASES[COLUMN], 'R3C')
        self.assertEqual(CASES['I/H beam - 3 sides'], 'R3')
        self.assertEqual(CASES['I/H column - 4 sides'], 'R4C')
        self.assertEqual(CASES['I/H beam/column - 4 sides'], 'R4')
        self.assertEqual(normalize_calculator_inputs('steel_intumescent', inputs())
                         ['SCHEDULE']['C10'], COLUMN)

    def test_all_products_use_column_tables_with_explicit_estimate_provenance(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                calculated = engine(inputs(product_name))
                row = calculated.row_result(10)
                selected = self.sc902 if product_name == PRODUCT else self.firetex
                self.assertEqual(selected.call_args.kwargs['case'], 'R4')
                self.assertEqual(selected.call_args.args[1:4], (100, 550, 60))
                self.assertEqual(row['V'], ESTIMATE_STATUS)
                self.assertIn('four-sided column DFT at A/V 100; three-sided coating area and quantities', row['Y'])
                self.assertIn(DFT_RESULT['note'], row['Y'])
                self.assertEqual(row['M'], 100)
                self.assertEqual(row['N'], 100)
                self.assertEqual(row['O'], 1000)
                self.assertEqual(row['X'], DFT_RESULT['source'])
                self.assertEqual(row['R'], 10)
                self.assertEqual(row['W'], 'QUANTIFIED - estimate')
                self.assertEqual(calculated.product_totals(product_name)['pending'], 0)
                self.assertEqual(calculated.product_totals(product_name)['whole'], 1)
        self.assertEqual(DFT_RESULT['status'], 'PUBLISHED - ASSESSMENT TABLE')

    def test_column_temperatures_match_each_products_four_sided_column_table(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                options = engine(inputs(product_name)).temperature_options(10)
                four_sided = inputs(product_name, C10='I/H column - 4 sides')
                self.assertTrue(options)
                self.assertEqual(options, engine(four_sided).temperature_options(10))

    def test_quantities_use_three_sided_perimeter_with_column_table_dft(self):
        # Retained 310UB40.4 geometry: 3-side girth 1.0908 m, A/V 211.95 m-1.
        # The 4-side girth is 1.2558 m and must not be used for this case.
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name, E10='Section', F10='310UB40.4',
                                    G10=None, I10=2, J10=5, L10=None)).row_result(10)
                self.assertAlmostEqual(row['Q'], 1.0908)
                self.assertAlmostEqual(row['R'], 10.908)
                self.assertEqual(row['O'], 1000)
                self.assertEqual(row['V'], ESTIMATE_STATUS)
                expected_litres = (10.908 * 1.75 / 1.46 if product_name == PRODUCT else
                                   10.908 / (.69 if product_name == PRODUCTS[1] else .92))
                self.assertAlmostEqual(row['S'], expected_litres)

    def test_three_sided_geometry_hold_and_hollow_family_mismatch_are_respected(self):
        calculated = engine(inputs())
        self.assertIsNone(calculated._geometry('100X100X4SHS', 'R3C')[0])
        original = WorkbookEngine.value

        def held(instance, sheet, address):
            return 1 if sheet == 'SECTIONS' and address == 'BA363' else original(instance, sheet, address)

        with patch.object(WorkbookEngine, 'value', held):
            self.assertIsNone(calculated._geometry('310UB40.4', 'R3C')[0])

    def test_named_dft_uses_four_sided_factor_while_input_factor_and_area_stay_three_sided(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name, E10='Section', F10='310UB40.4',
                                    G10=None, I10=2, J10=5, L10=None)).row_result(10)
                selected = self.sc902 if product_name == PRODUCT else self.firetex
                self.assertAlmostEqual(selected.call_args.args[1], 244.01064356435646)
                self.assertEqual(selected.call_args.kwargs['case'], 'R4')
                self.assertAlmostEqual(row['M'], 211.95)
                self.assertAlmostEqual(row['Q'], 1.0908)
                self.assertAlmostEqual(row['R'], 10.908)
                self.assertIn('four-sided column DFT at A/V 244.01064356435646', row['Y'])

    def test_four_sided_factor_review_hold_blocks_dft_even_when_three_sided_geometry_is_usable(self):
        original = WorkbookEngine.value

        def held(instance, sheet, address):
            return 1 if sheet == 'SECTIONS' and address == 'BB363' else original(instance, sheet, address)

        for product_name in PRODUCTS:
            with self.subTest(product=product_name), patch.object(WorkbookEngine, 'value', held):
                row = engine(inputs(product_name, E10='Section', F10='310UB40.4',
                                    G10=None, I10=2, J10=5, L10=None)).row_result(10)
                self.assertEqual(row['V'], 'CHECK INPUT')
                self.assertIn('Four-sided column DFT geometry', row['Y'])
                self.assertEqual(row['O'], '')
                self.assertAlmostEqual(row['R'], 10.908)

    def test_named_case_does_not_extend_the_new_rule_to_non_i_h_families(self):
        calculated = engine(inputs())
        from estimator.workbook_runtime import _application_catalog
        cells = next(s for s in _application_catalog('steel_vermiculite')['sheets']
                     if s['name'] == 'SECTIONS')['cells']
        member = next(cells[f'A{row}']['value'] for row in range(6, 561)
                      if cells.get(f'B{row}', {}).get('value') == 'PFC')
        self.assertIsNone(calculated._geometry(member, 'R3C')[0])

    def test_native_column_lookup_matches_complete_four_sided_calculation_for_all_products(self):
        # Invented monotone table values make 215 and245 different. This exercises
        # the native lookups independently of the routing mocks and private data.
        axes = dict(factors=(100, 215, 245, 320), temperatures=(550,),
                    values=((500,), (1000,), (4000,), (5000,)))
        sc_table = SimpleNamespace(**axes, case='R4', period=60, table=14,
                                   pages=(20,), source_pages_by_row=(20,)*4,
                                   red_applicable=((False,),)*4, mesh_required=False)
        sc = SimpleNamespace(error='', digest='synthetic', tables=(sc_table,)*32)
        firetex = tuple(SimpleNamespace(product=name, error='', digest='synthetic',
                                        tables=(SimpleNamespace(**axes, case='R4', period=60,
                                                                 table=table, pages=(table+1,)),)*count)
                         for name, table, count in ((PRODUCTS[1], 16, 40), (PRODUCTS[2], 14, 46)))
        with patch('estimator.sc902_assessment.lookup', side_effect=native_sc902_lookup), \
                patch('estimator.firetex_assessment.lookup', side_effect=native_firetex_lookup):
            for product_name in PRODUCTS:
                with self.subTest(product=product_name):
                    raw = inputs(product_name, E10='Section', F10='310UB40.4',
                                 G10=None, I10=2, J10=5, L10=None)
                    three = IntumescentEngine(model(), raw, assessment=sc,
                                               firetex_assessments=firetex).row_result(10)
                    raw['SCHEDULE']['C10'] = 'I/H column - 4 sides'
                    four = IntumescentEngine(model(), raw, assessment=sc,
                                              firetex_assessments=firetex).row_result(10)
                    self.assertEqual(three['O'], four['O'])
                    self.assertEqual(three['O'], 4000)
                    self.assertEqual(three['N'], four['N'])
                    self.assertEqual(three['N'], 245)
                    self.assertAlmostEqual(three['M'], 211.95)
                    self.assertAlmostEqual(four['M'], 244.01064356435646)
                    self.assertAlmostEqual(three['Q'], 1.0908)
                    self.assertAlmostEqual(four['Q'], 1.2558)
                    self.assertAlmostEqual(three['R'], 10.908)
                    self.assertAlmostEqual(four['R'], 12.558)
                    self.assertAlmostEqual(three['S']/four['S'], 1.0908/1.2558)
                    self.assertEqual(three['X'], four['X'])
                    self.assertEqual(three['V'], ESTIMATE_STATUS)
                    self.assertNotIn('Three-sided beam with concrete slab contact.', three['Y'])

    def test_esa_conversion_uses_supplied_factor_in_the_column_table(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name, E10='ESA/M', G10=12.5)).row_result(10)
                self.assertEqual(row['M'], 100)
                selected = self.sc902 if product_name == PRODUCT else self.firetex
                self.assertEqual(selected.call_args.args[1], 100)
                self.assertEqual(selected.call_args.kwargs['case'], 'R4')
                self.assertEqual(row['O'], 1000)
                self.assertEqual(row['V'], ESTIMATE_STATUS)

    def test_column_table_holds_are_not_overridden_by_the_estimating_policy(self):
        missing = {'dft': None, 'status': 'NO PUBLISHED CELL',
                   'note': 'The four-sided column table has no usable value.'}
        self.sc902.return_value = self.firetex.return_value = missing
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name)).row_result(10)
                self.assertEqual(row['V'], missing['status'])
                self.assertEqual(row['O'], '')
                self.assertEqual(row['W'], 'DFT unavailable')
                for column in 'PSTU':
                    self.assertEqual(row[column], '')

    def test_existing_four_sided_columns_retain_their_original_assessment_status(self):
        for product_name in PRODUCTS:
            with self.subTest(product=product_name):
                row = engine(inputs(product_name, C10='I/H column - 4 sides')).row_result(10)
                self.assertEqual(row['V'], DFT_RESULT['status'])
                self.assertNotIn('Estimate: four-sided column DFT', row['Y'])


if __name__ == '__main__':
    unittest.main()
