import unittest

from estimator.trafalgar_superstopper_installation import trafalgar_superstopper_installation_fields


def afs_variant(system_id, service, size):
    values = {
        'Manufacturer': 'Trafalgar', 'System Products': 'SuperSTOPPER Circular', 'Barrier Type': 'Walls',
        'Orientation': 'Vertical', 'Barrier Construction': 'AFS RW156C', 'Service': service,
        'Service Size / Configuration': size, 'FRL': '-/120/120', 'Annular Gap': 'up to 20mm',
        'Service Wrap': '300mm', 'Seal Depth / Fillet Size': '20mm (Both Sides) / No Fillet',
        'Collar': 'Cutout to suit',
    }
    fields = [{'label': label, 'value': value} for label, value in values.items()]
    fields.append({'label': 'Report Number', 'value': 'FC10266-01-5', 'report_links': [
        {'url': 'https://tfire.com.au/documents/Superstopper-orange-box-Range-Test-Report'}]})
    return {'id': f'trafalgar-selector-{system_id}'}, fields


class TrafalgarSuperstopperInstallationTests(unittest.TestCase):
    def test_exact_circular_configurations_get_plain_steps_and_service_scope(self):
        cases = [
            (8582, 'Pipes - Steel', 'Up to NB50', 'Uninsulated steel pipes up to NB50'),
            (8588, 'Paircoil Bundle', 'Up to 9.5 and 19mm Copper with up to 13mm PE insulation or 20mm FR insulation',
             '13 mm PE or 20 mm fire-rated insulation'),
            (8595, 'Conduits - PVC', 'Rigid or Flexible Conduits up to 32mm', 'uPVC conduits up to NB32'),
        ]
        for system_id, service, size, scope in cases:
            with self.subTest(system_id=system_id):
                record, fields = afs_variant(system_id, service, size)
                result = trafalgar_superstopper_installation_fields(record, fields)
                values = {field['label']: field['value'] for field in result}
                self.assertIn(scope, values['Assessment Scope'])
                self.assertIn('permanent formwork in place', values['Assessment Scope'])
                details = values['Installation Details']
                self.assertIn('at least 20 mm deep from each face', details)
                self.assertIn('at least 300 mm from each face', details)
                self.assertNotRegex(details, r'(?i)\b(?:table|figure|page)\b')
                self.assertNotIn('Installation Details', {field['label'] for field in fields})
                self.assertIs(trafalgar_superstopper_installation_fields(record, result), result)

    def test_does_not_apply_to_unsupported_product_service_or_aperture(self):
        record, fields = afs_variant(8583, 'Pipes - Copper, Pipes - Stainless Steel', 'Up to NB50')
        self.assertIs(trafalgar_superstopper_installation_fields(record, fields), fields)
        for label, value in [('System Products', 'SuperSTOPPER Maxi'), ('Service Wrap', '450mm'),
                             ('Maximum Opening Size', '1.8m long and 1.62m²')]:
            with self.subTest(label=label):
                record, fields = afs_variant(8582, 'Pipes - Steel', 'Up to NB50')
                fields = [field for field in fields if field['label'] != label]
                fields.append({'label': label, 'value': value})
                self.assertIs(trafalgar_superstopper_installation_fields(record, fields), fields)

    def test_preserves_an_existing_scope_with_ancillary_evidence(self):
        record, fields = afs_variant(8582, 'Pipes - Steel', 'Up to NB50')
        fields.append({'label': 'Assessment Scope', 'value': '', 'images': [{'id': 'evidence'}]})
        self.assertIs(trafalgar_superstopper_installation_fields(record, fields), fields)
