"""Older clients cannot silently erase persistent library row identities."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.penetration_calculator import source_model
from estimator.project_file import _portable_penetration, load_project_bytes
from estimator.project_library import ProjectLibrary, _preserve_penetration_inputs, file_fingerprint
from estimator.storage import Store


class _Chooser:
    selection = None

    def choose_save(self, initial_directory, filename):
        return self.selection


class PenetrationLibrarySaveGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'project.json'
        self.globals = {'J': 'No', 'K': None, 'L': 0, 'M': 0}
        self.row = {'id': 'line-1', 'inputs': {'T': 'Keep Ø65 原文', 'O': 2.1234567890123, 'AJ': 25},
                    'library_item_id': 'pkb-row-4'}
        self.draft = {'globals': deepcopy(self.globals), 'rows': [deepcopy(self.row)]}
        self.snapshot = {'draft': deepcopy(self.draft), 'composer': deepcopy(self.draft)}

    def write_minimal(self, penetration):
        payload = json.dumps({'format': 'ceasefire-project', 'penetration': penetration}).encode()
        self.path.write_bytes(payload)
        return payload

    def test_request_marker_is_exact_and_never_accepted_in_a_saved_snapshot(self):
        request = {**deepcopy(self.snapshot), 'library_tracking_version': 1}
        before = deepcopy(request)
        portable = _portable_penetration(request)
        self.assertNotIn('library_tracking_version', portable)
        self.assertEqual(portable['draft']['rows'][0], self.row)
        self.assertEqual(portable['composer']['rows'][0], self.row)
        self.assertEqual(request, before)
        self.assertEqual(_portable_penetration(portable, saved=True), portable)
        with self.assertRaises(ValidationError):
            _portable_penetration({**portable, 'library_tracking_version': 1}, saved=True)
        for invalid in (None, True, False, 0, 2, 1.0, '1', [], {}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValidationError, 'tracking version'):
                _portable_penetration({**request, 'library_tracking_version': invalid})

    def test_guard_checks_both_scopes_and_preserves_the_older_composer_guard(self):
        for scope in ('draft', 'composer'):
            previous = deepcopy(self.snapshot)
            del previous['composer' if scope == 'draft' else 'draft']['rows'][0]['library_item_id']
            before = self.write_minimal(previous)
            stale = deepcopy(previous)
            del stale[scope]['rows'][0]['library_item_id']
            with self.subTest(scope=scope), self.assertRaisesRegex(ValidationError, 'Refresh the application'):
                _preserve_penetration_inputs(self.path, {'penetration': stale})
            self.assertEqual(self.path.read_bytes(), before)
        for request in ({}, {'penetration': {'draft': self.draft, 'library_tracking_version': 1}}):
            with self.subTest(request=request), self.assertRaisesRegex(ValidationError, 'Refresh the application'):
                _preserve_penetration_inputs(self.path, request)

    def test_aware_deletions_and_reused_row_ids_are_not_rebound(self):
        before = self.write_minimal(self.snapshot)
        replacement = {'id': self.row['id'], 'inputs': {'T': 'Unrelated replacement', 'O': 0}}
        for rows in ([], [replacement]):
            request = {'penetration': {'draft': {'globals': self.globals, 'rows': deepcopy(rows)},
                                      'composer': {'globals': self.globals, 'rows': [deepcopy(replacement)]},
                                      'library_tracking_version': 1}}
            original = deepcopy(request)
            _preserve_penetration_inputs(self.path, request)
            self.assertEqual(request, original)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertTrue(all('library_item_id' not in row for row in request['penetration']['draft']['rows']))

    def test_legacy_projects_without_library_metadata_still_accept_older_clients(self):
        previous = deepcopy(self.snapshot)
        for draft in previous.values():
            del draft['rows'][0]['library_item_id']
        before = self.write_minimal(previous)
        _preserve_penetration_inputs(self.path, {'penetration': deepcopy(previous)})
        self.assertEqual(self.path.read_bytes(), before)
        # Original schedule-only projects also remain editable without a composer.
        self.write_minimal({'draft': previous['draft']})
        _preserve_penetration_inputs(self.path, {'penetration': {'draft': previous['draft']}})

    def test_native_save_and_save_as_reject_stale_clients_then_allow_intentional_removal(self):
        store = Store(self.root / 'disposable.sqlite3')
        chooser = _Chooser()
        library = ProjectLibrary(store, chooser)
        self.addCleanup(library.close)
        request = {'estimate': {'title': 'Library identity'}, 'calculators': {},
                   'penetration': {**deepcopy(self.snapshot), 'library_tracking_version': 1}}
        chooser.selection = SaveSelection(str(self.path), None)
        saved = library.save_as(request)
        original = self.path.read_bytes()
        stored = json.loads(original)
        self.assertNotIn('library_tracking_version', stored['penetration'])
        self.assertEqual(stored['penetration']['source_sha256'], source_model()['source']['sha256'])
        request['estimate'] = deepcopy(stored['estimate'])
        request['calculators'] = {key: {field: deepcopy(value[field]) for field in ('inputs', 'schedule_rows')}
                                  for key, value in stored['calculators'].items()}
        stale = deepcopy(request)
        del stale['penetration']['library_tracking_version']
        for key in ('draft', 'composer'):
            del stale['penetration'][key]['rows'][0]['library_item_id']
        with self.assertRaisesRegex(ValidationError, 'Refresh the application'):
            library.save({**stale, 'save_token': saved['file']['save_token']})
        self.assertEqual(self.path.read_bytes(), original)
        chooser.selection = SaveSelection(str(self.path), file_fingerprint(self.path))
        with self.assertRaisesRegex(ValidationError, 'Refresh the application'):
            library.save_as(stale)
        self.assertEqual(self.path.read_bytes(), original)
        aware = deepcopy(stale)
        aware['penetration']['library_tracking_version'] = 1
        aware['penetration']['draft']['rows'] = []
        # The rejected stale write did not consume the capability.
        removed = library.save({**aware, 'save_token': saved['file']['save_token']})
        self.assertEqual(removed['project']['penetration']['draft']['rows'], [])
        self.assertNotIn('library_item_id', removed['project']['penetration']['composer']['rows'][0])
        self.assertNotEqual(removed['file']['save_token'], saved['file']['save_token'])
        aware['penetration']['draft']['rows'] = [{'id': 'line-1', 'inputs': {'T': 'New unrelated row', 'O': 0}}]
        chooser.selection = SaveSelection(str(self.path), file_fingerprint(self.path))
        reused = library.save_as(aware)
        reopened = load_project_bytes(store, self.path.read_bytes())
        self.assertEqual(reopened['penetration'], reused['project']['penetration'])
        self.assertNotIn('library_item_id', reopened['penetration']['draft']['rows'][0])
        self.assertNotIn('library_tracking_version', reopened['penetration'])
        self.assertEqual(reopened['penetration']['draft']['rows'][0]['inputs']['T'], 'New unrelated row')
        self.assertEqual(reopened['penetration']['draft']['rows'][0]['inputs']['O'], 0)


if __name__ == '__main__':
    unittest.main()
