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
    def render(self, *, signature=None, created_at='2026-10-30T01:00:00+11:00', **values):
        fields = {**dict.fromkeys(FIELDS, ''), **values}
        return render_certificate_pdf(fields, company={**DEFAULTS, 'name': 'Layout Company'},
            certificate_id='12345678-1234-4234-9234-123456789012', revision=2,
            created_at=created_at, signature=signature)

    def test_identity_uses_four_cells_in_one_row_and_signer_table_stays_red(self):
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

    def test_requested_titles_are_bold_red_and_small_duplicate_header_is_removed(self):
        payload = self.render(client='BODYCLIENT', australian_standards='BODYSTANDARD', name='BODYSIGNER')
        with pdfplumber.open(BytesIO(payload)) as document:
            words = [word for page in document.pages
                     for word in page.extract_words(extra_attrs=['fontname', 'non_stroking_color'])]
            by_text = {word['text']: word for word in words}
            for label in ('Installation', 'Statement', 'Client', 'Project', 'Address', 'Location/Area',
                          'Exclusions', 'Materials/Manufacturers:', 'Date:'):
                word = by_text[label]
                if label in ('Installation', 'Statement', 'Client', 'Project', 'Address', 'Location/Area'):
                    self.assertIn('Bold', word['fontname'])
                else:
                    self.assertNotIn('Bold', word['fontname'])
                self.assertAlmostEqual(word['non_stroking_color'][0], 189/255, delta=.001)
                self.assertEqual(word['non_stroking_color'][1], 0)
            for label in ('Name', 'Position', 'Qualification', 'Accreditation'):
                self.assertEqual(tuple(by_text[label]['non_stroking_color']), (1, 1, 1))
                self.assertNotIn('Bold', by_text[label]['fontname'])
            for value in ('BODYCLIENT', 'BODYSTANDARD', 'BODYSIGNER'):
                self.assertEqual(tuple(by_text[value]['non_stroking_color']), (0, 0, 0))
                self.assertNotIn('Bold', by_text[value]['fontname'])
            text = '\n'.join(page.extract_text() for page in document.pages)
            self.assertNotIn('INSTALLATION CERTIFICATE', text)
            self.assertIn('Installation Certificate', text)
            self.assertIn('Exclusions - Certification is strictly limited to works completed by Layout Company, as per:', text)

    def test_compliance_and_attestation_are_entirely_bold_black(self):
        statement = 'COMPLIANCESTART Manufacturer requirements remain explicit. COMPLIANCEEND'
        payload = self.render(statement_of_compliance=statement)
        with pdfplumber.open(BytesIO(payload)) as document:
            lines = [line for page in document.pages for line in page.extract_text_lines()]
            compliance = next(line for line in lines if 'COMPLIANCESTART' in line['text'])
            start = next(index for index, line in enumerate(lines) if 'are approved by the manufacturers' in line['text'])
            end = next(index for index in range(start, len(lines)) if 'best of my knowledge.' in lines[index]['text'])
            for line in [compliance, *lines[start:end+1]]:
                for char in line['chars']:
                    self.assertIn('Bold', char['fontname'])
                    self.assertEqual(tuple(char['non_stroking_color']), (0, 0, 0))

    def test_signer_date_is_frozen_in_sydney_and_footer_remains_utc(self):
        cases = [('2026-10-29T13:30:00Z', '30 October 2026', '29 Oct 2026, 13:30 UTC'),
                 ('2026-06-29T14:30:00Z', '30 June 2026', '29 Jun 2026, 14:30 UTC'),
                 ('2026-10-30T01:00:00+11:00', '30 October 2026', '29 Oct 2026, 14:00 UTC')]
        for created_at, expected_date, expected_utc in cases:
            with self.subTest(created_at=created_at):
                payload = self.render(name='FROZENSIGNER', created_at=created_at)
                with pdfplumber.open(BytesIO(payload)) as document:
                    text = '\n'.join(page.extract_text() for page in document.pages)
                    self.assertIn(expected_date, text)
                    self.assertIn(expected_utc, text)
                    signer_page = next(page for page in document.pages if 'FROZENSIGNER' in page.extract_text())
                    words = {word['text']: word for word in signer_page.extract_words()}
                    self.assertGreater(words['Date:']['top'], words['FROZENSIGNER']['bottom'])

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

    def test_complete_multiline_signed_certificate_keeps_name_signature_and_date_on_one_page(self):
        drawing = Image.new('RGBA', (480, 140), (255, 255, 255, 0))
        ImageDraw.Draw(drawing).line([(12, 104), (50, 27), (70, 108), (105, 43), (460, 43)], fill='black', width=3)
        artwork = BytesIO(); drawing.save(artwork, format='PNG')
        signature = 'data:image/png;base64,' + base64.b64encode(artwork.getvalue()).decode('ascii')
        values = dict.fromkeys(FIELDS, 'N/A')
        values.update(client='Example Client', project='Demonstration project',
            address='123 Example Street, Sydney NSW', location_area='Ground floor - example only',
            statement_of_compliance="This is to certify that the fire rated materials have been installed according to the manufacturer's specifications to provide the nominated fire resistance level for the items listed in the relevant schedule. All materials have been installed at the above location and comply with:",
            australian_standards='AS 1530.4: 2014 Methods for fire tests on building materials, components & structures\nAS 4072.1: 2005 Protection of openings in fire-resistant separating elements',
            ncc_clauses='BCA 2022: Specification 13, Penetration of walls, floors and ceilings by services\nBCA 2022: C4D13 Openings in floors and ceilings for services\nBCA 2022: C4D15 Openings for service installations\nBCA 2022: C4D16 Construction joints',
            exclusions='Project No.: PREVIEW-001', materials_manufacturers='Example manufacturer',
            fire_resistance_level='-/120/120', name='EXAMPLESIGNER', position='Installer',
            qualification='Example qualification', accreditation='Example accreditation')
        payload = self.render(signature=signature, **values)
        with pdfplumber.open(BytesIO(payload)) as document:
            self.assertEqual(len(document.pages), 1)
            page = document.pages[0]
            words = {word['text']: word for word in page.extract_words()}
            image = next(image for image in page.images if image['srcsize'] == (480, 140))
            self.assertGreater(image['top'], words['EXAMPLESIGNER']['bottom'])
            self.assertGreater(words['Date:']['top'], image['bottom'])
            self.assertLess(words['Date:']['bottom'], page.height - 44)

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
