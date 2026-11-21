"""Downloaded diagrams match current illustrations without replacing evidence."""
import base64
from hashlib import sha256
from io import BytesIO
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from openpyxl import load_workbook
from PIL import Image
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.penetration_item_exports import prepare_item_snapshot, render_item_pdf
from estimator.penetration_report import render_penetration_pdf
from estimator.server import create_server
from estimator.storage import Store
from estimator.technical_item_exports import prepare_technical_item, render_technical_item_pdf, build_technical_item_xlsx
from estimator.technical_library_edits import ManualTechnicalLibrary
from technical_item_fixture_data import technical_library
from test_technical_item_exports import inventory, logical_database


class LibraryDisplayExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'library'
        technical_library(self.root)
        self.source = (self.root / 'images/diagram-a.png').read_bytes()
        self.store = Store(Path(self.temp.name) / 'test.sqlite3')
        self.library = ManualTechnicalLibrary(self.root, self.store)

    def install(self, color='#19ca52'):
        output = BytesIO()
        Image.new('RGB', (320, 160), color).save(output, format='PNG')
        payload = output.getvalue()
        archive = self.root / 'images_old'
        archive.mkdir(exist_ok=True)
        (archive / 'diagram-a.png').write_bytes(self.source)
        # Reproduce the live layout: replacement in images, original archived.
        (self.root / 'images/diagram-a.png').write_bytes(payload)
        folder = self.root / 'replicas'
        folder.mkdir(exist_ok=True)
        digest = sha256(payload).hexdigest()
        path = folder / (digest + '.png')
        path.write_bytes(payload)
        (folder / 'index.json').write_text(json.dumps({'version': 1, 'images': {
            'diagram-a': {'source_sha256': sha256(self.source).hexdigest(),
                          'file': path.name, 'sha256': digest, 'review': 'visual_review_passed'}}}), encoding='utf-8')
        return payload, path

    def snapshot(self, **extra):
        return prepare_item_snapshot({'item': {'id': 'line-1', 'library_item_id': 'pkb-001',
            'inputs': {'T': 'Current illustration', 'O': 1}}, **extra},
            library=self.library, default_configuration={})

    def assert_green_pdf(self, payload, size):
        images = [image.image.convert('RGB') for page in PdfReader(BytesIO(payload)).pages
                  for image in page.images if image.image.size == size]
        self.assertEqual(len(images), 1)
        red, green, blue = images[0].getpixel((size[0] // 2, size[1] // 2))
        self.assertLess(red, 40)
        self.assertGreater(green, 180)
        self.assertLess(blue, 100)

    def test_original_reader_and_unreplaced_downloads_preserve_source(self):
        self.assertEqual(self.library.display_asset('diagram-a')[0], self.source)
        self.assertEqual(self.snapshot()['diagram_identity']['source_sha256'], sha256(self.source).hexdigest())
        self.install()
        self.assertEqual(self.library.asset('diagram-a', False)[0], self.source)

    def test_technical_pdf_and_xlsx_embed_current_reviewed_pixels_without_writes(self):
        payload, _ = self.install()
        files, database = inventory(self.root), logical_database(self.store.path)
        snapshot = prepare_technical_item({'id': 'report-a-v1'}, library=self.library)
        self.assertEqual(snapshot['images'][0]['source_sha256'], sha256(payload).hexdigest())
        self.assert_green_pdf(render_technical_item_pdf(snapshot), (320, 160))
        workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)))
        try:
            image = workbook['Source Diagrams']._images[0]
            self.assertEqual((image.width, image.height), (320, 160))
            self.assertGreater(Image.open(BytesIO(image._data())).getpixel((160, 80))[1], 180)
        finally:
            workbook.close()
        self.assertEqual(inventory(self.root), files)
        self.assertEqual(logical_database(self.store.path), database)

    def test_firestopping_item_and_schedule_embed_current_full_and_thumbnail_images(self):
        payload, _ = self.install()
        self.assertEqual(self.library.diagram_asset('pkb-001')[0], payload)
        snapshot = self.snapshot()
        self.assert_green_pdf(render_item_pdf(snapshot), (320, 160))
        thumb = Image.open(BytesIO(self.library.diagram_asset('pkb-001', True)[0]))
        self.assert_green_pdf(render_penetration_pdf(snapshot['result'], snapshot['definition'], {},
                                                    library=self.library), thumb.size)

    def test_thumbnail_cache_changes_when_reviewed_replacement_changes(self):
        self.install()
        before = self.library.diagram_asset('pkb-001', True)[0]
        self.install('#1222dd')
        after = self.library.diagram_asset('pkb-001', True)[0]
        self.assertNotEqual(before, after)
        self.assertGreater(Image.open(BytesIO(after)).getpixel((80, 40))[2], 200)

    def test_saved_and_unsaved_item_images_keep_precedence_and_explicit_removal(self):
        replacement, _ = self.install()
        upload = {'filename': 'custom.png', 'content_base64': base64.b64encode(self.source).decode('ascii')}
        edit = self.library.edit('pkb-001')
        self.library.action('pkb-001', 'save', {**{key: edit[key] for key in ('draft', 'revision', 'pricing_token')},
                                               'diagram': upload})
        self.assertNotEqual(self.library.diagram_asset('pkb-001')[0], replacement)
        self.assertEqual(self.snapshot(diagram=upload)['diagram_identity']['kind'], 'current unsaved image')
        self.assertIsNone(self.snapshot(diagram=None)['diagram'])
        edit = self.library.edit('pkb-001')
        self.library.action('pkb-001', 'save', {**{key: edit[key] for key in ('draft', 'revision', 'pricing_token')},
                                               'diagram': None})
        self.assertEqual(self.library.diagram_asset('pkb-001')[0], replacement)

    def test_missing_or_changed_published_replacement_never_exports_archived_source(self):
        for changed in (True, False):
            with self.subTest(changed=changed):
                payload, path = self.install()
                if changed:
                    path.write_bytes(payload + b'changed')
                else:
                    path.unlink()
                for read in (lambda: self.library.display_asset('diagram-a'), self.snapshot,
                             lambda: prepare_technical_item({'id': 'report-a-v1'}, library=self.library)):
                    with self.assertRaises(ValidationError):
                        read()
                self.assertEqual(self.library.asset('diagram-a', False)[0], self.source)

    def test_archived_source_integrity_is_still_required(self):
        self.install()
        (self.root / 'images_old/diagram-a.png').write_bytes(self.source + b'changed')
        with self.assertRaisesRegex(ValidationError, 'source has changed'):
            self.snapshot()

    def test_http_downloads_match_published_library_illustration(self):
        replacement, _ = self.install()
        server = create_server(0, self.store.path, library_directory=self.root)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for method, route, body in (
                ('GET', '/api/libraries/replicas/diagram-a', None),
                ('POST', '/api/technical/item.pdf', {'id': 'report-a-v1'}),
                ('POST', '/api/penetration/item.pdf', {'item': {'id': 'line-1', 'library_item_id': 'pkb-001',
                                                             'inputs': {'O': 1}}}),
            ):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=30)
                try:
                    connection.request(method, route, json.dumps(body) if body else None,
                                       {'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    result = response.read()
                    self.assertEqual(response.status, 200, result[:300])
                    if method == 'GET':
                        self.assertEqual(result, replacement)
                    else:
                        self.assert_green_pdf(result, (320, 160))
                finally:
                    connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
