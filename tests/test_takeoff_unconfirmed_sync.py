"""Explicit linked-row updates remove unconfirmed sources without losing them."""
from copy import deepcopy
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_confirmed_transfer as physical_fixtures
from estimator.takeoff_physical import confirmation_owner, graph_collections


class TakeoffUnconfirmedSyncTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def linked(self, calculator='steel_vermiculite'):
        item = self.case.create('duct' if calculator == 'ductwork' else 'steel',
                                **({'quantity': 1} if calculator == 'ductwork' else {}))
        if calculator == 'steel_board':
            self.case.command('update_item', item_id=item,
                changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        if calculator == 'steel_intumescent':
            self.case.command('update_item', item_id=item, changes={'fields': {'product': 'Nullifire SC902', 'exposure': 'I/H beam - 3 sides'}})
        self.case.confirm(item)
        preview = self.case.preview(item, calculator); self.case.apply(preview)
        return item, {'inputs': deepcopy(preview['inputs']), 'rows': deepcopy(preview['schedule_rows'])}

    def remove(self, item, calculator, draft):
        return self.case.preview(item, calculator, inputs=draft['inputs'], rows=draft['rows'], update=True)

    def test_all_workbook_destinations_remove_then_reconfirm_and_add_same_source(self):
        for calculator in ('steel_vermiculite', 'steel_intumescent', 'steel_board', 'ductwork'):
            with self.subTest(calculator=calculator):
                item, draft = self.linked(calculator)
                self.case.command('unconfirm_items', item_ids=[item])
                original = deepcopy(self.case.state['snapshot']['items'])
                preview = self.remove(item, calculator, draft)
                self.assertEqual(preview['changes'][0]['action'], 'remove')
                self.assertEqual(len(preview['removed_bindings']), 1)
                self.assertEqual(preview['bindings'], [])
                request = self.case.apply(preview, inputs=draft['inputs'], rows=draft['rows'])
                self.assertEqual(self.case.state['snapshot']['items'], original)
                self.assertFalse(any(link['item_id'] == item and link['calculator_id'] == calculator for link in self.case.state['snapshot']['transfers']))
                for address in preview['removed_bindings'][0]['values']:
                    self.assertIsNone(preview['inputs'][preview['removed_bindings'][0]['sheet']][address])
                self.assertEqual(self.case.service.apply_transfer(self.case.sid, request), self.case.state)
                self.case.confirm(item)
                again = self.case.preview(item, calculator, inputs=preview['inputs'], rows=preview['schedule_rows'])
                self.assertEqual(again['changes'][0]['action'], 'append')
                self.case.apply(again, inputs=preview['inputs'], rows=preview['schedule_rows'])
                self.assertTrue(any(link['item_id'] == item and link['calculator_id'] == calculator for link in self.case.state['snapshot']['transfers']))

    def test_manual_row_other_destination_and_unselected_link_are_unchanged(self):
        item, draft = self.linked()
        another = self.case.create(); self.case.confirm(another)
        extra = self.case.preview(another, inputs=draft['inputs'], rows=draft['rows'])
        self.case.apply(extra, inputs=draft['inputs'], rows=draft['rows'])
        draft = {'inputs': deepcopy(extra['inputs']), 'rows': deepcopy(extra['schedule_rows'])}
        draft['inputs']['SCHEDULE']['A12'] = 'Manual source'; draft['rows'].append(12)
        before = deepcopy(self.case.state['snapshot']['transfers'][1])
        self.case.command('unconfirm_items', item_ids=[item])
        preview = self.remove(item, 'steel_vermiculite', draft)
        self.assertEqual(preview['inputs']['SCHEDULE']['A12'], 'Manual source')
        self.assertEqual(preview['inputs']['SCHEDULE']['A11'], draft['inputs']['SCHEDULE']['A11'])
        self.case.apply(preview, inputs=draft['inputs'], rows=draft['rows'])
        self.assertIn(before, self.case.state['snapshot']['transfers'])

    def test_changed_calculator_row_missing_row_or_unverified_receipt_cannot_be_removed(self):
        item, draft = self.linked(); self.case.command('unconfirm_items', item_ids=[item])
        edited = deepcopy(draft); edited['inputs']['SCHEDULE']['K10'] = 17
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'linked calculator row'):
            self.remove(item, 'steel_vermiculite', edited)
        missing = deepcopy(draft); missing['rows'] = [11]
        with self.assertRaises(ValidationError): self.remove(item, 'steel_vermiculite', missing)
        with self.case.store.connect() as db:
            db.execute('DELETE FROM takeoff_transfer_receipts')
        with self.assertRaisesRegex(ValidationError, 'no local transfer receipt'):
            self.remove(item, 'steel_vermiculite', draft)
        self.assertEqual(self.case.state['snapshot'], before)

    def test_changed_revision_or_destination_draft_cannot_apply_cached_removal(self):
        item, draft = self.linked(); self.case.command('unconfirm_items', item_ids=[item])
        preview = self.remove(item, 'steel_vermiculite', draft)
        edited = deepcopy(draft['inputs']); edited['SCHEDULE']['A11'] = 'Concurrent manual edit'
        with self.assertRaisesRegex(ValidationError, 'calculator draft changed'):
            self.case.apply(preview, inputs=edited, rows=draft['rows'])
        self.case.command('confirm_items', item_ids=[item])
        with self.assertRaises(ValidationError): self.case.apply(preview, inputs=draft['inputs'], rows=draft['rows'])

    def test_removal_is_scoped_to_selected_destination_for_one_source_linked_twice(self):
        item, spray = self.linked()
        self.case.command('update_item', item_id=item, changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        self.case.confirm(item)
        board = self.case.preview(item, 'steel_board'); self.case.apply(board)
        self.case.command('unconfirm_items', item_ids=[item])
        retained = deepcopy(next(link for link in self.case.state['snapshot']['transfers'] if link['calculator_id'] == 'steel_board'))
        preview = self.remove(item, 'steel_vermiculite', spray)
        self.case.apply(preview, inputs=spray['inputs'], rows=spray['rows'])
        self.assertEqual(self.case.state['snapshot']['transfers'], [retained])


class PhysicalUnconfirmedSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        physical_fixtures.ConfirmedRegisterTransferTests.setUpClass()

    def setUp(self):
        self.case = physical_fixtures.ConfirmedRegisterTransferTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def unconfirm(self, scope, identifier):
        graph = self.case.state()['physical' if scope == 'defect_reports' else 'service_plans']
        index = {entity['id']: (kind, entity) for kind, collection in graph_collections(graph).items() for entity in graph[collection]}
        _, owner = confirmation_owner(graph, identifier, _index=index)
        self.case.links.physical([{'op': 'update', 'entity_id': owner['id'], 'changes': {'confirmation': 'unconfirmed'}}], scope)

    def remove(self, scope, identifiers, **overrides):
        request = {'scope': scope, 'entity_ids': identifiers, 'expected_revision': self.case.state()['revision'],
            'request_id': str(uuid4()), 'draft': deepcopy(self.case.links.draft), 'configuration': {}, **overrides}
        result = self.case.service.remove_unconfirmed_library(self.case.sid, request)
        self.case.links.draft = deepcopy(result['penetration']['draft'])
        return result, request

    def test_manual_source_rows_remove_only_selected_source_then_readd_in_both_scopes(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                _, services = self.case.branch(scope, quantities=(2, 3))
                self.case.transfer(scope)
                mine = [row for row in self.case.links.draft['rows'] if row.get('takeoff_source', {}).get('scope') == scope]
                self.case.links.draft['rows'].append({'id': 'unrelated-' + scope, 'inputs': {'O': 19, 'T': 'Retained manual'}})
                self.unconfirm(scope, services[0]); before = deepcopy(self.case.state())
                result, request = self.remove(scope, [services[0]])
                self.assertEqual(result['library_link']['removed'], 1)
                self.assertEqual(result['snapshot']['physical' if scope == 'defect_reports' else 'service_plans'], before['physical' if scope == 'defect_reports' else 'service_plans'])
                self.assertNotIn(mine[0]['id'], [row['id'] for row in self.case.links.draft['rows']])
                self.assertIn(mine[1], self.case.links.draft['rows'])
                self.assertIn({'id': 'unrelated-' + scope, 'inputs': {'O': 19, 'T': 'Retained manual'}}, self.case.links.draft['rows'])
                self.assertEqual(self.case.service.remove_unconfirmed_library(self.case.sid, request), result)
                self.case.review(scope); self.case.transfer(scope)
                ids = [row['id'] for row in self.case.links.draft['rows']]
                self.assertEqual(ids.count(mine[0]['id']), 1); self.assertEqual(ids.count(mine[1]['id']), 1)

    def test_library_shared_row_subtracts_exact_contribution_and_keeps_manual_quantity_and_other_links(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                _, first = self.case.branch(scope, quantities=(2,))
                _, second = self.case.branch(scope, quantities=(4,))
                one = self.case.associate(first, scope=scope); two = self.case.associate(second, scope=scope)
                self.case.review(scope)
                self.case.links.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'shared', 'library_item_id': 'pkb-001',
                    'inputs': {'O': 10.125, 'AI': 17.25, 'T': 'Retained manual fields'}}]}
                self.case.transfer(scope)
                self.assertEqual(self.case.links.draft['rows'][0]['inputs']['O'], 16.125)
                self.unconfirm(scope, first[0]); before = deepcopy(self.case.state())
                other = next(record for record in before['library_assignments']['records'] if record['id'] == two)
                result, _ = self.remove(scope, first)
                self.assertEqual(self.case.links.draft['rows'][0]['inputs'], {'O': 14.125, 'AI': 17.25, 'T': 'Retained manual fields'})
                records = result['snapshot']['library_assignments']['records']
                self.assertIsNone(next(record for record in records if record['id'] == one)['schedule_binding'])
                self.assertIn(other, records)
                self.case.review(scope); self.case.transfer(scope)
                self.assertEqual(self.case.links.draft['rows'][0]['inputs']['O'], 16.125)

    def test_foreign_graph_project_and_replaced_row_identity_are_not_deleted(self):
        _, services = self.case.branch(quantities=(2,))
        self.case.transfer(); self.unconfirm('service_plans', services[0])
        original = deepcopy(self.case.links.draft)
        for field in ('project_id', 'graph_id'):
            changed = deepcopy(original); changed['rows'][0]['takeoff_source'][field] = str(uuid4())
            with self.assertRaisesRegex(ValidationError, 'No selected unconfirmed'):
                self.remove('service_plans', services, draft=changed)
        changed = deepcopy(original); changed['rows'][0]['id'] = 'manual-replacement'
        with self.assertRaisesRegex(ValidationError, 'moved or its source changed'):
            self.remove('service_plans', services, draft=changed)
        self.assertEqual(self.case.links.draft, original)

    def test_shared_row_conflict_and_stale_revision_are_atomic(self):
        _, services = self.case.branch(quantities=(3,)); self.case.associate(services)
        self.case.review(); self.case.transfer(); self.unconfirm('service_plans', services[0])
        before = deepcopy(self.case.state()); changed = deepcopy(self.case.links.draft)
        changed['rows'][0]['inputs']['O'] = 1
        with self.assertRaisesRegex(ValidationError, 'conflicts with the retained contribution'):
            self.remove('service_plans', services, draft=changed)
        with self.assertRaisesRegex(ValidationError, 'takeoff draft changed'):
            self.remove('service_plans', services, expected_revision=before['revision'] - 1)
        self.assertEqual(self.case.state(), before)

    def test_mixed_confirmation_and_partial_selection_cannot_remove_an_entire_association(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                _, first = self.case.branch(scope, quantities=(2,))
                _, second = self.case.branch(scope, quantities=(4,))
                self.case.associate(first + second, scope=scope)
                self.case.review(scope); self.case.transfer(scope)
                self.unconfirm(scope, second[0])
                before, draft = deepcopy(self.case.state()), deepcopy(self.case.links.draft)
                # A selected confirmed member must not trigger removal because
                # a different, unselected member happens to be unconfirmed.
                with self.assertRaisesRegex(ValidationError, 'No selected unconfirmed'):
                    self.remove(scope, first)
                # Nor can a selected unconfirmed member remove the retained
                # contribution of the group's other, still-confirmed member.
                with self.assertRaisesRegex(ValidationError, 'linked group'):
                    self.remove(scope, second)
                self.assertEqual(self.case.state(), before); self.assertEqual(self.case.links.draft, draft)
                self.unconfirm(scope, first[0]); before = deepcopy(self.case.state())
                with self.assertRaisesRegex(ValidationError, 'linked group'):
                    self.remove(scope, second)
                self.assertEqual(self.case.state(), before)
                result, _ = self.remove(scope, first + second)
                self.assertEqual(result['penetration']['draft']['rows'][0]['inputs']['O'], 0)


if __name__ == '__main__':
    unittest.main()
