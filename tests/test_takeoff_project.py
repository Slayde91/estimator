"""Portable evidence transactions must preserve the existing quote contract."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from reportlab.pdfgen import canvas
from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.project_file import export_project, load_project_bytes, project_summary
from estimator.project_library import ProjectLibrary, file_fingerprint
from estimator.storage import Store
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_workspace import TakeoffService


class Dialogs:
    selection = None
    opened = None
    def choose_save(self, directory, filename):
        return self.selection
    def choose_open(self, directory):
        return self.opened


class TakeoffProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as directory:
            source = Store(Path(directory) / 'source.sqlite3')
            cls.legacy = export_project(source, {'estimate': {'title': 'Takeoff QA', 'inputs': {'B15': 1.125}}})
            saved = json.loads(cls.legacy)
            cls.base = {'estimate': saved['estimate'], 'calculators': {
                key: {k: value[k] for k in ('inputs', 'schedule_rows')} for key, value in saved['calculators'].items()}}
        stream = BytesIO(); drawing = canvas.Canvas(stream, pagesize=(500, 500), invariant=True)
        drawing.drawString(50, 450, 'Synthetic steel B17, 8.35 metres'); drawing.line(50, 300, 450, 300)
        drawing.showPage(); drawing.save(); cls.pdf = stream.getvalue()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / 'state.sqlite3')
        self.documents = TakeoffDocuments(self.root / 'staging')
        self.addCleanup(self.documents.close)
        self.service = TakeoffService(self.store, self.documents)
        self.dialogs = Dialogs()
        self.library = ProjectLibrary(self.store, self.dialogs, takeoffs=self.service)
        self.addCleanup(self.library.close)
        self.session = self.service.open()
        upload = self.documents.begin_upload(self.session['session_id'], 'source.pdf', len(self.pdf))
        self.documents.write_chunk(self.session['session_id'], upload['upload_id'], 0, self.pdf)
        document = self.documents.finish_upload(self.session['session_id'], upload['upload_id'])
        self.session = self.service.add_document(self.session['session_id'], document, 0)
        self.request = {**deepcopy(self.base), 'takeoffs': self.session['snapshot'], 'takeoffs_session_id': self.session['session_id']}
        self.target = self.root / 'project.cf.json'
        self.dialogs.selection = SaveSelection(str(self.target), None)

    def test_wrong_project_extension_is_rejected_before_overwrite_reads_or_evidence_publication(self):
        target = self.root / 'legacy.json'
        target.write_bytes(self.legacy)
        self.dialogs.selection = SaveSelection(str(target), file_fingerprint(target))
        before = {path.relative_to(self.root).as_posix() for path in self.root.rglob('*')}
        with patch.object(self.library, '_preserve_takeoffs', side_effect=AssertionError('Legacy file was inspected')), \
                patch.object(self.library, '_publish_takeoffs', side_effect=AssertionError('Evidence was published')), \
                self.assertRaisesRegex(ValidationError, r'\.cf\.json'):
            self.library.save_as(self.request)
        self.assertEqual(target.read_bytes(), self.legacy)
        self.assertEqual({path.relative_to(self.root).as_posix() for path in self.root.rglob('*')}, before)
        self.assertFalse(self.target.exists())
        self.assertIsNone(self.store.project_folder())

    def test_cached_legacy_save_target_is_rejected_before_fingerprint_or_evidence_publication(self):
        saved = self.library.save_as(self.request)
        token = saved['file']['save_token']
        target = self.root / 'legacy.json'
        target.write_bytes(self.legacy)
        self.library._save_targets[token] = SaveSelection(str(target), file_fingerprint(target))
        before = {path.relative_to(self.root).as_posix() for path in self.root.rglob('*')}
        with patch('estimator.project_library.file_fingerprint', side_effect=AssertionError('Legacy file was inspected')), \
                patch.object(self.library, '_preserve_takeoffs', side_effect=AssertionError('Legacy evidence was inspected')), \
                patch.object(self.library, '_publish_takeoffs', side_effect=AssertionError('Evidence was published')), \
                self.assertRaisesRegex(ValidationError, r'\.cf\.json'):
            self.library.save({**self.request, 'save_token': token})
        self.assertEqual(target.read_bytes(), self.legacy)
        self.assertEqual({path.relative_to(self.root).as_posix() for path in self.root.rglob('*')}, before)

    def test_save_reopen_and_save_as_keep_originals_and_legacy_inputs(self):
        saved = self.library.save_as(self.request)
        payload = self.target.read_bytes(); value = json.loads(payload)
        self.assertEqual(value['version'], 2)
        original = json.loads(self.legacy)
        for key in ('estimate', 'calculators'):
            self.assertEqual(value[key], original[key])
        self.assertEqual(project_summary(payload)['estimate']['title'], original['estimate']['title'])
        companion = self.root / value['takeoffs']['companion_folder']
        self.assertTrue(companion.is_dir())
        self.assertTrue(any(p.read_bytes() == self.pdf for p in companion.rglob('*.pdf')))
        self.dialogs.opened = str(self.target)
        reopened = self.library.open_file()
        self.assertEqual(reopened['takeoffs']['project_id'], value['takeoffs']['project_id'])
        self.assertEqual(reopened['takeoffs_issues'], [])
        target2 = self.root / 'copied' / 'copy.cf.json'; target2.parent.mkdir()
        self.dialogs.selection = SaveSelection(str(target2), None)
        request = {**deepcopy(self.base), 'takeoffs': reopened['takeoffs'], 'takeoffs_session_id': reopened['takeoffs_session_id']}
        self.library.save_as(request)
        self.assertTrue((target2.parent / value['takeoffs']['companion_folder']).is_dir())
        self.assertEqual(self.target.read_bytes(), payload)
        self.assertIn('save_token', saved['file'])

    def test_cancel_does_not_create_project_or_companion(self):
        self.dialogs.selection = None
        self.assertTrue(self.library.save_as(self.request)['cancelled'])
        self.assertFalse(self.target.exists())
        self.assertFalse((self.root / '.ceasefire-evidence').exists())

    def test_post_commit_session_failure_reports_saved_with_warning(self):
        with patch.object(self.service, 'saved_source', side_effect=ValidationError('source moved')):
            result = self.library.save_as(self.request)
        self.assertFalse(result['cancelled'])
        self.assertIn('was saved', result['warning'])
        self.assertEqual(json.loads(self.target.read_bytes())['version'], 2)

    def test_failed_atomic_json_save_leaves_previous_project_unchanged(self):
        saved = self.library.save_as(self.request)
        before = self.target.read_bytes()
        request = {**self.request, 'save_token': saved['file']['save_token']}
        with patch('estimator.project_library._atomic_write', side_effect=OSError('simulated full disk')):
            with self.assertRaises(OSError):
                self.library.save(request)
        self.assertEqual(self.target.read_bytes(), before)

    def test_forged_snapshot_and_old_browser_cannot_replace_takeoffs(self):
        tampered = deepcopy(self.request)
        tampered['takeoffs']['revision'] += 1
        with self.assertRaises(ValidationError):
            self.library.save_as(tampered)
        saved = self.library.save_as(self.request)
        with self.assertRaisesRegex(ValidationError, 'takeoffs'):
            self.library.save({**deepcopy(self.base), 'save_token': saved['file']['save_token']})

    def test_missing_companion_reopens_for_diagnosis_and_blocks_save(self):
        self.library.save_as(self.request)
        source = json.loads(self.target.read_bytes())
        folder = self.root / source['takeoffs']['companion_folder']
        # Simulate a user moving the evidence folder, without deleting any evidence.
        folder.rename(folder.with_name(folder.name + '-moved'))
        self.dialogs.opened = str(self.target)
        reopened = self.library.open_file()
        self.assertTrue(reopened['takeoffs_issues'])
        with self.assertRaises(ValidationError):
            self.service.capture(reopened['takeoffs_session_id'], reopened['takeoffs'])

    def test_project_version_contract_does_not_silently_drop_evidence(self):
        request = {key: value for key, value in self.request.items() if key != 'takeoffs_session_id'}
        version2 = json.loads(export_project(self.store, request))
        version2['version'] = 1
        with self.assertRaises(ValidationError):
            load_project_bytes(self.store, json.dumps(version2).encode())
        version1 = json.loads(self.legacy)
        self.assertEqual(version1['version'], 1)
        self.assertNotIn('takeoffs', load_project_bytes(self.store, self.legacy))


if __name__ == '__main__':
    unittest.main()
