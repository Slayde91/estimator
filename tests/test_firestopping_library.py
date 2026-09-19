"""Synthetic item editing: pricing capture, persistence and isolation boundaries."""

from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.catalog import ValidationError, configuration_catalog, validate_configuration
from estimator.firestopping_library import FirestoppingLibrary, LibraryConflict
from estimator.penetration_calculator import definition, source_model
from estimator.server import create_server
from estimator.storage import Store
from test_reference_library import sample_library


def editable_library(root):
    data, _, _ = sample_library(root)
    data['firestopping'] = {'source_sha256': 'a' * 64,
        'calculator_source_sha256': source_model()['source']['sha256'],
        'configuration': validate_configuration({'catalog': configuration_catalog({})})}
    for index, item in enumerate(data['libraries']['penetration']['items'], 1):
        item.update(library_id=f'FL-ID-{index:03d}', title=f'PKB-{index} — Copper service',
                    price={'amount': 150, 'currency': 'AUD', 'label': 'Workbook price'},
                    estimate={'draft': {'globals': {}, 'rows': [{'id': f'row-{index}', 'inputs': {
                        'K': 'Copper service', 'V': 'Sample manufacturer', 'O': 1, 'AH': 2, 'AI': 50, 'AJ': 100}}]}})
        item.setdefault('fields', []).extend([{'label': 'PKB Entry ID', 'value': 'old-id'},
            {'label': 'Service', 'value': 'Copper service', 'column': 'K'}])
    (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
    return data


class FirestoppingLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = editable_library(self.root / 'library')
        self.store = Store(self.root / 'test.sqlite3')
        self.library = FirestoppingLibrary(self.root / 'library', self.store)
        self.source_bytes = (self.root / 'library/library.json').read_bytes()

    def body(self, edit):
        return {name: deepcopy(edit[name]) for name in ('draft', 'revision', 'pricing_token')}

    def protected(self):
        with self.store.connect() as db:
            return {table: db.execute(f'SELECT * FROM {table} ORDER BY 1').fetchall()
                    for table in ('settings', 'quotes', 'calculator_states', 'app_preferences')}

    def test_original_inputs_price_alias_and_source_are_preserved(self):
        before = self.protected()
        detail = self.library.detail('penetration', 'pkb-001')
        self.assertEqual(detail['library_id'], 'FL-ID-001')
        self.assertNotIn('PKB Entry ID', [f['label'] for f in detail['fields']])
        self.assertNotIn('estimate', detail)
        edit = self.library.edit('pkb-001')
        self.assertEqual(edit['price']['amount'], 150)
        self.assertEqual(edit['source_price']['amount'], 150)
        self.assertEqual(edit['pricing_basis'], 'workbook')
        self.assertEqual(edit['draft']['rows'][0]['inputs']['AI'], 50)
        edit['source_price']['amount'] = -1
        self.assertEqual(self.library.edit('pkb-001')['source_price']['amount'], 150)
        self.assertEqual(self.protected(), before)
        self.assertEqual(self.library.edits.stamp(), (0, 0))
        self.assertEqual((self.root / 'library/library.json').read_bytes(), self.source_bytes)

    def test_collar_pipe_labour_removes_only_the_duplicate_effective_additional_hours(self):
        collar = {'globals': {}, 'rows': [{'id': 'collar', 'inputs': {
            'Y': 'Selected collar', 'AL': 50, 'AN': 1, 'AH': .25, 'O': 1}}]}
        before = deepcopy(collar)
        effective = self.library._library_draft(collar)
        self.assertIsNone(effective['rows'][0]['inputs']['AH'])
        self.assertEqual(collar, before)
        no_collar = deepcopy(collar)
        no_collar['rows'][0]['inputs']['Y'] = None
        self.assertEqual(self.library._library_draft(no_collar)['rows'][0]['inputs']['AH'], .25)
        no_pipe = deepcopy(collar)
        no_pipe['rows'][0]['inputs']['AL'] = None
        self.assertEqual(self.library._library_draft(no_pipe)['rows'][0]['inputs']['AH'], .25)
        self.assertEqual((self.root / 'library/library.json').read_bytes(), self.source_bytes)

    def test_save_reopen_updates_price_search_filters_and_reciprocal_links(self):
        before = self.protected()
        body = self.body(self.library.edit('pkb-001'))
        body['draft']['rows'][0]['inputs'].update(K='Edited service', V='Edited manufacturer', AI=75)
        saved = self.library.action('pkb-001', 'save', body)
        self.assertEqual((saved['revision'], saved['price']['amount']), (1, 175))
        reopened = FirestoppingLibrary(self.root / 'library', self.store)
        self.assertEqual(reopened.edit('pkb-001')['draft'], saved['draft'])
        found = reopened.listing('penetration', search='Edited service', manufacturer='Edited manufacturer')
        self.assertEqual(found['total'], 1)
        self.assertEqual(found['items'][0]['price']['amount'], 175)
        self.assertIn('FL-ID-001', found['items'][0]['title'])
        reverse = reopened.detail('technical', 'report-a-v1')['links'][0]
        self.assertEqual(reverse['title'], found['items'][0]['title'])
        self.assertIn('original workbook entry', reverse['notice'])
        self.assertEqual(reopened.detail('penetration', 'pkb-002')['price']['amount'], 150)
        self.assertEqual(self.protected(), before)
        self.assertEqual((self.root / 'library/library.json').read_bytes(), self.source_bytes)

    def test_explicit_refresh_captures_saved_shared_rates_and_freezes_them(self):
        config = deepcopy(self.data['firestopping']['configuration'])
        worker = next(field for field in definition(config)['row_fields'] if field['column'] == 'W')['options'][0]
        product = next(item for item in config['catalog']['inventory'] if item['sales_description'] == worker)
        old_price = product['sales_price']
        self.assertGreater(old_price, 0)
        body = self.body(self.library.edit('pkb-001'))
        body['draft']['rows'][0]['inputs'] = {'O': 1, 'W': worker, 'AH': 1}
        original = self.library.action('pkb-001', 'calculate', body)['price']['amount']
        product['sales_price'] = old_price * 2
        self.store.save_configuration(config)
        self.assertEqual(self.library.action('pkb-001', 'calculate', body)['price']['amount'], original)
        refreshed = self.library.action('pkb-001', 'refresh-pricing', body)
        self.assertEqual(refreshed['pricing_basis'], 'shared')
        self.assertAlmostEqual(refreshed['price']['amount'], original * 2)
        duplicate = self.library.action('pkb-001', 'refresh-pricing', body)
        self.assertEqual(duplicate['pricing_token'], refreshed['pricing_token'])
        self.assertEqual(self.library.edits.stamp(), (0, 0))
        product['sales_price'] = old_price * 3
        self.store.save_configuration(config)
        saved = self.library.action('pkb-001', 'save', self.body(refreshed))
        self.assertEqual(saved['price'], refreshed['price'])
        reopened = FirestoppingLibrary(self.root / 'library', self.store).edit('pkb-001')
        self.assertEqual(reopened['price'], refreshed['price'])
        self.assertEqual(reopened['source_price']['amount'], 150)
        self.assertEqual(self.store.configuration(), validate_configuration(config))

    def test_stale_revision_and_injected_outputs_cannot_overwrite(self):
        other = FirestoppingLibrary(self.root / 'library', self.store)
        stale = self.body(other.edit('pkb-001'))
        self.library.action('pkb-001', 'save', stale)
        with self.assertRaises(LibraryConflict):
            other.action('pkb-001', 'save', stale)
        current = self.body(other.edit('pkb-001'))
        mutations = [lambda b: b.update(price=1), lambda b: b.update(revision=True),
                     lambda b: b.update(pricing_token='0' * 64),
                     lambda b: b['draft']['rows'][0]['inputs'].update(H=1),
                     lambda b: b['draft']['rows'].append(deepcopy(b['draft']['rows'][0]))]
        for mutate in mutations:
            invalid = deepcopy(current)
            mutate(invalid)
            with self.subTest(mutation=mutate), self.assertRaises(ValidationError):
                other.action('pkb-001', 'save', invalid)
        self.assertEqual(other.edit('pkb-001')['revision'], 1)

    def test_oversized_library_text_is_rejected_before_commit(self):
        for column in ('K', 'T', 'V'):
            body = self.body(self.library.edit('pkb-001'))
            body['draft']['rows'][0]['inputs']['K'] = None
            body['draft']['rows'][0]['inputs'][column] = 'x' * 2000
            with self.subTest(column=column), self.assertRaisesRegex(ValidationError, 'nothing has been saved'):
                self.library.action('pkb-001', 'save', body)
            self.assertEqual(self.library.edits.stamp(), (0, 0))
            self.assertEqual(self.library.listing('penetration')['total'], 2)
            self.assertEqual(self.library.edit('pkb-001')['revision'], 0)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM firestopping_prices').fetchone()[0], 0)

    def test_source_version_changes_retain_saved_values_but_refuse_edit(self):
        self.library.action('pkb-001', 'save', self.body(self.library.edit('pkb-001')))
        self.data['firestopping']['source_sha256'] = 'b' * 64
        (self.root / 'library/library.json').write_text(json.dumps(self.data), encoding='utf-8')
        with self.assertRaises(LibraryConflict):
            self.library.edit('pkb-001')
        self.assertFalse(self.library.detail('penetration', 'pkb-001')['editable'])
        self.assertEqual(self.library.edits.stamp(), (1, 1))
        self.data['firestopping']['calculator_source_sha256'] = 'c' * 64
        (self.root / 'library/library.json').write_text(json.dumps(self.data), encoding='utf-8')
        with self.assertRaises(LibraryConflict):
            self.library.edit('pkb-002')


class FirestoppingApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        editable_library(cls.root / 'library')
        cls.server = create_server(0, cls.root / 'api.sqlite3', library_directory=cls.root / 'library')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, suffix, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request(method, '/api/libraries/penetration/pkb-001/' + suffix,
                body=json.dumps(body) if body is not None else None,
                headers={'Content-Type': 'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_routes_conflicts_and_origin_guards(self):
        status, edit = self.request('GET', 'edit')
        self.assertEqual(status, 200)
        body = {key: edit[key] for key in ('draft', 'revision', 'pricing_token')}
        self.assertEqual(self.request('PUT', 'save', body)[0], 405)
        self.assertEqual(self.request('POST', 'save', body, {'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request('POST', 'save', body, {'Host': 'example.com'})[0], 403)
        self.assertEqual(self.request('POST', 'calculate', body)[0], 200)
        self.assertEqual(self.request('POST', 'save', body)[0], 200)
        self.assertEqual(self.request('POST', 'save', body)[0], 409)
        self.assertEqual(self.request('GET', 'edit')[1]['revision'], edit['revision'] + 1)


if __name__ == '__main__':
    unittest.main()
