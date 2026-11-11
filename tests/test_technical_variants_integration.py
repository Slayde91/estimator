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

    def prepare(self, *, caption=None, table=None):
        source = self.data['libraries']['technical']['items'][0]
        source['fields'] += [
            {'label': 'Service', 'value': 'Copper pipe'},
            {'label': 'FRL', 'value': '-/60/60 to -/90/90'},
            {'label': 'Barrier Construction', 'value': '', 'table': table or {
                'columns': ['Barrier Construction', 'FRL'],
                'rows': [['Concrete wall 100 mm', '-/60/60'], ['AAC wall 150 mm', '-/90/90']]}}]
        if caption is not None:
            source['fields'][-1]['table_captions'] = [caption]
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
        detail = self.library.detail('technical', child)
        self.assertEqual(detail['id'], child)
        self.assertEqual(detail['source_code'], 'V1')
        self.assertIn('AAC wall 150 mm', detail['configuration'])
        self.assertIn('-/90/90', detail['configuration'])
        self.assertIn('Vertical', detail['configuration'])
        self.assertIn(detail['configuration'], detail['title'])
        self.assertNotIn(child, detail['title'])
        result = self.library.listing('technical', search='V1 AAC ' + child)['items']
        self.assertEqual([(item['id'], item['title']) for item in result], [(child, detail['title'])])
        self.assertEqual(next(f['value'] for f in detail['fields'] if f['label'] == 'ID'), 'V1')
        private = after['_technical_public_records'][child]
        self.assertEqual(next(f['value'] for f in private['fields'] if f['label'] == 'ID'), child)
        self.assertEqual(source_fingerprint([private, after['_technical_discovery'][child]]),
                         after['_technical_variant_lineage'][child]['variant_sha256'])
        self.assertEqual(self.library.technical_source_record(key, after), source)
        self.assertEqual(self.library.technical_source_record(child, after)['variant_source']['parent_id'], key)
        self.assertEqual(after['_links']['technical'][child], [])
        self.assertEqual(after['_links']['technical'][key], before['_links']['technical'][key])

    def test_supplier_row_id_takes_precedence_over_aggregate_parent_code(self):
        parent = self.data['libraries']['technical']['items'][0]
        parent['fields'] = [{'label': 'ID', 'value': 'sys_var_100_au (+1 variants listed below)'},
                            {'label': 'Manufacturer', 'value': 'Promat'}]
        _, _, plan = self.prepare(table={'columns': ['Barrier Construction', 'FRL', 'ID'],
            'rows': [['Concrete wall', '-/60/60', 'sys_var_100_au'], ['AAC wall', '-/90/90', 'sys_var_101_au']]})
        self.save_plan(plan)
        child = variant_id(parent['id'], 'row-1')
        result = self.library.detail('technical', child)
        self.assertEqual(result['source_code'], 'sys_var_101_au')
        self.assertIn('Promat: sys_var_101_au', result['title'])
        self.assertNotIn('sys_var_100_au', result['title'])
        self.assertEqual(self.library.listing('technical', search='sys_var_101_au AAC')['items'][0]['id'], child)

    def test_matching_headings_use_distinguishing_reviewed_fixing(self):
        parent = self.data['libraries']['technical']['items'][0]
        parent['fields'] = [{'label': 'ID', 'value': '8495'}, {'label': 'Manufacturer', 'value': 'Trafalgar'}]
        _, _, plan = self.prepare(table={'columns': ['Barrier Construction', 'FRL', 'Fixing'],
            'rows': [['AAC wall', '-/90/90', 'M6 anchor'], ['AAC wall', '-/90/90', '8g screw']]})
        self.save_plan(plan)
        child = variant_id(parent['id'], 'row-1')
        result = self.library.detail('technical', child)
        self.assertIn('Trafalgar: 8495', result['title'])
        self.assertIn('Fixing: 8g screw', result['configuration'])
        self.assertNotIn('M6 anchor', result['configuration'])

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

    def test_only_reviewed_response_and_exports_show_selected_caption_while_identities_stay_exact(self):
        from estimator.technical_item_exports import prepare_technical_item
        caption = ('Complete source substrate alternatives; each rating and limit applies to its own '
                   'source row and installation conditions. The entry selection remains separate.'
                   ' No matching source substrate row has been established for this entry.'
                   ' Source: Example.pdf, page 2. Keep all fixing and aperture conditions.')
        source, before, plan = self.prepare(caption=caption)
        key = source['id']; index_bytes = (self.root / 'library.json').read_bytes()
        unreviewed = self.library.detail('technical', key)
        self.assertEqual(next(field for field in unreviewed['fields'] if field['label'] == 'Barrier Construction')['table_captions'], [caption])
        self.save_plan(plan)
        data = self.library._load(); retained = deepcopy(data['_technical_public_records'])
        identities = deepcopy((data['_technical_variant_lineage'], data['_technical_variant_sources']))
        for identifier in (key, variant_id(key, 'row-1')):
            actual = self.library.detail('technical', identifier)
            field = next(field for field in actual['fields'] if field['label'] == 'Barrier Construction')
            self.assertTrue(field['table_captions'][0].startswith('Selected reviewed substrate configuration;'))
            self.assertNotIn('No matching source substrate row', field['table_captions'][0])
            self.assertIn('Keep all fixing and aperture conditions.', field['table_captions'][0])
            exported = prepare_technical_item({'id': identifier}, library=self.library)
            table = next(table for table in exported['tables'] if table['label'] == 'Barrier Construction')
            self.assertEqual(table['caption'], field['table_captions'][0])
            self.assertEqual(table['rows'], field['table']['rows'])
        self.assertEqual(data['_technical_public_records'], retained)
        self.assertEqual((data['_technical_variant_lineage'], data['_technical_variant_sources']), identities)
        self.assertEqual((self.root / 'library.json').read_bytes(), index_bytes)
        self.assertEqual(next(field for field in retained[key]['fields'] if field['label'] == 'Barrier Construction')['table_captions'], [caption])

    def test_imported_capability_and_manual_runtime_markers_are_rejected(self):
        _, _, plan = self.prepare()
        for key, value in [(REVIEW_KEY, {'payload': '{}', 'sha256': 'a' * 64})]:
            forged = deepcopy(self.data); forged[key] = value; self.write(forged)
            with self.assertRaises(ValidationError):
                ReferenceLibrary(self.root)._load()
        for marker in ('variant_source', 'user_authored', 'source_code', 'configuration'):
            forged = deepcopy(self.data)
            forged['libraries']['technical']['items'][0][marker] = True
            self.write(forged)
            with self.assertRaises(ValidationError):
                ReferenceLibrary(self.root)._load()

    def test_saved_variant_link_and_unmodified_editor_caption_survive_edit_and_reopen(self):
        from estimator.penetration_references import resolve_schedule_references
        from estimator.register_references import system_text
        from estimator.storage import Store
        from estimator.technical_library_edits import ManualTechnicalLibrary
        from estimator.library_classifications import FACETS
        from estimator.catalog import configuration_catalog, validate_configuration
        from estimator.penetration_calculator import source_model

        parent = self.data['libraries']['technical']['items'][0]
        self.data['firestopping'] = {'source_sha256': 'a' * 64,
            'calculator_source_sha256': source_model()['source']['sha256'],
            'configuration': validate_configuration({'catalog': configuration_catalog({})})}
        self.data['libraries']['technical']['filters'] = [{'key': key, 'label': label} for key, label in FACETS]
        parent['fields'] = [{'label': 'ID', 'value': 'V285'}, {'label': 'Manufacturer', 'value': 'Sample supplier'},
                            {'label': 'Report Number', 'value': 'Sample report'}]
        parent['filter_values'].update(manufacturer=['Sample supplier'], type=['Core hole'], orientation=['Vertical'],
                                       category=['Plumbing & Hydraulic'], services=['Copper Pipes'])
        source, _, plan = self.prepare()
        self.save_plan(plan)
        key = variant_id(source['id'], 'row-1')
        store = Store(self.root.parent / 'editor.sqlite3')
        library = ManualTechnicalLibrary(self.root, store)
        library.add_link('pkb-002', {'technical_id': key})
        stored_title = library._load()['_technical_public_records'][key]['title']
        edit = library.technical_edit(key)
        record = edit['record']
        self.assertIn('V285', record['title'])
        self.assertNotIn(key, record['title'])
        facets = {entry['key']: record['filter_values'][entry['key']] for entry in edit['filters']}
        body = {'revision': edit['revision'], 'source_sha256': edit['source_sha256'], 'request_key': None,
                'title': record['title'], 'facets': facets, 'report': {'number': 'Sample report', 'url': ''},
                'fields': [{'label': f['label'], 'value': f['value']} for f in record['fields']]}
        body['fields'].append({'label': 'Site note', 'value': 'Retain the selected fixing detail.'})
        library.technical_save(key, body)
        reopened = ManualTechnicalLibrary(self.root, store)
        self.assertEqual(reopened.technical_edits.read()[0][key]['record']['title'], stored_title)
        self.assertEqual(reopened.technical_edit(key)['source_sha256'], edit['source_sha256'])
        detail = reopened.detail('technical', key)
        self.assertEqual(detail['title'], record['title'])
        matches = reopened.listing('technical', search='V285 AAC ' + key)['items']
        self.assertEqual([match['id'] for match in matches], [key])
        self.assertEqual(next(f['value'] for f in detail['fields'] if f['label'] == 'ID'), 'V285')
        draft = {'rows': [{'id': 'row-1', 'inputs': {}, 'technical_reference_ids': [key]}]}
        references = resolve_schedule_references(draft, reopened)['row_references']['row-1']['systems']
        self.assertEqual(references, [{'id': key, 'number': 1, 'title': detail['title']}])
        register = reopened.register_references({'row-1': [{'library_ids': ['pkb-002'], 'criteria': {}}]})
        row = register['row_references']['row-1']
        self.assertEqual([system['id'] for system in row['systems']], [key])
        self.assertIn('V285', system_text(row))
        self.assertNotIn(key, system_text(row))

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
