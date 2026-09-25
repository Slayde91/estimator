"""Runtime capacity and descriptive inputs preserve independently captured rules."""
from collections import Counter, defaultdict
import hashlib
import math
import unittest

from estimator.catalog import ValidationError
from estimator.excel_engine import WorkbookEngine
from estimator.workbook_catalog import DATA_DIRECTORY, CATALOG_SPECS, editable_cells, load_workbook_catalog
from estimator.workbook_calculators import (approved_formula_overrides, calculator_definition,
    calculator_list, normalize_calculator_inputs, source_model, _board_product_totals)
from estimator.workbook_runtime import (application_editable_cells, extend_schedule_references,
    load_application_catalog)
from tests.test_workbook_parity import read_fixture, excel_equal


def sheet(model, name):
    return next(item for item in model['sheets'] if item['name'] == name)


class WorkbookRuntimeTests(unittest.TestCase):
    def test_runtime_capacity_titles_and_source_evidence_are_separate(self):
        before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in DATA_DIRECTORY.glob('*') if path.is_file()}
        self.assertEqual([(entry['id'], entry['title']) for entry in calculator_list()['calculators']],
                         [('steel_vermiculite', 'Steel (spray)'), ('steel_board', 'Steel (board)'), ('ductwork', 'Ductwork (spray/wrap)')])
        for identity, original_end, runtime_end in (('steel_vermiculite', 1009, 1009), ('steel_board', 208, 1008), ('ductwork', 310, 1010)):
            with self.subTest(identity=identity):
                raw = load_workbook_catalog(identity)
                derived = source_model(identity)
                self.assertEqual(raw['schedule']['last_row'], original_end)
                self.assertEqual(CATALOG_SPECS[identity]['schedule']['last_row'], original_end)
                self.assertEqual(derived['schedule']['last_row'], runtime_end)
                self.assertEqual(runtime_end - derived['schedule']['first_row'] + 1, 1000)
                self.assertEqual(derived['source'], raw['source'])
                self.assertEqual(derived['counts'], raw['counts'])
                self.assertEqual(derived['application']['source_schedule_last_row'], original_end)
                if identity != 'steel_vermiculite':
                    self.assertNotIn(f'B{runtime_end}', editable_cells(identity, 'CALCULATOR'))
                    self.assertIn(f'B{runtime_end}', application_editable_cells(identity, 'CALCULATOR'))
        self.assertEqual(before, {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in DATA_DIRECTORY.glob('*') if path.is_file()})

    def test_reference_expansion_ignores_other_sheets_row_ranges_and_quoted_text(self):
        formula = 'SUM(CALCULATOR!$AD$9:$AD$208)+SUM(\'LOOKUP CACHE\'!$A$9:$A$208)+COUNTA(A208:X208)+IF(A1="CALCULATOR!A9:A208",1,0)'
        expected = formula.replace('CALCULATOR!$AD$9:$AD$208', 'CALCULATOR!$AD$9:$AD$1008')
        self.assertEqual(extend_schedule_references(formula, 'CALCULATOR', 'CALCULATOR', 9, 208, 1008), expected)
        self.assertEqual(extend_schedule_references('SUM($AD$9:$AD$208)', 'CALCULATOR', 'CALCULATOR', 9, 208, 1008), 'SUM($AD$9:$AD$1008)')
        self.assertEqual(extend_schedule_references('SUM($AD$9:$AD$208)', 'OTHER', 'CALCULATOR', 9, 208, 1008), 'SUM($AD$9:$AD$208)')
        self.assertEqual(extend_schedule_references("'CALCULATOR'!$A$8:$CI$208", None, 'CALCULATOR', 9, 208, 1008), "'CALCULATOR'!$A$8:$CI$1008")

    def test_ductwork_uncalibrated_yields_use_editable_mass_and_density(self):
        model = source_model('ductwork')
        original = load_workbook_catalog('ductwork')
        settings = sheet(model, 'PRODUCT SETTINGS')['cells']
        self.assertTrue({f'E{row}:H{row}' for row in range(161, 165)}.issubset(
            set(sheet(model, 'PRODUCT SETTINGS')['merges'])))
        self.assertEqual(sheet(original, 'PRODUCT SETTINGS')['cells']['B25']['formula'],
                         'IFERROR(IF(B35="Calibrated",B44*(B45/1000)/B46,IF(B35="Uncalibrated",B23*(B24/1000)*(B22/1000)*(B21/B20),0)),0)')
        for address in ('B161', 'B162', 'B163', 'B164'):
            self.assertIn(address, application_editable_cells('ductwork', 'PRODUCT SETTINGS'))
            self.assertNotIn(address, editable_cells('ductwork', 'PRODUCT SETTINGS'))
        self.assertEqual([settings[address]['value'] for address in ('B161', 'B162', 'B163', 'B164')],
                         [20, 308, 21.8, 344])
        calibrated = WorkbookEngine(model, {}, approved_formula_overrides('ductwork'))
        self.assertTrue(excel_equal(calibrated.value('PRODUCT SETTINGS', 'B25'), 10 * .060 / 11.7))
        self.assertTrue(excel_equal(calibrated.value('PRODUCT SETTINGS', 'B69'), 10 * .061 / 11.7))
        inputs = {'PRODUCT SETTINGS': {'B35': 'Uncalibrated', 'B73': 'Uncalibrated'}}
        baseline = WorkbookEngine(model, normalize_calculator_inputs('ductwork', inputs), approved_formula_overrides('ductwork'))
        self.assertTrue(excel_equal(baseline.value('PRODUCT SETTINGS', 'B25'), 20 / 308))
        self.assertTrue(excel_equal(baseline.value('PRODUCT SETTINGS', 'B69'), 21.8 / 344))
        edited = {'PRODUCT SETTINGS': {**inputs['PRODUCT SETTINGS'], 'B161': 25, 'B162': 500,
                                       'B163': 20, 'B164': 400}}
        adjusted = WorkbookEngine(model, normalize_calculator_inputs('ductwork', edited), approved_formula_overrides('ductwork'))
        self.assertTrue(excel_equal(adjusted.value('PRODUCT SETTINGS', 'B25'), .05))
        self.assertTrue(excel_equal(adjusted.value('PRODUCT SETTINGS', 'B69'), .05))
        for row in (11, 12):
            self.assertEqual(baseline.value('CALCULATOR', f'L{row}'), adjusted.value('CALCULATOR', f'L{row}'))
            self.assertNotEqual(baseline.value('CALCULATOR', f'M{row}'), adjusted.value('CALCULATOR', f'M{row}'))
        injected = WorkbookEngine(model, normalize_calculator_inputs('ductwork',
                                  {'PRODUCT SETTINGS': {**edited['PRODUCT SETTINGS'], 'B65': 'Injected'}}),
                                  approved_formula_overrides('ductwork'))
        self.assertTrue(excel_equal(injected.value('PRODUCT SETTINGS', 'B69'), .05 * 40 / 27))

    def test_derived_models_are_caller_owned_and_new_rows_keep_validations_and_line_identity(self):
        for identity, end, table_name in (('steel_board', 1008, 'tSchedule'), ('ductwork', 1010, 'DuctSchedule')):
            model = load_application_catalog(identity)
            schedule = model['schedule']
            target = sheet(model, schedule['sheet'])
            self.assertTrue(model['tables'][table_name]['ref'].endswith(str(end)))
            self.assertTrue(target['page_range'].endswith(str(end)))
            self.assertTrue(target['dimension'].endswith(str(end)))
            self.assertTrue(any(v['sqref'] == f'C{schedule["first_row"]}:C{end}' for v in target['validations']))
            for row in (schedule['first_row'], schedule['first_row'] + 499, end):
                data = {schedule['sheet']: {f'C{row}': 'A custom warning-list value'}}
                expected = {schedule['sheet']: {**data[schedule['sheet']], **({'I13': 'Both'} if identity == 'ductwork' else {})}}
                self.assertEqual(normalize_calculator_inputs(identity, data), expected)
            model['schedule']['last_row'] = 1
            target['cells'][f'C{end}']['value'] = 'caller change'
            self.assertEqual(load_application_catalog(identity)['schedule']['last_row'], end)
            self.assertNotIn('value', sheet(load_application_catalog(identity), schedule['sheet'])['cells'][f'C{end}'])
        duct = source_model('ductwork')
        self.assertEqual(sheet(duct, 'CALCULATOR')['cells']['A1010']['value'], 1000)
        self.assertIn('AL1010', approved_formula_overrides('ductwork')['CALCULATOR'])
        self.assertIn('AS1010', approved_formula_overrides('ductwork')['CALCULATOR']['AL1010'])
        self.assertTrue(source_model('steel_board')['schedule']['line_numbers'])

    def test_spray_location_is_text_and_existing_engine_line_links_remain_read_only(self):
        raw = load_workbook_catalog('steel_vermiculite')
        model = source_model('steel_vermiculite')
        source = sheet(raw, 'SCHEDULE')
        runtime = sheet(model, 'SCHEDULE')
        self.assertFalse(any(address.startswith('AA') for address in source['cells']))
        self.assertEqual(runtime['cells']['Z1009'], source['cells']['Z1009'])
        self.assertEqual(model['tables']['Tbl_10']['columns'][-2]['name'], 'Line ID')
        self.assertEqual(model['tables']['Tbl_10']['columns'][-1]['name'], 'Location')
        value = 'Level 03 / Zone A - 12.3456789'
        inputs = {'SCHEDULE': {'AA10': value, 'AA509': 'Middle', 'AA1009': 'Last location'}}
        self.assertEqual(normalize_calculator_inputs('steel_vermiculite', inputs), inputs)
        for invalid in ({'Z1009': 999}, {'AA1010': 'Past capacity'}):
            with self.assertRaises(ValidationError):
                normalize_calculator_inputs('steel_vermiculite', {'SCHEDULE': invalid})
        metadata = next(item for item in calculator_definition('steel_vermiculite')['sheets'] if item['name'] == 'SCHEDULE')
        self.assertEqual(metadata['display_column_order'][:3], [26, 27, 1])
        self.assertEqual(metadata['max_column'], 27)
        self.assertNotIn(26, metadata['hidden_columns'])
        self.assertNotIn(27, metadata['hidden_columns'])
        original = WorkbookEngine(model)
        changed = WorkbookEngine(model, inputs)
        for name, addresses in (('SCHEDULE', ('A5', 'G5', 'R10', 'T10')), ('BAGS', ('E20', 'G20'))):
            for address in addresses:
                self.assertEqual(original.value(name, address), changed.value(name, address))

    def test_thousand_board_items_match_native_rows_and_independent_pooled_orders(self):
        raw = load_workbook_catalog('steel_board')
        model = source_model('steel_board')
        source = sheet(raw, 'CALCULATOR')['cells']
        native = read_fixture('steel_board', 'default')['scenarios'][0]['expected']['CALCULATOR']
        samples = (9, 10, 17, 25)  # Four products, including native double-layer stacks.
        columns = [field['column'] for field in model['schedule']['columns'] if field['editable']]
        values, assignments = {}, {}
        for line in range(1000):
            row, sample = line + 9, samples[line % len(samples)]
            assignments[row] = sample
            values.update({f'{column}{row}': source.get(f'{column}{sample}', {}).get('value') for column in columns})
        # This used but unquantified item lies beyond the original 200 rows.
        incomplete_row = 209
        incomplete_product = values[f'C{incomplete_row}']
        for column in columns:
            values[f'{column}{incomplete_row}'] = incomplete_product if column == 'C' else None
        engine = WorkbookEngine(model, normalize_calculator_inputs('steel_board', {'CALCULATOR': values}))
        counts = Counter(sample for row, sample in assignments.items() if row != incomplete_row)
        for row, sample in assignments.items():
            if row == incomplete_row:
                continue
            for column in ('AD', 'AE', 'AF', 'AG', 'AJ', 'AK', 'AL', 'AM', 'AR', 'AZ', 'BA'):
                self.assertTrue(excel_equal(engine.value('CALCULATOR', f'{column}{row}'), native[f'{column}{sample}']), (row, sample, column))
        self.assertEqual(engine.value('CALCULATOR', 'BD209'), 1)
        self.assertEqual(engine.value('CALCULATOR', 'AE209'), '')
        expected_net, expected_waste = defaultdict(float), defaultdict(float)
        expected_box = defaultdict(float)
        for sample, count in counts.items():
            product = source[f'C{sample}']['value']
            expected_box[product] += native[f'AD{sample}'] * count
            for thickness, net, waste in (('AJ', 'AL', 'AZ'), ('AK', 'AM', 'BA')):
                key = product, native[f'{thickness}{sample}']
                expected_net[key] += native[f'{net}{sample}'] * count
                expected_waste[key] += native[f'{waste}{sample}'] * count
        stock = sheet(raw, 'BOARD SUMMARY')['cells']
        total_sheets, total_purchase = 0, 0
        for row in range(12, 30):
            key = stock[f'A{row}']['value'], stock[f'B{row}']['value']
            area = stock[f'C{row}']['value'] * stock[f'D{row}']['value'] / 1_000_000
            whole = math.ceil(expected_waste[key] / area)
            for column, expected in (('E', expected_net[key]), ('G', expected_net[key]), ('H', expected_waste[key]), ('I', whole), ('J', whole * area)):
                self.assertTrue(excel_equal(engine.value('BOARD SUMMARY', f'{column}{row}'), expected), (row, column, expected))
            total_sheets += whole
            total_purchase += whole * area
        self.assertTrue(excel_equal(engine.value('BOARD SUMMARY', 'A6'), sum(expected_net.values())))
        self.assertEqual(engine.value('BOARD SUMMARY', 'E6'), total_sheets)
        self.assertTrue(excel_equal(engine.value('BOARD SUMMARY', 'I6'), total_purchase))
        for totals in _board_product_totals(engine):
            self.assertTrue(excel_equal(totals['box_reference_area'], expected_box[totals['product']]))
            self.assertEqual(totals['incomplete_rows'], int(totals['product'] == incomplete_product))

    def test_thousand_duct_items_match_native_rows_and_all_product_summaries(self):
        raw = load_workbook_catalog('ductwork')
        model = source_model('ductwork')
        source = sheet(raw, 'CALCULATOR')['cells']
        native = read_fixture('ductwork', 'default')['scenarios'][0]['expected']['CALCULATOR']
        values, assignments = {}, {}
        for line in range(1000):
            row, sample = line + 11, (11, 12, 13)[line % 3]
            assignments[row] = sample
            values.update({f'{column}{row}': source[f'{column}{sample}'].get('value') for column in 'BCDEFGHI'})
        incomplete_row = 311
        incomplete_product = values[f'C{incomplete_row}']
        for column in 'BCDEFGHI':
            values[f'{column}{incomplete_row}'] = incomplete_product if column == 'C' else None
        engine = WorkbookEngine(model, normalize_calculator_inputs('ductwork', {'CALCULATOR': values}), approved_formula_overrides('ductwork'))
        counts = Counter(sample for row, sample in assignments.items() if row != incomplete_row)
        for row, sample in assignments.items():
            self.assertEqual(engine.value('CALCULATOR', f'A{row}'), row - 10)
            if row == incomplete_row:
                continue
            for column in ('J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'V', 'W', 'X', 'Z', 'AA', 'AE', 'AG', 'AI', 'AJ', 'AN', 'AO'):
                self.assertTrue(excel_equal(engine.value('CALCULATOR', f'{column}{row}'), native[f'{column}{sample}']), (row, sample, column))
        self.assertEqual(engine.value('CALCULATOR', 'CB311'), False)
        for summary_row, sample in ((9, 11), (10, 12), (11, 13)):
            count = counts[sample]
            product = source[f'C{sample}']['value']
            self.assertEqual(engine.value('SUMMARY', f'B{summary_row}'), count + int(product == incomplete_product))
            self.assertEqual(engine.value('SUMMARY', f'I{summary_row}'), int(product == incomplete_product))
            mapped = [('C', 'K'), ('H', 'AJ')] + ([('D', 'M')] if sample != 13 else [('E', 'N'), ('F', 'O'), ('G', 'P')])
            for summary_column, source_column in mapped:
                expected = native[f'{source_column}{sample}'] * count
                self.assertTrue(excel_equal(engine.value('SUMMARY', f'{summary_column}{summary_row}'), expected), (summary_row, summary_column))


if __name__ == '__main__':
    unittest.main()
