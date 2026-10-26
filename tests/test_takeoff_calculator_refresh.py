"""Calculator changes refresh supported details only after an explicit review."""
from copy import deepcopy
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import digest, item_digest
from tests import test_takeoff_workspace as fixtures


class CalculatorRefreshTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.item_id = self.case.create('duct', quantity=1); self.case.confirm(self.item_id)
        self.transferred = self.case.preview(self.item_id, 'ductwork'); self.case.apply(self.transferred)
        self.inputs = deepcopy(self.transferred['inputs']); self.rows = self.transferred['schedule_rows']

    def request(self, **overrides):
        return {'expected_revision': self.case.state['revision'], 'calculator_id': 'ductwork',
                'inputs': deepcopy(self.inputs), 'schedule_rows': deepcopy(self.rows),
                'item_ids': [self.item_id], **overrides}

    def preview(self, **overrides):
        return self.case.service.preview_calculator_refresh(self.case.sid, self.request(**overrides))

    def apply(self, preview, **overrides):
        request = {'expected_revision': self.case.state['revision'], 'request_id': str(uuid4()),
                   'preview_id': preview['preview_id'], 'inputs': deepcopy(self.inputs),
                   'schedule_rows': deepcopy(self.rows), **overrides}
        result = self.case.service.apply_calculator_refresh(self.case.sid, request)
        self.case.state = result
        return result, request

    def test_duct_field_refresh_preserves_sources_measurements_and_calculator_draft(self):
        before = deepcopy(self.case.state['snapshot']); self.inputs['CALCULATOR'].update(B11='800x500', F11=2, G11=1, H11='Both')
        draft = deepcopy(self.inputs); preview = self.preview()
        self.assertEqual(self.case.state['snapshot'], before, 'Preview is read-only')
        result, _ = self.apply(preview); item = result['snapshot']['items'][0]
        self.assertEqual(self.inputs, draft)
        self.assertEqual(item['fields']['width_mm'], 800); self.assertEqual(item['fields']['height_mm'], 500)
        self.assertEqual(item['fields']['wall_penetrations'], 2); self.assertEqual(item['fields']['floor_penetrations'], 1)
        self.assertEqual(item['fields']['exposure'], 'Both'); self.assertEqual(item['state'], 'draft')
        self.assertIsNone(item['review']); self.assertIsNone(item['confirmation'])
        for key in ('id', 'geometry', 'measurement', 'quantity', 'evidence', 'member_ids'):
            self.assertEqual(item[key], before['items'][0][key])
        self.assertEqual(result['item_results'][0]['length_m'], 10)
        binding = result['snapshot']['transfers'][0]
        self.assertEqual(binding['id'], before['transfers'][0]['id'])
        self.assertEqual(binding['item_digest'], item_digest(item, result['snapshot']))
        self.assertEqual(binding['input_hash'], digest(binding['values']))
        with self.case.store.connect() as db:
            self.assertTrue(db.execute('SELECT 1 FROM takeoff_transfer_receipts WHERE binding_id=? AND digest=?',
                (binding['id'], self.case.service._binding_digest(binding))).fetchone())
        self.case.confirm(self.item_id)
        forward = self.case.preview(self.item_id, 'ductwork', self.inputs, self.rows, update=True)
        self.assertEqual(forward['changes'][0]['action'], 'unchanged')
        self.assertEqual(forward['inputs'], self.inputs)

    def test_both_sides_changed_rejects_atomically(self):
        self.inputs['CALCULATOR']['F11'] = 2
        self.case.command('update_item', item_id=self.item_id, changes={'fields': {'notes': 'changed in Takeoffs'}})
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'Both Takeoffs and the calculator changed'):
            self.preview()
        self.assertEqual(self.case.state['snapshot'], before)

    def test_measurement_quantity_and_unmapped_inputs_are_not_imported(self):
        for address, value in [('D11', 50), ('CM11', 2), ('J11', 50)]:
            with self.subTest(address=address):
                draft = deepcopy(self.inputs); draft['CALCULATOR'][address] = value
                with self.assertRaises(ValidationError):
                    self.preview(inputs=draft)
        self.assertEqual(self.case.state['snapshot']['items'][0]['state'], 'confirmed')

    def test_missing_row_and_unregistered_binding_are_rejected(self):
        self.inputs['CALCULATOR']['F11'] = 2
        with self.assertRaisesRegex(ValidationError, 'missing, unverified'):
            self.preview(schedule_rows=[12])
        with self.case.store.connect() as db:
            db.execute('DELETE FROM takeoff_transfer_receipts')
        with self.assertRaisesRegex(ValidationError, 'missing, unverified'):
            self.preview()

    def test_changed_calculator_during_preview_does_not_change_takeoffs(self):
        self.inputs['CALCULATOR']['F11'] = 2; preview = self.preview()
        before = deepcopy(self.case.state['snapshot']); self.inputs['CALCULATOR']['G11'] = 3
        with self.assertRaisesRegex(ValidationError, 'calculator changed during refresh'):
            self.apply(preview)
        self.assertEqual(self.case.state['snapshot'], before)

    def test_changed_takeoffs_during_preview_cannot_apply_stale_result(self):
        self.inputs['CALCULATOR']['F11'] = 2; preview = self.preview(); revision = self.case.state['revision']
        self.case.command('update_item', item_id=self.item_id, changes={'fields': {'notes': 'newer'}})
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'draft changed'):
            self.apply(preview, expected_revision=revision)
        self.assertEqual(self.case.state['snapshot'], before)

    def test_retry_is_idempotent_and_different_payload_is_rejected(self):
        self.inputs['CALCULATOR']['F11'] = 2; result, request = self.apply(self.preview())
        retried = self.case.service.apply_calculator_refresh(self.case.sid, request)
        self.assertEqual(retried, result)
        altered = deepcopy(request); altered['inputs']['CALCULATOR']['F11'] = 3
        with self.assertRaisesRegex(ValidationError, 'already used'):
            self.case.service.apply_calculator_refresh(self.case.sid, altered)

    def test_source_only_edit_preserves_existing_forward_transfer_path(self):
        self.case.command('update_item', item_id=self.item_id, changes={'fields': {'wall_penetrations': 3}})
        preview = self.preview(); self.assertEqual(preview['changes'], []); self.assertIsNone(preview['preview_id'])
        self.case.confirm(self.item_id)
        forward = self.case.preview(self.item_id, 'ductwork', self.inputs, self.rows, update=True)
        self.assertEqual(forward['inputs']['CALCULATOR']['F11'], 3)

    def test_takeoff_only_undo_cannot_diverge_refreshed_link(self):
        self.inputs['CALCULATOR']['F11'] = 2; self.apply(self.preview())
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'cannot be reversed by Takeoff-only Undo'):
            self.case.command('undo')
        self.assertEqual(self.case.state['snapshot'], before)
        self.inputs['CALCULATOR']['F11'] = 0; self.apply(self.preview())
        self.assertEqual(self.case.state['snapshot']['items'][0]['fields']['wall_penetrations'], 0)

    def test_retry_after_later_edit_cannot_return_stale_refresh_authority(self):
        self.inputs['CALCULATOR']['F11'] = 2; _, request = self.apply(self.preview())
        self.case.command('update_item', item_id=self.item_id, changes={'fields': {'notes': 'later edit'}})
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'refresh was already applied'):
            self.case.service.apply_calculator_refresh(self.case.sid, request)
        self.assertEqual(self.case.state['snapshot'], before)

    def test_invalid_integer_and_size_are_rejected_without_mutation(self):
        for address, value in [('F11', 1.5), ('F11', 2.0), ('F11', True), ('G11', -1), ('B11', 'unknown'), ('B11', '0x400')]:
            with self.subTest(address=address, value=value):
                draft = deepcopy(self.inputs); draft['CALCULATOR'][address] = value
                with self.assertRaises(ValidationError):
                    self.preview(inputs=draft)
        self.assertEqual(self.case.state['snapshot']['items'][0]['state'], 'confirmed')

    def test_calculator_id_requires_a_supported_string(self):
        for value in ([], {}, None, True, 1, 'not-a-calculator'):
            with self.subTest(value=value), self.assertRaisesRegex(ValidationError, 'available steel or duct'):
                self.preview(calculator_id=value)

    def test_refresh_preview_cannot_be_used_as_transfer_approval(self):
        self.inputs['CALCULATOR']['F11'] = 2; preview = self.preview()
        with self.assertRaisesRegex(ValidationError, 'calculator transfer preview'):
            self.case.service.apply_transfer(self.case.sid, {'expected_revision': self.case.state['revision'],
                'request_id': str(uuid4()), 'preview_id': preview['preview_id'], 'inputs': self.inputs, 'schedule_rows': self.rows})

    def test_steel_fields_refresh_keeps_physical_quantity_and_length(self):
        identity = self.case.create(); self.case.confirm(identity)
        transferred = self.case.preview(identity, 'steel_vermiculite'); self.case.apply(transferred)
        draft = deepcopy(transferred['inputs']); draft['SCHEDULE'].update(A10='B18', H10=60)
        before = deepcopy(self.case.state['snapshot']['items'][-1])
        preview = self.preview(calculator_id='steel_vermiculite', inputs=draft,
                               schedule_rows=transferred['schedule_rows'], item_ids=[identity])
        result, _ = self.apply(preview, inputs=draft, schedule_rows=transferred['schedule_rows'])
        item = result['snapshot']['items'][-1]
        self.assertEqual(item['fields']['mark'], 'B18'); self.assertEqual(item['fields']['fire_period_min'], 60)
        for key in ('id', 'member_ids', 'quantity', 'geometry', 'measurement'):
            self.assertEqual(item[key], before[key])
        self.assertEqual(result['item_results'][-1]['total_length_m'], 20)

    def test_foreign_session_cannot_apply_preview(self):
        self.inputs['CALCULATOR']['F11'] = 2; preview = self.preview(); foreign = self.case.service.open()
        with self.assertRaisesRegex(ValidationError, 'preview expired'):
            self.case.service.apply_calculator_refresh(foreign['session_id'], {
                'expected_revision': foreign['revision'], 'request_id': str(uuid4()), 'preview_id': preview['preview_id'],
                'inputs': self.inputs, 'schedule_rows': self.rows})


if __name__ == '__main__':
    unittest.main()
