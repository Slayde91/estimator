"""Coupled takeoff/schedule removal, conflict boundaries and exact restoration."""

from copy import deepcopy
from pathlib import Path
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_linked_delete import prepare_delete
import test_takeoff_workspace as workspace


class LinkedDeleteTests(unittest.TestCase):
    setUp = workspace.TakeoffWorkspaceTests.setUp
    command = workspace.TakeoffWorkspaceTests.command
    create = workspace.TakeoffWorkspaceTests.create
    confirm = workspace.TakeoffWorkspaceTests.confirm
    preview = workspace.TakeoffWorkspaceTests.preview
    apply = workspace.TakeoffWorkspaceTests.apply

    def linked(self):
        identity = self.create()
        self.confirm(identity)
        preview = self.preview(identity)
        self.apply(preview)
        return identity, {'steel_vermiculite': {'inputs': deepcopy(preview['inputs']), 'schedule_rows': preview['schedule_rows']}}

    def delete(self, ids, calculators):
        request = {'expected_revision': self.state['revision'], 'request_id': str(uuid4()),
                   'item_ids': ids, 'calculators': calculators}
        self.state = self.service.delete_linked_items(self.sid, request)
        return request

    def undo(self, calculators):
        request = {'expected_revision': self.state['revision'], 'request_id': str(uuid4()), 'calculators': calculators}
        self.state = self.service.undo_linked_delete(self.sid, request)
        return request

    def test_delete_and_undo_restore_exact_item_row_and_unrelated_inputs(self):
        identity, calculators = self.linked()
        original_item = deepcopy(self.state['snapshot']['items'][0])
        original_binding = deepcopy(self.state['snapshot']['transfers'][0])
        draft = calculators['steel_vermiculite']
        draft['inputs']['SCHEDULE']['A11'] = 'Unrelated manual member'
        draft['inputs']['SETTINGS']['D37'] = 0.123456789012345
        draft['schedule_rows'] = [10, 11]
        retained = deepcopy(calculators)
        self.delete([identity], calculators)
        self.assertEqual(calculators, retained)
        self.assertFalse(self.state['snapshot']['items'])
        self.assertFalse(self.state['snapshot']['transfers'])
        self.assertEqual(self.state['calculators']['steel_vermiculite']['schedule_rows'], [11])
        self.assertTrue(all(self.state['calculators']['steel_vermiculite']['inputs']['SCHEDULE'][address] is None
                            for address in original_binding['values']))
        self.assertEqual(self.state['linked_undo']['calculator_ids'], ['steel_vermiculite'])
        changed = deepcopy(self.state['calculators'])
        changed['steel_vermiculite']['inputs']['SETTINGS']['D37'] = 0.23456789012345
        self.undo(changed)
        expected = deepcopy(retained)
        expected['steel_vermiculite']['inputs']['SETTINGS']['D37'] = 0.23456789012345
        self.assertEqual(self.state['calculators'], expected)
        item = self.state['snapshot']['items'][0]
        self.assertEqual(item['id'], original_item['id'])
        self.assertEqual(item['member_ids'], original_item['member_ids'])
        self.assertEqual(item['geometry'], original_item['geometry'])
        self.assertEqual(item['state'], 'draft')
        self.assertIsNone(item['confirmation'])
        self.assertEqual(self.state['snapshot']['transfers'][0], {**original_binding, 'status': 'stale'})
        self.assertIsNone(self.state['linked_undo'])

    def test_stale_item_is_safe_when_original_row_is_unchanged(self):
        identity, calculators = self.linked()
        self.command('update_item', item_id=identity, changes={'quantity': 3})
        self.assertEqual(self.state['snapshot']['transfers'][0]['status'], 'stale')
        self.delete([identity], calculators)
        self.assertFalse(self.state['snapshot']['transfers'])
        self.undo(self.state['calculators'])
        self.assertEqual(self.state['snapshot']['items'][0]['quantity'], 3)
        self.assertEqual(self.state['calculators']['steel_vermiculite']['inputs']['SCHEDULE']['I10'], 2)
        self.assertEqual(self.state['snapshot']['transfers'][0]['status'], 'stale')

    def test_manual_row_edits_block_without_partial_changes(self):
        identity, calculators = self.linked()
        calculators['steel_vermiculite']['inputs']['SCHEDULE']['K10'] = 0.123456789012345
        before = deepcopy(self.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'row was edited'):
            self.delete([identity], calculators)
        self.assertEqual(self.service.get(self.sid)['snapshot'], before)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM takeoff_linked_deletions').fetchone()[0], 0)

    def test_already_removed_row_deletes_link_without_resurrecting_it_on_undo(self):
        identity, calculators = self.linked()
        binding = self.state['snapshot']['transfers'][0]
        for address in binding['values']:
            calculators['steel_vermiculite']['inputs']['SCHEDULE'][address] = None
        calculators['steel_vermiculite']['schedule_rows'] = [11]
        original = deepcopy(calculators)
        self.delete([identity], calculators)
        self.undo(self.state['calculators'])
        self.assertEqual(self.state['calculators'], original)

    def test_multiple_destinations_and_unlinked_batch_item_are_atomic(self):
        identity, calculators = self.linked()
        self.command('update_item', item_id=identity, changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        self.confirm(identity)
        board = self.preview(identity, 'steel_board')
        self.apply(board)
        calculators['steel_board'] = {'inputs': board['inputs'], 'schedule_rows': board['schedule_rows']}
        other = self.create()
        before = deepcopy(self.state['snapshot'])
        broken = deepcopy(calculators)
        broken['steel_board']['inputs']['CALCULATOR']['F9'] = 321
        with self.assertRaisesRegex(ValidationError, 'row was edited'):
            self.delete([identity, other], broken)
        self.assertEqual(self.service.get(self.sid)['snapshot'], before)
        self.delete([identity, other], calculators)
        self.assertFalse(self.state['snapshot']['items'])
        self.assertEqual(set(self.state['calculators']), {'steel_board', 'steel_vermiculite'})
        self.assertEqual(self.state['linked_undo']['calculator_ids'], ['steel_board', 'steel_vermiculite'])
        self.undo(self.state['calculators'])
        self.assertEqual(self.state['calculators'], calculators)
        self.assertEqual({item['id'] for item in self.state['snapshot']['items']}, {identity, other})

    def test_missing_extra_or_invalid_target_drafts_fail_closed(self):
        identity, calculators = self.linked()
        before = deepcopy(self.state['snapshot'])
        for incoming in ({}, {**calculators, 'other': {}}, {'steel_vermiculite': {'inputs': {}, 'schedule_rows': []}}):
            with self.subTest(incoming=incoming), self.assertRaises(ValidationError):
                self.delete([identity], incoming)
            self.assertEqual(self.service.get(self.sid)['snapshot'], before)

    def test_unregistered_binding_cannot_authorize_deletion(self):
        identity, calculators = self.linked()
        with self.store.connect() as db:
            db.execute('DELETE FROM takeoff_transfer_receipts')
        before = deepcopy(self.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'no local transfer receipt'):
            self.delete([identity], calculators)
        self.assertEqual(self.service.get(self.sid)['snapshot'], before)

    def test_source_mismatch_and_conflict_bindings_are_rejected(self):
        _, calculators = self.linked()
        original = self.state['snapshot']['transfers'][0]
        for patch in ({'source_sha256': 'b' * 64}, {'status': 'conflict'}, {'status': 'deleted'}):
            with self.subTest(patch=patch), self.assertRaisesRegex(ValidationError, 'source is unverified or changed'):
                prepare_delete([{**original, **patch}], calculators)

    def test_retry_is_idempotent_and_stale_revision_cannot_apply_again(self):
        identity, calculators = self.linked()
        request = self.delete([identity], calculators)
        self.assertEqual(self.service.delete_linked_items(self.sid, request), self.state)
        altered = deepcopy(request)
        altered['item_ids'] = [str(uuid4())]
        with self.assertRaisesRegex(ValidationError, 'request ID'):
            self.service.delete_linked_items(self.sid, altered)
        undo_request = self.undo(self.state['calculators'])
        self.assertEqual(self.service.undo_linked_delete(self.sid, undo_request), self.state)
        with self.assertRaisesRegex(ValidationError, 'already applied'):
            self.service.delete_linked_items(self.sid, request)
        with self.assertRaisesRegex(ValidationError, 'draft changed'):
            self.service.delete_linked_items(self.sid, {**request, 'request_id': str(uuid4())})

    def test_undo_blocks_reused_row_or_changed_row_metadata_without_mutation(self):
        identity, calculators = self.linked()
        self.delete([identity], calculators)
        before = deepcopy(self.state['snapshot'])
        for change in ('input', 'rows'):
            changed = deepcopy(self.state['calculators'])
            if change == 'input':
                changed['steel_vermiculite']['inputs']['SCHEDULE']['A10'] = 'New manual member'
            else:
                changed['steel_vermiculite']['schedule_rows'].append(11)
            with self.subTest(change=change), self.assertRaisesRegex(ValidationError, 'Undo cannot overwrite'):
                self.undo(changed)
            self.assertEqual(self.service.get(self.sid)['snapshot'], before)
        with self.assertRaisesRegex(ValidationError, 'takeoff-only undo'):
            self.command('undo')

    def test_saved_reopened_session_exposes_durable_undo_and_restores(self):
        identity, calculators = self.linked()
        self.delete([identity], calculators)
        deleted = deepcopy(self.state['calculators'])
        saved = deepcopy(self.state['snapshot'])
        self.service = workspace.TakeoffService(self.store, self.documents)
        self.state = self.service.open(saved, source_path=Path(self.directory.name) / 'saved.ceasefire')
        self.sid = self.state['session_id']
        self.assertEqual(self.state['linked_undo']['calculator_ids'], ['steel_vermiculite'])
        self.assertEqual(len(self.state['linked_undo']['cleared_rows']), 1)
        self.undo(deleted)
        self.assertEqual(self.state['snapshot']['items'][0]['id'], identity)
        self.assertEqual(self.state['calculators'], calculators)

    def test_render_observations_after_reopen_preserve_undo_and_current_evidence(self):
        identity, calculators = self.linked()
        other = self.create()
        self.confirm(other)
        self.delete([identity], calculators)
        deleted = deepcopy(self.state['calculators'])
        self.state = self.service.open(self.state['snapshot'], source_path=Path(self.directory.name) / 'saved.ceasefire')
        self.sid = self.state['session_id']
        self.command('record_render', document_id=self.doc['id'], page=1, success=False, warnings=['Canvas warning'])
        self.command('record_render', document_id=self.doc['id'], page=1, success=True, warnings=[])
        observations = deepcopy(self.state['snapshot']['render_checks'])
        retained_other = deepcopy(self.state['snapshot']['items'][0])
        self.assertEqual(retained_other['id'], other)
        self.assertEqual(retained_other['state'], 'draft')
        self.assertEqual(self.state['linked_undo']['calculator_ids'], ['steel_vermiculite'])
        self.undo(deleted)
        self.assertEqual(self.state['snapshot']['render_checks'], observations)
        self.assertEqual(next(item for item in self.state['snapshot']['items'] if item['id'] == other), retained_other)
        self.assertEqual(self.state['calculators'], calculators)

    def test_intervening_item_edit_ends_coupled_undo_availability(self):
        identity, calculators = self.linked()
        self.delete([identity], calculators)
        deleted = deepcopy(self.state['calculators'])
        self.create()
        self.assertIsNone(self.state['linked_undo'])
        with self.assertRaisesRegex(ValidationError, 'no current linked deletion'):
            self.undo(deleted)

    def test_multiple_rows_same_calculator_restore_original_extent_and_member_ids(self):
        first, calculators = self.linked()
        second = self.create()
        self.confirm(second)
        draft = calculators['steel_vermiculite']
        preview = self.preview(second, inputs=draft['inputs'], rows=draft['schedule_rows'])
        self.apply(preview, inputs=draft['inputs'], rows=draft['schedule_rows'])
        calculators['steel_vermiculite'] = {'inputs': preview['inputs'], 'schedule_rows': preview['schedule_rows']}
        original_ids = {item['id']: item['member_ids'] for item in self.state['snapshot']['items']}
        self.delete([first, second], calculators)
        self.assertEqual(self.state['calculators']['steel_vermiculite']['schedule_rows'], [10])
        self.assertEqual(len(self.state['linked_undo']['cleared_rows']), 2)
        self.undo(self.state['calculators'])
        self.assertEqual(self.state['calculators'], calculators)
        self.assertEqual({item['id']: item['member_ids'] for item in self.state['snapshot']['items']}, original_ids)


if __name__ == '__main__':
    unittest.main()
