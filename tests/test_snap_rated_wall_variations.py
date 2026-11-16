import unittest

from scripts.snap_rated_wall_variations import PLASTERBOARD, SOLID, plan_rated_wall_variations, table_14


class SnapRatedWallTests(unittest.TestCase):
    def row(self, sid, element, size, code, listed, effective):
        row = {'system_id': sid, 'report_name': 'FAR3929', 'application_name': 'Wall - Retrofit',
               'element_name': element, 'service_name': 'HDPE', 'nominal_size': size,
               'product_generic_code': code, 'fitting_allowed': 'No', 'frl': listed}
        fields = {'Barrier Construction': element, 'FRL': effective,
                  'Installation Details': 'Keep pipe alignment.\n\nKeep the product-specific instructions.\n\n'
                                          'SNAP lists -/180/120 for this row and specifies an effective FRL of -/120/120.',
                  'Source Issues': 'Retain the pipe identification note.'}
        entry = {'record': {'fields': [{'label': k, 'value': v} for k, v in fields.items()]}}
        return row, entry

    def test_reference_and_independently_rated_walls_keep_their_assessed_constructions(self):
        pairs = [
            self.row(1, PLASTERBOARD, '110 mm', '110R', '-/180/120', '-/120/120'),
            self.row(2, PLASTERBOARD, '40 mm', '50R', '-/180/180', '-/180/180'),
            self.row(3, SOLID, '110 mm', '110R', '-/180/120', '-/120/120'),
            self.row(4, SOLID, '40 mm', '50R', '-/180/180', '-/180/180'),
        ]
        rows = {r['system_id']: r for r, _ in pairs}
        entries = {r['system_id']: e for r, e in pairs}
        parents, variants = plan_rated_wall_variations(rows, entries)
        variant = {s['parent_sid']: s for s in variants}
        self.assertEqual(set(parents), {1, 2, 3, 4})
        self.assertEqual(set(variant), {1, 2, 3})
        self.assertIn('Reference plasterboard wall (128 mm', parents[1]['element'])
        self.assertIn('minimum 128 mm, independently rated -/180/180', variant[1]['element'])
        self.assertEqual(variant[1]['frl'], '-/180/120')
        self.assertEqual(variant[2]['frl'], '-/120/120')
        self.assertIn('two layers of 16 mm', variant[2]['install'])
        self.assertIn('Concrete or masonry wall (minimum 128 mm', variant[3]['element'])
        for spec in [*parents.values(), *variant.values()]:
            self.assertIn('Keep the product-specific instructions.', spec['install'])
            self.assertNotIn('SNAP lists', spec['install'])
            self.assertEqual(spec['source_issues'], 'Retain the pipe identification note.')
            self.assertEqual([r['url'].split('#')[1] for r in spec['sources']], ['page=18', 'page=19'])

    def test_table_location_and_fitting_must_match_the_actual_assessment_cell(self):
        row, entry = self.row(1, PLASTERBOARD, '20 mm', '32R', '-/180/180', '-/180/180')
        self.assertEqual(table_14({**row, 'service_name':'PE100 SDR 7.4'}), ('-/180/180', 20))
        self.assertEqual(table_14({**row, 'service_name':'PPR-80 SDR7.4 Faser Composite'}), ('-/180/180', 20))
        with self.assertRaisesRegex(ValueError, 'no reviewed'):
            table_14({**row, 'service_name':'PE100 SDR 7.4', 'fitting_allowed':'Yes'})
        for service, size, code, fitting, expected in [
                ('PVC-DWV (SC)', '100 mm', '110R', 'No', '-/180/180'),
                ('PVC-DWV (SC)', '100 mm', '110R', 'Yes', '-/180/120'),
                ('PVC-DWV', '50 mm', '50R', 'No', '-/180/120'),
                ('PVC-DWV', '50 mm', '50R', 'Yes', '-/180/180')]:
            with self.subTest(service=service, fitting=fitting):
                self.assertEqual(table_14({**row, 'service_name': service, 'nominal_size': size,
                    'product_generic_code': code, 'fitting_allowed': fitting}), (expected, 19))
        with self.assertRaisesRegex(ValueError, 'rated cell differs'):
            plan_rated_wall_variations({1:{**row, 'service_name': 'PE100 SDR 7.4', 'frl': '-/180/120'}}, {1:entry})
