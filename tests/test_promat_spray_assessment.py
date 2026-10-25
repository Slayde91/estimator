"""Synthetic Promat assessment boundaries; publisher matrices stay private."""
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator import promat_spray_assessment as policy
from estimator.calculator_defaults import default_calculator_inputs
from estimator.monokote_hollow import Assessment as MonokoteAssessment
from estimator.perlifoc_assessment import Assessment as PerlifocAssessment, PerlifocEngine
from estimator.workbook_calculators import approved_formula_overrides, calculator_session, source_model

EXPOSURES = {'R3': 'Re-entrant - 3 sides', 'R4': 'Re-entrant - 4 sides',
             'H3': 'Hollow - 3 sides', 'H4': 'Hollow - 4 sides',
             'PFC3W': 'PFC web to slab - 3 sides', 'C': 'Castellated - special factor'}


def synthetic_dataset():
    """Invented distinguishable cells: never use these values for design."""
    tables = []
    for product_index, product in enumerate(policy.PRODUCTS):
        cases = ('C', 'H', 'R') if product_index == 2 else ('H', 'R')
        for case_index, case in enumerate(cases):
            for ti, temperature in enumerate(policy.TEMPERATURES[product_index]):
                sources = [policy.source_locator(product, case, temperature, p) for p in policy.PERIODS[product_index]]
                tables.append({'product': product, 'case': case, 'temperature': temperature,
                    'values': [[None if sources[pi] is None else round(10 + 5 * product_index + case_index + ti / 10 + fi / 1000 + pi / 100000, 6)
                                for pi in range(len(policy.PERIODS[product_index]))]
                               for fi in range(len(policy.FACTORS[product_index]))], 'period_sources': sources})
    return {'schema_version': 1, 'id': policy.DATASET_ID,
            'products': [policy.product_metadata(p) for p in policy.PRODUCTS], 'tables': tables}


