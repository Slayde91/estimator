"""Quotation layout uses one horizontal schedule and one page-number sequence."""
from copy import deepcopy
from io import BytesIO
import re
import unittest
from unittest.mock import patch

import pdfplumber
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4

from estimator.calculator_report import build_calculator_report
from estimator.commercial_documents import default_fields
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from estimator.penetration_calculator import calculate, definition
from estimator.penetration_report import render_penetration_pdf
from estimator.project_reports import build_project_report
from estimator.schedule_rows import blank_schedule_defaults
from tests.test_quote_schedule_layout import (calculators, fire_draft, references,
                                               HEADERS, FIRE_HEADERS, REFERENCE)
from tests.test_penetration_item_exports import DiagramLibrary, png


def compact(value):
    return ' '.join(value.split())


def brand_red(value):
    return isinstance(value, tuple) and len(value) == 3 and all(
        abs(actual - expected) < .000001 for actual, expected in zip(value, (189 / 255, 0, 24 / 255)))


class QuotePdfRefinementTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch('estimator.calculator_report.schedule_report_references', return_value=[REFERENCE]))
        self.enterContext(patch('estimator.penetration_report.resolve_schedule_references', side_effect=references))

    def quote(self, scopes=()):
        fields = default_fields('quote', {'project_no': 'QUOTE-TEST', 'client': 'Example client',
                                          'site_address': '1 Example Road'}, DEFAULTS)
        fields['lines'] = [{'estimate_id': 'estimate-1', 'description': 'Quoted work', 'quantity': '2',
                            'unit_price': '123.45', 'size': '', 'comments': ''}]
        fields['allowances'] = '<p>Normal access allowed.</p>'
        fields['terms'] = '<p><b>1. Terms</b></p><p>Agreed test terms.</p>'
        return render_commercial_pdf({'kind': 'quote', 'fields': fields}, 'Q-000123',
                                     company=DEFAULTS, scope_documents=list(scopes))

    def test_first_page_has_centered_quotation_header_bold_fields_and_totals_after_summary(self):
        payload = self.quote()
        with pdfplumber.open(BytesIO(payload)) as pdf:
            page = pdf.pages[0]
            words = page.extract_words()
            heading = next(word for word in words if word['text'] == 'QUOTATION')
            self.assertAlmostEqual((heading['x0'] + heading['x1']) / 2, A4[0] / 2, delta=1)
            self.assertLess(heading['top'], 70)
            text = page.extract_text()
            self.assertNotIn('\nQUOTE\n', text)
            self.assertNotIn('Field Details', text)
            self.assertLess(text.index('Total Price'), text.index('Subtotal'))
            all_text = '\n'.join(item.extract_text() for item in pdf.pages)
            self.assertLess(all_text.index('Grand total'), all_text.index('SCHEDULE OF RATES'))
            self.assertLess(all_text.index('SCHEDULE OF RATES'), all_text.index('SCOPE OF WORKS'))
            for label in ('Document', 'Date', 'Customer', 'Contact', 'Site', 'Project', 'Subtotal', 'GST', 'Grand'):
                word = next(word for word in words if word['text'] == label)
                chars = page.crop((word['x0'] - .1, word['top'] - .1, word['x1'] + .1, word['bottom'] + .1)).chars
                self.assertTrue(chars and all('Bold' in char['fontname'] for char in chars), label)
                self.assertTrue(all(char['non_stroking_color'] == (1, 1, 1) for char in chars), label)
                self.assertTrue(any(brand_red(rect['non_stroking_color']) and
                                    rect['x0'] < word['x0'] < word['x1'] < rect['x1'] and
                                    rect['top'] < word['top'] < word['bottom'] < rect['bottom']
                                    for rect in page.rects), label)
            # The quote's grids and section rules use the same brand red.
            rates_heading = next(word for word in words if word['text'] == 'RATES')
            table_lines = [line for line in page.lines if 85 < line['top'] < rates_heading['top']]
            self.assertTrue(table_lines)
            self.assertTrue(all(brand_red(line['stroking_color']) for line in table_lines))
            red_rects = [rect for rect in page.rects if isinstance(rect['non_stroking_color'], tuple)
                         and len(rect['non_stroking_color']) == 3
                         and all(abs(actual - expected) < .000001 for actual, expected in
                                 zip(rect['non_stroking_color'], (189 / 255, 0, 24 / 255)))]
            self.assertTrue(red_rects)
            header = next(word for word in words if word['text'] == 'Product')
            chars = page.crop((header['x0'] - .1, header['top'] - .1, header['x1'] + .1, header['bottom'] + .1)).chars
            self.assertTrue(all(char['non_stroking_color'] == (1, 1, 1) for char in chars))

    def test_main_sections_have_red_rules_and_acceptance_grid_matches(self):
        with pdfplumber.open(BytesIO(self.quote())) as pdf:
            for heading in ('SUMMARY', 'RATES', 'SCOPE', 'ALLOWANCES'):
                page, word = next((page, word) for page in pdf.pages for word in page.extract_words()
                                  if word['text'] == heading)
                self.assertTrue(any(brand_red(line['stroking_color']) and line['width'] > 500
                                    and word['bottom'] < line['top'] < word['bottom'] + 25
                                    for line in page.lines), heading)
            acceptance_page = next(page for page in pdf.pages if 'Accepted by' in page.extract_text())
            lines = [line for line in acceptance_page.lines if line['top'] > 85]
            self.assertTrue(lines and all(brand_red(line['stroking_color']) for line in lines))

    def test_all_schedule_columns_are_on_one_portrait_page_width_without_bands(self):
        for identity, value in calculators().items():
            with self.subTest(calculator=identity):
                before = deepcopy(value)
                payload = build_calculator_report(identity, value['inputs'], portrait=True, quote_scope=True)
                reader = PdfReader(BytesIO(payload))
                self.assertEqual(len(reader.pages), 1)
                page = reader.pages[0]
                self.assertAlmostEqual(float(page.mediabox.width), A4[0], places=3)
                content = compact(page.extract_text())
                for header in HEADERS[identity]:
                    self.assertIn(header, content)
                self.assertNotIn('Full schedule', content)
                self.assertNotIn('used schedule items', content)
                self.assertNotIn('Project details', content)
                self.assertNotRegex(content, r'Page \d+')
                self.assertEqual(value, before)
                with pdfplumber.open(BytesIO(payload)) as pdf:
                    body = [char for char in pdf.pages[0].chars if 90 < char['top'] < 790]
                    self.assertTrue(all(char['x0'] >= 31.5 and char['x1'] <= A4[0] - 31.5 for char in body))
                    self.assertTrue(all(char['size'] >= 6.79 for char in body))
                    lines = [line for line in pdf.pages[0].lines if line['top'] > 90]
                    self.assertTrue(lines and all(brand_red(line['stroking_color']) for line in lines))

    def test_firestopping_full_width_table_retains_diagram_and_report_link(self):
        library = DiagramLibrary(png())
        payload = render_penetration_pdf(calculate(fire_draft()), definition(), {},
                                         library=library, portrait=True, quote_scope=True)
        reader = PdfReader(BytesIO(payload))
        self.assertEqual(len(reader.pages), 1)
        content = compact(reader.pages[0].extract_text())
        for header in FIRE_HEADERS:
            self.assertIn(header, content)
        self.assertNotRegex(content, r'Page \d+')
        self.assertTrue(any(image.image.size == (320, 160) for image in reader.pages[0].images))
        links = [item.get_object().get('/A', {}).get('/URI') for item in reader.pages[0].get('/Annots', [])]
        self.assertIn(REFERENCE['url'], links)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            lines = [line for line in pdf.pages[0].lines if line['top'] > 90]
            self.assertTrue(lines and all(brand_red(line['stroking_color']) for line in lines))

    def test_assembled_quote_has_only_one_continuous_page_sequence_and_one_title(self):
        scope = build_project_report(calculators(), fire_draft(), {}, {'project_no': 'REPEATED-PROJECT'},
                                     company=DEFAULTS, library=DiagramLibrary(png()), portrait=True, quote_scope=True)
        reader = PdfReader(BytesIO(self.quote([scope])))
        combined = '\n'.join(page.extract_text() for page in reader.pages)
        self.assertEqual(combined.count('QUOTATION'), 1)
        self.assertNotIn('REPEATED-PROJECT', combined)
        self.assertNotIn('Fire Protection Schedule', combined)
        self.assertNotIn('used schedule items', combined)
        for index, page in enumerate(reader.pages, 1):
            numbers = re.findall(r'Page \d+(?: of \d+)?', page.extract_text())
            self.assertEqual(numbers, [f'Page {index} of {len(reader.pages)}'])

    def test_scope_heading_and_first_schedule_share_a_page(self):
        for values, fire in (({'steel_board': calculators()['steel_board']}, None), ({}, fire_draft())):
            with self.subTest(first_schedule='board' if values else 'firestopping'):
                scope = build_project_report(values, fire, {}, {}, company=DEFAULTS,
                    portrait=True, quote_scope=True, scope_intro={'name': 'Selected estimate', 'heading': True})
                reader = PdfReader(BytesIO(self.quote([scope])))
                scope_pages = [page.extract_text() for page in reader.pages if 'SCOPE OF WORKS' in page.extract_text()]
                self.assertEqual(len(scope_pages), 1)
                content = compact(scope_pages[0])
                self.assertIn('Selected estimate', content)
                self.assertIn('Line', content)
                self.assertIn('Report', content)
                self.assertIn('Board fixture' if values else 'Plastic Pipes', content)
                for removed in ('Calculation Notes', 'Status / estimating basis', 'used schedule items.',
                                'incomplete or unavailable primary quantities'):
                    self.assertNotIn(removed, content)

    def test_board_rows_paginate_vertically_with_every_column_repeated(self):
        inputs = {}
        for index in range(24):
            row = index + 9
            inputs.update({f'A{row}': f'UniqueMember{index:02}', f'B{row}': 'Level 2', f'C{row}': 'PROMATECT-XS',
                           f'D{row}': '200UC46', f'F{row}': 10, f'G{row}': 4, f'H{row}': 120,
                           f'I{row}': 'Column', f'J{row}': 550})
        payload = build_calculator_report('steel_board', blank_schedule_defaults('steel_board', {'CALCULATOR': inputs}),
                                          portrait=True, quote_scope=True)
        reader = PdfReader(BytesIO(payload))
        self.assertGreater(len(reader.pages), 1)
        combined = compact('\n'.join(page.extract_text() for page in reader.pages))
        for index in range(24):
            self.assertEqual(combined.replace(' ', '').count(f'UniqueMember{index:02}'), 1)
        for page in reader.pages:
            content = compact(page.extract_text())
            for header in HEADERS['steel_board']:
                self.assertIn(header, content)


if __name__ == '__main__':
    unittest.main()
