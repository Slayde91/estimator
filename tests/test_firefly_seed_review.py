"""Private factory seed keeps an optional review separate from original bytes."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.firefly_reference_review import PLAN_NAME, REPORTS
from estimator.firestopping_library import FirestoppingLibrary
from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from estimator.desktop_seed import initialize_data, verified_manifest
from scripts.prepare_desktop_seed import prepare
from test_firefly_reference_review import fixture, plan_for, write_plan


class FireflySeedReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / 'source-library'
        self.pdf = b'%PDF-1.4\nSynthetic Firefly review fixture only.\n%%EOF'
        self.patch = patch.dict(REPORTS, {key: (revision, hashlib.sha256(self.pdf).hexdigest())
                                        for key, (revision, _) in REPORTS.items()})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.data = fixture(self.library)
        for report in REPORTS:
            (self.library / 'documents' / (report + '.pdf')).write_bytes(self.pdf)
        self.database = self.root / 'synthetic.sqlite3'
        self.store = Store(self.database)
        FirestoppingLibrary(self.library, self.store)  # Explicit owned fixture schema only.

    def test_seed_copies_valid_review_exactly_without_serializing_projected_index(self):
        plan = plan_for(self.library, self.data)
        source_review = write_plan(self.library, plan)
        original_index = (self.library / 'library.json').read_bytes()
        original_review = source_review.read_bytes()
        output = self.root / 'seed'
        prepare(output, self.library, self.database)
        copied = output / 'reference-library'
        self.assertEqual((copied / 'library.json').read_bytes(), original_index)
        self.assertEqual((copied / 'reviews' / PLAN_NAME).read_bytes(), original_review)
        self.assertEqual((self.library / 'library.json').read_bytes(), original_index)
        item = ReferenceLibrary(copied).detail('penetration', 'pkb-001')
        self.assertEqual([link['id'] for link in item['links']],
                         ['fas190234-system-v1', 'fas190235-system-v11a'])
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        entry = next(f for f in manifest['files'] if f['path'] == 'reference-library/reviews/' + PLAN_NAME)
        self.assertEqual(entry['sha256'], hashlib.sha256(original_review).hexdigest())
        self.assertEqual(entry['size'], len(original_review))
        destination = self.root / 'installed'
        self.assertTrue(initialize_data(output, destination)['initialized'])
        installed = destination / 'reference-library'
        self.assertEqual((installed / 'library.json').read_bytes(), original_index)
        self.assertEqual((installed / 'reviews' / PLAN_NAME).read_bytes(), original_review)
        self.assertEqual([link['id'] for link in ReferenceLibrary(installed).detail('penetration', 'pkb-001')['links']],
                         ['fas190234-system-v1', 'fas190235-system-v11a'])

    def test_seed_without_review_keeps_original_reference_behavior(self):
        output = self.root / 'seed-no-review'
        prepare(output, self.library, self.database)
        copied = output / 'reference-library'
        self.assertFalse((copied / 'reviews').exists())
        self.assertEqual(ReferenceLibrary(copied).detail('penetration', 'pkb-001')['links'][0]['id'],
                         'report-a-v1')

    def test_stale_review_rejects_seed_instead_of_dropping_or_baking_correction(self):
        plan = deepcopy(plan_for(self.library, self.data))
        plan['items'][0]['targets'][1]['page'] = 13
        write_plan(self.library, plan)
        before = (self.library / 'library.json').read_bytes()
        output = self.root / 'invalid-seed'
        with self.assertRaisesRegex(ValueError, 'report/page'):
            prepare(output, self.library, self.database)
        self.assertFalse((output / 'manifest.json').exists())
        self.assertFalse((output / 'reference-library' / 'reviews' / PLAN_NAME).exists())
        self.assertEqual((self.library / 'library.json').read_bytes(), before)

    def test_seed_manifest_admits_only_fixed_review_name_and_revalidates_source_binding(self):
        write_plan(self.library, plan_for(self.library, self.data))
        output = self.root / 'seed-bad-review'
        prepare(output, self.library, self.database)
        manifest_path = output / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        record = next(f for f in manifest['files'] if f['path'].endswith('/' + PLAN_NAME))
        record['path'] = 'reference-library/reviews/unreviewed.json'
        identity = {key: value for key, value in manifest.items() if key != 'id'}
        manifest['id'] = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'),
                                                   ensure_ascii=False).encode('utf-8')).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'unexpected file path'):
            verified_manifest(output)
        record['path'] = 'reference-library/reviews/' + PLAN_NAME
        review_path = output / record['path']
        plan = json.loads(review_path.read_text(encoding='utf-8'))
        plan['items'][0]['targets'][1]['page'] = 13
        review_bytes = json.dumps(plan).encode('utf-8')
        review_path.write_bytes(review_bytes)
        record.update(size=len(review_bytes), sha256=hashlib.sha256(review_bytes).hexdigest())
        identity = {key: value for key, value in manifest.items() if key != 'id'}
        manifest['id'] = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'),
                                                   ensure_ascii=False).encode('utf-8')).hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        destination = self.root / 'rejected-install'
        with self.assertRaisesRegex(ValueError, 'could not be read'):
            initialize_data(output, destination)
        self.assertFalse((destination / 'reference-library').exists())
        self.assertFalse((destination / 'estimator.sqlite3').exists())


if __name__ == '__main__':
    unittest.main()
