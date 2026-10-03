"""Pasted lengths are new unconfirmed objects with exact retained source history."""

from copy import deepcopy
import json
import math
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import item_result, validate_snapshot
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_workspace as fixtures


class TakeoffCopyTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def values(self, identifiers, **changes):
        return {'sources': [{'item_id': identifier, 'version': self.item(identifier)['version']} for identifier in identifiers],
                'document_id': self.case.doc['id'], 'page': 1, 'point': [30, 60],
                'calibration_id': self.case.calibration_id, **changes}

    def duplicate(self, identifiers, **changes):
        response = self.case.command('duplicate_items', **self.values(identifiers, **changes))
        return [self.item(identifier) for identifier in response['created_item_ids']]

    def rejected(self, values, message=None):
        before = deepcopy(self.case.state['snapshot']); blobs = deepcopy(self.case.documents.blobs)
        with self.assertRaisesRegex(ValidationError, message or '.'):
            self.case.command('duplicate_items', **values)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(self.case.documents.blobs, blobs)

    def test_copies_fields_quantity_style_and_citations_without_authority_or_calculator_links(self):
        original_id = self.case.create(appearance={'stroke_color': '#ABCDEF', 'stroke_width': 3.5})
        self.case.confirm(original_id); self.case.apply(self.case.preview(original_id))
        original = deepcopy(self.item(original_id)); transfers = deepcopy(self.case.state['snapshot']['transfers'])
        copied, = self.duplicate([original_id])
        for key in ('fields', 'quantity', 'evidence', 'appearance'):
            self.assertEqual(copied[key], original[key])
        self.assertEqual(copied['geometry']['points'], [[30, 60], [130, 60]])
        self.assertEqual(copied['copied_from'], {'item_id': original_id, 'version': original['version']})
        self.assertEqual(copied['predecessor_ids'], [])
        self.assertEqual(copied['state'], 'draft'); self.assertEqual(copied['version'], 1)
        self.assertIsNone(copied['review']); self.assertIsNone(copied['confirmation'])
        self.assertNotEqual(copied['id'], original_id)
        self.assertTrue(set(copied['member_ids']).isdisjoint(original['member_ids']))
        self.assertEqual(self.item(original_id), original)
        self.assertEqual(self.case.state['snapshot']['transfers'], transfers)
        self.assertNotIn('calculator', self.case.state)
        with self.assertRaisesRegex(ValidationError, 'confirm'):
            self.case.preview(copied['id'])
        self.case.confirm(copied['id'])
        preview = self.case.preview(copied['id'])
        copied_binding, = preview['bindings']
        self.assertEqual(copied_binding['item_id'], copied['id'])
        self.assertNotIn(copied_binding['row'], [binding['row'] for binding in transfers])
        self.assertEqual(preview['inputs']['SCHEDULE'][f"J{copied_binding['row']}"], 10)

    def test_destination_scale_recalculates_and_group_offsets_are_preserved(self):
        first = self.case.create(mode='duct', quantity=1)
        second = self.case.create(mode='duct', quantity=3,
            geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[20, 50], [80, 50]]})
        calibration = str(uuid4())
        self.case.command('add_calibration', calibration={'id': calibration, 'document_id': self.case.doc['id'],
            'page': 1, 'name': 'Other scale', 'points': [[10, 20], [110, 20]], 'distance_m': 25, 'uniform_scale': True})
        copies = self.duplicate([first, second], calibration_id=calibration)
        self.assertEqual(copies[0]['geometry']['points'], [[30, 60], [130, 60]])
        self.assertEqual(copies[1]['geometry']['points'], [[40, 80], [100, 80]])
        self.assertEqual([item_result(item, self.case.state['snapshot'])['total_length_m'] for item in copies], [25, 45])
        self.assertEqual(self.item(first)['measurement']['calibration_id'], self.case.calibration_id)

    def test_cross_page_copy_reanchors_additions_but_preserves_original_citations_and_precision(self):
        additions = [
            {'id': str(uuid4()), 'kind': 'riser', 'length_mm': 1234.567890123, 'document_id': self.case.doc['id'],
             'page': 1, 'anchor': {'point_index': 1, 'point': [110, 30]}},
            {'id': str(uuid4()), 'kind': 'drop', 'length_mm': 750.012345678, 'document_id': self.case.doc['id'],
             'page': 1, 'note': 'Original section A'}]
        original_id = self.case.create(length_additions=additions)
        destination = fixtures.document(); destination['sha256'] = 'b'*64; destination['pages'][0]['rotation'] = 270
        self.case.state = self.case.service.add_document(self.case.sid, destination, self.case.state['revision'])
        calibration = str(uuid4())
        self.case.command('add_calibration', calibration={'id': calibration, 'document_id': destination['id'], 'page': 1,
            'name': 'Destination', 'points': [[10, 20], [110, 20]], 'distance_m': 5, 'uniform_scale': True})
        copied, = self.duplicate([original_id], document_id=destination['id'], calibration_id=calibration,
                                point=[30.123456789, 60.987654321])
        self.assertEqual(copied['geometry']['points'][0], [30.123456789, 60.987654321])
        anchored, cited = copied['length_additions']
        self.assertEqual(anchored['anchor']['point'], copied['geometry']['points'][1])
        self.assertEqual(anchored['document_id'], destination['id'])
        self.assertEqual(cited['document_id'], self.case.doc['id'])
        self.assertEqual(copied['evidence'], self.item(original_id)['evidence'])
        self.assertEqual([entry['length_mm'] for entry in copied['length_additions']], [entry['length_mm'] for entry in additions])
        self.assertTrue({entry['id'] for entry in copied['length_additions']}.isdisjoint(entry['id'] for entry in additions))
        result = item_result(copied, self.case.state['snapshot'])
        self.assertAlmostEqual(result['base_length_m'], 5, places=12)
        self.assertAlmostEqual(result['length_m'], 5 + sum(entry['length_mm']/1000 for entry in additions), places=12)
        self.assertTrue(any(issue['code'] == 'PAGE_REVIEW_BLOCKED' for issue in result['issues']))

    def test_idempotent_retry_and_repeated_paste_use_correct_fresh_identities(self):
        identifier = self.case.create()
        request = {'op': 'duplicate_items', 'expected_revision': self.case.state['revision'], 'request_id': str(uuid4()),
                   **self.values([identifier])}
        self.case.state = self.case.service.command(self.case.sid, request)
        retry = self.case.service.command(self.case.sid, request)
        self.assertEqual(retry, self.case.state)
        first_id = retry['created_item_ids'][0]
        second, = self.duplicate([identifier])
        self.assertNotEqual(second['id'], first_id)
        self.assertTrue(set(second['member_ids']).isdisjoint(self.item(first_id)['member_ids']))
        self.assertEqual(len(self.case.state['snapshot']['items']), 3)

    def test_stale_or_deleted_copied_source_is_rejected_without_a_partial_copy(self):
        identifier = self.case.create(); values = self.values([identifier])
        self.case.command('update_item', item_id=identifier, changes={'fields': {'mark': 'Changed'}})
        self.rejected(values, 'changed or was deleted')
        values = self.values([identifier]); self.case.command('delete_items', item_ids=[identifier])
        self.rejected(values, 'changed or was deleted')

    def test_unsupported_sources_and_duplicate_source_ids_are_rejected(self):
        steel = self.case.create(); duct = self.case.create(mode='duct')
        cited = self.case.create(measurement={'method': 'cited', 'length_m': 6.2, 'citation': 'Section B'})
        missing = self.case.create(geometry=None, measurement=None)
        self.case.command('add_count_items', document_id=self.case.doc['id'], page=1,
            markers=[{'point': [40, 80], 'length_m': 2}], fields={}, appearance={'stroke_color': '#123456'})
        count = self.case.state['created_item_ids'][0]
        for selected in ([steel, steel], [steel, duct], [cited], [missing], [count]):
            with self.subTest(selected=selected): self.rejected(self.values(selected))

    def test_invalid_pointer_calibration_or_second_geometry_cannot_mutate_any_item(self):
        first = self.case.create()
        second = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[110, 100], [210, 100]]})
        self.rejected(self.values([first, second]))
        for changes in ({'point': [math.nan, 60]}, {'point': [True, 60]}, {'point': [30]}, {'point': [5, 60]},
                        {'point': [130, 60]}, {'calibration_id': str(uuid4())}, {'page': 2}, {'sources': []},
                        {'sources': [{'item_id': first, 'version': True}]},
                        {'sources': [{'item_id': first, 'version': 1, 'fields': {}}]}):
            with self.subTest(changes=changes): self.rejected(self.values([first], **changes))

    def test_destination_viewport_scale_is_required_and_crossing_is_rejected(self):
        identifier = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1, 'points': [[10, 30], [50, 30]]})
        viewport = str(uuid4())
        self.case.command('add_calibration', calibration={'id': viewport, 'document_id': self.case.doc['id'], 'page': 1,
            'name': 'Detail', 'region': [90, 50, 100, 50], 'points': [[90, 50], [190, 50]], 'distance_m': 5, 'uniform_scale': True})
        self.rejected(self.values([identifier], point=[100, 60]), 'viewport')
        self.rejected(self.values([identifier], point=[170, 60], calibration_id=viewport), 'viewport boundary')
        copied, = self.duplicate([identifier], point=[100, 60], calibration_id=viewport)
        self.assertEqual(item_result(copied, self.case.state['snapshot'])['length_m'], 2)

    def test_changed_retained_source_is_rejected_before_any_new_audit(self):
        identifier = self.case.create(); self.case.documents.blocked = True
        self.rejected(self.values([identifier]), 'Changed source evidence')

    def test_undo_removes_only_copies_and_preserves_original_confirmation_and_links(self):
        identifier = self.case.create(); self.case.confirm(identifier); self.case.apply(self.case.preview(identifier))
        before = deepcopy(self.case.state['snapshot'])
        self.duplicate([identifier]); self.case.command('undo')
        self.assertEqual(self.case.state['snapshot']['items'], before['items'])
        self.assertEqual(self.case.state['snapshot']['transfers'], before['transfers'])

    def test_copy_traceability_survives_source_deletion_and_cannot_be_written_by_regular_edits(self):
        identifier = self.case.create(); copied, = self.duplicate([identifier])
        self.case.command('delete_items', item_ids=[identifier])
        reopened = self.case.service.open(json.loads(json.dumps(self.case.state['snapshot'])))
        self.assertEqual(reopened['snapshot']['items'][0]['copied_from'], copied['copied_from'])
        with self.assertRaises(ValidationError):
            self.case.command('update_item', item_id=copied['id'], changes={'copied_from': {'item_id': str(uuid4()), 'version': 1}})
        for source in ({'item_id': copied['id'], 'version': 1}, {'item_id': identifier, 'version': False},
                       {'item_id': identifier, 'version': 1, 'confirmation': True}):
            invalid = deepcopy(self.case.state['snapshot']); invalid['items'][0]['copied_from'] = source
            with self.subTest(source=source), self.assertRaises(ValidationError): validate_snapshot(invalid)


class TakeoffCopyProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def test_saved_project_restores_copy_identity_fields_and_source_companion(self):
        case = project_fixtures.TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        def command(op, **values):
            case.session = case.service.command(case.session['session_id'], {'op': op, 'request_id': str(uuid4()),
                'expected_revision': case.session['revision'], **values})
        document = case.session['snapshot']['documents'][0]; calibration = str(uuid4())
        command('add_calibration', calibration={'id': calibration, 'document_id': document['id'], 'page': 1,
            'name': 'Plan', 'points': [[50, 300], [450, 300]], 'distance_m': 8.35, 'uniform_scale': True})
        command('create_item', item={'mode': 'duct', 'quantity': 1, 'fields': {'mark': 'D-01', 'width_mm': 456.789},
            'geometry': {'document_id': document['id'], 'page': 1, 'points': [[50, 300], [150, 300]]},
            'measurement': {'method': 'calibrated', 'calibration_id': calibration}})
        original = case.session['snapshot']['items'][0]
        command('duplicate_items', sources=[{'item_id': original['id'], 'version': original['version']}],
            document_id=document['id'], page=1, point=[200, 250], calibration_id=calibration)
        copied = deepcopy(case.session['snapshot']['items'][-1])
        request = {**deepcopy(case.base), 'takeoffs': case.session['snapshot'], 'takeoffs_session_id': case.session['session_id']}
        case.library.save_as(request)
        case.dialogs.opened = str(case.target); reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['items'][-1], copied)
        companion = case.root / reopened['takeoffs']['companion_folder']
        self.assertTrue(any(path.read_bytes() == case.pdf for path in companion.rglob('*.pdf')))
        self.assertEqual({key: {field: value[field] for field in ('inputs', 'schedule_rows')}
                          for key, value in reopened['calculators'].items()}, request['calculators'])


if __name__ == '__main__':
    unittest.main()
