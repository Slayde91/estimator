"""Board product summaries checked against retained Excel evidence and inputs."""

from copy import deepcopy
import unittest

from estimator.excel_engine import WorkbookEngine
from estimator.workbook_calculators import (
    _board_product_totals, calculate_worksheet, source_model,
)
from estimator.workbook_catalog import editable_cells
from tests.test_workbook_parity import read_fixture, scenario_inputs


PRODUCTS = ('TRAFALGAR COREX', 'PROMATECT 250', 'PROMATECT 100', 'PROMATECT-XS')
FIELDS = ('box_reference_area', 'net_board_area', 'whole_sheets',
          'incomplete_rows', 'incomplete_extra_rows')


def cleared_inputs():
    return {sheet: {address: None for address in editable_cells('steel_board', sheet)}
            for sheet in ('CALCULATOR', 'EXTRA BOARDS')}


def example_inputs(*rows, length=10):
    """Copy source example inputs, never its calculated answers."""
    inputs = cleared_inputs()
    source = next(sheet['cells'] for sheet in source_model('steel_board')['sheets']
                  if sheet['name'] == 'CALCULATOR')
    for row in rows:
        for column in 'ABCDEFGHIJKLMNOPQRSTUVWX':
            inputs['CALCULATOR'][f'{column}{row}'] = source.get(f'{column}9', {}).get('value')
        inputs['CALCULATOR'][f'F{row}'] = length
    return inputs


def product_totals(inputs):
    engine = WorkbookEngine(source_model('steel_board'), inputs)
    return {row['product']: row for row in _board_product_totals(engine)}


def retained_expectations(model, scenario=None):
    """Group retained Excel outputs in Python; do not evaluate app formulas.

    Default answers use the immutable workbook caches. Varied answers come
    solely from native Excel captures; uncaptured rows must have no product.
    """
    sheets = {sheet['name']: sheet['cells'] for sheet in model['sheets']}
    inputs = scenario_inputs(scenario) if scenario else {}

    def value(sheet, address):
        cell = sheets[sheet].get(address, {})
        if address in inputs.get(sheet, {}):
            return inputs[sheet][address]
        if 'formula' not in cell:
            return cell.get('value')
        return (scenario['expected'][sheet][address] if scenario
                else cell.get('cached_value'))

    totals = {product: dict.fromkeys(FIELDS, 0) for product in PRODUCTS}
    for row in range(12, 30):
        product = value('BOARD SUMMARY', f'A{row}')
        totals[product]['net_board_area'] += value('BOARD SUMMARY', f'G{row}')
        totals[product]['whole_sheets'] += value('BOARD SUMMARY', f'I{row}')
    for row in range(9, 209):
        product = value('CALCULATOR', f'C{row}')
        if product not in totals:
            continue
        area = value('CALCULATOR', f'AD{row}')
        if type(area) in (int, float):
            totals[product]['box_reference_area'] += area
        if value('CALCULATOR', f'BD{row}') == 1 and value('CALCULATOR', f'AR{row}') != 'CLADDING ESTIMATE':
            totals[product]['incomplete_rows'] += 1
    for row in range(6, 46):
        product = value('EXTRA BOARDS', f'B{row}')
        if product in totals and value('EXTRA BOARDS', f'M{row}') not in (None, '', 'ENTERED ALLOWANCE'):
            totals[product]['incomplete_extra_rows'] += 1
    return totals


