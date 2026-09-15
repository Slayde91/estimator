"""Browser-only tabs keep the original calculator sheets and input contracts."""

from copy import deepcopy
import unittest

from estimator.catalog import ValidationError
from estimator.workbook_calculators import (
    calculate_page, calculator_definition, input_field, normalize_calculator_inputs, source_model,
)
from estimator.workbook_catalog import editable_cells
from tests.test_calculator_section_navigation import contains, digest
from tests.test_workbook_parity import read_fixture


SOURCE_PAGES = ['CALCULATOR', 'SCHEDULE', 'BAGS', 'SETTINGS']
DISPLAY_PAGES = ['START', 'CALCULATOR', 'SCHEDULE', 'BAGS', 'SETTINGS', 'FACTOR CALCS']
ALIASES = {
    'A9': 'GLOBAL SETTINGS', 'A17': 'COMMON CALCULATION RULES', 'A31': 'CAFCO 300',
    'A64': 'MANDOLITE CP2', 'A96': 'FENDOLITE MII', 'A173': 'PERLIFOC HP ECO+',
    'A229': 'MONOKOTE MK-6 HY', 'A270': 'COMPLETE WORKBOOK OPERATING RULES',
}
REFERENCES = {'D42', 'D75', 'D107', 'D184', 'D240'}


class CalculatorDisplayTabsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.definitions = {identity: calculator_definition(identity)
                           for identity in ('steel_vermiculite', 'steel_board', 'ductwork')}

    def metadata(self, identity, sheet):
        return next(value for value in self.definitions[identity]['sheets'] if value['name'] == sheet)

    def test_six_display_tabs_keep_four_original_source_pages(self):
        definition = self.definitions['steel_vermiculite']
        pages = definition['display_pages']
        self.assertEqual([page['id'] for page in pages], DISPLAY_PAGES)
        self.assertEqual([page['label'] for page in pages], DISPLAY_PAGES)
        self.assertEqual([page['sheet'] for page in pages],
                         ['SETTINGS', 'CALCULATOR', 'SCHEDULE', 'BAGS', 'SETTINGS', 'SETTINGS'])
        self.assertEqual(definition['pages'], SOURCE_PAGES)
        self.assertEqual(source_model('steel_vermiculite')['pages'], SOURCE_PAGES)
        self.assertEqual([sheet['name'] for sheet in definition['sheets']], SOURCE_PAGES)
        self.assertEqual(pages[0]['section_ids'], ['A270'])
        self.assertEqual(pages[0]['section_mode'], 'content')
        self.assertFalse(pages[0]['include_common'])
        self.assertEqual(pages[4]['section_ids'], ['A9', 'A17', 'A31', 'A64', 'A96', 'A173', 'A229'])
        self.assertTrue(pages[4]['include_common'])
        self.assertEqual(pages[5]['section_ids'], ['A341', 'A356', 'A370'])
        self.assertFalse(pages[5]['include_common'])
        for identity in ('steel_board', 'ductwork'):
            original = self.definitions[identity]
            self.assertEqual(original['display_pages'], [
                {'id': sheet, 'label': sheet, 'sheet': sheet} for sheet in original['pages']])

    def test_settings_sections_and_all_inputs_belong_to_one_display_tab(self):
        metadata = self.metadata('steel_vermiculite', 'SETTINGS')
        sections = {section['id']: section for section in metadata['settings_sections']}
        pages = [page for page in self.definitions['steel_vermiculite']['display_pages']
                 if page['sheet'] == 'SETTINGS']
        assigned = [section for page in pages for section in page['section_ids']]
        self.assertEqual(len(assigned), 11)
        self.assertEqual(set(assigned), set(sections))
        self.assertEqual(len(set(assigned)), len(assigned))
        source = next(sheet for sheet in source_model('steel_vermiculite')['sheets'] if sheet['name'] == 'SETTINGS')
        counts = {'START': 0, 'SETTINGS': 0, 'FACTOR CALCS': 0}
        readonly = []
        for address in editable_cells('steel_vermiculite', 'SETTINGS'):
            owners = [page['id'] for page in pages if any(
                contains(reference, address) for section_id in page['section_ids']
                for reference in sections[section_id]['ranges'])]
            self.assertEqual(len(owners), 1, address)
            if input_field('steel_vermiculite', source, address).get('read_only'):
                readonly.append(address)
                self.assertEqual(owners, ['SETTINGS'])
            else:
                counts[owners[0]] += 1
        self.assertEqual(counts, {'START': 0, 'SETTINGS': 25, 'FACTOR CALCS': 9})
        self.assertEqual(set(readonly), REFERENCES)
        for virtual in ('START', 'FACTOR CALCS'):
            with self.assertRaises(ValidationError):
                normalize_calculator_inputs('steel_vermiculite', {virtual: {'D346': 2}})
            with self.assertRaises(ValidationError):
                calculate_page('steel_vermiculite', {}, virtual)
        inputs = {'SETTINGS': {'D346': 1.2345678901234567, 'D358': 'RHS', 'D372': 24.56789}}
        self.assertEqual(normalize_calculator_inputs('steel_vermiculite', inputs), inputs)

    def test_display_page_metadata_is_detached_and_source_identity_is_unchanged(self):
        for identity in self.definitions:
            with self.subTest(identity=identity):
                model = source_model(identity)
                before = digest(model)
                definition = calculator_definition(identity)
                original = deepcopy(definition['display_pages'])
                definition['display_pages'][0]['label'] = 'Caller title'
                definition['display_pages'][0].setdefault('section_ids', []).append('Caller section')
                definition['display_pages'].append({'id': 'Caller tab', 'sheet': 'Caller sheet'})
                self.assertEqual(calculator_definition(identity)['display_pages'], original)
                self.assertEqual(digest(source_model(identity)), before)
                self.assertEqual(model['source']['sha256'], read_fixture(identity, 'default')['source_sha256'])

    def test_numbered_section_aliases_preserve_original_source_text(self):
        metadata = self.metadata('steel_vermiculite', 'SETTINGS')
        source = next(sheet for sheet in source_model('steel_vermiculite')['sheets'] if sheet['name'] == 'SETTINGS')
        for address, expected in ALIASES.items():
            with self.subTest(address=address):
                self.assertEqual(metadata['display_text'][address], expected)
                self.assertEqual(next(section['label'] for section in metadata['settings_sections']
                                      if section['title_address'] == address), expected)
                self.assertRegex(source['cells'][address]['value'], r'^\d{2}\s+/\s+')
                self.assertTrue(source['cells'][address]['value'].endswith(expected))
        for address in ('A341', 'A356', 'A370'):
            self.assertNotIn(address, metadata['display_text'])

    def test_section_id_native_dropdown_keeps_every_source_choice_and_strict_rule(self):
        metadata = self.metadata('steel_vermiculite', 'SCHEDULE')
        model = source_model('steel_vermiculite')
        source = next(sheet for sheet in model['sheets'] if sheet['name'] == 'SETTINGS')
        options = [source['cells'][f'BM{row}']['value'] for row in range(6, 559)]
        self.assertEqual(model['defined_names']['SectionList'], 'SETTINGS!$BM$6:$BM$558')
        self.assertEqual(len(options), 553)
        self.assertEqual(len(set(options)), 553)
        self.assertEqual(options[0], '1000WB215')
        self.assertEqual(options[-1], 'Z350-32H')
        for row in (10, 1009):
            result = calculate_page('steel_vermiculite', {}, 'SCHEDULE', row, 1)
            cell = next(cell for cell in result['rows'][0]['cells'] if cell['address'] == f'F{row}')
            self.assertEqual(cell['options'], options)
            self.assertEqual(cell['type'], 'select')
            self.assertTrue(cell['editable'])
            self.assertFalse(cell['allow_other'])
            self.assertEqual(cell['error_style'], 'stop')
            self.assertEqual(cell['validation']['allowBlank'], '1')
            self.assertEqual(cell['validation']['formula1'], 'SectionList')
        self.assertEqual({address for address, display in metadata['display_cells'].items()
                          if display.get('control') == 'select'}, {f'F{row}' for row in range(10, 1010)})

    def test_display_only_weight_and_thickness_highlight_have_exact_scopes(self):
        schedule = self.metadata('steel_vermiculite', 'SCHEDULE')['display_cells']
        self.assertEqual({address for address, display in schedule.items() if display.get('bold') is False},
                         {f'Y{row}' for row in range(10, 1010)})
        self.assertNotIn('Y9', schedule)
        self.assertTrue(all(schedule[f'C{row}']['bold'] for row in range(10, 1010)))
        calculator = self.metadata('steel_vermiculite', 'CALCULATOR')
        self.assertEqual(calculator['display_cells']['H6'],
                         {'align': 'left', 'suffix': ' mm', 'highlight': 'published-thickness'})
        self.assertEqual(calculator['display_text']['L6'], 'PUBLISHED VALUE')
        result = calculate_page('steel_vermiculite', {}, 'CALCULATOR', 6, 1)
        thickness = next(cell for cell in result['rows'][0]['cells'] if cell['address'] == 'H6')
        self.assertEqual(thickness['value'], 26)
        self.assertIsInstance(thickness['value'], (int, float))
        board = self.metadata('steel_board', 'SETTINGS')['display_cells']
        self.assertEqual({address for address, display in board.items() if display.get('bold') is True},
                         {f'A{row}' for row in range(6, 35)} | {f'P{row}' for row in range(6, 52)})
        self.assertNotIn('A5', board)
        self.assertNotIn('P5', board)

    def test_material_form_keeps_its_title_and_subtitle_when_tables_move(self):
        metadata = self.metadata('steel_vermiculite', 'BAGS')
        form, order = metadata['presentation_tables']
        self.assertEqual(metadata['display_table_order'], [1, 0])
        self.assertEqual((form['first_row'], form['last_row']), (1, 15))
        self.assertEqual((form['title_address'], form['subtitle_address']), ('A1', 'A3'))
        self.assertEqual((order['first_row'], order['last_row'], order['title_address']), (17, 24, 'A17'))
        source = next(sheet for sheet in source_model('steel_vermiculite')['sheets'] if sheet['name'] == 'BAGS')
        self.assertIn('CEASEFIRE', source['cells']['A1']['value'])
        self.assertTrue(source['cells']['A3']['value'])
        for address in editable_cells('steel_vermiculite', 'BAGS'):
            self.assertTrue(contains('A1:N15', address))
        duct = self.metadata('ductwork', 'SUMMARY')
        self.assertEqual(duct['navigation_mode'], 'hidden')
        self.assertEqual(len(duct['presentation_tables']), 4)
        self.assertEqual(duct['section_cells'], ['A17', 'A29', 'A38'])


if __name__ == '__main__':
    unittest.main()
