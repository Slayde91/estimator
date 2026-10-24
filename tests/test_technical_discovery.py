"""Discovery aliases preserve source, saved-link and duplicate-review inputs."""
from copy import deepcopy
import json
import unittest

from estimator.library_facets import MOVED_SERVICE_CATEGORIES, SERVICES
from estimator.library_opening_types import opening_type, report_opening_type
from estimator.technical_discovery import (FRL_ALIASES, canonical_frl, discovery_facets,
                                          present_frl_text, present_technical)
from estimator.technical_duplicates import review_fingerprint
from tests import test_reference_library as fixtures


def record(**values):
    return {'fields': [{'label': key.replace('_', ' '), 'value': value}
                       for key, value in values.items()]}


class DiscoveryTests(unittest.TestCase):
    def test_exact_requested_frl_aliases_and_zero_criteria_are_display_only(self):
        expected = {**FRL_ALIASES, '-/60/0': '-/60/-', '-/120/0': '-/120/-',
                    '0/120/120': '-/120/120'}
        for source, target in expected.items():
            with self.subTest(source=source):
                self.assertEqual(canonical_frl(source), target)
                self.assertEqual(present_frl_text('FRL ' + source + ' subject to wrap.'),
                                 'FRL ' + target + ' subject to wrap.')
        for value in ('-/15/-', '-/15/15', '-/120/60', '150/150/150', '-/300/300'):
            self.assertEqual(canonical_frl(value), value)
        self.assertEqual(present_frl_text('10–20 mm — FRL –/60/0'), '10–20 mm — FRL -/60/-')
        self.assertEqual(present_frl_text('Service dimensions 0/20/30 and cable code 0/120/120'),
                         'Service dimensions 0/20/30 and cable code 0/120/120')
        self.assertEqual(present_frl_text('0', rating=True), '-')
        self.assertEqual(present_frl_text('0'), '0')
        known = record(FRL='0/120/120'); known.update(title='System 0/120/120', subtitle='0/120/120')
        self.assertEqual(present_technical(known)['title'], 'System -/120/120')
        self.assertEqual(present_technical(known)['subtitle'], '-/120/120')

    def test_primary_d1_and_d2_do_not_cross_classify_from_notes(self):
        for primary, note, expected, excluded in (
                ('D1 copper power cables', 'D2 communication cables', 'D1 Power Cables', 'D2 Comms Cables'),
                ('D2 copper communication cables', 'D1 power cables', 'D2 Comms Cables', 'D1 Power Cables')):
            for separator in ('\nNOTE:\n', '\nNotes: ', '\n\n', '. NOTE: ', '. Notes: '):
                item = record(**{'Service': 'cables', 'Service Size / Configuration':
                    primary + separator + 'Any ratio of ' + note + ' may be included.'})
                item['filter_values'] = {'services': [expected, excluded]}
                before = deepcopy(item)
                services = discovery_facets(item)['services']
                self.assertIn(expected, services)
                self.assertNotIn(excluded, services)
                self.assertEqual(item, before)
        mixed = record(Service='Mixed D1 power cables and D2 communication cables')
        self.assertTrue({'D1 Power Cables', 'D2 Comms Cables'} <= set(discovery_facets(mixed)['services']))
        mixed = record(Service='Any ratio of D1 power cables and D2 communication cables')
        self.assertTrue({'D1 Power Cables', 'D2 Comms Cables'} <= set(discovery_facets(mixed)['services']))

    def test_non_service_prose_is_not_primary_service_evidence(self):
        item = record(Service='Copper pipe', Installation_Details='D1 power and D2 communications cables nearby.')
        self.assertFalse({'D1 Power Cables', 'D2 Comms Cables'} & set(discovery_facets(item)['services']))

    def test_category_only_items_and_junction_box_use_new_picker_taxonomy(self):
        for name in MOVED_SERVICE_CATEGORIES:
            item = {'fields': [], 'filter_values': {'services': [name]}}
            result = discovery_facets(item)
            self.assertIn(name, result['category'])
            self.assertEqual(result['services'], ['N/A'])
        self.assertEqual(SERVICES[0], 'N/A')
        self.assertFalse(MOVED_SERVICE_CATEGORIES & set(SERVICES))
        self.assertEqual(discovery_facets(record(Service='Junction box'))['services'], ['Conduits'])

    def test_unrecognized_real_service_does_not_mean_not_applicable(self):
        item = record(Service='Specialist device47')
        before = deepcopy(item)
        self.assertEqual(discovery_facets(item)['services'], [])
        self.assertEqual(item, before)
        self.assertEqual(discovery_facets({'fields': [], 'filter_values': {'services': ['N/A']}})['services'],
                         ['N/A'])

    def test_report_type_uses_structured_basis_and_does_not_search_notes(self):
        for report, expected in (('FAS190234', 'Oversized core hole'),
                                 ('FAS190235', 'Oversized core hole'),
                                 ('FAS190236', 'Core hole')):
            for basis in ({'filter_values': {'document': [report]}},
                          {'fields': [{'label': 'Report Number', 'value': report + ' RIR1.2'}]},
                          {'sources': [{'document_id': report.lower()}]}):
                item = {**record(System_Products='board'), **basis}
                before = deepcopy(item)
                self.assertEqual(opening_type(item), expected)
                self.assertEqual(report_opening_type(item), {'type': expected, 'reports': [report]})
                self.assertEqual(item, before)
        incidental = record(Installation_Details='Refer to FAS190234 and FAS190235 for other systems.')
        self.assertIsNone(report_opening_type(incidental))
        self.assertEqual(opening_type(incidental), 'Core hole')
        self.assertIsNone(report_opening_type({'filter_values': {'document': ['FAS190235', 'FAS190236']}}))

    def test_presentation_copies_visible_fields_but_keeps_retained_source_basis_exact(self):
        item = record(FRL='-/120/15', Barrier_Construction='Wall FRL -/60/0')
        item['fields'][0]['table'] = {'columns': ['FRL', 'Dimension'], 'rows': [['-/240/210', '0/0/0']]}
        item['technical_basis'] = {'source_fields': deepcopy(item['fields'])}
        before = deepcopy(item)
        result = present_technical(item)
        self.assertEqual(result['fields'][0]['value'], '-/120/-')
        self.assertEqual(result['fields'][0]['table']['rows'], [['-/240/180', '0/0/0']])
        self.assertEqual(result['fields'][1]['value'], 'Wall FRL -/60/-')
        self.assertEqual(result['technical_basis'], before['technical_basis'])
        self.assertEqual(item, before)


