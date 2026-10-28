"""Synthetic private Services decisions survive library and desktop installs."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.desktop_seed import initialize_data, verified_manifest
from estimator.firefly_reference_review import PLAN_NAME as REFERENCE_PLAN_NAME, REPORTS, fingerprint
from estimator.firefly_technical_review import PLAN_NAME as TECHNICAL_PLAN_NAME
from estimator.reference_library import ReferenceLibrary
from estimator.technical_service_review import PLAN_NAME, REVIEW_KEY, projection_fingerprint
from scripts.install_reference_library import install
from scripts.prepare_desktop_seed import prepare
from tests.test_reference_library import sample_library
from test_firefly_technical_review import fixture as firefly_fixture, write_plan as write_technical_plan


def write_services_plan(directory, raw, public, services):
    plan = {'schema_version': 1, 'review_id': 'synthetic-lifecycle-review',
            'reviewed_index_sha256': hashlib.sha256((directory / 'library.json').read_bytes()).hexdigest(),
            'items': [{'id': raw['id'], 'item_sha256': fingerprint(raw),
                       'projection_sha256': projection_fingerprint(public), 'services': services,
                       'evidence': [{'field': 'Installation Details', 'quote': 'copper pipe',
                                     'source_reference': 'Synthetic retained service evidence'}]}]}
    review = directory / 'reviews' / PLAN_NAME
    review.parent.mkdir(exist_ok=True)
    review.write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
    return review


class ServicesReviewLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'

    def basic_library(self):
        data, _, _ = sample_library(self.source)
        raw = data['libraries']['technical']['items'][0]
        raw['fields'] += [{'label': 'Service', 'value': 'Metal pipe'},
                          {'label': 'Installation Details', 'value': 'The penetrant is a copper pipe.'}]
        (self.source / 'library.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
        baseline = ReferenceLibrary(self.source)._load()
        public = baseline['_technical_public_records'][raw['id']]
        write_services_plan(self.source, raw, public, ['Copper Pipes'])
        return raw['id']

    def all_reviews_library(self):
        pdf = b'%PDF-1.4\nSynthetic review lifecycle fixture only.\n%%EOF'
        reports = {key: (revision, hashlib.sha256(pdf).hexdigest()) for key, (revision, _) in REPORTS.items()}
        review_patch = patch.dict(REPORTS, reports)
        review_patch.start(); self.addCleanup(review_patch.stop)
        data, _, technical = firefly_fixture(self.source)
        # Add exact field evidence before rebuilding the source-bound technical
        # plan, keeping this fixture unrelated to real supplier transcriptions.
        raw = data['libraries']['technical']['items'][1]
        raw['fields'].append({'label': 'Installation Details', 'value': 'The penetrant is a copper pipe.'})
        # The fixture already supplies this exact Installation Details label;
        # use its existing field rather than introduce duplicate source labels.
        details = [field for field in raw['fields'] if field['label'] == 'Installation Details']
        if len(details) > 1:
            raw['fields'].remove(details[-1])
            details[0]['value'] = 'The penetrant is a copper pipe.'
        index = self.source / 'library.json'
        index.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
        baseline = ReferenceLibrary(self.source)._load()
        for row in technical['items']:
            original = next(item for item in data['libraries']['technical']['items'] if item['id'] == row['id'])
            row['item_sha256'] = fingerprint(original)
            # Existing technical fingerprint deliberately binds its own fields
            # and substrate basis, before its sidecar is applied.
            from estimator.firefly_technical_review import projection_fingerprint as technical_fingerprint
            row['projection_sha256'] = technical_fingerprint(baseline['_records']['technical'][row['id']])
        technical['index_sha256'] = hashlib.sha256(index.read_bytes()).hexdigest()
        for report in REPORTS:
            (self.source / 'documents' / (report + '.pdf')).write_bytes(pdf)
        technical_path = write_technical_plan(self.source, technical)
        reference = {key: deepcopy(value) for key, value in technical.items()
                     if key in {'schema_version', 'review_id', 'index_sha256', 'reports'}}
        reference['items'] = []
        (technical_path.parent / REFERENCE_PLAN_NAME).write_text(json.dumps(reference, indent=2) + '\n', encoding='utf-8')
        public = ReferenceLibrary(self.source)._load()['_technical_public_records'][raw['id']]
        write_services_plan(self.source, raw, public, ['Copper Pipes'])
        return raw['id']

    def test_installer_preserves_exact_source_and_review_bytes(self):
        key = self.basic_library()
        source_index = (self.source / 'library.json').read_bytes()
        review = (self.source / 'reviews' / PLAN_NAME).read_bytes()
        destination = self.root / 'installed'
        install(self.source, destination)
        self.assertEqual((destination / 'library.json').read_bytes(), source_index)
        self.assertEqual((destination / 'reviews' / PLAN_NAME).read_bytes(), review)
        installed = ReferenceLibrary(destination)
        self.assertEqual(installed.listing('technical', services='Copper Pipes')['total'], 1)
        self.assertEqual(installed._load()['_technical_discovery'][key]['services'], ['Copper Pipes'])
        self.assertEqual((self.source / 'library.json').read_bytes(), source_index)

    def test_installer_preserves_services_and_both_firefly_review_dependencies(self):
        key = self.all_reviews_library()
        source = ReferenceLibrary(self.source)._load()
        expected_public = deepcopy(source['_technical_public_records'][key])
        paths = ['library.json', *['reviews/' + name for name in (REFERENCE_PLAN_NAME, TECHNICAL_PLAN_NAME, PLAN_NAME)]]
        expected = {name: (self.source / name).read_bytes() for name in paths}
        destination = self.root / 'installed-all-reviews'
        install(self.source, destination)
        self.assertEqual({name: (destination / name).read_bytes() for name in paths}, expected)
        loaded = ReferenceLibrary(destination)._load()
        self.assertIsNotNone(loaded[REVIEW_KEY])
        self.assertEqual(loaded['_technical_public_records'][key], expected_public)
        self.assertEqual(loaded['_technical_discovery'][key]['services'], ['Copper Pipes'])

    def test_replacement_backup_keeps_original_private_review_and_index(self):
        self.basic_library()
        destination = self.root / 'replaceable'
        install(self.source, destination)
        original_index = (destination / 'library.json').read_bytes()
        original_review = (destination / 'reviews' / PLAN_NAME).read_bytes()
        index = self.source / 'library.json'
        data = json.loads(index.read_text(encoding='utf-8'))
        data['notice'] = 'Synthetic unrelated catalog update.'
        index.write_text(json.dumps(data) + '\n', encoding='utf-8')
        receipt = install(self.source, destination, replace=True)
        backup = Path(receipt['backup'])
        self.assertEqual((backup / 'library.json').read_bytes(), original_index)
        self.assertEqual((backup / 'reviews' / PLAN_NAME).read_bytes(), original_review)
        self.assertEqual((destination / 'library.json').read_bytes(), index.read_bytes())
        self.assertEqual(ReferenceLibrary(destination).listing('technical', services='Copper Pipes')['total'], 1)

    def test_factory_seed_and_first_run_preserve_private_services_selection(self):
        self.basic_library()
        expected = (self.source / 'reviews' / PLAN_NAME).read_bytes()
        seed, user = self.root / 'seed', self.root / 'user'
        prepare(seed, self.source)
        name = 'reference-library/reviews/' + PLAN_NAME
        self.assertIn(name, [row['path'] for row in verified_manifest(seed)['files']])
        self.assertEqual((seed / name).read_bytes(), expected)
        self.assertTrue(initialize_data(seed, user)['initialized'])
        self.assertEqual((user / name).read_bytes(), expected)
        self.assertEqual(ReferenceLibrary(user / 'reference-library').listing('technical', services='Copper Pipes')['total'], 1)

    def test_factory_seed_preserves_all_three_reviews_and_public_projection(self):
        key = self.all_reviews_library()
        original_index = (self.source / 'library.json').read_bytes()
        expected = ReferenceLibrary(self.source)._load()['_technical_public_records'][key]
        seed, user = self.root / 'all-seed', self.root / 'all-user'
        prepare(seed, self.source)
        names = [row['path'] for row in verified_manifest(seed)['files']]
        for name in (REFERENCE_PLAN_NAME, TECHNICAL_PLAN_NAME, PLAN_NAME):
            self.assertIn('reference-library/reviews/' + name, names)
        self.assertTrue(initialize_data(seed, user)['initialized'])
        installed = user / 'reference-library'
        self.assertEqual((installed / 'library.json').read_bytes(), original_index)
        loaded = ReferenceLibrary(installed)._load()
        self.assertEqual(loaded['_technical_public_records'][key], expected)
        self.assertEqual(loaded['_technical_discovery'][key]['services'], ['Copper Pipes'])

    def test_services_manifest_path_is_fixed_and_review_binding_is_revalidated(self):
        self.basic_library()
        seed = self.root / 'tampered-seed'
        prepare(seed, self.source)
        manifest_path = seed / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        entry = next(row for row in manifest['files'] if row['path'].endswith('/' + PLAN_NAME))
        entry['path'] = 'reference-library/reviews/unapproved-services.json'
        self.rehash_manifest(manifest, manifest_path)
        with self.assertRaisesRegex(ValueError, 'unexpected file path'): verified_manifest(seed)
        entry['path'] = 'reference-library/reviews/' + PLAN_NAME
        review_path = seed / entry['path']
        plan = json.loads(review_path.read_text(encoding='utf-8'))
        plan['items'][0]['item_sha256'] = 'a' * 64
        payload = json.dumps(plan).encode()
        review_path.write_bytes(payload)
        entry.update(size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        self.rehash_manifest(manifest, manifest_path)
        with self.assertRaises(ValidationError): initialize_data(seed, self.root / 'rejected-user')
        self.assertFalse((self.root / 'rejected-user' / 'reference-library').exists())

    @staticmethod
    def rehash_manifest(manifest, path):
        identity = {key: value for key, value in manifest.items() if key != 'id'}
        manifest['id'] = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        path.write_text(json.dumps(manifest), encoding='utf-8')

    def test_source_index_change_during_asset_copy_preserves_destination(self):
        self.basic_library()
        destination = self.root / 'existing'
        install(self.source, destination)
        expected = (destination / 'library.json').read_bytes()
        original_asset = ReferenceLibrary.asset
        changed = False

        def changing_asset(library, key, pdf=True):
            nonlocal changed
            result = original_asset(library, key, pdf)
            if library.directory == self.source and not changed:
                changed = True
                index = self.source / 'library.json'
                index.write_bytes(index.read_bytes() + b' ')
            return result

        with patch.object(ReferenceLibrary, 'asset', changing_asset), self.assertRaisesRegex(ValueError, 'changed'):
            install(self.source, destination, replace=True)
        self.assertEqual((destination / 'library.json').read_bytes(), expected)
        self.assertFalse(list(self.root.glob('.reference-library-*')))
        self.assertFalse(list(self.root.glob('existing-backup-*')))


if __name__ == '__main__':
    unittest.main()
