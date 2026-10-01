"""Appending transfers skips existing destinations without refreshing their data."""
from copy import deepcopy
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_transfer import transfer_preview
from tests import test_takeoff_workspace as fixtures


class TakeoffTransferSkipTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def linked(self, calculator='steel_vermiculite'):
        identifier = self.case.create()
        if calculator == 'steel_board':
            self.case.command('update_item', item_id=identifier,
                              changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        self.case.confirm(identifier)
        preview = self.case.preview(identifier, calculator)
        self.case.apply(preview)
        return identifier, {'inputs': deepcopy(preview['inputs']), 'schedule_rows': preview['schedule_rows']}

    def preview(self, identifiers, draft, calculator='steel_vermiculite', update=False):
        return self.case.service.preview_transfer(self.case.sid, {
            'expected_revision': self.case.state['revision'], 'calculator_id': calculator,
            **draft, 'item_ids': identifiers, 'update_linked': update})

    def database(self):
        with self.case.store.connect() as connection:
            return list(connection.iterdump())

    def test_mixed_stale_invalid_item_and_edited_link_are_skipped_on_preview_apply_and_retry(self):
        linked, draft = self.linked()
        self.case.command('update_item', item_id=linked,
                          changes={'quantity': None, 'fields': {'section': 'Unsupported changed source'}})
        candidate = self.case.create(); self.case.confirm(candidate)
        draft['inputs']['SCHEDULE']['K10'] = 0.123456789012345
        before = deepcopy(self.case.state['snapshot']); original = deepcopy(draft)
        binding = deepcopy(before['transfers'][0])
        preview = self.preview([linked, candidate], draft)
        self.assertEqual(preview['skipped'], [{'item_id': linked, 'calculator_id': 'steel_vermiculite',
            'row': 10, 'binding_id': binding['id'], 'status': 'stale', 'reason': 'already_linked'}])
        self.assertEqual(preview['changes'], [{'item_id': candidate, 'row': 11, 'action': 'append'}])
        self.assertEqual([entry['item_id'] for entry in preview['bindings']], [candidate])
        for address in binding['values']:
            self.assertEqual(preview['inputs']['SCHEDULE'][address], draft['inputs']['SCHEDULE'][address])
        self.assertEqual(preview['inputs']['SETTINGS'], draft['inputs']['SETTINGS'])
        self.assertEqual(draft, original)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        request = self.case.apply(preview, inputs=draft['inputs'], rows=draft['schedule_rows'])
        current = self.case.state['snapshot']
        self.assertEqual(next(entry for entry in current['transfers'] if entry['item_id'] == linked), binding)
        self.assertEqual(current['items'], before['items'])
        self.assertEqual(self.case.state['calculator']['inputs']['SCHEDULE']['K10'], 0.123456789012345)
        self.assertEqual(self.case.state['calculator']['inputs']['SCHEDULE']['I10'], 2)
        self.assertEqual(self.case.state['calculator']['inputs']['SCHEDULE']['I11'], 2)
        self.assertEqual(self.case.service.apply_transfer(self.case.sid, request), self.case.state)

    def test_all_skipped_is_informational_with_exact_inputs_and_no_apply_authority_or_writes(self):
        linked, draft = self.linked()
        self.case.command('update_item', item_id=linked, changes={'quantity': None})
        before = deepcopy(self.case.state['snapshot']); database = self.database()
        blobs = deepcopy(self.case.documents.blobs)
        cache = deepcopy(self.case.service._sessions[self.case.sid]['previews'])
        self.case.documents.blocked = True
        # No candidate depends on source evidence or needs calculator defaults.
        original = {'inputs': {}, 'schedule_rows': [10]}
        for _ in range(2):
            preview = self.preview([linked], original)
            self.assertIsNone(preview['preview_id'])
            for key in ('changes', 'bindings', 'normalizations', 'warnings'):
                self.assertEqual(preview[key], [])
            self.assertEqual(preview['inputs'], original['inputs'])
            self.assertEqual(preview['schedule_rows'], original['schedule_rows'])
            self.assertEqual(preview['revision'], before['revision'])
            with self.assertRaises(ValidationError):
                self.case.service.apply_transfer(self.case.sid, {'expected_revision': before['revision'],
                    'request_id': str(uuid4()), 'preview_id': preview['preview_id'], **original})
        self.assertEqual(self.case.service.get(self.case.sid, verify_evidence=False)['snapshot'], before)
        self.assertEqual(self.database(), database)
        self.assertEqual(self.case.documents.blobs, blobs)
        self.assertEqual(self.case.service._sessions[self.case.sid]['previews'], cache)

    def test_cleared_skipped_row_keeps_exact_absent_cells_while_new_item_appends(self):
        linked, draft = self.linked()
        draft['inputs']['SCHEDULE'] = {}
        candidate = self.case.create(); self.case.confirm(candidate)
        preview = self.preview([linked, candidate], draft)
        self.assertEqual(preview['changes'][0]['row'], 11)
        self.assertFalse(any(address.endswith('10') for address in preview['inputs']['SCHEDULE']))
        binding = deepcopy(self.case.state['snapshot']['transfers'][0])
        self.case.apply(preview, inputs=draft['inputs'], rows=draft['schedule_rows'])
        self.assertEqual(self.case.state['snapshot']['transfers'][0], binding)

    def test_link_status_source_version_and_unconfirmed_properties_do_not_block_append_skips(self):
        linked, draft = self.linked()
        self.case.command('update_item', item_id=linked, changes={'quantity': None})
        candidate = self.case.create(); self.case.confirm(candidate)
        for status in ('current', 'stale', 'conflict', 'deleted'):
            with self.subTest(status=status):
                snapshot = deepcopy(self.case.state['snapshot'])
                snapshot['transfers'][0].update(status=status, source_sha256='b'*64, input_hash='c'*64)
                binding = deepcopy(snapshot['transfers'][0])
                result = transfer_preview(snapshot, {'calculator_id': 'steel_vermiculite',
                    'expected_revision': snapshot['revision'], 'item_ids': [linked, candidate], **draft})
                self.assertEqual(result['skipped'][0]['status'], status)
                self.assertEqual(result['all_bindings'][0], binding)
                self.assertEqual([entry['item_id'] for entry in result['bindings']], [candidate])

    def test_skips_are_scoped_to_selected_calculator(self):
        linked, _ = self.linked()
        self.case.command('update_item', item_id=linked,
                          changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        self.case.confirm(linked)
        before = deepcopy(self.case.state['snapshot']['transfers'][0])
        preview = self.case.preview(linked, 'steel_board')
        self.assertEqual(preview['skipped'], [])
        self.assertEqual(preview['changes'][0]['action'], 'append')
        self.case.apply(preview)
        self.assertEqual(self.case.state['snapshot']['transfers'][0], before)
        self.assertEqual(len(self.case.state['snapshot']['transfers']), 2)

    def test_skipped_board_row_is_not_reassessed_or_normalized(self):
        linked, draft = self.linked('steel_board')
        self.case.command('update_item', item_id=linked, changes={'fields': {'section': 'Unsupported source profile'}})
        draft['inputs']['CALCULATOR']['D9'] = 'Unsupported manual profile'
        candidate = self.case.create()
        self.case.command('update_item', item_id=candidate,
                          changes={'fields': {'product': 'TRAFALGAR COREX', 'critical_temperature': 620}})
        self.case.confirm(candidate)
        preview = self.preview([linked, candidate], draft, 'steel_board')
        self.assertEqual(preview['inputs']['CALCULATOR']['D9'], 'Unsupported manual profile')
        self.assertEqual(preview['inputs']['CALCULATOR']['F9'], draft['inputs']['CALCULATOR']['F9'])
        self.assertEqual(preview['inputs']['CALCULATOR']['F10'], 20)
        self.assertTrue(all(value['item_id'] == candidate for value in preview['warnings']))
        self.assertTrue(all(value['item_id'] == candidate for value in preview['normalizations']))

    def test_explicit_updates_still_validate_confirmation_conflicts_and_unchanged_receipts(self):
        linked, draft = self.linked()
        unchanged = self.preview([linked], draft, update=True)
        self.assertEqual(unchanged['changes'][0]['action'], 'unchanged')
        self.assertEqual(unchanged['skipped'], [])
        edited = deepcopy(draft); edited['inputs']['SCHEDULE']['K10'] = 5
        with self.assertRaisesRegex(ValidationError, 'linked calculator row'):
            self.preview([linked], edited, update=True)
        self.case.command('update_item', item_id=linked, changes={'quantity': 3})
        with self.assertRaises(ValidationError): self.preview([linked], draft, update=True)
        self.case.confirm(linked)
        update = self.preview([linked], draft, update=True)
        self.assertEqual(update['changes'][0]['action'], 'update')
        self.assertEqual(update['inputs']['SCHEDULE']['I10'], 3)

    def test_new_candidates_still_require_confirmation_and_available_capacity(self):
        linked, draft = self.linked()
        candidate = self.case.create()
        with self.assertRaises(ValidationError): self.preview([linked, candidate], draft)
        self.case.confirm(candidate)
        full = deepcopy(draft)
        full['inputs']['SCHEDULE'].update({f'A{row}': f'Manual {row}' for row in range(10, 1010)})
        full['schedule_rows'] = list(range(10, 1010))
        before = deepcopy(self.case.state['snapshot']); database = self.database()
        self.assertEqual(self.preview([linked], full)['changes'], [])
        with self.assertRaisesRegex(ValidationError, 'enough empty rows'):
            self.preview([linked, candidate], full)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(self.database(), database)


if __name__ == '__main__':
    unittest.main()
