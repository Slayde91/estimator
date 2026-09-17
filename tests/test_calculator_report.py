"""PDF schedule projections checked against independent Microsoft Excel captures."""

from copy import deepcopy
from functools import lru_cache
from io import BytesIO
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.calculator_report import build_calculator_report, build_calculator_summary_report, project_calculator_report, _material_rows, _source_text
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


@lru_cache(maxsize=3)
def blank_projection(identity):
    return project_calculator_report(identity, cleared_inputs(identity))


class CalculatorReportTests(unittest.TestCase):
    def assert_native_projection(self, identity, projected, expected):
        comparisons = 0
        for row in projected['rows']:
            for column, actual in row['values'].items():
                address = column + str(row['row'])
                if address in expected.get(projected['sheet'], {}):
                    if identity == 'ductwork' and (column == 'AL' or (row['wrap'] and column in ('AP', 'AQ'))):
                        # Fixing text has its own native fixture. The new directional
                        # application notes are asserted in test_fyrewrap_rules;
                        # all quantity outputs here still match the original oracle.
                        continue
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
        for identity, cell, value in [('ductwork', 'D1010', 0), ('steel_vermiculite', 'A1009', 'Last incomplete member'),
                                      ('steel_board', 'X1008', 'Last design reference')]:
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
                    for contact in ('ABN: 50 612 231 562', 'Phone: 1300 92 62 88', 'Email: sales@ceasefire.com.au'):
                        self.assertTrue(all(contact in content for content in texts))
                    for field in ('Project No.', 'Client', 'Site Address', 'Not recorded'):
                        self.assertIn(field, text)
                    self.assertTrue(all(f'Page {number}' in content for number, content in enumerate(texts, 1)))
                    self.assertTrue(all(page.images for page in reader.pages))
                    if builder is build_calculator_report:
                        self.assertTrue(all(sum(line.strip() == 'Line' for line in content.splitlines()) == 1
                                            for content in texts))
                    for page in reader.pages:
                        positions = {}
                        def located(value, cm, tm, font, size):
                            for token in ('CALCULATORS | ' + header, 'ABN: 50 612 231 562'):
                                if token in value:
                                    positions[token] = (tm[4], tm[5])
                        page.extract_text(visitor_text=located)
                        label = positions['CALCULATORS | ' + header]
                        contact = positions['ABN: 50 612 231 562']
                        self.assertAlmostEqual(label[0], 32)
                        self.assertLess(label[1], contact[1])
                        self.assertGreater(contact[0], float(page.mediabox.width) / 2)
                    self.assertIn('Current calculator snapshot', text)
                    abbreviated_summary = identity in {'steel_board', 'steel_vermiculite'} and builder is build_calculator_summary_report
                    for removed in ('Report generated from the complete', 'Authoritative workbook',
                                    'Source SHA-256', source_model(identity)['source']['sha256']):
                        self.assertNotIn(removed, text)
                    if abbreviated_summary or (identity == 'ductwork' and builder is build_calculator_report):
                        self.assertNotIn('Display rounding is limited', text)
                    else:
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
                for heading in ('Material quantities and summary', 'Overall schedule totals'):
                    self.assertNotIn(heading, text)
                    self.assertIn(heading, summary)
                self.assertNotIn('Final product and material summary', text)
                if identity == 'steel_vermiculite':
                    self.assertNotIn('Final product and material summary', summary)
                else:
                    self.assertIn('Final product and material summary', summary)
                self.assertNotIn('EXTRA BOARDS', text)
                if identity == 'ductwork':
                    self.assertIn('11.70', text)
                    self.assertIn('38.00 per layer', ' '.join(text.split()))
                    self.assertIn('27.81', text)
                    for heading in ('Product totals', 'Penetration angles by size and location',
                                    'Maxilite 60 mm boards and cut strips'):
                        self.assertNotIn(heading, text)
                        self.assertIn(heading, summary)
                    for removed in ('Working spray yields', 'Calibrated estimate', 'Original example: 11.7 bags',
                                    'Based on duct use', 'Duct use sets the full-length layers',
                                    'Confirm penetration steel sizes and layout'):
                        self.assertNotIn(removed, summary)
                elif identity == 'steel_vermiculite':
                    self.assertIn('430.73', text)
                    self.assertIn('218.38', text)
                    self.assertIn('219.00', text)
                    self.assertNotIn('Product order totals', text)
                    self.assertNotIn('Product order totals', summary)
                    for removed in ('Totals use available source results', 'Display rounding is limited',
                                    'Whole bags per product are pooled from net bags'):
                        self.assertNotIn(removed, summary)
                    for retained in ('CAFCO 300', 'Order status', 'Overall schedule totals'):
                        self.assertIn(retained, summary)
                    for unused in ('MONOKOTE MK-6 HY', 'MANDOLITE CP2', 'FENDOLITE MII', 'PERLIFOC HP ECO+'):
                        self.assertNotIn(unused, summary)
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
                if data['rows'] or data['extra_rows']:
                    self.assertIn('Board stock totals by product and thickness', normalized)
                else:
                    self.assertNotIn('Board stock totals by product and thickness', normalized)
                for heading in ('Overall schedule totals', 'Pooled whole sheets', 'incomplete or unavailable primary quantities'):
                    self.assertIn(heading, normalized)
                for item in data['extra_rows']:
                    self.assertIn(f"Extra-board item {item['line']}", text)
                self.assertEqual(data, before)

    def test_summary_filters_default_material_stock_without_changing_projection(self):
        expected = {
            'ductwork': [[9, 10, 11], [19, 23, 25], [40]],
            'steel_vermiculite': [[20]],
            'steel_board': [[12, 13, 14, 15, 18, 23, 25, 26, 27, 28]],
        }
        for identity, wanted in expected.items():
            data = default_projection(identity)
            before = deepcopy(data)
            tables = [summary for summary in data['summaries'] if summary['title'] != 'Working spray yields']
            self.assertEqual([[row['row'] for row in _material_rows(identity, table)] for table in tables], wanted)
            with patch('estimator.calculator_report.project_calculator_report', return_value=data):
                text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                    build_calculator_summary_report(identity))).pages)
            self.assertIn('Overall schedule totals', text)
            self.assertEqual(data, before)

    def test_schedule_header_stays_with_body_when_a_long_cell_spans_pages(self):
        data = deepcopy(default_projection('ductwork'))
        data['rows'] = data['rows'][:1]
        literal = 'Long product identifier ' * 90 + 'END OF IDENTIFIER'
        data['rows'][0]['values']['C'] = literal
        with patch('estimator.calculator_report.project_calculator_report', return_value=data):
            reader = PdfReader(BytesIO(build_calculator_report('ductwork')))
        texts = [page.extract_text() for page in reader.pages]
        self.assertGreater(len(texts), 1)
        compact = ''.join(''.join(texts).split())
        self.assertEqual(compact.count('Longproductidentifier'), 90)
        self.assertIn('ENDOFIDENTIFIER', compact)
        self.assertTrue(all(sum(line.strip() == 'Line' for line in text.splitlines()) == 1 for text in texts))

    def test_blank_material_summaries_have_no_product_stock_or_empty_table_headings(self):
        for identity in ('ductwork', 'steel_vermiculite', 'steel_board'):
            data = blank_projection(identity)
            before = deepcopy(data)
            with self.subTest(identity=identity), patch('estimator.calculator_report.project_calculator_report', return_value=data):
                text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                    build_calculator_summary_report(identity))).pages)
            self.assertIn('No materials are required by the current inputs.', text)
            self.assertNotIn('Final product and material summary', text)
            for summary in data['summaries']:
                self.assertNotIn(summary['title'], text)
                for row in summary['rows']:
                    if isinstance(row['values']['A'], str) and row['values']['A'] not in data['basis']:
                        self.assertNotIn(row['values']['A'], text)
            self.assertEqual(data, before)

    def test_one_used_product_does_not_publish_unused_stock(self):
        for identity, product, original_row in [('ductwork', 'FyreWrap', 13),
                                                 ('steel_vermiculite', 'CAFCO 300', 10),
                                                 ('steel_board', 'TRAFALGAR COREX', 10)]:
            model = source_model(identity)
            schedule = model['schedule']
            source = next(sheet for sheet in model['sheets'] if sheet['name'] == schedule['sheet'])
            inputs = cleared_inputs(identity)
            inputs[schedule['sheet']].update({field['column'] + str(schedule['first_row']):
                source['cells'].get(field['column'] + str(original_row), {}).get('value')
                for field in schedule['columns'] if field['editable']})
            data = project_calculator_report(identity, inputs)
            before = deepcopy(data)
            with self.subTest(identity=identity), patch('estimator.calculator_report.project_calculator_report', return_value=data):
                text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                    build_calculator_summary_report(identity))).pages)
            self.assertIn(product, text)
            for table in data['summaries'][:1]:
                for row in table['rows']:
                    if row['values']['A'] != product:
                        self.assertNotIn(row['values']['A'], text)
            self.assertEqual(data, before)

    def test_material_summary_preserves_tiny_negative_and_unknown_demand(self):
        # Distinct names prove the PDF includes each row, even though a normal
        # two-decimal display could have hidden a small quantity as zero.
        cases = [('steel_vermiculite', 0, 'E'), ('steel_board', 0, 'F'),
                 ('ductwork', 0, 'D'), ('ductwork', 1, 'D'), ('ductwork', 3, 'G')]
        for identity, table_index, column in cases:
            for demand in (0.0000001, -0.0000001, '#N/A', None):
                data = deepcopy(blank_projection(identity))
                table = data['summaries'][table_index]
                table['rows'][0]['values']['A'] = 'REQUIRED-MATERIAL'
                table['rows'][0]['values'][column] = demand
                with self.subTest(identity=identity, table=table_index, demand=demand), patch(
                        'estimator.calculator_report.project_calculator_report', return_value=data):
                    text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                        build_calculator_summary_report(identity))).pages)
                    compact = ''.join(text.split())
                    self.assertIn('REQUIRED-MATERIAL', compact)
                    if demand == '#N/A':
                        self.assertIn('Unavailable:#N/A', compact)
                    elif isinstance(demand, float):
                        self.assertIn('1.00E-7', compact)

    def test_unresolved_products_and_withheld_quantities_are_not_treated_as_unused(self):
        for identity, column, product in [('steel_vermiculite', 'B', 'MANDOLITE CP2'),
                                          ('steel_board', 'C', 'PROMATECT 100'),
                                          ('ductwork', 'C', 'CAFCO 300')]:
            schedule = source_model(identity)['schedule']
            inputs = cleared_inputs(identity)
            inputs[schedule['sheet']][column + str(schedule['first_row'])] = product
            data = project_calculator_report(identity, inputs)
            self.assertEqual(data['incomplete_rows'], 1)
            with self.subTest(identity=identity), patch('estimator.calculator_report.project_calculator_report', return_value=data):
                text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                    build_calculator_summary_report(identity))).pages)
            self.assertIn('Unresolved material requirements:', text)
            self.assertIn(product + ' (1 schedule item(s))', ' '.join(text.split()))
            self.assertNotIn('No materials are required', text)
        data = deepcopy(blank_projection('ductwork'))
        data['summaries'][0]['rows'][1]['values']['J'] = 1
        with patch('estimator.calculator_report.project_calculator_report', return_value=data):
            text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                build_calculator_summary_report('ductwork'))).pages)
        self.assertIn('MONOKOTE', text)
        self.assertIn('Steel rows withheld', text)
        self.assertNotIn('Penetration angles by size and location', text)

    def test_extra_only_board_quantities_and_incomplete_extra_evidence_survive_filtering(self):
        inputs = cleared_inputs('steel_board')
        inputs['EXTRA BOARDS'].update({'A6': 'Extra stock only', 'B6': 'PROMATECT 250', 'C6': 15,
                                       'G6': 0.0000001, 'N7': 'Allowance still under review'})
        data = project_calculator_report('steel_board', inputs)
        self.assertEqual(data['rows'], [])
        self.assertGreater(data['summaries'][0]['rows'][4]['values']['F'], 0)
        with patch('estimator.calculator_report.project_calculator_report', return_value=data):
            text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(
                build_calculator_summary_report('steel_board'))).pages)
        self.assertIn('PROMATECT 250', text)
        self.assertNotIn('TRAFALGAR COREX', text)
        self.assertIn('Extra-board item 1', text)
        self.assertIn('Extra-board item 2', text)
        self.assertIn('Allowance still under review', text)
        self.assertIn('1.00E-7', text)

    def test_pdf_preserves_long_free_text_and_identifier_precision(self):
        inputs = cleared_inputs('steel_board')
        note = 'R3 P250 M12 report 1.2345 <literal> ' + 'Design reference ' * 80
        inputs['CALCULATOR'].update({'A1008': 'Last member R3 P250 M12 1.2345', 'X1008': 'Private calculation detail'})
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
        inputs['CALCULATOR'].update({column + '1010': original['cells'][column + '13'].get('value') for column in 'BCDEFGHI'})
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
            ('ductwork', 'D1010', 0, 'Product missing'),
            ('steel_vermiculite', 'A1009', 'Final incomplete spray member', 'Final incomplete spray member'),
            ('steel_board', 'A1008', 'Final incomplete board member', 'Final incomplete board member'),
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

    def test_steel_locations_and_distinct_line_columns_reach_schedule_only(self):
        for identity, sheet, row, location in [('steel_vermiculite', 'SCHEDULE', 1009, 'AA'),
                                               ('steel_board', 'CALCULATOR', 1008, 'B')]:
            with self.subTest(identity=identity):
                inputs = cleared_inputs(identity)
                inputs[sheet][f'{location}{row}'] = 'North building / level 12 - zone B'
                inputs[sheet][f'A{row}'] = 'LAST-MARK-1000'
                before = deepcopy(inputs)
                data = project_calculator_report(identity, inputs)
                self.assertEqual(len(data['rows']), 1)
                self.assertEqual(data['rows'][0]['line'], 1000)
                self.assertEqual(data['rows'][0]['values'][location], inputs[sheet][f'{location}{row}'])
                text = ' '.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_report(identity, inputs))).pages)
                self.assertIn('Location', text)
                self.assertIn('1000', text)
                self.assertIn('LAST-MARK-1000', ''.join(text.split()))
                self.assertIn('Northbuilding/level12-zoneB', ''.join(text.split()))
                summary = ' '.join(page.extract_text() for page in PdfReader(BytesIO(build_calculator_summary_report(identity, inputs))).pages)
                self.assertNotIn('LAST-MARK-1000', summary)
                self.assertEqual(inputs, before)

    def test_numeric_marks_and_locations_keep_identifier_digits_in_pdf(self):
        for identity, location in [('steel_vermiculite', 'AA'), ('steel_board', 'B')]:
            with self.subTest(identity=identity):
                inputs = cleared_inputs(identity)
                schedule = source_model(identity)['schedule']
                row, sheet = schedule['last_row'], schedule['sheet']
                inputs[sheet][f'A{row}'] = 123.456789
                inputs[sheet][f'{location}{row}'] = 987.654321
                before = deepcopy(inputs)
                payload = build_calculator_report(identity, inputs)
                text = ''.join(''.join(page.extract_text().split()) for page in PdfReader(BytesIO(payload)).pages)
                self.assertIn('123.456789', text)
                self.assertIn('987.654321', text)
                self.assertNotIn('123.46', text)
                self.assertNotIn('987.65', text.replace('987.654321', ''))
                self.assertEqual(inputs, before)

    def test_invalid_input_types_and_reference_cell_writes_fail_before_reporting(self):
        for inputs in [{'CALCULATOR': {'K11': 3}}, {'CALCULATOR': {'D11': True}}, {'CALCULATOR': {'D11': 10 ** 400}}]:
            for builder in (build_calculator_report, build_calculator_summary_report):
                with self.assertRaises(ValidationError):
                    builder('ductwork', inputs)

    def test_project_details_are_literal_complete_and_do_not_change_report_data(self):
        details = {'project_no': 'CF-1000 <reference> & ' + 'P' * 70 + ' PROJECT END',
                   'client': 'Client <b>literal</b> & ' + 'C' * 160 + ' CLIENT END',
                   'site_address': 'Site address <literal> & ' + 'S' * 260 + ' ADDRESS END'}
        original = deepcopy(details)
        for identity in ('steel_vermiculite', 'steel_board', 'ductwork'):
            data = project_calculator_report(identity, {})
            before = deepcopy(data)
            for builder in (build_calculator_report, build_calculator_summary_report):
                with self.subTest(identity=identity, builder=builder.__name__), patch(
                        'estimator.calculator_report.project_calculator_report', return_value=data):
                    reader = PdfReader(BytesIO(builder(identity, {}, project_details=details)))
                    text = ''.join(''.join(page.extract_text().split()) for page in reader.pages)
                    for value in details.values():
                        self.assertIn(''.join(value.split()), text)
                    self.assertNotIn('Notrecorded', text)
                    self.assertEqual(data, before)
                    self.assertEqual(details, original)


if __name__ == '__main__':
    unittest.main()
