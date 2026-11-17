import unittest

from scripts.prepare_snap_library import apply_assessment, build_entry, by_id, FILTER_URL


class SnapSourceMappingTests(unittest.TestCase):
    def setUp(self):
        self.row = {
            'system_id': 10, 'product_generic_code': 'H100S', 'service_name': 'HDPE',
            'nominal_size': '110 mm', 'element_name': 'Concrete Beam (under 150mm slab)',
            'fitting_allowed': 'No', 'application_name': 'Stack - Cast-in',
            'product_type': 'High-top Cast-in', 'frl': '-/180/120', 'report_name': 'TEST',
            'report_publish_status': 'On Request',
            'note': [{'notes': 'The effective FRL of this system is -/120/120'}],
        }
        url = 'https://www.snapcollars.com.au/products/fire-collar/H100S'
        self.assoc = {'product_code': 'H100S', 'product_url': url, 'source_url': FILTER_URL,
                      'report_name': 'TEST', 'report_status': 'On Request', 'report_url': None,
                      'drawing_url': None}
        self.product = {'product_desc': 'SNAP H100S', 'product_url': url, 'guide_urls': [],
                        'installation_by_application': {'Stack - Cast-in': 'Generic slab method.'},
                        'installation_by_system': {'10': 'Fit into the side of the beam.'}}

    def test_beam_scope_and_explicit_effective_rating_reach_filters_and_detail(self):
        record = build_entry(self.row, self.assoc, self.product, {}, None, {})['record']
        fields = {f['label']: f['value'] for f in record['fields']}
        self.assertEqual(record['filter_values']['substrate'], ['Concrete beam'])
        self.assertEqual(record['filter_values']['orientation'], ['Vertical'])
        self.assertEqual(record['filter_values']['type'], ['Core hole'])
        self.assertEqual(fields['Installation Type'], 'Stack - Cast-in (High-top Cast-in)')
        self.assertEqual(record['filter_values']['frl'], ['-/120/120'])
        self.assertEqual(fields['FRL'], '-/120/120')
        self.assertIn('SNAP lists -/180/120', fields['Installation Details'])
        self.assertIn('side of the beam', fields['Installation Details'])
        self.assertNotIn('Generic slab', fields['Installation Details'])
        self.assertIn('on request', fields['Installation Details'])
        self.assertNotIn('report_links', record['fields'][-1])

    def test_opening_type_matches_cast_in_and_retrofit_applications(self):
        for application, element, expected in [
                ('Floor Waste & Shower - Cast-in', 'Concrete Slab (150mm)', 'Core hole'),
                ('Stack - Retrofit', 'Concrete Slab (150mm)', 'Core hole'),
                ('Wall - Retrofit', 'Speedpanel Wall (78mm) + PB Patch 1x13mm each side', 'Core hole'),
                ('Wall - Retrofit', 'PB Wall - 2x13mm each side + PB Patch (142 mm)', 'Core hole'),
                ('Stack - Retrofit', 'Concrete Slab (150mm) + MGO Board (10mm) + Steel Plate (1mm)', 'Oversized core hole')]:
            with self.subTest(application=application, element=element):
                row = {**self.row, 'application_name': application, 'element_name': element}
                record = build_entry(row, self.assoc, self.product, {}, None, {})['record']
                self.assertEqual(record['filter_values']['type'], [expected])
                self.assertEqual(next(f['value'] for f in record['fields'] if f['label'] == 'Barrier Construction'), element)

    def test_figure_link_preserves_its_page_and_literal_product_code(self):
        render = {'path': 'guide-drawings/images/page2.png', 'sha256': 'a' * 64,
                  'url': 'https://docs.snapcollars.com.au/Example Guide.pdf', 'page': 2}
        guide = {'render': render, 'caption': 'Installation guide, wall figure, page 2'}
        entry = build_entry(self.row, self.assoc, self.product, {}, guide, {})
        self.assertEqual(entry['drawings'][0]['path'], render['path'])
        self.assertIn({'label': guide['caption'], 'url': 'https://docs.snapcollars.com.au/Example%20Guide.pdf#page=2'},
                      entry['record']['sources'])
        self.assertNotIn('Source Issues', [f['label'] for f in entry['record']['fields']])

    def test_nominal_cpvc_inches_use_the_matching_report_and_retain_the_selector_value(self):
        source_url = 'https://docs.snapcollars.com.au/FSP2188.pdf'
        row = {**self.row, 'service_name': 'C-PVC', 'nominal_size': '1.25 Inch mm',
               'product_generic_code': '50R', 'report_name': 'FSP2188', 'report_publish_status': 'Public'}
        assoc = {**self.assoc, 'product_code': '50R', 'report_name': 'FSP2188',
                 'report_url': source_url, 'report_status': 'Public'}
        record = build_entry(row, assoc, self.product, {}, None, {})['record']
        fields = {field['label']: field['value'] for field in record['fields']}
        self.assertEqual(fields['Service Size / Configuration'], '1.25 inch. Fitting allowed: No.')
        self.assertIn('1.25 inch C-PVC', record['title'])
        self.assertIn('1.25 Inch mm', fields['Source Issues'])
        self.assertIn('FSP2188, page 9', fields['Source Issues'])
        self.assertIn(source_url + '#page=9', [s['url'] for s in record['sources']])
        for change in [{'service_name': 'PVC-DWV'}, {'product_generic_code': '32R'}]:
            with self.subTest(change=change):
                other = {**row, **change}
                other_assoc = {**assoc, 'product_code': other['product_generic_code']}
                record = build_entry(other, other_assoc, self.product, {}, None, {})['record']
                self.assertIn('1.25 Inch mm', record['title'])

    def test_source_ids_are_distinct_even_when_all_displayed_values_match(self):
        self.assertEqual(len(by_id([self.row, {**self.row, 'system_id': 11}])), 2)
        with self.assertRaises(ValueError):
            by_id([self.row, self.row])

    def test_assessment_cap_matches_search_detail_and_export_fields(self):
        self.row['note'] = []
        entry = build_entry(self.row, self.assoc, self.product, {}, None, {})
        issue = 'The selector lists -/180/120. The assessment supports -/120/120 in this assembly.'
        ref = {'label': 'Assessment table', 'url': 'https://docs.snapcollars.com.au/example.pdf#page=8'}
        apply_assessment(entry, {'effective_frl': '-/120/120', 'source_issue': issue,
                                 'service_configuration': 'Assessed pipe wall thickness 4 mm.',
                                 'references': [ref]})
        record = entry['record']
        fields = {f['label']: f['value'] for f in record['fields']}
        self.assertEqual(record['filter_values']['frl'], ['-/120/120'])
        self.assertEqual(fields['FRL'], '-/120/120')
        self.assertIn(issue, fields['Installation Details'])
        self.assertIn(issue, fields['Source Issues'])
        self.assertTrue(record['title'].endswith(' — -/120/120'))
        self.assertIn('4 mm', fields['Service Size / Configuration'])
        self.assertIn(ref, record['sources'])
        with self.assertRaisesRegex(ValueError, 'lower rating'):
            apply_assessment(entry, {'effective_frl': '-/180/180', 'source_issue': issue, 'references': []})
