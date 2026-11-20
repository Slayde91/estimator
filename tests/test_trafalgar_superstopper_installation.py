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
            (8587, 'Pipes - Insulated', 'Copper pipes up to 50mm with FR Insulation or up to 20mm PE insulation',
             'up to 20 mm PE insulation'),
            (8588, 'Paircoil Bundle', 'Up to 9.5 and 19mm Copper with up to 13mm PE insulation or 20mm FR insulation',
             '13 mm PE or 20 mm fire-rated insulation'),
            (8590, 'Cables - Fire', 'TPS Fire Cables', 'twelve 2.5 mm² copper-core TPS cables'),
            (8592, 'Cables - Fibre Optic', 'Fibre Optic Cables', 'NBN-grade fibre-optic cable'),
            (8593, 'Cables - Aluminium', '120mm2, 240mm2 28mm OD, 70mm2 17mm OD', '16 cables in total'),
            (8594, 'Cables - Data & Comms', 'RG6', 'three RG6 coaxial cables per bundle'),
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

    def test_power_and_communications_wraps_use_assessed_loading_and_infill(self):
        variants = (
            (8585, 'Cables - Data & Comms', 'Appendix D2 Comms', '400mm', '450 mm', 'Group B'),
            (8586, 'Cables - Power', 'Appendix D1 Power', '600mm', '600 mm', 'Group A'),
        )
        for system_id, service, size, old_wrap, assessed_wrap, group in variants:
            with self.subTest(system_id=system_id):
                record, fields = afs_variant(system_id, service, size)
                next(field for field in fields if field['label'] == 'Service Wrap')['value'] = old_wrap
                result = trafalgar_superstopper_installation_fields(record, fields)
                values = {field['label']: field['value'] for field in result}
                self.assertIn(group, values['Assessment Scope'])
                self.assertIn(f'{assessed_wrap} from each face', values['Service Wrap'])
                self.assertIn('300 mm loose TWrap infill on each side', values['Service Wrap'])
                self.assertIn('Remove the foil', values['Installation Details'])

    def test_pex_uses_the_assessed_wrap_and_preserves_the_original_input(self):
        record, fields = afs_variant(8584, 'Pipes - PEX', 'Up to NB32')
        size = next(field for field in fields if field['label'] == 'Service Size / Configuration')
        size['table'] = {
            'columns': ['Configuration', 'Service size / condition', 'Wrap requirement'],
            'rows': [
                ['Wrap configuration 1', 'PEX up to NB20 and PEX-AL-PEX up to NB25', '300mm'],
                ['Wrap configuration 2', 'PEX and PEX-AL-PEX up to NB32', '450mm'],
            ],
        }
        wrap = next(field for field in fields if field['label'] == 'Service Wrap')
        wrap.update(value='', table_links=[{'field': size['label'], 'table_index': 0}])
        fields.append({'label': 'Source Issues', 'value': 'No source diagram or diagram link was supplied for '
                       'this entry. Its configuration tables are selector summaries; their completeness cannot '
                       'be checked against a diagram.'})
        by_label = {field['label']: field for field in trafalgar_superstopper_installation_fields(record, fields)}
        self.assertIn('at least 450 mm', by_label['Installation Details']['value'])
        self.assertIn('up to NB32', by_label['Assessment Scope']['value'])
        self.assertEqual(by_label[wrap['label']]['value'], '450 mm from each face of the wall')
        self.assertNotIn('table', by_label[size['label']])
        self.assertNotIn('table_links', by_label[wrap['label']])
        self.assertEqual(size['table']['rows'][0][-1], '300mm')
        self.assertEqual(wrap['value'], '')

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
