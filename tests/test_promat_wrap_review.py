from copy import deepcopy
import unittest

from estimator.technical_field_reviewed import review_fingerprint
from scripts.import_promat_library import make_entry, map_variant
from scripts.review_promat_wraps import apply_reviews
from tests.test_promat_import import variant


class PromatWrapReviewTests(unittest.TestCase):
    def fixture(self):
        a, b = variant(), variant('example-2', rating='-/120/120')
        rows = [map_variant(s) for s in (a, b)]
        rows[1]['Service Wrap'] = 'Example wrap; 300 mm top side'
        item = make_entry(list(zip((a, b), rows)))
        item['technical_field_review'] = {'fields': deepcopy(item['fields'])}
        bundle = {'libraries': {'technical': {'items': [item]}}}
        decision = {'id': item['id'], 'value': 'N/A', 'reason': 'Reviewed wall detail requires no wrap.',
                    'variant_ids': item['promat_source']['variant_ids'],
                    'expected_sha256': review_fingerprint({'source_fields': item['fields'],
                        'reviewed_fields': item['technical_field_review']['fields'],
                        'promat_source': item['promat_source']})}
        return bundle, decision

    def test_review_removes_only_wrap_column_and_retains_evidence_and_rating_rows(self):
        bundle, decision = self.fixture()
        original = deepcopy(bundle)
        updated = apply_reviews(bundle, [decision])['libraries']['technical']['items'][0]
        self.assertEqual(bundle, original)
        self.assertEqual(updated['fields'], bundle['libraries']['technical']['items'][0]['fields'])
        fields = {f['label']: f for f in updated['technical_field_review']['fields']}
        self.assertEqual(fields['Service Wrap'], {'label': 'Service Wrap', 'value': 'N/A'})
        config = fields['Service Size / Configuration']
        self.assertEqual(config['table']['columns'], ['ID', 'FRL'])
        self.assertEqual(config['table']['rows'], [['example-1', '-/60/60'], ['example-2', '-/120/120']])
        self.assertEqual(config['table_row_ids'], [['example-1', 'example-2']])
        self.assertEqual(fields['FRL']['table_links'], [{'field': 'Service Size / Configuration', 'table_index': 0}])
        self.assertEqual(updated['technical_field_review']['wrap_reviews'], [decision])

    def test_stale_source_review_and_page_identity_each_block_application(self):
        for section in ('source', 'review', 'pages'):
            bundle, decision = self.fixture()
            item = bundle['libraries']['technical']['items'][0]
            if section == 'pages':
                item['promat_source']['pages'][0]['sha256'] = 'b' * 64
            else:
                fields = item['fields'] if section == 'source' else item['technical_field_review']['fields']
                fields[0]['value'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'evidence changed'):
                apply_reviews(bundle, [decision])

    def test_partial_variant_review_and_duplicate_decisions_are_rejected(self):
        bundle, decision = self.fixture()
        partial = {**decision, 'variant_ids': decision['variant_ids'][:1]}
        with self.assertRaisesRegex(ValueError, 'every variant'):
            apply_reviews(bundle, [partial])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            apply_reviews(bundle, [decision, decision])

    def test_common_wrap_is_standalone_but_missing_and_different_wraps_stay_paired(self):
        for wraps in [('300 mm each face', '300 mm each face'),
                      ('', '600 mm top side'), ('300 mm each face', '600 mm each face')]:
            with self.subTest(wraps=wraps):
                systems = [variant(), variant('example-2', rating='-/120/120')]
                rows = [map_variant(s) for s in systems]
                for row, wrap in zip(rows, wraps):
                    if wrap:
                        row['Service Wrap'] = wrap
                fields = {f['label']: f for f in make_entry(list(zip(systems, rows)))['fields']}
                table = fields['Service Size / Configuration']['table']
                if wraps[0] == wraps[1]:
                    self.assertNotIn('Service Wrap', table['columns'])
                    self.assertEqual(fields['Service Wrap']['value'], wraps[0])
                    self.assertNotIn('table_links', fields['Service Wrap'])
                else:
                    index = table['columns'].index('Service Wrap')
                    self.assertEqual([r[index] for r in table['rows']], list(wraps))

    def test_unselected_entries_are_unchanged_and_repeat_requires_new_review(self):
        bundle, decision = self.fixture()
        other = deepcopy(bundle['libraries']['technical']['items'][0])
        other['id'] = 'other'
        bundle['libraries']['technical']['items'].append(other)
        result = apply_reviews(bundle, [decision])
        self.assertEqual(result['libraries']['technical']['items'][1], other)
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            apply_reviews(result, [decision])
