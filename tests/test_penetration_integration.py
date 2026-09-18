"""Project, API and export boundaries for the separate penetration estimator."""

from copy import deepcopy
from io import BytesIO
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.penetration_calculator import calculate, definition
from estimator.project_file import ESTIMATE_FIELDS, export_project, load_project_bytes
from estimator.project_library import ProjectLibrary, file_fingerprint
from estimator.server import create_server
from estimator.storage import Store


class PenetrationIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.store = Store(cls.root / 'test.sqlite3')
        cls.server = create_server(0, cls.root / 'server.sqlite3')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None,
                               headers={'Content-Type': 'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def setUp(self):
        self.store.save_configuration({})

    def draft(self):
        draft = deepcopy(definition({})['defaults'])
        draft['globals'].update(K=2.1234567890123, L=.15, M=.2)
        draft['rows'][0]['inputs'].update(O=3, AI=12.3456789012345,
                                         AJ=45.6789012345678, T='=HYPERLINK("https://example.invalid","Literal text")')
        return draft

    def test_project_round_trip_is_separate_and_freezes_shared_pricing(self):
        draft = self.draft()
        original = deepcopy(draft)
        payload = export_project(self.store, {'estimate': {'inputs': {'B15': 12.345}},
                                             'penetration': {'draft': draft}})
        loaded = load_project_bytes(self.store, payload)
        self.assertEqual(loaded['penetration']['draft'], original)
        self.assertEqual(loaded['penetration']['source_sha256'], definition({})['source_sha256'])
        self.assertEqual(loaded['estimate']['inputs']['B15'], 12.345)
        before = calculate(draft, loaded['estimate']['configuration'])
        self.store.save_configuration({'inventory': {'0': {'sales_price': 123.456}}})
        reloaded = load_project_bytes(self.store, payload)
        self.assertEqual(calculate(reloaded['penetration']['draft'], reloaded['estimate']['configuration']), before)
        self.assertEqual(draft, original)

    def test_legacy_projects_remain_supported_and_new_payloads_are_strict(self):
        old = export_project(self.store, {'estimate': {}})
        self.assertNotIn('penetration', json.loads(old))
        self.assertNotIn('penetration', load_project_bytes(self.store, old))
        payload = json.loads(export_project(self.store, {'estimate': {}, 'penetration': {'draft': self.draft()}}))
        changes = [
            lambda value: value['penetration'].update(source_sha256='0' * 64),
            lambda value: value['penetration'].update(result={'grand_total': 1}),
            lambda value: value['penetration']['draft']['rows'][0]['inputs'].update(H=1),
        ]
        for change in changes:
            invalid = deepcopy(payload)
            change(invalid)
            with self.assertRaises(ValidationError):
                load_project_bytes(self.store, json.dumps(invalid).encode())

    def test_older_browser_cannot_silently_drop_saved_penetration_inputs(self):
        target = self.root / 'penetration-project.json'
        class Dialogs:
            def choose_save(self, folder, filename):
                return SaveSelection(str(target), file_fingerprint(target))
        library = ProjectLibrary(self.store, Dialogs())
        try:
            saved = library.save_as({'estimate': {}, 'penetration': {'draft': self.draft()}})
            project = saved['project']
            request = {'save_token': saved['file']['save_token'],
                       'estimate': {key: project['estimate'][key] for key in ESTIMATE_FIELDS},
                       'calculators': {key: {'inputs': value['inputs'], 'schedule_rows': value['schedule_rows']}
                                       for key, value in project['calculators'].items()}}
            before = target.read_bytes()
            with self.assertRaisesRegex(ValidationError, 'Firestopping Estimator'):
                library.save(request)
            self.assertEqual(target.read_bytes(), before)
            with self.assertRaisesRegex(ValidationError, 'Firestopping Estimator'):
                library.save_as({'estimate': request['estimate'], 'calculators': request['calculators']})
            self.assertEqual(target.read_bytes(), before)
            request['penetration'] = {'draft': self.draft()}
            request['penetration']['draft']['rows'][0]['inputs']['AJ'] = 8.9
            changed = library.save(request)
            self.assertEqual(changed['project']['penetration']['draft']['rows'][0]['inputs']['AJ'], 8.9)
        finally:
            library.close()

    def test_api_and_exports_use_the_same_draft_without_persisting_it(self):
        status, _, payload = self.request('POST', '/api/penetration/definition', {'configuration': {}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)['capacity'], 1000)
        draft = self.draft()
        draft['rows'][0]['inputs']['U'] = 'Install the selected protection.'
        request = {'draft': draft, 'configuration': {}}
        status, _, payload = self.request('POST', '/api/penetration/calculate', request)
        self.assertEqual(status, 200)
        result = json.loads(payload)
        self.assertEqual(result, calculate(draft, {}))
        details = {'project_no': 'TEST-PEN', 'client': 'Synthetic client', 'site_address': 'Example site'}
        for route, kind in [('report.pdf', 'application/pdf'), ('register.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')]:
            status, headers, content = self.request('POST', '/api/penetration/' + route,
                                                    {**request, 'project_details': details})
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], kind)
            if route.endswith('.pdf'):
                text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(content)).pages)
                self.assertIn('TEST-PEN', text)
                self.assertIn('Firestopping estimate', text)
                self.assertIn('Literal text', text)
                self.assertIn('Items/Services', text)
                self.assertIn('System/Install Details', text)
            else:
                workbook = load_workbook(BytesIO(content))
                totals = {row[0].value: row[1].value for row in workbook['Summary'] if row[0].value is not None}
                self.assertEqual(totals['Grand total'], result['summary']['grand_total'])
                for row in workbook['Summary']:
                    if row[0].value in {field['label'] for field in definition({})['global_fields'] if field['format'] == 'percent'}:
                        self.assertEqual(row[1].number_format, '0.00%')
                self.assertTrue(any(cell.value == draft['rows'][0]['inputs']['T']
                                    for row in workbook['Inputs'] for cell in row))
                input_labels = {row[1].value for row in workbook['Inputs']}
                self.assertTrue({'Items/Services', 'System/Install Details'} <= input_labels)
                self.assertFalse(any(cell.data_type in {'f', 'e'} or cell.hyperlink
                                     for sheet in workbook for row in sheet for cell in row))
        fresh = json.loads(self.request('GET', '/api/penetration')[2])
        self.assertEqual(fresh['defaults'], definition({})['defaults'])

    def test_penetration_downloads_use_project_folder_or_standard_downloads(self):
        folder = self.root / 'export-project'
        folder.mkdir(exist_ok=True)
        project_path = folder / 'estimate.json'
        class Dialogs:
            def choose_save(self, initial, filename):
                return SaveSelection(str(project_path), None)
        server = create_server(0, self.root / 'downloads.sqlite3', Dialogs())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        previous, self.server = self.server, server
        try:
            saved = self.request('POST', '/api/project/save-as', {'estimate': {}, 'penetration': {'draft': self.draft()}})
            self.assertEqual(saved[0], 200, saved[2])
            token = json.loads(saved[2])['file']['save_token']
            downloads = self.root / 'Downloads'
            with patch('estimator.download_files.standard_downloads_directory', return_value=downloads):
                for project_token, expected_folder in ((token, folder), (None, downloads)):
                    for route in ('report.pdf', 'register.xlsx'):
                        status, _, raw = self.request('POST', '/api/penetration/' + route,
                            {'draft': self.draft(), 'configuration': {}, 'download': {'project_token': project_token}})
                        self.assertEqual(status, 200, raw)
                        receipt = json.loads(raw)
                        self.assertTrue(receipt['saved'])
                        path = Path(receipt['path'])
                        self.assertEqual(path.parent, expected_folder)
                        self.assertTrue(path.read_bytes().startswith(b'%PDF' if route.endswith('.pdf') else b'PK'))
        finally:
            self.server = previous
            server.shutdown()
            server.server_close()
            thread.join()

    def test_penetration_routes_keep_existing_security_and_input_boundaries(self):
        body = {'draft': self.draft(), 'configuration': {}}
        self.assertEqual(self.request('POST', '/api/penetration/calculate', body,
                                      {'Origin': 'https://example.invalid'})[0], 403)
        self.assertEqual(self.request('PUT', '/api/penetration/calculate', body)[0], 405)
        self.assertEqual(self.request('POST', '/api/penetration/calculate', {**body, 'result': {}})[0], 400)
        self.assertEqual(self.request('POST', '/api/penetration/report.pdf',
                                      {**body, 'download': {'project_token': 'untrusted'}})[0], 400)


if __name__ == '__main__':
    unittest.main()
