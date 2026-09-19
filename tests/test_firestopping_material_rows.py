"""Quote rows retain rates, full quantities and allocated source task hours."""

from copy import deepcopy
import unittest

from estimator.penetration_breakdown import line_breakdown, material_breakdown


def line(identifier, quantity, board, bulkhead, board_hours):
    inputs = {'O': quantity, 'X': 'Batt', 'AA': 'Wrap roll', 'AB': 'Mastic',
              'Y': 'Collar', 'AE': 'Other material', 'Z': 'Frame', 'W': 'Team',
              'AN': 2, 'AC': .5, 'AF': 3, 'AG': .1}
    outputs = {'CJ': board, 'CQ': bulkhead, 'BS': 1, 'CB': 3, 'CU': 2,
               'CW': 40, 'CX': 10, 'CY': 8, 'CZ': 5, 'DA': 2, 'DB': 20, 'DC': 7,
               'DE': board_hours, 'DF': .2, 'DG': .1, 'DH': .3, 'DI': 2, 'DJ': .4,
               'DK': (board_hours + .2 + .1 + .3 + 2 + .4 + .25) * quantity}
    row = {'id': identifier, 'inputs': inputs, 'outputs': outputs}
    row['breakdown'] = line_breakdown(row, {'L': 9, 'M': 7}, .25)
    return row


class FirestoppingMaterialRowsTests(unittest.TestCase):
    def test_shared_hours_split_per_line_before_matching_materials_are_totalled(self):
        result = {'rows': [line('one', 2, 1, 3, 2), line('two', 1, 2, 0, 3)]}
        before = deepcopy(result)
        rows = material_breakdown(result)
        board = {item['context']: item for item in rows if item['product'] == 'Batt'}
        self.assertEqual(board['Substrate']['quantity'], 4)
        self.assertEqual(board['Substrate']['price'], 10)
        self.assertEqual(board['Substrate']['total'], 40)
        self.assertEqual(board['Substrate']['task_hours'], 4)
        self.assertEqual(board['Substrate']['days'], .5)
        self.assertEqual(board['Bulkhead']['quantity'], 6)
        self.assertEqual(board['Bulkhead']['task_hours'], 3)
        self.assertEqual(board['Bulkhead']['days'], .375)
        wrap = {item['context']: item for item in rows if item['product'] == 'Wrap roll'}
        self.assertEqual(wrap['Pipes']['task_hours'], 1.5)
        self.assertEqual(wrap['Cabletrays']['task_hours'], 4.5)
        self.assertTrue(all(item['row_ids'] == ['one', 'two'] for item in rows))
        self.assertEqual(result, before)

    def test_mastic_collars_other_and_framing_use_their_source_quantity_and_own_hours(self):
        rows = material_breakdown({'rows': [line('one', 2.5, 1, 3, 2)]})
        indexed = {item['product']: item for item in rows}
        self.assertEqual(indexed['Mastic']['quantity'], 1.25)
        self.assertEqual(indexed['Mastic']['total'], 6.25)
        self.assertEqual(indexed['Mastic']['days'], .25 / 8)
        self.assertEqual(indexed['Collar']['quantity'], 5)
        self.assertEqual(indexed['Collar']['days'], .5 / 8)  # AN does not multiply DF.
        self.assertEqual(indexed['Other material']['quantity'], 3 * 1.1 * 2.5)
        self.assertEqual(indexed['Other material']['days'], 1 / 8)
        self.assertEqual(indexed['Frame']['quantity'], 5)
        self.assertEqual(indexed['Frame']['days'], .75 / 8)

    def test_rates_contexts_and_unselected_products_are_not_collapsed(self):
        first, second = line('one', 1, 1, 3, 2), line('two', 1, 1, 3, 2)
        second['breakdown']['rows'][1]['unit_prices'][0]['value'] = 10.00000000000002
        rows = material_breakdown({'rows': [first, second]})
        self.assertEqual(len([item for item in rows if item['product'] == 'Batt']), 4)
        first['inputs']['X'] = second['inputs']['X'] = None
        rows = material_breakdown({'rows': [first, second]})
        self.assertEqual(len([item for item in rows if item['product'] is None]), 4)

    def test_no_rounding_and_error_values_are_retained(self):
        row = line('one', 1.23456789012345, .123456789012345, .987654321098765, 2)
        rows = material_breakdown({'rows': [row]})
        substrate = next(item for item in rows if item['context'] == 'Substrate')
        self.assertEqual(substrate['quantity'], .123456789012345 * 1.23456789012345)
        self.assertEqual(substrate['total'], substrate['quantity'] * 10)
        for item in row['breakdown']['rows'][1]['material_quantities']:
            item['value'] = '#DIV/0!'
        rows = material_breakdown({'rows': [row]})
        self.assertTrue(all(item['total'] == '#DIV/0!' and item['days'] == '#DIV/0!'
                            for item in rows if item['product'] == 'Batt'))

    def test_zero_quantity_does_not_invent_days_and_material_adjustments_stay_explicit(self):
        row = line('one', 0, 1, 3, 2)
        rows = material_breakdown({'rows': [row]})
        self.assertTrue(all(item['quantity'] == item['total'] == item['days'] == 0 for item in rows))
        row = line('one', 3, 1, 3, 2)
        row['inputs']['AI'] = 7.1234567890123
        adjustment = material_breakdown({'rows': [row]})[-1]
        self.assertEqual(adjustment['quantity'], 1)
        self.assertEqual(adjustment['price'], 7.1234567890123 * 3)
        self.assertEqual(adjustment['total'], adjustment['price'])
        self.assertEqual(adjustment['days'], 0)


if __name__ == '__main__':
    unittest.main()
