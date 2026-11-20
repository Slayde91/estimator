from copy import deepcopy
import unittest

from estimator.library_report_links import validate_report_links
from estimator.trafalgar_maxilite_installation import trafalgar_maxilite_installation_fields


def selector(system_id='4279', **overrides):
    values = {
        'ID': system_id,
        'Manufacturer': 'Trafalgar',
        'System Products': 'FyreBOARD Maxilite, SuperSTOPPER Maxi',
        'Barrier Type': 'Shaft Walls',
        'Orientation': 'Vertical',
        'Barrier Construction': 'Shaftliner (CH Stud 25mm + 2x16mm)',
        'Service': 'Pipes - Steel',
        'Service Size / Configuration': 'Up to 60mm OD',
        'FRL': '-/120/120 (Min. 60mm Maxilite)',
        'Maximum Opening Size': 'Size of aperture to be maximum 1.8m long and have a maximum area of 1.62m²',
        'Service Wrap': '300mm',
        'Seal Depth / Fillet Size': '20mm (Both Sides) / No Fillet',
    }
    values.update(overrides)
    fields = [{'label': label, 'value': value} for label, value in values.items() if value is not None]
    fields.append({'label': 'Report Number', 'value': 'FC10266-01-5', 'report_links': [{
        'label': 'FC10266-01-5', 'url': 'https://tfire.com.au/documents/Superstopper-orange-box-Range-Test-Report',
    }]})
    return {'id': f'trafalgar-selector-{system_id}'}, fields


class TrafalgarMaxiliteInstallationTests(unittest.TestCase):
    def test_shaftliner_maxi_uses_the_assessed_wall_and_preserves_original_report(self):
        record, fields = selector()
        original = deepcopy(fields)
        reviewed = trafalgar_maxilite_installation_fields(record, fields)
        by_label = {field['label']: field for field in reviewed}
        scope = by_label['Assessment Scope']['value']
        details = by_label['Installation Details']['value']
        for clause in ('64 mm CH steel studs', '25 mm shaftliner', 'two 16 mm fire-rated', '150 mm of residual',
                       '350, 550, 650, 750 or 1100 mm wide', 'span between the board supports', 'Table 1a'):
            self.assertIn(clause, scope)
        for clause in ('100 mm on all sides', 'plasterboard side only', 'through the full depth', '5–10 mm gap',
                       'full exposed casing', '300 mm beyond each exposed face', 'both faces with 8g × 50 mm screws'):
            self.assertIn(clause, details)
        self.assertIn('1.62 m²', by_label['Maximum Opening Size']['value'])
        self.assertIn('board dimension less 200 mm', by_label['Maximum Opening Size']['value'])
        self.assertEqual(by_label['Report Number']['report_links'][0], original[-1]['report_links'][0])
        self.assertIn('FCO 2586 Revision I', by_label['Report Number']['value'])
        validate_report_links(by_label['Report Number'])
        self.assertEqual(fields, original)
        self.assertIs(trafalgar_maxilite_installation_fields(record, reviewed), reviewed)

    def test_concrete_mini_applies_its_distinct_casing_and_wall_fixings(self):
        record, fields = selector('4386', **{
            'System Products': 'FyreBOARD Maxilite, SuperSTOPPER Mini',
            'Barrier Type': None,
            'Barrier Construction': 'Concrete/Masonry',
        })
        reviewed = {field['label']: field['value'] for field in trafalgar_maxilite_installation_fields(record, fields)}
        self.assertIn('wall at least 120 mm thick', reviewed['Assessment Scope'])
        self.assertIn('102 × 102 mm', reviewed['Assessment Scope'])
        self.assertIn('spans up to 850 mm', reviewed['Assessment Scope'])
        self.assertIn('M6 × 100 mm masonry anchors', reviewed['Installation Details'])

    def test_keeps_the_public_catalogue_code(self):
        record, fields = selector(**{'ID': 'CF-example'})
        reviewed = {field['label']: field['value'] for field in trafalgar_maxilite_installation_fields(record, fields)}
        self.assertIn('Installation Details', reviewed)
        self.assertEqual(reviewed['ID'], 'CF-example')

    def test_double_layer_communications_uses_longer_wrap_and_loose_infill(self):
        record, fields = selector('4456', **{
            'System Products': 'FyreBOARD Maxilite, SuperSTOPPER Mini',
            'Barrier Type': 'Walls',
            'Barrier Construction': 'Double Layer FR Plasterboard (Min. 2x13mm)',
            'Service': 'Cables - Data & Comms',
            'Service Size / Configuration': 'Appendix D2 Comms',
            'Service Wrap': '400mm',
        })
        reviewed = {field['label']: field['value'] for field in trafalgar_maxilite_installation_fields(record, fields)}
        self.assertIn('13 mm fire-rated plasterboard on each face', reviewed['Assessment Scope'])
        self.assertIn('300 mm foil-free TWrap infill', reviewed['Service Wrap'])
        self.assertIn('450 mm beyond each exposed face of the wall and Maxilite assembly', reviewed['Service Wrap'])
        self.assertIn('Group B copper-core', reviewed['Service Size / Configuration'])

    def test_requires_exact_configuration_and_reviewed_report(self):
        cases = (
            ('4278', {}),
            ('4279', {'Orientation': 'Horizontal'}),
            ('4279', {'Barrier Construction': 'Hebel 75mm'}),
            ('4279', {'Service Wrap': '450mm'}),
            ('4279', {'Maximum Opening Size': '1000 × 1000 mm'}),
            ('4279', {'Installation Details': 'Existing reviewed procedure'}),
        )
        for system_id, overrides in cases:
            with self.subTest(system_id=system_id, overrides=overrides):
                record, fields = selector(system_id, **overrides)
                self.assertIs(trafalgar_maxilite_installation_fields(record, fields), fields)
        record, fields = selector()
        self.assertIs(trafalgar_maxilite_installation_fields({**record, 'user_authored': True}, fields), fields)
        fields[-1]['report_links'][0]['url'] = 'https://tfire.com.au/documents/FyreBATT-Test-Report'
        self.assertIs(trafalgar_maxilite_installation_fields(record, fields), fields)
