import unittest

from scripts.snap_assessed_variations import TABLE_32, apply_configuration, fields_by_label, wall_amendments


class SnapWallVariationsTests(unittest.TestCase):
    def test_table_32_keeps_each_rating_with_its_material_and_pipe(self):
        rows, entries = {}, {}
        for index, size in enumerate((40, 50, 65, 80, 90, 100)):
            for sid, masonry in ((821 + index, True), (755 + index, False)):
                element = 'Concrete or Masonry Wall (130mm)' if masonry else 'Concrete Wall (120mm)'
                masonry_rating = '-/180/180' if size == 40 else '-/180/120'
                rows[sid] = {'report_name': 'FCO3520', 'nominal_size': f'{size} mm',
                             'service_name': 'PVC-DWV (SC)' if size == 100 else 'PVC-DWV',
                             'fitting_allowed': 'Yes', 'element_name': element,
                             'product_generic_code': f'UC{size}+', 'frl': masonry_rating if masonry else '-/120/120'}
                comparison = ('SNAP lists -/180/180 for concrete or masonry.' if sid == 821 else
                              f'SNAP lists {masonry_rating} for this row and specifies an effective FRL of -/120/120.')
                entries[sid] = {'record': {
                    'id': str(sid), 'title': f'SNAP UC{size}+ — example — {element} — -/120/120',
                    'summary': comparison if masonry else '', 'filter_values': {'frl': ['-/120/120']}, 'sources': [],
                    'fields': [{'label': 'FRL', 'value': '-/120/120'}, {'label': 'Barrier Construction', 'value': element},
                               {'label': 'Installation Details', 'value': 'Keep coupling instructions.' + ('\n\n' + comparison if masonry else '')},
                               {'label': 'Source Issues', 'value': 'Separate product note.' + ('\n\n' + comparison if sid == 821 else '')}]}}
        amendments = wall_amendments(rows, entries)
        rows[826]['service_name'] = 'PVC-DWV'
        with self.assertRaisesRegex(ValueError, '826'):
            wall_amendments(rows, entries)
        for sid, update in amendments.items():
            with self.subTest(sid=sid):
                record = entries[sid]['record']
                apply_configuration(record, update)
                fields = fields_by_label(record)
                rating = '-/120/120' if sid < 821 else ('-/180/180' if sid == 821 else '-/180/120')
                self.assertEqual(record['filter_values']['frl'], [rating])
                self.assertEqual(fields['FRL'], rating)
                self.assertEqual(fields['Barrier Construction'], 'Masonry Wall (minimum 130 mm)' if sid >= 821
                                 else 'Concrete Wall (minimum 120 mm)')
                self.assertTrue(record['title'].endswith(f'{fields["Barrier Construction"]} — {rating}'))
                self.assertEqual(fields['Installation Details'], 'Keep coupling instructions.')
                self.assertEqual(fields['Source Issues'], 'Separate product note.')
                self.assertEqual(record['summary'], '')
                self.assertIn(TABLE_32, record['sources'])
