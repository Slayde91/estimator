"""Presentation-only edits and atomic source-coordinate markup movement."""
from copy import deepcopy
import math
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import item_digest, item_result, markup_appearance, validate_snapshot
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_area as area_fixtures


class TakeoffMarkupEditTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def test_visual_edit_and_undo_preserve_confirmed_measurement_and_link_authority(self):
        identifier = self.case.create()
        self.case.confirm(identifier)
        self.case.apply(self.case.preview(identifier))
        before = deepcopy(self.case.state['snapshot']); original = deepcopy(self.item(identifier))
        self.case.command('update_item', item_id=identifier, changes={'appearance': {'stroke_color': '#123456', 'opacity': 0.4}})
        current = self.item(identifier)
        self.assertEqual(current['version'], original['version'])
        self.assertEqual(current['confirmation'], original['confirmation'])
        self.assertEqual(item_digest(current, self.case.state['snapshot']), item_digest(original, before))
        self.assertEqual(self.case.state['snapshot']['transfers'], before['transfers'])
        self.assertEqual(self.case.service.export(self.case.sid, 'csv', [identifier])[1], 'text/csv; charset=utf-8')
        audit = self.case.documents.get_blob(self.case.state['snapshot']['audit_head'])
        self.assertIn(identifier, audit['affected_ids']['items'])
        self.assertEqual(audit['before']['items'][0], original)
        self.case.command('undo')
        self.assertEqual(self.item(identifier), original)
        self.assertEqual(self.case.state['snapshot']['transfers'], before['transfers'])

    def test_sparse_multi_edit_preserves_each_unedited_field_and_style(self):
        first = self.case.create(appearance={'stroke_color': '#123456', 'opacity': 0.4})
        second = self.case.create(quantity=3, appearance={'stroke_color': '#654321', 'fill_enabled': False})
        self.case.command('update_item', item_id=second, changes={'fields': {'mark': 'B18', 'level': 'L2', 'notes': 'Retained'}})
        self.case.confirm(first); self.case.confirm(second)
        originals = {i: deepcopy(self.item(i)) for i in (first, second)}
        self.case.command('bulk_update', item_ids=[first, second], changes={'appearance': {'stroke_width': 4}})
        for identifier in (first, second):
            current, old = self.item(identifier), originals[identifier]
            self.assertEqual(current['fields'], old['fields'])
            self.assertEqual(current['quantity'], old['quantity'])
            self.assertEqual(current['appearance'], {**old['appearance'], 'stroke_width': 4})
            self.assertEqual(current['confirmation'], old['confirmation'])
        self.case.command('bulk_update', item_ids=[first, second], changes={'fields': {'level': 'L3'}})
        for identifier in (first, second):
            current, old = self.item(identifier), originals[identifier]
            self.assertEqual(current['fields'], {**old['fields'], 'level': 'L3'})
            self.assertEqual(current['version'], old['version'] + 1)
            self.assertEqual(current['state'], 'draft')
        self.assertEqual(self.item(second)['fields']['notes'], 'Retained')

    def test_identical_field_edit_does_not_invalidate_confirmation(self):
        identifier = self.case.create(); self.case.confirm(identifier)
        original = deepcopy(self.item(identifier))
        self.case.command('update_item', item_id=identifier, changes={'fields': {'mark': 'B17'}, 'quantity': 2})
        self.assertEqual(self.item(identifier), original)

    def test_malformed_technical_edits_fail_validation_without_partial_changes(self):
        identifier = self.case.create()
        self.case.confirm(identifier)
        before = deepcopy(self.case.state['snapshot'])
        for changes in ({'geometry': 'invalid'}, {'evidence': None},
                        {'measurement': 'invalid'}, {'length_additions': 'invalid'},
                        {'geometry': {'points': [[10, 30], [20, 30]]}}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.case.command('update_item', item_id=identifier, changes=changes)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_appearance_is_bounded_literal_and_legacy_items_keep_their_bytes(self):
        identifier = self.case.create(); original = deepcopy(self.item(identifier))
        self.assertNotIn('appearance', validate_snapshot(self.case.state['snapshot'])['items'][0])
        self.assertEqual(markup_appearance(original), {'stroke_color': '#FF0000', 'fill_color': '#FF0000',
            'stroke_width': 2, 'fill_enabled': False, 'opacity': 1})
        invalid = [None, [], {}, {'unknown': 1}, {'stroke_color': 'red'}, {'stroke_color': '#fff'},
                   {'fill_color': 'url(http://example.test)'}, {'fill_enabled': 1}, {'opacity': True},
                   {'opacity': -0.1}, {'opacity': 1.1}, {'opacity': math.nan}, {'stroke_width': 0},
                   {'stroke_width': 21}, {'stroke_width': math.inf}]
        for appearance in invalid:
            with self.subTest(appearance=appearance):
                before = deepcopy(self.case.state['snapshot'])
                with self.assertRaises(ValidationError):
                    self.case.command('update_item', item_id=identifier, changes={'appearance': appearance})
                self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_translation_is_atomic_idempotent_and_invalidates_geometry_authority(self):
        additions = [{'id': str(uuid4()), 'kind': 'riser', 'length_mm': 750,
                      'note': 'Section A: 750 mm', 'document_id': self.case.doc['id'], 'page': 1}]
        first = self.case.create(length_additions=additions)
        second = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[30, 50], [130, 50]]})
        self.case.confirm(first); self.case.confirm(second)
        self.case.apply(self.case.preview(first))
        originals = {i: deepcopy(self.item(i)) for i in (first, second)}
        before = deepcopy(self.case.state['snapshot'])
        request = {'op': 'move_items', 'item_ids': [first, second], 'delta_pdf': [12.5, 6.25],
                   'expected_revision': self.case.state['revision'], 'request_id': str(uuid4())}
        self.case.state = self.case.service.command(self.case.sid, request)
        self.assertEqual(self.case.service.command(self.case.sid, request), self.case.state)
        for identifier in (first, second):
            item, old = self.item(identifier), originals[identifier]
            self.assertEqual(item['geometry']['points'], [[x+12.5, y+6.25] for x, y in old['geometry']['points']])
            for key in ('fields', 'measurement', 'quantity', 'member_ids', 'evidence'):
                self.assertEqual(item[key], old[key])
            self.assertAlmostEqual(item_result(item, self.case.state['snapshot'])['length_m'], item_result(old, before)['length_m'])
            self.assertEqual(item['version'], old['version']+1)
            self.assertIsNone(item['confirmation'])
        self.assertEqual(self.item(first)['length_additions'], additions)
        self.assertTrue(all(b['status'] == 'stale' for b in self.case.state['snapshot']['transfers']))
        self.assertNotIn('calculator', self.case.state)
        self.case.command('undo')
        self.assertEqual(self.item(first)['geometry'], originals[first]['geometry'])
        self.assertIsNone(self.item(first)['confirmation'])

    def test_invalid_offsets_and_out_of_bounds_second_item_leave_whole_batch_unchanged(self):
        first = self.case.create()
        second = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[100, 100], [200, 100]]})
        for delta in ([11, 0], [0, 30], [-1, 0], [0, 0], [True, 1], [math.inf, 0], [1], '1,2'):
            with self.subTest(delta=delta):
                before = deepcopy(self.case.state['snapshot'])
                with self.assertRaises(ValidationError):
                    self.case.command('move_items', item_ids=[first, second], delta_pdf=delta)
                self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_drag_cannot_silently_cross_viewport_scale_boundaries(self):
        viewport = {'id': str(uuid4()), 'document_id': self.case.doc['id'], 'page': 1,
                    'name': 'Inset', 'region': [10, 20, 120, 50], 'points': [[10, 20], [130, 20]],
                    'distance_m': 6, 'uniform_scale': True}
        self.case.command('add_calibration', calibration=viewport)
        identifier = self.case.create(measurement={'method': 'calibrated', 'calibration_id': viewport['id']})
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'viewport boundary'):
            self.case.command('move_items', item_ids=[identifier], delta_pdf=[30, 0])
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.case.command('move_items', item_ids=[identifier], delta_pdf=[10, 10])
        self.assertEqual(self.item(identifier)['measurement']['calibration_id'], viewport['id'])

    def test_different_modes_and_missing_geometry_cannot_move_together(self):
        steel = self.case.create(); duct = self.case.create(mode='duct', quantity=1)
        missing = self.case.create(geometry=None, measurement=None)
        for ids in ([steel, duct], [missing], [steel, steel], []):
            before = deepcopy(self.case.state['snapshot'])
            with self.assertRaises(ValidationError):
                self.case.command('move_items', item_ids=ids, delta_pdf=[1, 1])
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_polygon_exclusions_translate_with_surface_but_source_citations_stay_pinned(self):
        area = area_fixtures.TakeoffAreaTests(); area.case = self.case
        proposal = area.proposal()
        proposal['appearance'] = {'fill_enabled': False, 'fill_color': '#FEDCBA'}
        proposal['evidence'][0]['region'] = [20, 30, 100, 50]
        self.case.command('create_item', item=proposal)
        identifier = self.case.state['snapshot']['items'][-1]['id']; original = deepcopy(self.item(identifier))
        result = item_result(original, self.case.state['snapshot'])
        self.case.command('move_items', item_ids=[identifier], delta_pdf=[15, 10])
        current = self.item(identifier)
        self.assertEqual(current['geometry']['exclusions'][0]['points'],
                         [[x+15, y+10] for x, y in original['geometry']['exclusions'][0]['points']])
        self.assertEqual(current['evidence'], original['evidence'])
        self.assertEqual(item_result(current, self.case.state['snapshot']), result)
        reopened = self.case.service.open(deepcopy(self.case.state['snapshot']))
        self.assertEqual(reopened['snapshot']['items'][0]['appearance'], proposal['appearance'])
        self.assertEqual(reopened['snapshot']['items'][0]['geometry'], current['geometry'])

    def test_split_and_merge_preserve_custom_appearance(self):
        identifier = self.case.create(mode='duct', quantity=1, appearance={'stroke_color': '#ABCDEF'})
        item = self.item(identifier)
        parts = [{'mode': 'duct', 'quantity': 1, 'fields': deepcopy(item['fields']), 'measurement': deepcopy(item['measurement']),
                  'evidence': deepcopy(item['evidence']), 'geometry': {**item['geometry'], 'points': points}}
                 for points in ([[10, 30], [60, 30]], [[60, 30], [110, 30]])]
        self.case.command('split_item', item_id=identifier, parts=parts)
        items = self.case.state['snapshot']['items']
        self.assertTrue(all(i['appearance'] == {'stroke_color': '#ABCDEF'} for i in items))
        proposed = {**parts[0], 'geometry': deepcopy(item['geometry'])}
        self.case.command('merge_items', item_ids=[i['id'] for i in items], item=proposed)
        self.assertEqual(self.case.state['snapshot']['items'][0]['appearance'], {'stroke_color': '#ABCDEF'})


if __name__ == '__main__':
    unittest.main()
