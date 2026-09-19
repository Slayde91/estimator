"""Library provenance is persistent metadata, never a workbook calculation input."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError, effective_catalog
from estimator.penetration_calculator import (
    ROW_COLUMNS, calculate, definition, engine_for_draft, normalize_composer,
    normalize_draft, source_model,
)
from estimator.project_file import ESTIMATE_FIELDS, export_project, load_project_bytes
from estimator.storage import Store


class PenetrationLibraryIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.store = Store(Path(cls.temporary.name) / 'identity.sqlite3')
        cls.spec = definition({})
        cls.mastic = next(field['options'][0] for field in cls.spec['row_fields'] if field['column'] == 'AB')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def draft(self):
        draft = deepcopy(self.spec['defaults'])
        draft['rows'][0]['inputs'].update(T='Service Ø65 – 原文', U='', O=3.12345678901234,
                                         AB=self.mastic, AC=.123456789012345, AJ=0, AL=None)
        return draft

    def test_optional_identity_keeps_legacy_rows_and_allows_distinct_library_rows(self):
        draft = self.draft()
        original = deepcopy(draft)
        normalized = normalize_draft(draft)
        self.assertEqual(set(normalized['rows'][0]), {'id', 'inputs'})
        self.assertNotIn('library_item_id', normalized['rows'][0])
        draft['rows'].append({'id': 'manual-second', 'inputs': deepcopy(draft['rows'][0]['inputs'])})
        self.assertEqual(len(normalize_draft(draft)['rows']), 2)
        for row, identity in zip(draft['rows'], ('pkb-plib-r000004', 'fl-user-100001')):
            row['library_item_id'] = identity
        result = normalize_draft(draft)
        self.assertEqual([row['library_item_id'] for row in result['rows']],
                         ['pkb-plib-r000004', 'fl-user-100001'])
        self.assertEqual(result['rows'][0]['inputs'], normalized['rows'][0]['inputs'])
        self.assertEqual(original['rows'][0]['inputs']['U'], '')

    def test_identity_grammar_is_bounded_and_does_not_accept_paths_or_objects(self):
        for identity in ('a', '0', 'FL-ID-001', 'source.v1:entry_4-2', 'a' * 200):
            draft = self.draft()
            draft['rows'][0]['library_item_id'] = identity
            with self.subTest(identity=identity):
                self.assertEqual(normalize_draft(draft)['rows'][0]['library_item_id'], identity)
        for identity in (None, '', True, 123, {}, [], 'a' * 201, '_a', '.a', ':a', '-a',
                         'with space', ' leading', 'trailing ', 'a/b', 'a\\b', '../item',
                         'https://example.invalid', 'x\n', 'Ø65', '<script>'):
            draft = self.draft()
            draft['rows'][0]['library_item_id'] = identity
            with self.subTest(identity=identity), self.assertRaisesRegex(ValidationError, 'library item ID'):
                normalize_draft(draft)

    def test_duplicates_are_rejected_without_weakening_row_or_input_validation(self):
        draft = self.draft()
        draft['rows'][0]['library_item_id'] = 'fl-user-100001'
        draft['rows'].append({'id': 'another-row', 'library_item_id': 'fl-user-100001', 'inputs': {'O': 7}})
        before = deepcopy(draft)
        with self.assertRaisesRegex(ValidationError, 'only once'):
            normalize_draft(draft)
        self.assertEqual(draft, before)
        for change in (lambda row: row.update(source_price=5),
                       lambda row: row['inputs'].update(library_item_id='not-an-input'),
                       lambda row: row['inputs'].update(H=1),
                       lambda row: row['inputs'].update(AC='=1+1')):
            invalid = self.draft()
            invalid['rows'][0]['library_item_id'] = 'fl-user-100001'
            change(invalid['rows'][0])
            with self.assertRaises(ValidationError):
                normalize_draft(invalid)
        draft['rows'][1]['library_item_id'] = 'fl-user-100002'
        draft['rows'][1]['id'] = draft['rows'][0]['id']
        with self.assertRaisesRegex(ValidationError, 'row IDs'):
            normalize_draft(draft)

    def test_calculation_preserves_identity_without_changing_any_input_formula_or_result(self):
        draft = self.draft()
        original = deepcopy(draft)
        source_before = deepcopy(source_model())
        base = calculate(draft, {})
        draft['rows'][0]['library_item_id'] = 'fl-user-100001'
        tagged_before = deepcopy(draft)
        tagged = calculate(draft, {})
        self.assertEqual(tagged['draft']['rows'][0]['library_item_id'], 'fl-user-100001')
        comparable = deepcopy(tagged)
        del comparable['draft']['rows'][0]['library_item_id']
        self.assertEqual(comparable, base)
        base_engine, _ = engine_for_draft(original, {})
        tagged_engine, normalized = engine_for_draft(draft, {})
        self.assertEqual(tagged_engine.inputs, base_engine.inputs)
        self.assertEqual(normalized['rows'][0]['library_item_id'], 'fl-user-100001')
        self.assertNotIn('library_item_id', ROW_COLUMNS)
        self.assertEqual(draft, tagged_before)
        self.assertEqual(source_model(), source_before)

    def test_composer_identity_is_independent_from_schedule_uniqueness(self):
        schedule = self.draft()
        schedule['rows'][0]['library_item_id'] = 'fl-user-100001'
        composer = deepcopy(schedule)
        composer['rows'][0]['inputs']['O'] = 9.87654321098765
        self.assertEqual(normalize_composer(composer)['rows'][0]['library_item_id'], 'fl-user-100001')
        self.assertEqual(normalize_draft(schedule)['rows'][0]['inputs']['O'], 3.12345678901234)
        composer['rows'].append({'id': 'second', 'library_item_id': 'fl-user-100002', 'inputs': {}})
        with self.assertRaisesRegex(ValidationError, 'exactly one'):
            normalize_composer(composer)

    def test_project_round_trip_keeps_both_identities_and_original_pricing(self):
        schedule = self.draft()
        schedule['rows'][0]['library_item_id'] = 'pkb-plib-r000004'
        composer = deepcopy(schedule)
        composer['rows'][0]['id'] = 'composer-other'
        composer['rows'][0]['library_item_id'] = 'fl-user-100001'
        composer['rows'][0]['inputs'].update(O=7.987654321012345, U='Unscheduled installation')
        composer['globals'].update(J='Yes', K=8.12345678901234, L=.3456789012345, M=.4567890123456)
        product = next(item for item in effective_catalog({})['inventory'] if item['sales_description'] == self.mastic)
        configuration = {'inventory': {product['id']: {'supplier_price': 12.3456789012345, 'markup': 0}}}
        request = {'estimate': {'configuration': configuration}, 'penetration': {'draft': schedule, 'composer': composer}}
        original = deepcopy(request)
        payload = export_project(self.store, request)
        loaded = load_project_bytes(self.store, payload)
        self.assertEqual(loaded['penetration'], {'draft': normalize_draft(schedule), 'composer': normalize_composer(composer),
                                                'source_sha256': self.spec['source_sha256']})
        self.assertEqual(request, original)
        before = calculate(schedule, loaded['estimate']['configuration'])
        self.store.save_configuration({'inventory': {product['id']: {'supplier_price': 98.7654321098765, 'markup': 0}}})
        reopened = load_project_bytes(self.store, payload)
        self.assertEqual(reopened['penetration'], loaded['penetration'])
        # Loading creates a new active-draft timestamp; every portable field
        # and the frozen catalog must nevertheless retain the saved values.
        for field in ESTIMATE_FIELDS:
            self.assertTrue(reopened['estimate'][field] == loaded['estimate'][field], field)
        self.assertTrue(reopened['calculators'] == loaded['calculators'])
        self.assertEqual(calculate(reopened['penetration']['draft'], reopened['estimate']['configuration']), before)
        self.assertEqual(before['rows'][0]['outputs']['CZ'], 12.3456789012345)
        self.assertEqual(calculate(schedule, self.store.configuration())['rows'][0]['outputs']['CZ'], 98.7654321098765)


if __name__ == '__main__':
    unittest.main()
