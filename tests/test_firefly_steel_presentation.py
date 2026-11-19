from copy import deepcopy
import hashlib
import unittest
from unittest.mock import patch

from estimator.firefly_steel_presentation import firefly_structural_fields
from estimator.technical_prose import public_prose_fields


def purlin(*, length_location='Service Wrap (length)'):
    return {
        'filter_values': {'category': ['Structural Steel'], 'manufacturer': ['Firefly']},
        'sources': [{'document_id': 'fas190235', 'page': 32}],
        'fields': [
            {'label': 'Service', 'value': 'Steel C Purlin or Z purlin protected with a combination\n'
             'of FIREFLYBatt and FIREFLY Penowrap (see item 119)\n'
             'Note. The purlins can be installed at the body of\n'
             'FIREFLYBatt or close to edge of the Batt against a\n'
             'concrete slab or a roof insulation.'},
            {'label': 'Service Size / Configuration', 'value': '100 19', 'table': {
                'columns': ['Service (purlin size)', length_location, 'FRL', 'PDF page'],
                'rows': [['100 19', '450 mm', '-/120/120', '32']],
            }},
            {'label': 'FRL', 'value': '-/120/120'},
            {'label': 'Service Wrap', 'value': '450 mm'},
            {'label': 'Local Protection', 'value': 'FIREFLYMastic to full depth of FIREFLYBatt'},
        ],
    }


class FireflySteelPresentationTests(unittest.TestCase):
    def test_service_and_report_link_remain_when_redundant_page_and_table_are_removed(self):
        item = purlin()
        item['fields'] += [{'label': 'Report Number', 'value': 'FAS190235'},
                           {'label': 'Report Page', 'value': 'FAS190235, PDF page 32'}]
        original = deepcopy(item)
        fields = {field['label']: field for field in public_prose_fields(item)}
        self.assertEqual(item, original)
        self.assertNotIn('table', fields['Service Size / Configuration'])
        self.assertNotIn('Report Page', fields)
        self.assertEqual(fields['Report Number']['value'], 'FAS190235')
        self.assertEqual(item['sources'], [{'document_id': 'fas190235', 'page': 32}])
        self.assertEqual(fields['Service']['value'], 'Steel C or Z purlin')
        self.assertIn('concrete slab or roof insulation', fields['Local Protection']['value'])
        self.assertIn('Item 119', fields['Local Protection']['value'])
        self.assertEqual(fields['Service Wrap']['value'], '450 mm')

    def test_only_verified_h45_instructions_get_reflowed_with_length_in_wrap_field(self):
        item = purlin(length_location='Protection (length)')
        item['fields'][0]['value'] = 'purlin'
        wrap, local = item['fields'][-2:]
        wrap['value'] = 'Known clause.\nThe layout has wrapped it.'
        local['value'] = '450 mm'
        exact = hashlib.sha256(b'Known clause. The layout has wrapped it.').hexdigest()
        with patch('estimator.firefly_steel_presentation._H45_SOURCE_SHA256', exact):
            fields = {f['label']: f for f in firefly_structural_fields(item, item['fields'])}
        value = fields['Service Wrap']['value']
        self.assertTrue(value.startswith('450 mm on each side'))
        self.assertIn('Three-sided wrap at the edge', value)
        self.assertIn('0.75 mm', value)
        self.assertIn('at 100 mm centres', value)
        self.assertIn('during a fire', value)
        self.assertNotIn('table', fields['Service Size / Configuration'])
        self.assertIn('full depth', fields['Local Protection']['value'])

    def test_alternative_or_missing_page_keeps_source_table(self):
        for change in ('alternative row', 'missing source page', 'different rate'):
            with self.subTest(change=change):
                item = purlin()
                size = item['fields'][1]
                if change == 'alternative row':
                    size['table']['rows'].append(['100 19', '400 mm', '-/180/180', '33'])
                elif change == 'missing source page':
                    item['sources'][0]['page'] = 33
                else:
                    item['fields'][2]['value'] = '-/60/60'
                fields = public_prose_fields(item)
                self.assertEqual(fields[1]['table'], size['table'])

    def test_other_manufacturer_fields_pass_through(self):
        item = purlin()
        item['filter_values']['manufacturer'] = ['Other']
        self.assertEqual(public_prose_fields(item), item['fields'])
