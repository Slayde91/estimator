"""Project-aware downloads write only to captured, authorized local folders."""

from concurrent.futures import ThreadPoolExecutor
import copy
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.download_files import DownloadDestination, standard_downloads_directory, write_download_file
from estimator.native_dialogs import SaveSelection
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.server import create_server
from estimator.storage import Store


class Dialogs:
    selection = None
    opened = None

    def choose_save(self, folder, filename):
        return self.selection

    def choose_open(self, folder):
        return self.opened


def stored_rows(store):
    with store.connect() as db:
        return {table: db.execute(f'SELECT * FROM {table} ORDER BY 1').fetchall()
                for table in ('settings', 'quotes', 'calculator_states', 'app_preferences')}


class DownloadDestinationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(export_project(Store(Path(directory) / 'seed.sqlite3'), {'estimate': {'title': 'Exact project'}}))
        cls.project_request = {key: data[key] for key in ('estimate', 'calculators')}
        cls.project_request['calculators'] = {key: {'inputs': value['inputs'], 'schedule_rows': value['schedule_rows']}
                                            for key, value in data['calculators'].items()}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.folder = self.root / 'Project folder'
        self.folder.mkdir()
        self.downloads = self.root / 'Redirected Downloads'
        self.store = Store(self.root / 'state.sqlite3')
        self.dialogs = Dialogs()
        self.library = ProjectLibrary(self.store, self.dialogs)
        self.addCleanup(self.library.close)

    def authorize(self, folder=None):
        self.dialogs.selection = SaveSelection(str((folder or self.folder) / 'Project.json'), None)
        return self.library.save_as(self.project_request)

    def test_null_project_uses_standard_downloads_even_when_a_different_folder_is_linked(self):
        self.store.set_project_folder(self.folder)
        before = stored_rows(self.store)
        with patch('estimator.download_files.standard_downloads_directory', return_value=self.downloads):
            selected = self.library.capture_download({'project_token': None})
        self.assertFalse(self.downloads.exists(), 'Capturing a destination must not create it.')
        result = self.library.write_download(selected, 'Exact report.pdf', b'%PDF exact bytes\x00\xff')
        self.assertEqual(result['destination'], 'downloads')
        self.assertEqual(Path(result['path']).parent, self.downloads)
        self.assertEqual(Path(result['path']).read_bytes(), b'%PDF exact bytes\x00\xff')
        self.assertEqual(list(self.folder.iterdir()), [])
        self.assertEqual(stored_rows(self.store), before)

    def test_saved_and_native_opened_project_downloads_are_adjacent_without_modifying_project(self):
        saved = self.authorize()
        project = Path(saved['file']['path'])
        original = project.read_bytes()
        before = stored_rows(self.store)
        for token in (saved['file']['save_token'],):
            selected = self.library.capture_download({'project_token': token})
            receipt = self.library.write_download(selected, 'APPENDIX A.xlsx', b'exact workbook')
            self.assertEqual(Path(receipt['path']).parent, project.parent)
            self.assertEqual(receipt['destination'], 'project')
        self.dialogs.opened = str(project)
        opened = self.library.open_file()
        selected = self.library.capture_download({'project_token': opened['file']['save_token']})
        receipt = self.library.write_download(selected, 'APPENDIX A.pdf', b'exact report')
        self.assertEqual(Path(receipt['path']).parent, project.parent)
        self.assertEqual(project.read_bytes(), original)
        self.assertEqual(stored_rows(self.store), before)

    def test_captured_destination_survives_save_rotation_and_later_save_as(self):
        original = self.authorize()
        token = original['file']['save_token']
        selected = self.library.capture_download({'project_token': token})
        edited = copy.deepcopy(self.project_request)
        edited['estimate']['measurements'] = 'Saved during report rendering'
        rotated = self.library.save({'save_token': token, **edited})
        self.assertNotEqual(token, rotated['file']['save_token'])
        elsewhere = self.root / 'Other project'
        elsewhere.mkdir()
        self.authorize(elsewhere)
        receipt = self.library.write_download(selected, 'APPENDIX A.pdf', b'captured bytes')
        self.assertEqual(Path(receipt['path']).parent, self.folder)
        self.assertFalse((elsewhere / 'APPENDIX A.pdf').exists())
        with self.assertRaisesRegex(ValidationError, 'no longer available'):
            self.library.capture_download({'project_token': token})

    def test_invalid_stale_and_client_path_options_never_fall_back_or_write(self):
        saved = self.authorize()
        token = saved['file']['save_token']
        before = sorted(path.name for path in self.folder.iterdir())
        for value in (None, [], {}, {'project_token': False}, {'project_token': []}, {'project_token': 'unknown'},
                      {'project_token': token, 'path': str(self.root)}, {'path': str(self.root)}):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                self.library.capture_download(value)
        Path(saved['file']['path']).write_bytes(b'external replacement')
        with self.assertRaisesRegex(ValidationError, 'changed or was removed'):
            self.library.capture_download({'project_token': token})
        self.assertEqual(sorted(path.name for path in self.folder.iterdir()), before)
        self.assertFalse(self.downloads.exists())

    def test_duplicate_names_and_concurrent_writers_never_overwrite(self):
        destination = DownloadDestination(self.folder, 'project')
        existing = self.folder / 'APPENDIX A.pdf'
        existing.write_bytes(b'keep existing')
        with ThreadPoolExecutor(max_workers=8) as pool:
            receipts = list(pool.map(lambda index: write_download_file(destination, 'APPENDIX A.pdf', f'file {index}'.encode()), range(12)))
        self.assertEqual(existing.read_bytes(), b'keep existing')
        self.assertEqual(len({receipt['path'] for receipt in receipts}), 12)
        for index, receipt in enumerate(receipts):
            self.assertEqual(Path(receipt['path']).read_bytes(), f'file {index}'.encode())
        self.assertEqual({receipt['filename'] for receipt in receipts}, {f'APPENDIX A ({index}).pdf' for index in range(1, 13)})

    def test_failed_write_removes_only_its_partial_file(self):
        destination = DownloadDestination(self.folder, 'project')
        existing = self.folder / 'APPENDIX A.xlsx'
        existing.write_bytes(b'keep workbook')
        with patch('estimator.download_files.os.fsync', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(ValidationError, 'could not be saved'):
                write_download_file(destination, existing.name, b'partial new workbook')
        self.assertEqual(list(self.folder.iterdir()), [existing])
        self.assertEqual(existing.read_bytes(), b'keep workbook')

    def test_filename_and_unavailable_directory_are_rejected(self):
        destination = DownloadDestination(self.folder, 'project')
        for filename in ('../outside.pdf', 'C:\\outside.xlsx', 'bad/name.pdf', 'script.exe', '.hidden.pdf', 'bad..pdf'):
            with self.subTest(filename=filename), self.assertRaises(ValidationError):
                write_download_file(destination, filename, b'no write')
        with self.assertRaisesRegex(ValidationError, 'file content'):
            write_download_file(destination, 'Empty report.pdf', b'')
        with self.assertRaisesRegex(ValidationError, 'folder is unavailable'):
            write_download_file(DownloadDestination(self.root / 'missing', 'project'), 'report.pdf', b'no write')
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_linked_destination_is_rejected(self):
        linked = self.root / 'Linked'
        try:
            linked.symlink_to(self.folder, target_is_directory=True)
        except OSError:
            self.skipTest('This test account cannot create directory symlinks.')
        with self.assertRaisesRegex(ValidationError, 'regular folder'):
            write_download_file(DownloadDestination(linked, 'downloads'), 'report.pdf', b'no write')
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_windows_known_folder_and_linux_xdg_redirect_are_used(self):
        with patch('estimator.download_files.sys.platform', 'win32'), patch('estimator.download_files._windows_downloads', return_value=self.downloads):
            self.assertEqual(standard_downloads_directory(), self.downloads)
        config = self.root / '.config'
        config.mkdir()
        (config / 'user-dirs.dirs').write_text('XDG_DOWNLOAD_DIR="$HOME/Team downloads"\n', encoding='utf-8')
        with patch('estimator.download_files.sys.platform', 'linux'), patch('estimator.download_files.Path.home', return_value=self.root), patch.dict(os.environ, {'XDG_CONFIG_HOME': str(config)}):
            self.assertEqual(standard_downloads_directory(), self.root / 'Team downloads')
        self.assertFalse((self.root / 'Team downloads').exists())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows known folder read-only probe.')
    def test_real_windows_downloads_lookup_is_read_only_and_absolute(self):
        path = standard_downloads_directory()
        self.assertTrue(path.is_absolute())


class DownloadApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve()
        cls.downloads = cls.root / 'Downloads'
        cls.folder = cls.root / 'Projects'
        cls.folder.mkdir()
        cls.dialogs = Dialogs()
        cls.database = cls.root / 'state.sqlite3'
        cls.server = create_server(0, cls.database, cls.dialogs)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def request(self, path, body=None, method='POST'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=90)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_all_pdf_excel_routes_preserve_binary_contract_and_save_exact_bytes_when_requested(self):
        store = Store(self.database)
        quote = store.save_quote({'title': 'Saved download test', 'measurements': 'Retain authored note'})
        routes = [('/api/quote-report', {}, 'estimator.report.render_quote_pdf'),
                  (f"/api/quotes/{quote['id']}/report.pdf", {}, 'estimator.report.render_quote_pdf'),
                  ('/api/pricing/export', {}, 'estimator.pricing_workbook.export_pricing_workbook')]
        for identity in ('steel_vermiculite', 'steel_board', 'ductwork'):
            for action, builder in (('report.pdf', 'calculator_report.build_calculator_report'),
                                    ('summary.pdf', 'calculator_report.build_calculator_summary_report'),
                                    ('register.xlsx', 'calculator_register.build_calculator_register'),
                                    ('template', 'schedule_workbook.export_schedule_template')):
                routes.append((f'/api/calculators/{identity}/{action}', {}, f'estimator.{builder}'))
        before = stored_rows(store)
        with patch('estimator.download_files.standard_downloads_directory', return_value=self.downloads) as downloads:
            for index, (route, body, builder) in enumerate(routes):
                payload = b'exact generated bytes\x00\xff' + str(index).encode()
                with self.subTest(route=route), patch(builder, return_value=payload):
                    called = downloads.call_count
                    status, headers, binary = self.request(route, body)
                    self.assertEqual(status, 200, binary[:500])
                    self.assertNotIn('application/json', headers['Content-Type'])
                    self.assertEqual(binary, payload)
                    self.assertEqual(downloads.call_count, called)
                    status, headers, receipt = self.request(route, {**body, 'download': {'project_token': None}})
                    self.assertEqual(status, 200, receipt[:500])
                    self.assertIn('application/json', headers['Content-Type'])
                    receipt = json.loads(receipt)
                    self.assertTrue(receipt['saved'])
                    self.assertEqual(receipt['destination'], 'downloads')
                    self.assertEqual(Path(receipt['path']).parent, self.downloads)
                    self.assertEqual(Path(receipt['path']).read_bytes(), payload)
            with patch('estimator.report.render_quote_pdf', return_value=b'saved GET bytes'):
                status, headers, payload = self.request(f"/api/quotes/{quote['id']}/report.pdf", method='GET')
                self.assertEqual((status, payload), (200, b'saved GET bytes'))
                self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertEqual(stored_rows(store), before)

    def test_project_folder_is_captured_before_report_render_and_survives_concurrent_save(self):
        self.dialogs.selection = SaveSelection(str(self.folder / 'Captured project.json'), None)
        status, _, raw = self.request('/api/project/save-as', {'estimate': {'title': 'Capture before rendering'}})
        self.assertEqual(status, 200, raw[:500])
        saved = json.loads(raw)
        project = saved['project']
        request = {'save_token': saved['file']['save_token'], 'estimate': {key: project['estimate'][key] for key in ('title', 'workflow', 'measurements', 'inputs', 'configuration', 'project_no', 'client', 'site_address')},
                   'calculators': {key: {'inputs': value['inputs'], 'schedule_rows': value['schedule_rows']} for key, value in project['calculators'].items()}}
        def render(_):
            status, _, payload = self.request('/api/project/save', request)
            self.assertEqual(status, 200, payload[:500])
            return b'bytes rendered after token rotation'
        with patch('estimator.report.render_quote_pdf', side_effect=render), patch('estimator.download_files.standard_downloads_directory', side_effect=AssertionError('Must not fall back')):
            status, _, raw = self.request('/api/quote-report', {'download': {'project_token': saved['file']['save_token']}})
        self.assertEqual(status, 200, raw[:500])
        receipt = json.loads(raw)
        self.assertEqual(receipt['destination'], 'project')
        self.assertEqual(Path(receipt['path']).parent, self.folder)
        self.assertEqual(Path(receipt['path']).read_bytes(), b'bytes rendered after token rotation')

    def test_invalid_download_options_are_rejected_before_rendering_or_writing(self):
        with patch('estimator.report.render_quote_pdf') as render, patch('estimator.download_files.standard_downloads_directory') as downloads:
            for option in (None, {}, [], {'project_token': '../path'}, {'project_token': None, 'path': str(self.root)}):
                status, _, raw = self.request('/api/quote-report', {'download': option})
                self.assertEqual(status, 400, raw[:500])
            render.assert_not_called()
            downloads.assert_not_called()
        for route in ('/api/calculate', '/api/calculators/ductwork/worksheet'):
            status, _, raw = self.request(route, {'download': {'project_token': None}})
            self.assertEqual(status, 400, raw[:500])


if __name__ == '__main__':
    unittest.main()
