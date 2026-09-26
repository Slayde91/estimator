"""Synthetic tests; private source passages and reviews are not shipped."""

from copy import deepcopy
import unittest

from estimator.technical_field_reviewed import normalize_reviewed_content, review_fingerprint


class ReviewedContentTests(unittest.TestCase):
    def setUp(self):
        self.original = [{'label': 'Service Description', 'value': 'Sample pipe, nominal 20 mm.'}]
        self.projected = [{'label': 'Service', 'value': 'Sample pipe, nominal 20 mm.'}]
        self.reviewed = [{'label': 'Service', 'value': 'Sample pipe'},
                         {'label': 'Service Size / Configuration', 'value': 'Nominal 20 mm'}]
        self.review = {'source_fields_sha256': review_fingerprint(self.original),
                       'pre_review_fields_sha256': review_fingerprint(self.projected),
                       'fields': deepcopy(self.reviewed)}

    def test_unreviewed_fields_remain_unchanged_and_independent(self):
        actual = normalize_reviewed_content(self.projected)
        self.assertEqual(actual, self.projected)
        actual[0]['value'] = 'Changed copy'
        self.assertEqual(self.projected[0]['value'], 'Sample pipe, nominal 20 mm.')

    def test_matching_review_applies_and_preserves_review_object(self):
        actual = normalize_reviewed_content(self.projected, self.review, self.original)
        self.assertEqual(actual, self.reviewed)
        actual[0]['value'] = 'Changed copy'
        self.assertEqual(self.review['fields'], self.reviewed)

    def test_changed_original_evidence_rejects_stale_review(self):
        original = deepcopy(self.original)
        original[0]['value'] = 'Sample pipe, nominal 25 mm.'
        with self.assertRaisesRegex(ValueError, 'source fields changed'):
            normalize_reviewed_content(self.projected, self.review, original)

    def test_changed_generic_projection_rejects_stale_review(self):
        projected = deepcopy(self.projected)
        projected.append({'label': 'Installation Details', 'value': 'New source condition.'})
        with self.assertRaisesRegex(ValueError, 'projection changed'):
            normalize_reviewed_content(projected, self.review, self.original)

    def test_review_requires_evidence_and_valid_fingerprints(self):
        for key in ('source_fields_sha256', 'pre_review_fields_sha256'):
            invalid = deepcopy(self.review)
            invalid[key] = 'invalid'
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'fingerprint'):
                normalize_reviewed_content(self.projected, invalid, self.original)
        with self.assertRaisesRegex(ValueError, 'source fields changed'):
            normalize_reviewed_content(self.projected, self.review)

    def test_malformed_reviewed_fields_are_rejected(self):
        for bad in ([], {'fields': 'text'}, {**self.review, 'fields': ['not a field']},
                    {**self.review, 'fields': [{'label': 'Service', 'value': 123}]}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'Invalid'):
                normalize_reviewed_content(self.projected, bad, self.original)

    def test_stable_json_fingerprint_is_independent_of_dict_key_order(self):
        self.assertEqual(review_fingerprint({'a': 1, 'b': 'Example'}),
                         review_fingerprint({'b': 'Example', 'a': 1}))
        self.assertNotEqual(review_fingerprint(['A', 'B']), review_fingerprint(['B', 'A']))


if __name__ == '__main__':
    unittest.main()
