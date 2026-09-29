"""Overlay reuse retains validation, source identity and reciprocal evidence."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary
from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from estimator.technical_duplicates import review_fingerprint
from test_firestopping_library import editable_library


class FullyValidatedLibrary(FirestoppingLibrary):
    def _validate(self, data, *, validated_source=None):
        super()._validate(data)


class ReferenceOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'library'
        self.data = editable_library(self.directory)
        self.index = self.directory / 'library.json'
        original = self.data['libraries']['technical']['items'][0]
        duplicate = deepcopy(original)
        duplicate.update(id='report-a-v2', title='V2 — Copper service')
        self.data['libraries']['technical']['items'].append(duplicate)
        self.write()
        projected = ReferenceLibrary(self.directory)._load()
        self.data['technical_duplicate_reviews'] = [{'canonical_id': original['id'], 'members': [
            {'id': item['id'], 'sha256': review_fingerprint(item, projected['_records']['technical'][item['id']], projected['_assets'])}
            for item in (original, duplicate)]}]
        self.write()
        self.store = Store(self.root / 'test.sqlite3')
        self.library = FirestoppingLibrary(self.directory, self.store)

    def write(self):
        self.index.write_text(json.dumps(self.data), encoding='utf-8')

    def assert_full_equivalence(self):
        expected = FullyValidatedLibrary(self.directory, self.store)._load()
        self.assertEqual(self.library._load(), expected)

    def test_choices_use_validated_technical_source_without_loading_saved_overlays(self):
        with patch.object(self.library.edits, 'overlay_stamp', side_effect=AssertionError('Unneeded overlay')):
            choices = self.library.service_types()
        expected = ReferenceLibrary(self.directory).listing('technical')['filters']
        self.assertEqual(choices, next([option['value'] for option in field['options']]
                                      for field in expected if field['key'] == 'services'))
        self.assertIsNone(self.library._effective)

    def test_overlay_edits_links_aliases_and_deletions_equal_full_validation(self):
        self.assert_full_equivalence()
        base = self.library._data
        before = deepcopy(base)
        opened = self.library.edit('pkb-001')
        draft = deepcopy(opened['draft'])
        draft['rows'][0]['inputs']['K'] = 'Changed service'
        snapshot = self.library._context('pkb-001')[3]
        self.library.edits.save('pkb-001', 0, self.data['firestopping']['source_sha256'], {
            'draft': draft, 'pricing_token': opened['pricing_token'], 'amount': 150}, snapshot)
        self.library.add_link('pkb-002', {'technical_id': 'report-a-v2'})
        self.assert_full_equivalence()
        self.assertEqual(self.library.detail('penetration', 'pkb-002')['links'][0]['id'], 'report-a-v1')
        self.library.remove_link('pkb-001', {'technical_id': 'report-a-v2'})
        self.assert_full_equivalence()
        self.library.edits.delete('pkb-002', self.data['firestopping']['source_sha256'])
        self.assert_full_equivalence()
        self.assertEqual(base, before)

    def test_public_results_and_prospective_saved_edits_cannot_mutate_cached_evidence(self):
        self.library._load()
        before = deepcopy(self.library._data)
        detail = self.library.detail('technical', 'report-a-v1')
        detail['fields'].clear()
        detail['sources'][0]['filename'] = 'Changed display.pdf'
        detail['consolidated_ids'].clear()
        detail['links'][0]['title'] = 'Changed reciprocal title'
        listing = self.library.listing('technical')
        listing['filters'].clear()
        choices = self.library.service_types()
        choices.clear()
        opened = self.library.edit('pkb-001')
        self.library._validate_save('pkb-001', {'draft': opened['draft'], 'amount': 150})
        self.assertEqual(self.library._data, before)
        self.assertEqual(self.library._load()['_groups'], {'report-a-v1': ['report-a-v1', 'report-a-v2']})

    def test_changed_source_asset_and_reviews_rebuild_or_disable_entire_group(self):
        original = deepcopy(self.data)
        for change in ('source', 'asset', 'review'):
            with self.subTest(change=change):
                self.data = deepcopy(original)
                self.write()
                self.library._load()
                previous = self.library._data
                if change == 'source':
                    self.data['libraries']['technical']['items'][1]['fields'].append({'label': 'FRL', 'value': '-/60/60'})
                elif change == 'asset':
                    self.data['documents'][0]['sha256'] = 'f' * 64
                else:
                    self.data['technical_duplicate_reviews'][0]['members'][0]['sha256'] = 'f' * 64
                self.write()
                current = self.library._load()
                self.assertIsNot(self.library._data, previous)
                self.assertEqual(current['_groups'], {})
                self.assertEqual(len(current['_visible']['technical']), 2)
                self.assert_full_equivalence()

    def test_changed_manual_link_evidence_is_withheld(self):
        self.library.add_link('pkb-002', {'technical_id': 'report-a-v2'})
        self.assertTrue(self.library.detail('penetration', 'pkb-002')['links'])
        self.data['documents'][0]['sha256'] = 'f' * 64
        self.write()
        item = self.library.detail('penetration', 'pkb-002')
        self.assertEqual(item['links'], [])
        self.assertIn('another source version', item['notice'])
        self.assertEqual(len(self.library.edits.links()), 1)

    def test_corrupt_index_cannot_use_cached_projection_or_imported_runtime_markers(self):
        original = deepcopy(self.data)
        for change in ('technical_basis', 'table', 'link'):
            with self.subTest(change=change):
                self.data = deepcopy(original)
                self.write()
                self.library._load()
                item = self.data['libraries']['technical']['items'][0]
                if change == 'technical_basis':
                    item['technical_basis'] = {'source_fields': []}
                elif change == 'table':
                    item['fields'].append({'label': 'Service', 'value': '', 'table': {'columns': ['one'], 'rows': [[]]}})
                else:
                    self.data['links'][0]['technical_id'] = 'missing'
                self.data['_records'] = {'technical': {'forged': {}}}
                self.write()
                with self.assertRaises(ValidationError):
                    self.library._load()
                self.assertEqual(self.library.service_types(), [])

    def test_replaced_overlay_dependency_requires_full_validation(self):
        base = ReferenceLibrary._load(self.library)
        for dependency in ('technical', 'documents', 'images', 'technical_duplicate_reviews', 'trafalgar_selector_import'):
            with self.subTest(dependency=dependency):
                data = self.library._copy_for_overlay(base)
                if dependency == 'technical':
                    data['libraries']['technical'] = deepcopy(data['libraries']['technical'])
                    data['libraries']['technical']['items'][0]['technical_basis'] = {}
                elif dependency == 'documents':
                    data['documents'] = deepcopy(data['documents'])
                    data['documents'][0]['pages'] = 0
                elif dependency == 'images':
                    data['images'] = deepcopy(data['images'])
                    data['images'][0]['extension'] = '.svg'
                elif dependency == 'technical_duplicate_reviews':
                    data[dependency] = [{'invalid': True}]
                else:
                    data[dependency] = {'invalid': True}
                self.assertFalse(self.library._same_technical_source(data, base))
                with self.assertRaises((ValueError, ValidationError, KeyError)):
                    self.library._validate(data, validated_source=base)


if __name__ == '__main__':
    unittest.main()
