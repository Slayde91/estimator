from copy import deepcopy
import unittest

from estimator.trafalgar_fyre_batt_installation import trafalgar_fyre_batt_installation


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
