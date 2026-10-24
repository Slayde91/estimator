"""SC902 pack controls preserve published consumption and saved calculation identities."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from estimator.intumescent import IntumescentEngine, PRODUCT, PRODUCTS, model
from estimator.workbook_calculators import calculate_worksheet, normalize_calculator_inputs


class SC902PackProjectionTests(unittest.TestCase):
    def setUp(self):
        self.lookup = patch('estimator.sc902_assessment.lookup', return_value={
            'dft': 1000, 'factor': 100, 'status': 'PUBLISHED', 'source': 'report p12 Table 6', 'note': ''})
        self.lookup.start()
        self.addCleanup(self.lookup.stop)

    def values(self, **settings):
        return {'SETTINGS': settings, 'SCHEDULE': {'B10': PRODUCT, 'C10': 'I/H beam - 3 sides',
            'D10': 550, 'E10': 'A/V', 'G10': 100, 'H10': 60, 'L10': 10}}

    def engine(self, values):
        return IntumescentEngine(model(), values, assessment=SimpleNamespace(error='', digest='test'))

    def test_blank_volume_derives_from_saved_components_without_rewriting_inputs(self):
        for blank in ({}, {'D24': None}, {'D24': ''}):
            values = self.values(D9=2, D10=15, D11=5, D15=2.4, **blank)
            before = deepcopy(values)
            engine = self.engine(values)
            self.assertEqual(engine.value('SETTINGS', 'D24'), 10)
            self.assertEqual(engine.value('SETTINGS', 'D22'), 10)
            self.assertEqual(engine.value('SETTINGS', 'D23'), 20 / 2.4)
            self.assertEqual(engine.value('SCHEDULE', 'S10'), 12)
            self.assertEqual(engine.value('SCHEDULE', 'T10'), 1.2)
            self.assertEqual(engine.value('SUMMARY', 'D10'), 30)
            self.assertEqual(engine.value('SUMMARY', 'D11'), 10)
            self.assertEqual(values, before)

    def test_explicit_pack_volume_changes_pack_count_but_not_published_material_use(self):
        values = self.values(D24=10)
        engine = self.engine(values)
        self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
        self.assertEqual(engine.totals()['kg'], 17.5)
        self.assertEqual(engine.value('SCHEDULE', 'S10'), 17.5 / 1.46)
        self.assertEqual(engine.value('SCHEDULE', 'T10'), 17.5 / 1.46 / 10)
        self.assertEqual(engine.totals()['whole'], 2)
        self.assertEqual(engine.totals()['order_litres'], 20)
        self.assertEqual(engine.totals()['part_a'], '')
        self.assertIn('component orders held', engine.totals()['status'])

    def test_consistent_volume_and_component_basis_preserve_component_orders(self):
        for settings in ({'D24': 25 / 1.46}, {'D24': -5, 'D25': 'Component mass (kg)'}):
            engine = self.engine(self.values(**settings))
            self.assertEqual(engine.totals()['whole'], 1)
            self.assertEqual(engine.totals()['part_a'], 22.3)
            self.assertEqual(engine.totals()['part_b'], 2.7)
            self.assertEqual(engine.value('SETTINGS', 'D22'), 25 / 1.46)

    def test_invalid_pack_volume_or_basis_holds_quantities_only(self):
        for settings in ({'D24': 0}, {'D24': -1}, {'D25': None}, {'D25': 'unknown'}):
            engine = self.engine(self.values(**settings))
            self.assertEqual(engine.value('SCHEDULE', 'O10'), 1000)
            self.assertEqual(engine.value('SCHEDULE', 'S10'), '')
            self.assertEqual(engine.totals()['whole'], '')
            self.assertEqual(engine.value('SETTINGS', 'D23'), '')

    def test_new_fields_round_trip_without_migrating_hidden_legacy_settings(self):
        values = self.values(D24=17.1234567890123, D25='Pack volume (L)', D15=1.87654321098765,
                             D8=1.54321098765432, D6=PRODUCT)
        self.assertEqual(normalize_calculator_inputs('steel_intumescent', values), values)

    def test_ui_summary_projects_same_product_pools_without_replacing_source_cells(self):
        values = self.values(D16=.1)
        result = calculate_worksheet('steel_intumescent', values, 'SUMMARY')
        self.assertEqual(tuple(row['product'] for row in result['intumescent_product_totals']), PRODUCTS)
        pool = result['intumescent_product_totals'][0]
        cells = {cell['address']: cell['value'] for row in result['rows'] for cell in row['cells']}
        for key, address in {'area': 'B7', 'kg': 'C7', 'litres': 'D7', 'net': 'E7',
                             'whole': 'G7', 'part_a': 'D10', 'part_b': 'D11', 'pending': 'D15'}.items():
            self.assertEqual(pool[key], cells[address])


if __name__ == '__main__':
    unittest.main()
