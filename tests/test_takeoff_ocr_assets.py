"""Pinned local OCR delivery, integrity and edition/CSP boundaries."""
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from estimator.catalog import ROOT
from estimator.edition import excluded_route
from estimator.server import create_server


class LocalOCRAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.server = create_server(0, Path(cls.temporary.name) / 'qa.sqlite3')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def request(self, route, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request(method, route, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_exact_public_manifest_retains_versions_models_licenses_and_sha512_sources(self):
        directory = ROOT / 'static/vendor/ocr'
        manifest = json.loads((directory / 'manifest.json').read_text('utf8'))
        self.assertEqual(manifest['engine_version'], '7.0.0')
        self.assertEqual(manifest['core_version'], '7.0.0')
        self.assertEqual(manifest['model'], '4.0.0_best_int')
        self.assertEqual(manifest['runtime'], 'local-only')
        self.assertEqual(manifest['authority'], 'approximate-search-only')
        self.assertEqual(len(manifest['packages']), 3)
        self.assertTrue(all(entry['source_url'].startswith('https://registry.npmjs.org/') and entry['integrity'].startswith('sha512-') for entry in manifest['packages']))
        required = {'worker.min.js', 'lang/eng.traineddata.gz', 'TESSERACT-JS-LICENSE.md',
                    'CORE-LICENSE.txt', 'MODEL-LICENSE.txt', 'WORKER-NOTICES.txt', 'NOTICE.txt'}
        required.update('core/tesseract-core' + variant + '-lstm.wasm.js' for variant in ('', '-simd', '-relaxedsimd'))
        self.assertTrue(required <= set(manifest['files']))
        for name, entry in manifest['files'].items():
            with self.subTest(name=name):
                self.assertNotIn('..', Path(name).parts)
                data = (directory / name).read_bytes()
                self.assertEqual(len(data), entry['size'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
        self.assertEqual(manifest['files']['lang/eng.traineddata.gz']['sha256'], '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91')

    def test_wasm_policy_applies_only_to_dedicated_recognition_worker(self):
        status, headers, _ = self.request('/vendor/ocr/worker.min.js')
        self.assertEqual(status, 200)
        self.assertIn("script-src 'self' 'wasm-unsafe-eval'", headers['Content-Security-Policy'])
        self.assertIn("connect-src 'self'", headers['Content-Security-Policy'])
        self.assertIn("worker-src 'none'", headers['Content-Security-Policy'])
        for route in ('/', '/takeoff-search.js', '/vendor/ocr/core/tesseract-core-lstm.wasm.js', '/vendor/ocr/lang/eng.traineddata.gz', '/vendor/pdfjs/build/pdf.mjs'):
            with self.subTest(route=route):
                status, headers, _ = self.request(route)
                self.assertEqual(status, 200)
                self.assertNotIn('wasm-unsafe-eval', headers['Content-Security-Policy'])
                self.assertNotIn("'unsafe-eval'", headers['Content-Security-Policy'])
                self.assertNotIn("'unsafe-inline'", headers['Content-Security-Policy'])

    def test_ocr_assets_use_allowlist_integrity_method_and_loopback_origin_guards(self):
        for route in ('/vendor/ocr/manifest.json', '/vendor/ocr/../manifest.json', '/vendor/ocr/core/not-installed.js', '/api/takeoffs/ocr'):
            self.assertEqual(self.request(route)[0], 404)
        self.assertEqual(self.request('/vendor/ocr/worker.min.js', 'POST')[0], 405)
        self.assertEqual(self.request('/vendor/ocr/worker.min.js', headers={'Origin': 'https://external.invalid'})[0], 403)
        original = Path.read_bytes
        def altered(path):
            data = original(path)
            return data + b'changed' if path == ROOT / 'static/vendor/ocr/worker.min.js' else data
        with patch.object(Path, 'read_bytes', altered):
            status, _, body = self.request('/vendor/ocr/worker.min.js')
        self.assertEqual(status, 400)
        self.assertIn(b'integrity check', body)

    def test_standard_edition_excludes_recognition_assets_without_takeoff_initialization(self):
        routes = ['/vendor/ocr', '/vendor/ocr/worker.min.js', '/vendor/ocr/lang/eng.traineddata.gz',
                  '/static/vendor/ocr', '/static/vendor/ocr/core/tesseract-core-lstm.wasm.js']
        with tempfile.TemporaryDirectory() as temporary:
            server = create_server(0, Path(temporary) / 'standard.sqlite3', edition='standard')
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for route in routes:
                    self.assertTrue(excluded_route(route, 'standard'))
                    self.assertFalse(excluded_route(route, 'full'))
                    for method in ('GET', 'HEAD'):
                        connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                        connection.request(method, route)
                        response = connection.getresponse()
                        self.assertEqual(response.status, 404)
                        response.read()
                        connection.close()
                self.assertFalse((Path(temporary) / 'takeoffs').exists())
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
