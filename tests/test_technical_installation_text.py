"""Transfer only the selected variant's exact repeated fields into readable steps."""
from copy import deepcopy
import unittest

from estimator.technical_installation_text import present_installation_fields
from estimator.technical_display import technical_field_text


class ReviewedStructuralTextTests(unittest.TestCase):
    profile_note = ("Use an SHS designation within this system's listed range that is expressly included in "
                    'FAS210123 R2.0 Table 97. ')
    scope = 'Follow FAS210123 R2.0 and FAS200363 R2.4 for the assessed configuration.'

    def present(self, barrier, text, *, size='89SHS6.3', scope=scope):
        fields = [{'label': label, 'value': value} for label, value in (
            ('Barrier Construction', barrier), ('Service Size / Configuration', size),
            ('Installation Details', text), ('Assessment Scope', scope),
            ('FRL', '-/120/120'), ('Max. Opening Size', '587 mm × 990 mm'),
        )]
        present_installation_fields(fields)
        once = deepcopy(fields)
        present_installation_fields(fields)
        self.assertEqual(fields, once)
        return {field['label']: field['value'] for field in fields}

    def test_assessed_rediwall_and_wrapped_section_keep_steps_and_conditions(self):
        fields = self.present('AFS RediWall RW156C, minimum 156 mm',
            'Use 156 mm AFS RediWall RW156C tested or assessed by an accredited testing laboratory to '
            'achieve at least 120 minutes of integrity and insulation under AS 1530.4:2014, as specified '
            'by FAS200363 R2.4 § 4.4.8. Fit the mechanically fixed Slide-on End Caps. '
            'See FAS200363 R2.4 Table 1, page 10, § 11.3.1 and Appendix A.28.\n\n' +
            self.profile_note + 'Extend wrap 500 mm from each board face. '
            'Use the symmetrical service protection shown in the tested prototypes. '
            'See FAS210123 R2.0, pages 60, 62 and Table 97, pages 160–161.')
        self.assertEqual(fields['Installation Details'],
                         'Fit the mechanically fixed Slide-on End Caps.\n\nExtend wrap 500 mm from each board face.')
        self.assertIn('at least 120 minutes of integrity and insulation under AS 1530.4:2014', fields['Assessment Scope'])
        self.assertIn('the same service protection on each side', fields['Assessment Scope'])
        self.assertEqual(fields['FRL'], '-/120/120')
        self.assertEqual(fields['Max. Opening Size'], '587 mm × 990 mm')

    def test_kingspan_rating_and_wrap_free_steps_remain_available(self):
        fields = self.present('150 mm Kingspan K-Roc Firemaster Ultima wall',
            'Use a 150mm Kingspan K-Roc Firemaster Ultima wall tested or assessed by an Accredited '
            'Testing Laboratory to achieve -/180/180 or 180/180/180. Reinforce the aperture.\n\n' +
            self.profile_note + 'Install the service protection symmetrically. '
            'See FAS210123 R2.0 Table 97, pages 165–166.', size='180SHS5')
        self.assertEqual(fields['Installation Details'], 'Reinforce the aperture.\n\nInstall the service protection symmetrically.')
        self.assertIn('FRL -/180/180 or 180/180/180', fields['Assessment Scope'])

    def test_profile_range_and_other_report_scopes_keep_section_selection_note(self):
        for kwargs in ({'size': 'SHS up to 250 x 10'}, {'scope': 'See FAS210123 R2.0 only.'}):
            with self.subTest(kwargs=kwargs):
                value = self.profile_note + 'Seal exposed board edges.'
                self.assertEqual(self.present('Structural wall', value, **kwargs)['Installation Details'], value)


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
    def test_extracted_page_labels_leave_source_steps_and_page_conditions_intact(self):
        source = ('Page 1, 2: 1. Cut the opening.\n2. Apply sealant to 20 mm depth. Page 1: Keep both faces sealed.\n'
                  '4. Where specified on page 2, wrap for 300 mm. See page 3 for approved services.')
        expected = ('1. Cut the opening.\n2. Apply sealant to 20 mm depth. Keep both faces sealed.\n'
                    '4. Where specified on page 2, wrap for 300 mm. See page 3 for approved services.')
        self.assertEqual(self.present(source)['Installation Details'], expected)
        self.assertEqual(self.present('Page 1, 2: Fit the collar. Page 1: Secure with ties.')['Installation Details'],
                         'Fit the collar. Secure with ties.')

    def test_only_the_exact_service_field_receives_the_reviewed_capitalisation(self):
        fields = [{'label': 'Service', 'value': 'fibre optic cables'},
                  {'label': 'Service Size / Configuration', 'value': 'Empty or containing fibre optic cables.'},
                  {'label': 'Service', 'value': 'uPVC pipe with fibre optic cables'}]
        expected = deepcopy(fields)
        expected[0]['value'] = 'Fibre Optic Cables'
        present_installation_fields(fields)
        self.assertEqual(fields, expected)

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
