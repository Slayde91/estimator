"""Offline application languages stay separate from project and source data."""
import hashlib
from html.parser import HTMLParser
import http.client
import json
from pathlib import Path
import runpy
import tempfile
import threading
import unittest

from estimator.server import DEFAULT_CONTENT_SECURITY_POLICY, create_server

ROOT = Path(__file__).resolve().parents[1]

class LanguageAssetsTests(unittest.TestCase):
    def test_catalog_is_complete_deterministic_and_current(self):
        builder = runpy.run_path(str(ROOT / 'scripts/build_language_catalog.py'))
        payload, count = builder['build']()
        self.assertGreater(count, 500)
        self.assertEqual((ROOT / 'static/language-catalog.js').read_text(encoding='utf-8'), payload)
        messages = {}
        for path in (ROOT / 'static/locales').glob('*.json'):
            messages.update(json.loads(path.read_text(encoding='utf-8')))
        for key in ['Language', 'Application language', 'Home', 'Settings', 'Document', 'Recalculate']:
            self.assertIn(key, messages)
            self.assertEqual(len(messages[key]), 5)
        class Markers(HTMLParser):
            def handle_starttag(inner, tag, attrs):
                for name, value in attrs:
                    if name.startswith('data-i18n'):
                        self.assertIn(value, messages, f'Missing static translation: {value}')
        Markers().feed((ROOT / 'static/index.html').read_text(encoding='utf-8'))

    def test_exact_assets_in_both_editions_preserve_security_and_database(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            for edition in ['full', 'standard']:
                server = create_server(0, folder / f'{edition}.sqlite3', library_directory=folder / f'library-{edition}', edition=edition)
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                database = folder / f'{edition}.sqlite3'
                before = hashlib.sha256(database.read_bytes()).hexdigest()
                def get(route):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                    try:
                        connection.request('GET', route); response = connection.getresponse()
                        return response.status, dict(response.getheaders()), response.read()
                    finally: connection.close()
                try:
                    for name, mime in [('language.js', 'text/javascript; charset=utf-8'), ('language-catalog.js', 'text/javascript; charset=utf-8'), ('language.css', 'text/css; charset=utf-8')]:
                        status, headers, body = get('/' + name)
                        self.assertEqual(status, 200)
                        self.assertEqual(headers['Content-Type'], mime)
                        self.assertEqual(headers['Content-Security-Policy'], DEFAULT_CONTENT_SECURITY_POLICY)
                        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                        self.assertEqual(body, (ROOT / 'static' / name).read_bytes())
                        self.assertEqual(get('/' + name + '/extra')[0], 404)
                    status, _, body = get('/')
                    self.assertEqual(status, 200)
                    self.assertIn(b'id="application-language"', body)
                    for locale in ['en', 'zh-Hans', 'hi', 'es', 'ar', 'th']:
                        self.assertIn(f'value="{locale}"'.encode(), body)
                    if edition == 'standard': self.assertNotIn(b'/takeoffs.js', body)
                    self.assertEqual(before, hashlib.sha256(database.read_bytes()).hexdigest())
                finally:
                    server.shutdown(); server.server_close(); thread.join()
