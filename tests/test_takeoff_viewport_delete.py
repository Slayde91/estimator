"""Retired viewport evidence must never silently become a different scale."""
from copy import deepcopy
import json
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.takeoff_model import active_calibrations, item_digest, item_result, validate_snapshot
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_project as project_fixtures


class TakeoffViewportDeleteTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def viewport(self, region=None):
        region = region or [10, 20, 110, 100]
        x, y, width, _ = region
        self.case.command('add_calibration', calibration={'id': str(uuid4()),
            'document_id': self.case.doc['id'], 'page': 1, 'name': 'Detail viewport',
            'points': [[x, y], [x+width, y]], 'region': region,
            'scale_denominator': 100, 'uniform_scale': True})
        return deepcopy(self.case.state['snapshot']['calibrations'][-1])

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def assert_blocked(self, identifier, transferred=None):
        result = item_result(self.item(identifier), self.case.state['snapshot'])
        self.assertIsNone(result['length_m'])
        self.assertTrue(result['issues'])
        with self.assertRaises(ValidationError):
            self.case.command('confirm_items', item_ids=[identifier])
        with self.assertRaises(ValidationError):
            self.case.preview(identifier, update=True)
        if transferred is None:
            with self.assertRaises(ValidationError):
                self.case.preview(identifier)
        else:
            # Add skips an existing destination even when its viewport evidence is retired.
            before_add = deepcopy(self.case.state['snapshot'])
            unchanged = self.case.preview(identifier, inputs=transferred['inputs'], rows=transferred['schedule_rows'])
            self.assertIsNone(unchanged['preview_id'])
            self.assertEqual(unchanged['changes'], []); self.assertEqual(unchanged['bindings'], [])
            binding = next(entry for entry in before_add['transfers'] if entry['item_id'] == identifier)
            self.assertEqual(unchanged['skipped'], [{'item_id': identifier, 'calculator_id': binding['calculator_id'],
                'row': binding['row'], 'binding_id': binding['id'], 'status': 'stale', 'reason': 'already_linked'}])
            self.assertEqual(unchanged['inputs'], transferred['inputs'])
            self.assertEqual(unchanged['schedule_rows'], transferred['schedule_rows'])
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before_add)
        with self.assertRaises(ValidationError):
            self.case.service.export(self.case.sid, 'csv', [identifier])

    def test_delete_retires_exact_evidence_invalidates_linked_item_and_is_idempotent(self):
        viewport = self.viewport()
        identifier = self.case.create(measurement={'method': 'calibrated', 'calibration_id': viewport['id']})
        self.case.command('confirm_items', item_ids=[identifier])
        transferred = self.case.preview(identifier); self.case.apply(transferred)
        original = deepcopy(self.item(identifier))
        bindings = deepcopy(self.case.state['snapshot']['transfers'])
        request = {'op': 'delete_viewport', 'calibration_id': viewport['id'],
                   'request_id': str(uuid4()), 'expected_revision': self.case.state['revision']}
        self.case.state = self.case.service.command(self.case.sid, request)
        self.assertEqual(self.case.service.command(self.case.sid, request), self.case.state)
        state = self.case.state['snapshot']; tombstone = state['calibrations'][-1]
        self.assertEqual(state['calibrations'][-2], viewport)
        self.assertEqual(tombstone, {**viewport, 'id': tombstone['id'], 'supersedes_id': viewport['id'], 'deleted': True})
        self.assertNotEqual(tombstone['id'], viewport['id'])
        self.assertEqual([entry['id'] for entry in active_calibrations(state)], [self.case.calibration_id])
        current = self.item(identifier)
        for key in ('geometry', 'measurement', 'fields', 'evidence', 'quantity', 'member_ids'):
            self.assertEqual(current[key], original[key])
        self.assertEqual(current['version'], original['version']+1)
        self.assertEqual(current['state'], 'draft')
        self.assertIsNone(current['review']); self.assertIsNone(current['confirmation'])
        self.assertEqual(state['transfers'], [{**binding, 'status': 'stale'} for binding in bindings])
        self.assertNotIn('calculator', self.case.state)
        event = self.case.documents.get_blob(state['audit_head'])
        self.assertEqual(event['op'], 'delete_viewport')
        self.assertIn(identifier, event['affected_ids']['items'])
        self.assertEqual(event['before']['items'][0], original)
        self.assert_blocked(identifier, transferred)
        # A new viewport in the same region is a different authority. It cannot
        # reactivate a retired reference or manufacture a fresh confirmation.
        replacement = self.viewport()
        self.assertNotEqual(replacement['id'], viewport['id'])
        self.assert_blocked(identifier, transferred)

    def test_undo_restores_viewport_identity_without_restoring_confirmation(self):
        viewport = self.viewport()
        identifier = self.case.create(measurement={'method': 'calibrated', 'calibration_id': viewport['id']})
        self.case.command('confirm_items', item_ids=[identifier])
        self.case.apply(self.case.preview(identifier))
        original = deepcopy(self.item(identifier))
        self.case.command('delete_viewport', calibration_id=viewport['id'])
        deletion_head = self.case.state['snapshot']['audit_head']
        self.case.command('undo')
        state = self.case.state['snapshot']; restored = self.item(identifier)
        self.assertIn(viewport, active_calibrations(state))
        self.assertEqual(restored['measurement'], original['measurement'])
        self.assertEqual(restored['member_ids'], original['member_ids'])
        self.assertGreater(restored['version'], original['version'])
        self.assertEqual(restored['state'], 'draft'); self.assertIsNone(restored['confirmation'])
        self.assertEqual(state['transfers'][0]['status'], 'stale')
        self.assertEqual(self.case.documents.get_blob(state['audit_head'])['previous'], deletion_head)
        self.assertEqual(self.case.documents.get_blob(deletion_head)['op'], 'delete_viewport')
        self.assertFalse(item_result(restored, state)['issues'])
        with self.assertRaises(ValidationError):
            self.case.service.export(self.case.sid, 'csv', [identifier])
        self.case.command('confirm_items', item_ids=[identifier])
        self.assertEqual(self.item(identifier)['state'], 'confirmed')

    def test_removed_scope_requires_explicit_page_scale_reselection_and_leaves_outside_receipt_exact(self):
        affected = self.case.create()
        outside = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1,
                                              'points': [[150, 30], [200, 30]]})
        self.case.command('confirm_items', item_ids=[affected, outside])
        original_outside = deepcopy(self.item(outside))
        outside_digest = item_digest(original_outside, self.case.state['snapshot'])
        previous_measurement = deepcopy(self.item(affected)['measurement'])
        viewport = self.viewport()
        self.assert_blocked(affected)
        self.case.command('delete_viewport', calibration_id=viewport['id'])
        self.assertIsNone(self.item(affected)['measurement'])
        self.assert_blocked(affected)
        self.assertEqual(self.item(outside), original_outside)
        self.assertEqual(item_digest(self.item(outside), self.case.state['snapshot']), outside_digest)
        event = self.case.documents.get_blob(self.case.state['snapshot']['audit_head'])
        self.assertEqual(event['before']['items'][0]['measurement'], previous_measurement)
        self.assertIsNone(event['after']['items'][0]['measurement'])
        self.case.command('update_item', item_id=affected, changes={'measurement': previous_measurement})
        self.assertEqual(self.item(affected)['state'], 'draft')
        self.case.command('confirm_items', item_ids=[affected])
        self.assertEqual(self.case.state['item_results'][0]['length_m'], 10)

    def test_stale_invalid_page_scale_and_retired_delete_targets_fail_atomically(self):
        viewport = self.viewport()
        self.case.command('update_calibration', calibration_id=viewport['id'], changes={'scale_denominator': 50})
        revised = deepcopy(self.case.state['snapshot']['calibrations'][-1])
        for identifier in (self.case.calibration_id, viewport['id'], str(uuid4()), 'bad-id'):
            before = deepcopy(self.case.state['snapshot'])
            with self.subTest(identifier=identifier), self.assertRaises(ValidationError):
                self.case.command('delete_viewport', calibration_id=identifier)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        with self.assertRaisesRegex(ValidationError, 'changed'):
            self.case.service.command(self.case.sid, {'op': 'delete_viewport', 'calibration_id': revised['id'],
                'request_id': str(uuid4()), 'expected_revision': self.case.state['revision']-1})
        self.case.command('delete_viewport', calibration_id=revised['id'])
        tombstone = self.case.state['snapshot']['calibrations'][-1]
        before = deepcopy(self.case.state['snapshot'])
        for identifier in (revised['id'], tombstone['id']):
            with self.assertRaises(ValidationError):
                self.case.command('delete_viewport', calibration_id=identifier)
            with self.assertRaises(ValidationError):
                self.case.command('update_calibration', calibration_id=identifier, changes={'scale_denominator': 25})
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_snapshot_tombstones_cannot_alter_original_basis_or_reactivate_chain(self):
        viewport = self.viewport()
        self.case.command('delete_viewport', calibration_id=viewport['id'])
        snapshot = deepcopy(self.case.state['snapshot'])
        self.assertEqual(validate_snapshot(snapshot), snapshot)
        for changes in ({'deleted': False}, {'deleted': 1}, {'name': 'Different evidence'},
                        {'region': [10, 20, 110, 99]}, {'scale_denominator': 50}):
            forged = deepcopy(snapshot); forged['calibrations'][-1].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                validate_snapshot(forged)
        forged = deepcopy(snapshot); del forged['calibrations'][-1]['supersedes_id']
        with self.assertRaises(ValidationError):
            validate_snapshot(forged)
        forged = deepcopy(snapshot)
        forged['calibrations'].append({**viewport, 'id': str(uuid4()),
                                       'supersedes_id': snapshot['calibrations'][-1]['id']})
        with self.assertRaisesRegex(ValidationError, 'immutable chain'):
            validate_snapshot(forged)
        with self.assertRaises(ValidationError):
            self.case.command('add_calibration', calibration={**viewport, 'id': str(uuid4()), 'deleted': True})

    def test_area_geometry_and_draft_physical_graph_survive_retirement_and_undo(self):
        from tests.test_takeoff_area import TakeoffAreaTests
        from tests.test_takeoff_physical_workspace import Images, PhysicalWorkspaceTests
        area = TakeoffAreaTests(); area.case = self.case
        viewport = self.viewport([10, 20, 130, 90])
        proposal = area.proposal(); proposal['measurement']['calibration_id'] = viewport['id']
        identifier = area.create(proposal)
        self.case.command('confirm_items', item_ids=[identifier])
        original_geometry = deepcopy(self.item(identifier)['geometry'])
        physical = PhysicalWorkspaceTests(); physical.case = self.case
        physical.service, physical.sid = self.case.service, self.case.sid
        self.case.documents.images = Images()
        self.case.state, _ = physical.apply([physical.barrier()])
        graph = deepcopy(self.case.state['snapshot']['physical'])
        self.case.command('delete_viewport', calibration_id=viewport['id'])
        self.assertEqual(self.case.state['snapshot']['physical'], graph)
        self.assertEqual(self.item(identifier)['geometry'], original_geometry)
        self.assertIsNone(item_result(self.item(identifier), self.case.state['snapshot'])['net_area_m2'])
        self.assertEqual(self.item(identifier)['state'], 'draft')
        with self.assertRaises(ValidationError):
            self.case.service.export(self.case.sid, 'xlsx', [identifier])
        self.case.command('undo')
        self.assertEqual(self.case.state['snapshot']['physical'], graph)
        self.assertEqual(self.item(identifier)['geometry'], original_geometry)
        self.assertEqual(self.item(identifier)['state'], 'draft')


class TakeoffViewportDeleteProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def test_save_as_reopen_preserves_retirement_audit_legacy_values_and_recoverable_undo(self):
        case = project_fixtures.TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        def command(op, **values):
            case.session = case.service.command(case.session['session_id'], {'op': op, 'request_id': str(uuid4()),
                                      'expected_revision': case.session['revision'], **values})
        document = case.session['snapshot']['documents'][0]
        command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
        calibration, item_id = str(uuid4()), str(uuid4())
        command('add_calibration', calibration={'id': calibration, 'document_id': document['id'], 'page': 1,
                'name': 'Detail viewport', 'points': [[50, 50], [150, 50]], 'region': [50, 50, 200, 200],
                'scale_denominator': 100, 'uniform_scale': True})
        command('create_item', item={'id': item_id, 'mode': 'duct', 'quantity': 1,
                'geometry': {'document_id': document['id'], 'page': 1, 'points': [[50, 60], [150, 60]]},
                'measurement': {'method': 'calibrated', 'calibration_id': calibration},
                'fields': {'shape': 'rectangular', 'width_mm': 600, 'height_mm': 400, 'frl': '120/120/120', 'orientation': 'Horizontal'},
                'evidence': []})
        command('confirm_items', item_ids=[item_id])
        command('delete_viewport', calibration_id=calibration)
        snapshot = deepcopy(case.session['snapshot'])
        case.library.save_as({**deepcopy(case.base), 'takeoffs': snapshot, 'takeoffs_session_id': case.session['session_id']})
        original_bytes = case.target.read_bytes(); saved = json.loads(original_bytes)
        for key in ('estimate', 'calculators'):
            self.assertEqual(saved[key], json.loads(case.legacy)[key])
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        self.assertEqual(opened['takeoffs_issues'], [])
        for key in ('items', 'calibrations', 'audit_head'):
            self.assertEqual(opened['takeoffs'][key], snapshot[key])
        self.assertEqual(item_digest(opened['takeoffs']['items'][0], opened['takeoffs']),
                         item_digest(snapshot['items'][0], snapshot))
        self.assertIsNone(item_result(opened['takeoffs']['items'][0], opened['takeoffs'])['length_m'])
        second = case.root / 'copied' / 'copy.json'; second.parent.mkdir()
        case.dialogs.selection = SaveSelection(str(second), None)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': opened['takeoffs'], 'takeoffs_session_id': opened['takeoffs_session_id']})
        self.assertEqual(case.target.read_bytes(), original_bytes)
        case.dialogs.opened = str(second); final = case.library.open_file()
        self.assertEqual(final['takeoffs_issues'], [])
        for key in ('items', 'calibrations', 'audit_head'):
            self.assertEqual(final['takeoffs'][key], snapshot[key])
        sources = list((second.parent / final['takeoffs']['companion_folder']).rglob('*.pdf'))
        self.assertTrue(sources); self.assertTrue(any(source.read_bytes() == case.pdf for source in sources))
        case.session = case.service.get(final['takeoffs_session_id'])
        with self.assertRaises(ValidationError):
            command('confirm_items', item_ids=[item_id])
        command('undo')
        self.assertEqual(case.session['snapshot']['calibrations'], snapshot['calibrations'][:-1])
        self.assertEqual(case.session['snapshot']['items'][0]['state'], 'draft')
        self.assertEqual(case.session['snapshot']['items'][0]['measurement']['calibration_id'], calibration)
        command('confirm_items', item_ids=[item_id])
        self.assertEqual(case.session['snapshot']['items'][0]['state'], 'confirmed')


if __name__ == '__main__':
    unittest.main()
