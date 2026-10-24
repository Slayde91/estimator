"""Published Promat cells, scope boundaries and boxed purchasing geometry."""

from copy import deepcopy
import math
import unittest

from estimator.board_steel_area import boxed_girth, board_layer_girths, board_net_steel_areas
from estimator.excel_engine import WorkbookEngine
from estimator.promat_board_assessment import (
    PromatBoardEngine, assessment_tables, canonical_product, chs_section_aliases, lookup_thickness,
    select_stock, steel_id_choices, stock_choices,
)
from estimator.schedule_quantity import application_formula_overrides, quantity_engine_inputs
from estimator.workbook_calculators import approved_formula_overrides, source_model
from tests.test_board_product_totals import example_inputs
from tests.test_workbook_parity import excel_equal, read_fixture, scenario_inputs


def engine_for(inputs):
    model = source_model('steel_board')
    return PromatBoardEngine(model, quantity_engine_inputs(model, inputs),
                             application_formula_overrides(model, approved_formula_overrides('steel_board')))


class PromatAssessmentTests(unittest.TestCase):
    def test_complete_reviewed_tables_retain_unavailable_cells(self):
        tables = assessment_tables()
        self.assertEqual(len(tables), 19)
        self.assertEqual(sum(len(table['rows']) for table in tables.values()), 1045)
        self.assertEqual(sum(value is not None for table in tables.values()
                             for _, row in table['rows'] for value in row), 4781)
        # Visually checked source Table5 pp14–15; blank180min at105 is not45.
        table = tables['Column', 350]
        self.assertEqual(table['rows'][14], [100, [10, 15, 23, 30, 45]])
        self.assertEqual(table['rows'][15], [105, [10, 16, 23, 31, None]])
        self.assertEqual(table['rows'][-1], [300, [16, 24, 33, None, None]])
        # Independently selected Table21 pp62–63 (620°C three-side beams).
        self.assertEqual(tables['Beam', 620]['rows'][14], [100, [10, 10, 13, 15, 28]])
        self.assertEqual(tables['Beam', 620]['rows'][44], [250, [12, 12, 19, 27, None]])

    def test_published_axes_conservative_selection_and_precise_actual_factor(self):
        result = lookup_thickness('PROMATECT 100', 'Column', 4, 575, 100.00000001, 119.5)
        self.assertEqual(result['factor'], 100.00000001)
        self.assertEqual((result['temperature_used'], result['factor_used'], result['period_used']), (550, 105, 120))
        self.assertEqual((result['required_mm'], result['layers_mm']), (20, (20,)))
        self.assertIn('FC15555-01-03', result['source'])
        self.assertIn('Table 10', result['source'])
        self.assertEqual(lookup_thickness('PROMATECT 100', 'Column', 4, 350, 1, 15)['required_mm'], 10)

    def test_four_side_beam_uses_column_table_not_three_side_beam(self):
        beam = lookup_thickness('PROMATECT 100', 'Beam', 4, 620, 100, 180)
        column = lookup_thickness('PROMATECT 100', 'Column', 4, 620, 100, 180)
        three = lookup_thickness('PROMATECT 100', 'Beam', 3, 620, 100, 180)
        self.assertEqual(beam, column)
        self.assertEqual(beam['table'], 11)  # Column600, not Beam620.
        self.assertEqual(three['table'], 21)
        self.assertEqual(three['required_mm'], 28)

    def test_no_extrapolation_or_missing_cell_interpolation(self):
        for member, sides, temp, factor, period in [
            ('Column', 3, 550, 100, 60), ('Beam', 2, 550, 100, 60),
            ('Column', 4, 349, 100, 60), ('Column', 4, 701, 100, 60),
            ('Column', 4, 550, 300.01, 60), ('Column', 4, 550, 100, 181),
            ('Column', 4, 350, 100.01, 180),
        ]:
            with self.subTest(member=member, sides=sides, temp=temp, factor=factor, period=period):
                result = lookup_thickness('PROMATECT 100', member, sides, temp, factor, period)
                self.assertTrue(result['error'])
                self.assertEqual(result['layers_mm'], ())
                self.assertIsNone(result['required_mm'])

    def test_stock_rules_do_not_authorise_three_layers_or_sixty_mm(self):
        expected = {10: (15,), 16: (20,), 21: (15, 15), 31: (20, 15), 36: (20, 20), 41: ()}
        for required, layers in expected.items():
            self.assertEqual(select_stock('PROMATECT 100', required), layers)
        self.assertEqual(select_stock('PROMATECT 250', 10), (30,))
        self.assertEqual(select_stock('PROMATECT 250', 31), ())
        self.assertEqual(select_stock('PROMATECT 250', 20, 'Double'), ())
        self.assertEqual(select_stock('PROMATECT 100', 10, 'Double'), (15, 15))
        result = lookup_thickness('PROMATECT 100', 'Column', 4, 350, 100, 180)
        self.assertEqual(result['required_mm'], 45)
        self.assertEqual(result['layers_mm'], ())
        self.assertIn('Three layers', result['error'])
        result = lookup_thickness('PROMATECT 250', 'Column', 4, 350, 105, 120)
        self.assertEqual(result['required_mm'], 31)
        self.assertEqual(result['layers_mm'], ())

    def test_flat_box_geometry_is_family_independent_and_laps_are_separate(self):
        self.assertEqual(boxed_girth(200, 100, 4), .6)
        self.assertEqual(boxed_girth(200, 100, 4.0), .6)
        self.assertEqual(boxed_girth(200, 100, 3), .5)
        self.assertEqual(boxed_girth(200, 100, 3, rotated=True), .4)
        self.assertEqual(boxed_girth(100, 100, 4), .4)  # CHS buys flat boards too.
        for actual, expected in zip(board_layer_girths(200, 100, 4, (20, 15)), (.68, .82)):
            self.assertAlmostEqual(actual, expected, places=14)
        self.assertEqual(board_layer_girths(200, 100, 4.0, (20, 15)),
                         board_layer_girths(200, 100, 4, (20, 15)))

    def test_picker_keeps_existing_chs_identity_and_exact_archived_aliases(self):
        model = source_model('steel_board')
        choices, aliases = steel_id_choices(model), chs_section_aliases(model)
        self.assertTrue(choices)
        self.assertTrue(all('[P100]' not in name for name in choices))
        self.assertEqual(aliases['CHS168.3x5'], 'CHS168.3x5 [P100]')
        self.assertNotIn('CHS114.3x3.2', aliases)  # Existing exact native ID wins.
        self.assertIn('CHS114.3x3.2', choices)
        self.assertEqual(len(set(choices)), len(choices))

    def test_named_channel_double_layers_and_summary_grouping(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR'].update(C9='PROMATECT 100', D9='100PFC', G9=4,
                                     H9=120, I9='Column', J9=550, CJ9=2)
        before = deepcopy(inputs)
        engine = engine_for(inputs)
        # Source D100/B50/A10.6cm²: A/V0.3/.00106=283.0188679245.
        self.assertAlmostEqual(engine.value('CALCULATOR', 'AP9'), .3 / .00106)
        self.assertEqual(engine.value('CALCULATOR', 'F9'), 2)
        self.assertEqual(engine.value('CALCULATOR', 'Z9'), '20+15')
        self.assertEqual(engine.value('CALCULATOR', 'AJ9'), 20)
        self.assertEqual(engine.value('CALCULATOR', 'AK9'), 15)
        self.assertAlmostEqual(engine.value('CALCULATOR', 'AD9'), 1.2)
        self.assertAlmostEqual(engine.value('CALCULATOR', 'AL9'), 1.52)
        self.assertAlmostEqual(engine.value('CALCULATOR', 'AM9'), 2.08)
        self.assertAlmostEqual(engine.value('BOARD SUMMARY', 'G25'), 1.52)
        self.assertAlmostEqual(engine.value('BOARD SUMMARY', 'G23'), 2.08)
        self.assertEqual(engine.value('BOARD SUMMARY', 'G21'), 0)
        self.assertEqual(inputs, before)

    def test_chs_alias_saved_identity_box_quantity_and_circumference_factor(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR'].update(C9='PROMATECT 100', D9='CHS168.3x5', G9=4,
                                     H9=120, I9='Column', J9=550, CJ9=3)
        alias = engine_for(inputs)
        legacy_inputs = deepcopy(inputs)
        legacy_inputs['CALCULATOR']['D9'] = 'CHS168.3x5 [P100]'
        legacy = engine_for(legacy_inputs)
        self.assertEqual(alias.value('CALCULATOR', 'D9'), 'CHS168.3x5')
        self.assertEqual(legacy.value('CALCULATOR', 'D9'), 'CHS168.3x5 [P100]')
        for column in ('BL', 'BM', 'BN', 'AP', 'AC', 'AD', 'AJ', 'AK', 'AE', 'AF', 'AG'):
            self.assertEqual(alias.value('CALCULATOR', column + '9'), legacy.value('CALCULATOR', column + '9'))
        self.assertAlmostEqual(alias.value('CALCULATOR', 'AC9'), .6732)
        self.assertAlmostEqual(alias.value('CALCULATOR', 'AD9'), .6732 * 6)
        self.assertAlmostEqual(alias.value('CALCULATOR', 'AP9'), math.pi * .1683 / .00257)
        self.assertNotIn('handbook', alias.value('CALCULATOR', 'AT9').casefold())
        self.assertEqual(alias.value('CALCULATOR', 'AU9'),
                         'Retained section geometry; verify dimensions and section area.')
        partial = deepcopy(inputs)
        partial['CALCULATOR'].update(G9=3, I9='Beam')
        partial_engine = engine_for(partial)
        self.assertIsNone(partial_engine.promat_result(9)['required_mm'])
        self.assertEqual(partial_engine.value('CALCULATOR', 'AG9'), '')
        self.assertIn('four-sided exposure only', partial_engine.value('CALCULATOR', 'AI9'))

    def test_unresolved_stock_withholds_all_board_order_quantities(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR'].update(C9='PROMATECT 250', D9='200UC46', G9=4,
                                     H9=120, I9='Column', J9=350)
        engine = engine_for(inputs)
        self.assertGreater(engine.promat_result(9)['required_mm'], 30)
        self.assertIn('No quantity:', engine.value('CALCULATOR', 'AI9'))
        for column in ('AE', 'AF', 'AG', 'AH'):
            self.assertEqual(engine.value('CALCULATOR', column + '9'), '')

    def test_manual_factor_retains_report_requirement_without_inventing_geometry(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR'].update(C9='PROMATECT 100', D9=None, E9=10,
                                     G9=4, H9=120, I9='Column', J9=550)
        engine = engine_for(inputs)
        result = engine.promat_result(9)
        self.assertEqual(result['required_mm'], 15)
        self.assertEqual(result['layers_mm'], ())
        self.assertIn('verified depth', result['error'])
        self.assertEqual(engine.value('CALCULATOR', 'AG9'), '')

    def test_net_steel_profile_reference_uses_quantity_but_never_box_girth(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR']['CJ9'] = 3
        engine = engine_for(inputs)
        result = board_net_steel_areas(engine)
        used = next(row for row in result['rows'] if row['product'] == 'PROMATECT-XS' and row['thickness_mm'] == 15)
        self.assertAlmostEqual(used['net_steel_sqm'], 1.1838283271233896 * 6)
        self.assertNotAlmostEqual(used['net_steel_sqm'], .812 * 6)

    def test_explicit_required_field_hold_precedes_default_temperature_lookup(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR'].update(C9='PROMATECT 100', J9=None, CJ9=1)
        engine = engine_for(inputs)
        engine.required_missing_by_row = {9: ['Critical temperature']}
        self.assertIsNone(engine.promat_result(9)['required_mm'])
        self.assertEqual(engine.value('CALCULATOR', 'AJ9'), 0)
        self.assertEqual(engine.value('CALCULATOR', 'AG9'), '')
        self.assertIn('Review required: complete Critical temperature', engine.value('CALCULATOR', 'AI9'))

    def test_non_promat_application_rows_retain_native_excel_numeric_oracle(self):
        checked = 0
        for scenario in read_fixture('steel_board', 'variations')['scenarios']:
            engine = engine_for(scenario_inputs(scenario))
            expected = scenario['expected'].get('CALCULATOR', {})
            for row in range(9, 209):
                if engine.value('CALCULATOR', f'C{row}') not in ('TRAFALGAR COREX', 'PROMATECT-XS'):
                    continue
                for column in ('Y', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP'):
                    address = f'{column}{row}'
                    if address in expected:
                        actual = engine.value('CALCULATOR', address)
                        self.assertTrue(excel_equal(actual, expected[address]),
                                        (scenario['id'], address, actual, expected[address]))
                        checked += 1
        self.assertGreater(checked, 5000)

    def test_manual_stock_allowances_hold_obsolete_inputs_without_rewriting_them(self):
        inputs = example_inputs()
        rows = [('PROMATECT 250', 15), ('PROMATECT 100', 25),
                ('PROMATECT 100', 15), ('PROMATECT 100', 20), ('PROMATECT 250', 30),
                ('PROMATECT 100', '15'), ('PROMATECT 100', '25'), ('PROMATECT 100', '15.0')]
        for row, (product, thickness) in enumerate(rows, 6):
            inputs['EXTRA BOARDS'].update({f'B{row}': product, f'C{row}': thickness,
                                           f'G{row}': 3})
        before = deepcopy(inputs)
        engine = engine_for(inputs)
        for row in (6, 7, 12, 13):
            self.assertIn('REVIEW STOCK', engine.value('EXTRA BOARDS', f'M{row}'))
            self.assertEqual(engine.value('EXTRA BOARDS', f'J{row}'), '')
            self.assertEqual(engine.value('EXTRA BOARDS', f'K{row}'), '')
        for row in (8, 9, 10, 11):
            self.assertEqual(engine.value('EXTRA BOARDS', f'M{row}'), 'ENTERED ALLOWANCE')
            self.assertGreater(engine.value('EXTRA BOARDS', f'J{row}'), 0)
            self.assertGreater(engine.value('EXTRA BOARDS', f'K{row}'), 0)
        self.assertEqual(engine.value('EXTRA BOARDS', 'C6'), 15)
        self.assertEqual(engine.value('EXTRA BOARDS', 'C7'), 25)
        self.assertEqual(engine.value('EXTRA BOARDS', 'C11'), '15')
        self.assertEqual(engine.value('EXTRA BOARDS', 'C12'), '25')
        self.assertEqual(inputs, before)
        self.assertEqual(stock_choices('PROMATECT 100'), (15, 20))
        self.assertEqual(stock_choices('PROMATECT 250'), (30,))

    def test_blank_legacy_default_temperature_holds_without_formatting_error(self):
        for member, sides, setting in [('Column', 4, 'B13'), ('Beam', 3, 'B14')]:
            with self.subTest(member=member):
                inputs = example_inputs(9, length=2)
                inputs['CALCULATOR'].update(C9='PROMATECT 100', J9=None, I9=member, G9=sides)
                inputs['SETTINGS'] = {setting: None}
                engine = engine_for(inputs)
                self.assertIsNone(engine.promat_result(9)['required_mm'])
                self.assertEqual(engine.value('CALCULATOR', 'AG9'), '')
                self.assertIn('Critical temperature is missing or invalid', engine.value('CALCULATOR', 'AV9'))

    def test_case_insensitive_saved_products_cannot_bypass_assessment_or_stock_rules(self):
        self.assertIsNone(canonical_product(' PROMATECT 100'))
        self.assertIsNone(canonical_product('PROMATECT100'))
        self.assertEqual(canonical_product('promatect 100'), 'PROMATECT 100')
        self.assertEqual(stock_choices('PrOmAtEcT 250'), (30,))
        self.assertEqual(select_stock('promatect 100', 31), (20, 15))
        for product in ('promatect 100', 'PrOmAtEcT 250'):
            with self.subTest(product=product):
                inputs = example_inputs(9, length=2)
                inputs['CALCULATOR'].update(C9=product, D9='100PFC', G9=4, H9=120, I9='Column', J9=550)
                inputs['EXTRA BOARDS'].update(B6=product, C6=25, G6=3)
                before = deepcopy(inputs)
                engine = engine_for(inputs)
                self.assertIn('FC15555-01-03', engine.value('CALCULATOR', 'AT9'))
                self.assertEqual(engine.value('CALCULATOR', 'C9'), product)
                self.assertEqual(engine.value('EXTRA BOARDS', 'B6'), product)
                self.assertIn('REVIEW STOCK', engine.value('EXTRA BOARDS', 'M6'))
                self.assertEqual(engine.value('EXTRA BOARDS', 'J6'), '')
                self.assertEqual(engine.value('EXTRA BOARDS', 'K6'), '')
                if canonical_product(product) == 'PROMATECT 100':
                    self.assertEqual(engine.value('CALCULATOR', 'Z9'), '20+15')
                else:
                    self.assertEqual(engine.value('CALCULATOR', 'AG9'), '')  #33mm cannot use60mm.
                self.assertEqual(inputs, before)

    def test_finite_custom_geometry_with_overflowing_factor_stays_unresolved(self):
        inputs = example_inputs(9, length=2)
        inputs['CALCULATOR'].update(C9='PROMATECT 100', D9=None, K9='I/H',
                                     R9=1e100, S9=1e100, T9=1e-300,
                                     G9=4, H9=120, I9='Column', J9=550)
        engine = engine_for(inputs)
        self.assertIsNone(engine.promat_result(9)['required_mm'])
        self.assertIsNone(engine.promat_result(9)['factor'])
        self.assertEqual(engine.value('CALCULATOR', 'AP9'), 0)
        self.assertEqual(engine.value('CALCULATOR', 'AG9'), '')
        self.assertEqual(inputs['CALCULATOR']['T9'], 1e-300)

    def test_summary_stock_labels_omit_handbook_citations_and_preserve_history(self):
        inputs = example_inputs()
        inputs['EXTRA BOARDS'].update(B6='PROMATECT 100', C6=15, G6=3,
                                       B7='PROMATECT 250', C7=15, G7=999)
        engine = engine_for(inputs)
        cells = engine.sheets['BOARD SUMMARY']['cells']
        retained = deepcopy({f'K{row}': cells.get(f'K{row}') for row in range(16, 27)})
        for row in (19, 23, 25):
            self.assertEqual(engine.value('BOARD SUMMARY', f'K{row}'),
                             'Confirmed stock; check sheet size.')
        for row in (16, 17, 18):
            self.assertEqual(engine.value('BOARD SUMMARY', f'K{row}'),
                             'Unavailable; use 30 mm stock.')
        for row in (20, 21, 22, 24, 26):
            self.assertEqual(engine.value('BOARD SUMMARY', f'K{row}'),
                             'Unavailable; use 15/20 mm stock.')
        self.assertEqual(engine.value('BOARD SUMMARY', 'G23'), 3)
        self.assertEqual(engine.value('BOARD SUMMARY', 'G16'), 0)
        self.assertEqual({f'K{row}': cells.get(f'K{row}') for row in range(16, 27)}, retained)


if __name__ == '__main__':
    unittest.main()