class BoardProductTotalsTests(unittest.TestCase):
    def assert_totals(self, actual, expected):
        self.assertEqual(list(actual), list(PRODUCTS))
        for product in PRODUCTS:
            self.assertEqual(set(actual[product]), {'product', *FIELDS})
            for field in FIELDS:
                with self.subTest(product=product, field=field):
                    self.assertAlmostEqual(actual[product][field], expected[product][field], places=9)

    def test_default_worksheet_totals_match_workbook_caches_and_known_orders(self):
        page = calculate_worksheet('steel_board', {}, 'CALCULATOR')
        actual = {row['product']: row for row in page['board_product_totals']}
        self.assert_totals(actual, retained_expectations(source_model('steel_board')))
        known = {
            'TRAFALGAR COREX': (13.456, 21.014, 11, 5),
            'PROMATECT 250': (1.1, 1.35, 1, 0),
            'PROMATECT 100': (6.392, 10.172, 5, 3),
            'PROMATECT-XS': (11.82, 25.94, 10, 1),
        }
        for product, values in known.items():
            for field, expected in zip(FIELDS, values):
                self.assertAlmostEqual(actual[product][field], expected)
        self.assertEqual(sum(row['whole_sheets'] for row in actual.values()), 27)
        self.assertNotEqual(actual['PROMATECT-XS']['box_reference_area'],
                            actual['PROMATECT-XS']['net_board_area'])

    def test_varied_native_captures_cover_all_stock_invalid_extras_and_zero_waste(self):
        scenarios = read_fixture('steel_board', 'variations')['scenarios']
        for name in ('advanced_choices_boundaries_and_all_stock',
                     'zero_waste_rounding_and_manual_geometry'):
            scenario = next(item for item in scenarios if item['id'] == name)
            with self.subTest(scenario=name):
                inputs = scenario_inputs(scenario)
                before = deepcopy(inputs)
                self.assert_totals(product_totals(inputs),
                                   retained_expectations(source_model('steel_board'), scenario))
                self.assertEqual(inputs, before)

    def test_length_and_waste_changes_keep_box_area_separate_from_board_layers(self):
        inputs = example_inputs(9, length=1)
        short = product_totals(inputs)['PROMATECT-XS']
        inputs['CALCULATOR']['F9'] = 2
        longer = product_totals(inputs)['PROMATECT-XS']
        self.assertAlmostEqual(short['box_reference_area'], 0.812)
        self.assertAlmostEqual(short['net_board_area'], 1.864)
        self.assertAlmostEqual(longer['box_reference_area'], 1.624)
        self.assertAlmostEqual(longer['net_board_area'], 3.728)
        self.assertEqual(longer['whole_sheets'], 2)
        inputs['SETTINGS'] = {'B10': 1}
        wasted = product_totals(inputs)['PROMATECT-XS']
        self.assertEqual(wasted['whole_sheets'], 3)
        for field in ('box_reference_area', 'net_board_area', 'incomplete_rows'):
            self.assertEqual(wasted[field], longer[field])

    def test_valid_extra_area_is_pooled_but_invalid_extra_is_counted_only(self):
        inputs = cleared_inputs()
        inputs['EXTRA BOARDS'].update({'B6': 'PROMATECT-XS', 'C6': 15, 'G6': 3.01,
                                       'B45': 'PROMATECT-XS', 'C45': 15, 'G45': 99, 'D45': 1})
        totals = product_totals(inputs)['PROMATECT-XS']
        self.assertEqual(totals['box_reference_area'], 0)
        self.assertAlmostEqual(totals['net_board_area'], 3.01)
        self.assertEqual(totals['whole_sheets'], 2)
        self.assertEqual(totals['incomplete_extra_rows'], 1)
        inputs['EXTRA BOARDS']['D45'] = None
        fixed = product_totals(inputs)['PROMATECT-XS']
        self.assertAlmostEqual(fixed['net_board_area'], 102.01)
        self.assertEqual(fixed['whole_sheets'], 35)
        self.assertEqual(fixed['incomplete_extra_rows'], 0)

    def test_pooled_sheets_do_not_sum_per_row_rounding_and_include_last_row(self):
        inputs = example_inputs(9, 208, length=0.1)
        engine = WorkbookEngine(source_model('steel_board'), inputs)
        actual = {row['product']: row for row in _board_product_totals(engine)}['PROMATECT-XS']
        self.assertAlmostEqual(actual['box_reference_area'], 0.1624)
        self.assertAlmostEqual(actual['net_board_area'], 0.3728)
        self.assertEqual(actual['whole_sheets'], 1)
        self.assertEqual(engine.value('CALCULATOR', 'AG9') + engine.value('CALCULATOR', 'AG208'), 2)

    def test_blank_zero_and_incomplete_rows_remain_distinct(self):
        inputs = cleared_inputs()
        self.assertTrue(all(row[field] == 0 for row in product_totals(inputs).values() for field in FIELDS))
        inputs['CALCULATOR'].update({'C208': 'PROMATECT-XS', 'F208': 0})
        inputs['EXTRA BOARDS'].update({'N44': 'Evidence only', 'B45': 'PROMATECT-XS', 'G45': 0})
        totals = product_totals(inputs)['PROMATECT-XS']
        self.assertEqual(tuple(totals[field] for field in FIELDS), (0, 0, 0, 1, 1))
        inputs['CALCULATOR'].update({'C208': None, 'F208': None})
        inputs['EXTRA BOARDS'].update({'B45': None, 'G45': None})
        self.assertTrue(all(row[field] == 0 for row in product_totals(inputs).values() for field in FIELDS))

    def test_case_insensitive_products_preserve_exact_input_text(self):
        inputs = example_inputs(9, length=1)
        inputs['EXTRA BOARDS'].update({'B6': 'PROMATECT-XS', 'C6': 15, 'G6': 0.5})
        expected = product_totals(inputs)
        inputs['CALCULATOR']['C9'] = 'promatect-xs'
        inputs['EXTRA BOARDS']['B6'] = 'Promatect-Xs'
        before = deepcopy(inputs)
        self.assertEqual(product_totals(inputs), expected)
        self.assertEqual(inputs, before)

    def test_source_division_errors_are_not_replaced_by_zero_orders(self):
        inputs = example_inputs(9)
        inputs['SETTINGS'] = {'B8': 0}
        totals = product_totals(inputs)
        self.assertTrue(all(row['whole_sheets'] == '#DIV/0!' for row in totals.values()))
        self.assertEqual(totals['PROMATECT-XS']['incomplete_rows'], 1)

    def test_grouping_does_not_write_inputs_source_cells_or_cached_values(self):
        model = source_model('steel_board')
        inputs = example_inputs(208, length=0.123456789)
        original_model, original_inputs = deepcopy(model), deepcopy(inputs)
        engine = WorkbookEngine(model, inputs)
        first = _board_product_totals(engine)
        self.assertEqual(_board_product_totals(engine), first)
        self.assertEqual(inputs, original_inputs)
        self.assertEqual(model, original_model)
        self.assertEqual(source_model('steel_board'), original_model)


if __name__ == '__main__':
    unittest.main()
