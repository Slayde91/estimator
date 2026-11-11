"""PO table branding and first-page heading are verified from rendered PDF geometry."""
from copy import deepcopy
from io import BytesIO
import unittest

import pdfplumber
from reportlab.lib.pagesizes import A4

from tests.test_purchase_order_signatures_pdf import purchase_order_fields, render


def red(value):
    return isinstance(value, (tuple, list)) and len(value) == 3 and all(
        abs(actual - expected) < .000001
        for actual, expected in zip(value, (189 / 255, 0, 24 / 255)))


def in_red_cell(page, word):
    return any(red(rect['non_stroking_color'])
               and rect['x0'] < word['x0'] < word['x1'] < rect['x1']
               and rect['top'] < word['top'] < word['bottom'] < rect['bottom']
               for rect in page.rects)


def multipage_fields():
    fields = purchase_order_fields(rejected=True)
    line = fields['lines'][0]
    fields['lines'] = [{**line, 'description': f'ITEM{index:03} Synthetic purchased service',
                       'comments': 'Synthetic delivery instructions retained with the requested item.',
                       'size': 'QA size'} for index in range(30)]
    fields['order']['verification'] = ' '.join(f'CHECK{index:03} specification retained.' for index in range(120))
    return fields


class PurchaseOrderPdfFormattingTests(unittest.TestCase):
    def assert_heading(self, pdf):
        for number, page in enumerate(pdf.pages):
            words = [word for word in page.extract_words(extra_attrs=['non_stroking_color'])
                     if word['top'] < 70 and word['text'] in {'PURCHASE', 'ORDER'}]
            if number:
                self.assertEqual(words, [], 'The centered document heading appears only on the first page')
            else:
                self.assertEqual([word['text'] for word in words], ['PURCHASE', 'ORDER'])
                self.assertAlmostEqual((words[0]['x0'] + words[-1]['x1']) / 2, A4[0] / 2, delta=.1)
                self.assertTrue(all(red(word['non_stroking_color']) for word in words))

    def test_key_value_labels_are_red_white_without_generic_headers_and_real_headers_remain(self):
        fields = purchase_order_fields(rejected=True)
        before = deepcopy(fields)
        with pdfplumber.open(BytesIO(render(fields))) as pdf:
            self.assertEqual(fields, before)
            self.assert_heading(pdf)
            text = '\n'.join(page.extract_text() for page in pdf.pages)
            self.assertNotIn('Field Details', text)
            for label in ('Subtotal', 'GST (10%)', 'Grand total', 'Rejection reason', 'Verification method,'):
                self.assertIn(label, text)
            tokens = {'Supplier', 'Contact', 'Subtotal', 'GST', 'Grand', 'Approval', 'Rejection', 'Verification'}
            found = set()
            signer_headers = {'Requested', 'Approved', 'Sent', 'Verified', 'Name'}
            seen_headers = set()
            for page in pdf.pages:
                self.assertTrue(page.lines)
                self.assertTrue(all(red(line['stroking_color']) for line in page.lines))
                for word in page.extract_words(extra_attrs=['non_stroking_color']):
                    if word['top'] <= 90:
                        continue
                    if word['text'] in tokens and word['x0'] < 161:
                        found.add(word['text'])
                        self.assertTrue(in_red_cell(page, word), word['text'])
                        self.assertEqual(tuple(word['non_stroking_color']), (1, 1, 1))
                    if word['text'] in signer_headers:
                        seen_headers.add(word['text'])
                        self.assertTrue(in_red_cell(page, word), word['text'])
                        self.assertEqual(tuple(word['non_stroking_color']), (1, 1, 1))
            self.assertEqual(found, tokens)
            self.assertEqual(seen_headers, signer_headers)

    def test_multipage_summary_repeats_real_red_headers_without_losing_items_or_verification(self):
        fields = multipage_fields()
        with pdfplumber.open(BytesIO(render(fields))) as pdf:
            self.assertGreaterEqual(len(pdf.pages), 3)
            self.assert_heading(pdf)
            text = '\n'.join(page.extract_text() for page in pdf.pages)
            self.assertNotIn('Field Details', text)
            for index in range(30):
                self.assertEqual(text.count(f'ITEM{index:03}'), 1)
            for index in range(120):
                self.assertEqual(text.count(f'CHECK{index:03}'), 1)
            summary_pages = [page for page in pdf.pages if 'ITEM0' in page.extract_text()]
            self.assertGreater(len(summary_pages), 1)
            for page in summary_pages:
                headers = [word for word in page.extract_words(extra_attrs=['non_stroking_color'])
                           if word['text'] in {'Item', 'Quantity', 'Size', 'Comments', 'Unit', 'price'}]
                self.assertEqual({word['text'] for word in headers}, {'Item', 'Quantity', 'Size', 'Comments', 'Unit', 'price'})
                self.assertTrue(all(in_red_cell(page, word) for word in headers))
                self.assertTrue(all(tuple(word['non_stroking_color']) == (1, 1, 1) for word in headers))
            for page in pdf.pages:
                self.assertTrue(all(red(line['stroking_color']) for line in page.lines))
                for char in page.chars:
                    if 90 < char['top'] < 805:
                        self.assertGreaterEqual(char['x0'], 35.9)
                        self.assertLessEqual(char['x1'], A4[0] - 35.9)


if __name__ == '__main__':
    unittest.main()
