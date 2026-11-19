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


def corehole_member(code, page, barrier, dimension, member):
    support = ('a horizontal or vertical support element (including roof insulation)'
               if barrier == 'wall' else 'a vertical support element')
    edge = (f'At the edge of the {barrier}, against {support}, '
            'requiring the use of a 3-sided wrap configuration.')
    if barrier == 'wall':
        step = ('Install 1 layer of FIREFLYPenowrap for 300 mm, on each side of the wall,\n'
                'butting up to the face of the wall.')
    else:
        step = ('Install 1 layer of FIREFLYPenowrap for:\n'
                '• 300 mm, on each side of the floor, butting up to the face of the floor, or,\n'
                '• 600 mm, on the topside of the floor, butting up to the face of the floor.')
    return {
        'id': 'tv-test-reviewed-substrate',
        'filter_values': {'category': ['Structural Steel'], 'manufacturer': ['Firefly']},
        'sources': [{'document_id': 'fas190236', 'page': page,
                     'label': f'FAS190236 RIR1.25A, {code}, PDF page {page}'}],
        'fields': [
            {'label': 'Service Size / Configuration', 'value': f'{dimension}\n\n{member} can be installed:'},
            {'label': 'Service Wrap', 'value': f'In the body of the {barrier}, using a 4-sided wrap configuration.\n\n{edge}'},
            {'label': 'Installation Details', 'value': f'• In the body of the {barrier} (4-sided wrap):\n4. {step}\n\n'
             f'• At the edge of the {barrier} (3-sided wrap):\n4. {step}\n5. Preserve the assessed edge fixing.'},
        ],
    }


class FireflySteelPresentationTests(unittest.TestCase):
    def test_corehole_members_show_only_their_assessed_wrap_lengths_in_service_wrap(self):
        purlin_size = 'Up to 200 mm x 77 mm x 1.8 BMT steel “C” purlin.'
        beam_size = 'From 150 UB up to 200 UB steel beam.'
        for code, page, barrier, size, member in (
            ('V31', 29, 'wall', beam_size, 'Steel beam'),
            ('V33', 31, 'wall', purlin_size, 'Purlin'),
            ('H24', 230, 'floor', beam_size, 'Steel beam'),
            ('H26', 232, 'floor', purlin_size, 'Purlin'),
        ):
            with self.subTest(code=code):
                item = corehole_member(code, page, barrier, size, member)
                if member == 'Steel beam':
                    instructions = item['fields'][2]
                    instructions['value'] = ' '.join(instructions['value'].split()).replace(
                        f'butting up to the face of the {barrier}', f'butting against the {barrier}')
                original = deepcopy(item)
                fields = {field['label']: field['value'] for field in public_prose_fields(item)}
                self.assertEqual(fields['Service Size / Configuration'], size)
                self.assertEqual(fields['Service Wrap'], 'One layer of FIREFLYPenowrap for '
                                 + ('300 mm on each side of the wall, butting against the wall face.'
                                    if barrier == 'wall' else
                                    '300 mm on each side of the floor or 600 mm on the topside, butting against the floor face.'))
                old_edge = original['fields'][1]['value'].split('\n\n')[1]
                self.assertEqual(fields['Installation Details'], old_edge + '\n\n' + original['fields'][2]['value'])
                self.assertEqual(item, original)

    def test_corehole_member_keeps_existing_wording_if_evidence_or_one_wrap_step_changes(self):
        item = corehole_member('V31', 29, 'wall', 'From 150 UB up to 200 UB steel beam.', 'Steel beam')
        wrong_page = deepcopy(item)
        wrong_page['sources'][0]['page'] = 28
        self.assertEqual(public_prose_fields(wrong_page), wrong_page['fields'])
        installation = item['fields'][2]
        installation['value'] = installation['value'].replace('300 mm', '350 mm', 1)
        self.assertEqual(public_prose_fields(item), item['fields'])

    def test_batt_beam_removes_only_the_standalone_lead_in(self):
        size = 'From 150 UB up to 200 UB steel beam/column.'
        wrap = 'One layer of FIREFLYPenowrap for 600 mm topside or 300 mm on each side of the FIREFLYBatt seal.'
        item = {
            'filter_values': {'category': ['Structural Steel'], 'manufacturer': ['Firefly']},
            'sources': [{'document_id': 'fas190235', 'page': 89,
                         'label': 'FAS190235 RIR1.29G, Table 6, H43, PDF page 89'}],
            'fields': [{'label': 'Service Size / Configuration', 'value': size + '\n\nSteel beam/column can be installed:'},
                       {'label': 'Service Wrap', 'value': wrap}],
        }
        self.assertEqual(public_prose_fields(item),
                         [{'label': 'Service Size / Configuration', 'value': size},
                          {'label': 'Service Wrap', 'value': wrap}])

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
