"""Vertex edits retain source identity and fail atomically at geometry boundaries."""
from copy import deepcopy
import json
import math
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.takeoff_model import MAX_POINTS, item_digest, item_result, validate_snapshot
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_area as area_fixtures
from tests import test_takeoff_project as project_fixtures


class TakeoffControlPointTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def geometry(self, points):
        return {'document_id': self.case.doc['id'], 'page': 1, 'points': points}

    def remove_point(self, identifier, index, exclusion=None):
        geometry = deepcopy(self.item(identifier)['geometry'])
        ring = geometry['points'] if exclusion is None else geometry['exclusions'][exclusion]['points']
        del ring[index]
        return self.case.command('update_item', item_id=identifier, changes={'geometry': geometry})

    def assert_rejected(self, identifier, changes, message=None):
        before = deepcopy(self.case.state['snapshot'])
        blobs = deepcopy(self.case.documents.blobs)
        with self.assertRaisesRegex(ValidationError, message or '.'):
            self.case.command('update_item', item_id=identifier, changes=changes)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(self.case.documents.blobs, blobs, 'Rejected geometry must not publish audit state.')

    def surface(self, points=None, exclusions=None):
        helper = area_fixtures.TakeoffAreaTests(); helper.case = self.case
        proposed = helper.proposal()
        if points is not None: proposed['geometry']['points'] = points
        if exclusions is not None: proposed['geometry']['exclusions'] = exclusions
        self.case.command('create_item', item=proposed)
        return self.case.state['snapshot']['items'][-1]['id']

    def test_delete_bend_recomputes_full_precision_per_member_length_and_preserves_identity(self):
        points = [[10.1234567890123, 30.9876543210987], [45.8765432109876, 80.1234567890123],
                  [110.246913578025, 40.1111111111111]]
        additions = [{'id': str(uuid4()), 'kind': 'riser', 'length_mm': 750.1234567890123,
                      'document_id': self.case.doc['id'], 'page': 1, 'note': 'Section A explicit rise'}]
        identifier = self.case.create(geometry=self.geometry(points), quantity=3, length_additions=additions,
                                      appearance={'stroke_color': '#AB1245', 'stroke_width': 3.75})
        self.case.confirm(identifier)
        transferred = self.case.preview(identifier); self.case.apply(transferred)
        before = deepcopy(self.case.state['snapshot']); old = deepcopy(self.item(identifier))
        receipt = old['confirmation']; original_length = item_result(old, before)['total_length_m']
        self.remove_point(identifier, 1)
        current = self.item(identifier); result = item_result(current, self.case.state['snapshot'])
        expected_base = math.hypot(points[2][0]-points[0][0], points[2][1]-points[0][1]) * 10 / 100
        expected_length = expected_base + additions[0]['length_mm']/1000
        self.assertEqual(result['base_length_m'], expected_base)
        self.assertEqual(result['length_m'], expected_length)
        self.assertEqual(result['total_length_m'], expected_length*3)
        self.assertNotEqual(result['length_m'], round(result['length_m'], 2))
        self.assertLess(result['total_length_m'], original_length)
        self.assertEqual(current['geometry'], self.geometry([points[0], points[2]]))
        for key in ('id', 'mode', 'quantity', 'member_ids', 'measurement', 'fields', 'evidence', 'length_additions', 'appearance'):
            self.assertEqual(current[key], old[key], key)
        self.assertEqual(current['version'], old['version']+1)
        self.assertEqual(current['state'], 'draft'); self.assertIsNone(current['review']); self.assertIsNone(current['confirmation'])
        self.assertEqual(self.case.state['snapshot']['revision'], before['revision']+1)
        self.assertEqual(self.case.state['snapshot']['transfers'], [{**binding, 'status': 'stale'} for binding in before['transfers']])
        self.assertNotIn('calculator', self.case.state, 'Geometry edits do not apply calculator changes.')
        with self.case.store.connect() as db:
            retained = db.execute('SELECT receipt FROM takeoff_approvals WHERE receipt_id=?', (receipt['id'],)).fetchone()
        self.assertEqual(json.loads(retained[0]), receipt)
        audit = self.case.documents.get_blob(self.case.state['snapshot']['audit_head'])
        self.assertEqual(audit['before']['items'], before['items'])
        self.assertIn(identifier, audit['affected_ids']['items'])
        self.case.command('undo')
        restored = self.item(identifier)
        self.assertEqual(restored['geometry'], old['geometry']); self.assertEqual(restored['member_ids'], old['member_ids'])
        self.assertGreater(restored['version'], current['version'])
        self.assertIsNone(restored['confirmation']); self.assertEqual(restored['state'], 'draft')
        self.assertTrue(all(binding['status'] == 'stale' for binding in self.case.state['snapshot']['transfers']))
        before_add = deepcopy(self.case.state['snapshot'])
        unchanged = self.case.preview(identifier, inputs=transferred['inputs'], rows=transferred['schedule_rows'])
        self.assertIsNone(unchanged['preview_id'])
        self.assertEqual(unchanged['changes'], []); self.assertEqual(unchanged['bindings'], [])
        binding = before_add['transfers'][0]
        self.assertEqual(unchanged['skipped'], [{'item_id': identifier, 'calculator_id': binding['calculator_id'],
            'row': binding['row'], 'binding_id': binding['id'], 'status': 'stale', 'reason': 'already_linked'}])
        self.assertEqual(unchanged['inputs'], transferred['inputs'])
        self.assertEqual(unchanged['schedule_rows'], transferred['schedule_rows'])
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before_add)
        # Add retains this linked row; explicitly updating it still requires a fresh confirmation.
        with self.assertRaises(ValidationError):
            self.case.preview(identifier, inputs=transferred['inputs'], rows=transferred['schedule_rows'], update=True)
        self.case.command('confirm_items', item_ids=[identifier])
        self.assertNotEqual(self.item(identifier)['confirmation']['id'], receipt['id'])

    def test_duct_endpoint_deletion_keeps_dimension_basis_and_run_identity(self):
        identifier = self.case.create(mode='duct', quantity=1,
            geometry=self.geometry([[20, 30], [60, 60], [140, 60]]))
        original = deepcopy(self.item(identifier)); self.case.confirm(identifier)
        self.remove_point(identifier, 0)
        current = self.item(identifier)
        self.assertEqual(item_result(current, self.case.state['snapshot'])['total_length_m'], 8)
        self.assertEqual(current['fields'], original['fields']); self.assertEqual(current['measurement'], original['measurement'])
        self.assertEqual(current['id'], identifier); self.assertEqual(current['member_ids'], original['member_ids'])
        self.assertIsNone(current['confirmation'])

    def test_minimum_malformed_outside_crop_and_maximum_point_edits_are_atomic(self):
        identifier = self.case.create(); self.case.confirm(identifier)
        for points in ([], [[10, 30]], [[10, 30], [9, 30]], [[10, 30], [110, 121]],
                       [[10, 30], [math.inf, 30]], [[10, 30], [True, 40]], [[10, 30], [20]],
                       [[10, 30], 'bad'], [[10, 30]]*(MAX_POINTS+1)):
            with self.subTest(points=str(points)[:100]):
                self.assert_rejected(identifier, {'geometry': self.geometry(points)})
        self.assert_rejected(identifier, {'geometry': 'bad'})
        self.assert_rejected(identifier, {'geometry': {'points': [[10, 30], [110, 30]]}})

    def test_deleting_bend_cannot_collapse_calibrated_path_to_identical_endpoints(self):
        identifier = self.case.create(geometry=self.geometry([[20, 40], [80, 60], [20, 40]]))
        self.case.confirm(identifier)
        self.assert_rejected(identifier, {'geometry': self.geometry([[20, 40], [20, 40]])}, 'distinct points')
        self.assert_rejected(identifier, {'geometry': self.geometry([[20, 40], [50, 40], [50, 40], [80, 40]])}, 'distinct points')

    def test_cited_region_cannot_lose_its_second_point_or_silently_change_basis(self):
        identifier = self.case.create(geometry=self.geometry([[20, 30], [80, 70]]),
            measurement={'method': 'cited', 'length_m': 7.123456789012345, 'citation': 'Section B height'})
        self.case.confirm(identifier); old = deepcopy(self.item(identifier))
        self.assert_rejected(identifier, {'geometry': self.geometry([[20, 30]])}, 'two control points')
        self.assertEqual(self.item(identifier), old)
        self.assertEqual(item_result(old, self.case.state['snapshot'])['length_m'], 7.123456789012345)

    def test_removing_a_bend_cannot_cross_another_viewport_scale(self):
        self.case.command('add_calibration', calibration={'id': str(uuid4()), 'document_id': self.case.doc['id'],
            'page': 1, 'name': 'Inset', 'region': [60, 50, 40, 40], 'points': [[60, 50], [100, 50]],
            'distance_m': 2, 'uniform_scale': True})
        points = [[20, 60], [20, 110], [130, 110], [130, 60]]
        identifier = self.case.create(geometry=self.geometry(points)); self.case.confirm(identifier)
        self.assert_rejected(identifier, {'geometry': self.geometry([points[0], points[2], points[3]])}, 'viewport')

    def test_outer_vertex_deletion_recomputes_area_and_preserves_exclusion_ids(self):
        identifier = self.surface(points=[[20, 30], [120, 30], [140, 55], [120, 80], [20, 80]])
        self.case.confirm(identifier); old = deepcopy(self.item(identifier))
        old_result = item_result(old, self.case.state['snapshot'])
        self.assertEqual(old_result['gross_area_m2'], 55)
        self.remove_point(identifier, 2)
        current = self.item(identifier); result = item_result(current, self.case.state['snapshot'])
        self.assertEqual(result['gross_area_m2'], 50); self.assertEqual(result['excluded_area_m2'], 2)
        self.assertEqual(result['net_area_m2'], 48)
        self.assertEqual(current['geometry']['exclusions'], old['geometry']['exclusions'])
        self.assertEqual(current['measurement'], old['measurement']); self.assertEqual(current['evidence'], old['evidence'])
        self.assertIsNone(current['confirmation'])
        self.case.command('undo')
        self.assertEqual(self.item(identifier)['geometry'], old['geometry'])
        self.assertIsNone(self.item(identifier)['confirmation'])

    def test_exclusion_vertex_deletion_retains_hole_identity_and_recomputes_net_area(self):
        identifier = self.surface(); self.case.confirm(identifier); old = deepcopy(self.item(identifier))
        self.remove_point(identifier, 1, exclusion=0)
        current = self.item(identifier); result = item_result(current, self.case.state['snapshot'])
        self.assertEqual(result['gross_area_m2'], 50); self.assertEqual(result['excluded_area_m2'], 1)
        self.assertEqual(result['net_area_m2'], 49)
        self.assertEqual(current['geometry']['points'], old['geometry']['points'])
        self.assertEqual(current['geometry']['exclusions'][0]['id'], old['geometry']['exclusions'][0]['id'])
        self.assertEqual(current['geometry']['exclusions'][0]['note'], old['geometry']['exclusions'][0]['note'])
        self.assertIsNone(current['confirmation'])
        invalid = deepcopy(current['geometry']); del invalid['exclusions'][0]['points'][0]
        self.assert_rejected(identifier, {'geometry': invalid}, '3 to')

    def test_polygon_minimum_self_crossing_and_exposed_hole_fail_atomically(self):
        triangle = self.surface(points=[[20, 30], [120, 30], [20, 80]], exclusions=[])
        geometry = deepcopy(self.item(triangle)['geometry']); del geometry['points'][0]
        self.assert_rejected(triangle, {'geometry': geometry}, '3 to')
        bent = self.surface(points=[[20, 30], [100, 30], [100, 90], [70, 90],
                                    [70, 50], [50, 50], [50, 90], [20, 90]], exclusions=[])
        geometry = deepcopy(self.item(bent)['geometry']); del geometry['points'][1]
        self.assert_rejected(bent, {'geometry': geometry})
        with_hole = self.surface(); geometry = deepcopy(self.item(with_hole)['geometry']); del geometry['points'][0]
        self.assert_rejected(with_hole, {'geometry': geometry}, 'exclusion')

    def test_legacy_single_point_drafts_load_and_allow_unrelated_edits(self):
        for measurement in ({'method': 'calibrated', 'calibration_id': self.case.calibration_id},
                            {'method': 'cited', 'length_m': 3, 'citation': 'Legacy single-point reference'}):
            identifier = self.case.create(geometry=self.geometry([[20, 40]]), measurement=measurement)
            state = deepcopy(self.case.state['snapshot'])
            self.assertEqual(validate_snapshot(state), state)
            reopened = self.case.service.open(state, source_path='legacy-project.json')
            request = {'op': 'update_item', 'item_id': identifier, 'changes': {'fields': {'notes': 'Retained legacy draft'},
                        'appearance': {'stroke_color': '#AABBCC'}}, 'request_id': str(uuid4()), 'expected_revision': reopened['revision']}
            edited = self.case.service.command(reopened['session_id'], request)
            item = next(item for item in edited['snapshot']['items'] if item['id'] == identifier)
            self.assertEqual(item['geometry']['points'], [[20, 40]])
            self.assertEqual(item['measurement'], measurement); self.assertEqual(item['fields']['notes'], 'Retained legacy draft')
            roundtrip = {'op': 'update_item', 'item_id': identifier, 'changes': {'geometry': deepcopy(item['geometry']),
                         'fields': {'notes': 'Same legacy geometry roundtrip'}}, 'request_id': str(uuid4()),
                         'expected_revision': edited['revision']}
            roundtripped = self.case.service.command(reopened['session_id'], roundtrip)
            invalid = {'op': 'update_item', 'item_id': identifier, 'changes': {'geometry': self.geometry([[21, 40]])},
                       'request_id': str(uuid4()), 'expected_revision': roundtripped['revision']}
            with self.assertRaisesRegex(ValidationError, 'two control points'):
                self.case.service.command(reopened['session_id'], invalid)
            self.assertEqual(self.case.service.get(reopened['session_id'])['snapshot'], roundtripped['snapshot'])
            repaired = self.case.service.command(reopened['session_id'], {**invalid, 'request_id': str(uuid4()),
                'changes': {'geometry': self.geometry([[20, 40], [30, 40]])}})
            restored = next(item for item in repaired['snapshot']['items'] if item['id'] == identifier)
            self.assertEqual(restored['measurement'], measurement)
            self.assertEqual(restored['geometry']['points'], [[20, 40], [30, 40]])
        identifier = self.case.create()
        self.case.command('update_item', item_id=identifier, changes={'geometry': None, 'measurement': None})
        self.assertIsNone(self.item(identifier)['geometry']); self.assertEqual(self.item(identifier)['id'], identifier)


class TakeoffControlPointProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): project_fixtures.TakeoffProjectTests.setUpClass()

    def test_vertex_edit_save_as_reopen_retains_precision_sources_and_frozen_values(self):
        case = project_fixtures.TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        def command(op, **values):
            case.session = case.service.command(case.session['session_id'], {'op': op, 'request_id': str(uuid4()),
                'expected_revision': case.session['revision'], **values})
        document = case.session['snapshot']['documents'][0]; calibration = str(uuid4()); identifier = str(uuid4())
        command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
        command('add_calibration', calibration={'id': calibration, 'document_id': document['id'], 'page': 1,
            'points': [[50, 50], [150, 50]], 'distance_m': 3.123456789012345, 'uniform_scale': True,
            'name': 'Retained scale', 'region': [50, 50, 300, 300]})
        points = [[50.1234567890123, 100.1234567890123], [150.3456789012345, 200.3456789012345],
                  [250.9876543210987, 110.9876543210987]]
        command('create_item', item={'id': identifier, 'mode': 'steel', 'quantity': 3,
            'geometry': {'document_id': document['id'], 'page': 1, 'points': points},
            'measurement': {'method': 'calibrated', 'calibration_id': calibration},
            'fields': {'mark': 'CP-01', 'member_type': 'Beam', 'section': '100UC15',
                       'exposure': 'Re-entrant - 3 sides', 'fire_period_min': 120},
            'appearance': {'stroke_color': '#AABBCC', 'stroke_width': 2.75},
            'evidence': [{'document_id': document['id'], 'page': 1, 'note': 'Plan bend and elevation dimension'}],
            'length_additions': [{'id': str(uuid4()), 'kind': 'drop', 'length_mm': 1234.56789012345,
                                 'note': 'Elevation drop', 'document_id': document['id'], 'page': 1}]})
        command('confirm_items', item_ids=[identifier])
        old = deepcopy(case.session['snapshot']['items'][0]); old_confirmation = old['confirmation']
        geometry = deepcopy(old['geometry']); del geometry['points'][1]
        command('update_item', item_id=identifier, changes={'geometry': geometry})
        snapshot = deepcopy(case.session['snapshot']); expected_digest = item_digest(snapshot['items'][0], snapshot)
        expected_result = item_result(snapshot['items'][0], snapshot)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': snapshot, 'takeoffs_session_id': case.session['session_id']})
        saved = json.loads(case.target.read_bytes()); legacy = json.loads(case.legacy)
        self.assertEqual(saved['version'], 2)
        for key in ('estimate', 'calculators'): self.assertEqual(saved[key], legacy[key])
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        self.assertEqual(opened['takeoffs_issues'], [])
        self.assertEqual(opened['takeoffs']['items'], snapshot['items'])
        self.assertEqual(opened['takeoffs']['audit_head'], snapshot['audit_head'])
        self.assertEqual(opened['takeoffs']['calibrations'], snapshot['calibrations'])
        item = opened['takeoffs']['items'][0]
        self.assertEqual(item['geometry']['points'], [points[0], points[2]])
        self.assertEqual(item['member_ids'], old['member_ids']); self.assertIsNone(item['confirmation'])
        self.assertEqual(item_digest(item, opened['takeoffs']), expected_digest)
        self.assertEqual(item_result(item, opened['takeoffs']), expected_result)
        second = case.root / 'second' / 'copy.json'; second.parent.mkdir()
        case.dialogs.selection = SaveSelection(str(second), None)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': opened['takeoffs'], 'takeoffs_session_id': opened['takeoffs_session_id']})
        case.dialogs.opened = str(second); copied = case.library.open_file()
        self.assertEqual(copied['takeoffs']['items'], snapshot['items'])
        self.assertEqual(copied['takeoffs']['documents'], snapshot['documents'])
        source = next((second.parent / copied['takeoffs']['companion_folder']).rglob('*.pdf'))
        self.assertEqual(source.read_bytes(), case.pdf)
        with case.store.connect() as db:
            retained = db.execute('SELECT receipt FROM takeoff_approvals WHERE receipt_id=?', (old_confirmation['id'],)).fetchone()
        self.assertEqual(json.loads(retained[0]), old_confirmation)


if __name__ == '__main__': unittest.main()
