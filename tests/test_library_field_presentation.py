from copy import deepcopy
import unittest

from estimator.technical_discovery import present_technical
from estimator.technical_table_navigation import validate_table_navigation


def field(label, value, **extra):
    return dict(label=label, value=value, **extra)


class RepeatedLibraryFieldsTests(unittest.TestCase):
    def service(self):
        return {'fields': [field('Service', 'Aluminium Cables'), field('Service Wrap', '300mm'),
            field('FRL', '-/90/90', table_links=[{'field': 'Service Size / Configuration', 'table_index': 0}]),
            field('Service Size / Configuration', 'Service Type: Aluminium Cables; Service Detail: Bundles up to 3 x 240 mm2 28 mm OD; TWrap Length: 300mm',
                table={'columns': ['Service Type', 'Service Detail', 'TWrap Length', 'FRL'],
                       'rows': [['Aluminium Cables', 'Bundles up to 3 x 240 mm2 28 mm OD', '300mm', '-/90/90']]},
                table_row_ids=[['source-row']], table_captions=['Source table'])]}

    def test_service_detail_only_and_source_evidence_stays_exact(self):
        item = self.service()
        item['technical_basis'] = {'source_fields': deepcopy(item['fields'])}
        original = deepcopy(item)
        result = present_technical(item)
        self.assertEqual(result['fields'][-1], field('Service Size / Configuration', 'Bundles up to 3 x 240 mm2 28 mm OD'))
        self.assertNotIn('table_links', result['fields'][2])
        self.assertEqual(item, original)
        self.assertEqual(result['technical_basis'], original['technical_basis'])
        self.assertEqual(present_technical(result), result)
        validate_table_navigation(result['fields'])

    def test_different_wrap_rating_service_unknown_cells_and_extra_prose_survive(self):
        for column in (0, 2):
            item = self.service(); item['fields'][column]['value'] = 'Different condition'
            self.assertIn('table', present_technical(item)['fields'][-1])
        item = self.service(); item['fields'][1]['value'] = '300mm on top only'
        self.assertIn('table', present_technical(item)['fields'][-1])
        item = self.service(); item['fields'][-1]['value'] += '; Important extra condition'
        self.assertIn('table', present_technical(item)['fields'][-1])
        item = self.service(); item['fields'][-1]['table']['columns'].append('Limits'); item['fields'][-1]['table']['rows'][0].append('Only arrangement A')
        self.assertIn('table', present_technical(item)['fields'][-1])

    def test_alternatives_and_ambiguous_fields_remain(self):
        item = self.service(); item['fields'][-1]['table']['rows'].append(['Aluminium Cables', 'Other bundle', '400mm', '-/120/120'])
        self.assertIn('table', present_technical(item)['fields'][-1])
        item = self.service(); item['fields'].insert(0, field('Service', 'Aluminium Cables'))
        self.assertIn('table', present_technical(item)['fields'][-1])

    def test_equal_barrier_removed_but_qualified_or_additional_columns_retained(self):
        item = {'fields': [field('Barrier Construction', '2x13mm FR Plasterboard Wall',
            table={'columns': ['Substrate', 'FRL'], 'rows': [['2x13mm FR Plasterboard Wall', '-/120/120']]}), field('FRL', '-/120/120')]}
        self.assertNotIn('table', present_technical(item)['fields'][0])
        item['fields'][0]['table']['rows'][0][1] += ' subject to ceiling reinforcement'
        self.assertIn('table', present_technical(item)['fields'][0])


if __name__ == '__main__':
    unittest.main()
