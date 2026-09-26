"""Synthetic substrate classifications and query-bound library filtering."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceLibrary
from estimator.technical_fields import normalize_technical_item
from estimator.technical_orientation import selector_orientation_basis, trafalgar_orientations


def item(number=1, *fields):
    return {'id': f'trafalgar-example-{number}', 'title': f'Synthetic {number}',
            'fields': [{'label': label, 'value': value} for label, value in fields]}


def capture_for(source, *barriers):
    queries = {}
    for number, barrier in enumerate(barriers):
        key = f'query-{number}'
        queries[key] = {'query_id': key, 'record_ids': ['record-1'],
                        'selected_options': {'pa_fire-barrier-type': {'label': barrier}}}
    source['selector_provenance'] = {'capture_sha256': 'a' * 64, 'category': 'synthetic',
                                     'record': {'query_ids': list(queries), 'record_id': 'record-1'}}
    return {'capture_sha256': 'a' * 64, 'queries': {'synthetic': queries}}


class TechnicalOrientationTests(unittest.TestCase):
    def test_selected_barrier_orientation_is_not_the_direction_of_the_service(self):
        for barrier, expected in [('Walls', 'Vertical'), ('Shaft Walls', 'Vertical'),
                                  ('Floors', 'Horizontal'), ('Ceilings', 'Horizontal')]:
            with self.subTest(barrier=barrier):
                source = item(1, ('Fire Barrier Type (Selector Search)', barrier),
                              ('Service', 'Horizontal pipe through a wall; floor waste'),
                              ('Installation Details', 'Install vertically.'))
                self.assertEqual(trafalgar_orientations(source), [expected])

    def test_substrate_fallback_does_not_read_alternative_table_rows(self):
        source = item(1, ('Substrate (Selector Search)', 'Concrete floor slab'))
        source['fields'][0]['table'] = {'columns': ['Other substrate'], 'rows': [['Masonry wall']]}
        self.assertEqual(trafalgar_orientations(source), ['Horizontal'])
        source['fields'][0]['value'] = 'Concrete'
        self.assertEqual(trafalgar_orientations(source), [])
        source['fields'][0]['value'] = 'Wall or ceiling'
        self.assertEqual(trafalgar_orientations(source), ['Horizontal', 'Vertical'])

    def test_selected_barrier_type_takes_priority_over_generic_substrate_description(self):
        source = item(1, ('Fire Barrier Type (Selector Search)', 'Wall'),
                      ('Substrate (Selector Search)', 'Wall and floor lining material'))
        self.assertEqual(trafalgar_orientations(source), ['Vertical'])

    def test_multiple_selector_queries_keep_all_substrate_orientations(self):
        source = item(1, ('Substrate (Selector Search)', 'Synthetic composite'))
        capture = capture_for(source, 'Walls', 'Shaft Walls', 'Ceilings')
        original, original_capture = deepcopy(source), deepcopy(capture)
        projected = normalize_technical_item(source, selector_capture=capture)
        self.assertEqual(projected['filter_values']['orientation'], ['Horizontal', 'Vertical'])
        field = next(field for field in projected['fields'] if field['label'] == 'Orientation')
        self.assertEqual(field['value'], 'Horizontal / Vertical')
        self.assertEqual(len(projected['technical_basis']['orientation']['queries']), 3)
        self.assertEqual(source, original)
        self.assertEqual(capture, original_capture)
        self.assertEqual(normalize_technical_item(projected), projected)

    def test_wall_and_shaft_wall_query_pair_classifies_as_vertical_once(self):
        source = item(1, ('Substrate (Selector Search)', 'Synthetic composite'))
        capture = capture_for(source, 'Walls', 'Shaft Walls')
        self.assertEqual(trafalgar_orientations(source, capture), ['Vertical'])

    def test_unbound_partial_or_conflicting_query_evidence_is_rejected(self):
        mutations = [
            lambda source, capture: capture.update(capture_sha256='b' * 64),
            lambda source, capture: capture['queries']['synthetic'].pop('query-1'),
            lambda source, capture: capture['queries']['synthetic']['query-0'].update(record_ids=['other']),
            lambda source, capture: source['selector_provenance']['record'].update(query_ids=['query-0', 'query-0']),
            lambda source, capture: source['selector_provenance']['record'].update(query_ids=['query-0']),
            lambda source, capture: source['fields'].append({'label': 'Barrier Type', 'value': 'Floor'}),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                source = item()
                capture = capture_for(source, 'Walls', 'Shaft Walls')
                mutation(source, capture)
                with self.assertRaises(ValueError):
                    trafalgar_orientations(source, capture)

    def test_omitting_floor_query_from_wall_and_floor_record_cannot_narrow_orientation(self):
        source = item()
        capture = capture_for(source, 'Walls', 'Floors')
        source['selector_provenance']['record']['query_ids'].pop()
        with self.assertRaisesRegex(ValueError, 'every matched query'):
            normalize_technical_item(source, selector_capture=capture)

    def test_incomplete_or_unselected_query_types_do_not_invent_an_orientation(self):
        source = item()
        capture = capture_for(source, 'Walls', 'Floors')
        queries = list(capture['queries']['synthetic'].values())
        queries[1]['selected_options']['pa_fire-barrier-type']['is_all'] = True
        self.assertIsNone(selector_orientation_basis(queries, 'a' * 64))
        self.assertEqual(trafalgar_orientations(source, capture), [])

    def test_other_manufacturers_are_not_reclassified(self):
        source = item(1, ('Orientation', 'Horizontal'), ('Barrier Type', 'Walls'))
        source['id'] = 'other-example'
        source['filter_values'] = {'orientation': ['Horizontal']}
        self.assertEqual(normalize_technical_item(source)['filter_values'], source['filter_values'])

    def test_library_search_filter_options_and_detail_use_the_same_projected_orientation(self):
        wall = item(1, ('Barrier Type', 'Walls'))
        floor = item(2, ('Barrier Type', 'Floors'))
        mixed = item(3, ('Barrier Type', 'Walls or ceilings'))
        data = {'schema_version': 1, 'documents': [], 'images': [], 'links': [],
                'libraries': {'penetration': {'filters': [], 'items': []},
                              'technical': {'filters': [], 'items': [wall, floor, mixed]}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'library.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            original = path.read_bytes()
            library = ReferenceLibrary(directory)
            listing = library.listing('technical', orientation='Horizontal')
            self.assertEqual({value['id'] for value in listing['items']}, {floor['id'], mixed['id']})
            self.assertEqual({value['id'] for value in library.listing('technical', orientation='Vertical')['items']},
                             {wall['id'], mixed['id']})
            self.assertEqual(library.listing('technical', search='Vertical')['total'], 2)
            options = next(value for value in listing['filters'] if value['key'] == 'orientation')['options']
            self.assertEqual([value['value'] for value in options], ['Horizontal', 'Vertical'])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(library._load()['libraries']['technical']['items'], data['libraries']['technical']['items'])
            with self.assertRaises(ValidationError):
                library.listing('technical', unknown='any')
            with patch('estimator.reference_library.normalize_technical_item',
                       return_value={**wall, 'filter_values': {'arbitrary': ['x']}}):
                with self.assertRaises(ValidationError):
                    ReferenceLibrary(directory).overview()

    def test_library_uses_capture_context_when_common_barrier_field_was_omitted(self):
        source = item(1, ('Substrate (Selector Search)', 'Synthetic composite'))
        capture = capture_for(source, 'Walls', 'Shaft Walls')
        data = {'schema_version': 1, 'documents': [], 'images': [], 'links': [],
                'trafalgar_selector_import': capture,
                'libraries': {'penetration': {'filters': [], 'items': []},
                              'technical': {'filters': [], 'items': [source]}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'library.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            library = ReferenceLibrary(directory)
            self.assertEqual(library.listing('technical', orientation='Vertical')['total'], 1)
            self.assertEqual(library.listing('technical', orientation='Horizontal')['total'], 0)
            self.assertEqual(next(field['value'] for field in library.detail('technical', source['id'])['fields']
                                  if field['label'] == 'Orientation'), 'Vertical')

    def test_orientation_options_are_collected_after_replacing_a_stale_imported_value(self):
        source = item(1, ('Barrier Type', 'Walls'))
        source['filter_values'] = {'orientation': ['Horizontal']}
        data = {'schema_version': 1, 'documents': [], 'images': [], 'links': [],
                'libraries': {'penetration': {'filters': [], 'items': []},
                              'technical': {'filters': [{'key': 'orientation', 'label': 'Orientation'}],
                                            'items': [source]}}}
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'library.json').write_text(json.dumps(data), encoding='utf-8')
            listing = ReferenceLibrary(directory).listing('technical', orientation='Vertical')
            self.assertEqual(listing['total'], 1)
            self.assertEqual(listing['filters'][0]['options'], [{'value': 'Vertical', 'label': 'Vertical'}])

    def test_runtime_orientation_filter_does_not_authorize_undeclared_imported_keys(self):
        derived = item(1, ('Barrier Type', 'Walls'))
        undeclared = item(2)
        undeclared['filter_values'] = {'orientation': ['Horizontal']}
        data = {'schema_version': 1, 'documents': [], 'images': [], 'links': [],
                'libraries': {'penetration': {'filters': [], 'items': []},
                              'technical': {'filters': [], 'items': [derived, undeclared]}}}
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'library.json').write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValidationError):
                ReferenceLibrary(directory).overview()


if __name__ == '__main__':
    unittest.main()
