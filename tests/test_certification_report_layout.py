"""Rendered geometry for full-width, label-above-value certificates."""
from io import BytesIO
import base64
import re
import unittest

import pdfplumber
from pypdf import PdfReader
from PIL import Image, ImageDraw

from estimator.certification import FIELDS
from estimator.certification_report import render_certificate_pdf
from estimator.company_settings import DEFAULTS


class CertificateLayoutTests(unittest.TestCase):
    def render(self, *, signature=None, **values):
        fields = {**dict.fromkeys(FIELDS, ''), **values}
        return render_certificate_pdf(fields, company={**DEFAULTS, 'name': 'Layout Company'},
            certificate_id='12345678-1234-4234-9234-123456789012', revision=2,
            created_at='2026-10-30T01:00:00+11:00', signature=signature)

    def test_identity_uses_four_cells_in_one_row_and_only_signer_headers_are_red(self):
        payload = self.render(client='ONLYCLIENT', project='ONLYPROJECT', address='ONLYADDRESS',
                              location_area='ONLYAREA', name='ONLYSIGNER', position='ONLYPOSITION',
                              qualification='ONLYQUALIFICATION', accreditation='ONLYACCREDITATION')
        with pdfplumber.open(BytesIO(payload)) as document:
            words = [word for page in document.pages for word in page.extract_words()]
            by_text = {word['text']: word for word in words}
            labels = [by_text[key] for key in ('Client', 'Project', 'Address', 'Location/Area')]
            values = [by_text[key] for key in ('ONLYCLIENT', 'ONLYPROJECT', 'ONLYADDRESS', 'ONLYAREA')]
            self.assertLess(max(word['top'] for word in labels)-min(word['top'] for word in labels), .1)
            self.assertLess(max(word['top'] for word in values)-min(word['top'] for word in values), .1)
            self.assertTrue(all(labels[index+1]['x0'] > labels[index]['x0']+100 for index in range(3)))
            red = [rect for page in document.pages for rect in page.rects
                   if isinstance(rect.get('non_stroking_color'), (tuple, list))
                   and len(rect['non_stroking_color']) == 3
                   and rect['non_stroking_color'][0] > .7
                   and rect['non_stroking_color'][1] < .05
                   and rect['non_stroking_color'][2] < .15]
            self.assertEqual(len(red), 1)
            for label in ('Name', 'Position', 'Qualification', 'Accreditation'):
                self.assertGreaterEqual(by_text[label]['top'], red[0]['top'])
                self.assertLessEqual(by_text[label]['bottom'], red[0]['bottom'])

    def test_signature_is_embedded_with_the_name_and_without_changing_other_fields(self):
        drawing = Image.new('RGBA', (360, 100), (255, 255, 255, 0))
        ImageDraw.Draw(drawing).line([(5, 70), (80, 20), (120, 80), (220, 35), (350, 60)], fill='black', width=4)
        artwork = BytesIO(); drawing.save(artwork, format='PNG')
        signature = 'data:image/png;base64,' + base64.b64encode(artwork.getvalue()).decode('ascii')
        values = {'name':'SIGNERART', 'position':'POSITIONART', 'qualification':'UNCHANGEDQUALIFICATION'}
        signed = self.render(signature=signature, **values)
        plain = self.render(**values)
        with pdfplumber.open(BytesIO(signed)) as signed_doc, pdfplumber.open(BytesIO(plain)) as plain_doc:
            self.assertEqual(len(signed_doc.pages), len(plain_doc.pages))
            self.assertEqual(''.join(page.extract_text() for page in signed_doc.pages),
                             ''.join(page.extract_text() for page in plain_doc.pages))
            signatures = [(page, image) for page in signed_doc.pages for image in page.images if image['srcsize'] == (360, 100)]
            self.assertEqual(len(signatures), 1)
            page, artwork = signatures[0]
            signer = next(word for word in page.extract_words() if word['text']=='SIGNERART')
            position = next(word for word in page.extract_words() if word['text']=='POSITIONART')
            self.assertGreater(artwork['top'], signer['bottom'])
            self.assertGreaterEqual(artwork['x0'], signer['x0']-.1)
            self.assertLess(artwork['x1'], position['x0'])

    def test_long_identity_cells_paginate_without_losing_text(self):
        payload = self.render(client='Client ZCLIENTTOKEN preserved. '*250,
                              address='Address ZADDRESSTOKEN preserved. '*250)
        pages = PdfReader(BytesIO(payload)).pages
        text = re.sub(r'\s+', ' ', '\n'.join(page.extract_text() for page in pages))
        self.assertGreater(len(pages), 1)
        # A split table continues each column on the next page; text extraction
        # reads the other columns between those fragments.
        self.assertEqual(len(re.findall(r'\bZCLIENTTOKEN\b', text)), 250)
        self.assertEqual(len(re.findall(r'\bZADDRESSTOKEN\b', text)), 250)
        self.assertEqual(text.count('preserved.'), 500)

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
