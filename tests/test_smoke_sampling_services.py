"""Smoke-sampling discovery must not consume fibre-optic microduct systems."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.technical_discovery import discovery_facets, project_smoke_sampling_services
from estimator.storage import Store
from estimator.technical_library_edits import ManualTechnicalLibrary, FACETS
from tests.test_reference_library import sample_library


def record(service, configuration='', **other_fields):
    values = {'Service': service, 'Service Size / Configuration': configuration,
              **other_fields}
    return {'fields': [{'label': key, 'value': value} for key, value in values.items()]}


class SmokeSamplingServicesTests(unittest.TestCase):
    def projected_services(self, item, *, explicit_ids=()):
        return project_smoke_sampling_services({'item': item}, {'item': discovery_facets(item)},
                                              explicit_ids=explicit_ids)['item']['services']

    def test_source_named_fibre_optic_microduct_is_not_smoke_sampling(self):
        for configuration in (
                'ICS-Hexatronic Microduct 1 x 10/8 + 24 x 5/3.5 ID. Empty or may contain fibre optic cables.',
                'ICS-Hexatronic Microduct Bundle of up to 10: 1 x 5/3.5 ID. Fibre optic cables.',
                'Generic microduct, empty or containing fibre optic cables.'):
            with self.subTest(configuration=configuration):
                item = record('fibre optic cables', configuration)
                original = deepcopy(item)
                selected = self.projected_services(item)
                self.assertIn('Fibre Optic', selected)
                self.assertNotIn('Smoke Sampling Tubes', selected)
                self.assertEqual(item, original)

    def test_explicit_smoke_sampling_and_vesda_remain_searchable(self):
        for service in ('56 x 4 mm Vesda microducts', 'VESDA microducts',
                        'Smoke sampling microducts', 'Smoke-sampling microduct'):
            with self.subTest(service=service):
                self.assertIn('Smoke Sampling Tubes', self.projected_services(record(service)))

    def test_unrelated_installation_or_retained_table_does_not_add_smoke_sampling(self):
        item = record('fibre optic cables', 'ICS-Hexatronic Microduct',
                      **{'Installation Details': 'Vesda smoke sampling tubes are on another source row.'})
        item['fields'][1]['table'] = {'columns': ['Service detail'],
                                     'rows': [['Vesda smoke sampling tubes']]}
        self.assertNotIn('Smoke Sampling Tubes', self.projected_services(item))

    def test_explicit_reviewed_service_selection_is_not_overridden(self):
        item = record('Reviewed service', 'Microduct')
        self.assertIn('Smoke Sampling Tubes', self.projected_services(item, explicit_ids={'item'}))

    def test_ambiguous_microduct_preserves_existing_assignment_without_inventing_an_alternative(self):
        item = record('Microduct')
        self.assertEqual(self.projected_services(item), discovery_facets(item)['services'])

    def test_child_inherits_explicit_parent_assignment(self):
        item = record('fibre optic cables', 'ICS-Hexatronic microduct')
        facets = {'item': discovery_facets(item)}
        result = project_smoke_sampling_services({'item': item}, facets,
            explicit_ids={'parent'}, lineage={'item': {'parent_id': 'parent'}})
        self.assertIs(result, facets)

    def test_projection_does_not_change_source_fields_facets_or_review_inputs(self):
        item = record('fibre optic cables', 'ICS-Hexatronic microduct')
        facets = {'item': discovery_facets(item)}
        before = deepcopy((item, facets))
        result = project_smoke_sampling_services({'item': item}, facets)
        self.assertEqual((item, facets), before)
        self.assertEqual(result['item']['services'], ['Fibre Optic'])

    def test_manual_assignment_survives_save_reopen_and_filtering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, _, _ = sample_library(root / 'library')
            technical = data['libraries']['technical']
            technical['filters'] = [{'key': key, 'label': label} for key, label in FACETS]
            item = technical['items'][0]
            item['fields'].extend(record('fibre optic cables', 'ICS-Hexatronic Microduct',
                Manufacturer='Sample manufacturer', **{'Barrier Construction': 'Concrete wall',
                'Orientation': 'Vertical', 'FRL': '-/120/120', 'Report Number': 'Sample report'})['fields'])
            item['filter_values'].update(manufacturer=['Sample manufacturer'],
                substrate=['Concrete/masonry wall'], orientation=['Vertical'], type=['Core hole'],
                category=['Electrical & Communications'], services=['Fibre Optic'], frl=['-/120/120'])
            source = root / 'library/library.json'
            source.write_text(json.dumps(data), encoding='utf-8')
            original = source.read_bytes()
            store = Store(root / 'state.sqlite3')
            library = ManualTechnicalLibrary(root / 'library', store)
            self.assertEqual(library.listing('technical', services='Smoke Sampling Tubes')['total'], 0)
            edit = library.technical_edit(item['id'])
            facets = {key: deepcopy(edit['record']['filter_values'][key]) for key, _ in FACETS}
            facets['services'] = ['Smoke Sampling Tubes']
            library.technical_save(item['id'], {'revision': edit['revision'],
                'source_sha256': edit['source_sha256'], 'request_key': None,
                'title': edit['record']['title'], 'fields': [
                    {'label': field['label'], 'value': field.get('value', '')}
                    for field in edit['record']['fields']], 'facets': facets,
                'report': {'number': 'Sample report', 'url': 'https://example.test/report.pdf'}})
            reopened = ManualTechnicalLibrary(root / 'library', store)
            self.assertEqual(reopened.technical_edit(item['id'])['record']['filter_values']['services'],
                             ['Smoke Sampling Tubes'])
            self.assertEqual(reopened.listing('technical', services='Smoke Sampling Tubes')['total'], 1)
            self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
