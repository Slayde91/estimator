from copy import deepcopy
import unittest

from scripts.trafalgar_details import (clean_instructions, installation_field, installation_input_sha256,
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

    def instruction_pages(self, *texts):
        doc = self.document()
        doc['pages'] = [{'page': number} for number in range(1, len(texts) + 1)]
        doc['installation_review'] = {
            number: {'kind': 'instructions', 'text': text} for number, text in enumerate(texts, 1)}
        return doc

    def test_pdf_layout_and_number_marker_spacing_do_not_repeat_five_step_list(self):
        first = ('1. Cut the board to fit the aperture.\n'
                 '2. Wrap two strips around the beam, secure with staples.\n'
                 '3. Coat the faces and seal the edges.\n'
                 '4. Install both boards into the wall.\n'
                 '5. Apply a 5 x 5mm fillet of mastic.')
        second = first.replace('beam, secure', 'beam,secure').replace('4. Install', '4.Install')
        second = second.replace('two strips around', 'two strips\naround')
        result = installation_field([self.instruction_pages(first, second)], 7)['value']
        self.assertEqual(result, 'Source page 1, 2\n' + first)

    def test_parenthesized_numbering_is_the_same_step_marker(self):
        doc = self.instruction_pages('1. Fit the seal.\n2. Seal the gap.',
                                     '1) Fit the seal.\n2)Seal the gap.')
        self.assertEqual(installation_field([doc], 7)['value'],
                         'Source page 1, 2\n1. Fit the seal.\n2. Seal the gap.')

    def test_partial_repeated_steps_keep_all_new_steps_and_each_page_locator(self):
        doc = self.instruction_pages('1. Fit the seal.\n2. Seal the gap.',
                                     '1.Fit the seal.\n2.Seal the gap.\n3. Inspect the finish.',
                                     '3. Inspect the finish.\n4. Record the installation.')
        self.assertEqual(installation_field([doc], 7)['value'],
                         'Source page 1, 2\n1. Fit the seal.\n2. Seal the gap.\n\n'
                         'Source page 2, 3\n3. Inspect the finish.\n\n'
                         'Source page 3\n4. Record the installation.')

    def test_partial_dedup_never_merges_different_numbered_variants(self):
        for first, second in [('Fit 1.5 mm board.', 'Fit 15 mm board.'),
                              ('Seal 10-20 mm deep.', 'Seal 1020 mm deep.'),
                              ('Do not coat the face.', 'Do coat the face.'),
                              ('Seal the upper face.', 'Seal the lower face.'),
                              ('Fit Material A.', 'Fit Material B.'),
                              ('Fix with M6 x 50 mm anchors.', 'Fix with M8 x 50 mm anchors.'),
                              ('Provide 50 mm overlap.', 'Provide 50 cm overlap.')]:
            with self.subTest(first=first, second=second):
                doc = self.instruction_pages('1. Prepare the opening.\n2. ' + first,
                                             '1. Prepare the opening.\n2. ' + second)
                result = installation_field([doc], 7)['value']
                self.assertIn(first, result)
                self.assertIn(second, result)
                self.assertEqual(result.count('1. Prepare the opening.'), 2)
                self.assertIn('Source page 1\n', result)
                self.assertIn('Source page 2\n', result)

    def test_full_repeated_list_can_join_separate_prior_partial_pages(self):
        doc = self.instruction_pages('1. Fit the seal.', '2. Seal the gap.',
                                     '1. Fit the seal.\n2. Seal the gap.')
        self.assertEqual(installation_field([doc], 7)['value'],
                         'Source page 1, 3\n1. Fit the seal.\n\n'
                         'Source page 2, 3\n2. Seal the gap.')

    def test_common_partial_page_cannot_join_conflicting_variants_transitively(self):
        doc = self.instruction_pages('1. Fit the seal.\n2. Seal 30 mm deep.',
                                     '1. Fit the seal.\n2. Seal 60 mm deep.', '1. Fit the seal.')
        result = installation_field([doc], 7)['value']
        self.assertIn('2. Seal 30 mm deep.', result)
        self.assertIn('2. Seal 60 mm deep.', result)
        self.assertNotIn('Source page 1, 2, 3', result)

    def test_partial_dedup_requires_an_unambiguous_numbered_list_without_headings(self):
        for first, second in [('Horizontal:\n1. Fit the seal.', 'Vertical:\n1. Fit the seal.'),
                              ('1. Fit the seal.\n1. Coat the board.',
                               '1. Fit the seal.\n2. Coat the board.'),
                              ('1. Fit the seal. 2. Coat the board.',
                               '1. Fit the seal.\n2. Coat the board.')]:
            with self.subTest(first=first):
                doc = self.instruction_pages(first, second)
                result = installation_field([doc], 7)['value']
                # A completely identical token sequence may merge, but ambiguous
                # lists must not have individual steps split or reordered.
                self.assertIn(clean_instructions(first), result)

    def test_different_punctuation_tokens_are_not_fuzzily_discarded(self):
        doc = self.instruction_pages('Use seal A / seal B.', 'Use seal A + seal B.')
        result = installation_field([doc], 7)['value']
        self.assertIn('Use seal A / seal B.', result)
        self.assertIn('Use seal A + seal B.', result)

    def reviewed_display_document(self):
        doc = self.instruction_pages('1. Fit the board.\n2. Seal the full 60 mm depth.',
                                     '1. Fit the board.\n2. Seal the full depth of the board.')
        for page in doc['pages']:
            page['image_sha256'] = str(page['page']) * 64
        doc['installation_display_review'] = {
            'source_sha256': doc['sha256'], 'input_sha256': installation_input_sha256(doc, 7),
            'pages': deepcopy(doc['pages']),
            'reason': 'Source images reviewed: common step retained once; depth variants remain separate.',
            'passages': [{'pages': [1, 2], 'text': '1. Fit the board.'},
                         {'pages': [1], 'text': '2. Seal the full 60 mm depth.'},
                         {'pages': [2], 'text': '2. Seal the full depth of the board.'}]}
        return doc

    def test_source_bound_review_merges_common_steps_but_retains_explicit_variants(self):
        doc = self.reviewed_display_document()
        original = deepcopy(doc['installation_review'])
        result = installation_field([doc], 7)['value']
        self.assertEqual(result, 'Source page 1, 2\n1. Fit the board.\n\n'
                         'Source page 1\n2. Seal the full 60 mm depth.\n\n'
                         'Source page 2\n2. Seal the full depth of the board.')
        self.assertEqual(doc['installation_review'], original)

    def test_display_review_requires_current_source_inputs_and_images(self):
        for changed, message in [('source', 'source fingerprint'), ('image', 'image fingerprint'),
                                 ('input', 'input fingerprint'), ('format', 'input fingerprint')]:
            with self.subTest(changed=changed):
                doc = self.reviewed_display_document()
                if changed == 'source':
                    doc['sha256'] = 'x' * 64
                elif changed == 'image':
                    doc['pages'][1]['image_sha256'] = 'x' * 64
                elif changed == 'input':
                    doc['installation_review'][1]['text'] = '1. Fit a different board.'
                else:
                    doc['installation_review'][1]['text'] += '\n'
                with self.assertRaisesRegex(ValueError, message):
                    installation_field([doc], 7)

    def test_display_review_cannot_hide_page_or_point_to_an_unrelated_page(self):
        for changed in ('bindings', 'passages', 'unrelated', 'duplicate', 'reason', 'empty', 'unbound'):
            with self.subTest(changed=changed):
                doc = self.reviewed_display_document()
                review = doc['installation_display_review']
                if changed == 'bindings':
                    review['pages'].pop()
                elif changed == 'passages':
                    review['passages'] = [{'pages': [1], 'text': 'Only one page.'}]
                elif changed == 'unrelated':
                    review['passages'][0]['pages'].append(3)
                elif changed == 'duplicate':
                    review['pages'].append(deepcopy(review['pages'][0]))
                elif changed == 'reason':
                    review['reason'] = ' '
                elif changed == 'empty':
                    review['passages'] = []
                else:
                    review['pages'][0]['image_sha256'] = ''
                    doc['pages'][0]['image_sha256'] = ''
                with self.assertRaises(ValueError):
                    installation_field([doc], 7)

    def test_display_review_for_one_product_does_not_override_another_product(self):
        doc = self.document()
        doc['fields'] = [
            {'label': 'Installation instructions', 'source_page': 1, 'value': '1. Fit type A.',
             'source_product_ids': [7]},
            {'label': 'Installation instructions', 'source_page': 1, 'value': '1. Fit type B.',
             'source_product_ids': [8]}]
        doc['installation_display_review'] = {
            'source_sha256': doc['sha256'], 'input_sha256': installation_input_sha256(doc, 7),
            'pages': deepcopy(doc['pages']), 'passages': [{'pages': [1], 'text': '1. Fit type A.'}],
            'reason': 'Source reviewed for type A.'}
        self.assertEqual(installation_field([doc], 7)['value'], '1. Fit type A.')
        with self.assertRaisesRegex(ValueError, 'input fingerprint'):
            installation_field([doc], 8)

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
                         '1. Fix with M6 x 50 mm anchors.\n2. Seal 20 mm deep.\n2. Finish.')

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
                      'Document Revision', 'DOCUMENT REVISION (Source Reference)',
                      'Document revision (diagram page 2) (Source Reference)',
                      'Installation instructions (diagram page 1)', 'Application text extract',
                      'Source Diagram Details', 'Source Document Details — Page 2',
                      'Source Image Text — Page 1 (OCR; check diagram)'):
            self.assertTrue(is_hidden_field(label), label)
        self.assertFalse(is_hidden_field('Service Wrap'))
        self.assertFalse(is_hidden_field('Report Number'))


if __name__ == '__main__':
    unittest.main()
