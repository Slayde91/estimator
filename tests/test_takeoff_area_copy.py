"""Copied surfaces retain measurements and evidence, but receive no review authority."""

from copy import deepcopy
import json
import math
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import item_result, validate_snapshot
from tests import test_takeoff_area as area_fixtures
from tests import test_takeoff_area_project as project_fixtures
from tests import test_takeoff_workspace as workspace_fixtures


class TakeoffAreaCopyTests(unittest.TestCase):
    def setUp(self):
        self.area = area_fixtures.TakeoffAreaTests()
        self.area.setUp()
        self.addCleanup(self.area.doCleanups)
        self.case = self.area.case

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def create(self, mode='wall', layers=3, **changes):
        proposed = self.area.proposal(mode)
        if layers is not None:
            proposed['fields']['layers'] = layers
        proposed.update(changes)
        return self.area.create(proposed)

    def values(self, identifiers, **changes):
        return {'sources': [{'item_id': i, 'version': self.item(i)['version']} for i in identifiers],
                'document_id': self.case.doc['id'], 'page': 1, 'point': [30, 60],
                'calibration_id': self.case.calibration_id, **changes}

    def duplicate(self, identifiers, **changes):
        result = self.case.command('duplicate_items', **self.values(identifiers, **changes))
        return [self.item(i) for i in result['created_item_ids']]

    def rejected(self, values, message='.'):
        snapshot = deepcopy(self.case.state['snapshot'])
        blobs = deepcopy(self.case.documents.blobs)
        with self.assertRaisesRegex(ValidationError, message):
            self.case.command('duplicate_items', **values)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], snapshot)
        self.assertEqual(self.case.documents.blobs, blobs)

    def test_surface_copy_moves_exclusions_and_preserves_layers_fields_style_without_authority(self):
        appearance = {'stroke_color': '#ABCDEF', 'stroke_width': 3.5, 'fill_color': '#FEDCBA',
                      'fill_enabled': True, 'opacity': 0.65, 'display_values': False}
        identifier = self.create(appearance=appearance)
        self.case.confirm(identifier)
        original = deepcopy(self.item(identifier))
        copied, = self.duplicate([identifier])
        for key in ('fields', 'quantity', 'evidence', 'appearance'):
            self.assertEqual(copied[key], original[key])
        self.assertEqual(copied['geometry']['points'], [[30, 60], [130, 60], [130, 110], [30, 110]])
        hole, = copied['geometry']['exclusions']
        self.assertEqual(hole['points'], [[50, 70], [70, 70], [70, 80], [50, 80]])
        self.assertEqual(hole['note'], original['geometry']['exclusions'][0]['note'])
        self.assertNotEqual(hole['id'], original['geometry']['exclusions'][0]['id'])
        self.assertNotEqual(copied['id'], identifier)
        self.assertTrue(set(copied['member_ids']).isdisjoint(original['member_ids']))
        self.assertEqual(len(copied['member_ids']), 1)
        self.assertEqual(copied['copied_from'], {'item_id': identifier, 'version': original['version']})
        self.assertEqual(copied['predecessor_ids'], [])
        self.assertEqual((copied['state'], copied['version'], copied['review'], copied['confirmation']),
                         ('draft', 1, None, None))
        self.assertEqual(item_result(copied, self.case.state['snapshot'])['total_area_m2'], 144)
        self.assertEqual(self.item(identifier), original)
        self.assertEqual(self.case.state['snapshot']['transfers'], [])
        self.assertNotIn('calculator', self.case.state)

    def test_mixed_wall_floor_group_keeps_relative_positions_and_uses_destination_scale_squared(self):
        first = self.create(layers=2)
        second_proposal = self.area.proposal('slab')
        second_proposal['fields']['layers'] = 4
        second_proposal['geometry']['points'] = [[70, 40], [110, 40], [110, 60], [70, 60]]
        second_proposal['geometry']['exclusions'][0]['points'] = [[80, 45], [90, 45], [90, 50], [80, 50]]
        second = self.area.create(second_proposal)
        calibration = str(uuid4())
        self.case.command('add_calibration', calibration={'id': calibration, 'document_id': self.case.doc['id'],
            'page': 1, 'name': 'Destination', 'points': [[10, 20], [110, 20]], 'distance_m': 5, 'uniform_scale': True})
        copied = self.duplicate([first, second], point=[30, 50], calibration_id=calibration)
        self.assertEqual([item['mode'] for item in copied], ['wall', 'slab'])
        self.assertEqual(copied[1]['geometry']['points'], [[80, 60], [120, 60], [120, 80], [80, 80]])
        results = [item_result(item, self.case.state['snapshot']) for item in copied]
        self.assertEqual([result['net_area_m2'] for result in results], [12, 1.875])
        self.assertEqual([result['total_area_m2'] for result in results], [24, 7.5])
        self.assertEqual(self.item(first)['measurement']['calibration_id'], self.case.calibration_id)

    def test_cross_document_copy_retains_citations_and_precision_requires_destination_render_review(self):
        identifier = self.create()
        original = deepcopy(self.item(identifier))
        destination = workspace_fixtures.document()
        destination['sha256'] = 'b' * 64
        destination['pages'][0].update(rotation=270, user_unit=5)
        self.case.state = self.case.service.add_document(self.case.sid, destination, self.case.state['revision'])
        calibration = str(uuid4())
        distance = 5.1234567890123
        self.case.command('add_calibration', calibration={'id': calibration, 'document_id': destination['id'],
            'page': 1, 'name': 'Other drawing', 'points': [[10, 20], [110, 20]], 'distance_m': distance, 'uniform_scale': True})
        with patch.object(self.case.documents, 'assert_documents', wraps=self.case.documents.assert_documents) as checked:
            copied, = self.duplicate([identifier], document_id=destination['id'], calibration_id=calibration,
                                    point=[30.123456789, 60.987654321])
        self.assertEqual({doc['id'] for doc in checked.call_args.args[0]}, {self.case.doc['id'], destination['id']})
        self.assertEqual(copied['geometry']['document_id'], destination['id'])
        self.assertEqual(copied['evidence'], original['evidence'])
        result = item_result(copied, self.case.state['snapshot'])
        self.assertAlmostEqual(result['net_area_m2'], 4800 * (distance / 100) ** 2, places=12)
        self.assertAlmostEqual(result['total_area_m2'], result['net_area_m2'] * 3, places=12)
        self.assertIn('PAGE_REVIEW_BLOCKED', {issue['code'] for issue in result['issues']})
        with self.assertRaises(ValidationError):
            self.case.command('review_items', item_ids=[copied['id']])
        self.case.command('record_render', document_id=destination['id'], page=1, success=True, warnings=[])
        self.case.confirm(copied['id'])
        self.assertEqual(self.item(copied['id'])['confirmation']['checks']['engine'], 'takeoffs-area-v2')

    def test_idempotent_retry_and_each_later_paste_create_separate_surface_and_exclusion_identities(self):
        identifier = self.create()
        request = {'op': 'duplicate_items', 'request_id': str(uuid4()), 'expected_revision': self.case.state['revision'],
                   **self.values([identifier])}
        self.case.state = self.case.service.command(self.case.sid, request)
        retry = self.case.service.command(self.case.sid, request)
        self.assertEqual(retry, self.case.state)
        second, = self.duplicate([identifier])
        items = self.case.state['snapshot']['items']
        self.assertEqual(len(items), 3)
        self.assertEqual(len({item['id'] for item in items}), 3)
        self.assertEqual(len({item['member_ids'][0] for item in items}), 3)
        self.assertEqual(len({item['geometry']['exclusions'][0]['id'] for item in items}), 3)
        self.assertEqual(second['copied_from']['item_id'], identifier)

    def test_stale_or_deleted_area_source_is_rejected_atomically(self):
        identifier = self.create()
        values = self.values([identifier])
        self.case.command('update_item', item_id=identifier, changes={'fields': {'layers': 5}})
        self.rejected(values, 'changed or was deleted')
        values = self.values([identifier])
        self.case.command('delete_items', item_ids=[identifier])
        self.rejected(values, 'changed or was deleted')

    def test_area_cannot_mix_with_linear_count_or_another_source_page(self):
        area = self.create()
        linear = self.case.create()
        standalone = self.create(geometry={'document_id': self.case.doc['id'], 'page': 1,
                                         'points': [[20, 30], [60, 30]]},
                                 fields={'mark': 'Measured length'}, purpose='length-only',
                                 evidence=[{'document_id': self.case.doc['id'], 'page': 1, 'note': 'Retained line'}])
        self.case.command('add_count_items', document_id=self.case.doc['id'], page=1,
                          markers=[{'point': [40, 80], 'length_m': 2}], fields={}, appearance={'stroke_color': '#123456'})
        count = self.case.state['created_item_ids'][0]
        destination = workspace_fixtures.document()
        destination['sha256'] = 'b' * 64
        self.case.state = self.case.service.add_document(self.case.sid, destination, self.case.state['revision'])
        calibration = str(uuid4())
        self.case.command('add_calibration', calibration={'id': calibration, 'document_id': destination['id'],
            'page': 1, 'name': 'Other page', 'points': [[10, 20], [110, 20]], 'distance_m': 10, 'uniform_scale': True})
        proposed = self.area.proposal('slab')
        proposed['geometry']['document_id'] = destination['id']
        proposed['measurement']['calibration_id'] = calibration
        other = self.area.create(proposed)
        for selected in ([area, linear], [standalone], [area, count], [area, other], [area, area]):
            with self.subTest(selected=selected):
                self.rejected(self.values(selected))

    def test_out_of_page_group_and_invalid_pointer_or_calibration_do_not_partially_create(self):
        first = self.create()
        proposed = self.area.proposal('slab')
        proposed['geometry']['points'] = [[140, 70], [200, 70], [200, 110], [140, 110]]
        proposed['geometry']['exclusions'] = []
        second = self.area.create(proposed)
        self.rejected(self.values([first, second], point=[30, 50]), 'outside')
        for changes in ({'point': [math.nan, 60]}, {'point': [True, 60]}, {'point': [30]},
                        {'point': [5, 60]}, {'point': [150, 60]}, {'calibration_id': str(uuid4())}, {'page': 2}):
            with self.subTest(changes=changes):
                self.rejected(self.values([first], **changes))

    def test_destination_viewport_is_explicit_and_cannot_be_crossed(self):
        proposed = self.area.proposal()
        proposed['fields']['layers'] = 2
        proposed['geometry']['points'] = [[20, 30], [60, 30], [60, 60], [20, 60]]
        proposed['geometry']['exclusions'][0]['points'] = [[30, 40], [40, 40], [40, 50], [30, 50]]
        identifier = self.area.create(proposed)
        viewport = str(uuid4())
        self.case.command('add_calibration', calibration={'id': viewport, 'document_id': self.case.doc['id'], 'page': 1,
            'name': 'Detail', 'region': [90, 50, 110, 60], 'points': [[90, 50], [190, 50]], 'distance_m': 5, 'uniform_scale': True})
        self.rejected(self.values([identifier], point=[100, 60]), 'viewport')
        self.rejected(self.values([identifier], point=[170, 60], calibration_id=viewport), 'viewport boundary')
        copied, = self.duplicate([identifier], point=[100, 60], calibration_id=viewport)
        self.assertEqual(item_result(copied, self.case.state['snapshot'])['net_area_m2'], 2.75)

    def test_superseded_destination_calibration_is_rejected_and_current_scale_recomputes_area(self):
        identifier = self.create()
        self.case.command('update_calibration', calibration_id=self.case.calibration_id, changes={'distance_m': 20})
        current = self.case.state['revised_calibration_id']
        self.rejected(self.values([identifier]), 'active calibration')
        copied, = self.duplicate([identifier], calibration_id=current)
        self.assertEqual(item_result(copied, self.case.state['snapshot'])['net_area_m2'], 192)

    def test_retained_evidence_change_and_item_or_member_capacity_fail_before_new_audit(self):
        area = self.create()
        self.case.documents.blocked = True
        self.rejected(self.values([area]), 'Changed source evidence')
        self.case.documents.blocked = False
        self.case.create(quantity=2)
        with patch('estimator.takeoff_copy.MAX_ITEMS', 2):
            self.rejected(self.values([area]), 'at most 2 items')
        with patch('estimator.takeoff_copy.MAX_ITEMS', 3):
            self.rejected(self.values([area]), 'physical member identities')

    def test_undo_removes_only_copies_preserving_confirmation_and_existing_calculator_links(self):
        area = self.create()
        self.case.confirm(area)
        linear = self.case.create()
        self.case.confirm(linear)
        self.case.apply(self.case.preview(linear))
        before = deepcopy(self.case.state['snapshot'])
        self.duplicate([area])
        self.assertEqual(self.case.state['snapshot']['transfers'], before['transfers'])
        self.case.command('undo')
        self.assertEqual(self.case.state['snapshot']['items'], before['items'])
        self.assertEqual(self.case.state['snapshot']['transfers'], before['transfers'])

    def test_legacy_area_fields_and_absent_layers_survive_copy_and_source_deletion(self):
        identifier = self.create(layers=None)
        original = deepcopy(self.item(identifier))
        copied, = self.duplicate([identifier])
        self.assertEqual(copied['fields'], original['fields'])
        self.assertNotIn('layers', copied['fields'])
        self.case.command('delete_items', item_ids=[identifier])
        reopened = self.case.service.open(json.loads(json.dumps(self.case.state['snapshot'])))
        self.assertEqual(reopened['snapshot']['items'][0]['copied_from'], copied['copied_from'])
        validate_snapshot(reopened['snapshot'])


class TakeoffAreaCopyProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffAreaProjectTests.setUpClass()

    def test_saved_area_copy_retains_fresh_identities_geometry_layers_and_citations_without_calculator_changes(self):
        case = project_fixtures.TakeoffAreaProjectTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        case.command('update_item', item_id=case.item_id, changes={'fields': {'layers': 3}})
        original = deepcopy(case.case.session['snapshot']['items'][0])
        geometry = original['geometry']
        case.command('duplicate_items', sources=[{'item_id': original['id'], 'version': original['version']}],
                     document_id=geometry['document_id'], page=geometry['page'], point=[200, 150],
                     calibration_id=original['measurement']['calibration_id'])
        copied = deepcopy(case.case.session['snapshot']['items'][-1])
        calculators = deepcopy(case.case.request['calculators'])
        case.case.library.save_as(case.case.request)
        case.case.dialogs.opened = str(case.case.target)
        reopened = case.case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['items'][-1], copied)
        self.assertEqual(reopened['takeoffs']['items'][0], original)
        self.assertNotEqual(copied['geometry']['exclusions'][0]['id'], original['geometry']['exclusions'][0]['id'])
        self.assertEqual((copied['state'], copied['review'], copied['confirmation']), ('draft', None, None))
        for key, value in calculators.items():
            self.assertEqual(reopened['calculators'][key]['inputs'], value['inputs'])
            self.assertEqual(reopened['calculators'][key]['schedule_rows'], value['schedule_rows'])


if __name__ == '__main__':
    unittest.main()
