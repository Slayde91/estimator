"""Portrait inspection PDFs place selected evidence beside the recorded details."""
from io import BytesIO
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader

from estimator.calculator_inspection_report import render_calculator_inspections
from estimator.company_settings import DEFAULTS
from test_calculator_register_report import entry, register


def positions(pdf):
    locations = {}
    for page_index, page in enumerate(pdf.pages):
        def visit(text, matrix, text_matrix, _font, _size):
            x, y = text_matrix[4:]
            final_x = x * matrix[0] + y * matrix[2] + matrix[4]
            final_y = x * matrix[1] + y * matrix[3] + matrix[5]
            if text.strip():
                locations.setdefault(text.strip(), []).append((page_index, final_x, final_y))

        page.extract_text(visitor_text=visit)
    return locations


class CalculatorInspectionLayoutTests(unittest.TestCase):
    def render(self, kind, item, details=None):
        content = render_calculator_inspections(register(kind, [item]), details or {}, kind, company=DEFAULTS)
        return PdfReader(BytesIO(content))

    def assert_once(self, coordinates, label):
        self.assertEqual(len(coordinates.get(label, [])), 1, label)
        return coordinates[label][0]

    def test_three_gauge_photos_are_beside_details_and_extras_are_below(self):
        item = entry('steel', 1)
        item['gauge'] *= 4
        item.update(inspection_date='2026-11-17', signature={'version': 1, 'ratio': 4, 'strokes': [[[0, 0], [1, 1]]]},
                    signature_details={'member_id': str(uuid4()), 'name': 'Inspection Signer', 'date': '2026-11-18'})
        pdf = self.render('steel', item, {'site_address': 'Inspection site'})
        coords = positions(pdf)
        _, detail_x, detail_y = self.assert_once(coords, 'Inspection ID')
        _, _, date_y = self.assert_once(coords, '17/11/2026')
        _, _, signer_date_y = self.assert_once(coords, '18/11/2026')
        signature_page, _, signature_y = self.assert_once(coords, 'Signature')
        self.assert_once(coords, 'Inspection Signer')
        self.assertGreater(detail_y, date_y)
        self.assertGreater(date_y, signer_date_y)
        for number in range(1, 4):
            page, x, y = self.assert_once(coords, f'Inspection 001 - Photo of Gauge ({number}/4)')
            self.assertEqual(page, 0)
            self.assertGreater(x, detail_x + 200)
            self.assertGreater(y, signature_y)
        for label in ('Photo of Gauge (4/4)', 'Before Photos', 'During Photos', 'After Photos'):
            page, _, y = self.assert_once(coords, f'Inspection 001 - {label}')
            self.assertGreater((page, -y), (signature_page, -signature_y))

    def test_no_gauge_or_plan_promotes_one_per_phase_and_shows_two_dates(self):
        item = entry('duct', 1)
        item['gauge'] = []
        item['inspection_date'] = '2026-11-17'
        for phase in ('before', 'during', 'after'):
            item[phase] *= 2
        with patch('estimator.calculator_inspection_report.register_download_date', return_value='20/11/2026'):
            pdf = self.render('duct', item, {'site_address': 'Inspection site'})
        coords = positions(pdf)
        _, _, site_y = self.assert_once(coords, 'Inspection site')
        _, _, export_y = self.assert_once(coords, '20/11/2026')
        _, detail_x, detail_y = self.assert_once(coords, 'Inspection ID')
        _, _, date_y = self.assert_once(coords, '17/11/2026')
        _, _, readings_y = self.assert_once(coords, 'Number of Readings')
        self.assertGreater(site_y, export_y)
        self.assertGreater(export_y, detail_y)
        self.assertGreater(detail_y, date_y)
        for phase in ('Before Photos', 'During Photos', 'After Photos'):
            page, x, y = self.assert_once(coords, f'Inspection 001 - {phase} (1/2)')
            self.assertEqual(page, 0)
            self.assertGreater(x, detail_x + 200)
            self.assertGreater(y, readings_y)
            page, _, y = self.assert_once(coords, f'Inspection 001 - {phase} (2/2)')
            self.assertGreater((page, -y), (0, -readings_y))
        self.assertNotIn('Signature', coords)
        self.assertNotIn('Inspection 001 - Photo of Gauge', coords)

    def test_long_details_continue_across_pages_before_remaining_evidence(self):
        item = entry('steel', 1)
        item['row']['location'] = ('Inspection floor area ' * 70) + 'Last recorded location'
        item['row']['report'] = ('Long supplementary field note ' * 42) + 'End of supplementary notes'
        pdf = self.render('steel', item)
        coords = positions(pdf)
        text = ' '.join(' '.join(page.extract_text() for page in pdf.pages).split())
        self.assertGreater(len(pdf.pages), 1)
        self.assertIn('Last recorded location', text)
        self.assertIn('End of supplementary notes', text)
        readings_page, _, readings_y = self.assert_once(coords, 'Number of Readings')
        photo_page, _, photo_y = self.assert_once(coords, 'Inspection 001 - Before Photos')
        self.assertGreater((photo_page, -photo_y), (readings_page, -readings_y))
