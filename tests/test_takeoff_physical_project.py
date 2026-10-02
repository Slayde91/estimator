"""Real image extraction, native project transactions and draft portability."""

from copy import deepcopy
from hashlib import sha256
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.takeoff_model import audit_affected, upgrade_snapshot
from estimator.takeoff_physical import new_graph
from estimator.takeoff_physical_operations import prepare_changes
from tests import test_takeoff_project as fixtures
from tests.test_takeoff_images_worker import make_pdf


class PhysicalProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = fixtures.TakeoffProjectTests()
        self.case.pdf = make_pdf(pages=2)
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        case = self.case
        document = case.session['snapshot']['documents'][0]
        case.session = case.service.extract_images(case.session['session_id'], {
            'request_id': str(uuid4()), 'expected_revision': case.session['revision'],
            'document_id': document['id'], 'first_page': 1, 'page_count': 2})
        descriptor = case.session['snapshot']['image_extractions'][0]
        self.manifest = case.documents.images.read(descriptor, document, verify_assets=True)
        occurrence = self.manifest['occurrences'][0]
        asset = self.manifest['assets'][0]
        evidence = {'document_id': document['id'], 'document_sha256': document['sha256'],
                    'page': occurrence['page'], 'image_id': asset['id'], 'image_sha256': asset['rendition']['sha256'],
                    'occurrence_id': occurrence['id'], 'region': occurrence['quad_pdf']}
        self.ids = [str(uuid4()) for _ in range(4)]
        commands = []
        for index, kind in enumerate(('barrier', 'defect', 'opening', 'service')):
            entity = {'id': self.ids[index], 'fields': {'label': 'Synthetic '+kind},
                      'evidence': [deepcopy(evidence)], 'uncertainty': {'state': 'human_review_required', 'note': 'Draft only'}}
            if index:
                entity[('barrier_id', 'defect_id', 'opening_id')[index-1]] = self.ids[index-1]
            if kind == 'service':
                entity['quantity'] = 2
            commands.append({'op': 'create', 'kind': kind, 'entity': entity})
        # Reconstruct an authentic legacy fixture through the original low-level
        # model, with a real audit event. The active editor no longer creates v1.
        before = deepcopy(case.session['snapshot'])
        legacy = {**before, 'physical': new_graph(before['project_id'], version=1)}
        after = upgrade_snapshot(before)
        after['physical'] = prepare_changes(legacy, commands, lambda ref: None)['graph']
        case.session = case.service._commit(case.session['session_id'], {
            'op': 'apply_physical', 'expected_revision': before['revision'],
            'request_id': str(uuid4())}, before, after)
        self.refresh_request()

    def refresh_request(self):
        case = self.case
        case.request = {**deepcopy(case.base), 'takeoffs': case.session['snapshot'], 'takeoffs_session_id': case.session['session_id']}

    def test_save_reopen_save_as_preserves_graph_exact_images_and_frozen_estimate(self):
        case = self.case
        original_graph = deepcopy(case.session['snapshot']['physical'])
        case.library.save_as(case.request)
        first_bytes = case.target.read_bytes(); first = json.loads(first_bytes)
        self.assertEqual(first['version'], 2)
        self.assertEqual(first['takeoffs']['version'], 2)
        for key in ('estimate', 'calculators'):
            self.assertEqual(first[key], json.loads(case.legacy)[key])
        self.assertEqual(first['takeoffs']['physical'], original_graph)
        self.assertEqual(first['takeoffs']['physical']['state'], 'draft')
        folder = case.root / first['takeoffs']['companion_folder']
        for entry in self.manifest['files']:
            retained = (folder / 'image-files' / entry['relative_path']).read_bytes()
            self.assertEqual(len(retained), entry['size'])
            self.assertEqual(sha256(retained).hexdigest(), entry['sha256'])
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['physical'], original_graph)
        with self.assertRaisesRegex(ValidationError, 'read-only'):
            case.service.preview_physical(reopened['takeoffs_session_id'], {
                'expected_revision': reopened['takeoffs']['revision'],
                'commands': [{'op': 'delete', 'entity_id': self.ids[0], 'cascade': True}]})
        second = case.root / 'other' / 'renamed.json'; second.parent.mkdir()
        case.dialogs.selection = SaveSelection(str(second), None)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': reopened['takeoffs'],
                              'takeoffs_session_id': reopened['takeoffs_session_id']})
        self.assertEqual(case.target.read_bytes(), first_bytes)
        second_folder = second.parent / first['takeoffs']['companion_folder']
        for entry in self.manifest['files']:
            self.assertEqual((folder / 'image-files' / entry['relative_path']).read_bytes(),
                             (second_folder / 'image-files' / entry['relative_path']).read_bytes())
        case.dialogs.opened = str(second)
        final = case.library.open_file()
        self.assertEqual(final['takeoffs_issues'], [])
        payload, _, _ = case.service.export_physical(final['takeoffs_session_id'], 'csv')
        self.assertIn(b'UNAPPROVED DRAFT', payload)
        self.assertIn(self.ids[3].encode(), payload)
        self.assertEqual(final['takeoffs']['physical']['services'][0]['quantity'], 2)

    def test_image_tampering_reopens_for_diagnosis_and_cannot_be_hidden_by_cache(self):
        case = self.case
        case.library.save_as(case.request)
        saved = json.loads(case.target.read_bytes())
        folder = case.root / saved['takeoffs']['companion_folder']
        file = folder / 'image-files' / self.manifest['assets'][0]['rendition']['relative_path']
        file.write_bytes(b'changed image')
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertTrue(any(issue['code'] == 'IMAGE_EVIDENCE_UNAVAILABLE' for issue in reopened['takeoffs_issues']))
        self.assertEqual(reopened['takeoffs']['physical'], case.session['snapshot']['physical'])
        with self.assertRaises(ValidationError):
            case.service.capture(reopened['takeoffs_session_id'], reopened['takeoffs'])
        with self.assertRaises(ValidationError):
            case.service.export_physical(reopened['takeoffs_session_id'], 'xlsx')

    def test_image_publication_failure_preserves_previous_json(self):
        case = self.case
        saved = case.library.save_as(case.request)
        before = case.target.read_bytes()
        with patch.object(case.documents.images, 'publish', side_effect=OSError('simulated image disk exhaustion')):
            with self.assertRaises(OSError):
                case.library.save({**case.request, 'save_token': saved['file']['save_token']})
        self.assertEqual(case.target.read_bytes(), before)

    def test_save_as_rebind_covers_historical_only_images_and_documents(self):
        case = self.case
        before = deepcopy(case.session['snapshot'])
        after = deepcopy(before)
        after.update(revision=before['revision']+1, physical=None, image_extractions=[], documents=[])
        strip = lambda state: {key: value for key, value in state.items() if key != 'audit_head'}
        event = {'version': 2, 'project_id': before['project_id'], 'revision': after['revision'],
                 'previous': before['audit_head'], 'request_id': str(uuid4()), 'op': 'diagnostic_history_test',
                 'at': '2026-09-29T00:00:00Z', 'actor': {'kind': 'local-session', 'session_id': str(uuid4())},
                 'before': strip(before), 'after': strip(after), 'affected_ids': audit_affected(before, after)}
        after['audit_head'] = case.documents.put_blob(event)
        first = case.documents.publish(after, case.target)
        owner = str(uuid4())
        case.documents.bind_source(owner, first, case.target)
        other = case.root / 'copy' / 'project.json'; other.parent.mkdir()
        second = case.documents.publish(after, other)
        case.documents.bind_source(owner, second, other)
        folder = other.parent / second['companion_folder']
        image_path = folder / 'image-files' / self.manifest['assets'][0]['rendition']['relative_path']
        original = image_path.read_bytes(); image_path.write_bytes(b'damaged historical copy')
        with self.assertRaises(ValidationError):
            case.documents.assert_image_evidence(second, owner)
        image_path.write_bytes(original)
        pdf = next((folder / 'documents').iterdir()); pdf.write_bytes(b'damaged old PDF')
        with self.assertRaises(ValidationError):
            case.documents.assert_image_evidence(second, owner)


if __name__ == '__main__':
    unittest.main()
