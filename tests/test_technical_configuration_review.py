"""Synthetic source-row coverage; no supplier content in the repository."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceLibrary
from estimator.technical_configuration_review import validate_configuration_review
from estimator.technical_field_reviewed import review_fingerprint
import estimator.technical_fields as projection
from tests.test_reference_library import sample_library
from unittest.mock import patch


class ConfigurationReviewTests(unittest.TestCase):
    def setUp(self):
        self.assets = {'report-a': {'pdf': True, 'pages': 2, 'sha256': 'a' * 64},
                       'diagram-a': {'pdf': False, 'sha256': 'b' * 64}}
        self.item = {'sources': [{'document_id': 'report-a', 'page': 2}],
                     'fields': [{'label': 'Refer Figure', 'value': '',
                                 'images': [{'id': 'diagram-a'}]}]}
        size = {'columns': ['Source row', 'Service'],
                'rows': [['1', 'Sample small pipe'], ['2', 'Sample large pipe']]}
        wrap = {'columns': ['Source row', 'Wrap', 'Ties', 'FRL'],
                'rows': [['1', '250 mm', '2', '-/60/60'], ['2', '500 mm', '4', '-/90/60']]}
        self.review = {'fields': [{'label': 'Service Size / Configuration', 'value': '', 'table': size},
                                  {'label': 'Service Wrap', 'value': '', 'table': wrap}],
                       'configuration_sources': [{'asset_id': 'report-a', 'sha256': 'a' * 64,
                                                  'page': 2, 'groups': [{
                           'row_ids': ['1', '2'], 'tables': [
                               {'label': label, 'table_index': 0, 'sha256': review_fingerprint(table)}
                               for label, table in [('Service Size / Configuration', size), ('Service Wrap', wrap)]]}]}]}

    def validate(self, review=None):
        return validate_configuration_review(self.review if review is None else review, self.item, self.assets)

    def test_complete_paired_source_rows_are_accepted_without_mutation(self):
        before = deepcopy(self.review)
        self.validate()
        self.assertEqual(self.review, before)

    def test_dropped_added_reordered_or_repeated_rows_reject_even_with_new_table_hash(self):
        for rows in [[['1', 'Sample small pipe']], [['1', 'x'], ['3', 'y']],
                     [['2', 'y'], ['1', 'x']], [['1', 'x'], ['1', 'y']]]:
            invalid = deepcopy(self.review)
            invalid['fields'][0]['table']['rows'] = rows
            invalid['configuration_sources'][0]['groups'][0]['tables'][0]['sha256'] = review_fingerprint(invalid['fields'][0]['table'])
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, 'rows changed'):
                self.validate(invalid)

    def test_changed_wrap_ties_or_rating_reject_stale_review(self):
        for column in (1, 2, 3):
            invalid = deepcopy(self.review)
            invalid['fields'][1]['table']['rows'][1][column] = 'Changed'
            with self.subTest(column=column), self.assertRaisesRegex(ValueError, 'table changed'):
                self.validate(invalid)

    def test_changed_document_fingerprint_rejects_review(self):
        self.assets['report-a']['sha256'] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.validate()

    def test_missing_unlinked_or_wrong_page_sources_reject(self):
        for changes in ({'asset_id': 'missing'}, {'page': 1}, {'page': 3}, {'page': True}):
            invalid = deepcopy(self.review)
            invalid['configuration_sources'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.validate(invalid)

    def test_registered_attached_raster_diagram_can_be_a_review_source(self):
        source = self.review['configuration_sources'][0]
        source.update(asset_id='diagram-a', sha256='b' * 64, page=1)
        self.validate()
        self.item['fields'] = []
        with self.assertRaises(ValueError):
            self.validate()

    def test_duplicate_source_and_table_claims_reject(self):
        duplicate_source = deepcopy(self.review)
        duplicate_source['configuration_sources'] *= 2
        duplicate_table = deepcopy(self.review)
        duplicate_table['configuration_sources'][0]['groups'][0]['tables'] *= 2
        for invalid in (duplicate_source, duplicate_table):
            with self.assertRaises(ValueError):
                self.validate(invalid)

    def test_absent_and_ambiguous_table_references_reject(self):
        for mutate in (lambda r: r['fields'].pop(),
                       lambda r: r['fields'].append(deepcopy(r['fields'][0])),
                       lambda r: r['configuration_sources'][0]['groups'][0]['tables'][0].update(table_index=9)):
            invalid = deepcopy(self.review)
            mutate(invalid)
            with self.assertRaises(ValueError):
                self.validate(invalid)

    def test_malformed_empty_or_duplicate_row_inventories_reject(self):
        for rows in ([], ['1', '1'], [''], [1], '1', [None]):
            invalid = deepcopy(self.review)
            invalid['configuration_sources'][0]['groups'][0]['row_ids'] = rows
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.validate(invalid)

    def test_older_editorial_reviews_make_no_configuration_coverage_claim(self):
        self.validate({'fields': []})

    def test_library_load_enforces_review_and_preserves_search_and_original_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, _, _ = sample_library(root)
            item = data['libraries']['technical']['items'][0]
            captured = []
            with patch.object(projection, 'normalize_reviewed_content', side_effect=lambda fields, *args: captured.extend(deepcopy(fields)) or fields):
                projection.normalize_technical_item(item)
            review = deepcopy(self.review)
            review.update(source_fields_sha256=review_fingerprint(item['fields']),
                          pre_review_fields_sha256=review_fingerprint(captured))
            review['configuration_sources'][0]['sha256'] = data['documents'][0]['sha256']
            item['technical_field_review'] = review
            index = root / 'library.json'
            index.write_text(json.dumps(data), encoding='utf-8')
            library = ReferenceLibrary(root)
            detail = library.detail('technical', item['id'])
            self.assertEqual(detail['technical_basis']['source_fields'], item['fields'])
            self.assertEqual(library.listing('technical', search='500')['total'], 1)
            self.assertEqual(next(f for f in detail['fields'] if f['label'] == 'Service Wrap')['table'], review['fields'][1]['table'])
            review['fields'][1]['table']['rows'].pop()
            index.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValidationError):
                ReferenceLibrary(root).overview()


if __name__ == '__main__':
    unittest.main()
