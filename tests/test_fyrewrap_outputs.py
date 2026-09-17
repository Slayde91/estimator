"""Directional application requirements remain visible in every export."""

from copy import deepcopy
from io import BytesIO
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.calculator_register import build_calculator_register
from estimator.calculator_report import (build_calculator_report,
    build_calculator_summary_report, project_calculator_report)
from estimator.schedule_rows import empty_schedule_inputs


def wrap_inputs():
    inputs = empty_schedule_inputs('ductwork')
    for row, exposure, floor in [(11, 'Both', 0), (12, 'Both', 0),
                                  (13, 'Stair pressurisation', 0), (14, 'Other pressurisation', 1),
                                  (15, 'External', 1)]:
        values = {'B': '250x250', 'C': 'FyreWrap', 'D': 10, 'E': '120/120/120',
                  'F': 0, 'G': floor, 'H': exposure, 'I': 'Both'}
        inputs['CALCULATOR'].update({f'{column}{row}': value for column, value in values.items()})
    return inputs


class FyreWrapOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = wrap_inputs()
        cls.data = project_calculator_report('ductwork', cls.inputs)

    def test_projection_deduplicates_exact_engine_notes_in_schedule_order(self):
        rows = self.data['rows']
        self.assertEqual([row['row'] for row in rows], [11, 12, 13, 14, 15])
        self.assertEqual(rows[0]['values']['AP'], rows[1]['values']['AP'])
        self.assertEqual(self.data['application_notes'], [rows[index]['values']['AP'] for index in (0, 2, 3, 4)])
        self.assertIn('internal 120/120/120; external 120/120/-', self.data['application_notes'][0])
        self.assertIn('external 120/120/60; internal not required', self.data['application_notes'][1])
        self.assertIn('Wrap total withheld: matching penetration detail required.', self.data['application_notes'][2])
        self.assertAlmostEqual(rows[0]['values']['N'], 16.7076, places=8)
        self.assertAlmostEqual(rows[2]['values']['N'], 37.0328, places=8)
        self.assertEqual(rows[3]['values']['N'], '')
        self.assertFalse(rows[3]['complete'])
        self.assertEqual(rows[3]['values']['J'], 'Wrap total needs a penetration detail')
        self.assertIn('external 120/120/-; internal not selected', self.data['application_notes'][3])
        self.assertIn('1 continuous layer(s)', self.data['application_notes'][3])
        self.assertAlmostEqual(rows[4]['values']['N'], 20.636, places=8)
        self.assertTrue(rows[4]['complete'])

    def test_both_pdf_types_disclose_directional_ratings_and_withheld_totals(self):
        before = deepcopy(self.data)
        for builder in (build_calculator_report, build_calculator_summary_report):
            with self.subTest(builder=builder.__name__), patch('estimator.calculator_report.project_calculator_report', return_value=self.data):
                payload = builder('ductwork', self.inputs)
                reader = PdfReader(BytesIO(payload))
                text = ' '.join(' '.join(page.extract_text().split()) for page in reader.pages)
                self.assertIn('FyreWrap application notes', text)
                for note in self.data['application_notes']:
                    self.assertEqual(text.count(' '.join(note.split())), 1)
                self.assertIn('internal 120/120/120; external 120/120/-', text)
                self.assertIn('external 120/120/60; internal not required', text)
                self.assertIn('external 120/120/-; internal not selected', text)
                self.assertNotIn('full selected FRL', text)
                self.assertIn('Wrap total withheld: matching penetration detail required.', text)
        self.assertEqual(self.data, before)

    def test_excel_summary_discloses_exact_notes_and_schedule_quantities_stay_separate(self):
        with patch('estimator.calculator_register.project_calculator_report', return_value=self.data):
            payload = build_calculator_register('ductwork', self.inputs)
        workbook = load_workbook(BytesIO(payload), data_only=False)
        try:
            summary = workbook['Summary']
            note_cells = [cell for row in summary for cell in row if cell.value in self.data['application_notes']]
            self.assertEqual([cell.value for cell in note_cells], self.data['application_notes'])
            self.assertTrue(all(cell.data_type == 's' and cell.alignment.wrap_text for cell in note_cells))
            text = ' '.join(str(cell.value) for row in summary for cell in row if cell.value is not None)
            self.assertIn('FyreWrap application notes', text)
            self.assertIn('internal 120/120/120; external 120/120/-', text)
            self.assertIn('external 120/120/60; internal not required', text)
            self.assertIn('external 120/120/-; internal not selected', text)
            self.assertNotIn('full selected FRL', text)
            self.assertIn('Wrap total withheld: matching penetration detail required.', text)
            schedule = workbook['Schedule']
            self.assertAlmostEqual(schedule['J6'].value, 16.7076, places=8)
            self.assertAlmostEqual(schedule['J8'].value, 37.0328, places=8)
            self.assertIsNone(schedule['J9'].value)
            self.assertAlmostEqual(schedule['J10'].value, 20.636, places=8)
            self.assertEqual(schedule['L9'].value, self.data['rows'][3]['values']['J'])
            self.assertNotIn('FyreWrap application notes', [cell.value for row in schedule for cell in row])
        finally:
            workbook.close()

    def test_spray_only_and_empty_schedules_do_not_gain_wrap_notes(self):
        inputs = empty_schedule_inputs('ductwork')
        self.assertEqual(project_calculator_report('ductwork', inputs)['application_notes'], [])
        inputs['CALCULATOR'].update({'B11': '250x250', 'C11': 'CAFCO 300', 'D11': 10,
                                    'E11': '120/120/120', 'F11': 0, 'G11': 0, 'H11': 'External', 'I11': 'Horizontal'})
        self.assertEqual(project_calculator_report('ductwork', inputs)['application_notes'], [])


if __name__ == '__main__':
    unittest.main()
