"""HTTP integration for durable user-created library items and references.

All fixtures are synthetic. These checks never open the installed library or
the application database.
"""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.catalog import validate_configuration
from estimator.penetration_calculator import definition, normalize_draft
from estimator.server import create_server
from estimator.storage import Store
from test_firestopping_library import editable_library


class LibraryWorkflowIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library_directory = self.root / 'library'
        self.bundle = editable_library(self.library_directory)
        self.database = self.root / 'workflow.sqlite3'
        self.store = Store(self.database)
        self.configuration = deepcopy(self.bundle['firestopping']['configuration'])
        self.store.save_configuration(self.configuration)
        self.source_files = {path.relative_to(self.library_directory): path.read_bytes()
                             for path in self.library_directory.rglob('*') if path.is_file()}
        self.server = None
        self.start_server()
        self.addCleanup(self.stop_server)

    def start_server(self):
        self.server = create_server(0, self.database, library_directory=self.library_directory)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()

    def stop_server(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=10)
            self.assertFalse(self.thread.is_alive())
            self.server = None

    def restart_server(self):
        self.stop_server()
        self.start_server()

    def request(self, method, path, body=None, headers=None, *, headers_only=False):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port,
                                               timeout=5 if headers_only else 30)
        try:
            payload = json.dumps(body).encode('utf-8') if body is not None else None
            request_headers = {'Content-Type': 'application/json', **(headers or {})}
            if headers_only:
                # Advertise the valid payload, but require the guard's response
                # before sending it. A guard that starts reading the body fails
                # with a bounded timeout rather than racing an early close.
                self.assertIsNotNone(payload)
                request_headers['Content-Length'] = str(len(payload))
            connection.request(method, path, body=None if headers_only else payload,
                               headers=request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def get(self, path):
        status, value = self.request('GET', path)
        self.assertEqual(status, 200, value)
        return value

    def creation(self, key='create-example-0001'):
        return {'draft': {'globals': {'J': 'No', 'K': 0, 'L': 0.123456789, 'M': 0.0123456789},
                         'rows': [{'id': 'unchanged-row-id', 'inputs': {
                             'K': 'Custom service / exact spelling', 'V': 'FIREFLY',
                             'T': 'Test service <literal>', 'U': 'Synthetic installation only.',
                             'O': 1, 'AH': 1.23456789, 'AI': 98.7654321, 'AJ': 12.3456789}}]},
                'configuration': deepcopy(self.configuration), 'idempotency_key': key}

    def create(self, body=None):
        status, value = self.request('POST', '/api/libraries/penetration', body or self.creation())
        self.assertEqual(status, 200, value)
        return value

    def protected(self):
        with self.store.connect() as db:
            return {table: db.execute(f'SELECT * FROM {table} ORDER BY 1').fetchall()
                    for table in ('settings', 'quotes', 'calculator_states', 'app_preferences')}

    def assert_source_unchanged(self):
        self.assertEqual({path.relative_to(self.library_directory): path.read_bytes()
                          for path in self.library_directory.rglob('*') if path.is_file()}, self.source_files)

    def test_create_reopen_save_and_restart_preserve_exact_draft_and_pricing(self):
        before = self.protected()
        body = self.creation()
        created = self.create(body)
        self.assertTrue(created['created'])
        self.assertEqual(created['library_id'], 'FL-ID-100001')
        self.assertEqual(created['draft'], normalize_draft(body['draft']))
        self.assertEqual(created['configuration'], validate_configuration(body['configuration']))
        self.assertEqual(created['result']['errors'], [])
        self.assertEqual(created['price']['amount'], created['result']['rows'][0]['outputs']['H'])
        endpoint = '/api/libraries/penetration/' + created['id']
        detail = self.get(endpoint)
        self.assertTrue(detail['editable'])
        self.assertEqual(detail['price']['amount'], created['price']['amount'])
        choices = next(field['options'] for field in self.get('/api/penetration')['row_fields']
                       if field['column'] == 'K')
        self.assertIn(body['draft']['rows'][0]['inputs']['K'], choices)
        self.assertEqual(self.get('/api/libraries/penetration?manufacturer=FIREFLY')['total'], 1)
        self.assertEqual(self.protected(), before)
        self.restart_server()
        reopened = self.get(endpoint + '/edit')
        for name in ('draft', 'configuration', 'pricing_token', 'price', 'revision'):
            self.assertEqual(reopened[name], created[name], name)
        edit = {key: deepcopy(reopened[key]) for key in ('draft', 'revision', 'pricing_token')}
        edit['draft']['rows'][0]['inputs']['AI'] = 101.987654321
        status, saved = self.request('POST', endpoint + '/save', edit)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved['revision'], reopened['revision'] + 1)
        self.assertEqual(saved['draft']['rows'][0]['inputs']['AI'], 101.987654321)
        self.assertEqual(self.request('POST', endpoint + '/save', edit)[0], 409)
        self.restart_server()
        self.assertEqual(self.get(endpoint + '/edit')['draft'], saved['draft'])
        self.assertEqual(self.protected(), before)
        self.assert_source_unchanged()

    def test_creation_retry_is_idempotent_and_cannot_replace_saved_item(self):
        body = self.creation()
        created = self.create(body)
        endpoint = '/api/libraries/penetration/' + created['id']
        update = {key: deepcopy(created[key]) for key in ('draft', 'revision', 'pricing_token')}
        update['draft']['rows'][0]['inputs']['T'] = 'Later saved description'
        self.assertEqual(self.request('POST', endpoint + '/save', update)[0], 200)
        self.restart_server()
        retried = self.create(body)
        self.assertFalse(retried['created'])
        self.assertEqual(retried['id'], created['id'])
        self.assertEqual(retried['draft']['rows'][0]['inputs']['T'], 'Later saved description')
        conflict = deepcopy(body)
        conflict['draft']['rows'][0]['inputs']['AI'] += 1
        self.assertEqual(self.request('POST', '/api/libraries/penetration', conflict)[0], 409)
        self.assertEqual(self.get('/api/libraries/penetration')['total'], 3)

    def test_frozen_product_price_survives_shared_pricing_changes(self):
        body = self.creation()
        worker = next(field for field in definition(self.configuration)['row_fields']
                      if field['column'] == 'W')['options'][0]
        body['draft']['rows'][0]['inputs'] = {'K': 'Cable Trays', 'O': 1, 'W': worker, 'AH': 2}
        created = self.create(body)
        changed = deepcopy(self.configuration)
        product = next(item for item in changed['catalog']['inventory'] if item['sales_description'] == worker)
        self.assertGreater(product['sales_price'], 0)
        product['sales_price'] *= 3
        self.store.save_configuration(changed)
        after_shared_change = self.protected()
        self.restart_server()
        reopened = self.get('/api/libraries/penetration/' + created['id'] + '/edit')
        self.assertEqual(reopened['price'], created['price'])
        self.assertEqual(reopened['configuration'], created['configuration'])
        self.assertEqual(self.protected(), after_shared_change)
        self.assert_source_unchanged()

    def test_manual_reference_is_reciprocal_idempotent_and_persistent(self):
        before = self.protected()
        created = self.create()
        endpoint = '/api/libraries/penetration/' + created['id']
        unlinked = self.get('/api/libraries/penetration?technical_reference=unlinked')
        self.assertIn(created['id'], {item['id'] for item in unlinked['items']})
        self.assertEqual({key: unlinked['counts'][key] for key in ('total', 'linked', 'unlinked')},
                         {'total': 3, 'linked': 1, 'unlinked': 2})
        self.assertEqual(sum(entry['count'] for entry in unlinked['counts']['manufacturers']), 3)
        link_body = {'technical_id': 'report-a-v1'}
        status, linked = self.request('POST', endpoint + '/links', link_body)
        self.assertEqual(status, 200, linked)
        self.assertTrue(linked['created'])
        self.assertTrue(linked['linked'])
        status, duplicate = self.request('POST', endpoint + '/links', link_body)
        self.assertEqual(status, 200, duplicate)
        self.assertFalse(duplicate['created'])
        self.restart_server()
        forward = self.get(endpoint)['links']
        reverse = self.get('/api/libraries/technical/report-a-v1')['links']
        self.assertEqual([item['id'] for item in forward], ['report-a-v1'])
        self.assertEqual(sum(item['id'] == created['id'] for item in reverse), 1)
        self.assertEqual(forward[0]['relationship'], next(item['relationship'] for item in reverse
                                                       if item['id'] == created['id']))
        listed = self.get('/api/libraries/penetration?technical_reference=linked')
        self.assertEqual({key: listed['counts'][key] for key in ('total', 'linked', 'unlinked')},
                         {'total': 3, 'linked': 2, 'unlinked': 1})
        self.assertEqual(sum(entry['count'] for entry in listed['counts']['manufacturers']), 3)
        self.assertEqual({item['id'] for item in listed['items']}, {'pkb-001', created['id']})
        summary = next(item for item in self.get('/api/libraries')['libraries'] if item['id'] == 'penetration')
        self.assertEqual((summary['linked_count'], summary['unlinked_count']), (2, 1))
        self.assertEqual(self.protected(), before)
        self.assert_source_unchanged()

    def test_invalid_creation_and_reference_requests_leave_no_partial_writes(self):
        before = self.protected()
        invalid = []
        for transform in (
            lambda body: body.update(price={'amount': 0}),
            lambda body: body.update(idempotency_key=''),
            lambda body: body.update(idempotency_key='../outside'),
            lambda body: body['draft']['rows'].append({'id': 'second', 'inputs': {}}),
            lambda body: body['draft']['rows'][0]['inputs'].update(H=0),
            lambda body: body['draft']['rows'][0]['inputs'].update(O=True),
            lambda body: body['draft']['rows'][0]['inputs'].update(O=10 ** 1000),
            lambda body: body['draft']['rows'][0]['inputs'].update(T='x' * 10001),
            lambda body: body.update(configuration={'unsupported': True}),
        ):
            body = self.creation()
            transform(body)
            invalid.append(body)
        for index, body in enumerate(invalid):
            with self.subTest(case=index):
                status, response = self.request('POST', '/api/libraries/penetration', body)
                self.assertEqual(status, 400, response)
        self.assertEqual(self.get('/api/libraries/penetration')['total'], 2)
        self.assertEqual(self.protected(), before)
        created = self.create()
        self.assertEqual(created['library_id'], 'FL-ID-100001')
        endpoint = '/api/libraries/penetration/' + created['id'] + '/links'
        for body, expected in (({'technical_id': '../outside'}, 400),
                               ({'technical_id': 'report-a-v1', 'relationship': 'Approved'}, 400),
                               ({'technical_id': 'missing-reference'}, 404)):
            status, response = self.request('POST', endpoint, body)
            self.assertEqual(status, expected, response)
        self.assertEqual(self.request('POST', '/api/libraries/penetration/missing-item/links',
                                      {'technical_id': 'report-a-v1'})[0], 404)
        self.assertEqual(self.get('/api/libraries/penetration/' + created['id'])['links'], [])
        self.assertEqual(self.protected(), before)
        self.assert_source_unchanged()

    def test_new_mutation_routes_enforce_method_and_same_origin(self):
        before = self.protected()
        body = self.creation()
        routes = [('/api/libraries/penetration', body),
                  ('/api/libraries/penetration/pkb-002/links', {'technical_id': 'report-a-v1'})]
        for path, payload in routes:
            with self.subTest(path=path):
                self.assertEqual(self.request('PUT', path, payload)[0], 405)
                self.assertEqual(self.request('POST', path, payload, {'Origin': 'https://example.com'},
                                              headers_only=True)[0], 403)
                self.assertEqual(self.request('POST', path, payload, {'Host': 'example.com'},
                                              headers_only=True)[0], 403)
        self.assertEqual(self.get('/api/libraries/penetration')['total'], 2)
        self.assertEqual(self.get('/api/libraries/penetration/pkb-002')['links'], [])
        self.assertEqual(self.protected(), before)

    def test_concurrent_http_creation_allocates_unique_ids_and_retries_once(self):
        bodies = [self.creation('parallel-first-0001'), self.creation('parallel-second-0001'),
                  self.creation('parallel-first-0001')]
        barrier = threading.Barrier(len(bodies))

        def submit(body):
            barrier.wait(timeout=10)
            return self.request('POST', '/api/libraries/penetration', body)

        with ThreadPoolExecutor(max_workers=len(bodies)) as executor:
            responses = list(executor.map(submit, bodies))
        for status, response in responses:
            self.assertEqual(status, 200, response)
        values = [value for _, value in responses]
        self.assertEqual(values[0]['id'], values[2]['id'])
        self.assertNotEqual(values[0]['id'], values[1]['id'])
        self.assertEqual({value['library_id'] for value in values}, {'FL-ID-100001', 'FL-ID-100002'})
        self.assertEqual(sum(value['created'] for value in values), 2)
        self.restart_server()
        self.assertEqual(self.get('/api/libraries/penetration')['total'], 4)

    def test_creation_and_editing_work_without_supplier_bundle(self):
        self.stop_server()
        self.library_directory = self.root / 'not-installed'
        self.start_server()
        before = self.protected()
        created = self.create()
        self.assertEqual(created['library_id'], 'FL-ID-100001')
        self.assertFalse(self.library_directory.exists())
        self.restart_server()
        endpoint = '/api/libraries/penetration/' + created['id']
        self.assertEqual(self.get(endpoint + '/edit')['draft'], created['draft'])
        listing = self.get('/api/libraries/penetration?technical_reference=unlinked')
        self.assertEqual({key: listing['counts'][key] for key in ('total', 'linked', 'unlinked')},
                         {'total': 1, 'linked': 0, 'unlinked': 1})
        self.assertEqual(listing['counts']['manufacturers'], [{'name': 'FIREFLY', 'count': 1}])
        self.assertEqual(listing['items'][0]['id'], created['id'])
        self.assertEqual(self.get('/api/libraries/technical')['total'], 0)
        self.assertEqual(self.request('POST', endpoint + '/links', {'technical_id': 'report-a-v1'})[0], 404)
        self.assertEqual(self.protected(), before)
        self.assertFalse(self.library_directory.exists())

    def test_supplier_install_after_first_user_creation_preserves_saved_identity(self):
        self.stop_server()
        installed_directory = self.library_directory
        self.library_directory = self.root / 'not-installed'
        self.start_server()
        before = self.protected()
        created = self.create()
        self.assertEqual(created['library_id'], 'FL-ID-100001')
        self.stop_server()
        self.library_directory = installed_directory
        self.start_server()
        combined = self.get('/api/libraries/penetration')
        aliases = {item['id']: item['library_id'] for item in combined['items']}
        self.assertEqual(aliases, {'pkb-001': 'FL-ID-001', 'pkb-002': 'FL-ID-002',
                                   created['id']: 'FL-ID-100001'})
        reopened = self.get('/api/libraries/penetration/' + created['id'] + '/edit')
        for key in ('id', 'library_id', 'draft', 'configuration', 'pricing_token', 'price'):
            self.assertEqual(reopened[key], created[key], key)
        next_item = self.create(self.creation('after-install-0001'))
        self.assertEqual(next_item['library_id'], 'FL-ID-100002')
        self.assertEqual(self.protected(), before)
        self.assert_source_unchanged()


if __name__ == '__main__':
    unittest.main()
