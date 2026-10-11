"""PDF-only measurement uses exact source scales without quantity authority."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import math
import unittest
from uuid import uuid4

from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.takeoff_graphics import validate_history
from estimator.takeoff_model import validate_snapshot
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_project as projects


class PDFMeasureTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def proposal(self, **changes):
        case = self.case
        return {'mode': 'steel', 'document_id': case.doc['id'], 'source_sha256': case.doc['sha256'],
                'page': 1, 'kind': 'measure', 'geometry': {'points': [[20, 30], [50, 70], [110, 70]]},
                'text': '', 'appearance': {}, 'calibration_id': case.calibration_id, **changes}

    def create(self, **changes):
        return self.case.command('create_graphic', graphic=self.proposal(**changes))['created_graphic_id']

    def test_exact_length_no_quantity_results_or_other_authority(self):
        case = self.case; before = deepcopy(case.state['snapshot'])
        identifier = self.create()
        result = case.state['pdf_measure_results'][0]
        self.assertEqual(result['id'], identifier)
        self.assertEqual(result['length_m'], math.fsum([5, 6]))
        self.assertEqual(result['segments_m'], [5, 6])
        self.assertEqual(result['status'], 'current')
        self.assertEqual(case.state['item_results'], [])
        for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
            self.assertEqual(case.state['snapshot'][key], before[key])
        self.assertNotIn('length_m', case.state['snapshot']['graphics']['records'][0])

    def test_point_edit_delete_undo_retains_id_and_recomputes_one_revision(self):
        case = self.case; identifier = self.create(); revision = case.state['revision']
        case.command('update_graphic', graphic_id=identifier, changes={'geometry': {'points': [[20, 30], [120, 30]]}})
        self.assertEqual(case.state['revision'], revision+1)
        self.assertEqual(case.state['pdf_measure_results'][0]['length_m'], 10)
        case.command('undo')
        self.assertEqual(case.state['pdf_measure_results'][0]['length_m'], 11)
        case.command('delete_graphic', graphic_id=identifier)
        self.assertEqual(case.state['pdf_measure_results'], [])
        case.command('undo')
        self.assertEqual(case.state['pdf_measure_results'][0]['id'], identifier)
        self.assertGreater(case.state['pdf_measure_results'][0]['version'], 1)

    def test_missing_foreign_or_nonmeasure_calibration_rejected_atomically(self):
        case = self.case; before = deepcopy(case.state['snapshot'])
        for changes in ({'calibration_id': str(uuid4())}, {'kind': 'line'}, {'text': 'quantity'}, {'source_sha256': 'b'*64}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError): self.create(**changes)
            self.assertEqual(case.service.get(case.sid)['snapshot'], before)
        missing = self.proposal(); del missing['calibration_id']
        with self.assertRaises(ValidationError): case.command('create_graphic', graphic=missing)
        self.assertEqual(case.service.get(case.sid)['snapshot'], before)

    def test_viewport_crossing_and_wrong_page_scale_rejected(self):
        case = self.case
        viewport = str(uuid4())
        case.command('add_calibration', calibration={'id': viewport, 'document_id': case.doc['id'], 'page': 1,
            'points': [[30, 40], [60, 40]], 'distance_m': 30, 'uniform_scale': True, 'region': [30, 40, 60, 60]})
        before = deepcopy(case.state['snapshot'])
        for basis, points in ((case.calibration_id, [[20, 50], [100, 50]]), (viewport, [[40, 50], [100, 50]])):
            with self.subTest(basis=basis), self.assertRaises(ValidationError):
                self.create(calibration_id=basis, geometry={'points': points})
            self.assertEqual(case.service.get(case.sid)['snapshot'], before)
        self.create(calibration_id=viewport, geometry={'points': [[40, 50], [70, 50]]})
        self.assertEqual(case.state['pdf_measure_results'][0]['length_m'], 30)

    def test_retired_scale_stays_loadable_without_numeric_claim_until_explicit_rebind(self):
        case = self.case; identifier = self.create(); original = deepcopy(case.state['snapshot']['graphics'])
        reply = case.command('update_calibration', calibration_id=case.calibration_id, changes={'distance_m': 20})
        self.assertEqual(case.state['snapshot']['graphics'], original)
        result = case.state['pdf_measure_results'][0]
        self.assertEqual(result['status'], 'needs_review'); self.assertIsNone(result['length_m'])
        validate_snapshot(case.state['snapshot'])
        case.command('update_graphic', graphic_id=identifier, changes={'calibration_id': reply['revised_calibration_id']})
        self.assertEqual(case.state['pdf_measure_results'][0]['length_m'], 22)
        self.assertEqual(case.state['snapshot']['items'], [])

    def test_invalid_point_edit_and_forged_history_fail_without_state_mutation(self):
        case = self.case; identifier = self.create(); before = deepcopy(case.state['snapshot'])
        for geometry in ({'points': [[20, 30], [20, 30]]}, {'points': [[20, 30], [220, 30]]}):
            with self.assertRaises(ValidationError): case.command('update_graphic', graphic_id=identifier, changes={'geometry': geometry})
            self.assertEqual(case.service.get(case.sid)['snapshot'], before)
        event = deepcopy(case.documents.get_blob(before['audit_head']))
        event['after']['items'].append({'id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'cannot change measurements'): validate_history(event)

    def test_existing_calculator_item_confirmations_remain_exact(self):
        case = self.case; item_id = case.create(); case.confirm(item_id)
        before = deepcopy(case.state['snapshot'])
        before_results = deepcopy(case.state['item_results'])
        self.create()
        self.assertEqual(case.state['snapshot']['items'], before['items'])
        self.assertEqual(case.state['snapshot']['transfers'], before['transfers'])
        self.assertEqual(case.state['item_results'], before_results)
        self.assertEqual(case.state['snapshot']['items'][0]['quantity'], 2)


class PDFMeasurePortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): projects.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = projects.TakeoffProjectTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.doc = self.case.session['snapshot']['documents'][0]

    def command(self, op, **values):
        case = self.case
        case.session = case.service.command(case.session['session_id'], {'op': op, 'expected_revision': case.session['revision'], 'request_id': str(uuid4()), **values})
        return case.session

    def test_actual_pdf_save_reopen_preserves_visual_measure_and_original(self):
        case = self.case; calibration = str(uuid4())
        self.command('add_calibration', calibration={'id': calibration, 'document_id': self.doc['id'], 'page': 1,
            'points': [[50, 300], [450, 300]], 'distance_m': 8.35, 'uniform_scale': True})
        identifier = self.command('create_graphic', graphic={'mode': 'steel', 'document_id': self.doc['id'],
            'source_sha256': self.doc['sha256'], 'page': 1, 'kind': 'measure', 'geometry': {'points': [[50, 200], [450, 200]]},
            'text': '', 'appearance': {}, 'calibration_id': calibration})['created_graphic_id']
        before = deepcopy(case.session['snapshot'])
        payload, kind, filename = case.service.export_workspace(case.session['session_id'], 'marked-pdf', {
            'expected_revision': case.session['revision'], 'mode': 'steel', 'document_id': self.doc['id'], 'item_ids': []})
        rendered = PdfReader(BytesIO(payload)); text = '\n'.join(page.extract_text() for page in rendered.pages)
        self.assertIn('8.35 m', text); self.assertEqual(kind, 'application/pdf')
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)
        case.request.update(takeoffs=before); case.library.save_as(case.request)
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        self.assertEqual(opened['takeoffs']['graphics'], before['graphics'])
        self.assertEqual(opened['takeoffs']['items'], [])
        reopened = case.service.get(opened['takeoffs_session_id'])
        self.assertEqual(reopened['pdf_measure_results'][0]['id'], identifier)
        self.assertEqual(reopened['pdf_measure_results'][0]['length_m'], 8.35)
        self.assertEqual(sha256(case.documents.document_path(self.doc).read_bytes()).hexdigest(), self.doc['sha256'])
