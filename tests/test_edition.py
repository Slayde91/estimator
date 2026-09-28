"""Reduced desktop edition boundaries without changing any live user data."""

import base64
import builtins
from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ROOT, ValidationError
from estimator.edition import (TAKEOFF_ASSETS, TAKEOFF_PROJECT_ERROR, excluded_route,
                               features, render_index, require_project_edition)
from estimator.native_dialogs import SaveSelection
from estimator.project_file import (assert_project_overwrite, export_project,
                                    import_project, load_project_bytes, project_summary)
from estimator.project_library import ProjectLibrary, file_fingerprint
from estimator.server import create_server
from estimator.storage import Store


def no_takeoff_imports():
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        if any(part.startswith('takeoff_') for part in name.split('.')):
            raise AssertionError('Standard edition imported ' + name)
        return original(name, *args, **kwargs)

    return patch('builtins.__import__', side_effect=guarded)


def database_rows(store):
    with store.connect() as db:
        names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        return {name: db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall()
                for name in names}


def takeoff_project(payload, internal_version=1):
    project = json.loads(payload)
    project['version'] = 2
    project['takeoffs'] = {'version': internal_version, 'project_id': str(uuid4()), 'revision': 0,
                          'documents': [], 'calibrations': [], 'items': [], 'transfers': [],
                          'render_checks': [], 'audit_head': None}
    if internal_version == 2:
        project['takeoffs'].update(physical=None, image_extractions=[])
    return json.dumps(project).encode()


class Dialogs:
    selection = None
    opened = None

    def __init__(self):
        self.calls = []

    def choose_save(self, *args):
        self.calls.append('save')
        return self.selection

    def choose_open(self, *args):
        self.calls.append('open')
        return self.opened


class EditionPolicyTests(unittest.TestCase):
    def test_explicit_capabilities_and_routes_fail_closed(self):
        self.assertEqual(features('full'), {'takeoffs': True})
        self.assertEqual(features('standard'), {'takeoffs': False})
        for invalid in ('', 'Full', 'desktop', None, False, []):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                features(invalid)
        for route in [*TAKEOFF_ASSETS, '/api/takeoffs', '/api/takeoffs/sessions',
                      '/vendor/pdfjs', '/vendor/pdfjs/build/pdf.mjs']:
            self.assertTrue(excluded_route(route, 'standard'))
            self.assertFalse(excluded_route(route, 'full'))
        for route in ('/api/penetration', '/penetration.js', '/calculators.js', '/api/libraries'):
            self.assertFalse(excluded_route(route, 'standard'))
        with self.assertRaises(ValidationError), patch('estimator.server.Store') as store:
            create_server(0, edition='typo')
        store.assert_not_called()

    def test_standard_startup_preserves_existing_user_and_takeoff_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = Store(root / 'existing.sqlite3')
            with store.connect() as db:
                db.execute('CREATE TABLE takeoff_approvals (id TEXT PRIMARY KEY, receipt TEXT)')
                db.execute("INSERT INTO takeoff_approvals VALUES('original','retain opaque future data')")
                db.execute("INSERT INTO quotes VALUES('legacy','Frozen estimate','original-date','original bytes')")
                db.execute("INSERT INTO calculator_states VALUES('steel_board','legacy overrides','original-date')")
            before = database_rows(store)
            with no_takeoff_imports():
                server = create_server(0, store.path, library_directory=root / 'reference-library', edition='standard')
                server.server_close()
            after = database_rows(store)
            for name, rows in before.items():
                self.assertEqual(after[name], rows, name)
            self.assertFalse((root / 'takeoffs').exists())

    def test_template_removes_only_reviewed_blocks_and_detects_drift(self):
        payload = (ROOT / 'static/index.html').read_bytes()
        self.assertEqual(render_index(payload, 'full'), payload)
        standard = render_index(payload, 'standard')
        for forbidden in (b'/takeoff', b'data-view="takeoffs"', b'id="view-takeoffs"'):
            self.assertNotIn(forbidden, standard)
        for required in (b'/penetration.js', b'/calculators.js', b'/libraries.js', b'id="view-estimate"'):
            self.assertIn(required, standard)
        for broken in (payload.replace(b'TAKEOFFS:START', b'TAKEOFFS:WRONG', 1),
                       payload + b'<script src="/takeoffs.js"></script>'):
            with self.assertRaises(ValidationError):
                render_index(broken, 'standard')


class StandardProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary) / 'source.sqlite3')
            cls.payload = export_project(store, {
                'estimate': {'project_no': 'CF-legacy', 'client': 'Frozen client',
                             'inputs': {'B15': 123.456789}, 'measurements': 'Retain exact notes'},
                'calculators': {'steel_board': {'inputs': {'EXTRA BOARDS': {'A45': 'Legacy allowance'}}}},
            })
        value = json.loads(cls.payload)
        cls.request = {'estimate': value['estimate'], 'calculators': {
            key: {field: draft[field] for field in ('inputs', 'schedule_rows')}
            for key, draft in value['calculators'].items()}}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = Store(self.root / 'state.sqlite3')
        self.dialogs = Dialogs()
        self.library = ProjectLibrary(self.store, self.dialogs, edition='standard')
        self.addCleanup(self.library.close)

    def test_legacy_roundtrip_keeps_every_calculator_value_and_frozen_pricing(self):
        before = database_rows(self.store)
        with no_takeoff_imports():
            loaded = load_project_bytes(self.store, self.payload, edition='standard')
            result = export_project(self.store, self.request, edition='standard')
        self.assertEqual(json.loads(result), json.loads(self.payload))
        self.assertEqual(loaded['estimate']['configuration'], self.request['estimate']['configuration'])
        self.assertEqual(loaded['calculators']['steel_board']['inputs']['EXTRA BOARDS']['A45'], 'Legacy allowance')
        self.assertEqual(database_rows(self.store), before)

    def test_incompatible_files_fail_before_calculation_or_takeoff_import(self):
        before = database_rows(self.store)
        variants = [takeoff_project(self.payload, version) for version in (1, 2)]
        for alteration in ({'version': 2}, {'takeoffs': None}, {'takeoffs_session_id': 'untrusted'}):
            variants.append(json.dumps({**json.loads(self.payload), **alteration}).encode())
        with no_takeoff_imports(), patch.object(self.store, 'prepare_quote', side_effect=AssertionError('calculated')):
            for payload in variants:
                with self.subTest(payload=payload[:80]):
                    for action in (
                            lambda: load_project_bytes(self.store, payload, edition='standard'),
                            lambda: project_summary(payload, edition='standard'),
                            lambda: import_project(self.store, 'project.json', base64.b64encode(payload).decode(), edition='standard')):
                        with self.assertRaisesRegex(ValidationError, 'TAKEOFFS'):
                            action()
        self.assertEqual(database_rows(self.store), before)

    def test_save_inputs_reject_before_dialog_or_any_state_mutation(self):
        before = database_rows(self.store)
        with no_takeoff_imports(), patch.object(self.store, 'prepare_quote', side_effect=AssertionError('calculated')):
            for extra in ({'takeoffs': None}, {'takeoffs_session_id': 'x'}, {'version': 2}):
                request = {**self.request, **extra}
                for action in (lambda: export_project(self.store, request, edition='standard'),
                               lambda: self.library.save_as(request), lambda: self.library.save(request)):
                    with self.assertRaisesRegex(ValidationError, 'TAKEOFFS'):
                        action()
        self.assertEqual(self.dialogs.calls, [])
        self.assertEqual(database_rows(self.store), before)

    def test_native_open_and_folder_listing_never_authorize_incompatible_projects(self):
        path = self.root / 'Takeoff.json'
        path.write_bytes(takeoff_project(self.payload, 2))
        self.store.set_project_folder(self.root)
        before = database_rows(self.store)
        self.dialogs.opened = str(path)
        with no_takeoff_imports(), self.assertRaisesRegex(ValidationError, 'TAKEOFFS'):
            self.library.open_file()
        listing = self.library.listing(refresh=True)
        self.assertEqual(listing['files'], [])
        self.assertTrue(any('TAKEOFFS' in row['error'] for row in listing['errors']))
        path.write_bytes(self.payload)
        identifier = self.library.listing(refresh=True)['files'][0]['id']
        replacement = takeoff_project(self.payload, 1)
        path.write_bytes(replacement)
        with no_takeoff_imports(), self.assertRaisesRegex(ValidationError, 'TAKEOFFS'):
            self.library.load(identifier)
        self.assertEqual(path.read_bytes(), replacement)
        self.assertEqual(self.library._save_targets, {})
        self.assertEqual(database_rows(self.store), before)

    def test_save_as_and_save_cannot_erase_actual_takeoff_target_or_companion(self):
        path = self.root / 'Protected.json'
        companion = self.root / '.ceasefire-evidence' / 'retained.bin'
        companion.parent.mkdir()
        companion.write_bytes(b'preserve all original evidence')
        before = database_rows(self.store)
        for value in (takeoff_project(self.payload, 1), takeoff_project(self.payload, 2),
                      json.dumps({**json.loads(self.payload), 'version': 2}).encode(),
                      b'{"format":"ceasefire-project","version":2,'):
            path.write_bytes(value)
            self.dialogs.selection = SaveSelection(str(path), file_fingerprint(path))
            with self.assertRaises(ValidationError), patch('estimator.project_library._atomic_write') as write:
                self.library.save_as(self.request)
            write.assert_not_called()
            # Also defend Save if an old capability exists for an incompatible file.
            self.library._save_targets['retained-capability'] = self.dialogs.selection
            with self.assertRaises(ValidationError), patch('estimator.project_library._atomic_write') as write:
                self.library.save({**self.request, 'save_token': 'retained-capability'})
            write.assert_not_called()
            self.assertEqual(path.read_bytes(), value)
            self.assertEqual(companion.read_bytes(), b'preserve all original evidence')
            self.assertEqual(database_rows(self.store), before)

    def test_existing_full_edition_preservation_and_standard_ordinary_save_remain(self):
        require_project_edition({'version': 2, 'takeoffs': {}}, 'full')
        assert_project_overwrite(takeoff_project(self.payload, 2), edition='full')
        path = self.root / 'Ordinary.json'
        self.dialogs.selection = SaveSelection(str(path), None)
        with no_takeoff_imports():
            saved = self.library.save_as(deepcopy(self.request))
            self.library.save({**deepcopy(self.request), 'save_token': saved['file']['save_token']})
        self.assertEqual(json.loads(path.read_bytes()), json.loads(self.payload))


class StandardHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.dialogs = Dialogs()
        with no_takeoff_imports():
            cls.server = create_server(0, cls.root / 'state.sqlite3', cls.dialogs,
                                       library_directory=cls.root / 'reference-library', edition='standard')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.store = Store(cls.root / 'state.sqlite3')

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=60)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_server_excludes_service_assets_routes_and_feature_tables(self):
        self.assertFalse((self.root / 'takeoffs').exists())
        self.assertFalse(any(name.startswith('takeoff_') for name in database_rows(self.store)))
        with no_takeoff_imports():
            for route in [*TAKEOFF_ASSETS, *('/static' + path for path in TAKEOFF_ASSETS),
                          '/vendor/pdfjs/build/pdf.mjs', '/static/vendor/pdfjs/build/pdf.mjs',
                          '/api/takeoffs/sessions', '/api/takeoffs', '/takeoffs.js?edition=full']:
                for method in ('GET', 'POST', 'HEAD'):
                    self.assertEqual(self.request(method, route, {} if method == 'POST' else None)[0], 404)
            status, headers, payload = self.request('GET', '/')
            self.assertEqual(status, 200)
            self.assertNotIn(b'/takeoff', payload)
            self.assertIn(b'/penetration.js', payload)
            self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
            status, _, payload = self.request('GET', '/api/bootstrap')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload)['features'], {'takeoffs': False})
            self.assertEqual(json.loads(payload)['edition'], 'standard')

    def test_calculators_pricing_firestopping_and_reports_remain_available(self):
        before = database_rows(self.store)
        with no_takeoff_imports():
            for route in ('/api/calculators', '/api/calculators/steel_board', '/api/penetration',
                          '/api/configuration', '/api/libraries', '/penetration.js', '/calculators.js'):
                self.assertEqual(self.request('GET', route)[0], 200, route)
            status, _, payload = self.request('POST', '/api/calculate', {'inputs': {'B15': 12.25}})
            self.assertEqual(status, 200)
            self.assertIn('summary', json.loads(payload))
            status, _, payload = self.request('POST', '/api/project/export', {'estimate': {'title': 'Normal'}})
            self.assertEqual(status, 200)
            status, _, loaded = self.request('POST', '/api/project/import', {
                'filename': 'project.json', 'content_base64': base64.b64encode(payload).decode()})
            self.assertEqual(status, 200)
            self.assertNotIn('takeoffs', json.loads(loaded))
        self.assertEqual(database_rows(self.store), before)

    def test_http_import_and_save_payloads_cannot_bypass_edition(self):
        before = database_rows(self.store)
        with no_takeoff_imports():
            for route in ('/api/project/save', '/api/project/save-as', '/api/project/export'):
                status, _, payload = self.request('POST', route, {'estimate': {}, 'takeoffs': None})
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(payload)['error'], TAKEOFF_PROJECT_ERROR)
            status, _, payload = self.request('POST', '/api/project/import', {
                'filename': 'project.json', 'content_base64': base64.b64encode(b'{"version":2}').decode()})
            self.assertEqual(status, 400)
            self.assertEqual(json.loads(payload)['error'], TAKEOFF_PROJECT_ERROR)
        self.assertEqual(self.dialogs.calls, [])
        self.assertEqual(database_rows(self.store), before)


if __name__ == '__main__':
    unittest.main()
