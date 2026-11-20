from copy import deepcopy
import unittest

from estimator.technical_prose import public_prose_fields


_EDGE_STEPS = (
    '1. Install 1 layer of FIREFLYPenowrap\n'
    '• for 600 mm, on the topside only of the FIREFLYBatt seal, butting up to\n'
    'the face of the FIREFLYBatt, or,\n'
    '• for 300 mm, on each side of the FIREFLYBatt seal, butting up to the face\n'
    'of the FIREFLYBatt\n'
    '2. Lap the FIREFLYPenowrap onto the vertical support element.\n'
    '3. Seal the FIREFLYPenowrap to the FIREFLYBatt using FIREFLYMastic.'
)
_SINGLE_LENGTH_STEPS = (
    '1. Install 1 layer of FIREFLYPenowrap for 300 mm, on each side of the\n'
    'FIREFLYBatt seal, butting up to the face of the FIREFLYBatt.\n'
    '2. Secure the FIREFLYPenowrap using stainless steel cable ties, nom. 50\n'
    'mm from each end and at nom. 100 mm centres.'
)


class FireflyWrapPresentationTests(unittest.TestCase):
    def setUp(self):
        self.item = {
            'filter_values': {'manufacturer': ['Firefly']},
            'sources': [{'document_id': 'fas190235', 'page': 73,
                         'sha256': 'a61e53af7ad9d54fbec0302ddc90ee261248ac8e73d54504cef5319295722819'}],
            'fields': [{'label': 'Service Wrap', 'value': _EDGE_STEPS},
                       {'label': 'Local Protection', 'value': 'Retain the stated seal.'},
                       {'label': 'Report Number', 'value': 'FAS190235'}],
        }

    def test_h5_moves_full_method_under_installation_and_leaves_a_length_summary(self):
        original = deepcopy(self.item)
        fields = public_prose_fields(self.item)
        self.assertEqual(self.item, original)
        self.assertEqual(fields, [
            {'label': 'Service Wrap', 'value': '300 mm both sides or 600 mm topside only'},
            original['fields'][1],
            {'label': 'Installation Details', 'value': _EDGE_STEPS},
            original['fields'][2],
        ])

    def test_near_edge_qualification_stays_in_summary_and_steps(self):
        qualification = ('This service may be installed close to edge of the aperture provided that a 50 mm fillet '
                         'of FIREFLYMastic is provided on the topside and the length of the FIREFLYPenowrap '
                         'is increased to 600 mm on the topside of the FIREFLYBatt seal.')
        self.item['fields'][0]['value'] += '\n\n' + qualification
        fields = {f['label']: f['value'] for f in public_prose_fields(self.item)}
        self.assertIn('close to the edge, use 600 mm topside only', fields['Service Wrap'])
        self.assertIn(qualification, fields['Installation Details'])

    def test_exact_single_length_wrap_moves_without_overwriting_existing_installation(self):
        self.item['fields'][0]['value'] = _SINGLE_LENGTH_STEPS
        self.item['fields'].insert(2, {'label': 'Installation Details', 'value': 'Keep the assessed batt fixings.'})
        fields = {f['label']: f['value'] for f in public_prose_fields(self.item)}
        self.assertEqual(fields['Service Wrap'], '300 mm both sides')
        self.assertEqual(fields['Installation Details'], 'Keep the assessed batt fixings.\n\n' + _SINGLE_LENGTH_STEPS)

    def test_different_source_payload_or_wrapping_rule_is_preserved(self):
        for change in ('hash', 'table', 'different method'):
            with self.subTest(change=change):
                item = deepcopy(self.item)
                if change == 'hash':
                    item['sources'][0]['sha256'] = '0' * 64
                elif change == 'table':
                    item['fields'][0]['table'] = {'columns': ['Length'], 'rows': [['600 mm']]}
                else:
                    item['fields'][0]['value'] = _EDGE_STEPS.replace('600 mm', '650 mm')
                self.assertEqual(public_prose_fields(item), item['fields'])
