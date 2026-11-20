from copy import deepcopy
import unittest

from estimator.trafalgar_fyre_batt_installation import (
    present_verified_fyre_batt_service_sizes,
    trafalgar_fyre_batt_installation,
)


class TrafalgarFyreBattInstallationTests(unittest.TestCase):
    def conduit(self):
        fields = [
            {'label': label, 'value': value} for label, value in {
                'Manufacturer': 'Trafalgar',
                'Report Number': 'FAS 210123',
                'Barrier Type': 'Walls',
                'Orientation': 'Vertical',
                'Barrier Construction': 'Korok Walls 78mm',
                'FRL': '-/90/90',
                'Service': 'Conduits - PVC',
                'Service Size / Configuration': '20mm Diameter Flexi or Rigid PVC pipe',
                'Service Wrap': 'Wrap Free',
                'System Products': 'FyreBATT 50, FyreMASTIC A-R, FyreBAND GWS',
                'Seal Depth / Fillet Size': ('2 x layers of FyreBAND GWS on both sides of FyreBATT 50 / '
                                            'FyreMASTIC A-R 5 x 5mm fillet'),
            }.items()
        ]
        return {'id': 'trafalgar-selector-9174', 'fields': fields}, fields

    def test_preserves_source_and_applies_both_service_and_wall_procedure(self):
        record, fields = self.conduit()
        original = deepcopy(record)
        result = trafalgar_fyre_batt_installation(record, fields)
        detail = next(field['value'] for field in result if field['label'] == 'Installation Details')
        self.assertIn('100 mm overlap', detail)
        self.assertIn('100 mm spiral screws at 200 mm centres', detail)
        self.assertIn('1 mm or less', detail)
        self.assertIn('5 × 5 mm fillet', detail)
        self.assertNotRegex(detail, r'(?i)\b(?:table|figure|page)\b')
        self.assertEqual(record, original)
        self.assertEqual([field for field in result if field['label'] != 'Installation Details'], fields)
        self.assertEqual(trafalgar_fyre_batt_installation(record, result), result)

    def test_requires_exact_service_scope_rating_and_report(self):
        for label, value in (
                ('Orientation', 'Horizontal'), ('FRL', '-/180/180'),
                ('Report Number', 'FAS 200363'), ('Service Wrap', '300mm'),
                ('Service Size / Configuration', '25mm Diameter PVC pipe'),
                ('Source Issues', 'Seal depth conflicts with the test.')):
            with self.subTest(label=label):
                record, fields = self.conduit()
                fields[:] = [field for field in fields if field['label'] != label]
                fields.append({'label': label, 'value': value})
                self.assertIs(trafalgar_fyre_batt_installation(record, fields), fields)

    def test_matches_substrate_to_d1_service_limited_insulation_rating(self):
        record, fields = self.conduit()
        record['id'] = 'trafalgar-selector-9231'
        updates = {
            'Barrier Construction': 'Concrete/Masonry walls',
            'FRL': '-/120/30',
            'Service': 'Cable Trays, Cables - Power',
            'Service Size / Configuration': 'Appendix D1 Copper Power Cables, with or without cable tray',
            'System Products': 'FyreBATT 50, FyreMASTIC A-R , FyreMASTIC HP-R',
            'Seal Depth / Fillet Size': ('FyreMASTIC HP-R Full Depth / Bead of FyreMASTIC A-R Around the Sides '
                                         'and Bottom of Cable Tray'),
        }
        for field in fields:
            if field['label'] in updates:
                field['value'] = updates[field['label']]
        result = trafalgar_fyre_batt_installation(record, fields)
        detail = next(field['value'] for field in result if field['label'] == 'Installation Details')
        self.assertIn('at least 116 mm thick', detail)
        self.assertIn('at least 100 mm overlap', detail)
        self.assertIn('450 × 50 mm', detail)
        self.assertIn('If a cable tray is used', detail)

    def test_corrects_only_assessed_pvc_conduit_and_carries_the_cable_conditions(self):
        record, fields = self.conduit()
        record['id'] = 'trafalgar-selector-9198'
        values = {'Service Size / Configuration': '25mm or 30mm PVC Conduit',
                  'System Products': 'FyreBATT 50, FyreMASTIC HP-R',
                  'Seal Depth / Fillet Size': 'FyreMASTIC HP-R Full Depth/ Flush finish both sides'}
        for field in fields:
            field['value'] = values.get(field['label'], field['value'])
        unmatched = deepcopy(record)
        unmatched['id'] = 'trafalgar-selector-9191'
        original = deepcopy(unmatched)
        present_verified_fyre_batt_service_sizes(unmatched)
        self.assertEqual(unmatched, original)
        self.assertIs(trafalgar_fyre_batt_installation(record, fields), fields)
        present_verified_fyre_batt_service_sizes(record)
        result = {field['label']: field for field in trafalgar_fyre_batt_installation(record, fields)}
        self.assertEqual(result['Service Size / Configuration']['value'], '25 or 32 mm PVC conduit with two 2.5 mm² TPS cables')
        self.assertIn('2 mm wall', result['Installation Details']['value'])
        self.assertIn('8–12 mm gap', result['Installation Details']['value'])
        self.assertIn('24SFR00068', result['Installation Details']['source_labels'][0])

    def test_combines_exact_pex_seal_with_selected_wall(self):
        record, fields = self.conduit()
        record['id'] = 'trafalgar-selector-9222'
        values = {'Service': 'Pipes - PEX Pipes',
                  'Service Size / Configuration': '16mm PE-Xa or 16mm PEX - Al - PEX Pipe',
                  'System Products': 'FyreBATT 50, FyreMASTIC HP-R',
                  'Seal Depth / Fillet Size': 'FyreMASTIC HP-R Full Depth / Flush finish both sides'}
        for field in fields:
            field['value'] = values.get(field['label'], field['value'])
        details = next(field['value'] for field in trafalgar_fyre_batt_installation(record, fields)
                       if field['label'] == 'Installation Details')
        for expected in ('100 mm overlap', '16 mm PE-Xa or PEX-Al-PEX', '2.29 mm wall', '10–30 mm gap'):
            self.assertIn(expected, details)

    def test_corrects_purlin_thickness_and_obeys_the_180_minute_wall_limit(self):
        record, fields = self.conduit()
        record['id'] = 'trafalgar-selector-9309'
        values = {'Service': 'Structural Elements - Steel',
                  'Service Size / Configuration': 'UB up to 410UB54 or C Purlin 200 x 12mm',
                  'Barrier Construction': 'Kingspan Walls - KRoc Firemaster Ultima Walls', 'FRL': '-/180/180',
                  'Service Wrap': '300mm both sides', 'System Products': 'FyreBATT 50, FyreMASTIC A-R, ServoWrap',
                  'Seal Depth / Fillet Size': '30 x 30mm Fillet of FyreMASTIC A-R on Outside of Wrap'}
        for field in fields:
            field['value'] = values.get(field['label'], field['value'])
        present_verified_fyre_batt_service_sizes(record)
        result = {field['label']: field['value'] for field in trafalgar_fyre_batt_installation(record, fields)}
        self.assertEqual(result['Service Size / Configuration'], 'UB up to 410UB54 or C purlin up to 200 × 1.2 mm')
        for expected in ('fire-rated 150 mm', '600 mm high and 1100 mm wide', '300 mm of ServoWrap', '30 × 30 mm'):
            self.assertIn(expected, result['Installation Details'])
