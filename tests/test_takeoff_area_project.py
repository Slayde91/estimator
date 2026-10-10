"""Area confirmations survive real evidence Save/Save As and fail on damage."""

from copy import deepcopy
import json
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from tests import test_takeoff_project as fixtures


class TakeoffAreaProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = fixtures.TakeoffProjectTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        document = self.case.session['snapshot']['documents'][0]
        self.command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
        calibration = str(uuid4())
        self.command('add_calibration', calibration={'id': calibration, 'document_id': document['id'], 'page': 1,
                    'name': 'Elevation', 'points': [[50, 50], [150, 50]], 'distance_m': 10, 'uniform_scale': True})
        self.item_id = str(uuid4())
        self.command('create_item', item={'id': self.item_id, 'mode': 'wall', 'quantity': 1,
                     'geometry': {'kind': 'polygon', 'document_id': document['id'], 'page': 1,
                                  'points': [[50, 50], [150, 50], [150, 100], [50, 100]],
                                  'exclusions': [{'id': str(uuid4()), 'points': [[60, 60], [80, 60], [80, 80], [60, 80]], 'note': 'Retained opening'}]},
                     'measurement': {'method': 'calibrated', 'calibration_id': calibration},
                     'fields': {'mark': 'W1', 'treatment': 'Nominated treatment', 'substrate': 'Concrete', 'frl': '120/120/120',
                                'surface_basis': 'wall-face', 'surface_citation': 'True face in elevation A'},
                     'evidence': [{'document_id': document['id'], 'page': 1, 'note': 'Face and opening'}]})
        self.command('review_items', item_ids=[self.item_id])
        self.command('confirm_items', item_ids=[self.item_id])

    def command(self, op, **values):
        case = self.case
        case.session = case.service.command(case.session['session_id'], {'op': op, 'request_id': str(uuid4()),
                                'expected_revision': case.session['revision'], **values})
        case.request = {**deepcopy(case.base), 'takeoffs': case.session['snapshot'], 'takeoffs_session_id': case.session['session_id']}

    def test_real_area_bundle_save_reopen_and_save_as_preserve_authority_and_legacy_inputs(self):
        case = self.case
        original = deepcopy(case.session['snapshot']['items'][0])
        case.library.save_as(case.request)
        first_bytes = case.target.read_bytes(); first = json.loads(first_bytes)
        self.assertEqual(first['version'], 2)
        self.assertEqual(first['takeoffs']['version'], 1)
        for key in ('estimate', 'calculators'):
            self.assertEqual(first[key], json.loads(case.legacy)[key])
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['items'][0], original)
        second = case.root / 'copy' / 'renamed.cf.json'; second.parent.mkdir()
        case.dialogs.selection = SaveSelection(str(second), None)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': reopened['takeoffs'], 'takeoffs_session_id': reopened['takeoffs_session_id']})
        self.assertEqual(case.target.read_bytes(), first_bytes)
        case.dialogs.opened = str(second)
        final = case.library.open_file()
        self.assertEqual(final['takeoffs_issues'], [])
        self.assertEqual(final['takeoffs']['items'][0], original)
        payload, _, _ = case.service.export(final['takeoffs_session_id'], 'csv', [self.item_id])
        self.assertIn(b'46.0', payload)

    def test_modified_area_source_reopens_for_diagnosis_without_export_authority(self):
        case = self.case
        case.library.save_as(case.request)
        saved = json.loads(case.target.read_bytes())
        folder = case.root / saved['takeoffs']['companion_folder']
        source = next(folder.rglob('*.pdf'))
        source.write_bytes(source.read_bytes() + b'\nchanged evidence\n')
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertTrue(reopened['takeoffs_issues'])
        self.assertEqual(reopened['takeoffs']['items'][0]['state'], 'draft')
        self.assertIsNone(reopened['takeoffs']['items'][0]['confirmation'])
        with self.assertRaises(ValidationError):
            case.service.export(reopened['takeoffs_session_id'], 'csv', [self.item_id])

    def test_layered_area_real_save_reopen_and_save_as_retain_source_and_v2_authority(self):
        case = self.case
        self.command('update_item', item_id=self.item_id, changes={'fields': {'layers': 3}})
        self.command('confirm_items', item_ids=[self.item_id])
        original = deepcopy(case.session['snapshot']['items'][0])
        self.assertEqual(original['quantity'], 1)
        self.assertEqual(len(original['member_ids']), 1)
        checks = original['confirmation']['checks']
        self.assertEqual((checks['engine'], checks['layers'], checks['net_area_m2'], checks['total_area_m2']),
                         ('takeoffs-area-v2', 3, 46, 138))
        case.library.save_as(case.request)
        first_bytes = case.target.read_bytes()
        first = json.loads(first_bytes)
        for key in ('estimate', 'calculators'):
            self.assertEqual(first[key], json.loads(case.legacy)[key])
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['items'][0], original)
        second = case.root / 'layers-copy' / 'renamed.cf.json'; second.parent.mkdir()
        case.dialogs.selection = SaveSelection(str(second), None)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': reopened['takeoffs'],
                              'takeoffs_session_id': reopened['takeoffs_session_id']})
        case.dialogs.opened = str(second)
        final = case.library.open_file()
        self.assertEqual(final['takeoffs_issues'], [])
        self.assertEqual(final['takeoffs']['items'][0], original)
        self.assertEqual(case.target.read_bytes(), first_bytes)


if __name__ == '__main__':
    unittest.main()
