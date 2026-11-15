from copy import deepcopy
import unittest

from estimator.technical_table_navigation import field_tables, validate_table_navigation
from estimator.technical_table_presentation import present_redundant_tables


def single_row(construction, rating):
    return [
        {'label': 'Barrier Construction', 'value': construction,
         'table': {'columns': ['Barrier Construction', 'FRL'], 'rows': [[construction, rating]]},
         'table_row_ids': [['option-1']]},
        {'label': 'FRL', 'value': rating,
         'table_links': [{'field': 'Barrier Construction', 'table_index': 0}]},
    ]


class TechnicalTablePresentationTests(unittest.TestCase):
    def test_floor_examples_keep_construction_rating_and_penetration_rating_separate(self):
        for thickness, material, construction_rating, locator, service_rating in (
                (120, 'concrete, masonry or AAC', '120/120/120', 13, '-/120/120'),
                (200, 'Concrete, Masonry or Hebel', '240/240/240', 58, '-/240/240'),
                (120, 'concrete, masonry or AAC', '90/90/90', 34, '-/90/90')):
            construction = (f'Min. {thickness} mm thick {material} floor.\n'
                            f'Capable of min. FRL of {construction_rating} (Item {locator})')
            fields = single_row(construction, service_rating)
            fields[0]['table']['rows'][0][0] = construction.replace('/', '\n/').replace('masonry or', 'masonry\nor')
            present_redundant_tables(fields)
            self.assertEqual(fields, [{'label': 'Barrier Construction', 'value': construction},
                                      {'label': 'FRL', 'value': service_rating}])
            present_redundant_tables(fields)
            validate_table_navigation(fields)

    def test_complete_selected_service_row_matches_every_field_including_id(self):
        owner = {'label': 'Service Size / Configuration', 'value': '100 mm',
                 'table': {'columns': ['ID', 'Barrier Construction', 'Service Size / Configuration', 'FRL'],
                           'rows': [['A-2', 'Concrete slab ≥ 175 mm', '100 mm', '-/120/90']]},
                 'table_captions': ['Reviewed source configuration']}
        fields = [owner, {'label': 'Barrier Construction', 'value': 'Concrete slab ≥ 175 mm'},
                  {'label': 'FRL', 'value': '-/120/90'}, {'label': 'ID', 'value': 'A-2'}]
        wrong_id = deepcopy(fields)
        wrong_id[-1]['value'] = 'A-3'
        before = deepcopy(wrong_id)
        present_redundant_tables(wrong_id)
        self.assertEqual(wrong_id, before)
        present_redundant_tables(fields)
        self.assertEqual(owner, {'label': 'Service Size / Configuration', 'value': '100 mm'})

    def test_keep_distinct_values_mappings_source_captions_and_external_links(self):
        for difference in ('alternative', 'rating', 'item', 'condition', 'unknown column', 'caption',
                           'additional table', 'unrelated link', 'ambiguous scalar', 'prose pointer',
                           'concealed scalar'):
            with self.subTest(difference=difference):
                fields = single_row('120 mm concrete floor (Item 13)', '-/120/120')
                owner, rating = fields
                if difference == 'alternative':
                    owner['table']['rows'].append(['200 mm concrete floor', '-/240/240'])
                    owner['table_row_ids'][0].append('option-2')
                elif difference == 'rating':
                    rating['value'] = '-/90/90'
                elif difference == 'item':
                    owner['value'] = owner['value'].replace('13', '34')
                elif difference == 'condition':
                    owner['table']['rows'][0][1] += ' from below only'
                elif difference == 'unknown column':
                    owner['table']['columns'][1] = 'Unwrapped FRL'
                elif difference == 'caption':
                    owner['table_captions'] = ['Related system only. Applicability unresolved.']
                elif difference == 'additional table':
                    owner['tables'] = [deepcopy(owner['table'])]
                    owner['table_row_ids'].append(['option-2'])
                    rating['table_links'][0]['table_index'] = 1
                elif difference == 'unrelated link':
                    fields.append({'label': 'Service Wrap', 'value': 'See configuration',
                                   'table_links': deepcopy(rating['table_links'])})
                elif difference == 'ambiguous scalar':
                    fields.append({'label': 'FRL', 'value': '-/90/90'})
                elif difference == 'prose pointer':
                    fields.append({'label': 'Installation Details', 'value': 'See Barrier Construction table 1.'})
                elif difference == 'concealed scalar':
                    owner['table']['columns'].append('Reference Review')
                    owner['table']['rows'][0].append('Additional condition')
                    fields.append({'label': 'Reference Review', 'value': 'Additional condition'})
                before = deepcopy(fields)
                present_redundant_tables(fields)
                self.assertEqual(fields, before)

    def test_blank_seal_moves_only_missing_construction_and_preserves_aperture_conditions(self):
        fields = [
            {'label': 'Barrier Construction', 'value': '',
             'table': {'columns': ['Max Aperture Size', 'Separating Element', 'FRL'],
                       'rows': [['600 mm × 1200 mm', 'Min. 51 mm Speedpanel wall', '-/60/60']]}},
            {'label': 'Blank Seal FRL', 'value': '-/60/60'},
            {'label': 'Max. Opening Size', 'value': '600 mm x 1200 mm'}]
        for column, condition in ((0, ' or equivalent area'), (2, ' supporting self-weight only')):
            qualified = deepcopy(fields)
            qualified[0]['table']['rows'][0][column] += condition
            before = deepcopy(qualified)
            present_redundant_tables(qualified)
            self.assertEqual(qualified, before)
        present_redundant_tables(fields)
        self.assertEqual(fields[0]['value'], 'Min. 51 mm Speedpanel wall')
        self.assertFalse(field_tables(fields[0]))
