"""The two user corrections apply only to the eight identified manual table rows."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from scripts import install_allproof_manuals as importer


class AllproofManualCorrectionsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.bundle = root / 'bundle'
        self.library = root / 'library'
        self.database = root / 'test.sqlite3'
        self.database.touch()
        self.library.mkdir()
        labels = ['System Products', 'Barrier Type', 'Installation Type', 'Barrier Construction',
                  'Service', 'Service Size / Configuration', 'Installation Details', 'Install Notes']
        source = {'items': [{'fields': [{'label': label} for label in labels]}]}
        (self.library / 'library.json').write_text(json.dumps({'libraries': {'technical': source}}), encoding='utf-8')

        manuals, digests = {}, {}
        for family in ('electrical', 'plumbing'):
            directory = self.bundle / family
            (directory / 'diagrams').mkdir(parents=True)
            manual = (family + ' original edition').encode('ascii')
            (directory / 'manual.pdf').write_bytes(manual)
            manuals[family] = ('manual.pdf', hashlib.sha256(manual).hexdigest())
            drawing = 'diagrams/p45-1.png' if family == 'plumbing' else 'diagrams/electrical.png'
            Image.new('RGB', (16, 16), color='blue').save(directory / drawing)
            row = {'key': 'earlier-' + family, 'title': 'Earlier ' + family, 'page': 1,
                   'source_locator': 'Previous page', 'source_url': 'https://allproof.com.au/manual.pdf',
                   'reports': ['Fixture report'], 'diagrams': [drawing],
                   'fields': {label: 'Fixture' for label in labels},
                   'facets': {'substrate': ['Plasterboard wall'], 'orientation': ['Vertical'],
                              'type': ['Core hole'], 'category': ['Mixed Services'],
                              'services': ['Mixed Services'], 'frl': ['-/60/60']}}
            manifest = json.dumps([row]).encode('utf-8')
            (directory / 'manifest.json').write_bytes(manifest)
            digest = hashlib.sha256(manifest)
            digest.update(drawing.encode('utf-8') + b'\0' + hashlib.sha256((directory / drawing).read_bytes()).digest())
            digests[family] = digest.hexdigest()
        self.enterContext(patch.object(importer, 'MANUALS', manuals))
        self.enterContext(patch.object(importer, 'REVIEWED_BUNDLES', digests))

    def install(self, apply):
        return importer.install(self.bundle, self.library, self.database, apply)

    def items(self):
        with closing(sqlite3.connect(self.database)) as db:
            return {key: (revision, json.loads(data)) for key, revision, data in
                    db.execute('SELECT id, revision, data FROM technical_library_items')}

    def test_corrected_rows_keep_their_own_specimens_and_ratings(self):
        self.install(True)
        records = [data for _, data in self.items().values()]
        cable_rows = [row for row in records if row['filter_values']['report'] == ['148639']]
        self.assertEqual(len(cable_rows), 7)
        # Six specimens reached 30 minutes of insulation. Seven TPS cables did not.
        expected = [
            ('1 × TPS', '28 mm', '-/30/30'), ('7 × TPS', '32 mm', '-/30/-'),
            ('1 × CAT6', '28 mm', '-/30/30'), ('10 × CAT6', '28 mm', '-/30/30'),
            ('1 × Fire Alarm', '28 mm', '-/30/30'), ('10 × Fire Alarm', '28 mm', '-/30/30'),
            ('1 × 16 mm Mains', '28 mm', '-/30/30'),
        ]
        for service, hole, rating in expected:
            with self.subTest(service=service):
                matches = [record for record in cable_rows if service.casefold() in record['title'].casefold()]
                self.assertEqual(len(matches), 1)
                record = matches[0]
                fields = {f['label']: f['value'] for f in record['fields']}
                self.assertEqual(record['filter_values']['frl'], [rating])
                self.assertIn(hole, fields['Service Size / Configuration'])
                self.assertIn('13 mm fire-rated plasterboard', fields['Barrier Construction'].lower())
                self.assertIn('64 mm', fields['Barrier Construction'])
                self.assertIn('6.5 × 32 mm', fields['Installation Details'])
                self.assertIn('user', fields['Install Notes'].lower())
                self.assertIn('148639', fields['Install Notes'])
                self.assertTrue(record['images'])
                self.assertTrue(record['sources'][0]['url'].endswith('#page=12'))

        pipes = [row for row in records if row['filter_values']['report'] == ['149096']]
        self.assertEqual(len(pipes), 1)
        pipe = pipes[0]
        fields = {f['label']: f['value'] for f in pipe['fields']}
        self.assertIn('DIFC100', fields['System Products'])
        for dimension in ('90 mm', '3.5 mm', '142 mm'):
            self.assertIn(dimension, fields['Service Size / Configuration'])
        self.assertIn('150 mm', fields['Barrier Construction'])
        self.assertIn('M5 × 22 mm', fields['Installation Details'])
        self.assertIn('-180/120', fields['Install Notes'])
        self.assertIn('user', fields['Install Notes'].lower())
        self.assertEqual(pipe['filter_values']['frl'], ['-/180/120'])
        self.assertTrue(pipe['images'])
        self.assertTrue(pipe['sources'][0]['url'].endswith('#page=43'))

    def test_install_adds_eight_and_replay_preserves_records_and_diagrams(self):
        with patch.object(importer, 'confirmed_rows', return_value=[]):
            self.assertEqual(self.install(True)['new'], 2)
        originals = self.items()
        self.assertEqual(self.install(False)['planned'], 8)
        self.assertEqual(self.items(), originals)
        self.assertEqual(self.install(True)['new'], 8)
        first = self.items()
        for key, original in originals.items():
            self.assertEqual(first[key], original)
        self.assertEqual(self.install(True)['new'], 0)
        self.assertEqual(self.items(), first)
        with closing(sqlite3.connect(self.database)) as db:
            image_ids = {image_id for image_id, in db.execute('SELECT id FROM technical_library_diagrams')}
        self.assertEqual(image_ids, {image['id'] for _, record in first.values() for image in record['images']})

    def test_conflict_in_second_manual_rolls_back_the_electrical_additions(self):
        with patch.object(importer, 'confirmed_rows', return_value=[]):
            self.install(True)
        key, row = next((key, row) for key, (_, row) in self.items().items() if row['title'] == 'Earlier plumbing')
        row['title'] = 'Locally edited record'
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('UPDATE technical_library_items SET data=? WHERE id=?', (json.dumps(row), key))
            db.commit()
        before = self.items()
        with self.assertRaisesRegex(ValueError, 'Existing item differs'):
            self.install(True)
        self.assertEqual(self.items(), before)
