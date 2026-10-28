"""Variant views integrate without changing sources, old links or calculators."""
from copy import deepcopy
import hashlib
import json
import unittest

from estimator.catalog import ValidationError
from estimator.desktop_seed import initialize_data, verified_manifest
from estimator.reference_library import ReferenceLibrary
from estimator.technical_variants import (PLAN_NAME, REVIEW_KEY, assets_fingerprint,
    discovery_fingerprint, projection_fingerprint, source_fingerprint, variant_id)
from tests import test_reference_library as fixtures
from scripts.install_reference_library import install
from scripts.prepare_desktop_seed import prepare as prepare_seed


class TechnicalVariantIntegrationTests(unittest.TestCase):
    setUp = fixtures.ReferenceLibraryTests.setUp
    write = fixtures.ReferenceLibraryTests.write

    def prepare(self):
        source = self.data['libraries']['technical']['items'][0]
        source['fields'] += [
            {'label': 'Service', 'value': 'Copper pipe'},
            {'label': 'FRL', 'value': '-/60/60 to -/90/90'},
            {'label': 'Barrier Construction', 'value': '', 'table': {
                'columns': ['Barrier Construction', 'FRL'],
                'rows': [['Concrete wall 100 mm', '-/60/60'], ['AAC wall 150 mm', '-/90/90']]}}]
        self.write(self.data)
        before = self.library._load(); key = source['id']
        public = before['_technical_public_records'][key]; discovery = before['_technical_discovery'][key]
        table = next(field['table'] for field in public['fields'] if field['label'] == 'Barrier Construction')
        family = {'source_id': key, 'item_sha256': source_fingerprint(source),
            'projection_sha256': projection_fingerprint(public), 'discovery_sha256': discovery_fingerprint(discovery),
            'assets_sha256': assets_fingerprint(source, before['_assets']),
            'tables': [{'field': 'Barrier Construction', 'table_index': 0, 'sha256': source_fingerprint(table)}],
            'reviewed_tables': [], 'variants': []}
        for index, row in enumerate(table['rows']):
            family['variants'].append({'key': 'row-' + str(index), 'existing_id': key if index == 0 else None,
                'selections': [{'field': 'Barrier Construction', 'table_index': 0, 'row_index': index, 'columns': None}],
                'fields': {'Barrier Construction': row[0], 'FRL': row[1]},
                'facets': {'substrate': ['Concrete/masonry wall' if index == 0 else 'Hebel wall'],
                           'orientation': ['Vertical'], 'frl': [row[1]],
                           'services': deepcopy(discovery['services']), 'category': deepcopy(discovery['category'])}})
        plan = {'schema_version': 1, 'review_id': 'synthetic-integration-variants',
                'reviewed_index_sha256': hashlib.sha256((self.root / 'library.json').read_bytes()).hexdigest(),
                'families': [family], 'aliases': []}
        return source, before, plan

    def save_plan(self, plan):
        directory = self.root / 'reviews'; directory.mkdir(exist_ok=True)
        (directory / PLAN_NAME).write_text(json.dumps(plan), encoding='utf-8')

    def test_rows_are_searchable_individual_records_and_old_raw_identity_is_unchanged(self):
        source, before, plan = self.prepare(); key = source['id']
        payload = (self.root / 'library.json').read_bytes()
        original = deepcopy(before['_records']['technical'][key])
        self.save_plan(plan)
        after = self.library._load(); child = variant_id(key, 'row-1')
        self.assertEqual((self.root / 'library.json').read_bytes(), payload)
        self.assertEqual(after['_records']['technical'][key], original)
        self.assertEqual({row['id'] for row in after['libraries']['technical']['items']}, {key})
        self.assertEqual(set(after['_visible']['technical']), {key, child})
        self.assertEqual([row['id'] for row in self.library.listing('technical', search='AAC')['items']], [child])
        self.assertEqual([row['id'] for row in self.library.listing('technical', frl='-/60/60')['items']], [key])
        self.assertEqual(self.library.detail('technical', child)['id'], child)
        self.assertEqual(self.library.technical_source_record(key, after), source)
        self.assertEqual(self.library.technical_source_record(child, after)['variant_source']['parent_id'], key)
        self.assertEqual(after['_links']['technical'][child], [])
        self.assertEqual(after['_links']['technical'][key], before['_links']['technical'][key])

    def test_changed_plan_invalidates_cached_views_and_old_fingerprints_fail_closed(self):
        _, _, plan = self.prepare(); self.save_plan(plan)
        first = self.library._load()
        changed = deepcopy(plan); changed['review_id'] = 'synthetic-later-review'
        self.save_plan(changed)
        second = self.library._load()
        self.assertIsNot(first, second)
        self.assertEqual(first['_visible'], second['_visible'])
        changed['families'][0]['projection_sha256'] = 'f' * 64
        self.save_plan(changed)
        with self.assertRaises(ValidationError):
            self.library.listing('technical')

    def test_imported_capability_and_manual_runtime_markers_are_rejected(self):
        _, _, plan = self.prepare()
        for key, value in [(REVIEW_KEY, {'payload': '{}', 'sha256': 'a' * 64})]:
            forged = deepcopy(self.data); forged[key] = value; self.write(forged)
            with self.assertRaises(ValidationError):
                ReferenceLibrary(self.root)._load()
        for marker in ('variant_source', 'user_authored'):
            forged = deepcopy(self.data)
            forged['libraries']['technical']['items'][0][marker] = True
            self.write(forged)
            with self.assertRaises(ValidationError):
                ReferenceLibrary(self.root)._load()

    def test_install_and_first_run_seed_carry_exact_source_and_variant_review_bytes(self):
        source, _, plan = self.prepare(); self.save_plan(plan)
        index_bytes = (self.root / 'library.json').read_bytes()
        review_bytes = (self.root / 'reviews' / PLAN_NAME).read_bytes()
        destination = self.root.parent / (self.root.name + '-installed-variants')
        seed = self.root.parent / (self.root.name + '-variant-seed')
        user = self.root.parent / (self.root.name + '-variant-user')
        install(self.root, destination)
        self.assertEqual((destination / 'library.json').read_bytes(), index_bytes)
        self.assertEqual((destination / 'reviews' / PLAN_NAME).read_bytes(), review_bytes)
        self.assertEqual(ReferenceLibrary(destination).listing('technical')['total'], 2)
        prepare_seed(seed, self.root)
        path = 'reference-library/reviews/' + PLAN_NAME
        self.assertIn(path, {row['path'] for row in verified_manifest(seed)['files']})
        self.assertTrue(initialize_data(seed, user)['initialized'])
        installed = user / 'reference-library'
        self.assertEqual((installed / 'reviews' / PLAN_NAME).read_bytes(), review_bytes)
        self.assertEqual((installed / 'library.json').read_bytes(), index_bytes)
        library = ReferenceLibrary(installed)
        child = variant_id(source['id'], 'row-1')
        self.assertEqual(library.listing('technical')['total'], 2)
        self.assertEqual(library.detail('technical', child)['id'], child)
        self.assertEqual((self.root / 'library.json').read_bytes(), index_bytes)


if __name__ == '__main__':
    unittest.main()
