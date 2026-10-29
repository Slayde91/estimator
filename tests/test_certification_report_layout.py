"""Rendered geometry for full-width, label-above-value certificates."""
from io import BytesIO
import unittest

import pdfplumber
from pypdf import PdfReader

from estimator.certification import FIELDS
from estimator.certification_report import render_certificate_pdf
from estimator.company_settings import DEFAULTS


class CertificateLayoutTests(unittest.TestCase):
    def render(self, **values):
        fields = {**dict.fromkeys(FIELDS, ''), **values}
        return render_certificate_pdf(fields, company={**DEFAULTS, 'name': 'Layout Company'},
            certificate_id='12345678-1234-4234-9234-123456789012', revision=2,
            created_at='2026-10-30T01:00:00+11:00')

    def test_labels_are_above_values_and_long_text_uses_full_width(self):
        payload = self.render(client='UNIQUECLIENT', project='UNIQUEPROJECT',
            australian_standards='STANDARDVALUE ' + 'A complete readable sentence uses the certificate width. '*8,
            ncc_clauses='CLAUSEVALUE', name='UNIQUESIGNER', position='UNIQUEPOSITION')
        with pdfplumber.open(BytesIO(payload)) as document:
            words = [word for page in document.pages for word in page.extract_words()]
            by_text = {word['text']: word for word in words}
            for label, value in [('Client', 'UNIQUECLIENT'), ('Project', 'UNIQUEPROJECT'),
                                 ('Name', 'UNIQUESIGNER'), ('Position', 'UNIQUEPOSITION')]:
                self.assertLess(by_text[label]['bottom'], by_text[value]['top'])
                self.assertAlmostEqual(by_text[label]['x0'], by_text[value]['x0'], delta=1)
            first = by_text['STANDARDVALUE']
            self.assertLess(first['x0'], 50)
            line = [word for word in words if abs(word['top']-first['top'])<1]
            self.assertGreater(max(word['x1'] for word in line), 500)
            for page in document.pages:
                self.assertTrue(all(30 <= word['x0'] < word['x1'] <= page.width-30
                                    for word in page.extract_words()))

    def test_long_values_paginate_without_losing_text_or_company_header(self):
        payload = self.render(approved_design='Design condition remains explicit. '*650,
                              qualification='Qualification retained. '*200)
        pages = PdfReader(BytesIO(payload)).pages
        combined = '\n'.join(page.extract_text() for page in pages)
        self.assertGreater(len(pages), 2)
        self.assertEqual(combined.count('explicit.'), 650)
        self.assertEqual(combined.count('retained.'), 200)
        for number, page in enumerate(pages, 1):
            text = page.extract_text()
            self.assertIn('Layout Company', text)
            self.assertIn(f'Page {number}', text)


if __name__ == '__main__':
    unittest.main()
