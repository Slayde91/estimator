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
            base = builder['read_catalog'](path)
            additions = builder['read_catalog'](path.parent / 'additions' / path.name)
            self.assertEqual(set(base), set(additions), path.name)
            for source, translations in base.items():
                self.assertEqual(len(translations), 5)
                self.assertEqual(len(additions[source]), 3)
                messages[source] = translations + additions[source]
        for key in ['Language', 'Application language', 'Home', 'Settings', 'Document', 'Recalculate']:
            self.assertIn(key, messages)
            self.assertEqual(len(messages[key]), 8)
        self.assertEqual(builder['LANGUAGES'], ('zh-Hans', 'hi', 'es', 'ar', 'th', 'ko', 'tl', 'vi', 'fr', 'bn', 'ur'))
        for locale in builder['EXTRA_LANGUAGES']:
            extra = builder['read_catalog'](ROOT / f'static/locales/extra/{locale}.json')
            self.assertEqual(set(extra), set(messages))
            for source, translation in extra.items():
                builder['validate_translations'](ROOT / f'{locale}.json', source, [translation], [locale])
        compiled = json.loads(payload.split('Object.freeze(', 1)[1].rsplit(');', 1)[0])
        self.assertTrue(all(len(translations) == 11 for translations in compiled.values()))
        for source, original_translations in messages.items():
            self.assertEqual(compiled[source][:8], original_translations)
        class Markers(HTMLParser):
            def handle_starttag(inner, tag, attrs):
                for name, value in attrs:
                    if name.startswith('data-i18n'):
                        self.assertIn(value, messages, f'Missing static translation: {value}')
        Markers().feed((ROOT / 'static/index.html').read_text(encoding='utf-8'))

    def test_duplicate_keys_and_placeholder_multiplicity_are_rejected(self):
        builder = runpy.run_path(str(ROOT / 'scripts/build_language_catalog.py'))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'duplicate.json'
            path.write_text('{"Home":["a"],"Home":["b"]}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate source message'):
                builder['read_catalog'](path)
            with self.assertRaisesRegex(ValueError, 'placeholders changed'):
                builder['validate_translations'](path, '{0} + {0} = {1}', ['{0} = {1}'], ['ko'])
            with self.assertRaisesRegex(ValueError, 'missing languages'):
                builder['validate_translations'](path, 'Home', ['홈'], ['ko', 'tl', 'vi'])

    def test_missing_additional_message_cannot_be_published_as_complete(self):
        builder = runpy.run_path(str(ROOT / 'scripts/build_language_catalog.py'))
        build = builder['build']
        original_root = build.__globals__['ROOT']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            locales = root / 'static/locales'
            (locales / 'additions').mkdir(parents=True)
            (locales / 'test.json').write_text(json.dumps({'Home': ['一', 'एक', 'Uno', 'واحد', 'หนึ่ง']}), encoding='utf-8')
            (locales / 'additions/test.json').write_text('{}', encoding='utf-8')
            try:
                build.__globals__['ROOT'] = root
                with self.assertRaisesRegex(ValueError, 'source keys differ'):
                    build()
                (locales / 'additions/test.json').write_text(json.dumps({'Home': ['홈', 'Simula', 'Trang chủ']}), encoding='utf-8')
                (locales / 'extra').mkdir()
                for locale, translation in [('fr', 'Accueil'), ('bn', 'হোম'), ('ur', 'ہوم')]:
                    (locales / f'extra/{locale}.json').write_text(json.dumps({'Home': translation}), encoding='utf-8')
                self.assertEqual(build()[1], 1)
                (locales / 'extra/ur.json').write_text('{}', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'source keys differ'):
                    build()
            finally:
                build.__globals__['ROOT'] = original_root

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
                    for locale in ['en', 'zh-Hans', 'hi', 'es', 'ar', 'th', 'ko', 'tl', 'vi', 'fr', 'bn', 'ur']:
                        self.assertIn(f'value="{locale}"'.encode(), body)
                    if edition == 'standard': self.assertNotIn(b'/takeoffs.js', body)
                    self.assertEqual(before, hashlib.sha256(database.read_bytes()).hexdigest())
                finally:
                    server.shutdown(); server.server_close(); thread.join()
