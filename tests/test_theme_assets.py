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
                for name, mime in [('theme.js', 'text/javascript; charset=utf-8'), ('theme.css', 'text/css; charset=utf-8'),
                                   ('laser.css', 'text/css; charset=utf-8'), ('laser-steel.svg', 'image/svg+xml'),
                                   ('home-steel-frame.png', 'image/png'),
                                   ('header-layout.css', 'text/css; charset=utf-8'), ('workspace-art.css', 'text/css; charset=utf-8'), ('header-steel-spray.png', 'image/png'), ('header-steel-board.png', 'image/png'), ('header-ductwork.png', 'image/png'), ('header-firestopping.png', 'image/png'), ('header-estimate.png', 'image/png'),
                                   ('icons/navigation-help.jpg', 'image/jpeg'), ('icons/navigation-takeoffs.jpg', 'image/jpeg')]:
                    status, headers, payload = self.get(edition, '/' + name)
                    if edition == 'standard' and name == 'icons/navigation-takeoffs.jpg':
                        self.assertEqual(status, 404)
                        continue
                    self.assertEqual(status, 200)
                    self.assertEqual(payload, (ROOT / 'static' / name).read_bytes())
                    self.assertEqual(headers['Content-Type'], mime)
                    self.assertEqual(headers['Content-Security-Policy'], DEFAULT_CONTENT_SECURITY_POLICY)
                    self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                status, _, html = self.get(edition, '/')
                self.assertEqual(status, 200)
                self.assertIn(b'id="theme-toggle" type="button"', html)
                self.assertIn(b'href="/theme.css"', html)
                self.assertIn(b'href="/laser.css"', html)
                self.assertIn(b'src="/home-steel-frame.png"', html)
                self.assertIn(b'href="/header-layout.css"', html)
                self.assertIn(b'href="/workspace-art.css"', html)
                self.assertIn(b'src="/header-steel-spray.png"', html)
                self.assertIn(b'src="/header-steel-board.png"', html)
                self.assertIn(b'src="/header-ductwork.png"', html)
                self.assertIn(b'src="/header-firestopping.png"', html)
                self.assertIn(b'src="/header-estimate.png"', html)
                self.assertIn(b'src="/theme.js" defer', html)
                if edition == 'standard':
                    self.assertNotIn(b'/takeoffs.js', html)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.glob('*.sqlite3')})

    def test_theme_routes_keep_the_exact_asset_boundary(self):
        for edition in self.servers:
            for route in ('/theme.js/extra', '/theme.css/extra', '/laser.css/extra', '/laser-steel.svg/extra', '/home-steel-frame.png/extra', '/theme-settings.json', '/header-layout.css/extra', '/workspace-art.css/extra', '/header-steel-spray.png/extra', '/header-steel-board.png/extra', '/header-ductwork.png/extra', '/header-firestopping.png/extra', '/header-estimate.png/extra'):
                with self.subTest(edition=edition, route=route):
                    self.assertEqual(self.get(edition, route)[0], 404)

    def test_takeoff_heading_art_is_full_edition_only(self):
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.glob('*.sqlite3')}
        for name in ('takeoff-header-steel.png', 'takeoff-header-ductwork.png', 'takeoff-header-physical.png', 'takeoff-header-service-plans.png'):
            with self.subTest(asset=name):
                status, headers, payload = self.get('full', '/' + name)
                self.assertEqual(status, 200)
                self.assertEqual(payload, (ROOT / 'static' / name).read_bytes())
                self.assertTrue(payload.startswith(b'\x89PNG\r\n\x1a\n'))
                self.assertEqual(headers['Content-Type'], 'image/png')
                self.assertEqual(headers['Content-Security-Policy'], DEFAULT_CONTENT_SECURITY_POLICY)
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(self.get('standard', '/' + name)[0], 404)
                for edition in self.servers:
                    self.assertEqual(self.get(edition, '/' + name + '/extra')[0], 404)
                    self.assertEqual(self.get(edition, '/static/' + name)[0], 404)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.glob('*.sqlite3')})
