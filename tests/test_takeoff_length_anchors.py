"""Explicit rise/drop lengths retain their selected source point through edits."""
from copy import deepcopy
import json
import math
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_exports import HEADERS, register_rows
from estimator.takeoff_model import item_result, validate_snapshot
from estimator.takeoff_transfer import mapped_values
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_workspace as fixtures


class TakeoffLengthAnchorTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def addition(self, index=1, point=None, **values):
        return {'id': str(uuid4()), 'kind': 'riser', 'length_mm': 1234.567890123,
                'document_id': self.case.doc['id'], 'page': 1,
                'anchor': {'point_index': index, 'point': point or [110, 30]}, **values}

    def edit_points(self, identifier, points):
        geometry = deepcopy(self.item(identifier)['geometry']); geometry['points'] = points
        return self.case.command('update_item', item_id=identifier, changes={'geometry': geometry})

    def assert_rejected(self, identifier, points, message):
        before = deepcopy(self.case.state['snapshot']); blobs = deepcopy(self.case.documents.blobs)
        with self.assertRaisesRegex(ValidationError, message):
            self.edit_points(identifier, points)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(self.case.documents.blobs, blobs)

    def test_optional_citation_keeps_explicit_lengths_quantity_and_all_transfer_formulas(self):
        for mode in ('steel', 'duct'):
            with self.subTest(mode=mode):
                rise = self.addition(); drop = self.addition(0, [10, 30], kind='drop', length_mm=765.432109877, note='')
                quantity = 3 if mode == 'steel' else 1
                identifier = self.case.create(mode, quantity=quantity, length_additions=[rise, drop])
                item = self.item(identifier); snapshot = self.case.state['snapshot']
                self.assertNotIn('note', item['length_additions'][0])
                self.assertEqual(item['length_additions'], [rise, drop])
                result = item_result(item, snapshot)
                self.assertEqual((result['base_length_m'], result['additions_length_m'], result['length_m'], result['total_length_m']), (10, 2, 12, 12*quantity))
                self.case.confirm(identifier)
                if mode == 'steel':
                    spray = self.case.preview(identifier)
                    self.assertEqual((spray['inputs']['SCHEDULE']['I10'], spray['inputs']['SCHEDULE']['J10']), (3, 12))
                    board = deepcopy(self.item(identifier)); board['fields'].update(product='TRAFALGAR COREX', critical_temperature=620)
                    values, _ = mapped_values(board, self.case.state['snapshot'], 'steel_board', 9)
                    self.assertEqual(values['F9'], 36)
                else:
                    duct = self.case.preview(identifier, 'ductwork')
                    self.assertEqual(duct['inputs']['CALCULATOR']['D11'], 12)

    def test_point_and_source_validation_rejects_invalid_and_nonfinite_inputs_atomically(self):
        bad = [self.addition(index=-1), self.addition(index=2), self.addition(index=True),
               self.addition(point=[109, 30]), self.addition(point=[math.nan, 30]),
               self.addition(point=[True, 30]), self.addition(anchor=None),
               self.addition(anchor={'point_index': 1, 'point': [110, 30], 'extra': 1})]
        other = fixtures.document(); other['sha256'] = 'b'*64
        self.case.state = self.case.service.add_document(self.case.sid, other, self.case.state['revision'])
        bad.append(self.addition(document_id=other['id']))
        for addition in bad:
            with self.subTest(addition=addition):
                before = deepcopy(self.case.state['snapshot']); blobs = deepcopy(self.case.documents.blobs)
                with self.assertRaises(ValidationError):
                    self.case.create(length_additions=[addition])
                self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
                self.assertEqual(self.case.documents.blobs, blobs)

    def test_anchor_requires_a_line_and_cannot_attach_to_count_markers(self):
        for geometry in (None, {'document_id': self.case.doc['id'], 'page': 1, 'points': [[110, 30]]}):
            with self.subTest(geometry=geometry), self.assertRaisesRegex(ValidationError, 'line'):
                self.case.create(geometry=geometry, measurement=None, length_additions=[self.addition()])
        self.case.command('add_count_items', document_id=self.case.doc['id'], page=1,
                          markers=[{'point': [110, 30], 'length_m': 2}], fields={}, appearance={})
        count = self.case.state['snapshot']['items'][-1]
        with self.assertRaisesRegex(ValidationError, 'line'):
            self.case.command('update_item', item_id=count['id'], changes={'length_additions': [self.addition(index=0)]})

    def test_single_point_move_follows_anchor_invalidates_links_and_undo_restores_identity(self):
        addition = self.addition(); identifier = self.case.create(length_additions=[addition])
        self.case.confirm(identifier); self.case.apply(self.case.preview(identifier))
        original = deepcopy(self.item(identifier)); calculator = deepcopy(self.case.state['calculator'])
        self.edit_points(identifier, [[10, 30], [90.123456789, 50.987654321]])
        current = self.item(identifier)
        self.assertEqual(current['length_additions'], [{**addition, 'anchor': {'point_index': 1, 'point': [90.123456789, 50.987654321]}}])
        for key in ('quantity', 'member_ids', 'fields', 'measurement'):
            self.assertEqual(current[key], original[key])
        self.assertIsNone(current['confirmation']); self.assertIsNone(current['review'])
        self.assertTrue(all(link['status'] == 'stale' for link in self.case.state['snapshot']['transfers']))
        self.assertNotIn('calculator', self.case.state)
        self.assertEqual(calculator['inputs']['SCHEDULE']['J10'], 10 + addition['length_mm']/1000)
        self.case.command('undo')
        self.assertEqual(self.item(identifier)['geometry'], original['geometry'])
        self.assertEqual(self.item(identifier)['length_additions'], original['length_additions'])
        self.assertEqual(self.item(identifier)['member_ids'], original['member_ids'])
        self.assertIsNone(self.item(identifier)['confirmation'])

    def test_whole_line_translation_moves_anchors_but_retains_legacy_citations(self):
        anchored = self.addition(); legacy = self.addition(note='Section A citation'); del legacy['anchor']
        identifier = self.case.create(length_additions=[anchored, legacy])
        original = deepcopy(self.item(identifier))
        self.case.command('move_items', item_ids=[identifier], delta_pdf=[10.123456789, 20.987654321])
        current = self.item(identifier)
        self.assertEqual(current['length_additions'][0]['anchor']['point'], current['geometry']['points'][1])
        self.assertEqual(current['length_additions'][1], legacy)
        for key in ('quantity', 'member_ids', 'measurement', 'fields'):
            self.assertEqual(current[key], original[key])
        self.assertEqual(current['length_additions'][0]['length_mm'], anchored['length_mm'])

    def test_insert_and_delete_other_points_adjust_index_without_moving_anchor(self):
        addition = self.addition(); identifier = self.case.create(length_additions=[addition])
        self.edit_points(identifier, [[10, 30], [60, 50], [110, 30]])
        self.assertEqual(self.item(identifier)['length_additions'][0]['anchor'], {'point_index': 2, 'point': [110, 30]})
        self.edit_points(identifier, [[60, 50], [110, 30]])
        self.assertEqual(self.item(identifier)['length_additions'][0]['anchor'], addition['anchor'])

    def test_delete_anchored_point_retrace_and_source_replacement_fail_closed(self):
        identifier = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1,
            'points': [[10, 30], [60, 50], [110, 30]]}, length_additions=[self.addition(1, [60, 50])])
        self.case.confirm(identifier)
        self.assert_rejected(identifier, [[10, 30], [110, 30]], 'anchored control point')
        self.assert_rejected(identifier, [[20, 40], [50, 70], [120, 40]], 'retracing')
        self.assert_rejected(identifier, [[20, 30], [40, 40], [60, 60], [80, 60], [100, 30]], 'retracing')
        with self.assertRaisesRegex(ValidationError, 'line source'):
            self.case.command('update_item', item_id=identifier, changes={'geometry': None})
        # Removing the addition explicitly allows retracing in the same atomic edit.
        self.case.command('update_item', item_id=identifier, changes={'length_additions': [],
            'geometry': {'document_id': self.case.doc['id'], 'page': 1, 'points': [[20, 40], [100, 90]]}})
        self.assertEqual(self.item(identifier)['length_additions'], [])

    def test_register_provenance_and_snapshot_validation_preserve_exact_anchor_and_legacy_bytes(self):
        addition = self.addition(); identifier = self.case.create(length_additions=[addition])
        legacy = {key: value for key, value in self.addition(note='Existing citation').items() if key != 'anchor'}
        old_id = self.case.create(length_additions=[legacy])
        self.case.confirm(identifier); self.case.confirm(old_id)
        snapshot = deepcopy(self.case.state['snapshot'])
        self.assertEqual(validate_snapshot(snapshot), snapshot)
        reopened = self.case.service.open(snapshot, source_path='verified-project.json')['snapshot']
        self.assertEqual(reopened['items'], snapshot['items'])
        row = dict(zip(HEADERS, register_rows(snapshot, [self.item(identifier)])[0]))
        provenance = json.loads(row['Riser/drop source dimensions'])[0]
        self.assertEqual(provenance['anchor'], addition['anchor'])
        self.assertEqual(provenance['document_sha256'], self.case.doc['sha256'])
        self.assertEqual(self.item(old_id)['length_additions'], [legacy])


class TakeoffLengthAnchorProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def test_real_save_reopen_retains_anchor_and_existing_calculator_values(self):
        case = project_fixtures.TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        document = case.session['snapshot']['documents'][0]
        addition = {'id': str(uuid4()), 'kind': 'drop', 'length_mm': 1750.125,
                    'document_id': document['id'], 'page': 1,
                    'anchor': {'point_index': 1, 'point': [150, 60]}}
        request = {'op': 'create_item', 'request_id': str(uuid4()), 'expected_revision': case.session['revision'],
            'item': {'mode': 'duct', 'quantity': 2, 'fields': {},
                     'geometry': {'document_id': document['id'], 'page': 1, 'points': [[50, 60], [150, 60]]},
                     'measurement': {'method': 'cited', 'length_m': 10, 'citation': 'Existing plan length'},
                     'evidence': [], 'length_additions': [addition]}}
        case.session = case.service.command(case.session['session_id'], request)
        snapshot = deepcopy(case.session['snapshot'])
        case.library.save_as({**deepcopy(case.base), 'takeoffs': snapshot, 'takeoffs_session_id': case.session['session_id']})
        saved = json.loads(case.target.read_bytes())
        for key in ('estimate', 'calculators'):
            self.assertEqual(saved[key], json.loads(case.legacy)[key])
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        self.assertEqual(opened['takeoffs_issues'], [])
        self.assertEqual(opened['takeoffs']['items'], snapshot['items'])
        self.assertEqual(opened['takeoffs']['audit_head'], snapshot['audit_head'])


if __name__ == '__main__':
    unittest.main()
