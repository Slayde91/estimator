import unittest
from copy import deepcopy

from estimator.technical_field_options import normalize_options


class TechnicalOptionsTests(unittest.TestCase):
    def test_conditional_tiers_keep_pairing_without_repeating_service_dimensions(self):
        fields = [{'label': 'Service Size / Configuration', 'value': 'Up to NB150'},
                  {'label': 'Service Wrap', 'value': '300mm up to NB50, 450mm up to NB100, 900mm & 300mm up to NB150'}]
        before = deepcopy(fields)
        size, wrap = normalize_options(fields)
        self.assertEqual(fields, before)
        self.assertEqual(size['value'], '')
        self.assertEqual(size['tables'][0]['rows'], [['Wrap configuration 1', 'up to NB50'],
                                                   ['Wrap configuration 2', 'up to NB100'],
                                                   ['Wrap configuration 3', 'up to NB150']])
        self.assertEqual(wrap['table']['rows'][-1], ['Wrap configuration 3', '900mm & 300mm'])
        self.assertNotIn('NB', str(wrap))

    def test_multiple_service_types_in_a_clause_are_not_split(self):
        fields = [{'label': 'Service Size / Configuration', 'value': 'Up to 32mm'},
                  {'label': 'Service Wrap', 'value': '300mm for Type A up to 20mm and Type B up to 25mm, 450mm for Type A and Type B up to 32mm'}]
        size, wrap = normalize_options(fields)
        self.assertEqual(len(size['tables'][0]['rows']), 2)
        self.assertEqual(size['tables'][0]['rows'][0][1], 'Type A up to 20mm and Type B up to 25mm')
        self.assertEqual(wrap['table']['rows'][1][1], '450mm')

    def test_inconsistent_nominal_dimensions_are_preserved_not_corrected(self):
        fields = [{'label': 'Service Size / Configuration', 'value': 'Up to NB100'},
                  {'label': 'Service Wrap', 'value': '300mm for pipes up to NB50, 450mm for pipes up to NB101'}]
        size, wrap = normalize_options(fields)
        self.assertEqual(size['value'], 'Up to NB100')
        self.assertIn('NB101', size['tables'][0]['rows'][1][1])
        self.assertEqual(wrap['table']['rows'][1][1], '450mm')

    def test_ambiguous_exceptions_and_source_tables_are_unchanged(self):
        for value in ['300mm (No wrap for -/180/90)', '300mm for FR insulation',
                      '600mm, wrap infill for 300mm', '300mm for first layer, 600mm for second layer']:
            fields = [{'label': 'Service Size / Configuration', 'value': 'Up to 100mm'},
                      {'label': 'Service Wrap', 'value': value}]
            self.assertEqual(normalize_options(fields), fields)
        fields[1]['table'] = {'columns': ['Option', 'Wrap'], 'rows': [['A', '300mm']]}
        self.assertEqual(normalize_options(fields), fields)

    def test_repeated_normalization_is_stable(self):
        fields = [{'label': 'Service Size / Configuration', 'value': 'Up to DN100'},
                  {'label': 'Service Wrap', 'value': '450mm for up to DN50 and 750mm for up to DN100'}]
        normalized = normalize_options(fields)
        self.assertEqual(normalize_options(normalized), normalized)
        self.assertEqual(len(normalized[0]['tables'][0]['rows']), 2)
