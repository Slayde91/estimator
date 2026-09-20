"""Raw source reconciliation and the effective firestopping display policy."""

from copy import deepcopy
import gzip
import json
import math
from pathlib import Path
import re
import unittest

from estimator.penetration_breakdown import add_breakdowns, line_breakdown, material_breakdown
from estimator.penetration_calculator import GLOBAL_DEFAULTS, ROW_COLUMNS, source_model
from test_penetration_calculator import source_example


def source_breakdown(row, globals_, miscellaneous):
    return line_breakdown(row, globals_, miscellaneous, effective=False)


def synthetic_row(quantity=3, labour_allowance=.2, material_allowance=.1):
    inputs = {'O': quantity, 'AI': 7, 'AJ': 11}
    outputs = dict(zip(('DE', 'DF', 'DG', 'DH', 'DI', 'DJ'), (.5, .2, .1, .4, .3, .6)))
    outputs.update(dict(zip(('DM', 'DN', 'DO', 'DP', 'DQ', 'DR'), (10, 20, 30, 40, 50, 60))))
    outputs.update(dict(zip(('CW', 'CX', 'CY', 'CZ', 'DA', 'DB', 'DC'), (40, 10, 20, 30, 40, 50, 60))))
    outputs.update(dict(zip(('BS', 'CB', 'CJ', 'CQ', 'CU'), (.25, .5, .75, 1, 1.25))))
    outputs.update(DK=(2.1 + .25) * (1 + labour_allowance) * quantity,
                   F=((2.1 + .25) * (1 + labour_allowance) * quantity) * 40 + 11,
                   G=217 * (1 + material_allowance) * quantity)
    return {'id': 'line-1', 'inputs': inputs, 'outputs': outputs, 'errors': []}, {
        'L': labour_allowance, 'M': material_allowance}


