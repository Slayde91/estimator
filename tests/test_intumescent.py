"""SC902 quantity arithmetic and shared calculator boundaries.

Table selection has separate tests against the reviewed authority. A fixed
1 mm result here provides hand-checkable quantity examples independent of DFT.
"""

from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

from estimator.catalog import ValidationError
from estimator.intumescent import IntumescentEngine, PRODUCT, model
from estimator.workbook_calculators import calculator_definition, calculate_worksheet, normalize_calculator_inputs
from estimator.schedule_workbook import export_schedule_template, import_schedule_workbook


ASSESSMENT = SimpleNamespace(digest='test', report_sha256='report', error='')
FIXED_RESULT = {'dft': 1000, 'factor': 100, 'status': 'PUBLISHED',
                'source': 'FC18580-01-01 p12 Table 6', 'note': '1 mm = 1000 µm DFT.'}


def inputs(*, area=10, row=10, **settings):
    return {'SCHEDULE': {f'B{row}': PRODUCT, f'C{row}': 'I/H beam - 3 sides',
                         f'D{row}': 550, f'E{row}': 'A/V', f'G{row}': 100,
                         f'H{row}': 60, f'L{row}': area},
            'SETTINGS': settings}


class IntumescentTests(unittest.TestCase):
    def setUp(self):
        self.lookup = patch('estimator.sc902_assessment.lookup', return_value=FIXED_RESULT)
        self.lookup.start()
        self.addCleanup(self.lookup.stop)

    def engine(self, values=None):
        return IntumescentEngine(model(), values or inputs(), assessment=ASSESSMENT)

    def test_published_consumption_drives_kg_litres_and_kits(self):
        engine = self.engine()
        # 10 m² × 1 mm × 1.75 kg/m²/mm = 17.5 kg.
        self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
        self.assertAlmostEqual(engine.value('SCHEDULE', 'P10'), 1000 / .85)
        self.assertAlmostEqual(engine.value('SCHEDULE', 'S10'), 17.5 / 1.46)
        self.assertEqual(engine.value('SCHEDULE', 'T10'), .7)
        self.assertEqual(engine.value('SUMMARY', 'G7'), 1)
        self.assertEqual(engine.value('SUMMARY', 'D10'), 22.3)
        self.assertEqual(engine.value('SUMMARY', 'D11'), 2.7)
        self.assertAlmostEqual(engine.value('SETTINGS', 'D22'), 25 / 1.46)
        self.assertAlmostEqual(engine.value('SETTINGS', 'D23'), 25 / 1.75)
        self.assertAlmostEqual(engine.value('SETTINGS', 'D18'), 22.3 / 1.55)
        self.assertAlmostEqual(engine.value('SETTINGS', 'D19'), 2.7 / .99)

    def test_product_totals_pool_before_waste_and_rounding(self):
        values = inputs(area=1, D16=.1)
        values['SCHEDULE'].update(inputs(area=1, row=11)['SCHEDULE'])
        values['SCHEDULE'].update(inputs(area=1, row=1009)['SCHEDULE'])
        engine = self.engine(values)
        self.assertEqual(sum(engine.value('SCHEDULE', f'U{row}') for row in (10, 11, 1009)), 3)
        self.assertAlmostEqual(engine.value('SUMMARY', 'E7'), .21)
        self.assertEqual(engine.value('SUMMARY', 'G7'), 1)
        self.assertAlmostEqual(engine.totals()['kg'], 5.25)

    def test_editable_settings_change_quantities_without_changing_dft(self):
        engine = self.engine(inputs(D9=2, D10=15, D11=5, D15=2.4, D14=.8, D16=.25))
        self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
        self.assertEqual(engine.value('SCHEDULE', 'P10'), 1250)
        self.assertEqual(engine.value('SCHEDULE', 'S10'), 12)
        self.assertEqual(engine.value('SCHEDULE', 'T10'), 1.2)
        self.assertEqual(engine.value('SUMMARY', 'G7'), 2)
        self.assertEqual(engine.value('SUMMARY', 'D10'), 30)
        self.assertEqual(engine.value('SUMMARY', 'D11'), 10)

    def test_incomplete_or_blocked_item_withholds_complete_order(self):
        values = inputs()
        values['SCHEDULE']['A11'] = 'incomplete member'
        engine = self.engine(values)
        self.assertEqual(engine.value('SUMMARY', 'G7'), '')
        self.assertEqual(engine.value('SUMMARY', 'D10'), '')
        self.assertEqual(engine.value('SUMMARY', 'D15'), 1)
        self.assertAlmostEqual(engine.value('SUMMARY', 'C7'), 17.5)
        with patch('estimator.sc902_assessment.lookup', return_value={**FIXED_RESULT, 'dft': None, 'status': 'UNAVAILABLE'}):
            blocked = self.engine()
            for column in ('O', 'P', 'S', 'T', 'U'):
                self.assertEqual(blocked.value('SCHEDULE', column + '10'), '')
            self.assertEqual(blocked.value('SUMMARY', 'G7'), '')

    def test_invalid_quantity_settings_withhold_without_zero_substitution(self):
        for address, value in [('D9', 0), ('D10', None), ('D11', -1), ('D14', 1.1), ('D15', 0), ('D16', -.1)]:
            with self.subTest(address=address):
                engine = self.engine(inputs(**{address: value}))
                self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
                self.assertEqual(engine.value('SCHEDULE', 'S10'), '')
                self.assertEqual(engine.value('SUMMARY', 'G7'), '')

    def test_geometry_area_and_esa_conversion_are_separate_from_dft(self):
        values = inputs(area=None, D17=8000)
        values['SCHEDULE'].update(E10='ESA/M', G10=12.5, I10=2, J10=5, K10=.8)
        engine = self.engine(values)
        self.assertEqual(engine.value('SCHEDULE', 'M10'), 100)
        self.assertEqual(engine.value('SCHEDULE', 'R10'), 8)
        values['SCHEDULE']['L10'] = 3
        self.assertEqual(self.engine(values).value('SCHEDULE', 'R10'), 3)

    def test_invalid_present_overrides_do_not_silently_fall_back(self):
        for field, value in [('K10', -1), ('K10', 0), ('L10', -1), ('L10', 0)]:
            values = inputs()
            values['SCHEDULE'].update(I10=2, J10=5, K10=.8)
            values['SCHEDULE'][field] = value
            with self.subTest(field=field, value=value):
                engine = self.engine(values)
                self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
                self.assertEqual(engine.value('SCHEDULE', 'S10'), '')
                self.assertEqual(engine.value('SUMMARY', 'G7'), '')

    def test_named_geometry_holds_and_family_mismatch_withhold(self):
        engine = self.engine()
        self.assertIsNone(engine._geometry('100X100X4SHS', 'R3')[0])
        self.assertIsNone(engine._geometry('310UB40.4', 'CHS')[0])
        self.assertIsNone(engine._geometry('unknown section', 'R4')[0])
        from estimator.excel_engine import WorkbookEngine
        original = WorkbookEngine.value
        for field, value in [('BA', 1), ('AM', 'EXCLUDED - invalid section')]:
            def held(instance, sheet, address):
                return value if sheet == 'SECTIONS' and address.startswith(field) else original(instance, sheet, address)
            with self.subTest(field=field), patch.object(WorkbookEngine, 'value', held):
                self.assertIsNone(engine._geometry('310UB40.4', 'R3')[0])

    def test_extreme_finite_inputs_withhold_instead_of_returning_infinity(self):
        engine = self.engine(inputs(D9=5e-324, D14=5e-324))
        self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
        self.assertEqual(engine.value('SCHEDULE', 'P10'), '')
        self.assertEqual(engine.value('SCHEDULE', 'S10'), '')
        self.assertEqual(engine.value('SUMMARY', 'G7'), '')

    def test_unrepresentable_positive_quantities_do_not_become_zero_orders(self):
        for values in (inputs(area=5e-324, D15=5e-324), inputs(area=5e-324, D9=1e100)):
            with self.subTest(values=values):
                engine = self.engine(values)
                self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
                self.assertEqual(engine.value('SCHEDULE', 'S10'), '')
                self.assertEqual(engine.value('SUMMARY', 'G7'), '')

    def test_model_has_four_pages_and_read_only_outputs(self):
        definition = calculator_definition('steel_intumescent')
        self.assertEqual(definition['pages'], ['START', 'SCHEDULE', 'SUMMARY', 'SETTINGS'])
        self.assertEqual(definition['title'], 'Steel (intumescent)')
        values = inputs()
        values['SCHEDULE']['C10'] = 'I/H beam/column - 4 sides'
        with patch('estimator.sc902_assessment.lookup', return_value=FIXED_RESULT) as selected:
            self.assertEqual(self.engine(values).value('SCHEDULE', 'O10'), 1000)
            self.assertEqual(selected.call_args.kwargs['case'], 'R4')
        with self.assertRaises(ValidationError):
            normalize_calculator_inputs('steel_intumescent', {'SCHEDULE': {'O10': 1}})
        for invalid in (float('inf'), True, '=1+1'):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                normalize_calculator_inputs('steel_intumescent', {'SETTINGS': {'D9': invalid}})

    def test_blank_schedule_is_blank_and_mutation_does_not_change_model(self):
        original = deepcopy(model())
        engine = self.engine({'SCHEDULE': {}})
        self.assertEqual(engine.value('SCHEDULE', 'O10'), '')
        self.assertEqual(engine.value('SUMMARY', 'G7'), 0)
        self.assertEqual(model(), original)

    def test_template_round_trip_retains_settings_and_location(self):
        payload = export_schedule_template('steel_intumescent')
        workbook = load_workbook(BytesIO(payload))
        sheet = workbook['SCHEDULE']
        headings = [cell.value for cell in sheet[1]]
        sheet.cell(2, headings.index('Location') + 1, 'Level 1')
        sheet.cell(2, headings.index('Product') + 1, PRODUCT)
        stream = BytesIO()
        workbook.save(stream)
        result = import_schedule_workbook('steel_intumescent', stream.getvalue(), 'schedule.xlsx', inputs(D16=.15))
        self.assertEqual(result['inputs']['SCHEDULE']['AA10'], 'Level 1')
        self.assertEqual(result['inputs']['SETTINGS']['D16'], .15)


if __name__ == '__main__':
    unittest.main()
