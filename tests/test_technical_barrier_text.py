"""Presentation changes must preserve an option's qualifications and row identity."""
import unittest

from estimator.technical_barrier_text import barrier_construction_text, present_barrier_text


class BarrierTextTests(unittest.TestCase):
    def test_report_wraps_and_named_examples(self):
        cases = {
            'Minimum 100 mm thick\nconcrete, masonry and Hebel\nwalls capable of achieving\n\n'
            'FRL 180/180/180 OR\n-/180/180 (Item 39)':
                'Min. 100 mm thick concrete, masonry and Hebel walls capable of achieving '
                'FRL 180/180/180 or -/180/180 (Item 39).',
            'Min. 150 mm thick Kingspan K-\nRoc panel wall.\nCapable of min. FRL of -\n/90/90':
                'Min. 150 mm thick Kingspan K-Roc panel wall. Capable of min. FRL of -/90/90',
            'Min’ 120 mm thick Concrete, Masonry or\nHebel Floor. Capable of minimum\nFRL120/120/120 '
            '(Item 13)': 'Min’ 120 mm thick Concrete, Masonry or Hebel Floor. '
                         'Capable of minimum FRL 120/120/120 (Item 13).',
            'Concrete, Masonry or Hebel Floor\nMinimum 120 mm thick\nCapable of minimum FRL90/90/90 '
            '(Item\n34)': 'Concrete, Masonry or Hebel Floor, minimum 120 mm thick. '
                          'Capable of minimum FRL 90/90/90 (Item 34).',
            'Concrete, Masonry or Hebel Floor\nMinimum 200mm thick\nCapable of minimum FRL '
            '120/120/120\n(Item 60)': 'Concrete, Masonry or Hebel Floor, minimum 200 mm thick. '
                                      'Capable of minimum FRL 120/120/120 (Item 60).',
            'Minimum 100 mm thick\nconcrete, masonry and Hebel walls capable of achieving\n'
            'FRL 120/120/120 OR\n-/120/120 (item 22)': 'Min. 100 mm thick concrete, masonry and Hebel '
                'walls capable of achieving FRL 120/120/120 or -/120/120 (item 22).',
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(barrier_construction_text(source), expected)
                self.assertEqual(barrier_construction_text(expected), expected)

    def test_conditions_and_independent_alternatives_keep_their_boundaries(self):
        source = ('Min. 116 mm thick plasterboard\nwall. Capable of min. FRL of -/120/120 (Item\n32),\n'
                  'Or,\nMin. 100 mm thick masonry, concrete,\nconcrete block or AAC block wall.\n'
                  'Capable of min. FRL of -/120/120 (Item\n22)\n\nNote: Seal the\nwall as tested.')
        expected = ('Min. 116 mm thick plasterboard wall. Capable of min. FRL of -/120/120 (Item 32),\n'
                    'Or,\nMin. 100 mm thick masonry, concrete, concrete block or AAC block wall. '
                    'Capable of min. FRL of -/120/120 (Item 22).\n\nNote: Seal the wall as tested.')
        self.assertEqual(barrier_construction_text(source), expected)
        variants = ('Min. 120 mm thick concrete floor. Capable of minimum FRL 120/120/120 (Item 13).\n'
                    'Min. 120 mm thick concrete floor. Capable of minimum FRL 90/90/90 (Item 34).')
        self.assertEqual(barrier_construction_text(variants), variants)

    def test_explicit_list_construction_and_qualifications_survive(self):
        values = ['• Concrete Floor — Minimum substrate thickness: 150 mm\n'
                  '• AAC / Hebel Floor — Minimum substrate thickness: 150 mm',
                  'Concrete floor\nPlasterboard wall',
                  'Min. 120 mm thick wall. Capable of FRL 90/90/90 (Item 39) only with the tested lining.',
                  'FRL 120/120/120 except as qualified below.\n(A) Concrete\n(B) Masonry']
        for source in values:
            self.assertEqual(barrier_construction_text(source), source)

    def test_only_barrier_fields_and_columns_change(self):
        source = 'Min. 150 mm thick Kingspan K-\nRoc panel wall.'
        flowed = 'Min. 150 mm thick Kingspan K-Roc panel wall.'
        fields = [{'label': 'Barrier Construction', 'value': source},
                  {'label': 'Service Size / Configuration', 'value': source, 'table_row_ids': [['A', 'B']],
                   'table': {'columns': ['Separating Element', 'Service', 'FRL'],
                             'rows': [[source, source, '-/90/90'], ['Other wall', 'Other service', '-/60/60']]}}]
        present_barrier_text(fields)
        self.assertEqual(fields[0]['value'], flowed)
        self.assertEqual(fields[1]['value'], source)
        self.assertEqual(fields[1]['table_row_ids'], [['A', 'B']])
        self.assertEqual(fields[1]['table']['rows'],
                         [[flowed, source, '-/90/90'], ['Other wall', 'Other service', '-/60/60']])
