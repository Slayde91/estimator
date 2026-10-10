"""Control-point movement and whole-markup deletion preserve source authority."""
from copy import deepcopy
from hashlib import sha256
import json
import math
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import item_digest, item_result
from tests import test_takeoff_area as area_fixtures
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_workspace as fixtures


class TakeoffGeometryEditingTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def result(self, identifier):
        return next(result for result in self.case.state['item_results'] if result['id'] == identifier)

    def move_point(self, identifier, index, point, exclusion=None):
        geometry = deepcopy(self.item(identifier)['geometry'])
        ring = geometry['points'] if exclusion is None else geometry['exclusions'][exclusion]['points']
        ring[index] = point
        return self.case.command('update_item', item_id=identifier, changes={'geometry': geometry})

    def surface(self, mode='wall', **geometry):
        helper = area_fixtures.TakeoffAreaTests(); helper.case = self.case
        proposed = helper.proposal(mode); proposed['geometry'].update(geometry)
        proposed['appearance'] = {'stroke_color': '#A123B4', 'fill_color': '#F0E0D0', 'opacity': 0.65}
        self.case.command('create_item', item=proposed)
        return self.case.state['snapshot']['items'][-1]['id']

    def assert_move_rejected(self, identifier, index, point, exclusion=None, message='.'):
        before = deepcopy(self.case.state['snapshot']); blobs = deepcopy(self.case.documents.blobs)
        with self.assertRaisesRegex(ValidationError, message):
            self.move_point(identifier, index, point, exclusion)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(self.case.documents.blobs, blobs, 'A rejected drag must not publish an audit event.')

    def test_moving_steel_bend_recalculates_exact_per_member_length_and_invalidates_only_that_item(self):
        points = [[20.1234567890123, 35.9876543210987], [70.246913578025, 80.1234567890123],
                  [160.876543210987, 45.1111111111111]]
        additions = [{'id': str(uuid4()), 'kind': 'riser', 'length_mm': 1234.56789012345,
                      'note': 'Elevation A stated rise', 'document_id': self.case.doc['id'], 'page': 1}]
        identifier = self.case.create(quantity=3, length_additions=additions,
            geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': points},
            appearance={'stroke_color': '#AABBCC', 'stroke_width': 3.125})
        untouched = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1,
                                               'points': [[150, 100], [190, 100]]})
        self.case.command('confirm_items', item_ids=[identifier, untouched])
        self.case.apply(self.case.preview(identifier))
        calculator = deepcopy(self.case.state['calculator']); before = deepcopy(self.case.state['snapshot'])
        old = deepcopy(self.item(identifier)); other = deepcopy(self.item(untouched))
        moved = [85.9876543210987, 106.234567890123]
        self.move_point(identifier, 1, moved)
        current = self.item(identifier); result = self.result(identifier)
        expected_points = [points[0], moved, points[2]]
        expected_base = math.fsum(math.hypot(b[0]-a[0], b[1]-a[1])
                                  for a, b in zip(expected_points, expected_points[1:])) * 10 / 100
        self.assertEqual(result['base_length_m'], expected_base)
        self.assertEqual(result['length_m'], expected_base + additions[0]['length_mm']/1000)
        self.assertEqual(result['total_length_m'], result['length_m']*3)
        self.assertEqual(result['issues'], [])
        self.assertNotEqual(result['length_m'], round(result['length_m'], 2))
        self.assertEqual(current['geometry']['points'], expected_points)
        for key in ('id', 'mode', 'measurement', 'quantity', 'member_ids', 'fields', 'evidence', 'length_additions', 'appearance'):
            self.assertEqual(current[key], old[key], key)
        self.assertEqual(current['version'], old['version']+1)
        self.assertIsNone(current['confirmation']); self.assertIsNone(current['review'])
        self.assertEqual(current['state'], 'draft'); self.assertEqual(self.item(untouched), other)
        self.assertNotEqual(item_digest(current, self.case.state['snapshot']), old['confirmation']['digest'])
        self.assertEqual(self.case.state['snapshot']['transfers'], [{**link, 'status': 'stale'} for link in before['transfers']])
        self.assertNotIn('calculator', self.case.state)
        self.assertEqual(calculator['inputs']['SCHEDULE']['I10'], 3)
        self.assertEqual(calculator['inputs']['SCHEDULE']['J10'], item_result(old, before)['length_m'])
        with self.assertRaises(ValidationError):
            self.case.preview(identifier, inputs=calculator['inputs'], rows=calculator['schedule_rows'], update=True)

    def test_duct_endpoint_move_keeps_centreline_dimensions_and_explicit_drop(self):
        identifier = self.case.create(mode='duct', quantity=1,
            geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[20, 30], [60, 60], [140, 60]]},
            length_additions=[{'id': str(uuid4()), 'kind': 'drop', 'length_mm': 750,
                               'document_id': self.case.doc['id'], 'page': 1, 'note': 'Section drop'}])
        self.case.confirm(identifier); old = deepcopy(self.item(identifier))
        self.move_point(identifier, 2, [100, 90])
        self.assertEqual(self.result(identifier)['base_length_m'], 10)
        self.assertEqual(self.result(identifier)['length_m'], 10.75)
        self.assertEqual(self.result(identifier)['total_length_m'], 10.75)
        self.assertEqual(self.item(identifier)['fields'], old['fields'])
        self.assertEqual(self.item(identifier)['measurement'], old['measurement'])
        self.assertEqual(self.item(identifier)['member_ids'], old['member_ids'])
        self.assertIsNone(self.item(identifier)['confirmation'])

    def test_rotated_cropped_preset_page_moves_use_source_coordinates_and_user_unit_once(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                document = fixtures.document(); document['pages'][0]['rotation'] = rotation
                document['sha256'] = sha256(f'Synthetic rotation {rotation}'.encode()).hexdigest()
                self.case.state = self.case.service.add_document(self.case.sid, document, self.case.state['revision'])
                self.case.command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
                calibration = str(uuid4())
                self.case.command('add_calibration', calibration={'id': calibration, 'document_id': document['id'],
                    'page': 1, 'name': 'Printed 1:100', 'points': [[10, 20], [110, 20]],
                    'scale_denominator': 100, 'uniform_scale': True})
                identifier = self.case.create(measurement={'method': 'calibrated', 'calibration_id': calibration},
                    geometry={'document_id': document['id'], 'page': 1, 'points': [[20, 30], [80, 30]]})
                self.move_point(identifier, 1, [80, 110])
                expected = 100 * 2 * (0.0254/72) * 100
                self.assertAlmostEqual(self.result(identifier)['length_m'], expected, places=12)
                self.assertEqual(self.item(identifier)['geometry']['points'], [[20, 30], [80, 110]])
                self.assertEqual(self.item(identifier)['measurement']['calibration_id'], calibration)

    def test_wall_outer_corner_move_recomputes_gross_and_net_but_keeps_exclusions_and_evidence(self):
        identifier = self.surface(); self.case.confirm(identifier)
        before = deepcopy(self.item(identifier))
        self.move_point(identifier, 2, [140, 100])
        self.assertEqual(self.result(identifier), {'id': identifier, 'gross_area_m2': 65,
            'excluded_area_m2': 2, 'net_area_m2': 63, 'layers': 1, 'total_area_m2': 63, 'issues': []})
        current = self.item(identifier)
        self.assertEqual(current['geometry']['exclusions'], before['geometry']['exclusions'])
        for key in ('id', 'measurement', 'quantity', 'member_ids', 'fields', 'evidence', 'appearance'):
            self.assertEqual(current[key], before[key], key)
        self.assertIsNone(current['confirmation'])
        self.case.command('undo')
        self.assertEqual(self.item(identifier)['geometry'], before['geometry'])
        self.assertEqual(self.result(identifier)['net_area_m2'], 48)
        self.assertIsNone(self.item(identifier)['confirmation'])

    def test_slab_exclusion_corner_move_recomputes_net_without_moving_outer_surface(self):
        identifier = self.surface('slab'); self.case.confirm(identifier)
        original = deepcopy(self.item(identifier))
        self.move_point(identifier, 2, [70, 60], exclusion=0)
        self.assertEqual(self.result(identifier), {'id': identifier, 'gross_area_m2': 50,
            'excluded_area_m2': 3.5, 'net_area_m2': 46.5, 'layers': 1, 'total_area_m2': 46.5, 'issues': []})
        current = self.item(identifier)
        self.assertEqual(current['geometry']['points'], original['geometry']['points'])
        for key in ('id', 'note'):
            self.assertEqual(current['geometry']['exclusions'][0][key], original['geometry']['exclusions'][0][key])
        self.assertEqual(current['evidence'], original['evidence']); self.assertIsNone(current['confirmation'])

    def test_invalid_line_drag_keeps_confirmations_links_and_audit_atomic(self):
        identifier = self.case.create(); self.case.confirm(identifier); self.case.apply(self.case.preview(identifier))
        for point in ([10, 30], [9, 30], [211, 30], [110, 121], [math.nan, 30], [110, math.inf], [True, 30], [110]):
            with self.subTest(point=point): self.assert_move_rejected(identifier, 1, point)

    def test_invalid_surface_and_exclusion_drags_cannot_cross_or_escape_boundaries(self):
        identifier = self.surface(); self.case.confirm(identifier)
        for index, point, exclusion in ((2, [10, 40], None), (2, [120, 30], None),
                                        (2, [220, 80], None), (2, [120, 50], 0),
                                        (2, [60, 40], 0), (2, [50, 35], 0)):
            with self.subTest(index=index, point=point, exclusion=exclusion):
                self.assert_move_rejected(identifier, index, point, exclusion)
        geometry = deepcopy(self.item(identifier)['geometry'])
        geometry['exclusions'].append({'id': str(uuid4()), 'note': 'Second opening',
            'points': [[80, 40], [100, 40], [100, 50], [80, 50]]})
        self.case.command('update_item', item_id=identifier, changes={'geometry': geometry})
        self.case.confirm(identifier)
        self.assert_move_rejected(identifier, 2, [90, 45], exclusion=0)

    def test_point_moves_cannot_leave_chosen_viewport_or_cut_through_another_scale(self):
        viewport = {'id': str(uuid4()), 'document_id': self.case.doc['id'], 'page': 1,
            'name': 'Detail', 'points': [[50, 50], [80, 50]], 'region': [50, 50, 30, 30],
            'distance_m': 1.5, 'uniform_scale': True}
        self.case.command('add_calibration', calibration=viewport)
        route = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1,
            'points': [[20, 30], [120, 30], [120, 90]]})
        self.case.confirm(route)
        self.assert_move_rejected(route, 1, [120, 70], message='viewport')
        detail = self.case.create(measurement={'method': 'calibrated', 'calibration_id': viewport['id']},
            geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[55, 55], [75, 55]]})
        self.case.confirm(detail)
        self.assert_move_rejected(detail, 1, [81, 75], message='viewport boundary')
        self.move_point(detail, 1, [75, 70])
        self.assertEqual(self.result(detail)['length_m'], 1.25)

    def test_cited_region_move_retains_stated_length_without_inferring_scale(self):
        identifier = self.case.create(quantity=1, measurement={'method': 'cited', 'length_m': 7.123456789012345,
            'citation': 'Elevation A dimension'},
            geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[20, 40], [50, 70]]})
        self.case.confirm(identifier); old = deepcopy(self.item(identifier))
        self.move_point(identifier, 1, [80, 90])
        self.assertEqual(self.result(identifier)['length_m'], 7.123456789012345)
        self.assertEqual(self.item(identifier)['measurement'], old['measurement'])
        self.assertIsNone(self.item(identifier)['confirmation'])

    def test_circular_duct_point_move_keeps_shape_and_remains_nontransferable(self):
        identifier = self.case.create(mode='duct', quantity=1)
        self.case.command('update_item', item_id=identifier,
            changes={'fields': {'shape': 'circular', 'diameter_mm': 315, 'width_mm': None, 'height_mm': None}})
        self.case.confirm(identifier)
        fields = deepcopy(self.item(identifier)['fields'])
        self.move_point(identifier, 1, [70, 110])
        self.assertEqual(self.result(identifier)['length_m'], 10)
        self.assertEqual(self.item(identifier)['fields'], fields)
        self.case.command('confirm_items', item_ids=[identifier])
        with self.assertRaisesRegex(ValidationError, 'Circular ducts'):
            self.case.preview(identifier, calculator_id='ductwork')

    def test_same_geometry_is_noop_and_stale_or_retried_drags_cannot_apply_twice(self):
        identifier = self.case.create(); self.case.confirm(identifier)
        old = deepcopy(self.item(identifier))
        self.case.command('update_item', item_id=identifier, changes={'geometry': deepcopy(old['geometry'])})
        self.assertEqual(self.item(identifier), old)
        geometry = deepcopy(old['geometry']); geometry['points'][1] = [130.1234567890123, 80.9876543210987]
        request = {'op': 'update_item', 'request_id': str(uuid4()), 'expected_revision': self.case.state['revision'],
            'item_id': identifier, 'changes': {'geometry': geometry}}
        self.case.state = self.case.service.command(self.case.sid, request)
        after = deepcopy(self.case.state)
        self.assertEqual(self.case.service.command(self.case.sid, request), after)
        with self.assertRaisesRegex(ValidationError, 'changed'):
            self.case.service.command(self.case.sid, {**request, 'request_id': str(uuid4())})
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], after['snapshot'])
        self.assertEqual(self.item(identifier)['version'], old['version']+1)

    def test_delete_whole_markup_retains_link_history_and_undo_requires_new_confirmation(self):
        identifier = self.case.create(); other_id = self.surface()
        self.case.command('confirm_items', item_ids=[identifier, other_id])
        self.case.apply(self.case.preview(identifier))
        calculator = deepcopy(self.case.state['calculator'])
        before = deepcopy(self.case.state['snapshot']); old = deepcopy(self.item(identifier)); other = deepcopy(self.item(other_id))
        self.case.command('delete_items', item_ids=[identifier])
        self.assertEqual(self.case.state['snapshot']['items'], [other])
        self.assertEqual(self.case.state['snapshot']['documents'], before['documents'])
        self.assertEqual(self.case.state['snapshot']['calibrations'], before['calibrations'])
        self.assertEqual(self.case.state['snapshot']['transfers'], [{**link, 'status': 'deleted'} for link in before['transfers']])
        self.assertNotIn('calculator', self.case.state)
        event = self.case.documents.get_blob(self.case.state['snapshot']['audit_head'])
        self.assertEqual(event['op'], 'delete_items')
        self.assertEqual(event['before'], {key: value for key, value in before.items() if key != 'audit_head'})
        self.assertEqual(event['previous'], before['audit_head'])
        with self.assertRaises(ValidationError): self.case.preview(identifier)
        self.case.command('undo')
        restored = self.item(identifier)
        for key in ('geometry', 'fields', 'member_ids', 'evidence', 'measurement'):
            self.assertEqual(restored[key], old[key], key)
        self.assertEqual(self.item(other_id), other)
        self.assertEqual(restored['state'], 'draft'); self.assertIsNone(restored['confirmation'])
        self.assertGreater(restored['version'], old['version'])
        self.assertEqual(self.case.state['snapshot']['transfers'], [{**link, 'status': 'stale'} for link in before['transfers']])
        self.assertNotIn('calculator', self.case.state)
        self.assertEqual(calculator['inputs']['SCHEDULE']['I10'], old['quantity'])
        self.assertEqual(calculator['inputs']['SCHEDULE']['J10'], 10)

    def test_whole_markup_deletion_rejects_mixed_missing_or_duplicate_ids_atomically(self):
        first = self.case.create(); second = self.surface('slab')
        self.case.command('confirm_items', item_ids=[first, second])
        before = deepcopy(self.case.state['snapshot']); blobs = deepcopy(self.case.documents.blobs)
        for identifiers in ([first, str(uuid4())], [first, first], [], 'all'):
            with self.subTest(identifiers=identifiers), self.assertRaises(ValidationError):
                self.case.command('delete_items', item_ids=identifiers)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
            self.assertEqual(self.case.documents.blobs, blobs)


class TakeoffGeometryEditingProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): project_fixtures.TakeoffProjectTests.setUpClass()

    def test_moved_then_deleted_surface_can_reopen_and_undo_without_changing_sources_or_calculators(self):
        case = project_fixtures.TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        def command(op, **values):
            case.session = case.service.command(case.session['session_id'], {'op': op, 'request_id': str(uuid4()),
                'expected_revision': case.session['revision'], **values})
        document = case.session['snapshot']['documents'][0]; calibration = str(uuid4()); identifier = str(uuid4())
        command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
        command('add_calibration', calibration={'id': calibration, 'document_id': document['id'], 'page': 1,
            'points': [[50, 50], [150, 50]], 'distance_m': 3.123456789012345,
            'uniform_scale': True, 'name': 'Retained elevation dimension'})
        command('create_item', item={'id': identifier, 'mode': 'wall', 'quantity': 1,
            'geometry': {'kind': 'polygon', 'document_id': document['id'], 'page': 1,
                'points': [[50, 50], [250, 50], [250, 250], [50, 250]],
                'exclusions': [{'id': str(uuid4()), 'note': 'Opening A',
                    'points': [[100, 100], [150, 100], [150, 150], [100, 150]]}]},
            'measurement': {'method': 'calibrated', 'calibration_id': calibration},
            'fields': {'mark': 'W-EDIT', 'treatment': 'Board', 'substrate': 'Concrete', 'frl': '120/120/120',
                'surface_basis': 'wall-face', 'surface_citation': 'Elevation A true wall face'},
            'evidence': [{'document_id': document['id'], 'page': 1, 'note': 'Elevation A'}],
            'appearance': {'stroke_color': '#123ABC', 'opacity': 0.7}})
        command('confirm_items', item_ids=[identifier])
        receipt = deepcopy(case.session['snapshot']['items'][0]['confirmation'])
        geometry = deepcopy(case.session['snapshot']['items'][0]['geometry'])
        geometry['points'][2] = [310.1234567890123, 290.9876543210987]
        command('update_item', item_id=identifier, changes={'geometry': geometry})
        moved = deepcopy(case.session['snapshot']); expected_item = moved['items'][0]
        expected_result = item_result(expected_item, moved)
        expected_digest = item_digest(expected_item, moved)
        saved = case.library.save_as({**deepcopy(case.base), 'takeoffs': moved,
                                      'takeoffs_session_id': case.session['session_id']})
        first_bytes = case.target.read_bytes(); first = json.loads(first_bytes)
        legacy = json.loads(case.legacy)
        for key in ('estimate', 'calculators'): self.assertEqual(first[key], legacy[key])
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        self.assertEqual(opened['takeoffs_issues'], [])
        self.assertEqual(opened['takeoffs']['items'], moved['items'])
        self.assertEqual(item_digest(opened['takeoffs']['items'][0], opened['takeoffs']), expected_digest)
        self.assertEqual(item_result(opened['takeoffs']['items'][0], opened['takeoffs']), expected_result)
        case.session = case.service.get(opened['takeoffs_session_id'])
        command('delete_items', item_ids=[identifier])
        deleted = deepcopy(case.session['snapshot'])
        case.library.save({**deepcopy(case.base), 'takeoffs': deleted,
            'takeoffs_session_id': case.session['session_id'], 'save_token': saved['file']['save_token']})
        second = json.loads(case.target.read_bytes())
        for key in ('estimate', 'calculators'): self.assertEqual(second[key], legacy[key])
        self.assertEqual(second['takeoffs']['items'], [])
        reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['documents'], moved['documents'])
        case.session = case.service.get(reopened['takeoffs_session_id'])
        command('undo')
        restored = case.session['snapshot']['items'][0]
        self.assertEqual(restored['id'], identifier); self.assertEqual(restored['geometry'], geometry)
        self.assertEqual(restored['member_ids'], expected_item['member_ids'])
        self.assertEqual(restored['appearance'], expected_item['appearance'])
        self.assertIsNone(restored['confirmation'])
        self.assertEqual(item_result(restored, case.session['snapshot']), expected_result)
        companion = case.target.parent / reopened['takeoffs']['companion_folder']
        originals = list(companion.rglob('*.pdf'))
        self.assertEqual(len(originals), 1); self.assertEqual(originals[0].read_bytes(), case.pdf)
        with case.store.connect() as database:
            retained = database.execute('SELECT receipt FROM takeoff_approvals WHERE receipt_id=?', (receipt['id'],)).fetchone()
        self.assertEqual(json.loads(retained[0]), receipt)


if __name__ == '__main__': unittest.main()
