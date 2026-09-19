"""Application labour allowances and source-preserving engine integration."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary
from estimator.penetration_calculator import (
    ROW_COLUMNS, calculate, definition, engine_for_draft, normalize_draft, source_model,
)
from estimator.penetration_labour import APP_INPUT_FIELDS, resolve_labour
from estimator.storage import Store
from test_firestopping_library import editable_library
from test_penetration_calculator import source_example


class LabourPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fields = {field['column']: field for field in definition()['row_fields']}
        cls.worker = cls.fields['W']['options'][0]
        cls.collar = cls.fields['Y']['options'][0]

    def result(self, **inputs):
        return calculate({'rows': [{'id': 'one', 'inputs': {'W': self.worker, 'O': 2, **inputs}}]})

    def test_every_band_boundary_is_inclusive_and_above_boundary_uses_next_band(self):
        cases = ((.000001, .25), (50, .25), (50.000001, .30), (100, .30),
                 (100.000001, .35), (150, .35), (150.000001, .40), (200, .40),
                 (200.000001, .45), (250, .45), (250.000001, .50), (300, .50))
        for diameter, expected in cases:
            with self.subTest(diameter=diameter):
                inputs = {'Y': self.collar, 'AL': diameter, 'AN': 3}
                before = deepcopy(inputs)
                labour = resolve_labour(inputs)
                self.assertEqual(labour['input_defaults']['pipe_labour_hours'], expected)
                self.assertEqual(labour['pipe_hours'], expected)
                self.assertEqual(labour['pipe_task_hours'], expected * 3)
                self.assertEqual(labour['errors'], [])
                self.assertEqual(inputs, before)

    def test_unavailable_automatic_pipe_hours_require_manual_only_with_selected_collar(self):
        for diameter in (None, 0, -1, 300.000001, 1000000000000):
            with self.subTest(diameter=diameter):
                inputs = {'AL': diameter, 'AN': 3}
                without = resolve_labour(inputs)
                self.assertIsNone(without['input_defaults']['pipe_labour_hours'])
                self.assertEqual(without['pipe_task_hours'], '')
                self.assertEqual(without['errors'], [])
                selected = resolve_labour({**inputs, 'Y': self.collar})
                self.assertEqual(selected['pipe_task_hours'], '#VALUE!')
                self.assertEqual(selected['errors'][0]['cell'], 'pipe_labour_hours')
                for manual in (0, .123456789012345):
                    allowed = resolve_labour({**inputs, 'Y': self.collar, 'pipe_labour_hours': manual})
                    self.assertEqual(allowed['errors'], [])
                    self.assertEqual(allowed['pipe_task_hours'], manual * 3)

    def test_missing_null_and_explicit_zero_distinguish_automatic_and_manual_values(self):
        for raw in ({}, {key: None for key in APP_INPUT_FIELDS}, {key: '' for key in APP_INPUT_FIELDS}):
            draft = {'rows': [{'id': 'one', 'inputs': {'AL': 100, 'AN': 2, 'Y': self.collar, **raw}}]}
            before = deepcopy(draft)
            normalized = normalize_draft(draft)
            policy = resolve_labour(normalized['rows'][0]['inputs'])
            self.assertEqual((policy['register_hours'], policy['pipe_hours']), (.25, .30))
            self.assertEqual(set(normalized['rows'][0]['inputs']), set(draft['rows'][0]['inputs']))
            self.assertEqual(draft, before)
        policy = resolve_labour({'AL': 100, 'AN': 2, 'Y': self.collar,
                                 'register_allowance_hours': 0, 'pipe_labour_hours': 0})
        self.assertEqual((policy['register_hours'], policy['pipe_hours'], policy['pipe_task_hours']), (0, 0, 0))
        self.assertEqual(policy['input_defaults'], {'register_allowance_hours': .25, 'pipe_labour_hours': .30})

    def test_manual_inputs_require_finite_nonnegative_numbers_and_preserve_precision(self):
        for key in APP_INPUT_FIELDS:
            for value in (-.001, True, '0.25', float('inf'), float('nan'), 10 ** 1000):
                with self.subTest(key=key, value=str(value)), self.assertRaises(ValidationError):
                    normalize_draft({'rows': [{'id': 'one', 'inputs': {key: value}}]})
            value = .123456789012345
            inputs = {key: value, **({'Y': self.collar} if key == 'pipe_labour_hours' else {})}
            draft = normalize_draft({'rows': [{'id': 'one', 'inputs': inputs}]})
            self.assertEqual(draft['rows'][0]['inputs'][key], value)

    def test_definition_exposes_application_fields_without_forged_workbook_addresses(self):
        spec = definition()
        columns = [field['column'] for field in spec['row_fields']]
        for key, metadata in APP_INPUT_FIELDS.items():
            field = self.fields[key]
            self.assertEqual(columns.index(key), columns.index(metadata['after']) + 1)
            self.assertEqual(field['label'], metadata['label'])
            self.assertEqual(field['units'], 'hrs')
            self.assertEqual(field['source'], 'application')
            self.assertIsNone(field['address'])
            self.assertIsNone(field['default'])
            self.assertTrue(field['automatic_default'])
            self.assertNotIn(key, ROW_COLUMNS)
            self.assertIn(key, spec['allowed_input_columns'])
        self.assertEqual(self.fields['AH']['label'], 'Additional Labour')
        self.assertEqual(next(field for field in spec['output_fields'] if field['column'] == 'DF')['label'],
                         'Pipes Task Hours')

    def test_register_only_charges_quantity_without_inventing_an_empty_composer_charge(self):
        automatic = self.result()
        row = automatic['rows'][0]
        self.assertEqual(row['outputs']['DK'], .25 * 2)
        self.assertEqual(row['outputs']['F'], .25 * 2 * row['outputs']['CW'])
        self.assertEqual(automatic['summary']['total_days'], .5 / 8)
        self.assertEqual(row['input_defaults']['register_allowance_hours'], .25)
        self.assertNotIn('register_allowance_hours', row['inputs'])
        zero = self.result(register_allowance_hours=0)
        self.assertEqual(zero['summary']['grand_total'], '')
        for draft in (None, {'rows': []}, {'rows': [{'id': 'blank', 'inputs': {'W': self.worker}}]}):
            empty = calculate(draft)
            self.assertIn(empty['summary']['grand_total'], ('', 0))
            self.assertEqual(empty['summary']['labour_hours'], 0)

    def test_pipe_count_and_item_quantity_each_scale_once_and_adjustment_stays_per_line(self):
        result = self.result(Y=self.collar, AL=51, AN=3, AH=.7, AJ=17,
                             register_allowance_hours=.4)
        row = result['rows'][0]
        self.assertEqual(row['outputs']['DF'], .3 * 3)
        self.assertEqual(row['outputs']['DJ'], .7)
        self.assertAlmostEqual(row['outputs']['DK'], (.3 * 3 + .7 + .4) * 2)
        self.assertAlmostEqual(row['outputs']['F'], row['outputs']['DK'] * row['outputs']['CW'] + 17)
        self.assertAlmostEqual(result['summary']['total_days'], row['outputs']['DK'] / 8)

    def test_clearing_collar_removes_manual_hours_and_pipe_charge(self):
        result = self.result(AL=50, AN=4, pipe_labour_hours=1.25)
        row = result['rows'][0]
        self.assertNotIn('pipe_labour_hours', row['inputs'])
        self.assertIsNone(row['input_defaults']['pipe_labour_hours'])
        self.assertIsNone(row['labour_policy']['pipe_hours'])
        self.assertEqual(row['outputs']['DF'], '')
        self.assertEqual(row['outputs']['DK'], .5)
        self.assertEqual(result['errors'], [])

    def test_project_pipe_band_settings_change_automatic_hours(self):
        draft = {'globals': {'pipe_labour_100_hours': .75}, 'rows': [{
            'id': 'one', 'inputs': {'W': self.worker, 'O': 1, 'Y': self.collar,
                                    'AL': 75, 'AN': 2, 'register_allowance_hours': 0}}]}
        result = calculate(draft)
        self.assertEqual(result['rows'][0]['input_defaults']['pipe_labour_hours'], .75)
        self.assertEqual(result['rows'][0]['outputs']['DF'], 1.5)

    def test_manual_zero_bypasses_missing_diameter_and_null_resets_to_validation(self):
        zero = self.result(Y=self.collar, AN=2, pipe_labour_hours=0)
        self.assertEqual(zero['rows'][0]['outputs']['DF'], 0)
        self.assertEqual(zero['errors'], [])
        automatic = self.result(Y=self.collar, AN=2, pipe_labour_hours=None)
        for column in ('DF', 'DK', 'F', 'H'):
            self.assertEqual(automatic['rows'][0]['outputs'][column], '#VALUE!')
        for key in ('labour', 'grand_total', 'total_days', 'labour_hours'):
            self.assertEqual(automatic['summary'][key], '#VALUE!')
        self.assertTrue(any(error['cell'] == 'pipe_labour_hours' for error in automatic['errors']))

    def test_multirow_overrides_are_independent_and_raw_source_mode_is_unchanged(self):
        draft = {'rows': [
            {'id': 'one', 'inputs': {'W': self.worker, 'O': 2, 'register_allowance_hours': .1}},
            {'id': 'two', 'inputs': {'W': self.worker, 'O': 3, 'Y': self.collar,
                                   'AL': 300, 'AN': 4, 'register_allowance_hours': .2}},
        ]}
        before, source = deepcopy(draft), deepcopy(source_model())
        result = calculate(draft)
        self.assertEqual(result['rows'][0]['outputs']['DK'], .1 * 2)
        self.assertEqual(result['rows'][1]['outputs']['DK'], (.5 * 4 + .2) * 3)
        self.assertAlmostEqual(result['summary']['labour_hours'], .2 + 6.6)
        self.assertEqual(draft, before)
        self.assertEqual(source_model(), source)
        raw_draft = source_example()
        raw, _ = engine_for_draft(raw_draft, effective=False)
        expected = raw.value('CALC', 'H4')
        raw_draft['rows'][0]['inputs'].update(register_allowance_hours=8, pipe_labour_hours=9)
        preserved, _ = engine_for_draft(raw_draft, effective=False)
        self.assertEqual(preserved.value('CALC', 'H4'), expected)
        self.assertFalse(preserved.formula_overrides.get('CALC'))

    def test_tiny_explicit_register_allowance_is_not_rounded_away(self):
        result = self.result(register_allowance_hours=1e-12)
        self.assertEqual(result['rows'][0]['outputs']['DK'], 2e-12)

    def test_nonpositive_task_base_gate_remains_but_positive_base_keeps_signed_item_quantity(self):
        for additional in (-.25, -1):
            result = self.result(AH=additional, AJ=17)
            self.assertEqual(result['rows'][0]['outputs']['DK'], '')
            self.assertEqual(result['rows'][0]['outputs']['F'], 17)
        for quantity in (0, -2):
            result = self.result(O=quantity)
            self.assertEqual(result['rows'][0]['outputs']['DK'], .25 * quantity)


class LabourLibraryPolicyTests(unittest.TestCase):
    def test_unavailable_pipe_default_does_not_hide_other_library_prices_and_manual_save_recovers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = editable_library(root / 'library')
            fields = {field['column']: field for field in definition()['row_fields']}
            original = data['libraries']['penetration']['items'][0]
            original['estimate']['draft']['rows'][0]['inputs'].update(
                Y=fields['Y']['options'][0], W=fields['W']['options'][0], AL=301, AN=2)
            path = root / 'library/library.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            before = path.read_bytes()
            store = Store(root / 'test.sqlite3')
            library = FirestoppingLibrary(path.parent, store)
            listing = library.listing('penetration')
            broken = next(item for item in listing['items'] if item['id'] == original['id'])
            self.assertIsNone(broken['price'])
            self.assertTrue(broken['price_error'])
            self.assertTrue(any(item['price'] is not None for item in listing['items'] if item['id'] != original['id']))
            opened = library.edit(original['id'])
            self.assertIsNone(opened['price'])
            self.assertTrue(any(error['cell'] == 'pipe_labour_hours' for error in opened['result']['errors']))
            request = {key: deepcopy(opened[key]) for key in ('draft', 'revision', 'pricing_token')}
            request['draft']['rows'][0]['inputs'].update(pipe_labour_hours=.123456789012345,
                                                       register_allowance_hours=0)
            saved = library.action(original['id'], 'save', request)
            self.assertEqual(saved['result']['errors'], [])
            reopened = FirestoppingLibrary(path.parent, store).edit(original['id'])
            self.assertEqual(reopened['draft'], saved['draft'])
            self.assertEqual(reopened['price'], saved['price'])
            self.assertEqual(reopened['draft']['rows'][0]['inputs']['register_allowance_hours'], 0)
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
