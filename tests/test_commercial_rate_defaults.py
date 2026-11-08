"""Shared future-document rates never become mutable document snapshots."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, RATE_DEFAULTS, default_fields
from estimator.commercial_rate_defaults import CommercialRateDefaults, PREFERENCE
from estimator.server import create_server
from estimator.storage import Store


class RateDefaultsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'state.sqlite3'
        self.store = Store(self.path)
        self.rates = CommercialRateDefaults(self.store)

    def test_explicit_edits_persist_across_restart_without_mutating_old_fields(self):
        original = default_fields('quote')
        original_copy = deepcopy(original)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM app_preferences').fetchone()[0], 0)
        self.assertEqual(self.rates.read(), {'version': 1, 'rates': RATE_DEFAULTS})
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM app_preferences').fetchone()[0], 0)
        saved = self.rates.save({'expected_version': 1, 'rates': {'ordinary_time': '145.25', 'equipment': '22'}})
        restarted = CommercialRateDefaults(Store(self.path))
        self.assertEqual(restarted.read(), saved)
        self.assertEqual(saved['rates']['double_time'], RATE_DEFAULTS['double_time'])
        new = default_fields('quote', rates=restarted.read()['rates'])
        self.assertEqual(new['rate_schedule']['rates']['ordinary_time'], '145.25')
        self.assertEqual(new['rate_schedule']['acceptance'], dict.fromkeys(('accepted_by', 'title', 'signature', 'date'), ''))
        self.assertEqual(original, original_copy)
        self.assertEqual(default_fields('quote'), original_copy)

    def test_invalid_edits_never_replace_durable_values(self):
        saved = self.rates.save({'expected_version': 1, 'rates': {'ordinary_time': '140'}})
        for changes in ({}, {'unknown': '5'}, {'ordinary_time': ''}, {'materials': '-1'}, {'equipment': '1.0000001'},
                        {'ordinary_time': '1000000001'}, {'ordinary_time': True}, {'ordinary_time': 'NaN'},
                        {'ordinary_time': 'Infinity'}, {'ordinary_time': '0e100000000'}, {'ordinary_time': 'x' * 100}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.rates.save({'expected_version': saved['version'], 'rates': changes})
            self.assertEqual(self.rates.read(), saved)
        for version in (True, 0, None, '2'):
            with self.subTest(version=version), self.assertRaises(ValidationError):
                self.rates.save({'expected_version': version, 'rates': {'materials': '25'}})
        self.assertEqual(self.rates.read(), saved)

    def test_concurrent_versions_conflict_and_explicit_retry_merges_only_touched_keys(self):
        def save(changes):
            try:
                return self.rates.save({'expected_version': 1, 'rates': changes})
            except CommercialConflict:
                return None
        patches = [{'ordinary_time': '150'}, {'materials': '30'}]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, patches))
        self.assertEqual(sum(value is not None for value in results), 1)
        winner = self.rates.read()
        loser = patches[results.index(None)]
        confirmed = self.rates.save({'expected_version': winner['version'], 'rates': loser})
        self.assertEqual(confirmed['rates']['ordinary_time'], '150')
        self.assertEqual(confirmed['rates']['materials'], '30')
        self.assertEqual(confirmed['version'], 3)
        # A repeated request after its response was lost is a read-only no-op.
        self.assertEqual(self.rates.save({'expected_version': winner['version'], 'rates': loser}), confirmed)

    def test_corrupted_preference_fails_closed_and_retains_original_bytes(self):
        with self.store.connect() as db:
            db.execute('INSERT INTO app_preferences VALUES(?,?)', (PREFERENCE, 'broken'))
        with self.assertRaises(ValidationError):
            self.rates.read()
        with self.assertRaises(ValidationError):
            self.rates.save({'expected_version': 1, 'rates': {'ordinary_time': '150'}})
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT value FROM app_preferences WHERE key=?', (PREFERENCE,)).fetchone()[0], 'broken')


class RateDefaultsHTTPTests(unittest.TestCase):
    def test_live_server_routes_are_versioned_and_new_defaults_are_injected_only_at_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = create_server(0, root / 'state.sqlite3', library_directory=root / 'library')
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(path, body=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                try:
                    headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{server.server_port}'}
                    connection.request('GET' if body is None else 'POST', path,
                                       None if body is None else json.dumps(body), headers)
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            try:
                status, profile = request('/api/commercial/rate-defaults')
                self.assertEqual(status, 200)
                status, workspace = request('/api/certifications/workspaces', {})
                self.assertEqual(status, 201)
                body = {'workspace_id': workspace['workspace_id'], 'kind': 'quote'}
                status, old = request('/api/commercial/defaults', body)
                self.assertEqual(status, 200)
                self.assertEqual(old['fields']['rate_schedule']['rates']['ordinary_time'], '130')
                status, saved = request('/api/commercial/rate-defaults', {'expected_version': profile['version'], 'rates': {'ordinary_time': '155'}})
                self.assertEqual(status, 200)
                status, new = request('/api/commercial/defaults', body)
                self.assertEqual(status, 200)
                self.assertEqual(new['fields']['rate_schedule']['rates']['ordinary_time'], '155')
                self.assertEqual(old['fields']['rate_schedule']['rates']['ordinary_time'], '130')
                self.assertEqual(request('/api/commercial/rate-defaults', {'expected_version': 1, 'rates': {'ordinary_time': '160'}})[0], 409)
                self.assertEqual(request('/api/commercial/rate-defaults?workspace=untrusted')[0], 400)
                self.assertEqual(request('/api/commercial/rate-defaults', {'expected_version': saved['version'], 'rates': {'ordinary_time': ''}})[0], 400)
                self.assertEqual(request('/api/commercial/rate-defaults')[1], saved)
            finally:
                server.shutdown(); server.server_close(); thread.join()
