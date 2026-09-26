"""Synthetic supplier-export examples; no captured supplier records in Git."""
from copy import deepcopy
import unittest

from scripts.import_promat_library import (map_variant, make_entry, group_key,
    summarize_frl, maximum_opening, wrap_text)
from estimator.library_substrates import classify_substrates
from estimator.technical_fields import FIELD_ORDER
from estimator.reference_library import field_text


def variant(identifier='example-1', *, size='40', barrier='Plasterboard wall, 100 mm',
            rating='-/60/60', report='EXAMPLE123'):
    sections = {
        'product_details': [('Fire protection product', 'Sample collar'), ('Service part', 'Sample40'), ('PI number', identifier)],
        'specifications': [('Fire rating performance', rating), ('Diameter', size),
            ('Compartment type', barrier), ('Service installation', 'Plastic pipe single layer, PVC')],
        'installation_details': [('Fire rating performance', rating), ('Fire rating direction', 'Wall - fire from both sides'),
            ('Service type', f'Plastic pipe single layer {size} mm, PVC'), ('', barrier),
            ('Service details', f'ø {size}, Wall - Horizontal'), ('Insulation (in place)', 'None'),
            ('Joint details', 'Sample40, Wall - both sides'), ('Service part', 'Sample40, Location: Wall - both sides, Fixings: M6 rods'),
            ('Report number', report), ('Test standard', 'AS1530.4')]}
    item = {'id': identifier, 'source_url': 'https://example.org/' + identifier,
            'source_sha256': 'a' * 64, 'source_diagrams': [], 'documents': [],
            'installation_groups': [{}], 'tables': [], 'source_quality_flags': []}
    item.update({k: [{'label': label, 'value': value} for label, value in pairs] for k, pairs in sections.items()})
    item['fields'] = [f for section in sections for f in item[section]]
    return item


class PromatImportTests(unittest.TestCase):
    def test_existing_vocabulary_and_duplicate_size_and_collar_ownership(self):
        row = map_variant(variant())
        self.assertTrue(set(row) <= set(FIELD_ORDER))
        self.assertEqual(row['Service Size / Configuration'], '40 mm\n\nWall - Horizontal\n\nExisting insulation: None')
        self.assertEqual(row['Collar'], 'Sample40')
        self.assertNotIn('Sample40', row['Installation Details'])
        self.assertEqual(row['Installation Details'].count('Wall - both sides'), 1)
        self.assertIn('M6 rods', row['Installation Details'])

    def test_service_direction_is_not_substrate_orientation(self):
        source = variant()
        entry = make_entry([(source, map_variant(source))])
        self.assertEqual(entry['filter_values']['orientation'], ['Vertical'])
        self.assertEqual(classify_substrates(entry, entry), ['Plasterboard wall'])

    def test_configuration_rows_keep_rating_size_and_substrate_pairs(self):
        a, b = variant(), variant('example-2', size='90', barrier='Concrete wall, 150 mm', rating='-/120/120')
        entry = make_entry([(s, map_variant(s)) for s in (a, b)])
        fields = {f['label']: f for f in entry['fields']}
        table = fields['Service Size / Configuration']['table']
        self.assertEqual(table['columns'], ['ID', 'Barrier Construction', 'Service Size / Configuration', 'FRL'])
        self.assertEqual(table['rows'][0][-1], '-/60/60')
        self.assertEqual(table['rows'][1][-1], '-/120/120')
        self.assertEqual(fields['FRL']['value'], '-/60/60 to -/120/120')
        self.assertEqual(fields['FRL']['table_links'], [{'field': 'Service Size / Configuration', 'table_index': 0}])
        self.assertEqual(classify_substrates(entry, entry), ['Plasterboard wall', 'Concrete/masonry wall'])
        field_text(entry['fields'], {})

    def test_different_reports_or_diagrams_never_group(self):
        a, b = variant(), variant('example-2', report='OTHER123')
        self.assertNotEqual(group_key(a, map_variant(a)), group_key(b, map_variant(b)))
        b = deepcopy(a)
        b['source_diagrams'] = [{'sha256': 'b' * 64}]
        self.assertNotEqual(group_key(a, map_variant(a)), group_key(b, map_variant(b)))

    def test_unknown_source_columns_and_conflicting_ratings_fail_closed(self):
        s = variant()
        s['fields'].append({'label': 'Unmapped source label', 'value': 'Important limit'})
        with self.assertRaisesRegex(ValueError, 'Unreviewed source'):
            map_variant(s)
        s = variant()
        s['installation_details'][0]['value'] = '-/90/90'
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            map_variant(s)

    def test_summaries_never_construct_an_unobserved_rating_or_aperture(self):
        self.assertEqual(summarize_frl(['-/120/60', '-/90/90']), '-/120/60\n\n-/90/90')
        self.assertEqual(maximum_opening(['ø 60mm', 'ø 90mm']), 'ø 90mm')
        self.assertEqual(maximum_opening(['100 x 400mm', '200 x 200mm']), '')

    def test_wrap_cleanup_preserves_conflicting_lengths_and_scope(self):
        self.assertEqual(wrap_text(': Wrap, Configuration: 300mm Each Face, Class: Wrap, : Wall - both sides 600mm Long, 600mm Long'),
                         'Wrap; Configuration: 300mm Each Face; Wall - both sides 600mm Long')
        self.assertEqual(wrap_text('Sample Wrap, Configuration: 600mm, Floor - both sides Sample Wrap'),
                         'Sample Wrap; Configuration: 600mm; Floor - both sides')

    def test_aperture_infill_does_not_create_another_substrate(self):
        s = variant(barrier='Concrete Slab, 150 mm')
        for f in s['fields']:
            if f['label'] == 'Service details': f['value'] = 'ø 40, Floor - Vertical'
            if f['label'] == 'Fire rating direction': f['value'] = 'Floor - fire from below'
        s['fields'].append({'label': 'Aperture part', 'value': 'PROMASEAL® Bulkhead Batt, Thickness: 2x50mm'})
        entry = make_entry([(s, map_variant(s))])
        self.assertEqual(classify_substrates(entry, entry), ['Concrete/masonry floor'])

    def test_blank_seal_uses_barrier_table_and_blank_rating(self):
        a, b = variant(), variant('example-2', barrier='Concrete wall, 150 mm', rating='-/120/120')
        for s in (a, b):
            for f in s['fields']:
                if f['label'] == 'Service installation': f['value'] = 'None, None'
                if f['label'] == 'Service type': f['value'] = 'None'
        entry = make_entry([(s, map_variant(s)) for s in (a, b)])
        fields = {f['label']: f for f in entry['fields']}
        self.assertIn('table', fields['Barrier Construction'])
        self.assertNotIn('FRL', fields)
        self.assertEqual(fields['Blank Seal FRL']['value'], '-/60/60 to -/120/120')

    def test_blank_seal_common_rating_still_maps_each_table_substrate(self):
        a, b = variant(), variant('example-2', barrier='Concrete wall, 150 mm')
        for s in (a, b):
            for f in s['fields']:
                if f['label'] == 'Service installation': f['value'] = 'None, None'
                if f['label'] == 'Service type': f['value'] = 'None'
        entry = make_entry([(s, map_variant(s)) for s in (a, b)])
        self.assertEqual(classify_substrates(entry, entry), ['Plasterboard wall', 'Concrete/masonry wall'])


if __name__ == '__main__':
    unittest.main()
