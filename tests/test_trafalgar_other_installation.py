from copy import deepcopy
import re
import unittest

from estimator.trafalgar_other_installation import (
    _FCO3527_FIELDS, _FCO3527_SERVICES, _INTRWALL_PEX_SOURCE, _procedure,
    present_trafalgar_other_installation, present_verified_intrwall_pex_scope,
)


class TrafalgarOtherInstallationTests(unittest.TestCase):
    def test_exact_fco3527_records_show_the_distinct_wrap_methods(self):
        for ids, (service, configuration, wrap) in _FCO3527_SERVICES.items():
            expected = {**_FCO3527_FIELDS, 'Service': service,
                        'Service Size / Configuration': configuration, 'Service Wrap': wrap}
            for number in ids:
                with self.subTest(number=number):
                    fields = [{'label': label, 'value': value} for label, value in expected.items()]
                    original = deepcopy(fields)
                    record = {'id': f'trafalgar-selector-{number}'}
                    result = present_trafalgar_other_installation(record, fields)
                    installation = next(field for field in result if field['label'] == 'Installation Details')
                    method = installation['value']
                    self.assertEqual(installation['source_labels'], ['FCO 3527 Revision G'])
                    self.assertEqual([item for item in result if item is not installation], original)
                    self.assertEqual(fields, original)
                    self.assertIn('minimum M6 x 50 mm', method)
                    self.assertIn('60 mm of FyrePEX HP', method)
                    self.assertNotRegex(method, re.compile(r'\b(?:table|figure|page)\b', re.I))
                    if wrap == '300mm':
                        self.assertIn('300 mm above the floor', method)
                        self.assertIn('three-sided wrap', method)
                    else:
                        self.assertIn('wrap-free', method)
                        self.assertNotIn('300 mm above the floor', method)
                    self.assertEqual(present_trafalgar_other_installation(record, result), result)

    def test_changed_source_or_selected_scope_keeps_the_original(self):
        service, configuration, wrap = _FCO3527_SERVICES[('8244', '8354')]
        expected = {**_FCO3527_FIELDS, 'Service': service,
                    'Service Size / Configuration': configuration, 'Service Wrap': wrap}
        fields = [{'label': label, 'value': value} for label, value in expected.items()]
        self.assertIs(present_trafalgar_other_installation({'id': 'trafalgar-selector-8254'}, fields), fields)
        record = {'id': 'trafalgar-selector-8244'}
        for label in ('Report Number', 'Barrier Construction', 'Service Size / Configuration', 'Service Wrap',
                      'Maximum Opening Size', 'Seal Depth / Fillet Size', 'FRL'):
            with self.subTest(label=label):
                different = deepcopy(fields)
                next(f for f in different if f['label'] == label)['value'] += ' changed'
                self.assertIs(present_trafalgar_other_installation(record, different), different)
        manual = [*fields, {'label': 'Installation Details', 'value': 'Reviewed procedure.'}]
        self.assertIs(present_trafalgar_other_installation(record, manual), manual)

    def test_installation_methods_preserve_different_materials_and_sides(self):
        cases = {
            '7177': ('line up the elbow with the collar', '150 mm thick', 'both wall faces'),
            '7178': ('110 mm outside diameter', '160 mm thick', 'out of the collars'),
            '7947': ('aluminium cable', 'FyrePEX HP', 'each wall face'),
            '7949': ('one RG6 cable, one RG11 cable and three CAT6 cables', 'FyreFLEX', '5 mm'),
            '7950': ('copper cable', 'FyreFLEX', '50 x 50 mm'),
            '7945': ('25 mm FyreCOLLAR Conduit inverted', 'collar projecting 10 mm', 'fixing-tab side'),
            '8261': ('175 mm', '72 mm hole', '300 mm above the floor'),
            '8799': ('Fyrechek layer on each wall face', '8g x 50 mm', '7.5 mm'),
            '1183': ('face-fix a second', '300 mm on both wall faces'),
            '1200': ('two 13 mm', 'Friction-fit two 60 mm'),
            '1254': ('78 mm Speedpanel', '600 x 600 mm'),
            '1312': ('300 mm above the floor', '170 mm opening'),
            '1313': ('300 mm on both sides of the floor',),
            '4821': ('concrete-filled steel deck floor', '300 mm on both sides of the floor'),
        }
        for number, required_text in cases.items():
            with self.subTest(number=number):
                expected, _, sources = _procedure(number)
                original = [{'label': label, 'value': value} for label, value in expected.items()]
                record = {'id': f'trafalgar-selector-{number}'}
                fields = present_trafalgar_other_installation(record, original)
                installation = next(field for field in fields if field['label'] == 'Installation Details')
                self.assertEqual(installation['source_labels'], sources)
                method = installation['value']
                self.assertNotRegex(method, re.compile(r'\b(?:table|figure|page)\b', re.I))
                for fragment in required_text:
                    self.assertIn(fragment, method)

                changed_product = deepcopy(original)
                next(f for f in changed_product if f['label'] == 'System Products')['value'] = 'Other product'
                self.assertIs(present_trafalgar_other_installation(record, changed_product), changed_product)

    def test_publishes_the_corrected_intrwall_collar_only_for_the_reviewed_configuration(self):
        original = [{'label': label, 'value': value} for label, value in _INTRWALL_PEX_SOURCE.items()]
        record = {'id': 'trafalgar-selector-7945', 'fields': deepcopy(original),
                  'summary': _INTRWALL_PEX_SOURCE['System Products']}
        fields = record['fields']
        self.assertIs(present_trafalgar_other_installation(record, fields), fields)
        different = deepcopy(record)
        next(f for f in different['fields'] if f['label'] == 'FRL')['value'] = '-/90/90'
        preserved = deepcopy(different)
        present_verified_intrwall_pex_scope(different)
        self.assertEqual(different, preserved)
        present_verified_intrwall_pex_scope(record)
        self.assertEqual(record['summary'], '25 mm FyreCOLLAR Conduit, FyreFLEX Sealant')
        result = {f['label']: f['value'] for f in present_trafalgar_other_installation(record, fields)}
        self.assertNotIn('10 mm', result['Maximum Opening Size'])
        self.assertNotIn('5mm', result['Seal Depth / Fillet Size'])
        self.assertIn('projecting 10 mm', result['Installation Details'])
