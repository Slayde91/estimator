"""Projected taxonomy preserves source drafts, numeric routing and seal counts."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from estimator.firestopping_taxonomy import (CATEGORY_ONLY_SERVICES, canonical_opening_type,
                                            display_details, is_blank_seal)
from estimator.firestopping_library import FirestoppingLibrary
from estimator.library_facets import CATEGORIES, SERVICES
from estimator.penetration_calculator import calculate, definition, engine_for_draft, normalize_draft
from estimator.storage import Store
from test_firestopping_library import editable_library


class FirestoppingTaxonomyTests(unittest.TestCase):
    def test_projection_is_lossless_and_only_explicit_aliases_change_display(self):
        for service in CATEGORY_ONLY_SERVICES:
            raw = {'J': 'Mechanical', 'K': service, 'L': 'Oversized', 'AL': 12.3456789012345}
            before = deepcopy(raw)
            self.assertEqual(display_details(raw), {**raw, 'J': service, 'K': 'N/A', 'L': 'Oversized core hole'})
            self.assertEqual(raw, before)
            self.assertEqual(normalize_draft({'rows': [{'id': 'saved', 'inputs': raw}]})['rows'][0]['inputs'], raw)
        self.assertEqual(display_details({'K': 'Junction Box', 'L': 'Core Hole'})['K'], 'Conduits')
        self.assertEqual(canonical_opening_type('Empty Opening'), 'Empty Opening')
        self.assertEqual(canonical_opening_type('Custom source designation'), 'Custom source designation')

    def test_choices_and_legacy_junction_waste_routing_are_separate(self):
        fields = {field['column']: field for field in definition()['row_fields']}
        self.assertEqual(fields['J']['options'], list(CATEGORIES))
        self.assertEqual(fields['K']['options'], list(SERVICES))
        self.assertEqual(fields['L']['options'], ['Core hole', 'Oversized core hole'])
        self.assertEqual(fields['K']['options'][0], 'N/A')
        self.assertTrue(CATEGORY_ONLY_SERVICES.isdisjoint(fields['K']['options']))
        draft = {'globals': {'waste_plastic_pipes': .123456789},
                 'rows': [{'id': 'saved', 'inputs': {'K': 'Junction Box', 'L': 'Empty Opening', 'O': 4.123456789}}]}
        before = deepcopy(draft)
        engine, normalized = engine_for_draft(draft)
        self.assertEqual(normalized['rows'][0]['inputs'], draft['rows'][0]['inputs'])
        self.assertEqual(engine.inputs['CALC']['AO4'], 0)
        self.assertEqual(draft, before)

    def test_old_and_new_blank_seals_remain_distinct_from_other_na_categories(self):
        self.assertTrue(is_blank_seal({'J': 'Mechanical', 'K': 'Blank Seal'}))
        self.assertTrue(is_blank_seal({'J': 'Blank Seal', 'K': 'N/A'}))
        self.assertFalse(is_blank_seal({'J': 'Access Panel', 'K': 'N/A'}))
        self.assertFalse(is_blank_seal({'J': 'Blank Seal', 'K': 'Copper Pipes'}))
        self.assertFalse(is_blank_seal({'J': 'Mechanical', 'K': 'blank seal'}))

    def test_old_oversized_stays_valid_without_reentering_new_choices(self):
        result = calculate({'rows': [{'id': 'saved', 'inputs': {'L': 'Oversized'}}]})
        self.assertFalse(any(error.get('cell') == 'L4' for error in result['rows'][0]['errors']))
        self.assertEqual(result['draft']['rows'][0]['inputs']['L'], 'Oversized')

    def test_fixed_type_choices_have_no_setting_and_keep_historical_custom_values(self):
        self.assertEqual(definition()['settings']['detail_option_columns'], ['J', 'K', 'M', 'N', 'P', 'V'])
        raw = {'globals': {'detail_options': {'L': ['Empty Opening', 'Custom saved type']}},
               'rows': [{'id': 'saved', 'inputs': {'L': 'Custom saved type'}}]}
        before = deepcopy(raw)
        normalized = normalize_draft(raw)
        self.assertEqual(normalized['globals']['detail_options']['L'], raw['globals']['detail_options']['L'])
        self.assertEqual(normalized['rows'][0]['inputs']['L'], 'Custom saved type')
        self.assertEqual(calculate(raw)['draft']['globals']['detail_options']['L'], raw['globals']['detail_options']['L'])
        self.assertEqual(raw, before)

    def test_every_source_and_saved_record_projects_filters_without_rewriting_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = editable_library(root / 'library', complete_entries=True)
            item = data['libraries']['penetration']['items'][0]
            inputs = item['estimate']['draft']['rows'][0]['inputs']
            inputs.update(J='Mechanical', K='Linear Joints', L='Oversized')
            path = root / 'library/library.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            source = path.read_bytes()
            library = FirestoppingLibrary(root / 'library', Store(root / 'test.sqlite3'))
            listing = library.listing('penetration', category='Linear Joints', service_type='N/A', penetration_type='Oversized core hole')
            self.assertEqual([record['id'] for record in listing['items']], ['pkb-001'])
            filters = listing['filters']
            keys = [field['key'] for field in filters]
            self.assertEqual(keys.index('category') + 1, keys.index('service_type'))
            self.assertEqual(next(field['label'] for field in filters if field['key'] == 'service_type'), 'Services')
            self.assertEqual(next(field['label'] for field in filters if field['key'] == 'penetration_type'), 'Type')
            detail = library.detail('penetration', 'pkb-001')
            shown = {field['column']: field['value'] for field in detail['fields'] if field.get('column') in ('J', 'K', 'L')}
            self.assertEqual(shown, {'J': 'Linear Joints', 'K': 'N/A', 'L': 'Oversized core hole'})
            self.assertEqual(library.edit('pkb-001')['draft']['rows'][0]['inputs']['K'], 'Linear Joints')
            selected = library.takeoff_record('pkb-001')
            self.assertEqual(selected['inputs']['K'], 'Linear Joints')
            self.assertEqual(selected['import_fields']['barrier']['barrier_type'], 'Oversized')
            self.assertEqual(path.read_bytes(), source)
            # Editing through the existing saved-overlay path projects the new
            # pair without changing the original source or captured price basis.
            opened = library.edit('pkb-001')
            saved = deepcopy(opened['draft'])
            saved['rows'][0]['inputs'].update(J='Blank Seal', K='N/A', L='Core hole')
            library.action('pkb-001', 'save', {'revision': opened['revision'], 'pricing_token': opened['pricing_token'], 'draft': saved})
            current = library.takeoff_record('pkb-001')
            self.assertIsNone(current['import_fields']['service'])
            self.assertEqual(current['inputs']['K'], 'N/A')
            self.assertEqual(library.listing('penetration', category='Blank Seal', service_type='N/A')['total'], 1)
            self.assertEqual(path.read_bytes(), source)

    def test_original_formula_container_stays_byte_identical(self):
        source = Path(__file__).resolve().parents[1] / 'data/penetration.json.gz'
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
                         '65f7f82cae6ad517ed366a8fe5b5a96f86d38a6d60fce6de8d5eb8812cef6c88')