class DiscoveryIntegrationTests(unittest.TestCase):
    setUp = fixtures.ReferenceLibraryTests.setUp
    write = fixtures.ReferenceLibraryTests.write

    def test_hidden_fifteen_minute_choices_retain_records_and_saved_queries(self):
        first = self.data['libraries']['technical']['items'][0]
        first['fields'].append({'label': 'FRL', 'value': '-/15/-'})
        second = deepcopy(first); second['id'] = 'fifteen-two'; second['fields'][-1]['value'] = '-/15/15'
        self.data['libraries']['technical']['items'].append(second)
        self.write(self.data)
        full = self.library.listing('technical')
        self.assertEqual(full['total'], 2)
        options = next(filter['options'] for filter in full['filters'] if filter['key'] == 'frl')
        self.assertFalse({'-/15/-', '-/15/15'} & {option['value'] for option in options})
        self.assertEqual(self.library.listing('technical', frl='-/15/-')['total'], 1)
        self.assertEqual(self.library.listing('technical', frl='-/15/15')['total'], 1)

    def test_discovery_aliases_preserve_source_and_review_fingerprints(self):
        first = self.data['libraries']['technical']['items'][0]
        first['fields'] += [{'label': 'FRL', 'value': '-/45/45'},
                            {'label': 'Service', 'value': 'D1 power cables\nNOTE: D2 cables may be included.'}]
        second = deepcopy(first); second['id'] = 'same-review'
        self.data['libraries']['technical']['items'].append(second)
        self.write(self.data)
        loaded = self.library._load()
        fingerprints = {item['id']: review_fingerprint(item, loaded['_records']['technical'][item['id']], loaded['_assets'])
                        for item in (first, second)}
        self.data['technical_duplicate_reviews'] = [{'canonical_id': first['id'], 'members':
            [{'id': key, 'sha256': value} for key, value in fingerprints.items()]}]
        self.write(self.data)
        source = (self.root / 'library.json').read_bytes()
        loaded = self.library._load()
        self.assertEqual(len(loaded['_groups']), 1)
        self.assertEqual(self.library.listing('technical', frl='-/30/30')['total'], 1)
        self.assertEqual(self.library.listing('technical', frl='-/45/45')['total'], 1)
        self.assertEqual(self.library.listing('technical', services='D2 Comms Cables')['total'], 0)
        self.assertEqual(self.library.listing('technical', services='D1 Power Cables')['total'], 1)
        detail = self.library.detail('technical', first['id'])
        self.assertEqual(next(field['value'] for field in detail['fields'] if field['label'] == 'FRL'), '-/30/30')
        self.assertEqual(detail['technical_basis']['source_fields'][-2]['value'], '-/45/45')
        for item in (first, second):
            reviewed = deepcopy(loaded['_records']['technical'][item['id']])
            reviewed.pop('canonical_id', None)
            reviewed.pop('consolidated_ids', None)
            self.assertEqual(review_fingerprint(item, reviewed, loaded['_assets']),
                             fingerprints[item['id']])
        self.assertEqual((self.root / 'library.json').read_bytes(), source)

    def test_related_technical_title_uses_same_response_only_frl_alias(self):
        source = self.data['libraries']['technical']['items'][0]
        source['fields'].append({'label': 'FRL', 'value': '-/120/45'})
        self.write(self.data)
        loaded = self.library._load()
        raw_links = deepcopy(loaded['_links'])
        related = self.library.detail('penetration', 'pkb-001')['links'][0]
        self.assertIn('-/120/30', related['title'])
        self.assertNotIn('-/120/45', related['title'])
        self.assertEqual(loaded['_links'], raw_links)


if __name__ == '__main__':
    unittest.main()
