"""Approved library labels remain separate from calculator inputs and routing."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from estimator.firefly_reference_review import fingerprint
from estimator.library_facets import SERVICES, facet_options
from estimator.library_filter_groups import grouped_filter_options
from estimator.penetration_calculator import definition
from estimator.reference_library import ReferenceLibrary
from estimator.technical_service_options import TECHNICAL_SERVICES, options
from estimator.technical_service_review import PLAN_NAME, project, projection_fingerprint, validate_plan
from tests.test_library_facets import REQUESTED_SERVICES
from tests.test_reference_library import sample_library
from tests.test_technical_service_review import fixture


ADDITIONAL = (
    'PP pipe', 'CPVC pipe', 'Unlagged Iron Pipes', 'Lagged Iron Pipes',
    'Beverage / Beer Lines', 'Raupiano Plus pipe', 'Unlagged Brass Pipes',
    'dBlue pipe', 'PU air line', 'Concentric plastic pipe', 'Smoke Sampling Tubes',
    'ABS pipe', 'PB pipe', 'Insulated Gas Lines', 'Kelox / KeKilit pipe',
)


class TechnicalServiceOptionsTests(unittest.TestCase):
    def test_only_approved_library_labels_extend_the_original_ordered_vocabulary(self):
        self.assertEqual(list(SERVICES), REQUESTED_SERVICES)
        self.assertEqual(TECHNICAL_SERVICES, (*SERVICES, *ADDITIONAL))
        self.assertEqual(len(TECHNICAL_SERVICES), len(set(TECHNICAL_SERVICES)))
        self.assertEqual(len(TECHNICAL_SERVICES), 45)

    def test_observed_unknown_values_do_not_authorize_another_option(self):
        observed = ['CPVC pipe', 'Unapproved specialist99', 'Plastic Pipes']
        original = deepcopy(observed)
        result = options(observed)
        self.assertEqual(result, list(TECHNICAL_SERVICES))
        self.assertEqual(observed, original)
        self.assertNotIn('Unapproved specialist99', result)
        self.assertNotIn('Plastic Pipes', result)
        result.append('A caller-local change')
        self.assertNotIn('A caller-local change', options([]))

    def test_calculator_choices_and_original_facet_options_are_unchanged(self):
        self.assertEqual(facet_options('services', ADDITIONAL), REQUESTED_SERVICES)
        field = next(field for field in definition()['row_fields'] if field['column'] == 'K')
        self.assertEqual(field['options'], REQUESTED_SERVICES)
        self.assertTrue(set(ADDITIONAL).isdisjoint(field['options']))

    def test_approved_labels_are_grouped_without_renaming_existing_choices(self):
        source = [{'value': value, 'label': value} for value in TECHNICAL_SERVICES]
        before = deepcopy(source)
        grouped = grouped_filter_options('services', source)
        self.assertEqual(source, before)
        self.assertCountEqual([row['value'] for row in grouped], TECHNICAL_SERVICES)
        by_value = {row['value']: row for row in grouped}
        expected = {
            'Smoke Sampling Tubes': 'Electrical & communications',
            'Beverage / Beer Lines': 'Mechanical', 'Insulated Gas Lines': 'Mechanical',
            'Unlagged Iron Pipes': 'Unlagged metal pipes',
            'Unlagged Brass Pipes': 'Unlagged metal pipes', 'Lagged Iron Pipes': 'Lagged metal pipes',
        }
        expected.update({value: 'Plastic pipes' for value in ADDITIONAL if value not in expected})
        for value, group in expected.items():
            with self.subTest(value=value):
                self.assertEqual(by_value[value]['group'], group)
                self.assertEqual(by_value[value]['label'], value)
        old_grouped = grouped_filter_options('services', [row for row in source if row['value'] in SERVICES])
        self.assertEqual([row for row in grouped if row['value'] in SERVICES], old_grouped)

    def test_each_new_approved_label_can_be_selected_by_a_source_bound_review(self):
        for service in ADDITIONAL:
            with self.subTest(service=service):
                data, public, discovery, plan = fixture()
                key = plan['items'][0]['id']
                raw = data['libraries']['technical']['items'][0]
                raw['fields'][0]['value'] = 'Synthetic ' + service
                public[key]['fields'][0]['value'] = raw['fields'][0]['value']
                row = plan['items'][0]
                row['item_sha256'] = fingerprint(raw)
                row['projection_sha256'] = projection_fingerprint(public[key])
                row['services'] = [service]
                row['evidence'][0]['quote'] = service
                before = deepcopy((data, public, discovery))
                review = validate_plan(data, 'b' * 64, plan)
                result = project(public, discovery, review)
                self.assertEqual(result[key]['services'], [service])
                self.assertEqual((data, public, discovery), before)

    def test_native_library_uses_approved_options_without_rewriting_source(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'library'
            sample_library(folder)
            source = (folder / 'library.json').read_bytes()
            library = ReferenceLibrary(folder)
            listing = library.listing('technical')
            services = next(entry for entry in listing['filters'] if entry['key'] == 'services')
            self.assertCountEqual([entry['value'] for entry in services['options']], TECHNICAL_SERVICES)
            self.assertEqual((folder / 'library.json').read_bytes(), source)

    def test_native_review_matches_approved_option_without_changing_original_record(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'library'
            data, _, _ = sample_library(folder)
            raw = data['libraries']['technical']['items'][0]
            raw['fields'].append({'label': 'Service', 'value': 'Synthetic CPVC pipe'})
            index = folder / 'library.json'
            index.write_text(json.dumps(data), encoding='utf-8')
            source = index.read_bytes()
            library = ReferenceLibrary(folder)
            before = library._load()
            key = raw['id']
            original = deepcopy(before['_records']['technical'][key])
            public = before['_technical_public_records'][key]
            plan = {'schema_version': 1, 'review_id': 'synthetic-approved-options',
                    'reviewed_index_sha256': hashlib.sha256(source).hexdigest(),
                    'items': [{'id': key, 'item_sha256': fingerprint(raw),
                               'projection_sha256': projection_fingerprint(public),
                               'services': ['CPVC pipe'], 'evidence': [{'field': 'Service',
                               'quote': 'CPVC pipe', 'source_reference': 'Synthetic report service field'}]}]}
            review = folder / 'reviews' / PLAN_NAME
            review.parent.mkdir()
            review.write_text(json.dumps(plan), encoding='utf-8')
            self.assertEqual(library.listing('technical', services='CPVC pipe')['total'], 1)
            self.assertEqual(library._load()['_records']['technical'][key], original)
            self.assertEqual(index.read_bytes(), source)


if __name__ == '__main__':
    unittest.main()
