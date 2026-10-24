"""Grouping changes discoverability, never records or selected filter values."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.library_facets import SERVICES
from estimator.library_filter_groups import SERVICE_GROUPS, grouped_filter_options
from estimator.reference_library import ReferenceLibrary
from tests.test_reference_library import sample_library


def options(values):
    return [{'value': value, 'label': value} for value in values]


class FilterGroupTests(unittest.TestCase):
    def test_all_services_appear_once_and_unknown_or_mixed_choices_stay_standalone(self):
        source = options([*SERVICES, 'Saved custom service'])
        original = deepcopy(source)
        result = grouped_filter_options('services', source)
        self.assertEqual(source, original)
        self.assertCountEqual([row['value'] for row in result], [row['value'] for row in source])
        self.assertEqual(len({row['value'] for row in result}), len(source))
        self.assertEqual([row['value'] for row in result if 'group' not in row],
                         ['N/A', 'Mixed Services', 'Saved custom service'])
        groups = list(dict.fromkeys(row['group'] for row in result if 'group' in row))
        self.assertEqual(groups, [name for name, _ in SERVICE_GROUPS])
        by_value = {row['value']: row for row in result}
        self.assertEqual(by_value['Pair Coils']['group'], 'Mechanical')
        self.assertEqual(by_value['Fire Dampers']['group'], 'HVAC')
        self.assertEqual(by_value['Copper Pipes']['label'], 'Copper Pipes')
        self.assertEqual(grouped_filter_options('service_type', source), result)

    def test_frl_groups_use_centre_criterion_and_keep_ninety_three_hundred_and_future_values(self):
        source = options(['240/60/30', '-/120/30', '-/30/-', '-/90/60', '-/300/180',
                          '-/180/180', '-/240/240', '-/60/60', '-/45/30', 'Unspecified'])
        result = grouped_filter_options('frl', source)
        by_value = {row['value']: row for row in result}
        self.assertEqual(by_value['240/60/30']['group'], '60')
        self.assertEqual(by_value['-/120/30']['group'], '120')
        self.assertEqual(by_value['-/90/60']['group'], '90')
        self.assertEqual(by_value['-/300/180']['group'], '300')
        self.assertEqual(by_value['-/45/30']['group'], '45')
        self.assertNotIn('group', by_value['Unspecified'])
        self.assertCountEqual([row['value'] for row in result], [row['value'] for row in source])
        self.assertTrue(all(row['label'] == row['value'] for row in result))

    def test_report_ownership_uses_actual_metadata_and_keeps_shared_and_missing_reports(self):
        for key in ('report', 'document'):
            records = [
                {'filter_values': {key: ['A', 'Shared', 'Partly unknown'], 'manufacturer': ['Promat']}},
                {'filter_values': {key: ['B', 'Shared'], 'manufacturer': ['Trafalgar']}},
                {'filter_values': {key: ['Unknown', 'Partly unknown']}},
            ]
            original = deepcopy(records)
            source = options(['A', 'B', 'Shared', 'Unknown', 'Partly unknown', 'Future report'])
            by_value = {row['value']: row for row in grouped_filter_options(key, source, records)}
            self.assertEqual(by_value['A']['group'], 'Promat')
            self.assertEqual(by_value['B']['group'], 'Trafalgar')
            for value in ('Shared', 'Unknown', 'Partly unknown', 'Future report'):
                self.assertNotIn('group', by_value[value])
            self.assertEqual(records, original)
            self.assertEqual(set(by_value), {row['value'] for row in source})

    def test_native_listing_metadata_preserves_queries_source_fields_and_source_bytes(self):
        for key in ('report', 'document'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                data, _, _ = sample_library(root)
                technical = data['libraries']['technical']
                technical['filters'] = [{'key': key, 'label': 'Report'}]
                item = technical['items'][0]
                item['fields'].extend([{'label': 'ID', 'value': 'sys_var_123_au'},
                                       {'label': 'Manufacturer', 'value': 'Promat'},
                                       {'label': 'FRL', 'value': '-/300/180'}])
                item['filter_values'] = {key: ['Sample report']}
                file = root / 'library.json'
                file.write_text(json.dumps(data), encoding='utf-8')
                source = file.read_bytes()
                library = ReferenceLibrary(root)
                listing = library.listing('technical', **{key: 'Sample report'})
                report = next(entry for entry in listing['filters'] if entry['key'] == key)
                self.assertEqual(report['options'], [{'value': 'Sample report', 'label': 'Sample report', 'group': 'Promat'}])
                self.assertEqual([row['id'] for row in listing['items']], [item['id']])
                self.assertEqual(library.listing('technical', **{key: 'Absent'})['total'], 0)
                detail = library.detail('technical', item['id'])
                self.assertEqual(next(field['value'] for field in detail['fields']
                                      if field['label'] == 'ID'), 'sys_var_123_au')
                self.assertEqual(detail['id'], item['id'])
                self.assertEqual(file.read_bytes(), source)


if __name__ == '__main__':
    unittest.main()
