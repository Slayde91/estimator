"""PDF schedule projections checked against independent Microsoft Excel captures."""

from copy import deepcopy
from functools import lru_cache
from io import BytesIO
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.calculator_report import build_calculator_report, build_calculator_summary_report, project_calculator_report, _source_text
from estimator.catalog import ValidationError
from estimator.workbook_calculators import source_model
from tests.test_workbook_parity import read_fixture, scenario_inputs, excel_equal


REMOVED_SECTIONS = (
    'Schedule inputs, calculations and complete notes',
    'Single-member calculator - separate from the schedule',
    'Manual bag calculation - separate from the schedule',
    'Settings used for this report',
)


def cleared_inputs(identity):
    model = source_model(identity)
    schedule = model['schedule']
    columns = [field['column'] for field in schedule['columns'] if field['editable']]
    inputs = {schedule['sheet']: {column + str(row): None for column in columns
              for row in range(schedule['first_row'], schedule['last_row'] + 1)}}
    if identity == 'steel_board':
        inputs['EXTRA BOARDS'] = {column + str(row): None for column in list('ABCDEFGHI') + ['N'] for row in range(6, 46)}
    return inputs


@lru_cache(maxsize=3)
def default_projection(identity):
    return project_calculator_report(identity, {})


class CalculatorReportTests(unittest.TestCase):
    def assert_native_projection(self, identity, projected, expected):
        comparisons = 0
        for row in projected['rows']:
            for column, actual in row['values'].items():
                address = column + str(row['row'])
                if address in expected.get(projected['sheet'], {}):
                    if identity == 'ductwork' and column == 'AL':
                        continue  # Explicit approved copied-text exception has its own native fixture.
                    self.assertTrue(excel_equal(actual, expected[projected['sheet']][address]), (identity, address, actual, expected[projected['sheet']][address]))
                    comparisons += 1
        for table in projected['summaries']:
            for row in table['rows']:
                for column, actual in row['values'].items():
                    address = column + str(row['row'])
                    if address in expected.get(table['sheet'], {}):
                        self.assertTrue(excel_equal(actual, expected[table['sheet']][address]), (identity, table['sheet'], address))
                        comparisons += 1
        for row in projected['extra_rows']:
            for column, actual in row['values'].items():
                address = column + str(row['row'])
                if address in expected.get('EXTRA BOARDS', {}):
                    self.assertTrue(excel_equal(actual, expected['EXTRA BOARDS'][address]), ('EXTRA BOARDS', address))
                    comparisons += 1
        self.assertGreater(comparisons, 20)

    def test_all_default_schedules_and_product_totals_match_native_excel(self):
        for identity, count in [('ductwork', 3), ('steel_vermiculite', 1), ('steel_board', 36)]:
            with self.subTest(identity=identity):
                expected = read_fixture(identity, 'default')['scenarios'][0]['expected']
                data = default_projection(identity)
                self.assertEqual(len(data['rows']), count)
                self.assert_native_projection(identity, data, expected)
        board = default_projection('steel_board')
        self.assertTrue(excel_equal(dict(board['totals'])['Reference box area (m²)'], read_fixture('steel_board', 'default')['scenarios'][0]['expected']['CALCULATOR']['AA4']))
        self.assertEqual(dict(board['totals'])['Pooled whole sheets'], 27)
        verm = default_projection('steel_vermiculite')
        self.assertAlmostEqual(verm['summaries'][0]['rows'][0]['values']['E'], 218.37775141101426)
        self.assertEqual(verm['summaries'][0]['rows'][0]['values']['G'], 219)

    def test_separate_helpers_do_not_change_schedule_projection_or_product_orders(self):
        default = default_projection('steel_vermiculite')
        changed = project_calculator_report('steel_vermiculite', {
            'CALCULATOR': {'D6': 'MANDOLITE CP2', 'D16': 456.789},
            'BAGS': {'D6': 'MANDOLITE CP2', 'D7': 1234.56789, 'D8': 19.875},
        })
        for key in ('rows', 'totals', 'summaries'):
            self.assertEqual(changed[key], default[key])
        self.assertNotIn('context', changed)
        self.assertNotIn('settings', changed)

    def test_native_changed_yields_rounding_unresolved_rows_and_extra_board_stock(self):
        cases = [('ductwork', 'calibration_reference_precision'),
                 ('steel_vermiculite', 'missing_yield_and_zero_area'),
                 ('steel_vermiculite', 'rounding_manual_bags_and_helpers'),
                 ('steel_board', 'advanced_choices_boundaries_and_all_stock'),
                 ('steel_board', 'zero_waste_rounding_and_manual_geometry')]
        for identity, name in cases:
            scenario = next(scenario for scenario in read_fixture(identity, 'variations')['scenarios'] if scenario['id'] == name)
            with self.subTest(identity=identity, scenario=name):
                data = project_calculator_report(identity, scenario_inputs(scenario))
                self.assert_native_projection(identity, data, scenario['expected'])
                self.assertEqual(data['source']['sha256'], read_fixture(identity, 'variations')['source_sha256'])

    def test_used_row_detection_retains_blank_product_zero_and_last_row(self):
        for identity, cell, value in [('ductwork', 'D310', 0), ('steel_vermiculite', 'A1009', 'Last incomplete member'),
                                      ('steel_board', 'X208', 'Last design reference')]:
            inputs = cleared_inputs(identity)
            sheet = source_model(identity)['schedule']['sheet']
            self.assertEqual(project_calculator_report(identity, inputs)['rows'], [])
            inputs[sheet][cell] = value
            before = deepcopy(inputs)
            data = project_calculator_report(identity, inputs)
            self.assertEqual(inputs, before)
            self.assertEqual(len(data['rows']), 1)
            self.assertEqual(data['rows'][0]['values'][cell.rstrip('0123456789')], value)
            self.assertEqual(data['incomplete_rows'], 1)
        inputs = cleared_inputs('steel_board')
        inputs['EXTRA BOARDS']['N45'] = 'Evidence without a quantity'
        data = project_calculator_report('steel_board', inputs)
        self.assertEqual(len(data['extra_rows']), 1)
        self.assertEqual(data['extra_rows'][0]['values']['M'], '')
        self.assertEqual(dict(data['totals'])['Required net board including extras (m²)'], 0)

    def test_board_pooled_totals_include_valid_extras_and_never_sum_line_sheet_orders(self):
        scenario = next(s for s in read_fixture('steel_board', 'variations')['scenarios'] if s['id'] == 'advanced_choices_boundaries_and_all_stock')
        data = project_calculator_report('steel_board', scenario_inputs(scenario))
        self.assertTrue(data['extra_rows'])
        expected = scenario['expected']['BOARD SUMMARY']
        totals = dict(data['totals'])
        for label, cell in [('Required net board including extras (m²)', 'A6'), ('Pooled whole sheets', 'E6'), ('Pooled purchase area (m²)', 'I6')]:
            self.assertTrue(excel_equal(totals[label], expected[cell]))
        self.assertNotEqual(totals['Pooled whole sheets'], sum(row['values']['AG'] for row in data['rows'] if type(row['values']['AG']) in (int, float)))

    def test_both_pdfs_preserve_branding_precision_and_separate_schedule_from_materials(self):
        for identity in ['ductwork', 'steel_vermiculite', 'steel_board']:
            with self.subTest(identity=identity):
                reports = []
                for builder, header in [(build_calculator_report, 'FULL SCHEDULE'),
                                        (build_calculator_summary_report, 'MATERIALS & SUMMARY')]:
                    payload = builder(identity, {})
                    reader = PdfReader(BytesIO(payload))
                    texts = [page.extract_text() for page in reader.pages]
                    text = '\n'.join(texts)
                    reports.append(text)
                    self.assertTrue(payload.startswith(b'%PDF'))
                    self.assertTrue(all(float(page.mediabox.width) > float(page.mediabox.height) for page in reader.pages))
                    self.assertTrue(all('CALCULATORS | ' + header in content for content in texts))
                    self.assertTrue(all(f'Page {number}' in content for number, content in enumerate(texts, 1)))
                    self.assertTrue(all(page.images for page in reader.pages))
                    self.assertIn('Current calculator snapshot', text)
                    board_summary = identity == 'steel_board' and builder is build_calculator_summary_report
                    if board_summary:
                        self.assertNotIn(source_model(identity)['source']['sha256'], text)
                        self.assertNotIn('Display rounding is limited', text)
                    else:
                        self.assertIn(source_model(identity)['source']['sha256'], text)
                        self.assertIn('Display rounding is limited', text)
                    for heading in REMOVED_SECTIONS:
                        self.assertNotIn(heading, text)
                    self.assertNotIn('Schedule item 1', text)
                    self.assertNotIn('CALCULATOR column AI', text)
                    self.assertNotIn('CALCULATOR column AD', text)
                    self.assertNotIn('header comment', text)
                text, summary = reports
                self.assertIn('Full schedule', text)
                self.assertNotIn('Full schedule', summary)
                for heading in ('Material quantities and summary', 'Final product and material summary', 'Overall schedule totals'):
                    self.assertNotIn(heading, text)
                    self.assertIn(heading, summary)
                self.assertNotIn('EXTRA BOARDS', text)
                if identity == 'ductwork':
                    self.assertIn('11.70', text)
                    self.assertIn('38.00 per layer', ' '.join(text.split()))
                    self.assertIn('27.81', text)
                    for heading in ('Product totals', 'Penetration angles by size and location', 'Working spray yields',
                                    'Maxilite 60 mm boards and cut strips'):
                        self.assertNotIn(heading, text)
                        self.assertIn(heading, summary)
                elif identity == 'steel_vermiculite':
                    self.assertIn('430.73', text)
                    self.assertIn('218.38', text)
                    self.assertIn('219.00', text)
                    self.assertNotIn('Product order totals', text)
                    self.assertIn('Product order totals', summary)
                else:
                    self.assertIn('74.40', summary)
                    self.assertIn('30.00', text)
                    self.assertIn('Total thickness mm', ' '.join(text.split()))
                    self.assertIn('EXTRA BOARDS', summary)
                    self.assertNotIn('EXTRA BOARDS', summary.splitlines())
                    self.assertIn('Board stock totals by product and thickness', summary)
                    self.assertIn('Bags are not applicable', summary)

    def test_board_summary_omits_only_requested_text_and_retains_extra_items_and_guidance(self):
        scenario = next(s for s in read_fixture('steel_board', 'variations')['scenarios']
                        if s['id'] == 'advanced_choices_boundaries_and_all_stock')
        for inputs in ({}, cleared_inputs('steel_board'), scenario_inputs(scenario)):
            with self.subTest(extra_inputs=inputs.get('EXTRA BOARDS', {})):
                data = project_calculator_report('steel_board', inputs)
                before = deepcopy(data)
                with patch('estimator.calculator_report.project_calculator_report', return_value=data):
                    text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(
                        build_calculator_summary_report('steel_board', inputs))).pages)
                normalized = ' '.join(text.split())
                for omitted in ('Display rounding is limited', 'Valid allowances are already included',
                                'No extra-board inputs are entered.', 'Report generated from the complete',
                                'Authoritative workbook:', 'Source SHA-256:', data['source']['sha256']):
                    self.assertNotIn(omitted, text)
                self.assertNotIn('EXTRA BOARDS', text.splitlines())
                for paragraph in data['summary_notes'][0].splitlines():
                    self.assertNotIn(' '.join(_source_text('steel_board', 'BOARD SUMMARY', 'A8', paragraph).split()), normalized)
                for note in data['summary_notes'][1:]:
                    self.assertIn(' '.join(_source_text('steel_board', 'BOARD SUMMARY', 'A31', note).split()), normalized)
                for heading in ('Board stock totals by product and thickness', 'Overall schedule totals',
                                'Pooled whole sheets', 'incomplete or unavailable primary quantities'):
                    self.assertIn(heading, normalized)
                for item in data['extra_rows']:
                    self.assertIn(f"Extra-board item {item['line']}", text)
                self.assertEqual(data, before)

    def test_pdf_preserves_long_free_text_and_identifier_precision(self):
        inputs = cleared_inputs('steel_board')
        note = 'R3 P250 M12 report 1.2345 <literal> ' + 'Design reference ' * 80
        inputs['CALCULATOR'].update({'A208': 'Last member R3 P250 M12 1.2345', 'X208': 'Private calculation detail'})
        inputs['EXTRA BOARDS'].update({'A45': 'Last allowance', 'G45': -1.005, 'H45': 0.14505, 'N45': note})
        before = deepcopy(inputs)
        text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_report('steel_board', inputs))).pages)
        summary = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_summary_report('steel_board', inputs))).pages)
        self.assertIn('Last member R3 P250 M12 1.2345', ' '.join(text.split()))
        self.assertNotIn('Last member', summary)
        self.assertNotIn('Extra-board item', text)
        self.assertIn('Extra-board item 40', summary)
        self.assertIn('R3 P250 M12 report 1.2345 <literal>', ' '.join(summary.split()))
        self.assertIn('14.51%', summary)
        self.assertIn('-1.01', summary)
        self.assertNotIn('Private calculation detail', text)
        self.assertNotIn('Private calculation detail', summary)
        self.assertEqual(inputs, before)
        self.assertEqual(_source_text('steel_board', 'CALCULATOR', 'AI9', 'Ask Promat for P250, report 1.2345 and M12 fixings.'), 'Ask Promat for P250, report 1.2345 and M12 fixings.')
        self.assertIn('Box girth override', _source_text('steel_board', 'CALCULATOR', 'AV9', 'Check V is the INSIDE box girth'))

    def test_wrap_only_has_no_invented_bag_order_and_blank_reports_are_supported(self):
        inputs = cleared_inputs('ductwork')
        original = next(sheet for sheet in source_model('ductwork')['sheets'] if sheet['name'] == 'CALCULATOR')
        inputs['CALCULATOR'].update({column + '310': original['cells'][column + '13'].get('value') for column in 'BCDEFGHI'})
        data = project_calculator_report('ductwork', inputs)
        self.assertEqual(dict(data['totals'])['Available net spray bags'], 'N/A')
        self.assertEqual(data['rows'][0]['values']['M'], '')
        self.assertEqual(data['rows'][0]['wrap_layer_mm'], 38)
        for identity in ['ductwork', 'steel_vermiculite', 'steel_board']:
            text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_report(identity, cleared_inputs(identity)))).pages)
            self.assertIn('No schedule inputs are entered.', text)
            summary = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_summary_report(identity, cleared_inputs(identity)))).pages)
            self.assertIn('0 used schedule items. 0 item(s)', ' '.join(summary.split()))
            self.assertIn('Overall schedule totals', summary)
            self.assertNotIn('Full schedule', summary)

    def test_removed_details_do_not_remove_incomplete_last_items_from_pdf(self):
        for identity, cell, value, expected in [
            ('ductwork', 'D310', 0, 'Product missing'),
            ('steel_vermiculite', 'A1009', 'Final incomplete spray member', 'Final incomplete spray member'),
            ('steel_board', 'A208', 'Final incomplete board member', 'Final incomplete board member'),
        ]:
            with self.subTest(identity=identity):
                inputs = cleared_inputs(identity)
                sheet = source_model(identity)['schedule']['sheet']
                inputs[sheet][cell] = value
                projected = project_calculator_report(identity, inputs)
                self.assertEqual(len(projected['rows']), 1)
                self.assertEqual(projected['rows'][0]['row'], source_model(identity)['schedule']['last_row'])
                text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_report(identity, inputs))).pages)
                # Narrow schedule cells may wrap within a long word; the full
                # identifier must survive PDF extraction without losing text.
                self.assertIn(''.join(expected.split()), ''.join(text.split()))
                self.assertIn('1 used schedule items. 1 item(s)', ' '.join(text.split()))
                for heading in REMOVED_SECTIONS:
                    self.assertNotIn(heading, text)

    def test_complete_thousand_row_spray_schedule_uses_native_per_line_results(self):
        identity = 'steel_vermiculite'
        source = next(sheet for sheet in source_model(identity)['sheets'] if sheet['name'] == 'SCHEDULE')
        inputs = cleared_inputs(identity)
        sample = {column: source['cells'].get(column + '10', {}).get('value') for column in 'ABCDEFGHIJKL'}
        for row in range(10, 1010):
            inputs['SCHEDULE'].update({column + str(row): value for column, value in sample.items()})
            inputs['SCHEDULE']['A' + str(row)] = 'Capacity member ' + str(row - 9)
        data = project_calculator_report(identity, inputs)
        native = read_fixture(identity, 'default')['scenarios'][0]['expected']['SCHEDULE']
        self.assertEqual(len(data['rows']), 1000)
        self.assertEqual(data['incomplete_rows'], 0)
        self.assertEqual(data['rows'][-1]['line'], 1000)
        for row in data['rows']:
            for column in 'OPRSTU':
                self.assertTrue(excel_equal(row['values'][column], native[column + '10']))

    def test_invalid_input_types_and_reference_cell_writes_fail_before_reporting(self):
        for inputs in [{'CALCULATOR': {'K11': 3}}, {'CALCULATOR': {'D11': True}}, {'CALCULATOR': {'D11': 10 ** 400}}]:
            for builder in (build_calculator_report, build_calculator_summary_report):
                with self.assertRaises(ValidationError):
                    builder('ductwork', inputs)


if __name__ == '__main__':
    unittest.main()
