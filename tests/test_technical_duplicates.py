"""Synthetic reviewed duplicates, historical references and fail-open discovery."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary, LibraryConflict
from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from estimator.technical_duplicates import review_fingerprint
from test_firestopping_library import editable_library


class TechnicalDuplicateTests(unittest.TestCase):
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
        loaded = ReferenceLibrary(self.directory)._load()
        self.data['technical_duplicate_reviews'] = [{'canonical_id': original['id'], 'members': [
            {'id': item['id'], 'sha256': review_fingerprint(item, loaded['_records']['technical'][item['id']], loaded['_assets'])}
            for item in (original, duplicate)]}]
        self.write()
        self.store = Store(self.root / 'test.sqlite3')
        self.library = FirestoppingLibrary(self.directory, self.store)

    def write(self):
        self.index.write_text(json.dumps(self.data), encoding='utf-8')

    def test_discovery_counts_search_and_historical_details(self):
        before = self.index.read_bytes()
        listing = self.library.listing('technical')
        self.assertEqual(listing['total'], 1)
        self.assertEqual(listing['counts'], {'total': 1, 'linked': 1, 'unlinked': 0})
        self.assertEqual(self.library.overview()['libraries'][1]['count'], 1)
        self.assertEqual(self.library.listing('technical', search='report-a-v2')['items'][0]['id'], 'report-a-v1')
        self.assertEqual(self.library.listing('technical', offset='1')['items'], [])
        for key in ('report-a-v1', 'report-a-v2'):
            detail = self.library.detail('technical', key)
            self.assertEqual(detail['id'], key)
            self.assertEqual(detail['canonical_id'], 'report-a-v1')
            self.assertEqual(detail['consolidated_ids'], ['report-a-v1', 'report-a-v2'])
            self.assertEqual(detail['links'][0]['id'], 'pkb-001')
        self.assertEqual(self.index.read_bytes(), before)

    def test_changed_source_display_or_asset_disables_whole_review(self):
        for change in ('source', 'asset', 'missing'):
            with self.subTest(change=change):
                data = deepcopy(self.data)
                if change == 'source':
                    data['libraries']['technical']['items'][1]['fields'].append({'label': 'FRL', 'value': '-/60/60'})
                elif change == 'asset':
                    data['documents'][0]['sha256'] = 'f' * 64
                else:
                    data['libraries']['technical']['items'].pop()
                self.index.write_text(json.dumps(data), encoding='utf-8')
                result = ReferenceLibrary(self.directory)._load()
                self.assertEqual(result['_groups'], {})
                self.assertEqual(len(result['_visible']['technical']), 1 if change == 'missing' else 2)

    def test_overlapping_or_malformed_review_is_rejected(self):
        self.data['technical_duplicate_reviews'].append(deepcopy(self.data['technical_duplicate_reviews'][0]))
        self.write()
        with self.assertRaises(ValidationError):
            self.library.overview()

    def test_unreviewed_similar_items_remain_separate(self):
        self.data.pop('technical_duplicate_reviews')
        self.write()
        self.assertEqual(self.library.listing('technical')['total'], 2)

    def test_historical_manual_and_imported_links_remain_reciprocal(self):
        data = self.library._load()
        source = self.library._technical_source(data['_records']['technical']['report-a-v2'], data)
        self.library.edits.link('pkb-002', 'report-a-v2', self.library._source_hash(data), source)
        reopened = FirestoppingLibrary(self.directory, self.store)
        detail = reopened.detail('technical', 'report-a-v1')
        self.assertEqual({entry['id'] for entry in detail['links']}, {'pkb-001', 'pkb-002'})
        self.assertEqual(reopened.detail('penetration', 'pkb-002')['links'][0]['id'], 'report-a-v1')
        self.assertEqual(reopened.add_link('pkb-002', {'technical_id': 'report-a-v1'})['created'], False)
        self.assertEqual(len(reopened.edits.links()), 1)
        reopened.remove_link('pkb-002', {'technical_id': 'report-a-v1'})
        self.assertEqual(reopened.detail('penetration', 'pkb-002')['links'], [])
        self.assertTrue(reopened.add_link('pkb-002', {'technical_id': 'report-a-v2'})['created'])
        self.assertEqual(len(reopened.detail('penetration', 'pkb-002')['links']), 1)

    def test_multiline_relationship_text_is_retained_exactly_once(self):
        relationship = 'First source condition\nSecond source condition'
        self.data['links'][0]['relationship'] = relationship
        self.data['links'].append({**self.data['links'][0], 'technical_id': 'report-a-v2'})
        self.write()
        for kind, key in [('penetration', 'pkb-001'), ('technical', 'report-a-v1')]:
            self.assertEqual(self.library.detail(kind, key)['links'][0]['relationship'], relationship)

    def test_multiple_alias_edges_display_once_and_unlink_atomically(self):
        self.data['links'].append({**self.data['links'][0], 'technical_id': 'report-a-v2', 'relationship': 'Second source reference'})
        self.write()
        self.assertEqual(len(self.library.detail('penetration', 'pkb-001')['links']), 1)
        self.assertEqual(len(self.library.detail('technical', 'report-a-v1')['links']), 1)
        self.assertIn('Second source reference', self.library.detail('technical', 'report-a-v1')['links'][0]['relationship'])
        self.library.remove_link('pkb-001', {'technical_id': 'report-a-v2'})
        self.assertEqual(self.library.detail('technical', 'report-a-v1')['links'], [])
        self.assertEqual(FirestoppingLibrary(self.directory, self.store).detail('penetration', 'pkb-001')['links'], [])

    def test_conflicting_alias_unlink_rolls_back_every_edge(self):
        data = self.library._load()
        self.library.edits.link('pkb-002', 'report-a-v2', 'wrong-source', 'wrong-source')
        before = self.library.edits.links()
        with self.assertRaises(LibraryConflict):
            self.library.remove_link('pkb-002', {'technical_id': 'report-a-v1'})
        self.assertEqual(self.library.edits.links(), before)
        self.assertEqual(self.library.edits.unlinks(), [])

    def test_batch_link_aliases_creates_one_edge_and_echoes_requested_ids(self):
        rights = ['report-a-v2', 'report-a-v1']
        receipt = self.library.add_link('pkb-002', {'technical_ids': rights})
        self.assertEqual(receipt['technical_ids'], rights)
        self.assertEqual(receipt['created_ids'], ['report-a-v2'])
        self.assertEqual(len(self.library.edits.links()), 1)
        self.assertEqual(self.library.edits.links()[0][1], 'report-a-v1')

    def test_renamed_display_sources_do_not_change_durable_link_identity(self):
        def rename(item, *args):
            for source in item.get('sources', []):
                source['filename'] = 'Reviewed drawing name.pdf'
                source['label'] = 'Reviewed drawing label'

        with patch('estimator.reference_library.apply_drawing_names', side_effect=rename):
            self.data.pop('technical_duplicate_reviews')
            self.write()
            projected = ReferenceLibrary(self.directory)._load()
            originals = self.data['libraries']['technical']['items']
            self.data['technical_duplicate_reviews'] = [{'canonical_id': 'report-a-v1', 'members': [
                {'id': item['id'], 'sha256': review_fingerprint(item, projected['_records']['technical'][item['id']], projected['_assets'])}
                for item in originals]}]
            self.write()
            self.library.add_link('pkb-002', {'technical_id': 'report-a-v2'})
            reopened = FirestoppingLibrary(self.directory, self.store)
            self.assertEqual(reopened.detail('penetration', 'pkb-002')['links'][0]['id'], 'report-a-v1')
            self.assertEqual(reopened.edits.links()[0][3], reopened._technical_source(originals[0], self.data))
            reopened.remove_link('pkb-001', {'technical_id': 'report-a-v2'})
            reopened.remove_link('pkb-002', {'technical_id': 'report-a-v1'})
            final = FirestoppingLibrary(self.directory, self.store)
            self.assertEqual(final.detail('technical', 'report-a-v1')['links'], [])
