import unittest

from scripts.prepare_snap_library import build_entry, by_id, FILTER_URL


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
        self.assertNotIn('type', record['filter_values'])
        self.assertEqual(record['filter_values']['frl'], ['-/120/120'])
        self.assertEqual(fields['FRL'], '-/120/120')
        self.assertIn('SNAP lists -/180/120', fields['Installation Details'])
        self.assertIn('side of the beam', fields['Installation Details'])
        self.assertNotIn('Generic slab', fields['Installation Details'])
        self.assertIn('on request', fields['Installation Details'])
        self.assertNotIn('report_links', record['fields'][-1])

    def test_figure_link_preserves_its_page_and_literal_product_code(self):
        render = {'path': 'guide-drawings/images/page2.png', 'sha256': 'a' * 64,
                  'url': 'https://docs.snapcollars.com.au/Example Guide.pdf', 'page': 2}
        guide = {'render': render, 'caption': 'Installation guide, wall figure, page 2'}
        entry = build_entry(self.row, self.assoc, self.product, {}, guide, {})
        self.assertEqual(entry['drawings'][0]['path'], render['path'])
        self.assertIn({'label': guide['caption'], 'url': 'https://docs.snapcollars.com.au/Example%20Guide.pdf#page=2'},
                      entry['record']['sources'])
        self.assertNotIn('Source Issues', [f['label'] for f in entry['record']['fields']])

    def test_source_ids_are_distinct_even_when_all_displayed_values_match(self):
        self.assertEqual(len(by_id([self.row, {**self.row, 'system_id': 11}])), 2)
        with self.assertRaises(ValueError):
            by_id([self.row, self.row])
