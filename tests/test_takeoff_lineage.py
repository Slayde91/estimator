"""Replaced takeoffs must not silently duplicate preserved calculator rows."""

from copy import deepcopy
import unittest

from estimator.catalog import ValidationError
from estimator.schedule_rows import empty_schedule_inputs
from estimator.takeoff_transfer import row_values
from estimator.workbook_calculators import source_model
from tests import test_takeoff_workspace as fixtures


class TakeoffLineageTransferTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def split(self, item_id):
        case = self.case
        original = next(item for item in case.state['snapshot']['items'] if item['id'] == item_id)
        points = original['geometry']['points']
        middle = [(points[0][axis] + points[-1][axis]) / 2 for axis in (0, 1)]
        parts = []
        for path in ([points[0], middle], [middle, points[-1]]):
            part = {key: deepcopy(original[key]) for key in ('mode', 'quantity', 'fields', 'measurement', 'geometry', 'evidence')}
            part['geometry']['points'] = path
            parts.append(part)
        case.command('split_item', item_id=item_id, parts=parts)
        return [item['id'] for item in case.state['snapshot']['items'] if item_id in item.get('predecessor_ids', [])]

    def prepare(self):
        case = self.case
        original = case.create('duct', quantity=1); case.confirm(original)
        transferred = case.preview(original, 'ductwork'); case.apply(transferred)
        children = self.split(original)
        return original, transferred, children

    def preview(self, item_ids, inputs, rows):
        case = self.case
        case.command('review_items', item_ids=item_ids); case.command('confirm_items', item_ids=item_ids)
        return case.service.preview_transfer(case.sid, {'expected_revision': case.state['revision'],
            'calculator_id': 'ductwork', 'inputs': inputs, 'schedule_rows': rows, 'item_ids': item_ids})

    def test_transferred_split_blocks_atomically_until_all_old_row_inputs_are_cleared(self):
        original, transferred, children = self.prepare()
        inputs = deepcopy(transferred['inputs']); rows = transferred['schedule_rows']
        with self.assertRaisesRegex(ValidationError, 'unresolved predecessor rows') as caught:
            self.preview(children, inputs, rows)
        self.assertIn(original, str(caught.exception)); self.assertIn('row 11', str(caught.exception))
        self.assertEqual(inputs, transferred['inputs'])
        self.assertEqual(len(self.case.state['snapshot']['transfers']), 1)
        self.assertFalse(self.case.service._sessions[self.case.sid]['previews'])
        schedule = source_model('ductwork')['schedule']
        for address in row_values(inputs, schedule, 11):
            inputs[schedule['sheet']][address] = None
        # A numeric zero is still an explicitly populated row input.
        inputs[schedule['sheet']]['F11'] = 0
        with self.assertRaisesRegex(ValidationError, 'unresolved predecessor rows'):
            self.preview(children, inputs, rows)
        inputs[schedule['sheet']]['F11'] = None
        result = self.preview(children, inputs, rows)
        self.assertEqual([change['action'] for change in result['changes']], ['append', 'append'])
        self.assertEqual(sum(result['inputs']['CALCULATOR'].get('D'+str(row)) or 0 for row in (11, 12, 13)), 10)

    def test_transitive_replacements_remain_blocked_by_the_original_destination(self):
        original, transferred, children = self.prepare()
        grandchild_ids = self.split(children[0])
        self.assertTrue(all(original in item['predecessor_ids'] for item in self.case.state['snapshot']['items']
                            if item['id'] in grandchild_ids))
        with self.assertRaisesRegex(ValidationError, 'unresolved predecessor rows'):
            self.preview(grandchild_ids, transferred['inputs'], transferred['schedule_rows'])

    def test_explicit_historical_detach_preserves_all_existing_calculator_values(self):
        original, transferred, children = self.prepare()
        # Explicit detach is a deliberate resolution, never an automatic erase.
        self.case.command('detach_transfers', item_ids=[original], calculator_id='ductwork')
        self.assertEqual(self.case.state['snapshot']['transfers'], [])
        unchanged = deepcopy(transferred['inputs'])
        result = self.preview(children, transferred['inputs'], transferred['schedule_rows'])
        self.assertEqual(transferred['inputs'], unchanged)
        self.assertEqual(result['inputs']['CALCULATOR']['D11'], 10)
        self.assertEqual([change['row'] for change in result['changes']], [12, 13])

    def test_steel_partition_guard_includes_advanced_cells_and_is_calculator_scoped(self):
        case = self.case
        original = case.create(quantity=2)
        case.command('update_item', item_id=original, changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        case.confirm(original)
        transferred = case.preview(original, 'steel_board'); case.apply(transferred)
        case.command('split_steel_group', item_id=original, quantities=[1, 1])
        children = [item['id'] for item in case.state['snapshot']['items']]
        case.command('review_items', item_ids=children); case.command('confirm_items', item_ids=children)
        inputs = deepcopy(transferred['inputs']); schedule = source_model('steel_board')['schedule']
        for address in row_values(inputs, schedule, 9):
            inputs['CALCULATOR'][address] = None
        inputs['CALCULATOR']['V9'] = 0.4  # Advanced box-girth override must also be cleared.
        request = {'expected_revision': case.state['revision'], 'calculator_id': 'steel_board',
                   'inputs': inputs, 'schedule_rows': [9], 'item_ids': children}
        with self.assertRaisesRegex(ValidationError, 'unresolved predecessor rows'):
            case.service.preview_transfer(case.sid, request)
        inputs['CALCULATOR']['V9'] = None
        result = case.service.preview_transfer(case.sid, request)
        self.assertEqual(sum(result['inputs']['CALCULATOR'].get('F'+str(row)) or 0 for row in (9, 10, 11)), 20)
        # The explicit guard belongs to the destination holding the old row.
        case.command('bulk_update', item_ids=children, changes={'fields': {'product': 'CAFCO 300', 'critical_temperature': 550}})
        case.command('review_items', item_ids=children); case.command('confirm_items', item_ids=children)
        spray = case.service.preview_transfer(case.sid, {'expected_revision': case.state['revision'],
            'calculator_id': 'steel_vermiculite', 'inputs': empty_schedule_inputs('steel_vermiculite'),
            'schedule_rows': [10], 'item_ids': children})
        self.assertEqual([change['row'] for change in spray['changes']], [10, 11])


if __name__ == '__main__':
    unittest.main()
