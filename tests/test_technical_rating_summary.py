import unittest
from copy import deepcopy

from estimator.technical_rating_summary import summarize_ratings


class TechnicalRatingSummaryTests(unittest.TestCase):
    def test_observed_endpoints_sorted_without_creating_intermediate_ratings(self):
        result = summarize_ratings(['-/120/120', '-/30/30', '-/90/90'])
        self.assertEqual(result['summary'], '-/30/30 to -/120/120')
        self.assertEqual(result['ratings'], ['-/30/30', '-/90/90', '-/120/120'])
        self.assertEqual(result['kind'], 'range')
        self.assertNotIn('-/60/60', result['ratings'])

    def test_endpoint_range_within_a_cell_is_parsed(self):
        for text in ('-/30/30 to -/90/90', '-/30/30 – -/90/90', '-/30/30—-/90/90'):
            with self.subTest(text=text):
                self.assertEqual(summarize_ratings([text])['summary'], '-/30/30 to -/90/90')

    def test_duplicates_and_harmless_formatting(self):
        result = summarize_ratings(['FRL: - / 060 / 060.', '-/60/60', '–/60/60'])
        self.assertEqual(result['summary'], '-/60/60')
        self.assertEqual(result['ratings'], ['-/60/60'])
        self.assertEqual(result['kind'], 'single')

    def test_complete_numeric_triples_remain_complete(self):
        result = summarize_ratings(['120/120/90', '60/60/30'])
        self.assertEqual(result['summary'], '60/60/30 to 120/120/90')

    def test_componentwise_extrema_are_never_fabricated(self):
        result = summarize_ratings(['-/120/60', '-/90/90'])
        self.assertEqual(result['kind'], 'distinct')
        self.assertEqual(result['summary'], '-/120/60; -/90/90')
        self.assertNotIn('-/90/60', result['ratings'])
        self.assertNotIn('-/120/90', result['ratings'])

    def test_middle_incomparable_rating_prevents_false_range(self):
        result = summarize_ratings(['-/30/30', '-/60/120', '-/90/90', '-/180/180'])
        self.assertEqual(result['kind'], 'distinct')
        self.assertNotIn(' to ', result['summary'])

    def test_mixed_dash_positions_do_not_imply_applicability(self):
        result = summarize_ratings(['-/60/60', '60/60/60', '-/120/-'])
        self.assertEqual(result['summary'], '-/60/60; 60/60/60; -/120/-')
        self.assertEqual(result['kind'], 'distinct')

    def test_zero_is_not_treated_as_dash(self):
        result = summarize_ratings(['0/60/60', '-/60/60'])
        self.assertEqual(result['kind'], 'distinct')
        self.assertEqual(result['ratings'], ['0/60/60', '-/60/60'])

    def test_qualified_cells_are_preserved_and_do_not_supply_a_range(self):
        for value in ('Up to -/120/120', '-/120/120 (wall only)', '-/120/120 + 60 RISF',
                      'Internal: -/120/120; external: -/60/60', '-/120/120*'):
            with self.subTest(value=value):
                result = summarize_ratings(['-/30/30', value])
                self.assertEqual(result['summary'], '')
                self.assertEqual(result['qualified'], [value])
                self.assertEqual(result['kind'], 'unresolved')

    def test_malformed_rating_mixed_with_valid_evidence_blocks_summary(self):
        for value in ('-/120', '-/120/120/60', '-/120/120 / 60', '-/60/60 and -/90',
                      '12.5/60/60', '-30/60/60', 'X-/60/60', '120/120/120X'):
            with self.subTest(value=value):
                result = summarize_ratings(['-/30/30', value])
                self.assertEqual(result['summary'], '')
                self.assertEqual(result['unparsed'], [value])
                self.assertEqual(result['kind'], 'unresolved')

    def test_unrecognized_status_and_missing_cells_are_not_silently_dropped(self):
        result = summarize_ratings(['-/60/60', '', 'Not assessed'])
        self.assertEqual(result['summary'], '')
        self.assertEqual(result['unparsed'], ['Not assessed'])
        self.assertEqual(result['empty_count'], 1)
        self.assertEqual(result['kind'], 'unresolved')

    def test_blank_cell_alone_has_no_rating(self):
        result = summarize_ratings([' ', '\n'])
        self.assertEqual(result['summary'], '')
        self.assertEqual(result['ratings'], [])
        self.assertEqual(result['empty_count'], 2)
        self.assertEqual(result['kind'], 'empty')

    def test_blank_alongside_rating_prevents_claim_of_complete_summary(self):
        result = summarize_ratings(['-/60/60', ''])
        self.assertEqual(result['summary'], '')
        self.assertEqual(result['kind'], 'unresolved')

    def test_all_dash_triple_does_not_become_a_performance_rating(self):
        result = summarize_ratings(['-/-/-'])
        self.assertEqual(result['summary'], '')
        self.assertEqual(result['ratings'], [])
        self.assertEqual(result['unparsed'], ['-/-/-'])

    def test_lists_and_explicit_alternatives_preserve_observed_values(self):
        for separator in (', ', '; ', ' and ', ' or ', '\n', ' | '):
            with self.subTest(separator=separator):
                result = summarize_ratings([separator.join(['-/30/30', '-/60/60'])])
                self.assertEqual(result['ratings'], ['-/30/30', '-/60/60'])
                self.assertEqual(result['kind'], 'range')

    def test_inputs_are_not_mutated(self):
        values = ['-/120/120', 'Unconfirmed: -/60/60']
        before = deepcopy(values)
        summarize_ratings(values)
        self.assertEqual(values, before)

    def test_non_string_cells_are_rejected(self):
        with self.assertRaises(TypeError):
            summarize_ratings(['-/60/60', None])

    def test_empty_input(self):
        self.assertEqual(summarize_ratings([]), {
            'summary': '', 'ratings': [], 'unparsed': [], 'qualified': [],
            'empty_count': 0, 'kind': 'empty',
        })
