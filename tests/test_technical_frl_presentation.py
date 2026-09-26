from copy import deepcopy
import unittest

from estimator.technical_frl_presentation import normalize_frl_presentation


def summary(value, scope='source substrate alternatives', target='Barrier Construction table 1; FRL'):
    return f'{value} — {scope} ({target}).'


class TechnicalFrlPresentationTests(unittest.TestCase):
    def apply(self, value, **metadata):
        fields = [{'label': 'FRL', 'value': value, **metadata}]
        before = deepcopy(fields)
        result = normalize_frl_presentation(fields)
        self.assertEqual(fields, before)
        self.assertIsNot(result, fields)
        return result[0]

    def test_remove_repeated_low_endpoint_and_preserve_links_and_metadata(self):
        generated = summary('-/60/60 to -/120/120')
        metadata = {'table_links': [{'field': 'Barrier Construction', 'table_index': 0}],
                    'source_labels': ['FRL'], 'source_metadata': [{'source': 'fixture'}]}
        result = self.apply('-/60/60\n\n' + generated, **metadata)
        self.assertEqual(result, {'label': 'FRL', 'value': generated, **metadata})

    def test_remove_repeated_high_endpoint_and_single_rating(self):
        for generated in [summary('-/60/60 to -/120/120'), summary('-/120/120')]:
            with self.subTest(generated=generated):
                self.assertEqual(self.apply('-/120/120\n\n' + generated)['value'], generated)

    def test_repeated_numeric_bare_rating_is_removed_without_reformatting_summary(self):
        generated = summary('-/60/60')
        self.assertEqual(self.apply('FRL: – / 60 / 60.\n\n' + generated)['value'], generated)

    def test_intermediate_rating_remains_observed_information(self):
        value = '-/90/90\n\n' + summary('-/60/60 to -/120/120')
        self.assertEqual(self.apply(value)['value'], value)

    def test_unmatched_ratings_and_different_dash_positions_remain(self):
        for bare in ['60/60/60', '-/120/60', '-/180/180', '-/-/-']:
            value = bare + '\n\n' + summary('-/60/60 to -/120/120')
            with self.subTest(bare=bare):
                self.assertEqual(self.apply(value)['value'], value)

    def test_same_rating_with_service_and_barrier_scopes_keeps_both_scopes(self):
        service = summary('-/60/60', 'observed source service ratings', 'Service Size / Configuration table 1')
        barrier = summary('-/60/60', 'matched source barrier row', 'Barrier Construction table 2; Wall: Fixture A')
        value = '-/60/60\n\n' + service + '\n\n' + barrier
        self.assertEqual(self.apply(value)['value'], service + '\n\n' + barrier)

    def test_attributed_selector_rating_remains_even_when_it_matches(self):
        value = 'Selector / previously recorded rating: -/60/60\n\n' + summary('-/60/60 to -/120/120')
        self.assertEqual(self.apply(value)['value'], value)

    def test_qualified_rating_paragraphs_remain(self):
        for original in ['Up to -/60/60', '-/60/60 + 60 RISF', '-/60/60 (wall only)',
                         '-/60/60 without wrap', 'Floor: -/60/60', '-/60/60*']:
            value = original + '\n\n' + summary('-/60/60 to -/120/120')
            with self.subTest(original=original):
                self.assertEqual(self.apply(value)['value'], value)

    def test_with_and_without_wrap_summaries_are_not_merged(self):
        without = summary('-/60/60 to -/120/60', target='Barrier Construction table 1; FRL Without Wrap')
        with_wrap = summary('-/60/60 to -/120/120', target='Barrier Construction table 1; FRL With Wrap')
        value = '-/60/60\n\n' + without + '\n\n' + with_wrap
        self.assertEqual(self.apply(value)['value'], without + '\n\n' + with_wrap)

    def test_qualified_or_malformed_summary_does_not_replace_bare_rating(self):
        for ratings in ['-/60/60 +60 RISF', 'Up to -/60/60', '-/60/60 to 120/120', '-/60/60 (floor only)']:
            value = '-/60/60\n\n' + summary(ratings)
            with self.subTest(ratings=ratings):
                self.assertEqual(self.apply(value)['value'], value)

    def test_explicit_distinct_ratings_remain_distinct(self):
        generated = summary('-/120/60; -/90/90; 60/60/60')
        self.assertEqual(self.apply('-/90/90\n\n' + generated)['value'], generated)

    def test_non_generated_and_unresolved_paragraphs_do_not_replace_rating(self):
        for other in ['Some related source gives -/60/60 to -/120/120.',
                      'Source substrate alternatives: qualified source ratings remain as shown.',
                      '-/60/60 to -/120/120',
                      summary('-/60/60', 'observed concrete-slab service ratings', 'Service Size / Configuration table 1'),
                      summary('-/60/60', 'observed source service ratings', 'Service Size / Configuration table 1; applicability is not established')]:
            value = '-/60/60\n\n' + other
            with self.subTest(other=other):
                self.assertEqual(self.apply(value)['value'], value)

    def test_other_fields_and_raw_structured_content_are_untouched(self):
        generated = summary('-/60/60 to -/120/120')
        fields = [{'label': 'Blank Seal FRL', 'value': '-/60/60\n\n' + generated},
                  {'label': 'Service Size / Configuration', 'value': 'Keep source scope.',
                   'table': {'columns': ['FRL'], 'rows': [['-/60/60']]},
                   'table_row_ids': [['source-row-1']]}]
        self.assertEqual(normalize_frl_presentation(fields), fields)

    def test_plain_rating_is_unchanged_and_projection_is_idempotent(self):
        self.assertEqual(self.apply('-/60/60')['value'], '-/60/60')
        first = [{'label': 'FRL', 'value': '-/60/60\n\n' + summary('-/60/60 to -/120/120')}]
        once = normalize_frl_presentation(first)
        self.assertEqual(normalize_frl_presentation(once), once)


if __name__ == '__main__':
    unittest.main()
