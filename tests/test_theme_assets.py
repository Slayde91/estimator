"""Theme assets are presentation-only in full and standard editions."""

import hashlib
import http.client
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.server import DEFAULT_CONTENT_SECURITY_POLICY, create_server


ROOT = Path(__file__).resolve().parents[1]


class ThemeAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temporary.name)
        cls.servers = {}
        cls.threads = []
        for edition in ('full', 'standard'):
            server = create_server(0, cls.folder / (edition + '.sqlite3'),
                                   library_directory=cls.folder / ('library-' + edition), edition=edition)
            cls.servers[edition] = server
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers.values():
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join()
        cls.temporary.cleanup()

    def get(self, edition, route):
        connection = http.client.HTTPConnection('127.0.0.1', self.servers[edition].server_port, timeout=30)
        try:
            connection.request('GET', route)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_exact_assets_and_html_are_available_without_changing_policy_or_database(self):
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.glob('*.sqlite3')}
        for edition in self.servers:
            with self.subTest(edition=edition):
                for name, mime in [('theme.js', 'text/javascript; charset=utf-8'), ('theme.css', 'text/css; charset=utf-8')]:
                    status, headers, payload = self.get(edition, '/' + name)
                    self.assertEqual(status, 200)
                    self.assertEqual(payload, (ROOT / 'static' / name).read_bytes())
                    self.assertEqual(headers['Content-Type'], mime)
                    self.assertEqual(headers['Content-Security-Policy'], DEFAULT_CONTENT_SECURITY_POLICY)
                    self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                status, _, html = self.get(edition, '/')
                self.assertEqual(status, 200)
                self.assertIn(b'id="theme-toggle" type="button"', html)
                self.assertIn(b'href="/theme.css"', html)
                self.assertIn(b'src="/theme.js" defer', html)
                if edition == 'standard':
                    self.assertNotIn(b'/takeoffs.js', html)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.glob('*.sqlite3')})

    def test_theme_routes_keep_the_exact_asset_boundary(self):
        for edition in self.servers:
            for route in ('/theme.js/extra', '/theme.css/extra', '/theme-settings.json'):
                with self.subTest(edition=edition, route=route):
                    self.assertEqual(self.get(edition, route)[0], 404)
