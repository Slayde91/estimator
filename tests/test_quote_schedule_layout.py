"""Quote scopes reuse public schedule columns and remain readable in portrait."""
from copy import deepcopy
from io import BytesIO
import unittest
from unittest.mock import patch

from pypdf import PdfReader
from reportlab.lib.pagesizes import A4

from estimator.calculator_report import (build_calculator_report, calculator_schedule_table,
                                         project_calculator_report)
from estimator.commercial_estimates import _scope_tables
from estimator.penetration_calculator import calculate, definition
from estimator.penetration_report import penetration_schedule_table, render_penetration_pdf
from estimator.project_reports import build_project_report
from estimator.schedule_rows import blank_schedule_defaults
from tests.test_penetration_item_exports import DiagramLibrary, png
from tests.test_penetration_labour_exports import draft


REFERENCE = {'label': 'Verified report <A> & B', 'url': 'https://media.promat.com/verified-report.pdf'}
HEADERS = {
    'steel_vermiculite': ['Line', 'Location', 'Item / mark', 'Product', 'Section', 'Quantity',
                         'Length (m)', 'Thickness (mm)', 'Report'],
    'steel_board': ['Line', 'Item / mark', 'Location', 'Product', 'Section', 'Design min / °C',
                    'Board stack mm', 'Total thickness mm', 'Box ref. m²', 'Net board m²',
                    'With waste m²', 'Sheets / line', 'Report'],
    'ductwork': ['Line', 'Product / duct mm', 'Length m × qty', 'FRL', 'Thickness mm',
                'Duct m²', 'Net spray bags', 'Wrap m²', 'Roll eq.', 'Report'],
    'steel_intumescent': ['Line', 'Location', 'Item / mark', 'Product / member case',
                          'Period (min)', 'Critical °C', 'DFT (µm)', 'Area (m²)', 'Report'],
}
FIRE_HEADERS = ['Line', 'Diagram', 'Service', 'Quantity', 'FRL', 'Service size',
                'Orientation', 'Substrate', 'Report']


def calculators():
    values = {
        'steel_vermiculite': {'inputs': {'SCHEDULE': {
            'A10': 'Spray <member> & fixture', 'AA10': 'Level 1', 'B10': 'CAFCO 300',
            'C10': 'Re-entrant - 3 sides', 'D10': 620, 'E10': 'Section', 'F10': '410UB54',
            'H10': 120, 'I10': 2, 'J10': 3}}},
        'steel_board': {'inputs': {'CALCULATOR': {
            'A9': 'Board fixture', 'B9': 'Level 2', 'C9': 'PROMATECT-XS', 'D9': '200UC46',
            'F9': 10, 'G9': 4, 'H9': 120, 'I9': 'Column', 'J9': 550}}},
        'ductwork': {'inputs': {'CALCULATOR': {
            'B11': '250x250', 'C11': 'CAFCO 300', 'D11': 10, 'E11': '120/120/120',
            'F11': 1, 'G11': 0, 'H11': 'External', 'I11': 'Horizontal'}}},
        'steel_intumescent': {'inputs': {'SCHEDULE': {
            'A10': 'Paint fixture', 'AA10': 'Level 3', 'B10': 'Nullifire SC902',
            'C10': 'I/H beam - 3 sides', 'D10': 550, 'E10': 'A/V', 'G10': 200,
            'H10': 120, 'I10': 2, 'J10': 3, 'K10': .4}}},
    }
    return {identity: {'inputs': blank_schedule_defaults(identity, value['inputs'])}
            for identity, value in values.items()}


def fire_draft():
    value = draft(K='Plastic Pipes', N='-/120/120', M='Horizontal', P='Concrete', AW=110)
    value['rows'][0]['library_item_id'] = 'fixture-source'
    return value


def references(value, library=None):
    return {'row_references': {row['id']: {'reports': [REFERENCE]} for row in value['rows']}}


def text(reader):
    return ' '.join('\n'.join(page.extract_text() for page in reader.pages).split())


class QuoteScheduleLayoutTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch('estimator.calculator_report.schedule_report_references', return_value=[REFERENCE]))
        self.enterContext(patch('estimator.penetration_report.resolve_schedule_references', side_effect=references))

    def assert_portrait(self, reader):
        self.assertTrue(reader.pages)
        for page in reader.pages:
            self.assertAlmostEqual(float(page.mediabox.width), A4[0], places=3)
            self.assertAlmostEqual(float(page.mediabox.height), A4[1], places=3)
            body = []
            page.extract_text(visitor_text=lambda value, cm, tm, font, size: body.append(value)
                              if 43 < tm[4] * cm[1] + tm[5] * cm[3] + cm[5] < A4[1] - 90 else None)
            self.assertTrue(''.join(body).strip(), 'Every page contains schedule content')

    def assert_values(self, table, reader):
        content = text(reader)
        for heading in table['headers']:
            self.assertIn(heading, content)
        for row in table['rows']:
            for cell in row:
                for line in cell.splitlines():
                    if line and line != 'Included in PDF':
                        self.assertIn(' '.join(line.split()), content)
        links = [item.get_object().get('/A', {}).get('/URI')
                 for page in reader.pages for item in page.get('/Annots', [])]
        if any(REFERENCE['label'] in cell for row in table['rows'] for cell in row):
            self.assertIn(REFERENCE['url'], links)

    def test_all_calculator_scope_columns_values_and_portrait_bands_match_canonical_exports(self):
        for identity, value in calculators().items():
            with self.subTest(calculator=identity):
                before = deepcopy(value)
                data = project_calculator_report(identity, value['inputs'])
                data_before = deepcopy(data)
                table = calculator_schedule_table(data)
                self.assertEqual(table['headers'], HEADERS[identity])
                self.assertEqual(len(table['rows']), 1)
                self.assertEqual(data, data_before)
                portrait = PdfReader(BytesIO(build_calculator_report(identity, value['inputs'], portrait=True)))
                self.assert_portrait(portrait)
                self.assert_values(table, portrait)
                standalone = PdfReader(BytesIO(build_calculator_report(identity, value['inputs'])))
                self.assertTrue(all(float(page.mediabox.width) > float(page.mediabox.height)
                                    for page in standalone.pages))
                self.assert_values(table, standalone)
                if data['rows'][0]['result_unavailable']:
                    self.assertEqual(table['rows'][0][-1], 'N / A')
                    self.assertFalse(any(annotation.get_object().get('/A', {}).get('/URI')
                                         for page in standalone.pages for annotation in page.get('/Annots', [])))
                self.assertEqual(value, before)

    def test_firestopping_scope_preserves_diagram_references_and_every_visible_column(self):
        source = fire_draft()
        result = calculate(source)
        before = deepcopy(result)
        library = DiagramLibrary(png())
        table = penetration_schedule_table(result, definition(), library=library)
        self.assertEqual(table['headers'], FIRE_HEADERS)
        self.assertEqual(table['rows'][0][1], 'Included in PDF')
        for portrait in (False, True):
            reader = PdfReader(BytesIO(render_penetration_pdf(result, definition(), {}, library=library, portrait=portrait)))
            if portrait:
                self.assert_portrait(reader)
            else:
                self.assertGreater(float(reader.pages[0].mediabox.width), float(reader.pages[0].mediabox.height))
            self.assert_values(table, reader)
            images = [image for page in reader.pages for image in page.images]
            self.assertTrue(any(image.image.size == (320, 160) for image in images))
        self.assertEqual(result, before)

    def test_missing_diagram_still_exports_retained_schedule_and_reports(self):
        result = calculate(fire_draft())
        library = DiagramLibrary()
        table = penetration_schedule_table(result, definition(), library=library)
        self.assertEqual(table['rows'][0][1], '')
        reader = PdfReader(BytesIO(render_penetration_pdf(result, definition(), {}, library=library, portrait=True)))
        self.assert_portrait(reader)
        self.assert_values(table, reader)

    def test_combined_quote_scope_uses_only_canonical_columns_for_all_five_schedules(self):
        values = calculators()
        source = fire_draft()
        library = DiagramLibrary(png())
        project = {'calculators': values, 'penetration': {'draft': source}, 'estimate': {'configuration': {}}}
        before = deepcopy(project)
        tables = _scope_tables(project, 'Quoted work', library)
        self.assertEqual([table['headers'] for table in tables], [*HEADERS.values(), FIRE_HEADERS])
        reader = PdfReader(BytesIO(build_project_report(values, source, {}, {'project_no': 'QUOTE-1'},
                                                       library=library, portrait=True)))
        self.assert_portrait(reader)
        self.assertEqual(len(reader.outline), 5)
        for table in tables:
            self.assert_values(table, reader)
        self.assertEqual(project, before)

    def test_long_captured_values_split_without_losing_text_or_creating_blank_pages(self):
        words = [f'Token{index:03}' for index in range(160)]
        marker = '<Long member> & ' + ' '.join(words)
        reader = PdfReader(BytesIO(build_calculator_report('steel_board',
            blank_schedule_defaults('steel_board', {'CALCULATOR': {'A9': marker}}), portrait=True)))
        self.assert_portrait(reader)
        content = text(reader)
        self.assertIn('<Long member> &', content)
        for word in words:
            self.assertIn(word, content)

    def test_multi_page_schedule_repeats_item_identity_in_every_column_band(self):
        values = {}
        for index in range(24):
            row = index + 9
            values.update({f'A{row}': f'Member-{index:02}', f'B{row}': 'Level 2',
                           f'C{row}': 'PROMATECT-XS', f'D{row}': '200UC46',
                           f'F{row}': 10, f'G{row}': 4, f'H{row}': 120,
                           f'I{row}': 'Column', f'J{row}': 550})
        reader = PdfReader(BytesIO(build_calculator_report('steel_board',
            blank_schedule_defaults('steel_board', {'CALCULATOR': values}), portrait=True)))
        self.assertGreater(len(reader.pages), 1)
        self.assert_portrait(reader)
        content = text(reader)
        for index in range(24):
            self.assertEqual(content.count(f'Member-{index:02}'), 4)


if __name__ == '__main__':
    unittest.main()
