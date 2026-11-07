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
from estimator.company_settings import DEFAULTS, contact_lines
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
            starts = [index for index, page in enumerate(pdf.pages) if '-TERMS OF TRADE-' in page.extract_text()]
            self.assertEqual(len(starts), 1)
            self.assertGreater(starts[0], 0)
            terms_pages = pdf.pages[starts[0]:]
            self.assertGreater(len(terms_pages), 2)
            # Company headers and page numbers now use the same font as the
            # clauses. Isolate the area between the header rule and footer.
            bodies = [[char for char in page.chars if char['top'] > 78 and char['bottom'] < page.height - 32]
                      for page in terms_pages]
            self.assertTrue(all(bodies))
            body = [char for page_chars in bodies for char in page_chars]
            self.assertTrue(all('Montserrat' in char['fontname'] for char in body))
            self.assertTrue(all(abs(char['size'] - 9) < .01 for char in body))
            self.assertTrue(any(char['x0'] < 100 for char in bodies[0]))
            self.assertTrue(any(char['x0'] > 303 for char in bodies[0]))
            self.assertTrue(any('Bold' in char['fontname'] and isinstance(char['non_stroking_color'], tuple)
                                and all(abs(actual - target) < .00001 for actual, target in zip(char['non_stroking_color'], (189 / 255, 0, 24 / 255))) for char in bodies[0]))
            self.assertTrue(all(39 < char['x0'] < char['x1'] < 556 and char['top'] > 90 for char in body))
            for page in terms_pages:
                header = page.crop((0, 0, page.width, 80))
                for value in [DEFAULTS['name'], *contact_lines(DEFAULTS)]:
                    self.assertIn(value, header.extract_text())
                self.assertEqual(len(header.images), 1)
                self.assertAlmostEqual(header.images[0]['x0'], 36)
                self.assertAlmostEqual(header.images[0]['top'], 22)
                self.assertTrue(any(abs(line['top'] - 78) < .001 and line['width'] > 500 for line in header.lines))
                self.assertNotIn('QUOTATION', header.extract_text())
            # Read characters in content-stream order to keep each column's
            # clauses and hanging labels together. Every word must be in body.
            actual = ''.join(char['text'] for char in body)
        expected = unescape(re.sub('<[^>]+>', ' ', fields['terms']))
        normal = lambda value: re.sub(r'\s+', '', value).replace('\u2022', '')
        self.assertEqual(normal(actual).strip('-'), normal(expected).replace('TERMSOFTRADE', '-TERMSOFTRADE-', 1).strip('-'))


if __name__ == '__main__':
    unittest.main()
