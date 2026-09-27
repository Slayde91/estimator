from copy import deepcopy
import unittest

from estimator.library_report_links import validate_report_links, valid_report_url
from estimator.library_facets import frl_values
from estimator.technical_presentation import technical_title


class TrafalgarReportPresentationTests(unittest.TestCase):
    def test_only_document_urls_on_exact_publisher_host_are_allowed(self):
        self.assertTrue(valid_report_url('https://tfire.com.au/documents/Example-Report'))
        self.assertTrue(valid_report_url('https://tfire.com.au/documents/Example_report.pdf'))
        for url in ('http://tfire.com.au/documents/report', 'https://tfire.com.au.evil/documents/report',
                    'https://user@tfire.com.au/documents/report', 'https://tfire.com.au:443/documents/report',
                    'https://tfire.com.au/documents/report?redirect=evil', 'https://tfire.com.au/documents/report#other',
                    'https://tfire.com.au/product/report', 'https://tfire.com.au/documents/',
                    'https://tfire.com.au/documents/..', 'https://tfire.com.au/documents/%2e%2e/report',
                    'https://tfire.com.au/documents/report/next', 'https://tfire.com.au/documents/report\n'):
            self.assertFalse(valid_report_url(url), url)

    def test_partial_report_matches_preserve_unmatched_labels_and_order(self):
        field = {'label': 'Report Number', 'value': 'FIRST\nUNMATCHED\nLAST', 'report_links': [
            {'label': 'FIRST', 'url': 'https://tfire.com.au/documents/First'},
            {'label': 'LAST', 'url': 'https://tfire.com.au/documents/Last'}]}
        validate_report_links(field)
        for links in (field['report_links'][::-1], field['report_links'] * 2,
                      [{'label': 'NOT-LISTED', 'url': 'https://tfire.com.au/documents/First'}]):
            with self.assertRaises(ValueError): validate_report_links({**field, 'report_links': links})

    def fixture(self):
        fields = [{'label': 'ID', 'value': '1'}, {'label': 'Service', 'value': 'Pipe'},
                  {'label': 'Barrier Construction', 'value': '', 'table': {
                      'columns': ['Wall', 'FRL With TWrap', 'FRL Without Servowrap'],
                      'rows': [['Wall A', '-/60/60', '-/60/-'], ['Wall B', '-/120/120', '-/120/60']]}},
                  {'label': 'FRL', 'value': '-/60/60 to -/120/120 — source substrate alternatives (Barrier Construction table 1; FRL With TWrap).\n\n'
                      '-/60/-; -/120/60 — source substrate alternatives (Barrier Construction table 1; FRL Without Servowrap).',
                   'table_links': [{'field': 'Barrier Construction', 'table_index': 0}]}]
        item = {'id': 'test', 'fields': fields, 'filter_values': {'manufacturer': ['Trafalgar'], 'orientation': ['Vertical']}}
        item['filter_values']['frl'] = frl_values(item)
        return item

    def test_title_uses_standard_range_but_detail_and_facets_keep_unwrapped_ratings(self):
        item = self.fixture()
        original = deepcopy(item)
        self.assertEqual(technical_title(item), 'Trafalgar: 1 — Pipe — -/60/60 to -/120/120 — Vertical')
        self.assertEqual(item, original)
        self.assertIn('-/120/60', item['filter_values']['frl'])
        self.assertIn('-/60/-', item['filter_values']['frl'])

    def test_title_respects_matched_row_scope(self):
        item = self.fixture()
        item['fields'][-1]['value'] = 'Source substrate alternatives (Barrier Construction table 1; Wall: Wall A).'
        self.assertIn(' — -/60/60 — ', technical_title(item))

    def test_inline_unwrapped_rating_is_not_in_title(self):
        item = self.fixture()
        item['fields'] = [{'label': 'FRL', 'value': 'Up to -/180/120 (-/180/90 without TWrap)'}]
        item['filter_values']['frl'] = frl_values(item)
        self.assertIn(' — -/180/120 — ', technical_title(item))
        self.assertEqual(item['filter_values']['frl'], ['-/180/90', '-/180/120'])

    def test_unwrapped_only_or_unrelated_wrap_prose_keeps_rating(self):
        item = self.fixture()
        item['fields'] = [{'label': 'FRL', 'value': '-/120/- without TWrap'}]
        item['filter_values']['frl'] = frl_values(item)
        self.assertIn(' — -/120/- — ', technical_title(item))
        item['fields'] = [{'label': 'Installation Details', 'value': 'Without TWrap for this alternative'}]
        self.assertIn(' — -/120/- — ', technical_title(item))
