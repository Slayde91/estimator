from copy import deepcopy
import unittest

from estimator.library_facets import (CATEGORIES, SERVICES, FRLS, classify_facets,
                                      facet_options, frl_values, service_values)
from estimator.library_report_links import valid_report_url, FIREFLY_REPORTS_URL
from estimator.technical_frl_presentation import normalize_frl_presentation
from tests import test_reference_library as fixtures


def record(**values):
    return {'fields': [{'label': k.replace('_', ' '), 'value': v} for k, v in values.items()]}


REQUESTED_SERVICES = [
    'Access Panel', 'Blank Seal', 'Busbar Trunking', 'Cable Bundles',
    'Cable Trays', 'Coaxial Cables', 'Conduits', 'D1 Power Cables',
    'D2 Comms Cables', 'Data Cables', 'Downlights', 'Fibre Optic',
    'Fire Dampers', 'Fire Resistant Cables', 'Flexible Ducts', 'Junction Box',
    'Lagged Copper Pipes', 'Lagged Steel Pipes', 'Linear Joints',
    'Mixed Services', 'Movement Joints', 'Pair Coils', 'uPVC pipe',
    'uPVC floorwaste', 'PEX pipe', 'HDPE pipe', 'Power Cables', 'Single Cables',
    'TPS & Fire Alarm Cables', 'Copper Pipes', 'Steel Pipes',
    'Air Transfer Grilles', 'Communications Cables', 'Structural Steel',
    'Structural Timber', 'Wall Sockets',
]