class PenetrationBreakdownTests(unittest.TestCase):
    def assert_reconciles(self, table):
        for key in ('material_costs', 'labour_costs', 'task_hours'):
            total = table['totals'][key]
            values = [row[key] for row in table['rows']]
            if any(isinstance(value, str) and value.startswith('#') for value in values):
                self.assertIsInstance(total, str)
                self.assertTrue(total.startswith('#'), (key, total, values))
                continue
            actual = sum(value for value in values if isinstance(value, (int, float)))
            expected = total if isinstance(total, (int, float)) else 0
            self.assertTrue(math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10),
                            (key, actual, expected, values))

    def test_adjusted_components_include_each_allowance_once_and_preserve_raw_values(self):
        row, globals_ = synthetic_row()
        original = deepcopy(row)
        table = source_breakdown(row, globals_, .25)
        self.assertEqual([value['label'] for value in table['rows']],
                         ['Labour', 'Board', 'Collars', 'Mastic', 'Framing', 'Wrap', 'Other'])
        self.assertEqual(table['totals'], {'material_costs': row['outputs']['G'],
                                          'labour_costs': row['outputs']['F'], 'task_hours': row['outputs']['DK']})
        indexed = {entry['label']: entry for entry in table['rows']}
        self.assertAlmostEqual(indexed['Labour']['task_hours'], .9)
        self.assertAlmostEqual(indexed['Labour']['labour_costs'], 47)
        self.assertAlmostEqual(indexed['Board']['task_hours'], 1.8)
        self.assertAlmostEqual(indexed['Board']['labour_costs'], 72)
        self.assertAlmostEqual(indexed['Other']['material_costs'], 221.1)
        self.assertAlmostEqual(indexed['Other']['labour_costs'], 86.4)
        quantities = {value['column']: value['value'] for entry in table['rows']
                      for value in entry['material_quantities']}
        self.assertEqual(quantities, {'BS': .75, 'CB': 1.5, 'CJ': 2.25, 'CQ': 3, 'CU': 3.75, 'AC': None, 'AF': None})
        self.assertEqual(indexed['Labour']['unit_prices'][0]['value'], 40)
        self.assert_reconciles(table)
        self.assertEqual(row, original)

    def test_register_additional_hours_and_fixed_adjustment_are_separate_and_reconcile(self):
        row, globals_ = synthetic_row(quantity=3, labour_allowance=0, material_allowance=0)
        row['inputs'].update(AH=.6)
        globals_['register_allowance_hours'] = .4
        row['outputs'].update(DK=7.5, F=311)
        before = deepcopy(row)
        table = line_breakdown(row, globals_, 987654)
        self.assertEqual([task['label'] for task in table['rows']],
                         ['Additional Labour', 'Register allowance', 'Board', 'Collars',
                          'Mastic', 'Framing', 'Wrap', 'Other'])
        tasks = {task['label']: task for task in table['rows']}
        self.assertAlmostEqual(tasks['Additional Labour']['task_hours'], 1.8)
        self.assertAlmostEqual(tasks['Additional Labour']['labour_costs'], 83)
        self.assertAlmostEqual(tasks['Register allowance']['task_hours'], 1.2)
        self.assertAlmostEqual(tasks['Register allowance']['labour_costs'], 48)
        self.assertEqual(tasks['Register allowance']['unit_prices'][0]['value'], 40)
        self.assertEqual(tasks['Other']['task_hours'], '')
        self.assertEqual(tasks['Other']['labour_costs'], '')
        self.assertEqual(tasks['Other']['material_costs'], 201)
        self.assert_reconciles(table)
        self.assertEqual(row, before)

    def test_register_default_and_explicit_zero_do_not_reuse_source_miscellaneous_hours(self):
        row, globals_ = synthetic_row(quantity=2, labour_allowance=0, material_allowance=0)
        for value, expected in ((None, .5), (0, 0), (.123456789012345, .24691357802469)):
            with self.subTest(register=value):
                globals_['register_allowance_hours'] = .25 if value is None else value
                table = line_breakdown(row, globals_, 987654)
                register = next(task for task in table['rows'] if task['label'] == 'Register allowance')
                self.assertEqual(register['task_hours'], expected)
                self.assertEqual(register['labour_costs'], expected * 40)

    def test_all_native_scenarios_reconcile_without_replacing_any_source_value(self):
        with gzip.open(Path(__file__).parent / 'fixtures/penetration_excel_oracle.json.gz', 'rt', encoding='utf-8') as stream:
            fixture = json.load(stream)
        self.assertEqual(fixture['source_sha256'], source_model()['source']['sha256'])
        checked = 0
        for scenario in fixture['scenarios']:
            source = source_example()
            draft = {'globals': source['globals'], 'rows': [
                {'id': f'line-{index}', 'inputs': deepcopy(source['rows'][0]['inputs'])}
                for index in range(scenario['row_count'])]}
            for address, value in scenario['inputs']['CALC'].items():
                match = re.fullmatch(r'([A-Z]+)(\d+)', address)
                column, index = match[1], int(match[2])
                if index == 2 and column in GLOBAL_DEFAULTS:
                    draft['globals'][column] = value
                elif index >= 4 and column in ROW_COLUMNS:
                    draft['rows'][index - 4]['inputs'][column] = value
            rows = []
            for index, draft_row in enumerate(draft['rows'], 4):
                outputs = {re.sub(r'\d+$', '', address): value
                           for address, value in scenario['expected']['CALC'].items()
                           if int(re.search(r'\d+$', address)[0]) == index}
                rows.append({**deepcopy(draft_row), 'outputs': outputs, 'errors': []})
            result = {'draft': draft, 'rows': rows, 'unrelated': {'exact': 1.123456789012345}}
            original = deepcopy(result)
            add_breakdowns(result, source_model(), effective=False)
            for row in result['rows']:
                table = row.pop('breakdown')
                with self.subTest(scenario=scenario['id'], row=row['id']):
                    self.assertEqual(table['totals'], {'material_costs': row['outputs']['G'],
                                                      'labour_costs': row['outputs']['F'], 'task_hours': row['outputs']['DK']})
                    self.assert_reconciles(table)
                    mastic = next(item for item in table['rows'] if item['label'] == 'Mastic')['material_quantities'][0]
                    quantity = row['inputs'].get('AC')
                    item_count = row['inputs'].get('O') or 0
                    self.assertEqual(mastic['column'], 'AC')
                    self.assertEqual(mastic['value'], quantity if quantity in (None, '') else quantity * item_count)
                checked += 1
            self.assertEqual(result, original)
        self.assertEqual(len(fixture['scenarios']), 49)
        self.assertEqual(checked, 50)

    def test_mastic_quantity_uses_authoritative_input_times_item_qty_once(self):
        calc = next(sheet for sheet in source_model()['sheets'] if sheet['name'] == 'CALC')['cells']
        self.assertEqual(calc['AC3']['value'], 'Mastic Qty')
        self.assertEqual(calc['DO4']['formula'], '=IFERROR((AC4) * (CZ4), "")')
        for mastic, quantity, expected in ((.123456789012345, 3, .123456789012345 * 3),
                                          (0, 4, 0), (None, 3, None), ('', 3, ''),
                                          (2, 0, 0), (-.5, 3, -1.5), (2, None, 0),
                                          ('#VALUE!', 3, '#VALUE!'), (2, '#N/A', '#N/A')):
            with self.subTest(mastic=mastic, quantity=quantity):
                row, globals_ = synthetic_row()
                row['inputs'].update(AC=mastic, O=quantity)
                row['outputs']['AC'] = 987654  # It is an input, never a calculated output.
                globals_['M'] = 7
                original = deepcopy(row)
                value = next(item for item in source_breakdown(row, globals_, .25)['rows']
                             if item['label'] == 'Mastic')['material_quantities'][0]
                self.assertEqual(value, {'column': 'AC', 'label': 'Mastic Qty', 'value': expected,
                                         'format': 'number', 'units': ''})
                self.assertEqual(row, original)

    def test_source_gate_omits_all_hours_but_keeps_explicit_labour_adjustment(self):
        for other_hours in (-3, -1.5):
            with self.subTest(other_hours=other_hours):
                row, globals_ = synthetic_row()
                row['outputs'].update(DJ=other_hours, DK='', F=11)
                table = source_breakdown(row, globals_, .25)
                self.assertTrue(all(item['task_hours'] == '' for item in table['rows']))
                self.assertEqual([item['labour_costs'] for item in table['rows']], [11, '', '', '', '', '', ''])
                self.assertEqual(table['totals']['task_hours'], '')
                self.assertIn('zero or negative', table['note'])
                self.assert_reconciles(table)

    def test_zero_negative_and_blank_source_totals_are_not_replaced_or_rounded(self):
        for quantity, labour, material in ((0, .2, .1), (-2, .2, .1), (2.123456789, -2, -.5), (7, -1, -1)):
            with self.subTest(quantity=quantity, labour=labour, material=material):
                row, globals_ = synthetic_row(quantity, labour, material)
                if row['outputs']['G'] == 0:
                    row['outputs']['G'] = ''
                table = source_breakdown(row, globals_, .25)
                self.assertEqual(table['totals']['material_costs'], row['outputs']['G'])
                self.assertEqual(table['totals']['labour_costs'], row['outputs']['F'])
                self.assertEqual(table['totals']['task_hours'], row['outputs']['DK'])
                self.assert_reconciles(table)
        row, globals_ = synthetic_row(0)
        row['inputs']['AJ'] = 0
        row['outputs'].update(F='', G='', DK=0)
        table = source_breakdown(row, globals_, .25)
        self.assertEqual(table['totals'], {'material_costs': '', 'labour_costs': '', 'task_hours': 0})

    def test_errors_propagate_to_dependent_components_and_canonical_footer(self):
        row, globals_ = synthetic_row()
        row['outputs'].update(DE='#VALUE!', DK='#VALUE!', F='#VALUE!', DM='#DIV/0!', G='#DIV/0!')
        table = source_breakdown(row, globals_, .25)
        self.assertTrue(all(item['task_hours'] == '#VALUE!' for item in table['rows']))
        self.assertTrue(all(item['labour_costs'] == '#VALUE!' for item in table['rows']))
        self.assertEqual(table['rows'][1]['material_costs'], '#DIV/0!')
        self.assertEqual(table['rows'][2]['material_costs'], 66)
        self.assertEqual(table['totals'], {'material_costs': '#DIV/0!', 'labour_costs': '#VALUE!', 'task_hours': '#VALUE!'})
        row['outputs'].update(CW=float('inf'), F=float('inf'))
        table = source_breakdown(row, globals_, .25)
        self.assertEqual(table['rows'][0]['unit_prices'][0]['value'], '#NUM!')
        self.assertEqual(table['totals']['labour_costs'], '#NUM!')
        self.assertTrue(math.isinf(row['outputs']['F']))

    def test_miscellaneous_hours_follow_source_named_range_not_a_fixed_copy(self):
        row, globals_ = synthetic_row()
        model = {'defined_names': {'misc_labour': 'Settings!$D$7:$E$8'},
                 'sheets': [{'name': 'Settings', 'cells': {'E7': {'value': .3}, 'E8': {'value': .1}}}]}
        result = {'draft': {'globals': globals_}, 'rows': [row]}
        add_breakdowns(result, model, effective=False)
        self.assertAlmostEqual(result['rows'][0]['breakdown']['rows'][0]['task_hours'], 1.44)
        model['sheets'][0]['cells']['E7'] = {'formula': '=1/0'}
        add_breakdowns(result, model, effective=False)
        self.assertEqual(result['rows'][0]['breakdown']['rows'][0]['task_hours'], '#VALUE!')


if __name__ == '__main__':
    unittest.main()
