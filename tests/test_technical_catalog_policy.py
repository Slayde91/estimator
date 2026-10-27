"""Synthetic catalog decisions preserve evidence and durable reference identity."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.firestopping_library import FirestoppingLibrary
from estimator.reference_library import ReferenceLibrary, ReferenceNotFound
from estimator.storage import Store
from estimator.technical_catalog_policy import (
    FYRESHIELD_REPORT, FYRESHIELD_REPORT_URL, product_family, public_records,
)
from estimator.technical_duplicates import review_fingerprint
from test_firestopping_library import editable_library


FAMILIES = ['FyreSHIELD', 'FyreSHIELD PLUS', 'FyreSHIELD - Screw Fixed', 'FyreSHIELD PLUS - Screw Fixed']


def record(key, product, manufacturer='Trafalgar'):
    return {'id': key, 'title': product, 'fields': [
        {'label': 'Manufacturer', 'value': manufacturer},
        {'label': 'System Products', 'value': product}],
        'filter_values': {'manufacturer': [manufacturer]}}


class CatalogPolicyProjectionTests(unittest.TestCase):
    def test_only_explicit_unambiguous_supplier_and_whole_product_family_match(self):
        for name in FAMILIES:
            item = record('arbitrary-id', name)
            projected = public_records({'arbitrary-id': item}, {}, ['report'])['arbitrary-id']
            self.assertEqual(projected['filter_values']['report'], [FYRESHIELD_REPORT])
        for name, manufacturer in [('FyreSHIELD accessory', 'Trafalgar'), ('Not FyreSHIELD', 'Trafalgar'),
                                   ('FRSS replacement', 'Trafalgar'), ('FyreSHIELD', 'Other')]:
            item = record('trafalgar-selector-5413', name, manufacturer)
            item['title'] = 'Trafalgar FyreSHIELD FRSS'
            item['fields'].append({'label': 'Installation Details', 'value': 'FyreSHIELD and FRSS are mentioned incidentally.'})
            self.assertIs(public_records({item['id']: item}, {}, ['report'])[item['id']], item)
        mixed = record('mixed', 'FyreSHIELD\nOther product')
        self.assertIsNone(product_family(mixed))
        self.assertIs(public_records({'mixed': mixed}, {}, ['report'])['mixed'], mixed)

    def test_assignment_is_idempotent_preserves_other_reports_and_never_mutates_input(self):
        item = record('one', 'FyreSHIELD PLUS')
        other = {'label': 'OTHER R1', 'url': 'https://tfire.com.au/documents/Other-Report'}
        item['fields'].append({'label': 'Report Number', 'value': 'OTHER R1\nfas200221 r3.0',
                               'report_links': [other, {'label': 'fas200221 r3.0', 'url': 'https://tfire.com.au/documents/Old-Report'}]})
        item['filter_values']['document'] = ['OTHER R1']
        original = deepcopy(item)
        first = public_records({'one': item}, {}, ['document'])
        second = public_records(first, {}, ['document'])
        self.assertEqual(first, second)
        self.assertEqual(item, original)
        report = next(field for field in first['one']['fields'] if field['label'] == 'Report Number')
        self.assertEqual(report['value'], 'OTHER R1\n' + FYRESHIELD_REPORT)
        self.assertEqual(report['report_links'], [other, {'label': FYRESHIELD_REPORT, 'url': FYRESHIELD_REPORT_URL}])
        self.assertEqual(first['one']['filter_values']['document'], ['OTHER R1', FYRESHIELD_REPORT])

    def test_retired_families_exclude_aliases_without_mutating_original_records(self):
        records = {'retired': record('retired', 'FRSS-Screw fixed'), 'alias': record('alias', 'FRSS'),
                   'other': record('other', 'Other'), 'other-supplier': record('other-supplier', 'FRSS', 'Other')}
        before = deepcopy(records)
        self.assertEqual(set(public_records(records, {'alias': 'retired'}, ['report'])), {'other', 'other-supplier'})
        self.assertEqual(records, before)


class CatalogPolicyLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'library'
        self.data = editable_library(self.directory)
        original = self.data['libraries']['technical']['items'][0]
        items = []
        for number, name in enumerate(FAMILIES + ['FRSS', 'FRSS-Screw fixed', 'Other product']):
            item = deepcopy(original)
            item.update(id=f'product-{number}', title=f'Synthetic {name}')
            item['fields'] = [{'label': 'Manufacturer', 'value': 'Trafalgar'},
                              {'label': 'System Recommendation', 'value': name},
                              {'label': 'Barrier Construction', 'value': 'Concrete wall'},
                              {'label': 'FRL', 'value': '-/120/30'}]
            item['filter_values'] = {'report': ['RETIRED ONLY'] if number in (4, 5) else []}
            if number in (4, 5):
                item['fields'].append({'label': 'Report Number', 'value': 'RETIRED ONLY'})
            items.append(item)
        self.data['libraries']['technical']['items'] = items
        self.data['links'] = [{'penetration_id': 'pkb-001', 'technical_id': f'product-{number}', 'relationship': 'Synthetic retained association'} for number in (0, 4, 5)]
        self.index = self.directory / 'library.json'
        self.write()
        self.store = Store(Path(self.temp.name) / 'qa.sqlite3')
        self.library = FirestoppingLibrary(self.directory, self.store)

    def write(self):
        self.index.write_text(json.dumps(self.data), encoding='utf-8')

    def test_listing_detail_filters_search_and_reciprocal_links_use_public_policy(self):
        before = self.index.read_bytes()
        listing = self.library.listing('technical')
        self.assertEqual(listing['total'], 5)
        self.assertEqual(self.library.listing('technical', search='FRSS')['total'], 0)
        self.assertEqual(self.library.listing('technical', search=FYRESHIELD_REPORT)['total'], 4)
        self.assertEqual(self.library.listing('technical', report=FYRESHIELD_REPORT)['total'], 4)
        options = next(field['options'] for field in listing['filters'] if field['key'] == 'report')
        self.assertEqual(options, [{'value': FYRESHIELD_REPORT, 'label': FYRESHIELD_REPORT, 'group': 'Trafalgar'}])
        self.assertEqual([link['id'] for link in self.library.detail('penetration', 'pkb-001')['links']], ['product-0'])
        for key in ('product-4', 'product-5'):
            with self.assertRaises(ReferenceNotFound):
                self.library.detail('technical', key)
            with self.assertRaises(ReferenceNotFound):
                self.library.add_link('pkb-002', {'technical_id': key})
        loaded = self.library._load()
        self.assertEqual(len(loaded['_records']['technical']), 7)
        self.assertNotIn('report_links', json.dumps(loaded['_records']['technical']))
        self.assertEqual(loaded['libraries']['technical']['items'], self.data['libraries']['technical']['items'])
        self.assertEqual(self.index.read_bytes(), before)

    def test_review_fingerprints_and_saved_manual_link_identities_remain_source_bound(self):
        # Capture a source-bound review before adding it to the immutable index.
        loaded = ReferenceLibrary(self.directory)._load()
        sources = self.data['libraries']['technical']['items']
        self.data['technical_duplicate_reviews'] = [{'canonical_id': 'product-0', 'members': [
            {'id': item['id'], 'sha256': review_fingerprint(item, loaded['_records']['technical'][item['id']], loaded['_assets'])}
            for item in sources[:2]]}]
        self.write()
        library = FirestoppingLibrary(self.directory, self.store)
        before = self.index.read_bytes()
        first = library._load()
        self.assertEqual(first['_aliases'].get('product-1'), 'product-0')
        expected_identity = library._original_technical_source('product-0', first)
        library.add_link('pkb-002', {'technical_id': 'product-1'})
        self.assertEqual(library.edits.links()[0][3], expected_identity)
        reopened = FirestoppingLibrary(self.directory, self.store)
        self.assertEqual([link['id'] for link in reopened.detail('penetration', 'pkb-002')['links']], ['product-0'])
        self.assertEqual(reopened._load()['_aliases'], first['_aliases'])
        self.assertIn(FYRESHIELD_REPORT, json.dumps(reopened.detail('technical', 'product-1')))
        self.assertEqual(self.index.read_bytes(), before)
        reopened.remove_link('pkb-002', {'technical_id': 'product-1'})
        self.assertEqual(reopened.detail('penetration', 'pkb-002')['links'], [])

    def test_legacy_retired_manual_edge_stays_stored_but_not_public(self):
        loaded = self.library._load()
        self.library.edits.link('pkb-002', 'product-4', self.library._source_hash(loaded),
                                self.library._original_technical_source('product-4', loaded))
        saved = self.library.edits.links()
        reopened = FirestoppingLibrary(self.directory, self.store)
        self.assertEqual(reopened.detail('penetration', 'pkb-002')['links'], [])
        self.assertEqual(reopened.edits.links(), saved)
        with self.assertRaises(ReferenceNotFound):
            reopened.detail('technical', 'product-4')


if __name__ == '__main__':
    unittest.main()
