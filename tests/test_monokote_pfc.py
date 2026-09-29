"""Retained named PFC data must calculate without widening its source scope."""

from copy import copy
from io import BytesIO
import unittest

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.calculator_defaults import default_calculator_inputs
from estimator.excel_engine import WorkbookEngine
from estimator.monokote_pfc import application_formula_overrides
from estimator.calculator_register import build_calculator_register
from estimator.calculator_report import build_calculator_report, project_calculator_report
from estimator.workbook_calculators import calculator_session, source_model


def row_inputs(product='MONOKOTE MK-6 HY', *, row=10, **changes):
    inputs = default_calculator_inputs('steel_vermiculite')
    values = {'A': 'Channel review', 'B': product, 'C': 'PFC web to slab - 3 sides',
              'D': 620, 'E': 'Section', 'F': '250X90PFC', 'H': 120, 'I': 2, 'J': 3}
    values.update(changes)
    inputs['SCHEDULE'] = {f'{column}{row}': value for column, value in values.items()}
    inputs['CALCULATOR'] = {f'D{target}': values.get(column) for target, column in (
        (6, 'B'), (7, 'C'), (8, 'D'), (9, 'E'), (10, 'F'), (11, 'G'), (12, 'H'),
        (14, 'I'), (15, 'J'), (16, 'K'), (17, 'L'))}
    return inputs


class MonokotePfcTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = source_model('steel_vermiculite')
        cls.data = next(sheet['cells'] for sheet in cls.model['sheets'] if sheet['name'] == 'THICKNESS DATA')
        cls.overrides = application_formula_overrides(cls.model)

    def test_all_retained_named_sections_and_periods_both_products_quantify(self):
        inputs = row_inputs()
        inputs['SCHEDULE'] = {}
        cases = []
        source_rows = [int(address[1:]) for address, cell in self.data.items()
                       if address.startswith('A') and address[1:].isdigit()
                       and str(cell.get('value', '')).startswith('MONOKOTE MK-6 HY|PFC3W|620|')]
        self.assertEqual(len(source_rows), 10)
        for product in ('MONOKOTE MK-6 HY', 'MONOKOTE Z106'):
            for source_row in source_rows:
                section = self.data[f'E{source_row}']['value']
                for period, column in ((60, 'M'), (90, 'N'), (120, 'O'), (180, 'P'), (240, 'Q')):
                    row = 10 + len(cases)
                    inputs['SCHEDULE'].update(row_inputs(product, row=row, F=section, H=period)['SCHEDULE'])
                    cases.append((row, source_row, column, product))
        original = WorkbookEngine(self.model, inputs)
        engine = calculator_session('steel_vermiculite', inputs)[1]
        self.assertEqual(len(cases), 100)
        for row, source_row, source_column, product in cases:
            with self.subTest(row=row, product=product):
                expected = self.data[f'{source_column}{source_row}']['value']
                self.assertEqual(original.value('SCHEDULE', f'V{row}'), 'CALCULATION ERROR')
                self.assertEqual(original.value('SCHEDULE', f'O{row}'), expected)
                self.assertEqual(engine.value('SCHEDULE', f'O{row}'), expected)
                self.assertEqual(engine.value('SCHEDULE', f'P{row}'), expected)
                self.assertEqual(engine.value('SCHEDULE', f'V{row}'), 'PUBLISHED - TABLE LOOKUP')
                self.assertEqual(engine.value('SCHEDULE', f'W{row}'), 'QUANTIFIED - ESTIMATE')
                self.assertEqual(engine.value('SCHEDULE', f'X{row}'), 'MK6-030521 p15')
                girth = original.value('SCHEDULE', f'Q{row}')
                volume = 2 * 3 * girth * expected / 1000
                mass, density = (21.8, 344) if product == 'MONOKOTE MK-6 HY' else (22.2, 325)
                self.assertAlmostEqual(engine.value('SCHEDULE', f'S{row}'), volume)
                self.assertAlmostEqual(engine.value('SCHEDULE', f'T{row}'), volume / (mass / density))

    def test_unsupported_combinations_and_other_exposures_keep_original_results(self):
        changes = [{'H': 30}, {'H': 45}, {'D': 550}, {'E': 'Hp/A', 'G': 133},
                   {'E': 'ESA/M', 'G': 17}, {'F': '410UB54'}, {'F': '250PFC'},
                   {'F': ''}, {'C': 'Hollow - 3 sides', 'F': '100X100X9SHS'},
                   {'C': 'Hollow - 4 sides', 'D': 550, 'F': '100X100X9SHS'},
                   {'C': 'Re-entrant - 3 sides', 'F': '410UB54'}, {'B': 'CAFCO 300'}]
        for change in changes:
            inputs = row_inputs(**change)
            original = WorkbookEngine(self.model, inputs)
            repaired = WorkbookEngine(self.model, inputs, self.overrides)
            with self.subTest(change=change):
                for column in ('M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'):
                    self.assertEqual(repaired.value('SCHEDULE', column + '10'), original.value('SCHEDULE', column + '10'))

    def test_lookup_last_row_case_insensitive_inputs_and_existing_area_overrides(self):
        for product in ('MONOKOTE MK-6 HY', 'MONOKOTE Z106', 'monokote z106'):
            inputs = row_inputs(product, row=1009, C='pfc web to slab - 3 sides', F='250x90pfc', K=.8, L=7)
            engine = calculator_session('steel_vermiculite', inputs)[1]
            self.assertEqual(engine.value('SCHEDULE', 'P1009'), 19)
            self.assertEqual(engine.value('SCHEDULE', 'Q1009'), .8)
            self.assertEqual(engine.value('SCHEDULE', 'R1009'), 7)
            self.assertAlmostEqual(engine.value('SCHEDULE', 'S1009'), 7 * 19 / 1000)
            self.assertEqual(engine.value('CALCULATOR', 'H6'), 19)
            self.assertEqual(engine.value('CALCULATOR', 'H9'), 'PUBLISHED - TABLE LOOKUP')

    def test_invalid_quantity_or_material_settings_still_withhold_bags(self):
        for change in ({'I': None}, {'I': 0}, {'I': -1}, {'I': 1.5}, {'J': 0}):
            engine = calculator_session('steel_vermiculite', row_inputs(**change))[1]
            with self.subTest(change=change):
                self.assertEqual(engine.value('SCHEDULE', 'T10'), '')
                self.assertNotEqual(engine.value('SCHEDULE', 'W10'), 'QUANTIFIED - ESTIMATE')
        for address, value in (('D235', 0), ('D237', -1)):
            inputs = row_inputs()
            inputs['SETTINGS'][address] = value
            engine = calculator_session('steel_vermiculite', inputs)[1]
            with self.subTest(address=address):
                self.assertNotEqual(engine.value('SCHEDULE', 'W10'), 'QUANTIFIED - ESTIMATE')

    def test_original_flags_remain_authoritative_and_guard_shape_is_checked(self):
        inputs = row_inputs()
        # Supply source flags through the existing formula-overrides boundary;
        # do not modify the immutable model or disclose new publisher data.
        for flag, expected in [('EXCLUDED - REVIEW', 'EXCLUDED - REVIEW'),
                               ('RETIRED', 'EXCLUDED - RETIRED SOURCE'),
                               ('ESTIMATE - REVIEW', 'ESTIMATE - REVIEW')]:
            overrides = {'ENGINE': {**self.overrides['ENGINE'], 'AB3': f'"{flag}"'}}
            engine = WorkbookEngine(self.model, inputs, overrides)
            with self.subTest(flag=flag):
                self.assertEqual(engine.value('SCHEDULE', 'V10'), expected)
                if flag.startswith('ESTIMATE'):
                    self.assertEqual(engine.value('SCHEDULE', 'P10'), 19)
                else:
                    self.assertEqual(engine.value('SCHEDULE', 'P10'), '')
                    self.assertEqual(engine.value('SCHEDULE', 'T10'), '')
        unpublished = WorkbookEngine(self.model, inputs, {'ENGINE': {
            **self.overrides['ENGINE'], 'AA3': '"NP"'}})
        self.assertEqual(unpublished.value('SCHEDULE', 'V10'), 'NP - NOT PUBLISHED')
        self.assertEqual(unpublished.value('SCHEDULE', 'T10'), '')
        model = copy(self.model)
        model['sheets'] = [dict(sheet, cells=dict(sheet['cells'])) if sheet['name'] == 'ENGINE'
                           else sheet for sheet in self.model['sheets']]
        cells = next(sheet['cells'] for sheet in model['sheets'] if sheet['name'] == 'ENGINE')
        cells['CE3'] = dict(cells['CE3'], formula='TRUE')
        with self.assertRaisesRegex(ValueError, 'Unexpected Monokote named-lookup guard'):
            application_formula_overrides(model)

    def test_pfc_register_and_pdf_retain_source_and_quantities_without_hollow_receipt(self):
        for product in ('MONOKOTE MK-6 HY', 'monokote z106'):
            inputs = row_inputs(product, C='pfc web to slab - 3 sides')
            data = project_calculator_report('steel_vermiculite', inputs)
            self.assertEqual(data['rows'][0]['source_reference'], 'MK6-030521 p15')
            self.assertNotIn('assessment_evidence', data)
            workbook = load_workbook(BytesIO(build_calculator_register('steel_vermiculite', inputs)))
            row = next(row for row in workbook['Schedule'].values if row[2] == 'Channel review')
            self.assertEqual(row[7:9], (19, 19))
            self.assertIn('MK6-030521 p15', row[12])
            self.assertFalse(any(cell.data_type == 'f' for sheet in workbook for row in sheet for cell in row))
            pdf = PdfReader(BytesIO(build_calculator_report('steel_vermiculite', inputs)))
            text = '\n'.join(page.extract_text() for page in pdf.pages)
            self.assertIn('MK6-030521 p15', text)
            self.assertNotIn('FAR4856 Issue2 dataset', text)


if __name__ == '__main__':
    unittest.main()
