"""Public schedule geometry stays readable with long identity fields."""
from copy import deepcopy
from io import BytesIO
import re
import unittest

import pdfplumber
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4

from estimator.calculator_report import build_calculator_report
from estimator.project_reports import build_project_report
from tests.test_quote_schedule_layout import calculators, fire_draft


def steel_rows(identity, count=32):
    """Use real products and editable cells, with the long marks seen in use."""
    value = calculators()[identity]
    sheet_name, start = ('CALCULATOR', 9) if identity == 'steel_board' else ('SCHEDULE', 10)
    sheet = value['inputs'][sheet_name]
    template = {match[1]: cell for key, cell in list(sheet.items())
                if (match := re.fullmatch(r'([A-Z]+)(\d+)', key)) and int(match[2]) == start}
    for index in range(count):
        row = start + index
        sheet.update({f'{column}{row}': cell for column, cell in template.items()})
        sheet[f'A{row}'] = f'DUMMY-VERMICULITE-{index + 1:04}'
        sheet[f'{"B" if identity == "steel_board" else "AA"}{row}'] = f'DUMMY - Level {index + 1:02} / Grid A1'
    return value


def cell_bounds(page, heading):
    word = next(word for word in page.extract_words() if word['text'] == heading)
    middle = (word['x0'] + word['x1']) / 2
    borders = sorted({round(edge['x0'], 4) for edge in page.edges
                      if abs(edge['x1'] - edge['x0']) < .01
                      and edge['top'] <= word['top'] and edge['bottom'] >= word['bottom']})
    left = max(value for value in borders if value < middle)
    right = min(value for value in borders if value > middle)
    return left, right


def cell_width(page, heading):
    left, right = cell_bounds(page, heading)
    return right - left


class SchedulePdfPresentationTests(unittest.TestCase):
    def test_long_marks_wrap_in_equal_identity_columns_and_product_keeps_more_room(self):
        for identity in ('steel_vermiculite', 'steel_board', 'steel_intumescent'):
            with self.subTest(calculator=identity):
                value = steel_rows(identity)
                before = deepcopy(value)
                payload = build_calculator_report(identity, value['inputs'], project_details={'project_no': 'PN-PRESENTATION'})
                reader = PdfReader(BytesIO(payload))
                self.assertGreater(len(reader.pages), 1)
                with pdfplumber.open(BytesIO(payload)) as pdf:
                    schedule_pages = [page for page in pdf.pages if any(word['text'] == 'Location' for word in page.extract_words())]
                    self.assertTrue(schedule_pages)
                    marks = []
                    for page in schedule_pages:
                        self.assertAlmostEqual(page.width, A4[0], places=3)
                        location, item, product = (cell_width(page, heading) for heading in ('Location', 'Item', 'Product'))
                        self.assertAlmostEqual(location, item, delta=.01)
                        self.assertGreater(product, location)
                        left, right = cell_bounds(page, 'Item')
                        item_heading = next(word for word in page.extract_words() if word['text'] == 'Item')
                        header_bottom = min(rect['bottom'] for rect in page.rects if rect['width'] > 500
                                            and rect['top'] < item_heading['top'] < item_heading['bottom'] < rect['bottom'])
                        marks.append(''.join(page.crop((left + .01, header_bottom + .01, right - .01,
                                                       page.height - 43)).extract_text().split()))
                        # Long unbroken marks remain readable inside their own
                        # cell, without shrinking the shared 6.8-point font.
                        body = [char for char in page.chars if 90 < char['top'] < 790]
                        self.assertTrue(all(char['x0'] >= 31.5 and char['x1'] <= A4[0] - 31.5 for char in body))
                        self.assertTrue(all(char['size'] >= 6.79 for char in body))
                    # Reading one identity column across pages also covers a
                    # long row split between pages without mixing other cells
                    # or repeated headers into its identifier.
                    for index in range(32):
                        self.assertIn(f'DUMMY-VERMICULITE-{index + 1:04}', ''.join(marks))
                self.assertEqual(value, before)

    def test_full_schedule_title_is_uppercase_brand_red_for_either_first_section(self):
        for values, fire in (({'steel_vermiculite': steel_rows('steel_vermiculite', 1)}, None), ({}, fire_draft())):
            with self.subTest(first_section='steel' if values else 'firestopping'):
                payload = build_project_report(values, fire, {}, {})
                reader = PdfReader(BytesIO(payload))
                self.assertEqual(reader.metadata.title, 'FIRE PROTECTION SCHEDULE')
                with pdfplumber.open(BytesIO(payload)) as pdf:
                    page = pdf.pages[0]
                    words = page.extract_words()
                    title = [next(word for word in words if word['text'] == text and word['top'] > 90)
                             for text in ('FIRE', 'PROTECTION', 'SCHEDULE')]
                    for word in title:
                        chars = page.crop((word['x0'] - .1, word['top'] - .1, word['x1'] + .1, word['bottom'] + .1)).chars
                        self.assertTrue(chars and all('Bold' in char['fontname'] for char in chars))
                        self.assertTrue(all(all(abs(channel - expected) < .000001 for channel, expected in
                                                zip(char['non_stroking_color'], (189 / 255, 0, 24 / 255))) for char in chars))


if __name__ == '__main__':
    unittest.main()
