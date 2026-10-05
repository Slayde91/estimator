"""Drawing values are presentation only and retain their exact source basis."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import unittest

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.takeoff_model import item_digest, item_result, markup_appearance, validate_appearance
from estimator.takeoff_markup_pdf import measurement_value_labels
from tests import test_takeoff_area as area_fixtures
from tests import test_takeoff_counts as count_fixtures
from tests import test_takeoff_marked_exports as pdf_fixtures
from tests import test_takeoff_workspace as fixtures


class TakeoffDisplayValueTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def current(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def test_percentage_storage_width_bounds_and_boolean_are_strict_with_legacy_preservation(self):
        for appearance in ({'stroke_width': 100, 'opacity': .01, 'display_values': True},
                           {'stroke_width': .25, 'opacity': 0}, {'opacity': .003333333333333333}):
            self.assertEqual(validate_appearance(appearance), appearance)
        for appearance in ({'stroke_width': 101}, {'stroke_width': .24}, {'stroke_width': True},
                           {'opacity': 100}, {'display_values': 1}, {'display_values': 'true'}):
            with self.subTest(appearance=appearance), self.assertRaises(ValidationError): validate_appearance(appearance)
        self.assertFalse(markup_appearance({'mode': 'steel', 'geometry': None})['display_values'])

    def test_appearance_changes_leave_confirmation_precision_members_and_source_contracts_intact(self):
        identifier = self.case.create(); self.case.confirm(identifier)
        old = deepcopy(self.current(identifier)); snapshot = deepcopy(self.case.state['snapshot'])
        result, digest = item_result(old, snapshot), item_digest(old, snapshot)
        self.case.command('update_item', item_id=identifier, changes={'appearance': {
            'stroke_width': 100, 'opacity': .01, 'display_values': True}})
        current = self.current(identifier)
        for key in ('geometry', 'measurement', 'quantity', 'member_ids', 'fields', 'evidence', 'confirmation', 'state'):
            self.assertEqual(current[key], old[key], key)
        for key in ('documents', 'calibrations', 'transfers'):
            self.assertEqual(self.case.state['snapshot'][key], snapshot[key], key)
        self.assertEqual(item_digest(current, self.case.state['snapshot']), digest)
        self.assertEqual(item_result(current, self.case.state['snapshot']), result)

    def test_polyline_labels_each_exact_calibrated_segment_without_quantity_or_addition_multiplier(self):
        identifier = self.case.create(geometry={'document_id': self.case.doc['id'], 'page': 1,
            'points': [[20, 30], [50, 30], [50, 70]]}, appearance={'display_values': True})
        item = self.current(identifier); snapshot = deepcopy(self.case.state['snapshot'])
        labels = measurement_value_labels(item, snapshot, item_result(item, snapshot))
        self.assertEqual([label['value'] for label in labels], [3000, 4000])
        self.assertEqual([label['point'] for label in labels], [[35, 30], [50, 50]])
        self.assertTrue(all(label['unit'] == 'mm' and label['kind'] == 'segment' for label in labels))
        self.assertEqual(item_result(item, snapshot)['total_length_m'], 14)
        self.assertEqual(self.case.state['snapshot'], snapshot)
        hidden = deepcopy(item); hidden['appearance']['display_values'] = False
        self.assertEqual(measurement_value_labels(hidden, snapshot, {}), [])
        missing = deepcopy(snapshot); missing['calibrations'] = []
        self.assertEqual(measurement_value_labels(item, missing, {}), [])
        self.case.command('update_calibration', calibration_id=self.case.calibration_id, changes={'distance_m': 20})
        self.assertEqual(measurement_value_labels(item, self.case.state['snapshot'], {}), [], 'Superseded scale cannot label an old measurement')

    def test_polygon_labels_closed_outer_and_exclusion_edges_and_net_area_inside_surface(self):
        case = area_fixtures.TakeoffAreaTests(); case.setUp(); self.addCleanup(case.doCleanups)
        for mode in ('wall', 'slab'):
            proposed = case.proposal(mode); proposed['appearance'] = {'display_values': True}
            item = case.current(case.create(proposed)); snapshot = deepcopy(case.case.state['snapshot'])
            labels = measurement_value_labels(item, snapshot, item_result(item, snapshot))
            self.assertEqual([label['value'] for label in labels[:-1]], [10000, 5000, 10000, 5000, 2000, 1000, 2000, 1000])
            self.assertEqual({key: labels[-1][key] for key in ('value', 'unit', 'kind')}, {'value': 48, 'unit': 'm²', 'kind': 'area'})
            from estimator.takeoff_area import _inside
            self.assertTrue(_inside(labels[-1]['point'], item['geometry']['points']))
            self.assertFalse(_inside(labels[-1]['point'], item['geometry']['exclusions'][0]['points']))
            self.assertEqual(case.case.state['snapshot'], snapshot)

    def test_steel_count_values_are_entered_per_member_lengths_without_inferred_scale(self):
        case = count_fixtures.TakeoffCountTests(); case.setUp(); self.addCleanup(case.doCleanups)
        identifier = case.add((6.123456789, 6.123456789), appearance={'display_values': True})[0]
        item = case.item(identifier); snapshot = deepcopy(case.case.state['snapshot'])
        labels = measurement_value_labels(item, snapshot, item_result(item, snapshot))
        self.assertEqual(snapshot['calibrations'], [])
        self.assertEqual([label['point'] for label in labels], item['geometry']['points'])
        self.assertEqual([label['value'] for label in labels], [6123.456789, 6123.456789])
        self.assertEqual(item['measurement']['length_m'], 6.123456789)
        self.assertEqual(case.case.state['snapshot'], snapshot)


class TakeoffDisplayValuePDFTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): pdf_fixtures.TakeoffMarkedPDFTests.setUpClass()

    def setUp(self):
        self.case = pdf_fixtures.TakeoffMarkedPDFTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def test_real_pdf_segment_labels_opt_in_with_rotation_crop_userunit_and_original_preserved(self):
        case = self.case; identifiers = case.create_marks()
        source = case.case.documents.document_path(case.document); original = sha256(source.read_bytes()).hexdigest()
        reader = PdfReader(BytesIO(case.export(identifiers)[0]))
        self.assertTrue(all('8,000.00 mm' not in page.extract_text() for page in reader.pages))
        for identifier in identifiers:
            case.command('update_item', item_id=identifier, changes={'appearance': {'display_values': True}})
        snapshot = deepcopy(case.case.session['snapshot']); reader = PdfReader(BytesIO(case.export(identifiers)[0]))
        for index, page in enumerate(reader.pages):
            self.assertIn('8,000.00 mm', page.extract_text()); self.assertIn(f'ORIGINAL DRAWING ROTATION {index*90}', page.extract_text())
            self.assertEqual(page.get('/Rotate', 0), 0); self.assertEqual(page.get('/UserUnit', 1), 1)
        self.assertEqual(sha256(source.read_bytes()).hexdigest(), original)
        self.assertEqual(case.case.service.get(case.case.session['session_id'])['snapshot'], snapshot)

    def test_real_surface_pdf_contains_perimeter_lengths_and_net_area_but_never_changes_area(self):
        case = self.case; case.create_marks(); snapshot = case.case.session['snapshot']
        calibration = snapshot['calibrations'][0]['id']
        case.command('create_item', item={'mode': 'wall', 'quantity': 1,
            'geometry': {'kind': 'polygon', 'document_id': case.document['id'], 'page': 1,
                         'points': [[20, 30], [120, 30], [120, 80], [20, 80]], 'exclusions': []},
            'measurement': {'method': 'calibrated', 'calibration_id': calibration},
            'fields': {'mark': 'W-VALUE', 'surface_basis': 'wall-face', 'surface_citation': 'Synthetic elevation'},
            'evidence': [], 'appearance': {'display_values': True}})
        identifier = case.case.session['snapshot']['items'][-1]['id']; before = deepcopy(case.case.session['snapshot'])
        result = next(value for value in case.case.session['item_results'] if value['id'] == identifier)
        payload = case.export([identifier], mode='wall')[0]; text = PdfReader(BytesIO(payload)).pages[0].extract_text()
        self.assertIn('10,000.00 mm', text); self.assertIn('5,000.00 mm', text); self.assertIn('50.00 m²', text)
        self.assertEqual(result['net_area_m2'], 50)
        self.assertEqual(case.case.service.get(case.case.session['session_id'])['snapshot'], before)

    def test_real_count_pdf_rounds_only_display_and_labels_each_entered_member_length(self):
        case = self.case; case.create_marks()
        reply = case.command('add_count_items', document_id=case.document['id'], page=2,
            markers=[{'point': [30, 40], 'length_m': 1.2345675}, {'point': [110, 80], 'length_m': 1.2345675}],
            fields={'mark': 'EXPLICIT-COUNT'}, appearance={'display_values': True})
        identifier = reply['created_item_ids'][0]; before = deepcopy(case.case.session['snapshot'])
        text = PdfReader(BytesIO(case.export([identifier])[0])).pages[1].extract_text()
        self.assertEqual(text.count('1,234.57 mm'), 2)
        self.assertIn('2 markers x 1.23 m manual length each; 2.47 m total', text)
        current = next(item for item in before['items'] if item['id'] == identifier)
        self.assertEqual(current['measurement']['length_m'], 1.2345675)
        self.assertEqual(case.case.service.get(case.case.session['session_id'])['snapshot'], before)


if __name__ == '__main__': unittest.main()
