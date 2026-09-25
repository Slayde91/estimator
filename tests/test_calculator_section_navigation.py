"""Settings panels partition the visible source without changing input scope."""

from copy import deepcopy
import hashlib
import json
import unittest

from estimator.excel_engine import coordinates
from estimator.workbook_calculators import calculator_definition, input_field, source_model
from estimator.workbook_catalog import editable_cells


SECTIONS = {
    ('steel_vermiculite', 'SETTINGS'): [
        ('A9', 'A9:N16'), ('A17', 'A17:N30'), ('A31', 'A31:N63'), ('A64', 'A64:N95'),
        ('A96', 'A96:N172'), ('A173', 'A173:N228'), ('A229', 'A229:N269'),
        ('A270', 'A270:N340'), ('A341', 'A341:N355'), ('A356', 'A356:N369'),
        ('A370', 'A370:N374'), ('A559', 'A559:N568'),
    ],
    ('ductwork', 'PRODUCT SETTINGS'): [
        ('A6', 'A6:H46'), ('A48', 'A48:H92'), ('A94', 'A94:H151'),
        ('J94', 'J94:Q113'), ('J115', 'J115:Q149'),
    ],
    ('steel_board', 'SETTINGS'): [
        ('table-0', 'A5:C34'), ('table-1', 'G5:N10'), ('table-2', 'P5:Q51'),
    ],
}


def bounds(reference):
    first, last = reference.split(':')
    return (*coordinates(first), *coordinates(last))


def contains(reference, address):
    first_row, first_column, last_row, last_column = bounds(reference)
    row, column = coordinates(address)
    return first_row <= row <= last_row and first_column <= column <= last_column


def owners(metadata, address):
    return [section['id'] for section in metadata['settings_sections']
            if any(contains(reference, address) for reference in section['ranges'])]


