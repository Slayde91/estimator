from copy import deepcopy
import unittest

from estimator.library_facets import (CATEGORIES, SERVICES, FRLS, classify_facets,
                                      facet_options, frl_values, service_values)
from estimator.library_report_links import valid_report_url, FIREFLY_REPORTS_URL
from estimator.technical_frl_presentation import normalize_frl_presentation
from tests import test_reference_library as fixtures


def record(**values):
    return {'fields': [{'label': k.replace('_', ' '), 'value': v} for k, v in values.items()]}


class LibraryFacetTests(unittest.TestCase):
    def test_requested_options_remain_available_in_requested_order(self):
        for key, expected in [('category', CATEGORIES), ('services', SERVICES), ('frl', FRLS)]:
            self.assertEqual(facet_options(key, []), list(expected))
            self.assertEqual(facet_options(key, ['extra']), list(expected) + ['extra'])

    def test_cable_ties_and_supporting_steel_do_not_classify_pipe_service(self):
        item = record(Service='Copper pipe', Installation_Details='Fix wrap with steel cable ties',
                      Barrier_Construction='Steel framed wall FRL -/180/180', FRL='-/120/120')
        self.assertEqual(classify_facets(item), {'services': ['Unlagged Pipes'],
                         'category': ['Plumbing & Hydraulic'], 'frl': ['-/120/120']})

    def test_metal_pipe_insulation_is_not_cable_insulation(self):
        item = record(Service='Steel pipe', **{'Service Size / Configuration': 'PVC insulated power cables in adjacent source are not service details'})
        self.assertNotIn('Lagged Pipes', service_values(item))
        self.assertIn('Lagged Pipes', service_values(record(Service='Copper pipe with 25 mm pipe insulation')))

    def test_structural_types_and_access_panel_do_not_become_pipes(self):
        for value, service in [('Structural Elements - Steel, UB up to 610UB125', 'Structural Steel'),
                               ('Structural Elements, Kwila beam', 'Structural Timber'),
                               ('Fire rated access panel', 'Access Panel')]:
            self.assertIn(service, service_values(record(Service=value)))
        self.assertEqual(service_values(record(Service='Structural Elements - Timber',
                         **{'Service Size / Configuration': 'Timber Purlin maximum 45mm wide x 285mm high'})),
                         ['Structural Timber'])
        self.assertEqual(service_values(record(Service='Pipes - Drinks Python',
                         **{'Service Size / Configuration': '14 tubes with 30mm FR foam insulation'})),
                         ['Lagged Pipes'])
        self.assertIn('Communications Cables', service_values(record(Service='Cables - Data & Comms, Cables - Power')))

    def test_blank_linear_and_bulkhead_categories(self):
        self.assertEqual(classify_facets(record(Installation_Type='Horizontal Linear Gap Seal'))['services'], ['Linear Joints'])
        self.assertEqual(classify_facets(record(Installation_Type='Framed Bulkhead'))['category'], ['Bulkheads'])

    def test_configuration_sizes_and_explicit_continuation_mapping(self):
        item = record(**{'Service Size / Configuration': 'Bundle of up to 35 CAT6 cables'})
        self.assertIn('Data Cable Bundles', service_values(item))
        item = {'fields': [], 'filter_values': {'services': ['Plastic Pipes']}}
        self.assertEqual(classify_facets(item)['category'], ['Plumbing & Hydraulic'])

    def test_retained_other_service_rows_do_not_reclassify_specific_entry(self):
        item = record(Service='Coaxial cable')
        item['fields'].append({'label': 'Service Size / Configuration', 'value': '',
                               'table': {'columns': ['Service Type', 'Service Detail'],
                                         'rows': [['D1 Power cables', 'cable tray']]}})
        self.assertEqual(service_values(item), ['Coaxial Cables'])

    def test_middle_frl_is_found_without_inventing_intermediates(self):
        item = record(FRL='-/60/60 to -/120/120')
        item['fields'][0]['table_links'] = [{'field': 'Service Size / Configuration', 'table_index': 0}]
        item['fields'].append({'label': 'Service Size / Configuration', 'value': '', 'table': {
            'columns': ['Size', 'FRL'], 'rows': [['10', '-/60/60'], ['20', '-/90/90'], ['30', '-/120/120']]}})
        before = deepcopy(item)
        self.assertEqual(frl_values(item), ['-/60/60', '-/90/90', '-/120/120'])
        self.assertEqual(item, before)
        self.assertEqual(frl_values(record(FRL='-/60/60 to -/120/120')), ['-/60/60', '-/120/120'])

    def test_scope_selects_only_matched_row_and_column(self):
        table = {'label': 'Barrier Construction', 'value': '', 'table': {
            'columns': ['Wall', 'FRL', 'FRL Without Wrap'],
            'rows': [['A', '-/120/120', '-/60/60'], ['B', '-/180/180', '-/90/90']]}}
        item = record(FRL='-/120/120 — matched source barrier row (Barrier Construction table 1; Wall: A).')
        item['fields'][0]['table_links'] = [{'field': 'Barrier Construction', 'table_index': 0}]
        item['fields'].append(table)
        self.assertEqual(frl_values(item), ['-/60/60', '-/120/120'])
        item['fields'][0]['value'] = '-/60/60 to -/90/90 — source substrate alternatives (Barrier Construction table 1; FRL Without Wrap). The entry selection remains separate.'
        self.assertEqual(frl_values(item), ['-/60/60', '-/90/90'])

    def test_unrelated_source_table_and_supporting_capacity_are_excluded(self):
        item = record(FRL='Selector / previously recorded rating: -/60/60\n\nService Size / Configuration table 1: related source ratings only; applicability to this entry is not established.')
        item['fields'][0]['table_links'] = [{'field': 'Service Size / Configuration', 'table_index': 0}]
        item['fields'].append({'label': 'Service Size / Configuration', 'value': '', 'table': {
            'columns': ['FRL'], 'rows': [['-/240/240']]}})
        self.assertEqual(frl_values(item), ['-/60/60'])

    def test_qualified_ratings_dash_masks_and_missing_data_stay_distinct(self):
        self.assertEqual(frl_values(record(FRL='-/90/90 + 60 RISF; -/120/-; 120/120/120')),
                         ['-/90/90', '-/120/-', '120/120/120'])
        self.assertEqual(frl_values(record(FRL='120 - product')), ['Not specified'])
        self.assertEqual(frl_values(record(Service='Blank for future use')), ['N/A'])
        self.assertEqual(frl_values(record(FRL='-90/90')), ['-/90/90'])
        self.assertEqual(frl_values(record(FRL='/240/180 (100 mm mortar)')), ['-/240/180'])

    def test_duplicate_selector_note_removed_only_with_matching_source(self):
        note = 'Selector / previously recorded rating: Up to -/120/120'
        item = record(FRL=note+'\n\n-/120/120 — observed source service ratings (Service Size / Configuration table 1).')
        item['fields'][0]['table_links'] = [{'field': 'Service Size / Configuration', 'table_index': 0}]
        item['fields'].append({'label': 'Service Size / Configuration', 'value': '', 'table': {
            'columns': ['FRL'], 'rows': [['-/120/120']]}})
        result = normalize_frl_presentation(item['fields'])
        self.assertNotIn('previously recorded', result[0]['value'])
        item['fields'][1]['table']['rows'] = [['-/60/60']]
        self.assertIn(note, normalize_frl_presentation(item['fields'])[0]['value'])

    def test_only_exact_firefly_report_directory_is_allowed(self):
        self.assertTrue(valid_report_url(FIREFLY_REPORTS_URL))
        for url in [FIREFLY_REPORTS_URL+'?redirect=evil', FIREFLY_REPORTS_URL+'/other',
                    'https://systems.tbafirefly.com.au.evil/reports',
                    'https://user@systems.tbafirefly.com.au/reports']:
            self.assertFalse(valid_report_url(url))


class FacetIntegrationTests(unittest.TestCase):
    setUp = fixtures.ReferenceLibraryTests.setUp
    write = fixtures.ReferenceLibraryTests.write

    def test_facet_intersection_and_firefly_links_use_projected_record(self):
        self.data['documents'][0]['filename'] = 'FIREFLY report.pdf'
        item = self.data['libraries']['technical']['items'][0]
        item['fields'] += [{'label': 'Service', 'value': 'Copper pipe'},
                           {'label': 'FRL', 'value': '-/90/90 to -/120/120'},
                           {'label': 'Report Number', 'value': 'EXAMPLE'}]
        self.write(self.data)
        result = self.library.listing('technical', category='Plumbing & Hydraulic', services='Unlagged Pipes', frl='-/90/90')
        self.assertEqual(result['total'], 1)
        self.assertEqual(self.library.listing('technical', frl='-/60/60')['total'], 0)
        detail = self.library.detail('technical', item['id'])
        field = next(f for f in detail['fields'] if f['label'] == 'Report Number')
        self.assertEqual(field['report_links'], [{'label': 'EXAMPLE', 'url': FIREFLY_REPORTS_URL}])
