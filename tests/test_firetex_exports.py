"""Mixed-product exports retain source and product identity with held quantities."""
from io import BytesIO
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.calculator_report import project_calculator_report, build_calculator_report, build_calculator_summary_report
from estimator.calculator_register import build_calculator_register
from estimator.firetex_assessment import Assessment, PRODUCTS


def mixed_inputs():
    values = {'SCHEDULE': {}, 'SETTINGS': {}}
    for row, name in enumerate(PRODUCTS, 10):
        values['SCHEDULE'].update({f'B{row}': name, f'C{row}': 'I/H beam - 3 sides',
            f'D{row}': 550, f'E{row}': 'A/V', f'G{row}': 100, f'H{row}': 60,
            f'L{row}': 10, f'AA{row}': 'Level ' + str(row)})
    return values


class FiretexExportTests(unittest.TestCase):
    def setUp(self):
        snapshots = tuple(Assessment(name, str(index) * 64, str(index + 2) * 64)
                          for index, name in enumerate(PRODUCTS, 1))
        self.patchers = [patch('estimator.firetex_assessment.load_assessments', return_value=snapshots),
                         patch('estimator.firetex_assessment.lookup', return_value={
                             'dft': 1000, 'factor': 100, 'status': 'PUBLISHED',
                             'source': 'Synthetic certificate p2 Table 1', 'note': 'Invented 1000 µm test cell.'})]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_projection_keeps_separate_orders_and_source_receipts(self):
        data = project_calculator_report('steel_intumescent', mixed_inputs())
        self.assertEqual([row['values']['B'] for row in data['rows']], list(PRODUCTS))
        self.assertEqual([item['product'] for item in data['assessment_evidences']], list(PRODUCTS))
        pools = {row['values']['A']: row['values'] for row in data['summaries'][0]['rows']}
        self.assertEqual(pools[PRODUCTS[0]]['G'], 1)
        self.assertEqual(pools[PRODUCTS[1]]['G'], '')
        self.assertIn('INCOMPLETE', pools[PRODUCTS[1]]['I'])
        self.assertEqual(data['incomplete_rows'], 1)
        self.assertEqual(data['title'], 'Steel (intumescent)')

    def test_pdf_and_xlsx_keep_product_names_and_held_status_without_saving(self):
        values = mixed_inputs()
        for builder in (build_calculator_report, build_calculator_summary_report):
            payload = builder('steel_intumescent', values)
            text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)
            for name in PRODUCTS:
                self.assertIn(name, text)
            self.assertIn('INCOMPLETE' if builder == build_calculator_summary_report else 'DFT', text)
            self.assertIn('dataset SHA-256', text)
        workbook = load_workbook(BytesIO(build_calculator_register('steel_intumescent', values)))
        text = '\n'.join(str(cell.value) for sheet in workbook for row in sheet for cell in row if cell.value is not None)
        for name in PRODUCTS:
            self.assertIn(name, text)
        self.assertIn('INCOMPLETE', text)
        self.assertIn('Compatibility SHA-256', text)


if __name__ == '__main__':
    unittest.main()
