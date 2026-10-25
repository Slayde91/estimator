"""Published FC15909-01-03 tables and existing duct application boundaries."""

from copy import deepcopy
import itertools
import unittest

from estimator.ductwork_rules import application_formula_overrides as duct_overrides
from estimator.catalog import ValidationError
from estimator.excel_engine import WorkbookEngine
from estimator.monokote_duct_assessment import application_formula_overrides, REPORT, SETTINGS_DISPLAY_TEXT
from estimator.schedule_quantity import application_formula_overrides as quantity_overrides, quantity_engine_inputs
from estimator.workbook_calculators import normalize_calculator_inputs, source_model


OMITTED = object()


class MonokoteDuctAssessmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = source_model('ductwork')
        cls.base = quantity_overrides(cls.model, duct_overrides(cls.model))
        cls.current = application_formula_overrides(cls.model, cls.base)

    def inputs(self, frl='180/180/180', exposure='Internal', orientation='Horizontal',
               size='1000 x 250', product='MONOKOTE', count=1, length=1.123456789012345):
        values = {'B11': size, 'C11': product, 'D11': length, 'E11': frl,
                  'F11': 0, 'G11': 0, 'H11': exposure, 'I11': orientation}
        if count is not OMITTED:
            values['CM11'] = count
        return {'CALCULATOR': values}

    def engine(self, inputs, *, old=False):
        normalized = normalize_calculator_inputs('ductwork', inputs)
        return WorkbookEngine(self.model, quantity_engine_inputs(self.model, normalized),
                              self.base if old else self.current)

    def test_all_visible_routes_match_published_tables_and_old_differences(self):
        # Tables 2/3/4 pp.14-15 have identical DFTs, but distinct construction.
        frls = ['60/60/60', '90/90/90', '120/120/120', '180/180/180', '240/240/180']
        published_internal, published_external = [37, 47, 54, 73, 73], [44, 54, 61, 71, 71]
        differences = 0
        for index, exposure, orientation, size in itertools.product(
                range(5), ['Internal', 'External', 'Both'], ['Horizontal', 'Vertical', 'Both'],
                ['1000 x 250', '1500 x 1500', '2400 x 2400']):
            with self.subTest(frl=frls[index], exposure=exposure, orientation=orientation, size=size):
                inputs = self.inputs(frls[index], exposure, orientation, size)
                expected = (published_internal[index] if exposure == 'Internal' else
                            published_external[index] if exposure == 'External' else
                            max(published_internal[index], published_external[index]))
                actual = self.engine(inputs)
                self.assertEqual(actual.value('CALCULATOR', 'L11'), expected)
                self.assertGreater(actual.value('CALCULATOR', 'M11'), 0)
                differences += self.engine(inputs, old=True).value('CALCULATOR', 'L11') != expected
        self.assertEqual(differences, 36)

    def test_scope_limits_withhold_materials_instead_of_extrapolating(self):
        for size in ['1000 x 200', '250 x 1001', '2401 x 2400', '2400 x 2401']:
            with self.subTest(size=size):
                value = self.engine(self.inputs(size=size))
                self.assertFalse(value.value('CALCULATOR', 'BE11'))
                for column in ['L', 'AN', 'M', 'AE', 'AG', 'AI']:
                    self.assertIn(value.value('CALCULATOR', column + '11'), ('', None))
                self.assertIn('report', value.value('CALCULATOR', 'J11').lower())
        self.assertEqual(self.engine(self.inputs(size='1000 x 250')).value('CALCULATOR', 'L11'), 73)
        self.assertEqual(self.engine(self.inputs(size='250 x 1000')).value('CALCULATOR', 'L11'), 73)

    def test_saved_settings_cannot_extend_report_coverage_or_restore_old_thickness(self):
        def references_engine(inputs):
            # The HTTP boundary already rejects these read-only references.
            # Exercise the lower evaluator defensively without weakening it.
            with self.assertRaises(ValidationError):
                normalize_calculator_inputs('ductwork', inputs)
            values = deepcopy(inputs)
            references = values.pop('PRODUCT SETTINGS')
            normalized = normalize_calculator_inputs('ductwork', values)
            normalized['PRODUCT SETTINGS'] = references
            return WorkbookEngine(self.model, quantity_engine_inputs(self.model, normalized), self.current)

        inputs = self.inputs(size='2500 x 2500')
        inputs['PRODUCT SETTINGS'] = {'B50': 3000, 'B51': 300, 'B52': 300}
        value = references_engine(inputs)
        self.assertIn(value.value('CALCULATOR', 'L11'), ('', None))
        inputs = self.inputs()
        inputs['PRODUCT SETTINGS'] = {'C78': 64, 'C79': 64}
        self.assertEqual(references_engine(inputs).value('CALCULATOR', 'L11'), 73)
        # A stricter saved size ceiling is still respected.
        inputs['PRODUCT SETTINGS']['B50'] = 900
        self.assertIn(references_engine(inputs).value('CALCULATOR', 'L11'), ('', None))

    def test_closed_frls_and_existing_aliases_keep_their_meaning(self):
        for alias in ['120/120/60', '120/120/-', '120', 120]:
            value = self.engine(self.inputs(frl=alias, exposure='External'))
            self.assertEqual(value.value('CALCULATOR', 'L11'), 61)
        for frl in ['120/120/90', '240/240/240', '300/300/180']:
            self.assertIn(self.engine(self.inputs(frl=frl)).value('CALCULATOR', 'L11'), ('', None))
        self.assertIn(self.engine(self.inputs(exposure='Simultaneous')).value('CALCULATOR', 'L11'), ('', None))

    def test_quantity_repeats_once_and_yield_and_precision_are_retained(self):
        inputs = self.inputs(count=3)
        inputs['CALCULATOR']['F11'] = 1
        before = deepcopy(inputs)
        three = self.engine(inputs)
        one_inputs = deepcopy(inputs)
        one_inputs['CALCULATOR']['CM11'] = 1
        one = self.engine(one_inputs)
        for column in ['K', 'AN', 'M', 'AE', 'AJ']:
            self.assertAlmostEqual(three.value('CALCULATOR', column + '11'),
                                   3 * one.value('CALCULATOR', column + '11'), places=12)
        self.assertEqual(three.value('CALCULATOR', 'L11'), 73)
        self.assertEqual(three.value('CALCULATOR', 'D11'), 1.123456789012345)
        self.assertEqual(three.value('CALCULATOR', 'F11'), 1)
        self.assertEqual(three.value('CALCULATOR', 'AO11'), self.engine(inputs, old=True).value('CALCULATOR', 'AO11'))
        self.assertEqual(inputs, before)

    def test_legacy_missing_and_new_blank_quantity_remain_distinct(self):
        legacy = self.inputs(count=OMITTED)
        before = deepcopy(legacy)
        self.assertEqual(self.engine(legacy).value('CALCULATOR', 'M11'),
                         self.engine(self.inputs(count=1)).value('CALCULATOR', 'M11'))
        self.assertEqual(legacy, before)
        blank = self.engine(self.inputs(count=None))
        self.assertIn(blank.value('CALCULATOR', 'M11'), ('', None))
        self.assertIn('Quantity', blank.value('CALCULATOR', 'J11'))
        padding = {'CALCULATOR': {column + '11': None for column in 'BCDEFGHI'}}
        for column in ['J', 'L', 'M', 'AQ']:
            self.assertIn(self.engine(padding).value('CALCULATOR', column + '11'), ('', None))

    def test_other_products_and_unrelated_outputs_remain_native(self):
        for product, size in [('CAFCO 300', '1000 x 200'), ('FyreWrap', '300 x 200')]:
            inputs = self.inputs('120/120/120', product=product, size=size)
            old, current = self.engine(inputs, old=True), self.engine(inputs)
            for column in ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'AN', 'AO', 'AP', 'AQ', 'AM', 'BE', 'BF']:
                self.assertEqual(current.value('CALCULATOR', column + '11'), old.value('CALCULATOR', column + '11'),
                                 product + ':' + column)

    def test_report_basis_settings_and_source_objects_are_not_rewritten(self):
        model, overrides = deepcopy(self.model), deepcopy(self.base)
        before_model, before_overrides = deepcopy(model), deepcopy(overrides)
        applied = application_formula_overrides(model, overrides)
        self.assertEqual(model, before_model)
        self.assertEqual(overrides, before_overrides)
        cells = next(sheet['cells'] for sheet in model['sheets'] if sheet['name'] == 'PRODUCT SETTINGS')
        self.assertEqual(cells['C78']['value'], 64)
        value = self.engine(self.inputs())
        self.assertEqual(value.value('PRODUCT SETTINGS', 'C78'), 64)
        self.assertEqual(SETTINGS_DISPLAY_TEXT['C78'], 73)
        self.assertEqual(SETTINGS_DISPLAY_TEXT['C79'], 73)
        self.assertTrue(SETTINGS_DISPLAY_TEXT['B88'].startswith(REPORT))
        self.assertIn(REPORT, value.value('CALCULATOR', 'AQ11'))
        self.assertIn('not a general field acceptance tolerance', value.value('CALCULATOR', 'AP11'))
        self.assertIn('8:1', value.value('CALCULATOR', 'AM11'))
        # The final row receives a translated reference, not a reference to row11.
        self.assertIn('AU1010', applied['CALCULATOR']['BE1010'])
        self.assertNotIn('AU11', applied['CALCULATOR']['BE1010'])


if __name__ == '__main__':
    unittest.main()
