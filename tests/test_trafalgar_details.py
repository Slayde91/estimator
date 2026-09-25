import unittest

from scripts.trafalgar_details import (clean_instructions, installation_field,
                                      is_hidden_field, validate_installation_reviews)


class InstallationDetailsTests(unittest.TestCase):
    def document(self):
        return {'document_id': 'd-one', 'source_filename': 'Source.pdf', 'sha256': 'a' * 64,
                'pages': [{'page': 1, 'image_sha256': 'b' * 64}], 'fields': [],
                'installation_review': {1: {'kind': 'summary', 'text': 'Fit a seal around the pipe.'}}}

    def test_explicit_instructions_exclude_summary_application_and_raw_text(self):
        doc = self.document()
        doc['pages'][0]['text'] = 'Supplier footer and unrelated application text.'
        doc['fields'] = [
            {'label': 'Installation instructions (diagram page 1)', 'source_page': 1,
             'value': '1. Fit the collar.\n2. Seal the annular gap to\n20 mm depth.'},
            {'label': 'Application text extract', 'value': 'Do not repeat this.'}]
        self.assertEqual(installation_field([doc], 7), {
            'label': 'Installation Details',
            'value': '1. Fit the collar.\n2. Seal the annular gap to 20 mm depth.'})

    def test_any_instruction_page_prevents_callout_summary_on_other_pages(self):
        doc = self.document()
        doc['pages'].append({'page': 2, 'image_sha256': 'c' * 64})
        doc['installation_review'][2] = {'kind': 'instructions', 'text': '1. Fit the specified seal.'}
        result = installation_field([doc], 7)['value']
        self.assertEqual(result, 'Source page 2\n1. Fit the specified seal.')

    def test_repeated_instructions_keep_page_locators_without_repeating_steps(self):
        doc = self.document()
        doc['pages'].append({'page': 2, 'image_sha256': 'c' * 64})
        for page in (1, 2):
            doc['installation_review'][page] = {'kind': 'instructions', 'text': '1. Fit the seal.'}
        self.assertEqual(installation_field([doc, doc], 7)['value'].count('1. Fit the seal.'), 1)
        self.assertIn('source page 1, 2', installation_field([doc, doc], 7)['value'])

    def test_missing_summary_fails_instead_of_silently_omitting_source(self):
        doc = self.document()
        doc['installation_review'] = {}
        with self.assertRaisesRegex(ValueError, 'Missing reviewed installation summary'):
            installation_field([doc], 7)

    def test_empty_instruction_field_does_not_hide_reviewed_summary(self):
        doc = self.document()
        doc['fields'].append({'label': 'Installation instructions', 'value': '  '})
        self.assertEqual(installation_field([doc], 7)['value'], 'Fit a seal around the pipe.')

    def test_unscoped_and_other_product_instructions_do_not_escape_variant_scope(self):
        doc = self.document()
        doc['pages'].append({'page': 2, 'image_sha256': 'c' * 64})
        doc['installation_review'][2] = {'kind': 'not_provided', 'text': '', 'reason': 'Reference photo.'}
        doc['fields'] = [
            {'label': 'Installation instructions', 'source_page': 1, 'value': 'Unscoped other variant.'},
            {'label': 'Installation instructions', 'source_page': 2, 'value': 'Other product only.',
             'source_product_ids': [999]}]
        self.assertEqual(installation_field([doc], 7)['value'], 'Source page 1\nFit a seal around the pipe.')

    def test_precedence_applies_to_each_separate_linked_diagram(self):
        first = self.document()
        first['installation_review'][1] = {'kind': 'instructions', 'text': '1. Install the first component.'}
        second = self.document()
        second.update(sha256='c' * 64, source_filename='Second.pdf')
        result = installation_field([first, second], 7)['value']
        self.assertIn('Source.pdf — source page 1\n1. Install the first component.', result)
        self.assertIn('Second.pdf — source page 1\nFit a seal around the pipe.', result)

    def test_no_relevant_details_is_explicitly_reviewed_without_inventing_instructions(self):
        doc = self.document()
        doc['installation_review'][1] = {'kind': 'not_provided', 'text': '', 'reason': 'Product photo only.'}
        self.assertIsNone(installation_field([doc], 7))

    def test_numbering_dimensions_and_repeated_source_step_numbers_are_preserved(self):
        self.assertEqual(clean_instructions('1. Fix with M6 x 50 mm\nanchors.\n2.Seal 20 mm deep.\n2. Finish.'),
                         '1. Fix with M6 x 50 mm anchors.\n2.Seal 20 mm deep.\n2. Finish.')

    def test_review_requires_exact_source_page_and_image_identity(self):
        doc = self.document()
        page = {'page': 1, 'image_sha256': 'b' * 64, 'kind': 'summary', 'text': 'Fit the seal.'}
        row = {'document_id': 'D-ONE', 'source_sha256': 'a' * 64, 'pages': [page]}
        review = {'documents': [row]}
        self.assertEqual(validate_installation_reviews(review, {'d-one': doc}, 'capture')['d-one'][1], page)
        for key, bad, message in [('source_sha256', 'x', 'source fingerprint'),
                                  ('image_sha256', 'x', 'image fingerprint'),
                                  ('page', 2, 'unavailable source page')]:
            target = row if key == 'source_sha256' else page
            original = target[key]
            target[key] = bad
            with self.assertRaisesRegex(ValueError, message):
                validate_installation_reviews(review, {'d-one': doc}, 'capture')
            target[key] = original
        row['pages'].append(dict(page))
        with self.assertRaisesRegex(ValueError, 'Duplicate installation details page'):
            validate_installation_reviews(review, {'d-one': doc}, 'capture')

    def test_empty_summary_and_unbound_no_details_reason_are_rejected(self):
        doc = self.document()
        page = {'page': 1, 'image_sha256': 'b' * 64, 'kind': 'summary', 'text': ''}
        review = {'documents': [{'document_id': 'd-one', 'source_sha256': 'a' * 64, 'pages': [page]}]}
        with self.assertRaisesRegex(ValueError, 'empty instruction or summary'):
            validate_installation_reviews(review, {'d-one': doc}, 'capture')
        page['kind'] = 'not_provided'
        with self.assertRaisesRegex(ValueError, 'evidence reason'):
            validate_installation_reviews(review, {'d-one': doc}, 'capture')

    def test_removed_presentation_fields_are_recognized_with_source_suffixes(self):
        for label in ('T-card number (diagram page 1) (Source Reference)', 'Selector Search Context',
                      'Drawing identification / FRL (Source Reference)',
                      'Installation instructions (diagram page 1)', 'Application text extract',
                      'Source Diagram Details', 'Source Document Details — Page 2',
                      'Source Image Text — Page 1 (OCR; check diagram)'):
            self.assertTrue(is_hidden_field(label), label)
        self.assertFalse(is_hidden_field('Service Wrap'))


if __name__ == '__main__':
    unittest.main()
