"""Independent manual takeoffs for the approved application-FRL policy."""

from copy import deepcopy
import unittest

from estimator.calculator_report import project_calculator_report
from estimator.excel_engine import WorkbookEngine
from estimator.schedule_rows import empty_schedule_inputs
from estimator.workbook_calculators import calculator_session, source_model


def schedule_input(rows):
    inputs = empty_schedule_inputs('ductwork')
    for row, supplied in rows.items():
        values = {'B': '250x250', 'C': 'FyreWrap', 'D': 10, 'E': '120/120/120',
                  'F': 0, 'G': 0, 'H': 'Internal', 'I': 'Both', **supplied}
        inputs['CALCULATOR'].update({f'{column}{row}': value for column, value in values.items()})
    return inputs


class FyreWrapApplicationRulesTests(unittest.TestCase):
    def test_hand_takeoffs_for_exhaust_wall_and_floor_layers(self):
        # 610 mm rolls, 100 mm laps, 38 mm layer thickness. For a 10 m run,
        # 20 bands require 11.9 m of material length. The first small-duct
        # cut girth is 1.404 m. Published wall/floor lengths are per zone.
        # These literal quantities are derived in FYREWRAP_RULE_REVIEW.md,
        # not captured from the Excel implementation.
        cases = [
            ({}, (1, 0, 0, 0, 16.7076, 0, 0, 16.7076)),
            ({'F': 1}, (1, 1.8, 0, 0, 16.7076, 7.1736, 0, 23.8812)),
            ({'G': 1}, (1, 0, 2, 0, 16.7076, 3.9284, 0, 20.6360)),
            ({'F': 1, 'G': 1}, (1, 1.8, 2, 0, 16.7076, 11.102, 0, 27.8096)),
            ({'B': '1000x500', 'F': 1}, (1, 2.15, 0, 0, 40.5076, 18.9108, 0, 59.4184)),
            ({'B': '1000x500', 'G': 1}, (1, 0, 2.55, 1.25, 40.5076, 10.9386, 5.8174, 57.2636)),
            ({'B': '1000x500', 'F': 1, 'G': 1}, (1, 2.15, 2.55, 1.25, 40.5076, 29.8494, 5.8174, 76.1744)),
        ]
        rows, expected_rows = {}, {}
        for exposure in ['Internal', 'External', 'Both']:
            for supplied, expected in cases:
                row = 11 + len(rows)
                rows[row] = {**supplied, 'H': exposure}
                expected_rows[row] = expected
        normalized, engine, _ = calculator_session('ductwork', schedule_input(rows))
        for row, expected in expected_rows.items():
            for column, quantity in zip(['R', 'S', 'T', 'U', 'V', 'W', 'X', 'N'], expected):
                with self.subTest(row=row, column=column):
                    self.assertAlmostEqual(engine.value('CALCULATOR', f'{column}{row}'), quantity, places=8)
            if rows[row]['H'] == 'Both':
                self.assertIn('internal 120/120/120; external 120/120/-', engine.value('CALCULATOR', f'AP{row}'))
            if rows[row]['H'] == 'External':
                self.assertIn('external 120/120/-; internal not selected', engine.value('CALCULATOR', f'AP{row}'))

    def test_pressurisation_keeps_actual_directional_rating_and_no_extra_full_layer(self):
        inputs = schedule_input({11: {'H': 'Stair pressurisation'}, 12: {'H': 'Other pressurisation'},
                                 13: {'H': 'External'}, 14: {'H': 'External', 'E': '60/60/60'}})
        _, engine, _ = calculator_session('ductwork', inputs)
        for row, layers, material in [(11, 2, 37.0328), (12, 3, 60.9756), (13, 1, 16.7076), (14, 1, 16.7076)]:
            self.assertEqual(engine.value('CALCULATOR', f'R{row}'), layers)
            self.assertAlmostEqual(engine.value('CALCULATOR', f'N{row}'), material, places=8)
        self.assertIn('external 120/120/60; internal not required', engine.value('CALCULATOR', 'AP11'))
        self.assertIn('external 120/120/120; internal not required', engine.value('CALCULATOR', 'AP12'))
        self.assertIn('No penetration wrap included.', engine.value('CALCULATOR', 'AP11'))
        self.assertNotIn('Local wall wrap is on both faces', engine.value('CALCULATOR', 'AP11'))

    def test_unresolved_or_unsupported_details_cannot_produce_complete_wrap_totals(self):
        rows = {11: {'H': 'Stair pressurisation', 'F': 1}, 12: {'H': 'Other pressurisation', 'G': 1},
                13: {'H': 'External', 'F': 1, 'B': '3600x3600'}, 14: {'B': '3600x3600', 'F': 1},
                15: {'B': '500x1000', 'F': 1}, 16: {'E': '180/180/180'},
                17: {'E': '75/75/75'}, 18: {'C': 'Custom product'},
                19: {'H': 'Custom application'}, 20: {'I': 'Custom orientation'},
                21: {'H': 'External', 'E': '180/180/180'},
                22: {'H': 'External', 'G': 1, 'I': 'Horizontal'}}
        _, engine, _ = calculator_session('ductwork', schedule_input(rows))
        for row in rows:
            self.assertEqual(engine.value('CALCULATOR', f'N{row}'), '', row)
            self.assertEqual(engine.value('CALCULATOR', f'O{row}'), '', row)
        self.assertIn('wall table discrepancy', engine.value('CALCULATOR', 'J14'))
        self.assertIn('differs between manual and assessment', engine.value('CALCULATOR', 'AP14'))

    def test_legacy_external_ratings_use_one_base_layer_at_last_row_without_mutation(self):
        ratings = [60, '90/90/90', '120/120/-', '120/120/60', '120/120/120']
        raw = schedule_input({row: {'H': 'External', 'E': rating}
                              for row, rating in zip(range(1006, 1011), ratings)})
        before = deepcopy(raw)
        normalized, engine, _ = calculator_session('ductwork', raw)
        self.assertEqual(raw, before)
        for row in range(1006, 1011):
            self.assertEqual(normalized['CALCULATOR'][f'E{row}'], '120/120/120')
            self.assertEqual(normalized['CALCULATOR'][f'H{row}'], 'External')
            self.assertEqual(engine.value('CALCULATOR', f'R{row}'), 1)
            self.assertEqual(engine.value('CALCULATOR', f'W{row}'), 0)
            self.assertEqual(engine.value('CALCULATOR', f'X{row}'), 0)
            self.assertAlmostEqual(engine.value('CALCULATOR', f'N{row}'), 16.7076, places=8)
        reconciled, _, _ = calculator_session('ductwork', normalized)
        self.assertEqual(reconciled, normalized)

    def test_short_run_caps_local_layers_without_adding_a_continuous_layer(self):
        _, engine, _ = calculator_session('ductwork', schedule_input({11: {'D': 1, 'F': 2, 'G': 2}}))
        self.assertEqual(engine.value('CALCULATOR', 'R11'), 1)
        self.assertAlmostEqual(engine.value('CALCULATOR', 'V11'), 1.5444, places=8)
        self.assertAlmostEqual(engine.value('CALCULATOR', 'W11'), 1.8788, places=8)
        self.assertEqual(engine.value('CALCULATOR', 'X11'), 0)
        self.assertIn('capped to run', engine.value('CALCULATOR', 'AP11'))

    def test_last_capacity_row_and_reports_use_same_reconciled_calculation(self):
        raw = schedule_input({1010: {'H': 'Smoke exhaust', 'E': '120/120/-', 'G': 1, 'I': 'Mixed'}})
        unchanged = deepcopy(raw)
        normalized, engine, _ = calculator_session('ductwork', raw)
        self.assertEqual(raw, unchanged)
        self.assertEqual(normalized['CALCULATOR']['H1010'], 'Both')
        self.assertEqual(normalized['CALCULATOR']['I1010'], 'Both')
        self.assertEqual(normalized['CALCULATOR']['E1010'], '120/120/120')
        self.assertAlmostEqual(engine.value('CALCULATOR', 'N1010'), 20.636, places=8)
        report = project_calculator_report('ductwork', raw)
        row = next(row for row in report['rows'] if row['row'] == 1010)
        self.assertTrue(row['complete'])
        for column in ['H', 'I', 'E', 'R', 'N', 'O', 'AP']:
            self.assertEqual(row['values'][column], engine.value('CALCULATOR', f'{column}1010'))

    def test_spray_quantity_outputs_preserve_source_calculations(self):
        rows = {}
        for product in ['CAFCO 300', 'MONOKOTE']:
            for frl in [60, 90, 120]:
                for exposure in ['Internal', 'External', 'Both']:
                    rows[11 + len(rows)] = {'C': product, 'E': frl, 'H': exposure, 'F': 1, 'G': 1}
        raw = schedule_input(rows)
        original = WorkbookEngine(source_model('ductwork'), raw)
        _, current, _ = calculator_session('ductwork', raw)
        for row in rows:
            for column in ['K', 'L', 'M', 'P', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AN', 'AO']:
                self.assertEqual(current.value('CALCULATOR', f'{column}{row}'),
                                 original.value('CALCULATOR', f'{column}{row}'), (row, column))


if __name__ == '__main__':
    unittest.main()
