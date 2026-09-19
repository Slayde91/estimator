"""Authorized commercial policy over immutable source formulas and snapshots."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import configuration_catalog, validate_configuration
from estimator.firestopping_library import FirestoppingLibrary
from estimator.penetration_calculator import (
    CALCULATION_POLICY_VERSION, EFFECTIVE_GLOBALS, calculate, definition,
    engine_for_draft, normalize_draft, source_model,
)
from estimator.project_file import export_project, load_project_bytes
from estimator.storage import Store
from test_firestopping_library import editable_library
from test_penetration_calculator import source_example


class EffectiveFirestoppingPolicyTests(unittest.TestCase):
    def test_all_removed_effects_are_neutral_but_raw_inputs_and_source_are_unchanged(self):
        source = deepcopy(source_model())
        draft = source_example()
        draft['globals'] = {'J': 'Yes', 'K': 17.123456789, 'L': 2.25, 'M': 3.75}
        draft['rows'][0]['inputs'].update(Q='Historical access', R='Historical complexity')
        draft['rows'].append({'id': 'another', 'inputs': deepcopy(draft['rows'][0]['inputs'])})
        draft['rows'][1]['inputs']['O'] = 3.123456789
        before = deepcopy(draft)
        result = calculate(draft)
        self.assertEqual(result['draft'], normalize_draft(before))
        self.assertEqual(draft, before)
        self.assertEqual(source_model(), source)
        self.assertEqual(result['calculation_policy'], CALCULATION_POLICY_VERSION)
        for row in result['rows']:
            quantity = row['inputs']['O']
            self.assertEqual([row['outputs'][col] for col in ('BI', 'BJ', 'BK')], [0, 0, 0])
            self.assertEqual([row['outputs'][col] for col in ('B', 'C', 'D', 'E')], ['', '', '', ''])
            self.assertAlmostEqual(row['outputs']['F'], 494 * quantity, places=10)
            self.assertAlmostEqual(row['outputs']['G'], 336.50993360655735 * quantity, places=10)
            self.assertAlmostEqual(row['outputs']['H'], (494 + 336.50993360655735) * quantity, places=10)
        self.assertEqual(result['summary']['travel_lafha'], '')
        self.assertEqual(result['summary']['other_allowances'], '')
        self.assertEqual(result['summary']['access'], '')
        self.assertEqual(result['errors'], [])

    def test_changed_lookup_values_and_legacy_globals_cannot_reactivate_removed_charges(self):
        draft = source_example()
        draft['globals'] = {'J': 'Yes', 'K': 1000, 'L': 999, 'M': 999}
        engine, preserved = engine_for_draft(draft)
        expected = engine.value('CALC', 'H4')
        # Exercise independent engines because formula results are memoized.
        engine, _ = engine_for_draft(draft)
        engine.inputs['LISTS'].update(BY2=1e12, BZ2=1e12)
        self.assertEqual(engine.value('CALC', 'H4'), expected)
        self.assertEqual(engine.value('CALC', 'D2'), '')
        self.assertEqual({col: engine.inputs['CALC'][col+'2'] for col in EFFECTIVE_GLOBALS}, EFFECTIVE_GLOBALS)
        self.assertEqual(preserved['globals'], normalize_draft(draft)['globals'])
        raw, _ = engine_for_draft(draft, effective=False)
        self.assertNotEqual(raw.value('CALC', 'H4'), expected)
        self.assertGreater(raw.value('CALC', 'D2'), 0)

    def test_descriptive_substrate_and_explicit_row_adjustments_keep_their_roles(self):
        draft = {'globals': {'J': 'Yes', 'K': 9, 'L': .5, 'M': .5},
                 'rows': [{'id': 'manual', 'inputs': {'O': 3, 'AH': 2, 'AI': 17.123456789, 'AJ': 29.123456789}}]}
        first = calculate(draft)
        self.assertAlmostEqual(first['rows'][0]['outputs']['G'], 17.123456789 * 3, places=12)
        self.assertEqual(first['rows'][0]['outputs']['F'], 29.123456789)
        for substrate in next(field['options'] for field in definition()['row_fields'] if field['column'] == 'P'):
            draft['rows'][0]['inputs']['P'] = substrate
            engine, _ = engine_for_draft(draft)
            self.assertEqual(engine.value('CALC', 'H4'), first['rows'][0]['outputs']['H'])
        spec = definition()
        columns = {field['column'] for field in spec['row_fields']}
        self.assertTrue({'P', 'AE', 'AF', 'AH', 'AI', 'AJ'} <= columns)
        self.assertNotIn('AG', columns)
        self.assertFalse({'Q', 'R'} & columns)
        self.assertTrue({'Q', 'R'} <= set(spec['allowed_input_columns']))
        self.assertEqual(len(spec['global_fields']), 12)
        self.assertTrue(all(field['group'] == 'SETTINGS' for field in spec['global_fields']))

    def test_project_roundtrip_preserves_inactive_values_without_restoring_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary) / 'project.sqlite3')
            draft = source_example()
            draft['globals'].update(J='Yes', K=7.234567890123, L=.234567890123, M=.345678901234)
            draft['rows'][0]['inputs'].update(Q='Historic access', R='Historic complexity')
            request = {'estimate': {}, 'penetration': {'draft': draft, 'composer': deepcopy(draft)}}
            reopened = load_project_bytes(store, export_project(store, request))
            self.assertEqual(reopened['penetration']['draft'], normalize_draft(draft))
            self.assertEqual(reopened['penetration']['composer'], normalize_draft(draft))
            current = calculate(draft)
            restored = calculate(reopened['penetration']['draft'], reopened['estimate']['configuration'])
            self.assertEqual(restored['summary'], current['summary'])
            self.assertEqual(restored['rows'], current['rows'])


class EffectiveLibraryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = editable_library(self.root / 'library')
        for item in self.data['libraries']['penetration']['items']:
            item['price']['amount'] = 999999
            item['estimate']['draft']['globals'] = {'J': 'Yes', 'K': 17, 'L': 2, 'M': 3}
            item['estimate']['draft']['rows'][0]['inputs'].update(O=2, P='Concrete wall', Q='Historical access', R='Historical complexity')
        self.path = self.root / 'library' / 'library.json'
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        self.before = self.path.read_bytes()
        self.store = Store(self.root / 'isolated.sqlite3')
        self.library = FirestoppingLibrary(self.path.parent, self.store)

    def test_list_and_detail_ignore_historical_amounts_batch_and_reuse_effective_cache(self):
        with patch('estimator.firestopping_library.engine_for_draft', wraps=engine_for_draft) as engine:
            result = self.library.listing('penetration')
            self.assertEqual(engine.call_count, 1)
            self.assertTrue(result['items'])
            self.assertTrue(all(item['price']['amount'] == 200 for item in result['items']))
            self.assertEqual(self.library.detail('penetration', 'pkb-001')['price']['amount'], 200)
            self.assertEqual(engine.call_count, 1)
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertEqual(self.library.edit('pkb-001')['source_price']['amount'], 999999)
        self.assertEqual(self.library.edit('pkb-001')['price']['amount'], 200)

    def test_historical_saved_edits_reprice_without_mutating_their_snapshot_or_amount(self):
        opened = self.library.edit('pkb-001')
        draft = deepcopy(opened['draft'])
        draft['globals'].update(K=999, L=99, M=99)
        draft['rows'][0]['inputs']['O'] = 3
        # Opening a source item is read-only; its token becomes durable on Save.
        snapshot = self.library._context('pkb-001')[3]
        self.library.edits.save('pkb-001', 0, self.data['firestopping']['source_sha256'],
            {'draft': draft, 'pricing_token': opened['pricing_token'], 'amount': 888888}, snapshot)
        before = deepcopy(self.library.edits.all())
        reopened = FirestoppingLibrary(self.path.parent, self.store)
        self.assertEqual(reopened.detail('penetration', 'pkb-001')['price']['amount'], 250)
        self.assertEqual(reopened.listing('penetration')['items'][0]['price']['amount'], 250)
        self.assertEqual(reopened.edit('pkb-001')['draft'], normalize_draft(draft))
        self.assertEqual(self.library.edits.all(), before)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_frozen_prices_and_source_cache_invalidation_use_actual_configuration(self):
        configuration = self.data['firestopping']['configuration']
        option = next(field['options'][0] for field in definition(configuration)['row_fields'] if field['column'] == 'AB')
        product = next(item for item in configuration['catalog']['inventory'] if item['sales_description'] == option)
        for item in self.data['libraries']['penetration']['items']:
            item['estimate']['draft']['rows'][0]['inputs'].update(AB=option, AC=.123456789)
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        frozen = self.library.detail('penetration', 'pkb-001')['price']['amount']
        changed = {'inventory': {product['id']: {'supplier_price': 432.123456789, 'markup': 0}}}
        self.store.save_configuration(changed)
        self.assertEqual(self.library.detail('penetration', 'pkb-001')['price']['amount'], frozen)
        updated = validate_configuration(changed)
        updated['catalog'] = configuration_catalog(updated)
        self.data['firestopping']['configuration'] = updated
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        refreshed = self.library.detail('penetration', 'pkb-001')['price']['amount']
        self.assertAlmostEqual(refreshed, 200 + 432.123456789 * .123456789 * 2, places=10)
        self.assertNotEqual(refreshed, frozen)


if __name__ == '__main__':
    unittest.main()
