"""Atomic user-library writes and immutable source/pricing boundaries."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import base64
import http.client
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest

from PIL import Image

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary, LibraryConflict
from estimator.penetration_calculator import normalize_draft
from estimator.server import create_server
from estimator.storage import Store
from test_firestopping_library import editable_library


class LibraryWorkflowStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = editable_library(self.root / 'library')
        self.data['libraries']['penetration']['items'][1]['library_id'] = 'FL-ID-897'
        self.index = self.root / 'library/library.json'
        self.index.write_text(json.dumps(self.data), encoding='utf-8')
        self.source = self.index.read_bytes()
        self.store = Store(self.root / 'test.sqlite3')
        self.library = FirestoppingLibrary(self.root / 'library', self.store)

    def body(self, key='request-0000000001'):
        return {'idempotency_key': key, 'configuration': {}, 'draft': {
            'globals': {'J': 'No', 'K': None, 'L': 0.125, 'M': 0},
            'rows': [{'id': 'selected-row', 'inputs': {'K': 'Unknown saved service Ø65', 'T': '65 mm copper',
                       'Q': None, 'O': 1, 'AH': 2, 'AI': 50.123456789, 'AJ': 100, 'AL': 65, 'AO': 0}}]}}

    def counts(self):
        with self.store.connect() as db:
            return tuple(db.execute('SELECT (SELECT count(*) FROM firestopping_created),'
                                    '(SELECT count(*) FROM firestopping_prices),(SELECT count(*) FROM firestopping_items)').fetchone())

    def test_concurrent_instances_allocate_unique_monotonic_ids_and_retry_once(self):
        libraries = [FirestoppingLibrary(self.root / 'library', self.store) for _ in range(4)]
        barrier = threading.Barrier(4)

        def add(index):
            barrier.wait()
            return libraries[index].create(self.body(f'parallel-request-{index}'))

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(add, range(4)))
        self.assertEqual(sorted(item['library_id'] for item in results), ['FL-ID-100001', 'FL-ID-100002', 'FL-ID-100003', 'FL-ID-100004'])
        self.assertEqual(len({item['id'] for item in results}), 4)
        self.assertTrue(all(item['created'] for item in results))
        barrier = threading.Barrier(4)

        def retry(index):
            barrier.wait()
            return libraries[index].create(self.body('one-shared-request'))

        with ThreadPoolExecutor(max_workers=4) as executor:
            repeated = list(executor.map(retry, range(4)))
        self.assertEqual(sum(item['created'] for item in repeated), 1)
        self.assertEqual({item['library_id'] for item in repeated}, {'FL-ID-100005'})
        self.assertEqual(self.counts()[0], 5)
        self.assertEqual(self.index.read_bytes(), self.source)

    def test_created_snapshot_survives_edits_bundle_removal_and_retry_conflict(self):
        request = self.body()
        created = self.library.create(request)
        self.assertEqual(self.library.detail('penetration', created['id'])['price']['label'], 'Library price')
        original = self.library.edits.created()[created['id']]
        original_prices = self.library.edits.snapshot(created['pricing_token'])
        self.assertEqual(created['draft'], normalize_draft(request['draft']))
        self.assertIn('catalog', created['configuration'])
        self.assertIn('Unknown saved service Ø65', self.library.service_types())
        edit = {key: deepcopy(created[key]) for key in ('draft', 'revision', 'pricing_token')}
        edit['draft']['rows'][0]['inputs'].update(K='Edited service', AI=75.987654321)
        saved = self.library.action(created['id'], 'save', edit)
        self.assertEqual(saved['revision'], 1)
        self.assertNotEqual(saved['price']['amount'], created['price']['amount'])
        self.assertEqual(self.library.edits.created()[created['id']], original)
        self.assertEqual(self.library.edits.snapshot(created['pricing_token']), original_prices)
        self.index.unlink()
        reopened = FirestoppingLibrary(self.root / 'library', self.store)
        self.assertEqual(reopened.edit(created['id'])['draft'], saved['draft'])
        self.assertEqual(reopened.edit(created['id'])['source_price'], created['source_price'])
        counts = reopened.listing('penetration')['counts']
        self.assertEqual({key: counts[key] for key in ('total', 'linked', 'unlinked')},
                         {'total': 1, 'linked': 0, 'unlinked': 1})
        self.assertEqual(counts['manufacturers'], [{'name': 'Not recorded', 'count': 1}])
        self.assertFalse(reopened.create(request)['created'])
        different = deepcopy(request)
        different['draft']['rows'][0]['inputs']['AI'] = 999
        with self.assertRaises(LibraryConflict):
            reopened.create(different)
        next_item = reopened.create(self.body('request-after-removal'))
        self.assertEqual(next_item['library_id'], 'FL-ID-100002')
        self.assertEqual(self.store.configuration(), {'inventory': {}, 'rates': {}})
        with self.store.connect() as db:
            for table in ('quotes', 'calculator_states', 'app_preferences'):
                self.assertEqual(db.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0)

    def test_creation_atomically_compresses_and_persists_optional_source_diagram(self):
        image = BytesIO()
        Image.new('RGBA', (3200, 1200), (180, 40, 50, 180)).save(image, format='PNG')
        request = self.body('diagram-request-0001')
        request['diagram'] = {'filename': 'site detail.PNG',
                              'content_base64': base64.b64encode(image.getvalue()).decode('ascii')}
        created = self.library.create(request)
        self.assertTrue(created['diagram']['custom'])
        self.assertEqual(created['diagram']['mime_type'], 'image/jpeg')
        self.assertLessEqual(created['diagram']['width'], 2000)
        self.assertTrue(self.library.diagram_asset(created['id'])[0].startswith(b'\xff\xd8\xff'))
        self.assertTrue(self.library.diagram_asset(created['id'], True)[0].startswith(b'\xff\xd8\xff'))
        reopened = FirestoppingLibrary(self.root / 'library', self.store)
        self.assertEqual(reopened.diagram_asset(created['id'])[0], self.library.diagram_asset(created['id'])[0])
        self.assertFalse(reopened.create(request)['created'])
        different_image = BytesIO()
        Image.new('RGB', (600, 400), '#224466').save(different_image, format='PNG')
        changed = deepcopy(request)
        changed['diagram']['content_base64'] = base64.b64encode(different_image.getvalue()).decode('ascii')
        with self.assertRaises(LibraryConflict):
            reopened.create(changed)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM firestopping_images WHERE item_id=?', (created['id'],)).fetchone()[0], 1)

    def test_manual_links_are_atomic_reciprocal_and_bound_to_source_versions(self):
        created = self.library.create(self.body())
        key = created['id']
        libraries = [FirestoppingLibrary(self.root / 'library', self.store) for _ in range(3)]
        barrier = threading.Barrier(3)

        def link(index):
            barrier.wait()
            return libraries[index].add_link(key, {'technical_id': 'report-a-v1'})

        with ThreadPoolExecutor(max_workers=3) as executor:
            result = list(executor.map(link, range(3)))
        self.assertEqual(sum(item['created'] for item in result), 1)
        left = self.library.detail('penetration', key)['links']
        self.assertEqual(len(left), 1)
        self.assertEqual(left[0]['origin'], 'user')
        self.assertEqual(left[0]['relationship'], 'Manually linked.')
        right = self.library.detail('technical', 'report-a-v1')['links']
        self.assertEqual(len([item for item in right if item['id'] == key]), 1)
        self.assertEqual(self.library.edit(key)['revision'], 0)
        edit = self.library.edit(key)
        body = {name: deepcopy(edit[name]) for name in ('draft', 'revision', 'pricing_token')}
        body['draft']['rows'][0]['inputs']['T'] = 'Changed service description'
        self.library.action(key, 'save', body)
        reverse = next(item for item in self.library.detail('technical', 'report-a-v1')['links'] if item['id'] == key)
        self.assertEqual(reverse['origin'], 'user')
        self.assertIn('Review its current inputs', reverse['notice'])
        self.assertNotIn('original workbook', reverse['notice'])
        counts = self.library.listing('penetration', search='not found', technical_reference='unlinked')['counts']
        self.assertEqual({key: counts[key] for key in ('total', 'linked', 'unlinked')},
                         {'total': 3, 'linked': 2, 'unlinked': 1})
        self.assertEqual(sum(entry['count'] for entry in counts['manufacturers']), 3)
        self.data['documents'][0]['sha256'] = 'b' * 64
        self.index.write_text(json.dumps(self.data), encoding='utf-8')
        self.assertEqual(self.library.detail('penetration', key)['links'], [])
        self.assertIn('another source version', self.library.detail('penetration', key)['notice'])
        with self.assertRaises(LibraryConflict):
            self.library.add_link(key, {'technical_id': 'report-a-v1'})
        self.assertEqual(len(self.library.edits.links()), 1)

    def test_rejected_creation_never_persists_partial_records_or_snapshots(self):
        mutations = [lambda b: b.update(idempotency_key=True),
                     lambda b: b['draft']['rows'].append({'id': 'second', 'inputs': {}}),
                     lambda b: b['draft']['rows'][0]['inputs'].update(H=1),
                     lambda b: b['draft']['rows'][0]['inputs'].update(O=0),
                     lambda b: b['draft']['rows'][0]['inputs'].update(K=None, T=None),
                     lambda b: b['draft']['rows'][0]['inputs'].update(K='x'*2001)]
        for mutation in mutations:
            request = self.body()
            mutation(request)
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                self.library.create(request)
            self.assertEqual(self.counts(), (0, 0, 0))
        self.assertEqual(self.index.read_bytes(), self.source)

    def test_supplier_install_after_first_user_creation_preserves_ids_and_rejects_reserved_range(self):
        self.index.unlink()
        created = self.library.create(self.body())
        self.assertEqual(created['library_id'], 'FL-ID-100001')
        self.index.write_bytes(self.source)
        self.assertEqual(self.library.listing('penetration')['counts']['total'], 3)
        self.assertEqual(self.library.edit(created['id'])['library_id'], created['library_id'])
        self.data['libraries']['penetration']['items'][0]['library_id'] = 'FL-ID-100002'
        self.index.write_text(json.dumps(self.data), encoding='utf-8')
        with self.assertRaisesRegex(ValidationError, 'reserved'):
            self.library.listing('penetration')
        self.assertEqual(self.counts()[0], 1)

    def test_supplier_internal_identifier_collision_is_rejected_before_write(self):
        self.data['libraries']['penetration']['items'][1]['id'] = 'fl-user-100001'
        self.index.write_text(json.dumps(self.data), encoding='utf-8')
        with self.assertRaisesRegex(LibraryConflict, 'conflicts'):
            self.library.create(self.body())
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_service_type_choices_use_effective_saved_fields_and_filter_fallback(self):
        library = self.data['libraries']['penetration']
        library['filters'].append({'key': 'service_type', 'label': 'Service type'})
        item = library['items'][0]
        item['fields'] = [field for field in item['fields'] if field.get('column') != 'K']
        item['filter_values']['service_type'] = ['Fallback service']
        self.index.write_text(json.dumps(self.data), encoding='utf-8')
        self.assertEqual(self.library.service_types(), ['Copper service', 'Fallback service'])
        edit = self.library.edit(item['id'])
        body = {key: deepcopy(edit[key]) for key in ('draft', 'revision', 'pricing_token')}
        body['draft']['rows'][0]['inputs']['K'] = 'Saved service Ø65'
        self.library.action(item['id'], 'save', body)
        self.assertEqual(self.library.service_types(), ['Copper service', 'Saved service Ø65'])

    def test_invalid_reference_bundle_cannot_disable_estimator_http_endpoints(self):
        server = create_server(0, self.root / 'test.sqlite3', library_directory=self.root / 'library')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path, body=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
            try:
                connection.request('POST' if body is not None else 'GET', path,
                                   body=json.dumps(body) if body is not None else None,
                                   headers={'Content-Type': 'application/json'})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        try:
            body = self.body()
            calculation = {key: body[key] for key in ('draft', 'configuration')}
            status, before = request('/api/penetration/calculate', calculation)
            self.assertEqual(status, 200)
            self.index.write_text('{malformed source library', encoding='utf-8')
            for path, body in [('/api/penetration', None), ('/api/penetration/definition', {'configuration': {}})]:
                status, spec = request(path, body)
                self.assertEqual(status, 200)
                self.assertIn('Cable Trays', next(field for field in spec['row_fields'] if field['column'] == 'K')['options'])
            status, after = request('/api/penetration/calculate', calculation)
            self.assertEqual(status, 200)
            self.assertEqual(after['rows'], before['rows'])
            self.assertEqual(after['summary'], before['summary'])
            self.assertEqual(after['draft'], before['draft'])
            self.assertEqual(request('/api/libraries/penetration')[0], 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
