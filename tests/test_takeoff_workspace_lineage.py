"""Explicit physical-group edits retain identities and historical schedule links."""

from copy import deepcopy
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from tests import test_takeoff_workspace as fixtures


class TakeoffWorkspaceLineageTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def items(self):
        return self.case.state['snapshot']['items']

    def command(self, op, **values):
        return self.case.command(op, **values)

    def part(self, original, points):
        result = {key: deepcopy(original[key]) for key in ('mode', 'quantity', 'fields', 'measurement', 'geometry', 'evidence')}
        result['geometry']['points'] = points
        return result

    def split_duct(self, original):
        self.command('split_item', item_id=original['id'], parts=[
            self.part(original, [[10, 30], [60, 30]]), self.part(original, [[60, 30], [110, 30]])])
        return deepcopy(self.items())

    def test_repeated_duct_split_merge_preserves_transitive_predecessors(self):
        root_id = self.case.create('duct', quantity=1)
        original = deepcopy(self.items()[0])
        children = self.split_duct(original)
        self.command('merge_items', item_ids=[item['id'] for item in children],
                     item=self.part(original, [[10, 30], [60, 30], [110, 30]]))
        merged = deepcopy(self.items()[0])
        ancestors = {root_id, *(item['id'] for item in children)}
        self.assertEqual(merged['predecessor_ids'], sorted(ancestors))
        self.split_duct(merged)
        for item in self.items():
            self.assertEqual(item['predecessor_ids'], sorted(ancestors | {merged['id']}))
        self.assertEqual(sum(item['length_m'] for item in self.case.state['item_results']), 10)

    def test_historical_detach_preserves_schedule_values_and_audit_lineage(self):
        root_id = self.case.create('duct', quantity=1)
        self.case.confirm(root_id)
        self.case.apply(self.case.preview(root_id, calculator_id='ductwork'))
        calculator = deepcopy(self.case.state['calculator'])
        original = deepcopy(self.items()[0])
        self.split_duct(original)
        binding = deepcopy(self.case.state['snapshot']['transfers'][0])
        self.assertEqual(binding['status'], 'deleted')
        self.assertNotIn(root_id, [item['id'] for item in self.items()])
        self.command('detach_transfers', item_ids=[root_id], calculator_id='ductwork')
        self.assertEqual(self.case.state['snapshot']['transfers'], [])
        self.assertNotIn('calculator', self.case.state)
        event = self.case.documents.get_blob(self.case.state['snapshot']['audit_head'])
        self.assertEqual(event['op'], 'detach_transfers')
        self.assertEqual(event['before']['transfers'], [binding])
        self.assertEqual(event['after']['transfers'], [])
        for address, value in binding['values'].items():
            self.assertEqual(calculator['inputs'][binding['sheet']].get(address), value)
        self.assertTrue(all(root_id in item['predecessor_ids'] for item in self.items()))
        with self.case.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM calculator_states').fetchone()[0], 0)

    def test_detach_rejects_unknown_duplicate_malformed_and_wrong_calculator_ids(self):
        root_id = self.case.create('duct', quantity=1)
        self.case.confirm(root_id)
        self.case.apply(self.case.preview(root_id, calculator_id='ductwork'))
        self.split_duct(deepcopy(self.items()[0]))
        before = deepcopy(self.case.state['snapshot'])
        for ids, calculator in (([str(uuid4())], 'ductwork'), ([root_id, root_id], 'ductwork'),
                                (['invalid'], 'ductwork'), ([], 'ductwork'), ([root_id], 'steel_board'),
                                ([root_id], 'unknown'), ([None], 'ductwork')):
            with self.subTest(ids=ids, calculator=calculator), self.assertRaises(ValidationError):
                self.command('detach_transfers', item_ids=ids, calculator_id=calculator)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_steel_partition_keeps_exact_member_ids_quantities_properties_and_requires_review(self):
        root_id = self.case.create(quantity=5)
        self.case.confirm(root_id)
        original = deepcopy(self.items()[0])
        total = self.case.state['item_results'][0]['total_length_m']
        self.command('split_steel_group', item_id=root_id, quantities=[2, 3])
        children = self.items()
        self.assertEqual([item['quantity'] for item in children], [2, 3])
        self.assertEqual([member for item in children for member in item['member_ids']], original['member_ids'])
        self.assertEqual(sum(item['total_length_m'] for item in self.case.state['item_results']), total)
        for item in children:
            self.assertEqual(item['predecessor_ids'], [root_id])
            self.assertEqual(item['state'], 'draft')
            self.assertIsNone(item['review']); self.assertIsNone(item['confirmation'])
            for key in ('fields', 'geometry', 'measurement', 'evidence'):
                self.assertEqual(item[key], original[key])

    def test_nested_steel_partition_and_merge_keep_member_identity_and_full_ancestry(self):
        root_id = self.case.create(quantity=5)
        original = deepcopy(self.items()[0])
        self.command('split_steel_group', item_id=root_id, quantities=[2, 3])
        first, second = deepcopy(self.items())
        self.command('split_steel_group', item_id=first['id'], quantities=[1, 1])
        children = [deepcopy(item) for item in self.items() if item['id'] != second['id']]
        extra = {'document_id': self.case.doc['id'], 'page': 1, 'note': 'Independent supporting member reference'}
        self.command('update_item', item_id=second['id'], changes={'evidence': [*second['evidence'], extra]})
        selected = [children[0]['id'], children[1]['id'], second['id']]
        self.command('merge_steel_groups', item_ids=selected)
        merged = self.items()[0]
        self.assertEqual(merged['quantity'], 5)
        self.assertEqual(merged['member_ids'], original['member_ids'])
        self.assertEqual(merged['predecessor_ids'], sorted({root_id, first['id'], *selected}))
        self.assertIn(extra, merged['evidence'])
        self.assertEqual(merged['state'], 'draft')
        self.assertIsNone(merged['review']); self.assertIsNone(merged['confirmation'])

    def test_steel_partition_rejects_inferred_or_changed_physical_quantity(self):
        root_id = self.case.create(quantity=5)
        before = deepcopy(self.case.state['snapshot'])
        for quantities in ([5], [2, 2], [0, 5], [True, 4], [2.0, 3], '2,3', [1]*101):
            with self.subTest(quantities=quantities), self.assertRaises(ValidationError):
                self.command('split_steel_group', item_id=root_id, quantities=quantities)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        duct = self.case.create('duct', quantity=2)
        with self.assertRaises(ValidationError):
            self.command('split_steel_group', item_id=duct, quantities=[1, 1])

    def test_steel_merge_rejects_property_source_and_length_conflicts_atomically(self):
        first = self.case.create(quantity=2)
        second = self.case.create(quantity=3)
        second_item = deepcopy(self.items()[1])
        variants = [
            {'fields': {'section': 'DIFFERENT'}},
            {'geometry': {**second_item['geometry'], 'points': [[10, 40], [110, 40]]}},
            {'measurement': {'method': 'cited', 'length_m': 10, 'citation': 'Different source dimension'}},
        ]
        for change in variants:
            self.command('update_item', item_id=second, changes=change)
            before = deepcopy(self.case.state['snapshot'])
            with self.subTest(change=change), self.assertRaisesRegex(ValidationError, 'identical complete'):
                self.command('merge_steel_groups', item_ids=[first, second])
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
            self.command('update_item', item_id=second, changes={key: second_item[key] for key in change})
        with self.assertRaises(ValidationError):
            self.command('merge_steel_groups', item_ids=[first, first])


if __name__ == '__main__':
    unittest.main()
