"""Opening Terms emphasis is presentation only; saved wording remains authoritative."""
from copy import deepcopy
from html import unescape
from html.parser import HTMLParser
from io import BytesIO
import re
import unittest

from pypdf import PdfReader

from estimator.commercial_documents import default_fields, default_terms, format_terms, validate_fields
from estimator.commercial_pdf import _terms_pdf
from estimator.company_settings import DEFAULTS


def plain(value):
    return unescape(re.sub(r'<[^>]+>', '', value))


def opening(terms):
    return next(paragraph for paragraph in re.findall(r'<p>(.*?)</p>', terms)
                if plain(paragraph).startswith('These terms and conditions are between '))


class Emphasis(HTMLParser):
    def __init__(self):
        super().__init__()
        self.bold = 0
        self.values = []

    def handle_starttag(self, tag, attrs):
        if tag in {'b', 'strong'}:
            self.bold += 1

    def handle_endtag(self, tag):
        if tag in {'b', 'strong'}:
            self.bold -= 1

    def handle_data(self, text):
        if text.strip():
            self.values.append((text, self.bold > 0))


class CommercialTermsTests(unittest.TestCase):
    def setUp(self):
        self.company = {**DEFAULTS, 'name': 'Example & Sons Pty Ltd', 'abn': '12 345 678 901'}
        self.default = default_terms(self.company)
        self.opening = plain(opening(self.default))

    def test_new_default_opening_is_entirely_bold_with_unchanged_wording(self):
        rendered = opening(self.default)
        self.assertEqual(rendered, '<b>' + self.opening.replace('&', '&amp;') + '</b>')
        self.assertEqual(format_terms(self.default), self.default)
        self.assertIn('Our Disclosures:', self.default)

    def test_older_plain_opening_and_inline_authored_emphasis_are_preserved(self):
        original = '<p>' + self.opening.replace('&', '&amp;').replace('Goods and Services', '<i>Goods</i> and <u>Services</u>') + '</p>'
        original += '<p>My <i>custom</i> paragraph remains <strong>as entered</strong>.</p>'
        formatted = format_terms(original)
        self.assertEqual(plain(formatted), plain(original))
        self.assertIn('<i><b>Goods</b></i>', formatted)
        self.assertIn('<u><b>Services</b></u>', formatted)
        self.assertTrue(formatted.endswith('<p>My <i>custom</i> paragraph remains <strong>as entered</strong>.</p>'))
        emphasis = Emphasis()
        emphasis.feed(opening(formatted))
        self.assertTrue(emphasis.values)
        self.assertTrue(all(bold for _, bold in emphasis.values))
        self.assertEqual(format_terms(formatted), formatted)

    def test_custom_or_incomplete_openings_are_not_forced_bold(self):
        for text in (self.opening.replace('entire agreement', 'different agreement'),
                     self.opening + ' A manually added sentence.',
                     'These terms and conditions are between custom parties.',
                     self.opening.removesuffix('(Terms).')):
            with self.subTest(text=text):
                source = '<p>' + text.replace('&', '&amp;') + '</p>'
                self.assertEqual(format_terms(source), source)

    def test_company_names_containing_clause_like_text_never_duplicate_words(self):
        terms = default_terms({**self.company, 'name': 'Example (1) Pty Ltd'})
        body = plain(opening(terms))
        self.assertEqual(body.count('Example (1) Pty Ltd'), 1)
        self.assertEqual(plain(format_terms('<p>' + body + '</p>')), body)
        self.assertEqual(format_terms(terms), terms)

    def test_validating_or_rendering_a_saved_draft_does_not_rewrite_its_terms(self):
        fields = default_fields('quote', company=self.company)
        fields['terms'] = '<p>' + self.opening.replace('&', '&amp;') + '</p><p>Manual clause.</p>'
        before = deepcopy(fields)
        self.assertEqual(validate_fields(fields)['terms'], before['terms'])
        _terms_pdf(fields['terms'], {'kind': 'quote', 'fields': fields}, 'Q-01', self.company)
        self.assertEqual(fields, before)

    def test_pdf_bolds_entire_older_default_opening_and_keeps_other_text_regular(self):
        source = '<p>' + self.opening.replace('&', '&amp;') + '</p><p>Regular custom paragraph marker.</p>'
        data = _terms_pdf(source, {'kind': 'quote', 'fields': {}}, 'Q-01', self.company)
        spans = []
        for page in PdfReader(BytesIO(data)).pages:
            page.extract_text(visitor_text=lambda text, cm, tm, font, size:
                spans.append((text, str((font or {}).get('/BaseFont', '')))))
        active = False
        opening_spans = []
        for text, font in spans:
            if 'These terms and conditions are between' in text:
                active = True
            if active and text.strip():
                opening_spans.append((text, font))
            if active and '(Terms).' in text:
                break
        self.assertTrue(opening_spans)
        self.assertIn('(Terms).', ''.join(text for text, _ in opening_spans))
        self.assertTrue(all('Bold' in font for _, font in opening_spans), opening_spans)
        self.assertTrue(any('Regular custom paragraph marker.' in text and 'Regular' in font for text, font in spans))


if __name__ == '__main__':
    unittest.main()
