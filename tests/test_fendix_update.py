import json
import tempfile
import unittest
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from estimator.storage import Store
from estimator.technical_library_edits import TechnicalEdits
from scripts.normalize_fendix_fields import CONFIGURATIONS, URL, normalize


class FendixUpdateTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.database = Path(folder.name) / 'library.sqlite3'
        self.edits = TechnicalEdits(Store(self.database))
        self.keys = []
        for material, size, slab, rating in CONFIGURATIONS:
            key = 'user-technical-' + uuid5(NAMESPACE_URL, f'{URL}#{material}/{size}/{slab}/{rating}').hex
            record = {
                'id': key,
                'filter_values': {'manufacturer': ['Fendix'], 'report': ['RTL FA 2981.03'], 'frl': [rating]},
                'fields': [
                    {'label': 'Installation Details', 'value': 'An edited installation note.'},
                    {'label': 'Fixings', 'value': 'An edited fixing note.'},
                    {'label': 'Service Size / Configuration', 'value': (
                        f'{size} mm nominal pipe. Stack or floor waste through a core hole, or with an existing '
                        'cast-in collar. With or without a fitting within the limits of §8.2.')},
                ],
            }
            self.edits.save(key, 0, '', record, created=True)
            self.keys.append(key)

    def test_updates_original_fields_preserves_edits_and_respects_tombstones(self):
        self.assertEqual(normalize(self.database)['planned'], self.keys)
        self.assertTrue(all(row['revision'] == 1 for row in self.edits.read()[0].values()))
        self.assertEqual(normalize(self.database, apply=True)['changed'], self.keys)
        rows = self.edits.read()[0]
        self.assertTrue(rows[self.keys[-1]]['deleted'])
        for key in self.keys[:-1]:
            fields = {f['label']: f['value'] for f in rows[key]['record']['fields']}
            self.assertIn('with or without an existing cast-in collar', fields['Service Size / Configuration'])
            self.assertEqual(fields['Installation Details'], 'An edited installation note.\n\nFixings: An edited fixing note.')
            self.assertNotIn('Fixings', fields)
        self.assertEqual(normalize(self.database, apply=True)['changed'], [])
        self.assertEqual(self.edits.read()[0], rows)

    def test_mismatched_record_rolls_back_all_changes(self):
        with self.edits.store.connect() as db:
            record = json.loads(db.execute('SELECT data FROM technical_library_items WHERE id=?',
                                           (self.keys[-1],)).fetchone()[0])
            record['filter_values']['manufacturer'] = ['Other']
            db.execute('UPDATE technical_library_items SET data=? WHERE id=?',
                       (json.dumps(record), self.keys[-1]))
        before = self.edits.read()[0]
        with self.assertRaisesRegex(ValueError, 'no longer matches'):
            normalize(self.database, apply=True)
        self.assertEqual(self.edits.read()[0], before)
