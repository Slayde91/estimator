"""Presentation changes retain source inputs, validation and purchasing totals."""

import hashlib
import unittest

from estimator.workbook_calculators import (
    _validation, calculate_page, calculator_definition, normalize_calculator_inputs, source_model,
)
from estimator.workbook_catalog import DATA_DIRECTORY, editable_cells, load_workbook_catalog
from estimator.workbook_runtime import application_editable_cells
from tests.test_calculator_section_navigation import digest, visible
from tests.test_workbook_parity import read_fixture


IDENTITIES = ('steel_vermiculite', 'steel_board', 'ductwork')
BOARD_PRODUCTS = ['TRAFALGAR COREX', 'PROMATECT 250', 'PROMATECT 100', 'PROMATECT-XS']
NATIVE_RANGES = (
    ('steel_board', 'CALCULATOR', 'CDHJ', 9, 1008),
    ('steel_board', 'EXTRA BOARDS', 'BC', 6, 45),
    ('ductwork', 'CALCULATOR', 'CEHI', 11, 1010),
)


def source_sheet(identity, name):
    return next(sheet for sheet in source_model(identity)['sheets'] if sheet['name'] == name)


def page_cells(identity, name, row, count=1, inputs=None):
    page = calculate_page(identity, inputs or {}, name, row, count)
    return {cell['address']: cell for line in page['rows'] for cell in line['cells']}


class WorkbookCalculatorCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in DATA_DIRECTORY.glob('*.json.gz')}
        cls.source_digests = {identity: digest(source_model(identity)) for identity in IDENTITIES}
        cls.package_digests = {identity: digest(load_workbook_catalog(identity)) for identity in IDENTITIES}
        cls.definitions = {identity: calculator_definition(identity) for identity in IDENTITIES}

    def metadata(self, identity, name):
        return next(sheet for sheet in self.definitions[identity]['sheets'] if sheet['name'] == name)

    def test_quick_calculator_title_and_subtitle_are_display_only(self):
        metadata = self.metadata('steel_vermiculite', 'CALCULATOR')
        source = source_sheet('steel_vermiculite', 'CALCULATOR')
        self.assertEqual(metadata['display_text']['A1'], 'QUICK CALCULATOR')
        self.assertEqual(source['cells']['A1']['value'], 'CEASEFIRE  |  STEEL FIRE PROTECTION')
        self.assertIn('Five products', source['cells']['A3']['value'])
        self.assertIn(3, metadata['omitted_rows'])
        self.assertTrue(visible(metadata, 'A1'))
        self.assertEqual([(table['first_row'], table['last_row'])
                          for table in metadata['presentation_tables']], [(5, 24), (5, 24), (26, 30)])
        self.assertTrue(all(visible(metadata, address)
                            for address in editable_cells('steel_vermiculite', 'CALCULATOR')))
        # The raw page still carries the original subtitle for other consumers.
        self.assertEqual(page_cells('steel_vermiculite', 'CALCULATOR', 3)['A3']['value'],
                         source['cells']['A3']['value'])

    def test_start_hides_only_requested_operating_notes_and_keeps_source_evidence(self):
        metadata = self.metadata('steel_vermiculite', 'SETTINGS')
        source = source_sheet('steel_vermiculite', 'SETTINGS')
        removed = {*range(304, 308), *range(316, 320)}
        self.assertEqual(set(metadata['omitted_rows']) & set(range(270, 341)), removed)
        self.assertEqual(source['cells']['A304']['value'], 'SOURCE CONFLICTS')
        self.assertEqual(source['cells']['A316']['value'], 'ORIGINAL TAKE-OFF')
        for first, last in ((304, 307), (316, 319)):
            cells = page_cells('steel_vermiculite', 'SETTINGS', first, last - first + 1)
            for address in (f'A{first}', f'A{first + 1}'):
                self.assertFalse(visible(metadata, address))
                self.assertEqual(cells[address]['value'], source['cells'][address]['value'])
        for address in ('A308', 'A309', 'A312', 'A313', 'A320'):
            self.assertTrue(visible(metadata, address), address)
        self.assertTrue(all(visible(metadata, address)
                            for address in editable_cells('steel_vermiculite', 'SETTINGS')))
        # Section IDs in the hidden BM source column share the omitted row numbers.
        for row in removed:
            self.assertTrue(source['cells'][f'BM{row}']['value'])

    def test_short_factor_titles_and_moved_intro_keep_canonical_settings_identity(self):
        metadata = self.metadata('steel_vermiculite', 'SETTINGS')
        source = source_sheet('steel_vermiculite', 'SETTINGS')
        for address, title in (('A356', 'IDEALISED HOLLOW GEOMETRY'),
                               ('A370', 'FENDOLITE CASTELLATED SECTION')):
            self.assertEqual(metadata['display_text'][address], title)
            self.assertEqual(next(section['label'] for section in metadata['settings_sections']
                                  if section['id'] == address), title)
            self.assertTrue(source['cells'][address]['value'].startswith(title + '  |  '))
        pages = {page['id']: page for page in self.definitions['steel_vermiculite']['display_pages']}
        self.assertEqual((pages['START']['intro_address'], pages['START']['intro_after_address']),
                         ('A7', 'A270'))
        self.assertEqual(pages['SETTINGS']['hidden_common_addresses'], ['A7'])
        self.assertEqual(pages['START']['sheet'], 'SETTINGS')
        self.assertEqual(pages['SETTINGS']['sheet'], 'SETTINGS')
        self.assertNotIn('intro_address', pages['FACTOR CALCS'])
        self.assertTrue(visible(metadata, 'A7'))
        self.assertIn('Factor helper starts at row 341.', source['cells']['A7']['value'])
        self.assertEqual(page_cells('steel_vermiculite', 'SETTINGS', 7)['A7']['value'],
                         source['cells']['A7']['value'])

    def test_native_dropdown_metadata_covers_every_prepared_row_and_no_other_fields(self):
        for identity, name, columns, first, last in NATIVE_RANGES:
            with self.subTest(identity=identity, sheet=name):
                metadata = self.metadata(identity, name)
                source = source_sheet(identity, name)
                expected = {f'{column}{row}' for column in columns for row in range(first, last + 1)}
                self.assertEqual({address for address, display in metadata['display_cells'].items()
                                  if display.get('control') == 'select'}, expected)
                self.assertTrue(expected <= application_editable_cells(identity, name))
                for address in expected:
                    self.assertTrue(visible(metadata, address), address)
                    self.assertEqual(_validation(source, address)['type'], 'list', address)

    def test_board_native_choices_keep_full_library_and_warning_rules(self):
        library = source_sheet('steel_board', 'STEEL LIBRARY')['cells']
        steel_ids = [library[f'A{row}']['value'] for row in range(6, 1348)]
        self.assertEqual(len(steel_ids), 1342)
        source = source_sheet('steel_board', 'CALCULATOR')
        for row in (9, 208, 1008):
            cells = page_cells('steel_board', 'CALCULATOR', row)
            self.assertEqual(cells[f'C{row}']['options'], BOARD_PRODUCTS)
            self.assertEqual(cells[f'D{row}']['options'], steel_ids)
            for column in 'CDHJ':
                cell = cells[f'{column}{row}']
                self.assertTrue(cell['editable'])
                self.assertEqual(cell['type'], 'select')
                self.assertEqual(cell['value'], source['cells'].get(cell['address'], {}).get('value'))
                self.assertEqual(cell['allow_other'], column in 'HJ')
                self.assertEqual(cell['error_style'], 'warning' if column in 'HJ' else 'stop')
                self.assertEqual(cell['validation']['allowBlank'], '1')
        settings = source_sheet('steel_board', 'SETTINGS')['cells']
        for product, column, last in zip(BOARD_PRODUCTS, 'GHIJ', (10, 9, 10, 9)):
            inputs = {'CALCULATOR': {'C208': product, 'I208': 'Beam'}}
            cells = page_cells('steel_board', 'CALCULATOR', 208, inputs=inputs)
            self.assertEqual(cells['H208']['options'],
                             [settings[f'{column}{row}']['value'] for row in range(6, last + 1)])
            self.assertEqual(cells['J208']['options'], [550, 620] if product == 'PROMATECT 100' else [620])
        cells = page_cells('steel_board', 'CALCULATOR', 208, inputs={
            'CALCULATOR': {'C208': 'PROMATECT 100', 'I208': 'Column', 'H208': 75, 'J208': 612}})
        self.assertEqual(cells['J208']['options'], [550])
        self.assertEqual((cells['H208']['value'], cells['J208']['value']), (75, 612))
        self.assertTrue(cells['H208']['allow_other'] and cells['J208']['allow_other'])

    def test_extra_board_and_duct_dropdowns_preserve_permissive_lists_and_custom_values(self):
        application_cells = source_sheet('ductwork', 'PRODUCT SETTINGS')['cells']
        choices = {
            ('steel_board', 'EXTRA BOARDS'): {
                'B': BOARD_PRODUCTS, 'C': [8, 10, 12, 12.5, 15, 18, 20, 25, 30]},
            ('ductwork', 'CALCULATOR'): {
                'C': ['CAFCO 300', 'MONOKOTE', 'FyreWrap'],
                'E': [60, 90, 120, 180, '60/60/60', '90/90/90', '120/120/120',
                      '180/180/180', '240/240/180', '120/120/-', '120/120/60'],
                'H': [application_cells[f'J{row}']['value'] for row in range(137, 150)],
                'I': ['Horizontal', 'Vertical', 'Mixed', 'Both']},
        }
        for identity, name, _, first, last in NATIVE_RANGES[1:]:
            source = source_sheet(identity, name)
            for row in (first, last):
                cells = page_cells(identity, name, row)
                for column, expected in choices[(identity, name)].items():
                    cell = cells[f'{column}{row}']
                    self.assertEqual(cell['options'], expected)
                    self.assertEqual(cell['type'], 'select')
                    self.assertTrue(cell['editable'] and cell['allow_other'])
                    self.assertEqual(cell['error_style'], 'stop')
                    self.assertNotIn('showErrorMessage', _validation(source, cell['address']))
                    self.assertEqual(cell['value'], source['cells'].get(cell['address'], {}).get('value'))
        cases = (
            ('steel_board', 'EXTRA BOARDS', 45, {'B45': 'Custom board', 'C45': 13.75}),
            ('ductwork', 'CALCULATOR', 1010, {'C1010': 'Custom product', 'E1010': '75/75/75',
                                           'H1010': 'Custom application', 'I1010': 'Custom orientation'}),
        )
        for identity, name, row, custom in cases:
            inputs = {name: custom}
            self.assertEqual(normalize_calculator_inputs(identity, inputs), inputs)
            cells = page_cells(identity, name, row, inputs=inputs)
            for address, value in custom.items():
                self.assertEqual(cells[address]['value'], value)
                self.assertTrue(cells[address]['allow_other'])
            cleared = {name: dict.fromkeys(custom, '')}
            self.assertEqual(normalize_calculator_inputs(identity, cleared), {name: dict.fromkeys(custom)})

    def test_board_unit_suffixes_preserve_raw_numbers_whole_sheets_cards_and_warning(self):
        metadata = self.metadata('steel_board', 'BOARD SUMMARY')
        source = source_sheet('steel_board', 'BOARD SUMMARY')['cells']
        expected_suffixes = {f'{column}{row}': ' mm' for column in 'BCD' for row in range(12, 30)}
        expected_suffixes.update({f'J{row}': ' m²' for row in range(12, 30)})
        self.assertEqual({address: display['suffix'] for address, display in metadata['display_cells'].items()
                          if 'suffix' in display}, expected_suffixes)
        self.assertEqual(metadata['presentation_tables'][0]['columns'], [1, 2, 3, 4, 9, 10])
        cells = page_cells('steel_board', 'BOARD SUMMARY', 6, 24)
        oracle = read_fixture('steel_board', 'default')['scenarios'][0]['expected']
        for address in expected_suffixes:
            cell = cells[address]
            self.assertIsInstance(cell['value'], (int, float), address)
            expected = oracle['BOARD SUMMARY'][address] if address.startswith('J') else source[address]['value']
            self.assertAlmostEqual(cell['value'], expected, places=10, msg=address)
        for address in ('A6', 'E6', 'I6', *(f'I{row}' for row in range(12, 30))):
            self.assertNotIn('suffix', metadata['display_cells'].get(address, {}))
            self.assertTrue(visible(metadata, address))
            self.assertAlmostEqual(cells[address]['value'], oracle['BOARD SUMMARY'][address], places=10)
        warning = page_cells('steel_board', 'CALCULATOR', 6)['Y6']
        self.assertTrue(warning['calculated'])
        self.assertEqual(warning['value'], oracle['CALCULATOR']['Y6'])
        self.assertIn('Incomplete order:', warning['value'])

    def test_duct_summary_spacing_keeps_table_columns_and_interpretation_notes(self):
        metadata = self.metadata('ductwork', 'SUMMARY')
        self.assertTrue(metadata['section_spacing'])
        self.assertEqual(metadata['table_layout'], 'inline')
        self.assertEqual([(table['first_row'], table['last_row'], table['columns'])
                          for table in metadata['presentation_tables']], [
            (8, 11, list(range(1, 11))), (18, 26, list(range(1, 7))),
            (30, 32, list(range(1, 4))), (39, 41, list(range(1, 8)))])
        for address in ('A14', 'A17', 'A29', 'A35', 'A38'):
            self.assertTrue(visible(metadata, address), address)
            self.assertTrue(source_sheet('ductwork', 'SUMMARY')['cells'][address]['value'])
        for identity, definition in self.definitions.items():
            for sheet in definition['sheets']:
                if (identity, sheet['name']) != ('ductwork', 'SUMMARY'):
                    self.assertFalse(sheet['section_spacing'])

    def test_z_presentation_metadata_is_detached_and_all_source_packages_remain_unchanged(self):
        for identity in IDENTITIES:
            original = self.definitions[identity]
            altered = calculator_definition(identity)
            for sheet in altered['sheets']:
                sheet['display_cells']['TEST1'] = {'control': 'Caller control'}
                sheet['display_text']['TEST1'] = 'Caller title'
                sheet['omitted_rows'].append(99999)
            altered['display_pages'][0].setdefault('hidden_common_addresses', []).append('Caller address')
            fresh = calculator_definition(identity)
            self.assertEqual(fresh, original)
            self.assertEqual(digest(source_model(identity)), self.source_digests[identity])
            self.assertEqual(digest(load_workbook_catalog(identity)), self.package_digests[identity])
            self.assertEqual(source_model(identity)['source']['sha256'], read_fixture(identity, 'default')['source_sha256'])
        self.assertEqual({path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in DATA_DIRECTORY.glob('*.json.gz')}, self.package_hashes)


if __name__ == '__main__':
    unittest.main()