def visible(metadata, address):
    row, column = coordinates(address)
    return (row not in metadata['omitted_rows'] and column not in metadata['hidden_columns']
            and column not in metadata['omitted_columns']
            and not any(contains(reference, address) for reference in metadata['omitted_ranges']))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class CalculatorSectionNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.definitions = {identity: calculator_definition(identity) for identity, _ in SECTIONS}

    def metadata(self, identity, name):
        return next(sheet for sheet in self.definitions[identity]['sheets'] if sheet['name'] == name)

    def test_exact_settings_sections_are_unique_and_have_source_labels(self):
        for (identity, name), expected in SECTIONS.items():
            with self.subTest(identity=identity):
                metadata = self.metadata(identity, name)
                self.assertEqual(metadata['navigation_mode'], 'select')
                sections = metadata['settings_sections']
                expected_ranges = [(section_id, [reference]) for section_id, reference in expected]
                if identity == 'ductwork':
                    expected_ranges[0][1].append('A161:H162')
                    expected_ranges[1][1].append('A163:H164')
                self.assertEqual([(section['id'], section['ranges']) for section in sections], expected_ranges)
                self.assertEqual(len({section['id'] for section in sections}), len(expected))
                source = next(sheet for sheet in source_model(identity)['sheets'] if sheet['name'] == name)
                for section in sections:
                    self.assertIsInstance(section['label'], str)
                    self.assertTrue(section['label'].strip())
                    if section.get('title_address'):
                        address = section['title_address']
                        expected_label = metadata['display_text'].get(address, source['cells'][address]['value'])
                        self.assertEqual(section['label'], expected_label)
                        self.assertEqual(owners(metadata, address), [section['id']])
                for index, section in enumerate(sections):
                    for other in sections[index + 1:]:
                        for left in section['ranges']:
                            r1, c1, r2, c2 = bounds(left)
                            for right in other['ranges']:
                                s1, d1, s2, d2 = bounds(right)
                                self.assertTrue(r2 < s1 or s2 < r1 or c2 < d1 or d2 < c1,
                                                (identity, left, right))

    def test_each_visible_setting_input_remains_in_exactly_one_panel(self):
        expected_editable = {'steel_vermiculite': 34, 'ductwork': 11, 'steel_board': 28}
        for identity, name in SECTIONS:
            with self.subTest(identity=identity):
                metadata = self.metadata(identity, name)
                source = next(sheet for sheet in source_model(identity)['sheets'] if sheet['name'] == name)
                count = 0
                for address in editable_cells(identity, name):
                    self.assertTrue(visible(metadata, address), (identity, address))
                    self.assertEqual(len(owners(metadata, address)), 1, (identity, address))
                    field = input_field(identity, source, address)
                    if not field.get('read_only'):
                        count += 1
                self.assertEqual(count, expected_editable[identity])

    def test_every_visible_body_value_and_merged_note_is_preserved(self):
        for identity, name in SECTIONS:
            with self.subTest(identity=identity):
                metadata = self.metadata(identity, name)
                source = next(sheet for sheet in source_model(identity)['sheets'] if sheet['name'] == name)
                first_row = min(bounds(reference)[0] for section in metadata['settings_sections']
                                for reference in section['ranges'])
                for address, cell in source['cells'].items():
                    if coordinates(address)[0] < first_row or not visible(metadata, address):
                        continue  # Common title/preamble and existing intentional exclusions.
                    if cell.get('value') not in (None, '') or cell.get('formula'):
                        self.assertEqual(len(owners(metadata, address)), 1, (identity, address))
                for reference in source['merges']:
                    start, end = reference.split(':')
                    owner = owners(metadata, start)
                    if owner:
                        self.assertEqual(owners(metadata, end), owner, (identity, reference))

    def test_side_by_side_duct_sections_and_multiline_helper_titles_keep_full_spans(self):
        duct = self.metadata('ductwork', 'PRODUCT SETTINGS')
        for address, owner in [('A94', 'A94'), ('B97', 'A94'), ('B100', 'A94'),
                               ('A115', 'A94'), ('B150', 'A94'), ('H151', 'A94'),
                               ('J94', 'J94'), ('J106', 'J94'), ('Q113', 'J94'),
                               ('J115', 'J115'), ('J132', 'J115'), ('Q135', 'J115'),
                               ('K137', 'J115'), ('Q139', 'J115')]:
            self.assertEqual(owners(duct, address), [owner], address)
        self.assertFalse(owners(duct, 'A153'))
        self.assertTrue(set(range(153, 160)).issubset(duct['omitted_rows']))
        verm = self.metadata('steel_vermiculite', 'SETTINGS')
        for address, owner in [('A341', 'A341'), ('N342', 'A341'), ('D346', 'A341'),
                               ('D362', 'A356'), ('H371', 'A370'), ('N374', 'A370')]:
            self.assertEqual(owners(verm, address), [owner], address)

    def test_navigation_metadata_is_detached_and_source_models_do_not_change(self):
        for identity, name in SECTIONS:
            with self.subTest(identity=identity):
                model = source_model(identity)
                before = digest(model)
                definition = calculator_definition(identity)
                metadata = next(sheet for sheet in definition['sheets'] if sheet['name'] == name)
                original = deepcopy(metadata['settings_sections'])
                metadata['settings_sections'][0]['ranges'].append('A1:A1')
                metadata['settings_sections'][0]['label'] = 'caller-owned replacement'
                metadata['settings_sections'].append({'id': 'caller-owned', 'label': 'New', 'ranges': []})
                refreshed = next(sheet for sheet in calculator_definition(identity)['sheets'] if sheet['name'] == name)
                self.assertEqual(refreshed['settings_sections'], original)
                self.assertEqual(digest(source_model(identity)), before)

    def test_non_settings_pages_keep_their_existing_input_and_table_scopes(self):
        for identity, definition in self.definitions.items():
            for metadata in definition['sheets']:
                if (identity, metadata['name']) not in SECTIONS:
                    self.assertEqual(metadata['settings_sections'], [])
                    self.assertNotEqual(metadata['navigation_mode'], 'select')
        bags = self.metadata('steel_vermiculite', 'BAGS')
        self.assertEqual(bags['display_table_order'], [1, 0])
        self.assertEqual([(table['first_row'], table['last_row']) for table in bags['presentation_tables']],
                         [(1, 15), (17, 25)])
        self.assertEqual(bags['presentation_tables'][0]['title_address'], 'A1')
        self.assertEqual(bags['presentation_tables'][0]['subtitle_address'], 'A3')
        self.assertEqual(self.metadata('steel_vermiculite', 'SCHEDULE')['schedule_heading'], 'MEMBER SCHEDULE')
        self.assertTrue(self.metadata('steel_board', 'START')['expand_tables'])


if __name__ == '__main__':
    unittest.main()
