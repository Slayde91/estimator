import unittest

from scripts.snap_slab_variations import plan_slab_variations


def selector(product, size, service, element, frl, report='FAR3932', application='Stack - Cast-in'):
    return dict(product_generic_code=product, nominal_size=size, service_name=service,
                element_name=element, frl=frl, report_name=report, application_name=application,
                fitting_allowed='No')


def existing(rating='-/180/180', installation='', issues=''):
    return {'record': {'fields': [{'label': 'FRL', 'value': rating},
                                  {'label': 'Installation Details', 'value': installation},
                                  {'label': 'Source Issues', 'value': issues}]}}


class SnapSlabVariationTests(unittest.TestCase):
    def test_floor_waste_has_two_specific_builds_and_keeps_unrelated_notes(self):
        row = selector('H50FWS', '40 mm', 'PVC-DWV', 'Concrete Slab (150mm) + Screed (35mm)',
                       '-/240/240', application='Floor Waste & Shower - Cast-in')
        issue = 'SNAP lists -/240/240. The searchable rating for the specified assembly is -/180/180 under FAR3932 Issue 3.'
        installation = ('Install the pipe and puddle flange, then place bedding on the concrete.\n\n'
                        'FAR3932 Table 3 p10 gives penetration-only -/240/240 for this pipe and collar. '
                        'Provide the floor waste grate and a 150 mm slab plus 35 mm topping as shown in the source assembly. '
                        'Seal the pipe-to-slab gap at the unexposed face.\n\n' + issue)
        amendments, children = plan_slab_variations(
            {4134: row}, {4134: existing(installation=installation, issues=issue+'\n\nRetain this source note.')})
        self.assertEqual(amendments[4134]['source_issues'], 'Retain this source note.')
        self.assertIn('35 mm topping', amendments[4134]['install'])
        self.assertEqual([(x['element'], x['frl']) for x in children], [('Concrete Slab (185mm)', '-/240/240')])
        child = children[0]
        self.assertNotIn('bedding', child['install'])
        self.assertNotIn('35 mm', child['install'])
        self.assertIn('Seal the pipe-to-slab gap', child['install'])

    def test_far3932_special_minima_and_integrity_insulation_are_independent(self):
        rows = {
            4101: selector('H150FWS', '160 mm', 'PPR-80 SDR7.4 Faser Composite', 'Concrete Slab (175mm)', '-/240/180'),
            4130: selector('H150FWS', '150 mm', 'PVC-DWV', 'Concrete Slab (170mm)', '-/240/240'),
            4214: selector('H150FWS', '160 mm', 'HDPE', 'Concrete Slab (180mm)', '-/180/180'),
        }
        _, children = plan_slab_variations(rows, {sid: existing() for sid in rows})
        self.assertEqual([(x['parent_sid'], x['element'], x['frl']) for x in children], [
            (4101, 'Concrete Slab (180mm)', '-/240/180'),
            (4130, 'Concrete Slab (150mm)', '-/180/180'),
            (4130, 'Concrete Slab (180mm)', '-/240/240'),
        ])

    def test_thinner_retrofit_and_cap_limited_triplus_do_not_gain_240_minutes(self):
        row = selector('50R', '50 mm', 'Triplus', 'Concrete Slab (150mm)', '-/180/180',
                       report='FAR3933', application='Stack - Retrofit')
        _, children = plan_slab_variations({3800: row}, {3800: existing()})
        self.assertEqual([(x['element'], x['frl']) for x in children], [('Concrete Slab (120mm)', '-/120/120')])

    def test_pn12_beam_and_duplicate_slab_rows_keep_their_source_geometry(self):
        beam = selector('H50S', '40 mm', 'PVC-PN12', 'Concrete Beam (under 150mm slab)', '-/180/180', report='FCO3426')
        stack = selector('L50FWS', '40 mm', 'PVC-DWV', 'Concrete Slab (150mm)', '-/240/240')
        rows = {1853: beam, 4144: stack, 4174: stack.copy()}
        _, children = plan_slab_variations(rows, {sid: existing() for sid in rows})
        self.assertEqual([(x['parent_sid'], x['element']) for x in children], [
            (1853, 'Concrete Beam (under 120mm slab)'), (4144, 'Concrete Slab (120mm)'),
            (4144, 'Concrete Slab (180mm)'),
        ])
