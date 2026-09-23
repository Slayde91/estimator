"""Source, pricing, input-boundary and independent Excel parity regression."""

from copy import deepcopy
import gzip
import json
import math
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from estimator.catalog import FIRESTOPPING_GROUPS, ValidationError, baseline, configuration_catalog, effective_catalog
from estimator.excel_engine import FormulaError, column_number, coordinates
from estimator.penetration_calculator import (
    FRL_OPTIONS, GLOBAL_DEFAULTS, ROW_COLUMNS, WASTE_SETTINGS, PenetrationEngine, _copy_row_formula,
    calculate, definition, engine_for_draft, inventory_lists, normalize_draft, pricing_usage_metadata, source_model,
)


def source_example():
    cells = next(s['cells'] for s in source_model()['sheets'] if s['name'] == 'CALC')
    return {'globals': {col: cells.get(col + '2', {}).get('value') for col in GLOBAL_DEFAULTS},
            'rows': [{'id': 'source-example', 'inputs': {col: cells.get(col + '4', {}).get('value') for col in ROW_COLUMNS}}]}


class PenetrationSourceTests(unittest.TestCase):
    def test_all_native_excel_scenarios_match_every_formula_output(self):
        path = Path(__file__).parent / 'fixtures' / 'penetration_excel_oracle.json.gz'
        with gzip.open(path, 'rt', encoding='utf-8') as stream:
            fixture = json.load(stream)
        self.assertEqual(fixture['source_sha256'], source_model()['source']['sha256'])
        self.assertEqual(fixture['oracle']['application'], 'Microsoft Excel')
        self.assertTrue(fixture['oracle']['financial_xml_identical'])
        self.assertEqual(fixture['oracle']['frozen_lookup_anchors'], 32)
        self.assertEqual(len(fixture['scenarios']), 49)
        comparisons = 0
        for scenario in fixture['scenarios']:
            source = source_example()
            draft = {'globals': source['globals'], 'rows': [
                {'id': 'row-' + str(row), 'inputs': deepcopy(source['rows'][0]['inputs'])}
                for row in range(scenario['row_count'])]}
            for address, value in scenario['inputs']['CALC'].items():
                match = re.fullmatch(r'([A-Z]+)(\d+)', address)
                column, row = match[1], int(match[2])
                if row == 2 and column in GLOBAL_DEFAULTS:
                    draft['globals'][column] = value
                elif row >= 4 and column in ROW_COLUMNS:
                    draft['rows'][row - 4]['inputs'][column] = value
                else:
                    self.assertIsNone(value, f'Unexpected nonblank input {scenario["id"]}:{address}')
            # The native fixture proves the unchanged source engine; the
            # authorized application policy is tested independently.
            engine, _ = engine_for_draft(draft, scenario.get('configuration'), effective=False)
            if scenario.get('configuration'):
                for address, expected in scenario['inputs']['LISTS'].items():
                    self.assertEqual(engine.inputs['LISTS'][address], expected,
                                     f'Shared inventory hydration {scenario["id"]}:{address}')
            else:
                engine.inputs['LISTS'].update(scenario['inputs']['LISTS'])
            for sheet, expected_cells in scenario['expected'].items():
                for address, expected in expected_cells.items():
                    actual = engine.value(sheet, address)
                    with self.subTest(scenario=scenario['id'], sheet=sheet, cell=address):
                        if isinstance(expected, (int, float)) and not isinstance(expected, bool):
                            self.assertIsInstance(actual, (int, float))
                            self.assertTrue(math.isclose(actual, expected, abs_tol=1e-10, rel_tol=1e-12),
                                            f'{actual!r} != {expected!r}')
                        else:
                            self.assertEqual(actual, expected)
                    comparisons += 1
        self.assertEqual(comparisons, 3786)

    def test_preserved_source_identity_formulas_constants_and_names(self):
        model = source_model()
        self.assertEqual(model['source']['sha256'], '388bf5d51befe860304c82ec0475c01a6737c8be225a219a763d087851a5dfde')
        self.assertEqual(model['counts']['formulas'], 108)
        self.assertEqual({s['name']: sum('formula' in c for c in s['cells'].values()) for s in model['sheets']},
                         {'LISTS': 32, 'Settings': 0, 'CALC': 69, 'BREAKDOWN': 7})
        self.assertFalse(model['has_vba'])
        self.assertEqual(model['calculation_properties'], {'calcId': '191029'})
        self.assertEqual(model['defined_names']['LAFHA_rate'], 'LISTS!$BY$2')
        self.assertEqual(model['tables']['Table1']['ref'], 'J3:V4')
        self.assertEqual(len(model['tables']['Table1']['columns']), 13)
        lists = next(s['cells'] for s in model['sheets'] if s['name'] == 'LISTS')
        self.assertEqual((lists['BY2']['value'], lists['BZ2']['value']), (650, 2080))
        self.assertEqual(len(model['list_filters']), 13)
        self.assertEqual(len(model['list_lookups']), 19)

    def test_every_source_calculation_matches_independent_saved_excel_caches(self):
        engine, _ = engine_for_draft(source_example(), effective=False)
        count = 0
        for sheet in source_model()['sheets']:
            if sheet['name'] not in ('CALC', 'BREAKDOWN'):
                continue
            for address, cell in sheet['cells'].items():
                if 'formula' not in cell:
                    continue
                expected = cell['cached_value']
                expected = '' if expected is None else expected
                actual = engine.value(sheet['name'], address)
                with self.subTest(sheet=sheet['name'], address=address):
                    if isinstance(expected, (int, float)):
                        self.assertAlmostEqual(actual, expected, places=9)
                    else:
                        self.assertEqual(actual, expected)
                count += 1
        self.assertEqual(count, 76)

    def test_all_inventory_list_names_prices_dimensions_match_source_cache(self):
        overlay, selections = inventory_lists()
        cells = next(s['cells'] for s in source_model()['sheets'] if s['name'] == 'LISTS')
        for rule in source_model()['list_filters']:
            col = rule['column']
            cached = [cells.get(col + str(row), {}).get('cached_value', cells.get(col + str(row), {}).get('value')) for row in range(1, 1001)]
            self.assertEqual(selections[col], [value for value in cached if value not in (None, '')])
        checked = 0
        for rule in source_model()['list_lookups']:
            for row in range(1, 1001):
                address = rule['column'] + str(row)
                cell = cells.get(address, {})
                expected = cell.get('cached_value', cell.get('value'))
                expected = '' if expected is None else expected
                with self.subTest(cell=address):
                    if isinstance(expected, (int, float)):
                        self.assertAlmostEqual(overlay[address], expected, places=10)
                    else:
                        self.assertEqual(overlay[address], expected)
                checked += 1
        self.assertEqual(checked, 19000)

    def test_pricing_usage_metadata_matches_firestopping_inventory_filters(self):
        metadata = pricing_usage_metadata()['firestopping']
        self.assertEqual(metadata['label'], 'Firestopping Estimator')
        self.assertEqual(metadata['source_field'], 'sales_description')
        expected = []
        for rule in source_model()['list_filters']:
            for keyword in rule['keywords']:
                if keyword.casefold() not in {value.casefold() for value in expected}:
                    expected.append(keyword)
        self.assertEqual(metadata['keywords'], expected)
        self.assertEqual([(group['key'], group['label'], group['list_column']) for group in metadata['groups']],
                         [(group['key'], group['label'], group['list_column']) for group in FIRESTOPPING_GROUPS])
        catalog = effective_catalog()
        listed = {name for names in inventory_lists()[1].values() for name in names}
        classified = {item['sales_description'] for item in catalog['inventory']
                      if any(keyword.casefold() in item['sales_description'].casefold()
                             for keyword in metadata['keywords'])}
        self.assertEqual(classified, listed)

    def test_explicit_firestopping_groups_move_a_product_between_dropdowns(self):
        catalog = baseline()
        product = next(item for item in catalog['inventory'] if item['id'] == '207')
        name = product['sales_description']
        self.assertIn(name, inventory_lists({'catalog': catalog})[1]['B'])
        product['firestopping_groups'] = ['wraps']
        selections = inventory_lists({'catalog': catalog})[1]
        self.assertNotIn(name, selections['B'])
        self.assertIn(name, selections['E'])

    def test_row_formula_expansion_matches_independent_openpyxl(self):
        from openpyxl.formula.translate import Translator
        from openpyxl.formula import Tokenizer
        def tokens(formula):
            return [(t.type, t.subtype, t.value) for t in Tokenizer(formula).items if t.type != 'WHITE-SPACE']
        calc = next(s['cells'] for s in source_model()['sheets'] if s['name'] == 'CALC')
        for address, cell in calc.items():
            if 'formula' not in cell or not address.endswith('4'):
                continue
            for row in (5, 503, 1003):
                with self.subTest(cell=address, row=row):
                    self.assertEqual(tokens(_copy_row_formula(cell['formula'], row)),
                                     tokens(Translator(cell['formula'], origin=address).translate_formula(address[:-1] + str(row))))