class LibraryFacetTests(unittest.TestCase):
    def test_requested_options_remain_available_in_requested_order(self):
        for key, expected in [('category', CATEGORIES), ('frl', FRLS)]:
            self.assertEqual(facet_options(key, []), list(expected))
            self.assertEqual(facet_options(key, ['extra']), list(expected) + ['extra'])
        self.assertEqual(list(SERVICES), REQUESTED_SERVICES)
        self.assertEqual(facet_options('services', ['Plastic Pipes', 'Saved custom service',
                                                   'Data Cable Bundles']), REQUESTED_SERVICES)

    def test_cable_ties_and_supporting_steel_do_not_classify_pipe_service(self):
        item = record(Service='Copper pipe', Installation_Details='Fix wrap with steel cable ties',
                      Barrier_Construction='Steel framed wall FRL -/180/180', FRL='-/120/120')
        self.assertEqual(classify_facets(item), {'services': ['Copper Pipes', 'Unlagged Pipes'],
                         'category': ['Plumbing & Hydraulic'], 'frl': ['-/120/120']})

    def test_material_filters_require_scoped_explicit_material_evidence(self):
        cases = [
            ('uPVC pipe', 'uPVC pipe', 'Plastic Pipes'),
            ('PVC-U floor waste', 'uPVC floorwaste', 'Plastic Pipes'),
            ('uPVC floorwaste', 'uPVC floorwaste', 'Plastic Pipes'),
            ('PEX pipe', 'PEX pipe', 'Plastic Pipes'),
            ('PE-X pipe', 'PEX pipe', 'Plastic Pipes'),
            ('HDPE pipe', 'HDPE pipe', 'Plastic Pipes'),
            ('Copper pipe', 'Copper Pipes', 'Unlagged Pipes'),
            ('Unlagged copper pipe', 'Copper Pipes', 'Lagged Pipes'),
            ('Pipes - Steel', 'Steel Pipes', 'Unlagged Pipes'),
            ('Lagged copper pipe', 'Lagged Copper Pipes', 'Lagged Pipes'),
            ('Steel pipe with 25mm pipe insulation', 'Lagged Steel Pipes', 'Lagged Pipes'),
        ]
        for source, exact, legacy in cases:
            with self.subTest(source=source):
                item = record(Service=source)
                before = deepcopy(item)
                result = classify_facets(item)
                self.assertIn(exact, result['services'])
                self.assertIn(legacy, result['services'])
                self.assertEqual(result['category'], ['Plumbing & Hydraulic'])
                self.assertEqual(item, before)
        precise = set(REQUESTED_SERVICES[16:18] + REQUESTED_SERVICES[22:26]
                      + ['Copper Pipes', 'Steel Pipes'])
        for source in ('Plastic pipes', 'Lagged pipes', 'Unlagged pipes',
                       'PVC pipe', 'LDPE pipe', 'Pair coil with copper pipe'):
            with self.subTest(source=source):
                self.assertFalse(precise.intersection(service_values(record(Service=source))))
        broad = {'fields': [], 'filter_values': {'services': ['Plastic Pipes', 'Lagged Pipes']}}
        self.assertFalse(precise.intersection(classify_facets(broad)['services']))
        self.assertNotIn('Steel Pipes', service_values(record(Service='Copper pipe',
                          Installation_Details='Steel pipes support the assembly')))
        ambiguous = record(Service='Mixed copper pipe and steel pipe bundle',
                           **{'Service Size / Configuration': 'Pipe insulation shown for one service'})
        self.assertNotIn('Lagged Copper Pipes', service_values(ambiguous))
        self.assertNotIn('Lagged Steel Pipes', service_values(ambiguous))

    def test_mixed_service_materials_do_not_borrow_another_pipe_or_floorwaste_identity(self):
        cases = [
            ('uPVC conduits and copper pipes', [], ['uPVC pipe', 'uPVC floorwaste']),
            ('uPVC pipe and HDPE cable conduits', ['uPVC pipe'], ['HDPE pipe']),
            ('uPVC pipe and copper floor waste', ['uPVC pipe'], ['uPVC floorwaste']),
            ('PEX cable conduit and steel pipe', ['Steel Pipes'], ['PEX pipe']),
            ('HDPE pipe and uPVC floor waste', ['HDPE pipe', 'uPVC floorwaste'], ['uPVC pipe']),
            ('Copper pipe and HDPE pipe with pipe insulation', ['HDPE pipe'], ['Lagged Copper Pipes']),
        ]
        for source, present, absent in cases:
            with self.subTest(source=source):
                values = service_values(record(Service=source))
                for value in present: self.assertIn(value, values)
                for value in absent: self.assertNotIn(value, values)

    def test_new_cable_labels_retain_historical_matching_tokens(self):
        data = service_values(record(Service='Bundle of CAT6 data cables'))
        self.assertIn('Data Cables', data)
        self.assertIn('Data Cable Bundles', data)
        self.assertIn('Cable Bundles', data)
        alarm = service_values(record(Service='TPS and fire alarm cable bundles'))
        self.assertIn('TPS & Fire Alarm Cables', alarm)
        self.assertIn('TPS & Fire Alarm Cable Bundles', alarm)
        for source in ('Data pipes and power cables', 'Data duct with power cable',
                       'CAT6 pipes beside coaxial cables', 'Data pipes and power cable bundles'):
            with self.subTest(source=source):
                self.assertNotIn('Data Cables', service_values(record(Service=source)))
                self.assertNotIn('Data Cables', classify_facets(record(Service=source))['services'])
        for source in ('TPS pipes and coaxial cables', 'Fire alarm pipe and power cable'):
            with self.subTest(source=source):
                self.assertNotIn('TPS & Fire Alarm Cables', service_values(record(Service=source)))
                self.assertNotIn('TPS & Fire Alarm Cables', classify_facets(record(Service=source))['services'])
        for source in ('TPS cable', 'Fire alarm cable', 'Cables - TPS', 'TPS & Fire Alarm Cables'):
            with self.subTest(source=source):
                self.assertIn('TPS & Fire Alarm Cables', service_values(record(Service=source)))

    def test_explicit_historical_bundle_tokens_gain_general_discovery_without_renaming(self):
        for legacy, general in [('Data Cable Bundles', 'Data Cables'),
                                ('Power Cable Bundles', 'Power Cables'),
                                ('TPS & Fire Alarm Cable Bundles', 'TPS & Fire Alarm Cables')]:
            with self.subTest(legacy=legacy):
                item = {'fields': [], 'filter_values': {'services': [legacy]}}
                before = deepcopy(item)
                self.assertEqual(classify_facets(item)['services'], sorted([legacy, general]))
                self.assertEqual(item, before)
                literal = record(Service=legacy)
                self.assertIn(general, classify_facets(literal)['services'])
                self.assertEqual(literal['fields'][0]['value'], legacy)
        for legacy in ('Plastic Pipes', 'Lagged Pipes', 'Unlagged Pipes', 'Cable Bundles'):
            self.assertEqual(classify_facets({'fields': [], 'filter_values': {'services': [legacy]}})['services'], [legacy])

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

    def test_imported_and_derived_service_aliases_share_one_facet(self):
        item = record(Service='Mixed cable and lagged copper pipe bundle with pair coil')
        item['filter_values'] = {'services': ['Mixed Service Bundle', 'Multi-service Bundle',
                                             'Mixed Services', 'Pair Coil Bundle', 'Pair coils']}
        before = deepcopy(item)
        result = classify_facets(item)
        self.assertIn('Mixed Services', result['services'])
        self.assertIn('Pair Coils', result['services'])
        for alias in ['Mixed Service Bundle', 'Multi-service Bundle', 'Pair Coil Bundle', 'Pair coils']:
            self.assertNotIn(alias, result['services'])
        self.assertIn('HVAC', result['category'])
        self.assertIn('Plumbing & Hydraulic', result['category'])
        self.assertEqual(item, before)

    def test_removed_service_option_does_not_remove_record_classification(self):
        item = record(Service='Floor/Deck Boxes')
        services = classify_facets(item)['services']
        self.assertEqual(services, ['Floor/Deck Boxes'])
        self.assertNotIn('Floor/Deck Boxes', facet_options('services', services))
        options = facet_options('services', ['Mixed Service Bundle', 'Multi-service Bundle', 'Pair Coil Bundles'])
        self.assertEqual(options.count('Mixed Services'), 1)
        self.assertEqual(options.count('Pair Coils'), 1)
        self.assertNotIn('Pair Coil Bundles', options)

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
        item['fields'][0]['value'] = ('Selector / previously recorded rating: -/60/60\n\n'
            '-/120/90 to -/120/120 — observed concrete-slab service ratings '
            '(Service Size / Configuration table 1; applicability to the CLT entry is not established).')
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
        item['fields'][0]['value'] = item['fields'][0]['value'].replace('Up to', 'up to')
        self.assertNotIn('previously recorded', normalize_frl_presentation(item['fields'])[0]['value'])
        item['fields'][0]['value'] = item['fields'][0]['value'].replace('up to', 'Up to')
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

    def test_precisely_typed_legacy_bundle_queries_and_new_labels_find_the_same_source(self):
        original = self.data['libraries']['technical']['items'][0]
        self.data['libraries']['technical']['filters'].append({'key': 'services', 'label': 'Services'})
        pairs = [('Data Cable Bundles', 'Data Cables'), ('Power Cable Bundles', 'Power Cables'),
                 ('TPS & Fire Alarm Cable Bundles', 'TPS & Fire Alarm Cables')]
        items = []
        for n, (legacy, _) in enumerate(pairs):
            item = deepcopy(original)
            item['id'] = original['id'] if n == 0 else f'cable-{n}'
            item.setdefault('filter_values', {})['services'] = [legacy]
            items.append(item)
        self.data['libraries']['technical']['items'] = items
        self.write(self.data)
        source_bytes = (self.root / 'library.json').read_bytes()
        for n, (legacy, general) in enumerate(pairs):
            self.assertEqual(self.library.listing('technical', services=legacy)['items'][0]['id'], items[n]['id'])
            self.assertEqual(self.library.listing('technical', services=general)['items'][0]['id'], items[n]['id'])
            self.assertEqual(self.library.listing('technical', services=general)['total'], 1)
        self.assertEqual((self.root / 'library.json').read_bytes(), source_bytes)

    def test_exact_choices_find_specific_records_without_expanding_broad_legacy_types(self):
        original = self.data['libraries']['technical']['items'][0]
        self.data['libraries']['technical']['filters'].append({'key': 'services', 'label': 'Services'})
        items = []
        for n, (source, legacy) in enumerate([
                ('uPVC floor waste', None), ('HDPE pipe', None),
                ('Copper pipe', None), ('Lagged steel pipe', None),
                ('', 'Plastic Pipes'), ('', 'Lagged Pipes')]):
            item = deepcopy(original)
            item['id'] = original['id'] if n == 0 else f'service-{n}'
            item['fields'].append({'label': 'Service', 'value': source})
            if legacy: item.setdefault('filter_values', {})['services'] = [legacy]
            items.append(item)
        self.data['libraries']['technical']['items'] = items
        self.write(self.data)
        source_bytes = (self.root / 'library.json').read_bytes()
        for label in ('uPVC floorwaste', 'HDPE pipe', 'Copper Pipes', 'Lagged Steel Pipes'):
            self.assertEqual(self.library.listing('technical', services=label)['total'], 1)
        self.assertEqual(self.library.listing('technical', services='PEX pipe')['total'], 0)
        self.assertEqual(self.library.listing('technical', services='Plastic Pipes')['total'], 3)
        self.assertEqual(self.library.listing('technical', services='Lagged Pipes')['total'], 2)
        choices = next(entry['options'] for entry in self.library.listing('technical')['filters']
                       if entry['key'] == 'services')
        self.assertEqual([entry['value'] for entry in choices], REQUESTED_SERVICES)
        self.assertEqual((self.root / 'library.json').read_bytes(), source_bytes)

    def test_canonical_filter_finds_records_imported_with_each_alias(self):
        original = self.data['libraries']['technical']['items'][0]
        self.data['libraries']['technical']['filters'].append({'key': 'services', 'label': 'Services'})
        items = []
        for n, alias in enumerate(['Mixed Service Bundle', 'Mixed Services', 'Multi-service Bundle']):
            item = deepcopy(original)
            item['id'] = original['id'] if n == 0 else f'mixed-{n}'
            item.setdefault('filter_values', {})['services'] = [alias]
            items.append(item)
        self.data['libraries']['technical']['items'] = items
        self.write(self.data)
        self.assertEqual(self.library.listing('technical', services='Mixed Services')['total'], 3)

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
