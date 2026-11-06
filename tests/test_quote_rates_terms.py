"""Commercial rates round-trip independently of totals; terms retain wording."""
from copy import deepcopy
from html import unescape
from io import BytesIO
from pathlib import Path
import re
import tempfile
import unittest
import uuid

import pdfplumber
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_documents import (CommercialDocuments, default_fields,
                                            validate_fields)
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from tests.test_commercial_documents import Projects


class QuoteRatesTermsTests(unittest.TestCase):
    def test_legacy_fields_and_custom_rates_round_trip_without_changing_terms(self):
        legacy = default_fields('quote')
        del legacy['rate_schedule']
        fields = validate_fields(legacy)
        self.assertEqual(fields['rate_schedule']['rates']['ordinary_time'], '130')
        fields['rate_schedule']['rates'].update(ordinary_time='147.25', equipment='17.5')
        fields['rate_schedule']['acceptance'].update(accepted_by='Example person', date='2026-11-07')
        fields['terms'] = '<p>My <i>custom</i> terms remain <b>exactly</b> as entered.</p>'
        before = deepcopy(fields)
        with tempfile.TemporaryDirectory() as temporary:
            projects = Projects(temporary)
            workspace = projects.add()
            service = CommercialDocuments(projects)
            saved = service.save(workspace, {'id': str(uuid.uuid4()), 'version': 0,
                'kind': 'quote', 'status': 'Draft', 'fields': fields})
            snapshot = service.capture(workspace)
            restored = projects.add(projects.project_id(workspace))
            service.restore(restored, snapshot)
            self.assertEqual(service.view(restored)['documents'][0]['fields'], before)
            pdf = render_commercial_pdf(saved, 'Q-000001', company=DEFAULTS)
        text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(pdf)).pages)
        for expected in ('$147.25', 'Hire Rate + 17.5%', 'Example person', '2026-11-07', 'custom'):
            self.assertIn(expected, text)
        self.assertLess(text.index('SCHEDULE OF RATES'), text.index('SCOPE OF WORKS'))
        self.assertIn('Accepted by', text)
        self.assertIn('Signature', text)
        with pdfplumber.open(BytesIO(pdf)) as document:
            italic = [char for page in document.pages for char in page.chars if 'Italic' in char['fontname']]
            self.assertEqual(''.join(char['text'] for char in italic), 'custom')

    def test_invalid_rates_cannot_reach_an_export(self):
        for amount in ('NaN', '-1', True, '1000000001', '0.1234567'):
            fields = default_fields('quote')
            fields['rate_schedule']['rates']['materials'] = amount
            with self.subTest(amount=amount), self.assertRaises(ValidationError):
                validate_fields(fields)

    def test_terms_use_reference_columns_and_typeface_without_losing_words(self):
        fields = default_fields('quote')
        payload = render_commercial_pdf({'kind': 'quote', 'fields': fields}, 'Q-000002', company=DEFAULTS)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            terms_pages = [page for page in pdf.pages if any('Montserrat' in char['fontname'] for char in page.chars)]
            self.assertGreater(len(terms_pages), 2)
            first = terms_pages[0]
            body = [char for char in first.chars if 'Montserrat' in char['fontname']]
            self.assertTrue(all(abs(char['size'] - 9) < .01 for char in body))
            self.assertTrue(any(char['x0'] < 100 for char in body))
            self.assertTrue(any(char['x0'] > 303 for char in body))
            self.assertTrue(any('Bold' in char['fontname'] and isinstance(char['non_stroking_color'], tuple)
                                and all(abs(actual - target) < .00001 for actual, target in zip(char['non_stroking_color'], (244 / 255, 119 / 255, 33 / 255))) for char in body))
            self.assertTrue(all(39 < char['x0'] < char['x1'] < 556 for page in terms_pages
                                for char in page.chars if 'Montserrat' in char['fontname']))
        # Compare word order using the PDF content stream: visual extraction
        # would interleave adjacent columns. Hanging labels remain in the text.
        reader = PdfReader(BytesIO(payload))
        actual = '\n'.join(page.extract_text() for page in reader.pages if 'TERMS OF TRADE' in page.extract_text() or any('Montserrat' in str(font.get_object().get('/BaseFont', '')) for font in page['/Resources'].get('/Font', {}).values()))
        expected = unescape(re.sub('<[^>]+>', ' ', fields['terms']))
        normal = lambda value: re.sub(r'\s+', '', value).replace('\u2022', '')
        actual = re.sub(r'Quote Q-000002\s*\|\s*Page \d+ of \d+', '', actual)
        self.assertEqual(normal(actual).strip('-'), normal(expected).replace('TERMSOFTRADE', '-TERMSOFTRADE-', 1).strip('-'))


if __name__ == '__main__':
    unittest.main()
