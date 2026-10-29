"""Synthetic source-bound row projection, evidence and alias integrity."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.technical_variants import (
    PLAN_NAME, MAX_PLAN_BYTES, assets_fingerprint, discovery_fingerprint,
    load_review, plan_stamp, project, projection_fingerprint, registered_assets,
    source_fingerprint, technical_signature, validate_plan, variant_id,
    present_reviewed_table_captions,
)


def example():
    raw = {'id': 'source-a', 'title': 'Copper system', 'sources': [{'document_id': 'report', 'page': 1}],
           'images': [{'id': 'diagram', 'caption': 'Reviewed diagram'}],
           'fields': [{'label': 'ID', 'value': 'A'}, {'label': 'Manufacturer', 'value': 'Example'},
                      {'label': 'Report Number', 'value': 'R1'}, {'label': 'Service', 'value': 'Copper pipe'},
                      {'label': 'Installation Details', 'value': 'Keep exact instructions.'},
                      {'label': 'FRL', 'value': '-/60/60 to -/90/90'},
                      {'label': 'Barrier Construction', 'value': '', 'table': {
                          'columns': ['Barrier Construction', 'FRL'],
                          'rows': [['Concrete wall 100 mm', '-/60/60'], ['AAC wall 150 mm', '-/90/90']]}}]}
    facets = {'manufacturer': ['Example'], 'report': ['R1'], 'type': ['Core hole'],
              'orientation': ['Vertical'], 'substrate': ['Concrete/masonry wall', 'Hebel wall'],
              'category': ['Plumbing & Hydraulic'], 'services': ['Copper Pipes'],
              'frl': ['-/60/60', '-/90/90']}
    record = {**deepcopy(raw), 'filter_values': deepcopy(facets)}
    data = {'libraries': {'technical': {'items': [raw]}},
            'documents': [{'id': 'report', 'filename': 'report.pdf', 'sha256': 'a' * 64, 'pages': 3}],
            'images': [{'id': 'diagram', 'filename': 'diagram.jpg', 'extension': '.jpg', 'sha256': 'b' * 64}]}
    assets = registered_assets(data)
    family = {'source_id': raw['id'], 'item_sha256': source_fingerprint(raw),
              'projection_sha256': projection_fingerprint(record), 'discovery_sha256': discovery_fingerprint(facets),
              'assets_sha256': assets_fingerprint(raw, assets),
              'tables': [{'field': 'Barrier Construction', 'table_index': 0,
                          'sha256': source_fingerprint(raw['fields'][-1]['table'])}],
              'reviewed_tables': [], 'variants': []}
    for index, (construction, frl) in enumerate(raw['fields'][-1]['table']['rows']):
        family['variants'].append({'key': 'configuration-' + str(index),
            'existing_id': raw['id'] if index == 0 else None,
            'selections': [{'field': 'Barrier Construction', 'table_index': 0, 'row_index': index, 'columns': None}],
            'fields': {'FRL': frl, 'Barrier Construction': construction},
            'facets': {'frl': [frl], 'substrate': ['Concrete/masonry wall' if index == 0 else 'Hebel wall'],
                       'orientation': ['Vertical'], 'category': ['Plumbing & Hydraulic'], 'services': ['Copper Pipes']}})
    plan = {'schema_version': 1, 'review_id': 'synthetic-variants', 'reviewed_index_sha256': 'c' * 64,
            'families': [family], 'aliases': []}
    return raw, record, facets, data, assets, plan


class TechnicalVariantTests(unittest.TestCase):
    def setUp(self):
        self.raw, self.record, self.facets, self.data, self.assets, self.plan = example()

    def project(self, plan=None):
        plan = self.plan if plan is None else plan
        capability = validate_plan(self.data, 'd' * 64, plan)
        return project({'source-a': self.record}, {'source-a': self.facets}, capability,
                       source_records={'source-a': self.raw}, assets=self.assets)

    def test_scopes_exact_rows_retains_original_id_and_all_other_details(self):
        original = deepcopy((self.raw, self.record, self.facets, self.data, self.assets, self.plan))
        result = self.project()
        child = variant_id('source-a', 'configuration-1')
        self.assertEqual(set(result.records), {'source-a', child})
        for key, expected in [('source-a', 0), (child, 1)]:
            item = result.records[key]
            barrier = next(field for field in item['fields'] if field['label'] == 'Barrier Construction')
            self.assertEqual(barrier['table']['rows'], [self.raw['fields'][-1]['table']['rows'][expected]])
            self.assertEqual(item['images'], self.raw['images'])
            self.assertEqual(item['sources'], self.raw['sources'])
            self.assertEqual(next(field['value'] for field in item['fields'] if field['label'] == 'Installation Details'), 'Keep exact instructions.')
            self.assertEqual(result.discovery[key]['frl'], ['-/60/60' if expected == 0 else '-/90/90'])
        self.assertEqual(result.sources[child]['variant_source']['parent_id'], 'source-a')
        self.assertNotIn('source-a', result.sources)
        self.assertEqual((self.raw, self.record, self.facets, self.data, self.assets, self.plan), original)

    def test_stable_child_identity_does_not_depend_on_review_or_variant_order(self):
        expected = set(self.project().records)
        self.plan['review_id'] = 'a-later-reviewed-manifest'
        self.plan['families'][0]['variants'].reverse()
        self.assertEqual(set(self.project().records), expected)
        self.assertNotEqual(variant_id('source-a', 'configuration-1'), variant_id('source-b', 'configuration-1'))

    def test_source_asset_public_and_discovery_drift_all_fail_closed(self):
        for kind in ('source', 'asset', 'public', 'discovery'):
            self.setUp()
            if kind == 'source':
                self.raw['fields'][0]['value'] = 'changed'
            elif kind == 'asset':
                self.data['images'][0]['sha256'] = 'e' * 64
            elif kind == 'public':
                self.record['fields'][0]['value'] = 'changed'
            else:
                self.facets['services'] = ['Steel Pipes']
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.project()

    def test_invalid_later_variant_cannot_partially_modify_any_record(self):
        before = deepcopy((self.record, self.facets))
        self.plan['families'][0]['variants'][1]['facets']['frl'] = ['-/180/180']
        self.plan['families'][0]['variants'][1]['fields']['FRL'] = '-/180/180'
        with self.assertRaisesRegex(ValueError, 'absent from the selected'):
            self.project()
        self.assertEqual((self.record, self.facets), before)

    def test_alias_signature_keeps_differing_substrate_frl_category_services_and_images_separate(self):
        signature = technical_signature(self.record, self.facets, self.assets)
        for facet, value in [('substrate', ['Hebel wall']), ('frl', ['-/60/60']),
                             ('category', ['Mechanical']), ('services', ['Steel Pipes']),
                             ('manufacturer', ['Other']), ('type', ['Oversized core hole']),
                             ('orientation', ['Horizontal']), ('report', ['R2']),
                             ('unknown_scope', ['Different'])]:
            changed = {**self.facets, facet: value}
            self.assertNotEqual(signature, technical_signature(self.record, changed, self.assets), facet)
        changed_assets = deepcopy(self.assets); changed_assets['diagram']['sha256'] = 'e' * 64
        self.assertNotEqual(signature, technical_signature(self.record, self.facets, changed_assets))
        changed = deepcopy(self.record); changed['id'] = 'different'; changed['sources'][0]['page'] = 2
        changed['fields'][0]['value'] = 'different-ID'
        self.assertEqual(signature, technical_signature(changed, self.facets, self.assets))

    def test_hidden_selector_group_is_provenance_but_engineering_cells_still_differ(self):
        signature = technical_signature(self.record, self.facets, self.assets)
        for group in ('Service Penetrations', 'Fire Collars'):
            self.assertEqual(signature, technical_signature(
                self.record, {**self.facets, 'trafalgar_category': [group]}, self.assets))
        changed = deepcopy(self.record)
        changed['fields'][-1]['table']['rows'][0][0] = 'Concrete wall 150 mm'
        self.assertNotEqual(signature, technical_signature(changed, self.facets, self.assets))

    def test_provenance_only_alias_remains_explicit_and_source_bound(self):
        self.facets['trafalgar_category'] = ['Service Penetrations']
        self.plan['families'][0]['discovery_sha256'] = discovery_fingerprint(self.facets)
        other_raw = {**deepcopy(self.raw), 'id': 'source-b'}
        other_record = {**deepcopy(self.record), 'id': 'source-b'}
        other_facets = {**deepcopy(self.facets), 'trafalgar_category': ['Fire Collars']}
        other_family = deepcopy(self.plan['families'][0])
        other_family.update(source_id='source-b', item_sha256=source_fingerprint(other_raw),
                            projection_sha256=projection_fingerprint(other_record),
                            discovery_sha256=discovery_fingerprint(other_facets))
        other_family['variants'][0]['existing_id'] = 'source-b'
        self.plan['families'].append(other_family)
        self.data['libraries']['technical']['items'].append(other_raw)
        records = {'source-a': self.record, 'source-b': other_record}
        facets = {'source-a': self.facets, 'source-b': other_facets}
        originals = {'source-a': self.raw, 'source-b': other_raw}
        def apply():
            return project(records, facets, validate_plan(self.data, 'd' * 64, self.plan),
                           source_records=originals, assets=self.assets)
        self.assertEqual(apply().aliases, {})
        self.plan['aliases'] = [{'alias_id': 'source-b', 'canonical_id': 'source-a'}]
        self.assertEqual(apply().aliases, {'source-b': 'source-a'})
        other_facets['trafalgar_category'] = ['Changed since review']
        with self.assertRaisesRegex(ValueError, 'projection or discovery'):
            apply()
        other_facets['trafalgar_category'] = ['Fire Collars']
        other_raw['filter_values'] = {'trafalgar_category': ['Changed source grouping']}
        with self.assertRaisesRegex(ValueError, 'Variant source'):
            apply()

    def test_explicit_identical_aliases_resolve_to_retained_original(self):
        family = self.plan['families'][0]
        duplicate = deepcopy(family['variants'][0]); duplicate.update(key='same-row-again', existing_id=None)
        family['variants'].append(duplicate)
        child = variant_id('source-a', 'same-row-again')
        self.plan['aliases'] = [{'alias_id': child, 'canonical_id': 'source-a'}]
        result = self.project()
        self.assertEqual(result.aliases, {child: 'source-a'})
        self.assertEqual(result.table_scopes[child], result.table_scopes['source-a'])
        self.plan['aliases'][0]['alias_id'] = variant_id('source-a', 'configuration-1')
        with self.assertRaisesRegex(ValueError, 'different technical facts'):
            self.project()

    def test_same_report_caption_cannot_merge_different_urls_or_document_bytes(self):
        record = deepcopy(self.record)
        report = next(field for field in record['fields'] if field['label'] == 'Report Number')
        report['report_links'] = [{'label': 'R1', 'url': 'https://example.com/revision-one.pdf'}]
        signature = technical_signature(record, self.facets, self.assets)
        changed = deepcopy(record)
        next(field for field in changed['fields'] if field['label'] == 'Report Number')['report_links'][0]['url'] = 'https://example.com/revision-two.pdf'
        self.assertNotEqual(signature, technical_signature(changed, self.facets, self.assets))
        changed_assets = deepcopy(self.assets); changed_assets['report']['sha256'] = 'e' * 64
        self.assertNotEqual(signature, technical_signature(record, self.facets, changed_assets))
        changed['sources'][0]['page'] = 3
        self.assertEqual(technical_signature(changed, self.facets, self.assets),
                         technical_signature({**changed, 'sources': [{'document_id': 'report', 'page': 1}]}, self.facets, self.assets))

    def test_rating_columns_require_an_explicit_single_choice(self):
        table = self.record['fields'][-1]['table']
        table['columns'].append('FRL without protection')
        for row in table['rows']:
            row.append('-/30/30')
        self.plan['families'][0]['projection_sha256'] = projection_fingerprint(self.record)
        self.plan['families'][0]['tables'][0]['sha256'] = source_fingerprint(table)
        with self.assertRaisesRegex(ValueError, 'one row and one FRL'):
            self.project()
        for variant in self.plan['families'][0]['variants']:
            variant['selections'][0]['columns'] = [0, 1]
        result = self.project()
        self.assertEqual(result.records['source-a']['fields'][-1]['table']['columns'], ['Barrier Construction', 'FRL'])

    def test_reviewed_appended_source_table_binds_registered_asset_and_page(self):
        self.record['fields'][-1].pop('table')
        family = self.plan['families'][0]
        family['projection_sha256'] = projection_fingerprint(self.record)
        family['tables'][0]['sha256'] = source_fingerprint(None)
        family['reviewed_tables'] = [{'field': 'Barrier Construction', 'table_index': 0,
            'source_table_sha256': source_fingerprint(None), 'table': deepcopy(self.raw['fields'][-1]['table']),
            'row_ids': ['source-row-a', 'source-row-b'], 'evidence': [
                {'asset_id': 'report', 'sha256': 'a' * 64, 'page': 2,
                 'quote': 'Synthetic source construction rows', 'source_reference': 'Synthetic report page 2'}]}]
        result = self.project()
        self.assertEqual(result.records['source-a']['fields'][-1]['table_row_ids'], [['source-row-a']])
        family['reviewed_tables'][0]['evidence'][0]['page'] = 4
        with self.assertRaisesRegex(ValueError, 'asset evidence'):
            self.project()

    def test_cumulative_ancillary_rows_and_deleted_alternative_remap_navigation(self):
        field = self.record['fields'][-1]
        field['tables'] = [{'columns': ['Fixing', 'Spacing'], 'rows': [['Wall', '100 mm'], ['Batt', '200 mm']]},
                           {'columns': ['Other construction'], 'rows': [['Not this variant'], ['Other']]}]
        field['table_captions'] = ['Construction', 'Cumulative fixings', 'Other arrangement']
        self.record['fields'][5]['table_links'] = [{'field': 'Barrier Construction', 'table_index': 1}, {'field': 'Barrier Construction', 'table_index': 2}]
        family = self.plan['families'][0]; family['projection_sha256'] = projection_fingerprint(self.record)
        for index, table in enumerate(field['tables'], 1):
            family['tables'].append({'field': 'Barrier Construction', 'table_index': index, 'sha256': source_fingerprint(table)})
        for variant in family['variants']:
            variant['selections'] += [{'field': 'Barrier Construction', 'table_index': 1, 'row_indices': [0, 1], 'columns': None},
                                      {'field': 'Barrier Construction', 'table_index': 2, 'row_indices': [], 'columns': None}]
        result = self.project().records['source-a']
        self.assertEqual(len(result['fields'][-1]['tables']), 1)
        self.assertEqual(len(result['fields'][-1]['tables'][0]['rows']), 2)
        self.assertEqual(result['fields'][-1]['table_captions'], ['Construction', 'Cumulative fixings'])
        self.assertEqual(result['fields'][5]['table_links'], [{'field': 'Barrier Construction', 'table_index': 1}])

    def test_caption_presentation_requires_a_selected_single_row_and_retains_conditions(self):
        caption = ('Complete source substrate alternatives; each rating and limit applies to its own '
                   'source row and installation conditions. The entry selection remains separate.'
                   ' No matching source substrate row has been established for this entry.'
                   ' Source: Example.pdf, page 2. Keep the 50 mm fillet and adjacent-wall condition.')
        self.record['fields'][-1]['table_captions'] = [caption, caption]
        self.record['fields'][-1]['tables'] = [{'columns': ['Fixing'], 'rows': [['Retain this unselected ancillary row']]}]
        self.record['fields'].append({'label': 'Source Issues', 'value': 'Unresolved material warning remains literal.'})
        family = self.plan['families'][0]
        family['projection_sha256'] = projection_fingerprint(self.record)
        projected = self.project()
        source = projected.records['source-a']
        before = deepcopy(source)
        shown = present_reviewed_table_captions(source, projected.table_scopes['source-a'])
        selected = next(field for field in shown['fields'] if field['label'] == 'Barrier Construction')
        self.assertTrue(selected['table_captions'][0].startswith('Selected reviewed substrate configuration;'))
        self.assertNotIn('No matching source substrate row', selected['table_captions'][0])
        self.assertIn('Source: Example.pdf, page 2. Keep the 50 mm fillet and adjacent-wall condition.', selected['table_captions'][0])
        self.assertEqual(selected['table_captions'][1], caption)
        self.assertEqual(shown['fields'][-1], before['fields'][-1])
        self.assertEqual(source, before)
        self.assertEqual(technical_signature(source, projected.discovery['source-a'], self.assets),
                         technical_signature(shown, projected.discovery['source-a'], self.assets))
        self.assertEqual(present_reviewed_table_captions(source, {}), source)
        self.assertEqual(present_reviewed_table_captions(self.record, {'Barrier Construction': [0]}), self.record)

    def test_caption_scope_positions_follow_removed_tables_without_changing_lineage(self):
        field = self.record['fields'][-1]
        original = deepcopy(field['table'])
        field['table'] = {'columns': ['Other'], 'rows': [['Not retained']]}
        field['tables'] = [original]
        field['table_captions'] = ['Unselected', 'Source inventory']
        family = self.plan['families'][0]
        family['projection_sha256'] = projection_fingerprint(self.record)
        family['tables'] = [{'field': 'Barrier Construction', 'table_index': index, 'sha256': source_fingerprint(table)}
                            for index, table in enumerate([field['table'], original])]
        for index, variant in enumerate(family['variants']):
            variant['selections'] = [
                {'field': 'Barrier Construction', 'table_index': 0, 'row_indices': [], 'columns': None},
                {'field': 'Barrier Construction', 'table_index': 1, 'row_index': index, 'columns': None}]
        projected = self.project()
        for key, value in projected.records.items():
            self.assertEqual(projected.table_scopes[key], {'Barrier Construction': [0]})
            self.assertEqual(projected.lineage[key]['variant_sha256'],
                             source_fingerprint([value, projected.discovery[key]]))

    def test_capability_cannot_be_forged_and_new_services_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'capability'):
            project({'source-a': self.record}, {'source-a': self.facets}, {'payload': '{}'},
                    source_records={'source-a': self.raw}, assets=self.assets)
        self.plan['families'][0]['variants'][0]['facets']['services'] = ['Invented unapproved service']
        with self.assertRaisesRegex(ValueError, 'Unapproved variant Services'):
            self.project()

    def test_non_null_existing_target_cannot_create_an_unbound_arbitrary_id(self):
        self.plan['families'][0]['variants'][1]['existing_id'] = 'an-unbound-original'
        with self.assertRaisesRegex(ValueError, 'bound current record'):
            self.project()

    def test_sidecar_stamp_empty_absent_duplicate_keys_and_size_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assertIsNone(plan_stamp(directory))
            self.assertIsNone(load_review(directory, self.data, 'd' * 64, None))
            (directory / 'reviews').mkdir(); path = directory / 'reviews' / PLAN_NAME
            path.write_text(json.dumps(self.plan), encoding='utf-8')
            stamp = plan_stamp(directory)
            self.assertIsNotNone(load_review(directory, self.data, 'd' * 64, stamp))
            path.write_text('{"schema_version":1,"schema_version":1}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'changed before'):
                load_review(directory, self.data, 'd' * 64, stamp)
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                load_review(directory, self.data, 'd' * 64, plan_stamp(directory))
            path.write_bytes(b'')
            with self.assertRaises(ValueError):
                plan_stamp(directory)
            with path.open('wb') as stream:
                stream.truncate(MAX_PLAN_BYTES + 1)
            with self.assertRaises(ValueError):
                plan_stamp(directory)


if __name__ == '__main__':
    unittest.main()
