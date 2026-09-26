"""Configuration links preserve table identity through validation/projection."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceLibrary, field_text
from estimator.technical_field_reviewed import review_fingerprint
import estimator.technical_fields as projection
from tests.test_reference_library import sample_library


class TableNavigationTests(unittest.TestCase):
    def setUp(self):
        table = {'columns': ['Configuration', 'Service', 'Wrap', 'FRL'],
                 'rows': [['1', 'Sample pipe', '250 mm', '-/60/60'],
                          ['2', 'Sample pipe', '500 mm', '-/120/90']]}
        self.fields = [
            {'label': 'Service Size / Configuration', 'value': '',
             'table': deepcopy(table), 'tables': [deepcopy(table)],
             'table_captions': ['Source page 1', 'Separate source page 2']},
            {'label': 'FRL', 'value': '-/60/60 to -/120/90',
             'table_links': [{'field': 'Service Size / Configuration', 'table_index': 0},
                             {'field': 'Service Size / Configuration', 'table_index': 1}]},
            {'label': 'Service Wrap', 'value': '',
             'table_links': [{'field': 'Service Size / Configuration', 'table_index': 1}]},
        ]

    def test_equal_tables_with_distinct_sources_and_link_only_fields_survive(self):
        original = deepcopy(self.fields)
        text = field_text(self.fields, {}, projected=True)
        projected = projection._merge_fields(self.fields)
        size = next(f for f in projected if f['label'] == 'Service Size / Configuration')
        self.assertEqual(len(size['tables']), 2)
        self.assertEqual(size['table_captions'], original[0]['table_captions'])
        wrap = next(f for f in projected if f['label'] == 'Service Wrap')
        self.assertEqual(wrap['value'], '')
        self.assertEqual(wrap['table_links'], original[2]['table_links'])
        field_text(projected, {}, projected=True)
        self.assertIn('Separate source page 2', text)
        self.assertEqual(self.fields, original)

    def test_invalid_or_external_targets_and_unbounded_indices_are_rejected(self):
        for link in ({'field': 'https://example.com', 'table_index': 0},
                     {'field': 'Service Size / Configuration', 'table_index': True},
                     {'field': 'Service Size / Configuration', 'table_index': -1},
                     {'field': 'Service Size / Configuration', 'table_index': 2},
                     {'field': 'Service Size / Configuration', 'table_index': '0'},
                     {'field': 'Service Size / Configuration', 'table_index': 0, 'url': 'javascript:x'},
                     None):
            fields = deepcopy(self.fields)
            fields[1]['table_links'] = [link]
            with self.subTest(link=link), self.assertRaises(ValueError):
                field_text(fields, {}, projected=True)

    def test_referenced_equal_tables_keep_indices_without_optional_captions(self):
        fields = deepcopy(self.fields)
        del fields[0]['table_captions']
        field_text(fields, {}, projected=True)
        projected = projection._merge_fields(fields)
        size = next(f for f in projected if f['label'] == 'Service Size / Configuration')
        self.assertEqual(len(size['tables']), 2)
        field_text(projected, {}, projected=True)

    def test_missing_duplicate_and_self_references_are_rejected(self):
        missing = deepcopy(self.fields[1:])
        duplicate_link = deepcopy(self.fields)
        duplicate_link[1]['table_links'] *= 2
        duplicate_field = deepcopy(self.fields) + [deepcopy(self.fields[0])]
        self_link = deepcopy(self.fields)
        self_link[0]['table_links'] = deepcopy(self.fields[2]['table_links'])
        for fields in (missing, duplicate_link, duplicate_field, self_link):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                field_text(fields, {}, projected=True)

    def test_captions_must_stay_aligned_and_bounded(self):
        for captions in ([], ['only one'], ['one', 'two', 'extra'], ['one', None],
                         ['one', ''], ['one', 'x' * 2001], 'not a list'):
            fields = deepcopy(self.fields)
            fields[0]['table_captions'] = captions
            with self.subTest(captions=captions), self.assertRaises(ValueError):
                field_text(fields, {}, projected=True)

    def test_legacy_fields_without_navigation_are_unchanged(self):
        fields = [{'label': 'FRL', 'value': '-/60/60'}, {'label': 'FRL', 'value': '-/90/90'}]
        self.assertEqual(field_text(fields, {}), ['FRL', '-/60/60', 'FRL', '-/90/90'])

    def test_loaded_review_keeps_links_original_evidence_and_search(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, _, _ = sample_library(root)
            item = data['libraries']['technical']['items'][0]
            original = deepcopy(item['fields'])
            captured = []
            with patch.object(projection, 'normalize_reviewed_content',
                              side_effect=lambda fields, *args: captured.extend(deepcopy(fields)) or fields):
                projection.normalize_technical_item(item)
            item['technical_field_review'] = {
                'source_fields_sha256': review_fingerprint(original),
                'pre_review_fields_sha256': review_fingerprint(captured),
                'fields': deepcopy(self.fields),
            }
            index = root / 'library.json'
            index.write_text(json.dumps(data), encoding='utf8')
            library = ReferenceLibrary(root)
            detail = library.detail('technical', item['id'])
            self.assertEqual(detail['technical_basis']['source_fields'], original)
            wrap = next(f for f in detail['fields'] if f['label'] == 'Service Wrap')
            self.assertEqual(wrap['table_links'][0]['table_index'], 1)
            self.assertEqual(library.listing('technical', search='500 mm')['total'], 1)
            self.assertEqual(library.listing('technical', search='Separate source page 2')['total'], 1)
            item['technical_field_review']['fields'][2]['table_links'][0]['table_index'] = 7
            index.write_text(json.dumps(data), encoding='utf8')
            with self.assertRaises(ValidationError):
                ReferenceLibrary(root).overview()


if __name__ == '__main__':
    unittest.main()
