"""Saved-file links expose only original application-written PDF/XLSX files."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.download_files import DownloadDestination, SavedDownloadFiles, write_download_file
from estimator.server import create_server
from estimator.storage import Store
from estimator.project_file import export_project
from estimator.native_dialogs import SaveSelection


class SavedFileCapabilityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name).resolve()
        self.now = 0
        self.files = SavedDownloadFiles(clock=lambda: self.now, limit=2, ttl=10)

    def save(self, name='Report.pdf', payload=b'%PDF original'):
        receipt = write_download_file(DownloadDestination(self.folder, 'project'), name, payload)
        return self.files.register(receipt, payload)

    def token(self, receipt):
        return receipt['download_url'].rsplit('/', 1)[1]

    def test_capabilities_are_opaque_bound_and_read_original_bytes(self):
        first, second = self.save(), self.save()
        self.assertNotEqual(first['download_url'], second['download_url'])
        self.assertRegex(first['download_url'], r'^/api/download-files/[A-Za-z0-9_-]{32}$')
        self.assertIsNone(first['open_url'])
        self.assertEqual(self.files.read(self.token(first)), (Path(first['path']), b'%PDF original'))
        for token in (str(self.folder), '../Report.pdf', None, ''):
            with self.assertRaises(ValidationError): self.files.read(token)

    def test_excel_opens_only_after_explicit_action_using_default_application(self):
        receipt = self.save('Report.xlsx', b'exact workbook')
        with patch('estimator.download_files.sys.platform', 'win32'), patch('estimator.download_files.os.startfile', create=True) as opener:
            self.assertFalse(opener.called)
            self.assertEqual(self.files.open_workbook(self.token(receipt)), {'opened': True})
            opener.assert_called_once_with(receipt['path'])
        with self.assertRaisesRegex(ValidationError, 'Only saved Excel'):
            self.files.open_workbook(self.token(self.save()))

    def test_failed_default_application_is_explained(self):
        receipt = self.save('Report.xlsx', b'workbook')
        with patch('estimator.download_files.sys.platform', 'win32'), patch('estimator.download_files.os.startfile', create=True, side_effect=OSError('no association')):
            with self.assertRaisesRegex(ValidationError, 'default application'): self.files.open_workbook(self.token(receipt))

    def test_replaced_moved_and_modified_files_are_rejected(self):
        for action in ('modify', 'replace', 'move'):
            with self.subTest(action=action):
                receipt = self.save('Exact.pdf'); path = Path(receipt['path'])
                if action == 'modify': path.write_bytes(b'%PDF changed')
                elif action == 'replace': path.unlink(); path.write_bytes(b'%PDF replacement')
                else: path.rename(path.with_suffix('.moved'))
                with self.assertRaisesRegex(ValidationError, 'changed, moved or was removed'): self.files.read(self.token(receipt))

    def test_same_stat_content_change_is_detected_by_digest(self):
        receipt = self.save(); path = Path(receipt['path']); info = path.stat()
        path.write_bytes(b'%PDF changed!')
        import os
        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
        with self.assertRaises(ValidationError): self.files.read(self.token(receipt))

    def test_file_symlinks_are_rejected(self):
        receipt = self.save(); path = Path(receipt['path']); alternate = self.folder / 'Other.pdf'
        alternate.write_bytes(b'%PDF original'); path.unlink()
        try: path.symlink_to(alternate)
        except OSError: self.skipTest('This Windows user cannot create symbolic links.')
        with self.assertRaises(ValidationError): self.files.read(self.token(receipt))

    def test_reparse_points_are_rejected_without_requiring_symlink_privileges(self):
        receipt = self.save()
        with patch('estimator.project_library._linked', return_value=True):
            with self.assertRaises(ValidationError): self.files.read(self.token(receipt))

    def test_expiry_and_capacity_do_not_open_arbitrary_files(self):
        first = self.save(); self.save(); self.save()
        with self.assertRaisesRegex(ValidationError, 'expired'): self.files.read(self.token(first))
        latest = self.save(); self.now = 11
        with self.assertRaisesRegex(ValidationError, 'expired'): self.files.read(self.token(latest))


class SavedFileHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); cls.folder = Path(cls.temp.name).resolve()
        class Dialogs:
            def choose_save(self, folder, filename):
                return SaveSelection(str(cls.folder / 'Test.cf.json'), None)
        cls.server = create_server(0, cls.folder / 'state.sqlite3', project_dialogs=Dialogs())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        data = json.loads(export_project(Store(cls.folder / 'seed.sqlite3'), {'estimate': {'title': 'Test Project', 'client': 'Test Company', 'site_address': 'Test Address',
            'contact_name': 'Synthetic Contact', 'contact_phone': '0400 000 001', 'contact_email': 'project@example.test'}}))
        request = {'estimate':data['estimate'], 'calculators':{key:{'inputs':value['inputs'], 'schedule_rows':value['schedule_rows']} for key,value in data['calculators'].items()}}
        connection = http.client.HTTPConnection('127.0.0.1', cls.server.server_port)
        try:
            connection.request('POST', '/api/project/save-as', json.dumps(request), {'Content-Type':'application/json'})
            response=connection.getresponse(); receipt=response.read()
            if response.status != 200: raise AssertionError(receipt)
            cls.project_token=json.loads(receipt)['file']['save_token']
        finally: connection.close()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def request(self, path, body=None, method='GET', origin=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Content-Type': 'application/json'}
        if origin: headers['Origin'] = origin
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse(); return response.status, dict(response.getheaders()), response.read()
        finally: connection.close()

    def save(self, suffix):
        with patch('estimator.download_files.standard_downloads_directory', return_value=self.folder), patch('estimator.pricing_workbook.export_pricing_workbook', return_value=b'workbook bytes'):
            status, _, payload = self.request('/api/pricing/export', {'download': {'project_token': self.project_token}}, 'POST')
        self.assertEqual(status, 200, payload)
        return json.loads(payload)

    def test_workbook_receipt_link_serves_exact_bytes_and_opens_on_post_only(self):
        receipt = self.save('.xlsx'); url = receipt['download_url']
        status, headers, payload = self.request(url)
        self.assertEqual(status, 200); self.assertEqual(payload, b'workbook bytes')
        self.assertIn('attachment;', headers['Content-Disposition'])
        with patch('estimator.download_files.os.startfile', create=True) as opener, patch('estimator.download_files.sys.platform', 'win32'):
            self.assertEqual(self.request(receipt['open_url'])[0], 405)
            self.assertEqual(self.request(receipt['open_url'], {}, 'POST', 'http://evil.test')[0], 403)
            self.assertEqual(self.request(receipt['open_url'], {'path': 'C:/arbitrary.xlsx'}, 'POST')[0], 400)
            self.assertFalse(opener.called)
            self.assertEqual(self.request(receipt['open_url'], {}, 'POST')[0], 200)
            opener.assert_called_once_with(receipt['path'])

    def test_pdf_link_is_inline_and_never_launches_default_application(self):
        with patch('estimator.download_files.standard_downloads_directory', return_value=self.folder), patch('estimator.report.render_quote_pdf', return_value=b'%PDF bytes'):
            status, _, payload = self.request('/api/quote-report', {'download': {'project_token': self.project_token}}, 'POST')
        self.assertEqual(status, 200, payload); receipt = json.loads(payload)
        status, headers, payload = self.request(receipt['download_url'])
        self.assertEqual(status, 200); self.assertEqual(payload, b'%PDF bytes'); self.assertIn('inline;', headers['Content-Disposition'])
        self.assertEqual(self.request(receipt['download_url'] + '/open', {}, 'POST')[0], 400)
        Path(receipt['path']).unlink()
        self.assertEqual(self.request(receipt['download_url'])[0], 400)

    def test_reference_workbook_retains_no_project_exception_without_arbitrary_paths(self):
        with patch('estimator.download_files.standard_downloads_directory', return_value=self.folder), patch('estimator.pricing_workbook.export_pricing_workbook', return_value=b'library workbook'):
            status, _, payload = self.request('/api/pricing/export', {'download': {'project_token': None}}, 'POST')
            self.assertEqual(status, 200, payload); receipt = json.loads(payload)
            self.assertEqual(receipt['destination'], 'downloads'); self.assertRegex(receipt['download_url'], r'^/api/download-files/')
            status, _, _ = self.request('/api/pricing/export', {'download': {'project_token': None, 'path':'C:/arbitrary'}}, 'POST')
            self.assertEqual(status, 400)