def encoded(data):
    return (json.dumps(data, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def row_inputs(product='CAFCO 300', case='R3', *, factor=200, temperature=550, period=120,
               method='Hp/A', section=None, **changes):
    inputs = default_calculator_inputs('steel_vermiculite')
    row = {'A': 'Synthetic report fixture', 'B': product, 'C': EXPOSURES[case], 'D': temperature,
           'E': method, 'F': section, 'G': factor, 'H': period, 'I': 2, 'J': 3, 'K': .4}
    row.update(changes)
    inputs['SCHEDULE'] = {f'{col}10': value for col, value in row.items()}
    inputs['CALCULATOR'] = {f'D{address}': row[col] for address, col in (
        (6, 'B'), (7, 'C'), (8, 'D'), (9, 'E'), (10, 'F'), (11, 'G'), (12, 'H'), (14, 'I'), (15, 'J'), (16, 'K'))}
    return inputs


class PromatSprayAssessmentTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.data = synthetic_dataset()
        self.install(self.data)
        environment = patch.dict('os.environ', {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': str(self.folder)})
        environment.start()
        self.addCleanup(environment.stop)

    def install(self, data):
        payload = encoded(data)
        self.path = self.folder / policy.DATASET_FILENAME
        self.path.write_bytes(payload)
        self.payload = payload
        pin = patch.object(policy, 'DATASET_SHA256', sha256(payload).hexdigest())
        pin.start()
        self.addCleanup(pin.stop)

    def engine(self, inputs, assessment=None):
        return policy.PromatSprayEngine(source_model('steel_vermiculite'), inputs,
            approved_formula_overrides('steel_vermiculite'),
            assessment=MonokoteAssessment('irrelevant', error='Synthetic other-product evidence unavailable.'),
            perlifoc_assessment=PerlifocAssessment('irrelevant', error='Synthetic other-product evidence unavailable.'),
            promat_assessment=assessment or policy.load_assessment())

    def test_private_loader_is_fresh_complete_hashable_and_fail_closed(self):
        assessment = policy.load_assessment()
        self.assertFalse(assessment.error)
        self.assertEqual(len(assessment.tables), 61)
        self.assertEqual(assessment.report_sha256s, policy.REPORT_SHA256S)
        self.assertIsInstance(hash(assessment), int)
        self.assertIsInstance(assessment.tables[0].values[0], tuple)
        self.path.write_bytes(self.payload + b' ')
        self.assertTrue(policy.load_assessment().error)
        self.path.unlink()
        self.assertTrue(policy.load_assessment().error)
        self.path.mkdir()
        self.assertTrue(policy.load_assessment().error)
        for bad in ['relative-evidence', str(policy.ROOT / 'private-evidence')]:
            with patch.dict('os.environ', {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': bad}):
                self.assertTrue(policy.load_assessment().error)
        with self.assertRaises(ValueError):
            policy.validate_assessment_payload(b'x' * (policy.MAX_DATASET_BYTES + 1))

    def test_matching_digest_cannot_bypass_source_axes_order_or_blank_source_cell(self):
        variants = []
        altered = deepcopy(self.data); altered['products'][0]['report'] = 'Unverified revision'; variants.append(altered)
        altered = deepcopy(self.data); altered['products'][1]['factors'][-1] = 324; variants.append(altered)
        altered = deepcopy(self.data); altered['tables'].reverse(); variants.append(altered)
        altered = deepcopy(self.data); altered['tables'][0]['values'][0][-1] = 10; variants.append(altered)
        altered = deepcopy(self.data); altered['tables'][1]['period_sources'][0]['pages'][0] += 1; variants.append(altered)
        for data in variants:
            payload = encoded(data)
            with self.subTest(data=data['products'][0]['report']), patch.object(policy, 'DATASET_SHA256', sha256(payload).hexdigest()):
                with self.assertRaises(ValueError):
                    policy.validate_assessment_payload(payload)
        duplicate = self.payload.replace(b'{', b'{"id":"duplicated",', 1)
        with patch.object(policy, 'DATASET_SHA256', sha256(duplicate).hexdigest()):
            with self.assertRaises(ValueError):
                policy.validate_assessment_payload(duplicate)

    def test_exact_report_table_and_page_selection_including_cp2_new_periods(self):
        assessment = policy.load_assessment()
        for product, case, temp, factor, period, table, page in [
                ('CAFCO 300', 'R4', 450, 70, 240, 4, 15),
                ('CAFCO 300', 'R3', 550, 310, 120, 6, 22),
                ('CAFCO 300', 'H4', 750, 310, 180, 14, 41),
                ('MANDOLITE CP2', 'R3', 700, 100, 300, 12, 17),
                ('MANDOLITE CP2', 'H4', 550, 100, 150, 17, 22),
                ('FENDOLITE MII', 'R3', 450, 70, 120, 4, 21),
                ('FENDOLITE MII', 'C', 750, 300, 60, 34, 114)]:
            result = policy.lookup(assessment, product, factor, temp, period, exposure=case, policy='Exact only')
            with self.subTest(product=product, case=case, period=period):
                self.assertIsInstance(result.thickness, (int, float))
                self.assertEqual((result.table, result.page), (table, page))
                self.assertEqual(result.status, 'PUBLISHED - ASSESSMENT TABLE')
                self.assertIn(policy.REPORTS[policy.PRODUCTS.index(product)], result.source)

    def test_blank_cells_and_absent_period_never_use_another_table(self):
        self.data['tables'][0]['values'][0][0] = None
        self.install(self.data)
        assessment = policy.load_assessment()
        result = policy.lookup(assessment, 'CAFCO 300', 70, 350, 30, exposure='H4')
        self.assertEqual(result.status, 'NP - NOT PUBLISHED')
        self.assertEqual(result.thickness, '')
        self.assertEqual(policy.lookup(assessment, 'CAFCO 300', 70, 350, 240, exposure='R4').status, 'FRL NOT TABULATED')
        self.assertEqual(policy.lookup(assessment, 'FENDOLITE MII', 100, 550, 30, exposure='R3').status, 'FRL NOT TABULATED')
        self.assertEqual(policy.lookup(assessment, 'MANDOLITE CP2', 100, 550, 45, exposure='R3').status, 'FRL NOT TABULATED')

    def test_factor_policy_never_rounds_down_or_extrapolates_above_maximum(self):
        assessment = policy.load_assessment()
        near = 200.00000000001
        result = policy.lookup(assessment, 'CAFCO 300', near, 550, 120, exposure='R3')
        self.assertEqual(result.actual_factor, near)
        self.assertEqual(result.table_factor, 205)
        self.assertEqual(policy.lookup(assessment, 'CAFCO 300', near, 550, 120, exposure='R3', policy='Exact only').status, 'NO EXACT FACTOR ROW')
        for product, maximum in [('CAFCO 300', 310), ('MANDOLITE CP2', 323.4), ('FENDOLITE MII', 385)]:
            self.assertEqual(policy.lookup(assessment, product, maximum + .000001, 550, 120, exposure='R4').status, 'FACTOR OUT OF RANGE')
        for bad in (0, -1, float('inf'), float('nan'), True, None, '100'):
            self.assertEqual(policy.lookup(assessment, 'CAFCO 300', bad, 550, 120, exposure='R3').status, 'ENTER POSITIVE FACTOR')

    def test_authorized_minimum_band_uses_that_cell_even_under_exact_policy(self):
        assessment = policy.load_assessment()
        for product, minimum in [('CAFCO 300', 70), ('MANDOLITE CP2', 63)]:
            result = policy.lookup(assessment, product, 20, 550, 180, exposure='R3', policy='Exact only')
            exact = policy.lookup(assessment, product, minimum, 550, 180, exposure='R3', policy='Exact only')
            self.assertEqual(result.table_factor, minimum)
            self.assertEqual(result.actual_factor, 20)
            self.assertEqual(result.thickness, exact.thickness)
            self.assertEqual(result.status, 'ESTIMATE - MINIMUM ASSESSMENT ROW')
        self.assertEqual(policy.lookup(assessment, 'FENDOLITE MII', 69, 550, 120, exposure='R3').status, 'FACTOR OUT OF RANGE')

    def test_only_expressly_allowed_temperature_floor_preserves_requested_temperature(self):
        assessment = policy.load_assessment()
        for product, requested, selected in [('CAFCO 300', 400, 350), ('MANDOLITE CP2', 620, 600)]:
            result = policy.lookup(assessment, product, 100, requested, 120, exposure='R3', policy='Exact only')
            self.assertEqual((result.input_temperature, result.table_temperature), (requested, selected))
            self.assertIn('LOWER ASSESSMENT TEMPERATURE', result.status)
            self.assertIn(f'{requested:g}', result.note)
        for product, bad in [('CAFCO 300', 751), ('CAFCO 300', 349), ('MANDOLITE CP2', 701), ('FENDOLITE MII', 621), ('FENDOLITE MII', None)]:
            self.assertEqual(policy.lookup(assessment, product, 100, bad, 120, exposure='R3').status, 'UNSUPPORTED CASE / TEMP')
        self.assertIn(620, policy.temperature_options('MANDOLITE CP2'))
        self.assertNotIn(750, policy.temperature_options('MANDOLITE CP2'))
        self.assertIn(300, policy.period_options('MANDOLITE CP2', 700))
        self.assertNotIn(240, policy.period_options('CAFCO 300', 400))

    def test_casefold_routing_preserves_raw_labels_and_does_not_add_unmatched_aliases(self):
        inputs = row_inputs(product='CaFcO 300')
        original = deepcopy(inputs)
        engine = self.engine(inputs)
        self.assertTrue(engine.promat_scope_active(3))
        self.assertIsInstance(engine.value('SCHEDULE', 'P10'), (int, float))
        self.assertEqual(engine.value('SCHEDULE', 'B10'), 'CaFcO 300')
        self.assertEqual(inputs, original)
        self.assertIsNone(policy.canonical_product(' CAFCO 300'))
        self.assertIsNone(policy.canonical_product('CAFCO'))

    def test_fixed_report_conversion_is_independent_of_estimating_density(self):
        for product, case, temp, method, section, factor in [
                ('CAFCO 300', 'R3', 550, 'ESA/M', None, 20),
                ('CAFCO 300', 'R3', 620, 'Section', '410UB54', None),
                ('CAFCO 300', 'R3', 550, 'Section', '410UB54', None),
                ('FENDOLITE MII', 'H4', 550, 'Section', '100X100X9SHS', None)]:
            base = row_inputs(product, case, temperature=temp, method=method, section=section, factor=factor)
            changed = deepcopy(base); changed['SETTINGS']['D13'] = 1000
            first, second = self.engine(base), self.engine(changed)
            self.assertEqual(first.value('ENGINE', 'R3'), second.value('ENGINE', 'R3'))
            self.assertEqual(first.value('SCHEDULE', 'P10'), second.value('SCHEDULE', 'P10'))
            self.assertIn('7.85', second.value('SCHEDULE', 'Y10'))
            self.assertEqual(changed['SETTINGS']['D13'], 1000)
        self.assertEqual(self.engine(row_inputs(method='ESA/M', factor=20)).value('ENGINE', 'R3'), 157)

    def test_family_identity_and_sides_guards_are_retained(self):
        for product, case, section in [('CAFCO 300', 'H4', '410UB54'), ('MANDOLITE CP2', 'H3', '168.3X6.4CHS'),
                                      ('MANDOLITE CP2', 'R3', '100X100X9SHS')]:
            engine = self.engine(row_inputs(product, case, method='Section', section=section))
            self.assertEqual(engine.value('SCHEDULE', 'P10'), '')
            self.assertIn('UNSUPPORTED STEEL SECTION', engine.value('SCHEDULE', 'V10'))
        for product in ('CAFCO 300', 'FENDOLITE MII'):
            engine = self.engine(row_inputs(product, 'H3'))
            self.assertEqual(engine.value('SCHEDULE', 'P10'), '')
            self.assertIn('UNSUPPORTED CASE', engine.value('SCHEDULE', 'V10'))
        self.assertIsInstance(self.engine(row_inputs('MANDOLITE CP2', 'H3', method='Section', section='100X100X9SHS')).value('SCHEDULE', 'P10'), (int, float))
        self.assertIsInstance(self.engine(row_inputs('CAFCO 300', 'PFC3W', method='Section', section='180PFC')).value('SCHEDULE', 'P10'), (int, float))

    def test_castellated_report_formula_and_cap_ignore_editable_native_numerator(self):
        inputs = row_inputs('FENDOLITE MII', 'C', method='Lower web (mm)', factor=7)
        inputs['SETTINGS']['D115'] = 17
        engine = self.engine(inputs)
        self.assertEqual(engine.value('ENGINE', 'R3'), 200)
        self.assertIsInstance(engine.value('SCHEDULE', 'P10'), (int, float))
        self.assertIn('1400', engine.value('SCHEDULE', 'Y10'))
        table = next(t for t in self.data['tables'] if (t['product'], t['case'], t['temperature']) == ('FENDOLITE MII', 'C', 550))
        table['values'][policy.FACTORS[2].index(200)][policy.PERIODS[2].index(120)] = 53
        self.install(self.data)
        held = self.engine(inputs)
        self.assertEqual(held.value('SCHEDULE', 'P10'), '')
        self.assertIn('ABOVE 52.8', held.value('SCHEDULE', 'V10'))
        self.assertEqual(held.value('SCHEDULE', 'S10'), '')
        self.assertEqual(inputs['SETTINGS']['D115'], 17)
        for method in ('ESA/M', 'Section'):
            invalid = self.engine(row_inputs('FENDOLITE MII', 'C', method=method, factor=20, section='410UB54'))
            self.assertEqual(invalid.value('SCHEDULE', 'P10'), '')
            self.assertIn('ENTER LOWER WEB / SPECIAL FACTOR', invalid.value('SCHEDULE', 'V10'))

    def test_missing_evidence_holds_thickness_quantities_and_never_reuses_manual_values(self):
        missing = policy.Assessment('missing', error='Synthetic assessment absent.')
        for product in policy.PRODUCTS:
            engine = self.engine(row_inputs(product), assessment=missing)
            for col in ('O', 'P', 'S', 'T', 'U'):
                self.assertEqual(engine.value('SCHEDULE', col + '10'), '')
            self.assertIn('ASSESSMENT DATA UNAVAILABLE', engine.value('SCHEDULE', 'V10'))
            self.assertEqual(engine.value('SCHEDULE', 'X10'), policy.REPORTS[policy.PRODUCTS.index(product)])

    def test_unsupported_inputs_identify_current_report_without_inventing_page_or_thickness(self):
        engine = self.engine(row_inputs('CAFCO 300', 'H3'))
        self.assertEqual(engine.value('SCHEDULE', 'X10'), 'FC13107-01-05')
        self.assertEqual(engine.value('SCHEDULE', 'P10'), '')
        self.assertEqual(engine.value('SCHEDULE', 'S10'), '')

    def test_native_area_yield_and_precision_consume_only_the_new_thickness(self):
        inputs = row_inputs(factor=200.123456789, period=120)
        inputs['SETTINGS'].update(D36=20, D37=None, D38=390)
        original = deepcopy(inputs)
        engine = self.engine(inputs)
        thickness = engine.value('SCHEDULE', 'P10')
        self.assertEqual(engine.value('SCHEDULE', 'R10'), 2 * 3 * .4)
        self.assertEqual(engine.value('SCHEDULE', 'S10'), engine.value('SCHEDULE', 'R10') * thickness / 1000)
        self.assertEqual(engine.value('SCHEDULE', 'T10'), engine.value('SCHEDULE', 'S10') / (20 / 390))
        self.assertEqual(engine.value('ENGINE', 'R3'), 200.123456789)
        self.assertEqual(inputs, original)

    def test_unaffected_perlifoc_monokote_paths_are_byte_for_value_identical(self):
        for product, case in [('MONOKOTE MK-6 HY', 'R3'), ('MONOKOTE Z106', 'H4'), ('PERLIFOC HP ECO+', 'R4')]:
            inputs = row_inputs(product, case)
            kwargs = {'assessment': MonokoteAssessment('irrelevant', error='Synthetic other-product evidence unavailable.'),
                      'perlifoc_assessment': PerlifocAssessment('irrelevant', error='Synthetic other-product evidence unavailable.')}
            old = PerlifocEngine(source_model('steel_vermiculite'), inputs, approved_formula_overrides('steel_vermiculite'), **kwargs)
            new = policy.PromatSprayEngine(source_model('steel_vermiculite'), inputs,
                approved_formula_overrides('steel_vermiculite'), promat_assessment=policy.load_assessment(), **kwargs)
            self.assertEqual([old.value('SCHEDULE', c + '10') for c in 'MNOPQRSTUVWX Y'.replace(' ', '')],
                             [new.value('SCHEDULE', c + '10') for c in 'MNOPQRSTUVWX Y'.replace(' ', '')])

    def test_session_cache_keys_include_fresh_validated_assessment_snapshot(self):
        inputs = row_inputs()
        _, first, _ = calculator_session('steel_vermiculite', inputs)
        self.assertIsInstance(first.value('SCHEDULE', 'P10'), (int, float))
        self.path.write_bytes(self.payload + b' ')
        _, second, _ = calculator_session('steel_vermiculite', inputs)
        self.assertIsNot(first, second)
        self.assertEqual(second.value('SCHEDULE', 'P10'), '')
        self.assertIn('UNAVAILABLE', second.value('SCHEDULE', 'V10'))

    def test_display_metadata_updates_do_not_mutate_original_catalog(self):
        from estimator.workbook_catalog import load_workbook_catalog
        source = load_workbook_catalog('steel_vermiculite')
        raw = next(s['cells'] for s in source['sheets'] if s['name'] == 'SETTINGS')
        model = deepcopy(source)
        policy.apply_model_metadata(model)
        display = next(s['cells'] for s in model['sheets'] if s['name'] == 'SETTINGS')
        self.assertEqual(raw['D33']['value'], 'C300-2021')
        self.assertEqual(display['D33']['value'], 'FC13107-01-05')
        self.assertEqual(display['D98']['value'], 'FAR3541 Issue 7')
        self.assertNotIn('400C substitution', display['D121']['value'].replace('superseded 400C substitution', ''))
        self.assertEqual(raw['D42'], display['D42'])


class PromatSprayImporterBoundaryTests(unittest.TestCase):
    def test_output_inside_repository_is_rejected_before_reading_reports(self):
        from scripts import import_promat_spray_assessments as importer
        target = importer.ROOT / 'never-write-assessment-data.json'
        self.assertFalse(target.exists())
        with self.assertRaises(ValueError):
            importer.import_assessments(['missing.pdf'] * 3, target)
        self.assertFalse(target.exists())

    def test_wrong_source_digest_creates_no_dataset_or_receipt(self):
        from scripts import import_promat_spray_assessments as importer
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'unverified.pdf'
            source.write_bytes(b'%PDF-unverified complete-report substitute')
            target = Path(folder) / 'dataset.json'
            with self.assertRaises(ValueError):
                importer.import_assessments([source] * 3, target)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix('.json.receipt.json').exists())

    def test_existing_output_is_preserved_without_opening_missing_reports(self):
        from scripts import import_promat_spray_assessments as importer
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'dataset.json'
            target.write_bytes(b'private recovery must remain intact')
            with self.assertRaises(ValueError):
                importer.import_assessments(['missing.pdf'] * 3, target)
            self.assertEqual(target.read_bytes(), b'private recovery must remain intact')

    def test_relative_or_incomplete_input_contract_cannot_write_output(self):
        from scripts import import_promat_spray_assessments as importer
        for paths, output in [(['missing.pdf'] * 3, Path('relative-output.json')), ([], Path(tempfile.gettempdir()) / 'missing-three-pdfs.json')]:
            with self.assertRaises(ValueError):
                importer.import_assessments(paths, output)


if __name__ == '__main__':
    unittest.main()