class PenetrationCalculationTests(unittest.TestCase):
    def test_frl_and_shared_settings_are_canonical_and_drive_every_row(self):
        draft = source_example()
        template = deepcopy(draft['rows'][0]['inputs'])
        draft['rows'] = []
        pipe_settings = [
            ('Unlagged Pipes', 'waste_unlagged_pipes'),
            ('Lagged Pipes', 'waste_lagged_pipes'),
            ('Plastic Pipes', 'waste_plastic_pipes'),
            ('Cable Bundles', 'waste_bundles'),
        ]
        for index, (service, _) in enumerate(pipe_settings, 1):
            inputs = deepcopy(template)
            inputs.update(K=service, N='120 min')
            draft['rows'].append({'id': f'row-{index}', 'inputs': inputs})
        for index, key in enumerate(WASTE_SETTINGS, 1):
            draft['globals'][key] = index / 100
        normalized = normalize_draft(draft)
        self.assertEqual([row['inputs']['N'] for row in normalized['rows']], ['-/120/120'] * 4)
        self.assertEqual(definition()['row_fields'][4]['options'], list(FRL_OPTIONS))
        engine, _ = engine_for_draft(draft)
        for row, (_, key) in enumerate(pipe_settings, 4):
            self.assertEqual(engine.value('CALC', f'AO{row}'), draft['globals'][key])
        pipe_keys = {key for _, key in pipe_settings}
        for row in range(4, 8):
            for key, (column, _) in WASTE_SETTINGS.items():
                if key not in pipe_keys:
                    self.assertEqual(engine.value('CALC', f'{column}{row}'), draft['globals'][key])

    def test_legacy_shared_pipe_waste_migrates_to_every_service_tab(self):
        normalized = normalize_draft({'globals': {'waste_pipes': .175},
                                      'rows': [{'id': 'legacy', 'inputs': {'K': 'Lagged Pipes'}}]})
        self.assertNotIn('waste_pipes', normalized['globals'])
        keys = (
            'waste_unlagged_pipes', 'waste_lagged_pipes',
            'waste_plastic_pipes', 'waste_bundles')
        self.assertEqual([normalized['globals'][key] for key in keys], [.175] * 4)
        row_legacy = normalize_draft({'globals': {},
                                      'rows': [{'id': 'legacy', 'inputs': {'AO': .225}}]})
        self.assertEqual([row_legacy['globals'][key] for key in keys], [.225] * 4)

    def test_blank_draft_and_globals_do_not_resurrect_example(self):
        result = calculate(None)
        self.assertEqual(result['draft']['rows'][0]['inputs'], {})
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['summary']['grand_total'], '')
        self.assertEqual(result['summary']['labour_hours'], 0)
        self.assertEqual(result['draft'], normalize_draft(None))

    def test_legacy_conduit_values_resolve_to_one_conduits_choice_and_route(self):
        spec = definition(service_types=['Conduit', 'Conduits'])
        service = next(field for field in spec['row_fields'] if field['column'] == 'K')
        self.assertNotIn('Conduit', service['options'])
        self.assertEqual(service['options'].count('Conduits'), 1)
        draft = {'globals': {'service_routes': {'Plastic Pipes': ['Plastic Pipes', 'Conduit', 'Conduits']}},
                 'rows': [{'id': 'legacy-conduit', 'inputs': {'K': 'Conduit'}}]}
        normalized = normalize_draft(draft)
        self.assertEqual(normalized['rows'][0]['inputs']['K'], 'Conduits')
        self.assertEqual(normalized['globals']['service_routes']['Plastic Pipes'], ['Plastic Pipes', 'Conduits'])

    def test_new_row_defaults_and_descriptive_choices_preserve_existing_inputs(self):
        spec = definition(service_types=['Saved custom service'])
        fields = {field['column']: field for field in spec['row_fields']}
        self.assertEqual(spec['defaults']['rows'][0]['inputs'], {})
        self.assertNotIn('Q', fields)
        self.assertNotIn('R', fields)
        settings = {field['column']: field for field in spec['global_fields']}
        self.assertEqual(len(settings), 10)
        self.assertEqual(settings['register_allowance_hours']['label'], 'Register Allowance')
        self.assertEqual(settings['register_allowance_hours']['default'], .25)
        self.assertEqual(settings['register_allowance_hours']['step'], .05)
        self.assertTrue(all(field['group'] == 'SETTINGS' for field in settings.values()))
        self.assertEqual(spec['defaults']['globals']['labour_bands']['pipe'], [
            {'maximum': maximum, 'hours': hours}
            for maximum, hours in ((50, .25), (100, .30), (150, .35),
                                   (200, .40), (250, .45), (300, .50))])
        self.assertEqual([item['key'] for item in spec['settings']['labour_bands']],
                         ['pipe', 'board', 'mastic', 'framing', 'wrap'])
        self.assertEqual([item['key'] for item in spec['settings']['service_routes']],
                         ['Unlagged Pipes', 'Lagged Pipes', 'Plastic Pipes',
                          'Cables/Bundles', 'Cabletrays', 'Substrate'])
        self.assertTrue(all(settings[key]['label'] == 'Waste'
                            and settings[key]['format'] == 'percent'
                            and settings[key]['help'].startswith('Applies to ')
                            for key in settings if key.startswith('waste_')))
        self.assertEqual(fields['K']['type'], 'select')
        self.assertIn('Saved custom service', fields['K']['options'])
        self.assertIn('Cable Trays', fields['K']['options'])
        self.assertEqual(fields['V']['options'], ['Promat', 'Trafalgar', 'Boss', 'Firefly', 'Hilti', 'Snap', 'Fendix'])
        self.assertEqual(fields['J']['label'], 'Category')
        self.assertEqual(fields['T']['label'], 'Description')
        self.assertEqual(fields['U']['label'], 'System/Install Details')
        self.assertEqual(fields['W']['label'], 'Teams/Crews')
        self.assertEqual(fields['X']['label'], 'Board/Batt Type')
        self.assertEqual(fields['Z']['label'], 'Framing Type')
        self.assertNotIn('register_allowance_hours', fields)
        for column in ('AG', 'AO', 'AU', 'AZ', 'BF', 'BG'):
            self.assertNotIn(column, fields)
        self.assertEqual(fields['N']['options'], ['N/A', '-/60/60', '-/90/90', '-/120/120', '-/180/180', '-/240/240'])
        self.assertEqual(spec['groups'], ['Penetration', 'Products and labour', 'Additional Allowances',
            'Unlagged Pipes', 'Lagged Pipes', 'Plastic Pipes', 'Cables/Bundles', 'Cabletrays', 'Substrate', 'Bulkhead', 'SETTINGS'])
        self.assertEqual(spec['group_labels'], {'Penetration': 'DETAILS', 'Cabletrays': 'CABLE TRAYS',
            'Cables/Bundles': 'BUNDLES', 'Additional Allowances': 'OTHER'})
        self.assertEqual(spec['group_visibility']['Bulkhead'], {'column': 'J', 'values': ['Bulkheads']})
        self.assertEqual(spec['group_visibility']['Substrate']['any'][0], {'column': 'L', 'values': ['Oversized']})
        self.assertEqual(spec['group_visibility']['Substrate']['any'][1]['column'], 'K')
        for service in ('Access Panel', 'Blank Seal', 'Fire Dampers', 'Linear Joints', 'Movement Joints'):
            self.assertIn(service, spec['group_visibility']['Substrate']['any'][1]['values'])
        self.assertEqual(spec['group_visibility']['Cabletrays']['column'], 'K')
        self.assertEqual(spec['group_visibility']['Cabletrays']['route_key'], 'Cabletrays')
        for service in ('D1 Power Cables', 'D2 Comms Cables', 'Data Cable Bundles',
                        'Pair Coil Bundle', 'Cable Trays', 'Lagged Pipes'):
            self.assertIn(service, spec['group_visibility']['Cabletrays']['values'])
        self.assertNotIn('Plastic Pipes', spec['group_visibility']['Cabletrays']['values'])
        self.assertIn('Plastic Pipes', spec['group_visibility']['Plastic Pipes']['values'])
        self.assertEqual(spec['group_visibility']['Unlagged Pipes']['values'], ['Unlagged Pipes'])
        self.assertEqual(spec['group_visibility']['Lagged Pipes']['values'], ['Lagged Pipes'])
        self.assertEqual(spec['group_visibility']['Unlagged Pipes']['route_key'], 'Unlagged Pipes')
        self.assertEqual(spec['group_visibility']['Lagged Pipes']['route_key'], 'Lagged Pipes')
        self.assertIn('Cable Bundles', spec['group_visibility']['Cables/Bundles']['values'])
        pipe_fields = [field for field in spec['row_fields'] if field['group'] == 'Pipes']
        self.assertEqual([field['column'] for field in pipe_fields],
                         ['AL', 'AM', 'AN', 'pipe_labour_hours'])
        for field in pipe_fields:
            expected_groups = ['Unlagged Pipes', 'Lagged Pipes', 'Cables/Bundles'] if field['column'] == 'AM' else [
                'Unlagged Pipes', 'Lagged Pipes', 'Plastic Pipes', 'Cables/Bundles']
            self.assertEqual(field['display_groups'], expected_groups)
        self.assertTrue(fields['pipe_labour_hours']['hidden'])
        self.assertEqual(fields['AM']['label'], 'Wrap Length required')
        self.assertEqual(fields['AN']['label'], 'Wrap Multiplier')
        self.assertEqual(fields['AS']['label'], 'Wrap Length required')
        self.assertEqual(fields['P']['options'], ['Plasterboard wall', 'Concrete/masonry wall', 'Hebel wall',
            'Speedpanel wall', 'Dincel wall', 'AFS wall', 'CLT wall', 'Insulated panel wall',
            'Plasterboard ceiling', 'Concrete/masonry floor', 'Bondek floor', 'Hebel floor', 'CLT floor'])
        self.assertEqual(fields['AQ']['paired_column'], 'AR')
        self.assertEqual(fields['AR']['paired_into'], 'AQ')
        self.assertTrue(fields['AR']['hidden'])
        self.assertEqual(fields['AW']['paired_column'], 'AX')
        self.assertEqual(fields['AX']['paired_into'], 'AW')
        self.assertTrue(fields['AX']['hidden'])
        expected_steps = {'O': 1, 'AC': .25,
            'AF': 1, 'AH': .25, 'AI': 1, 'AJ': 1, 'AM': 5,
            'AQ': 5, 'AR': 5, 'AS': 5, 'AT': 1,
            'AW': 5, 'AX': 5, 'AY': 1, 'BB': 5, 'BC': 5,
            'BD': 5, 'BE': 1}
        self.assertEqual({column: fields[column]['step'] for column in expected_steps}, expected_steps)
        self.assertNotIn('step', fields['AL'])
        self.assertNotIn('step', fields['pipe_labour_hours'])
        existing = {'globals': {}, 'rows': [{'id': 'old', 'inputs': {'Q': None, 'R': 'Easy', 'V': 'FIREFLY', 'K': 'Legacy text'}}]}
        self.assertEqual(normalize_draft(existing)['rows'], existing['rows'])
        original = source_example()
        renamed = deepcopy(original)
        renamed['rows'][0]['inputs'].update(K='Cable Trays', V='Firefly')
        self.assertEqual(calculate(original)['summary'], calculate(renamed)['summary'])

    def test_percentage_outputs_display_source_fractions_as_percentages(self):
        spec = definition()
        outputs = {field['column']: field for field in spec['output_fields']}
        for col in ('BI', 'BJ', 'BK', 'BR', 'CA', 'CI', 'CP'):
            self.assertEqual((outputs[col]['format'], outputs[col]['units']), ('percent', '%'))
        self.assertEqual(outputs['H']['format'], 'currency')
        self.assertEqual(outputs['DK']['format'], 'number')
        self.assertEqual(calculate(source_example())['rows'][0]['outputs']['BI'], 0)

    def test_multirow_ignores_removed_travel_and_preserves_source_precision(self):
        draft = source_example()
        draft['rows'].append({'id': 'second', 'inputs': deepcopy(draft['rows'][0]['inputs'])})
        draft['globals']['K'] = 1.125
        result = calculate(draft)
        self.assertEqual(result['errors'], [])
        # Original direct labour/material costs, without substrate or travel.
        self.assertAlmostEqual(result['summary']['grand_total'], 2 * (494 + 336.50993360655735), places=10)
        self.assertEqual(result['summary']['labour_hours'], 3.8)
        self.assertEqual(result['summary']['total_days'], 3.8 / 8)
        self.assertEqual(result['summary']['travel_lafha'], '')
        self.assertEqual(result['draft']['globals']['K'], 1.125)
        self.assertEqual(result['rows'][0]['outputs'], result['rows'][1]['outputs'])

    def test_reviewed_substrate_labels_use_the_existing_workbook_multiplier_basis(self):
        draft = source_example()
        draft['rows'][0]['inputs']['P'] = 'Dincel wall'
        engine, normalized = engine_for_draft(draft)
        self.assertEqual(normalized['rows'][0]['inputs']['P'], 'Dincel wall')
        self.assertEqual(engine.inputs['CALC']['P4'], 'Concrete wall')
        self.assertFalse(any(error['cell'] == 'P4' for error in calculate(draft)['errors']))

    def test_shared_supplier_markup_updates_price_without_changing_saved_snapshot(self):
        draft = source_example()
        original = calculate(draft)
        frozen = configuration_catalog()
        configuration = {'inventory': {'300': {'supplier_price': 123.456789}}}
        current = calculate(draft, configuration)
        inventory = next(i for i in effective_catalog(configuration)['inventory'] if i['id'] == '300')
        self.assertEqual(current['rows'][0]['outputs']['CX'], inventory['sales_price'])
        self.assertNotEqual(current['summary']['grand_total'], original['summary']['grand_total'])
        self.assertEqual(calculate(draft, {'catalog': frozen})['summary'], original['summary'])
        self.assertEqual(current['draft'], original['draft'])

    def test_removed_product_never_resurrects_source_cached_price(self):
        draft = source_example()
        catalog = configuration_catalog()
        selected = draft['rows'][0]['inputs']['X']
        catalog['inventory'] = [item for item in catalog['inventory'] if item['sales_description'] != selected]
        # Keep catalog validation coherent: remove rates linked to this item too.
        ids = {i['id'] for i in catalog['inventory']}
        for group, rows in catalog['rate_groups'].items():
            catalog['rate_groups'][group] = [r for r in rows if not r.get('inventory_id') or r['inventory_id'] in ids]
        result = calculate(draft, {'catalog': catalog})
        self.assertEqual(result['rows'][0]['outputs']['CX'], '')
        self.assertTrue(any(e['cell'] == 'X4' for e in result['errors']))

    def test_duplicate_description_uses_first_inventory_price(self):
        catalog = configuration_catalog()
        item = next(i for i in catalog['inventory'] if i['id'] == '300')
        duplicate = deepcopy(item)
        duplicate['id'] = 'duplicate-board'
        duplicate['item_code'] = 'duplicate-board'
        duplicate['sales_price'] = 99999
        duplicate['calculated_sell_price'] = 99999
        catalog['inventory'].append(duplicate)
        result = calculate(source_example(), {'catalog': catalog})
        self.assertEqual(result['rows'][0]['outputs']['CX'], item['sales_price'])

    def test_input_boundary_rejects_formula_edits_duplicate_ids_and_nonfinite_numbers(self):
        for draft in ({'rows': [{'id': 'a', 'inputs': {'DK': 10}}]},
                      {'rows': [{'id': 'a'}, {'id': 'a'}]},
                      {'rows': [{'id': 'a', 'inputs': {'O': float('inf')}}]},
                      {'rows': [{'id': 'a', 'inputs': {'O': 10 ** 1000}}]},
                      {'rows': [{'id': 'a', 'inputs': {'O': True}}]},
                      {'globals': {'J': 'Maybe'}}, {'rows': [None]}, {'rows': [{'id': 'a', 'inputs': {'O': '1'}}]}):
            with self.subTest(draft=draft), self.assertRaises(ValidationError):
                normalize_draft(draft)

    def test_every_plastic_pipe_row_removes_only_positive_duplicate_additional_labour(self):
        rows = [
            {'id': 'automatic', 'inputs': {'K': 'Plastic Pipes', 'Y': 'Collar', 'AL': 50, 'AH': .25}},
            {'id': 'manual', 'inputs': {'K': 'Plastic Pipes', 'Y': 'Collar', 'AL': None,
                                        'pipe_labour_hours': .375, 'AH': 1}},
            {'id': 'zero-pipe', 'inputs': {'K': 'Plastic Pipes', 'Y': 'Collar', 'AL': None,
                                           'pipe_labour_hours': 0, 'AH': .25}},
            {'id': 'zero-additional', 'inputs': {'K': 'Plastic Pipes', 'Y': 'Collar', 'AL': 50, 'AH': 0}},
            {'id': 'no-collar', 'inputs': {'K': 'Plastic Pipes', 'Y': None, 'AL': 50, 'AH': .25}},
            {'id': 'other-service', 'inputs': {'K': 'D1 Power Cables', 'Y': 'Collar', 'AL': 50, 'AH': .25}},
        ]
        draft = {'globals': {}, 'rows': rows}
        before = deepcopy(draft)
        normalized = normalize_draft(draft)
        self.assertIsNone(normalized['rows'][0]['inputs']['AH'])
        self.assertIsNone(normalized['rows'][1]['inputs']['AH'])
        self.assertEqual([row['inputs']['AH'] for row in normalized['rows'][2:]], [.25, 0, .25, .25])
        self.assertEqual(draft, before)

    def test_summary_never_hides_row_calculation_error(self):
        original = PenetrationEngine.cell
        def failing(engine, sheet, row, column):
            if sheet == 'CALC' and row == 4 and column == column_number('DK'):
                raise FormulaError('#VALUE!')
            return original(engine, sheet, row, column)
        with patch.object(PenetrationEngine, 'cell', failing):
            result = calculate(source_example())
        self.assertEqual(result['summary']['labour_hours'], '#VALUE!')
        self.assertEqual(result['summary']['grand_total'], '#VALUE!')
        self.assertTrue(any(e['row_id'] is None and e['cell'] == 'H2' for e in result['errors']))

    def test_unknown_workbook_choices_are_visible_without_changing_source_results(self):
        draft = source_example()
        for col in ('J', 'L', 'M', 'N', 'P', 'Q', 'R'):
            draft['rows'][0]['inputs'][col] = 'Unlisted choice'
        result = calculate(draft)
        self.assertEqual({error['cell'] for error in result['rows'][0]['errors']},
                         {'J4', 'L4', 'M4', 'N4', 'P4'})
        self.assertEqual(result['rows'][0]['outputs']['BI'], 0)
        self.assertEqual(result['rows'][0]['outputs']['BJ'], 0)
        self.assertEqual(result['rows'][0]['outputs']['BK'], 0)
        self.assertEqual(result['draft']['rows'][0]['inputs']['P'], 'Unlisted choice')

    def test_source_labour_band_next_larger_and_maximum_fallback(self):
        engine, _ = engine_for_draft(None)
        for actual, expected in ((0.15, 0.5), (0.150001, 0.6)):
            engine.inputs['CALC']['CH4'] = actual
            engine.cache.clear()
            self.assertEqual(engine.value('CALC', 'DE4'), expected)
        engine.inputs['CALC'].update(CH4=1e8, AC4=1e8, CT4=1e8, AM4=1e8)
        engine.cache.clear()
        lists = next(s['cells'] for s in source_model()['sheets'] if s['name'] == 'LISTS')
        for output, last in (('DE4', 'BP38'), ('DG4', 'BM9'), ('DH4', 'BX16'), ('DI4', 'BR14')):
            self.assertEqual(engine.value('CALC', output), lists[last]['value'])

    def test_editable_routing_and_band_tables_are_validated_and_change_only_effective_task_hours(self):
        source_before = deepcopy(source_model())
        source = source_example()
        original = calculate(source)
        normalized = normalize_draft(source)
        self.assertEqual(normalized['globals']['service_routes']['Lagged Pipes'], ['Lagged Pipes'])
        self.assertNotIn('Lagged Pipes', normalized['globals']['service_routes']['Unlagged Pipes'])
        normalized['globals']['service_routes']['Lagged Pipes'] = ['Lagged Pipes', 'Saved custom lagged service']
        normalized['globals']['labour_bands'].update({
            key: [{'maximum': 1e12, 'hours': hours}]
            for key, hours in {'board': 3, 'mastic': 4, 'framing': 5, 'wrap': 6}.items()
        })
        normalized['rows'][0]['inputs']['AM'] = 500
        changed = calculate(normalized)
        self.assertEqual(changed['draft']['globals']['service_routes']['Lagged Pipes'],
                         ['Lagged Pipes', 'Saved custom lagged service'])
        self.assertEqual({key: changed['rows'][0]['outputs'][key]
                          for key in ('DE', 'DG', 'DH', 'DI')},
                         {'DE': 3, 'DG': 4, 'DH': 5, 'DI': 6})
        self.assertEqual(original['source_sha256'], changed['source_sha256'])
        self.assertEqual(source_model(), source_before)
        for invalid in (
                {'board': []},
                {'board': [{'maximum': .5, 'hours': .2}, {'maximum': .5, 'hours': .3}]},
                {'board': [{'maximum': 1, 'hours': -1}]},
                {'unknown': [{'maximum': 1, 'hours': 1}]},
        ):
            candidate = source_example()
            candidate['globals']['labour_bands'] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                normalize_draft(candidate)

    def test_legacy_pipe_hours_migrate_into_editable_bands(self):
        draft = source_example()
        draft['globals']['pipe_labour_100_hours'] = .875
        normalized = normalize_draft(draft)
        self.assertEqual(normalized['globals']['labour_bands']['pipe'][1],
                         {'maximum': 100, 'hours': .875})
        self.assertNotIn('pipe_labour_100_hours', normalized['globals'])


if __name__ == '__main__':
    unittest.main()
