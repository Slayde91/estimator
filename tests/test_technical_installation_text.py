"""Transfer only the selected variant's exact repeated fields into readable steps."""
from copy import deepcopy
import unittest

from estimator.technical_installation_text import present_installation_fields
from estimator.technical_display import technical_field_text


class ServiceConfigurationTextTests(unittest.TestCase):
    label = 'Service Size / Configuration'
    components = ('1 × DN100 DWV uPVC pipe\n1 × 100 mm to 80 mm PVC offset reducer\n1 × 80 mm waste pipe\n'
                  '1 × Ø80 mm Puddle flange\n1 × BOSS gully trap')
    source = ('Single layer of waterproofing panel is installed\naround the puddle flange using board screws at 200\n'
              'mm centers\nVitreous tile is then adhered to waterproofing panel\nusing adhesive\n'
              'A square drain protruded through the waterproofing\npanel and finish flush with the tile.\n'
              'A small insert vitreous tile is then fit into the square\ndrain')

    def show(self, source):
        fields = [{'label': self.label, 'value': source}]
        present_installation_fields(fields)
        displayed = fields[0]['value']
        present_installation_fields(fields)
        self.assertEqual(fields[0]['value'], displayed)
        return displayed

    def test_drain_parts_and_four_sentences_are_separate_and_preserved_in_exports(self):
        value = self.show(self.components + '\n' + self.source)
        parts, method = value.split('\n\n')
        self.assertEqual(parts.splitlines(), ['• ' + row for row in self.components.splitlines()])
        self.assertEqual(method, 'Fix a single layer of waterproofing panel around the puddle flange with board screws '
            'at 200 mm centres. Bond the vitreous tile to the panel with adhesive. Fit the square drain through the '
            'panel so it sits flush with the tile. Fit a small vitreous tile insert into the square drain.')
        self.assertEqual(technical_field_text(self.label, value), value)
        self.assertIn('at 150.5 mm centres.', self.show(self.source.replace('200', '150.5')))

    def test_only_complete_component_lists_and_known_drain_methods_are_reformatted(self):
        self.assertEqual(self.show('Any combination of up to\n1 × Cat6 cable\n4 × RG6 cables'),
                         'Any combination of up to\n\n• 1 × Cat6 cable\n• 4 × RG6 cables')
        for text in (self.components + '\n' + self.source + ' only where stated.',
                     '1 × Ø80 mm drain\nOR\n2 × Ø40 mm drains', '150 × 200 mm\n100 × 80 mm'):
            self.assertEqual(self.show(text), text)


PROCEDURE = (
    'Apply Ryanfire Brush Grade Mastic to exposed board edges and mating surfaces. '
    'Install the two-layer Ryanfire502Board aperture seal using the selected floor or wall construction and its '
    'source-specific fixings,restraint and overlap. Seal board joints and the perimeter with the specified Ryanfire Mastic. '
    'Independently support penetrating services. Keep the named local service sealant and protection for this configuration.')
SEAL = ('Ryanfire HP-X to10mm depth from the underside of the Ryan502Batts over PEbackingrod,asT00169detailG/instruction3;'
        'annular gap per selectedFAS210123Table105row. Unicorncollar fixed with source tabs/bolts and penny washers.')
CONDITION = ('FAS200363Table30;CLT independently rated60min;full timber/friction-fit installation. '
             'All tested local service details retained;maximum aperture:1000mm×1000mm')


class TechnicalInstallationTextTests(unittest.TestCase):
    def present(self, text, opening='1000mm×1000mm', seal=SEAL):
        fields = [{'label': k, 'value': v} for k, v in (
            ('Service', 'uPVC pipe'), ('Seal Depth / Fillet Size', seal),
            ('Maximum Opening Size', opening), ('Installation Details', text))]
        present_installation_fields(fields)
        first = deepcopy(fields)
        present_installation_fields(fields)
        self.assertEqual(fields, first)
        return {f['label']: f['value'] for f in fields}

    def test_marked_record_keeps_source_locators_depth_direction_and_fixings(self):
        result = self.present(PROCEDURE + '\n\nService: uPVC pipe\nSeal Depth / Fillet Size: ' + SEAL + '\n\n' + CONDITION)
        seal, installation = result['Seal Depth / Fillet Size'], result['Installation Details']
        for phrase in ('PE backing rod', '10 mm from the underside', 'T00169, detail G, instruction 3',
                       'selected row of FAS210123 Table 105', 'tabs/bolts and penny washers'):
            self.assertIn(phrase, seal)
        for phrase in ('1. Apply Ryanfire Brush Grade Mastic', 'two-layer Ryanfire 502 Board', 'fixings, restraint and overlap',
                       'independently', 'local service sealant and protection', 'FAS200363 Table 30', '60 min'):
            self.assertIn(phrase, installation)
        self.assertNotIn('Service:', installation)
        self.assertNotIn('Seal Depth / Fillet Size:', installation)
        self.assertEqual(result['Maximum Opening Size'], '1000mm×1000mm')

    def test_different_conditions_stay_with_the_correct_variant(self):
        text = PROCEDURE + '\n\nService: uPVC pipe\nSeal Depth / Fillet Size: Different interface: 25mm\n\n' + CONDITION
        value = self.present(text, opening='900mm×900mm')['Installation Details']
        self.assertNotIn('Service: uPVC pipe', value)
        self.assertIn('Seal Depth / Fillet Size: Different interface: 25mm', value)
        self.assertIn('Maximum aperture: 1000mm×1000mm', value)

    def test_never_deduplicate_an_unrecognised_alternative_or_change_its_seal(self):
        value = 'Do not use this combination:\n\nService: uPVC pipe\nSeal Depth / Fillet Size: ' + SEAL
        seal = SEAL.replace('to10mm', 'to12mm')
        fields = self.present(value, seal=seal)
        self.assertEqual(fields['Installation Details'], value)
        self.assertEqual(fields['Seal Depth / Fillet Size'], seal)
