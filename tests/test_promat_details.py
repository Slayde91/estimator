from copy import deepcopy
import unittest

from estimator.library_report_links import validate_report_links, valid_report_url
from estimator.promat_service_text import clean_service_size
from estimator.reference_library import field_text
from estimator.technical_field_reviewed import review_fingerprint
from scripts.review_promat_details import apply_reviews, evidence
from tests.test_promat_wrap_review import PromatWrapReviewTests


class PromatDetailsTests(unittest.TestCase):
    def fixture(self):
        bundle, _ = PromatWrapReviewTests().fixture()
        item = bundle['libraries']['technical']['items'][0]
        item['technical_field_review']['wrap_reviews'] = [{'reason': 'Keep prior decision'}]
        return bundle, {'id': item['id'], 'expected_sha256': review_fingerprint(evidence(item)),
                        'variant_ids': item['promat_source']['variant_ids'], 'diagram_sha256': [],
                        'installation_details': 'Fit the sample collar using the stated fixings.',
                        'report': {'label': 'EXAMPLE123', 'url': 'https://media.promat.com/example.pdf'}}

    def test_details_preserve_source_table_pairs_and_previous_reviews(self):
        bundle, decision = self.fixture()
        before = deepcopy(bundle)
        item = apply_reviews(bundle, [decision])['libraries']['technical']['items'][0]
        original = before['libraries']['technical']['items'][0]
        self.assertEqual(bundle, before)
        self.assertEqual(item['fields'], original['fields'])
        self.assertEqual(item['promat_source'], original['promat_source'])
        review = item['technical_field_review']
        self.assertEqual(review['wrap_reviews'], original['technical_field_review']['wrap_reviews'])
        for field in review['fields']:
            prior = next(f for f in original['technical_field_review']['fields'] if f['label'] == field['label'])
            if field['label'] not in {'Installation Details', 'Report Number'}:
                self.assertEqual(field, prior)
        report = next(f for f in review['fields'] if f['label'] == 'Report Number')
        field_text([report], {})
        self.assertEqual(report['report_links'], [decision['report']])

    def test_stale_partial_wrong_diagrams_and_duplicate_reviews_fail(self):
        for change in ('expected_sha256', 'variant_ids', 'diagram_sha256'):
            bundle, decision = self.fixture()
            decision[change] = 'bad' if change == 'expected_sha256' else ['wrong']
            with self.assertRaises(ValueError):
                apply_reviews(bundle, [decision])
        bundle, decision = self.fixture()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            apply_reviews(bundle, [decision, decision])

    def test_report_link_validation_rejects_active_or_mismatched_content(self):
        good = {'label': 'Report Number', 'value': 'EXAMPLE123', 'report_links': [
            {'label': 'EXAMPLE123', 'url': 'https://media.promat.com/example.pdf?brand=sample'}]}
        validate_report_links(good)
        for url in ('javascript:alert(1)', 'http://media.promat.com/a.pdf', '//media.promat.com/a.pdf',
                    'https://media.promat.com.evil.test/a.pdf', 'https://x@media.promat.com/a.pdf',
                    'https://media.promat.com:443/a.pdf', 'https://media.promat.com/a.html',
                    'https://media.promat.com/a.pdf\n', 'https://media.promat.com\\evil/a.pdf'):
            self.assertFalse(valid_report_url(url), url)
            bad = deepcopy(good); bad['report_links'][0]['url'] = url
            with self.assertRaises(ValueError): validate_report_links(bad)
        for key, value in (('label', 'Installation Details'), ('value', 'OTHER')):
            bad = {**good, key: value}
            with self.assertRaises(ValueError): validate_report_links(bad)

    def test_repeated_cable_quantity_cleanup_is_narrow(self):
        value = '1.5mm2, 2C, Alarm / Fire cable. Up to 21\n\nø Up to 21 cables, Wall - Horizontal\n\nExisting insulation: None'
        expected = '1.5mm2, 2C, Alarm / Fire cable. ø Up to 21 cables, Wall - Horizontal, Existing insulation: None'
        self.assertEqual(clean_service_size(value), expected)
        self.assertEqual(clean_service_size(expected), expected)
        different = value.replace('ø Up to 21', 'ø Up to 24')
        self.assertEqual(clean_service_size(different), different)
        self.assertEqual(clean_service_size('Up to 21\nSeparate condition\nø Up to 21 cables'), 'Up to 21\nSeparate condition\nø Up to 21 cables')
