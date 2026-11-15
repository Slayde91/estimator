from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceNotFound
from estimator.storage import Store
from estimator.technical_discovery import SNAP_FILTER_SOURCE
from estimator.technical_item_exports import prepare_technical_item
from estimator.technical_library_edits import ManualTechnicalLibrary, SOURCE_IMAGE_PREFIX
from scripts.install_snap_library import install
from test_firestopping_library import editable_library


class SnapLibraryInstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'library'
        editable_library(self.source)
        self.base_index = (self.source / 'library.json').read_bytes()
        self.store = Store(self.root / 'state.sqlite3')
        self.library = ManualTechnicalLibrary(self.source, self.store)
        image = BytesIO()
        Image.new('RGB', (60, 45), 'white').save(image, format='PNG')
        self.png = image.getvalue()
        (self.root / 'drawing.png').write_bytes(self.png)
        self.digest = hashlib.sha256(self.png).hexdigest()
        self.image_id = SOURCE_IMAGE_PREFIX + self.digest
        self.systems = []
        for number in (1, 2):
            key = f'user-technical-{number:032x}'
            record = {'id': key, 'title': f'Example {number}', 'summary': '', 'subtitle': '',
                      'source_label': SNAP_FILTER_SOURCE, 'editable': True,
                      'sources': [{'label': 'Product', 'url': 'https://www.snapcollars.com.au/product/example'}],
                      'fields': [{'label': 'Manufacturer', 'value': 'Snap'},
                                 {'label': 'System Products', 'value': 'Example collar'},
                                 {'label': 'Installation Details', 'value': 'Install as shown in the drawing.'},
                                 {'label': 'FRL', 'value': '-/120/90'}],
                      'filter_values': {'manufacturer': ['Snap'], 'frl': ['-/120/90'], 'services': ['PEX-AL-PEX']}}
            self.systems.append({'record': record, 'drawings': [
                {'path': 'drawing.png', 'sha256': self.digest, 'caption': 'Drawing page 1'}]})

    def write_manifest(self, systems, apply):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'systems': systems}), encoding='utf-8')
        return install(manifest, self.source, self.store.path, apply)

    def test_atomic_import_shared_png_search_export_and_idempotent_replay(self):
        baseline = self.library.listing('technical')['total']
        self.assertEqual(self.write_manifest(self.systems, False)['planned'], 2)
        self.assertEqual(self.library.listing('technical')['total'], baseline)
        result = self.write_manifest(self.systems, True)
        self.assertEqual((result['new'], result['new_drawings'], result['drawing_references']), (2, 1, 2))
        ids = [system['record']['id'] for system in self.systems]
        found = self.library.listing('technical', manufacturer='Snap', frl='-/120/90', inspection='1')
        self.assertEqual({row['id'] for row in found['items']}, set(ids))
        services = next(f['options'] for f in found['filters'] if f['key'] == 'services')
        self.assertEqual(next(s['group'] for s in services if s['value'] == 'PEX-AL-PEX'), 'Plastic pipes')
        self.assertEqual(self.library.detail('technical', ids[0])['images'][0]['id'], self.image_id)
        self.assertEqual(self.library.asset(self.image_id, pdf=False), (self.png, 'image/png', self.image_id + '.png'))
        self.assertTrue(self.library.image_thumbnail(self.image_id).startswith(b'\xff\xd8'))
        self.assertEqual(prepare_technical_item({'id': ids[0]}, library=self.library)['images'][0]['source_sha256'], self.digest)
        self.assertEqual(self.write_manifest(self.systems, True)['already_verified'], 2)
        self.assertEqual(self.library.listing('technical')['total'], baseline + 2)
        self.assertEqual((self.source / 'library.json').read_bytes(), self.base_index)
        # A shared source remains available until the last referring record is removed.
        for key in ids:
            edit = self.library.technical_edit(key)
            self.library.technical_delete(key, {'revision': edit['revision'], 'source_sha256': edit['source_sha256']})
            if key == ids[0]:
                self.assertEqual(self.library.asset(self.image_id, pdf=False)[0], self.png)
        with self.assertRaises(ReferenceNotFound):
            self.library.asset(self.image_id, pdf=False)

    def test_conflict_rolls_back_earlier_row_and_preserves_existing_record(self):
        self.write_manifest([self.systems[1]], True)
        conflicts = deepcopy(self.systems)
        conflicts[1]['record']['title'] = 'Conflicting import'
        with self.assertRaisesRegex(ValueError, 'Existing record differs'):
            self.write_manifest(conflicts, True)
        rows, _ = self.library.technical_edits.read()
        self.assertEqual(set(rows), {self.systems[1]['record']['id']})
        self.assertEqual(next(iter(rows.values()))['record']['title'], 'Example 2')
        self.assertEqual(next(iter(rows.values()))['revision'], 1)

    def test_tampered_drawing_and_unknown_fields_fail_closed(self):
        systems = deepcopy(self.systems)
        systems[0]['record']['fields'].append({'label': 'Invented attribute', 'value': 'No'})
        with self.assertRaisesRegex(ValueError, 'Unrecognised'):
            self.write_manifest(systems, True)
        self.assertEqual(self.library.technical_edits.read()[0], {})
        self.write_manifest(self.systems, True)
        with self.store.connect() as db:
            db.execute('UPDATE technical_library_source_images SET image_data=?', (b'corrupt',))
        with self.assertRaisesRegex(ValueError, 'Existing source drawing differs'):
            self.write_manifest(self.systems, True)
        with self.assertRaisesRegex(ValidationError, 'could not be verified'):
            self.library.asset(self.image_id, pdf=False)

    def test_unavailable_drawing_is_recorded_without_an_illustration(self):
        system = self.systems[0]
        system['drawings'] = []
        with self.assertRaisesRegex(ValueError, 'Missing drawing'):
            self.write_manifest([system], True)
        system['record']['fields'].append({'label': 'Source Issues', 'value': 'No matching published drawing.'})
        self.assertEqual(self.write_manifest([system], True)['new_drawings'], 0)
        item = self.library.detail('technical', system['record']['id'])
        self.assertFalse(item['images'])
        self.assertIsNone(item['thumbnail_url'])
