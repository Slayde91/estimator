"""FC21278 policy checks with invented matrices, never publisher tables."""

from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator import perlifoc_assessment as policy
from estimator.calculator_defaults import default_calculator_inputs
from estimator.calculator_register import build_calculator_register
from estimator.calculator_report import build_calculator_report, build_calculator_summary_report, project_calculator_report
from estimator.monokote_hollow import Assessment as MonokoteAssessment, MonokoteHollowEngine
from estimator.workbook_calculators import (approved_formula_overrides, calculator_session,
                                           calculate_page, calculate_worksheet, source_model)


EXPOSURES = {'R3': 'Re-entrant - 3 sides', 'R4': 'Re-entrant - 4 sides',
             'H3': 'Hollow - 3 sides', 'H4': 'Hollow - 4 sides'}


def synthetic_dataset():
    """The invented values make every table/row/period address distinguishable."""
    return {
        'schema_version': 1, 'id': policy.DATASET_ID,
        'source': {'report': 'FC21278-01-1', 'date': '2025-11-04', 'sha256': policy.REPORT_SHA256},
        'temperatures': list(policy.TEMPERATURES), 'factors': list(policy.FACTORS),
        'periods': list(policy.PERIODS),
        'tables': [{'case': case, 'temperature': temperature,
                    'page': case_index * 9 + temperature_index + 11,
                    'table': case_index * 9 + temperature_index + 5,
                    'values': [[(case_index + 1) * 100 + temperature_index * 10 + factor_index + period_index
                                for period_index in range(len(policy.PERIODS))]
                               for factor_index in range(len(policy.FACTORS))]}
                   for case_index, case in enumerate(policy.CASES)
                   for temperature_index, temperature in enumerate(policy.TEMPERATURES)],
    }


def encoded(data):
    return json.dumps(data, separators=(',', ':'), allow_nan=False).encode()


def row_inputs(case='R3', *, factor=200, temperature=550, period=120, method='Hp/A', section=None, **changes):
    inputs = default_calculator_inputs('steel_vermiculite')
    values = {'A': 'Perlifoc diagnostic', 'B': 'PERLIFOC HP ECO+', 'C': EXPOSURES[case],
              'D': temperature, 'E': method, 'F': section, 'G': factor, 'H': period,
              'I': 2, 'J': 3, 'K': .4}
    values.update(changes)
    inputs['SCHEDULE'] = {f'{column}10': value for column, value in values.items()}
    inputs['CALCULATOR'] = {f'D{target}': values[column] for target, column in (
        (6, 'B'), (7, 'C'), (8, 'D'), (9, 'E'), (10, 'F'), (11, 'G'), (12, 'H'),
        (14, 'I'), (15, 'J'), (16, 'K'))}
    return inputs


class PerlifocAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.data = synthetic_dataset()
        self.data['tables'][-1]['values'][-1][-1] = None
        self.payload = encoded(self.data)
        self.path = Path(self.folder.name) / policy.DATASET_FILENAME
        self.path.write_bytes(self.payload)
        pin = patch.object(policy, 'DATASET_SHA256', sha256(self.payload).hexdigest())
        pin.start()
        self.addCleanup(pin.stop)
        environment = patch.dict('os.environ', {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': self.folder.name})
        environment.start()
        self.addCleanup(environment.stop)

    def direct_engine(self, inputs, assessment=None):
        return policy.PerlifocEngine(source_model('steel_vermiculite'), inputs,
                                    approved_formula_overrides('steel_vermiculite'),
                                    assessment=MonokoteAssessment('missing', error='Synthetic Monokote evidence missing.'),
                                    perlifoc_assessment=assessment or policy.load_assessment())

    def test_loader_accepts_only_bound_complete_snapshot_and_regular_external_file(self):
        assessment = policy.load_assessment()
        self.assertFalse(assessment.error)
        self.assertEqual(assessment.digest, sha256(self.payload).hexdigest())
        self.assertEqual(assessment.report_sha256, policy.REPORT_SHA256)
        self.assertEqual(len(assessment.tables), 36)
        self.assertIsInstance(assessment.tables[0].values[0], tuple)
        self.path.write_bytes(self.payload + b' ')
        self.assertTrue(policy.load_assessment().error)
        self.path.unlink()
        self.assertTrue(policy.load_assessment().error)
        self.path.mkdir()
        self.assertTrue(policy.load_assessment().error)
        with patch.dict('os.environ', {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': 'relative-evidence'}):
            self.assertTrue(policy.load_assessment().error)
        with patch.dict('os.environ', {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': str(policy.ROOT / 'calculator-evidence')}):
            self.assertTrue(policy.load_assessment().error)
        with self.assertRaises(ValueError):
            policy.validate_assessment_payload(b'x' * (policy.MAX_DATASET_BYTES + 1))

    def test_matching_hash_does_not_bypass_axes_source_order_or_cell_validation(self):
        changes = [lambda d: d.update(factors=[68]),
                   lambda d: d.update(temperatures=[350]),
                   lambda d: d.update(periods=[120]),
                   lambda d: d['source'].update(report='FC15622-I4'),
                   lambda d: d['source'].update(sha256='1' * 64),
                   lambda d: d['source'].update(date='2024-02-14'),
                   lambda d: d['tables'].pop(),
                   lambda d: d['tables'][0].update(case='H4'),
                   lambda d: d['tables'][0].update(page=12),
                   lambda d: d['tables'][0]['values'].pop(),
                   lambda d: d['tables'][0]['values'][0].pop(),
                   lambda d: d['tables'][0]['values'][0].__setitem__(0, 0),
                   lambda d: d['tables'][0]['values'][0].__setitem__(0, True),
                   lambda d: d['tables'][0]['values'][0].__setitem__(0, 10.5)]
        for change in changes:
            data = deepcopy(self.data)
            change(data)
            payload = encoded(data)
            with self.subTest(change=change), patch.object(policy, 'DATASET_SHA256', sha256(payload).hexdigest()):
                with self.assertRaises(ValueError):
                    policy.validate_assessment_payload(payload)

    def test_every_table_and_period_resolves_its_distinct_synthetic_address(self):
        assessment = policy.load_assessment()
        for table in self.data['tables']:
            for factor_index in (0, 13, 42):
                for period_index, period in enumerate(policy.PERIODS):
                    factor = policy.FACTORS[factor_index]
                    expected = table['values'][factor_index][period_index]
                    result = policy.lookup(assessment, factor, table['temperature'], period, exposure=table['case'])
                    with self.subTest(case=table['case'], temp=table['temperature'], factor=factor, period=period):
                        self.assertEqual(result.thickness, '' if expected is None else expected)
                        self.assertEqual(result.page, table['page'])
                        self.assertEqual(result.table, table['table'])
                        self.assertEqual(result.status, 'NP - NOT PUBLISHED' if expected is None else 'PUBLISHED - ASSESSMENT TABLE')

    def test_exact_policy_bounds_and_unpublished_values_do_not_fall_back(self):
        assessment = policy.load_assessment()
        cases = [(67, 550, 120, 'R3', 'FACTOR OUT OF RANGE'),
                 (476.1, 550, 120, 'R3', 'FACTOR OUT OF RANGE'),
                 (0, 550, 120, 'R3', 'ENTER POSITIVE FACTOR'),
                 (True, 550, 120, 'R3', 'ENTER POSITIVE FACTOR'),
                 (200, 620, 120, 'R3', 'UNSUPPORTED CASE / TEMP'),
                 (200, 550, 150, 'R3', 'FRL NOT TABULATED'),
                 (200, 550, 120, 'PFC3W', 'UNSUPPORTED CASE / TEMP'),
                 (476, 750, 360, 'H4', 'NP - NOT PUBLISHED')]
        for factor, temp, period, case, expected in cases:
            with self.subTest(inputs=(factor, temp, period, case)):
                result = policy.lookup(assessment, factor, temp, period, exposure=case)
                self.assertEqual(result.status, expected)
                self.assertEqual(result.thickness, '')
        for factor in (68, 476):
            self.assertIsInstance(policy.lookup(assessment, factor, 550, 120, exposure='R3').thickness, int)
        upper = policy.lookup(assessment, 201, 550, 120, exposure='R3')
        self.assertEqual(upper.table_factor, 210)
        self.assertIn('without interpolation', upper.note)
        self.assertEqual(policy.lookup(assessment, 201, 550, 120, exposure='R3', policy='exact only').status,
                         'NO EXACT FACTOR ROW')
        self.assertEqual(policy.lookup(assessment, 200, 550, 120, exposure='r3', policy='EXACT ONLY').thickness,
                         policy.lookup(assessment, 200, 550, 120, exposure='R3').thickness)
        self.assertEqual(policy.lookup(assessment, 200, 550, 120, exposure='R3', policy=' Exact only').status,
                         'CHECK LOOKUP POLICY')

    def test_all_exposures_and_360_use_new_thickness_for_quick_schedule_and_bags(self):
        assessment = policy.load_assessment()
        for case in policy.CASES:
            for period in (120, 180, 240, 360):
                inputs = row_inputs(case, period=period)
                before = deepcopy(inputs)
                engine = self.direct_engine(inputs)
                expected = policy.lookup(assessment, 200, 550, period, exposure=case).thickness
                with self.subTest(case=case, period=period):
                    self.assertEqual(engine.value('CALCULATOR', 'H6'), expected)
                    self.assertEqual(engine.value('SCHEDULE', 'O10'), expected)
                    self.assertEqual(engine.value('SCHEDULE', 'P10'), expected)
                    self.assertAlmostEqual(engine.value('SCHEDULE', 'S10'), 2 * 3 * .4 * expected / 1000)
                    self.assertGreater(engine.value('SCHEDULE', 'T10'), 0)
                    self.assertEqual(engine.value('SCHEDULE', 'W10'), 'QUANTIFIED - ESTIMATE')
                    self.assertIn('FC21278-01-1', engine.value('SCHEDULE', 'X10'))
                    self.assertNotIn('FC15622', engine.value('SCHEDULE', 'Y10'))
                    self.assertEqual(inputs, before)
                self.assertEqual(engine.value('CALCULATOR', 'J29'),
                                 policy.lookup(assessment, 200, 550, 360, exposure=case).thickness)
                self.assertEqual(engine.value('CALCULATOR', 'J30'), 'ASSESSMENT')

    def test_old_period_substitutions_are_replaced_by_exact_new_evidence(self):
        for case, temperature, factor in [('R3', 650, 100), ('R4', 400, 80)]:
            inputs = row_inputs(case, temperature=temperature, factor=factor)
            engine = self.direct_engine(inputs)
            expected = policy.lookup(policy.load_assessment(), factor, temperature, 120, exposure=case)
            self.assertEqual(engine.value('SCHEDULE', 'O10'), expected.thickness)
            self.assertEqual(engine.value('SCHEDULE', 'V10'), 'PUBLISHED - ASSESSMENT TABLE')
            self.assertNotIn('SUBSTITUTION', engine.value('SCHEDULE', 'Y10'))

    def test_h3_named_basis_matches_exact_three_side_factor_and_blocks_chs_and_open(self):
        engine = self.direct_engine(row_inputs('H3', method='Section', section='100X100X3SHS'))
        self.assertEqual(engine.value('ENGINE', 'R3'), 258)
        self.assertEqual(engine.value('SCHEDULE', 'N10'), 260)
        self.assertEqual(engine.value('SCHEDULE', 'V10'), 'ESTIMATE - SHARED FACTOR')
        self.assertIn('MK6-030521 p20', engine.value('SCHEDULE', 'Y10'))
        for case, section in [('H3', '168.3X6.4CHS'), ('H3', '410UB54'),
                              ('R3', '100X100X3SHS'), ('H4', '410UB54')]:
            engine = self.direct_engine(row_inputs(case, method='Section', section=section))
            with self.subTest(case=case, section=section):
                self.assertEqual(engine.value('SCHEDULE', 'V10'), 'UNSUPPORTED STEEL SECTION')
                self.assertEqual(engine.value('SCHEDULE', 'T10'), '')

    def test_esa_conversion_and_case_variants_preserve_original_inputs(self):
        inputs = row_inputs('H3', method='esa/m', factor=200 / 7.85)
        inputs['SCHEDULE']['B10'] = inputs['CALCULATOR']['D6'] = 'PeRlIfOc Hp EcO+'
        inputs['SCHEDULE']['C10'] = inputs['CALCULATOR']['D7'] = 'hOlLoW - 3 SiDeS'
        inputs['SETTINGS']['D14'] = 'NEXT HIGHER (ESTIMATE)'
        before = deepcopy(inputs)
        engine = self.direct_engine(inputs)
        self.assertAlmostEqual(engine.value('ENGINE', 'R3'), 200)
        self.assertEqual(engine.value('SCHEDULE', 'P10'),
                         self.direct_engine(row_inputs('H3')).value('SCHEDULE', 'P10'))
        self.assertEqual(inputs, before)

    def test_missing_evidence_blocks_every_perlifoc_output_comparison_and_quantity(self):
        missing = policy.Assessment('missing', error='Synthetic Perlifoc assessment is missing.')
        engine = self.direct_engine(row_inputs(), missing)
        for address in ('O10', 'P10', 'S10', 'T10'):
            self.assertEqual(engine.value('SCHEDULE', address), '')
        for address in ('B29', 'C29', 'D29', 'E29', 'F29', 'G29', 'H29', 'I29', 'J29'):
            self.assertEqual(engine.value('CALCULATOR', address), '')
        self.assertEqual(engine.value('SCHEDULE', 'V10'), 'ASSESSMENT DATA UNAVAILABLE')
        self.assertIn('Synthetic Perlifoc assessment is missing', engine.value('SCHEDULE', 'Y10'))

    def test_non_perlifoc_rows_retain_existing_engine_behavior(self):
        inputs = row_inputs(B='CAFCO 300')
        assessment = MonokoteAssessment('missing', error='Synthetic Monokote evidence missing.')
        baseline = MonokoteHollowEngine(source_model('steel_vermiculite'), inputs,
                                       approved_formula_overrides('steel_vermiculite'), assessment=assessment)
        engine = self.direct_engine(inputs)
        for sheet, addresses in [('SCHEDULE', ('N10', 'O10', 'P10', 'R10', 'S10', 'T10', 'V10', 'W10', 'X10', 'Y10')),
                                 ('CALCULATOR', ('H6', 'H9', 'G29', 'G30'))]:
            for address in addresses:
                with self.subTest(sheet=sheet, address=address):
                    self.assertEqual(engine.value(sheet, address), baseline.value(sheet, address))

    def test_application_session_cache_checks_fresh_evidence_and_renders_notes(self):
        inputs = row_inputs('H3', period=360)
        before = deepcopy(inputs)
        normalized, engine, _ = calculator_session('steel_vermiculite', inputs)
        expected = self.direct_engine(inputs).value('SCHEDULE', 'P10')
        self.assertEqual(engine.value('SCHEDULE', 'P10'), expected)
        self.assertEqual(normalized, before)
        sheet = calculate_worksheet('steel_vermiculite', inputs, 'CALCULATOR')
        self.assertNotIn('H23:N24', sheet['omitted_ranges'])
        self.assertIn('FC21278-01-1', engine.value('CALCULATOR', 'H23'))
        self.path.unlink()
        _, missing, _ = calculator_session('steel_vermiculite', inputs)
        self.assertIsNot(engine, missing)
        self.assertEqual(missing.value('SCHEDULE', 'P10'), '')
        self.assertEqual(missing.value('SCHEDULE', 'V10'), 'ASSESSMENT DATA UNAVAILABLE')
        self.assertEqual(inputs, before)

    def test_pdf_and_xlsx_keep_values_and_report_without_evidence_receipt(self):
        inputs = row_inputs('H3', period=360)
        expected = self.direct_engine(inputs).value('SCHEDULE', 'P10')
        data = project_calculator_report('steel_vermiculite', inputs)
        self.assertEqual(data['rows'][0]['values']['P'], expected)
        self.assertIn('FC21278-01-1', data['rows'][0]['assessment_source'])
        digest = sha256(self.payload).hexdigest()
        workbook = load_workbook(BytesIO(build_calculator_register('steel_vermiculite', inputs)))
        text = '\n'.join(str(cell.value) for sheet in workbook for row in sheet for cell in row)
        self.assertIn('FC21278-01-1', text)
        self.assertNotIn(digest, text)
        self.assertNotIn('Status', [cell.value for cell in workbook['Schedule'][5]])
        self.assertIn(expected, [cell.value for row in workbook['Schedule'] for cell in row])
        for build in (build_calculator_report, build_calculator_summary_report):
            pdf = PdfReader(BytesIO(build('steel_vermiculite', inputs)))
            text = '\n'.join(page.extract_text() for page in pdf.pages)
            self.assertIn('FC21278-01-1', text)
            self.assertNotIn(digest, text.replace('\n', ''))

    def test_mixed_reports_keep_internal_receipts_but_publish_report_only_and_fail_closed(self):
        from estimator import monokote_hollow as monokote
        from tests.test_monokote_hollow import synthetic_dataset as synthetic_monokote

        monokote_payload = encoded(synthetic_monokote())
        monokote_path = Path(self.folder.name) / monokote.DATASET_FILENAME
        monokote_path.write_bytes(monokote_payload)
        monokote_digest = sha256(monokote_payload).hexdigest()
        inputs = row_inputs('H3', period=360)
        inputs['SCHEDULE'].update({'A11': 'Independent Monokote line', 'B11': 'MONOKOTE MK-6 HY',
                                   'C11': 'Hollow - 4 sides', 'D11': 550, 'E11': 'Hp/A',
                                   'G11': 125, 'H11': 120, 'L11': 10})
        with patch.object(monokote, 'DATASET_SHA256', monokote_digest):
            for available in (True, False):
                if not available:
                    self.path.unlink()
                data = project_calculator_report('steel_vermiculite', inputs)
                evidence = {item['id']: item for item in data['assessment_evidences']}
                self.assertEqual(evidence[policy.DATASET_ID]['available'], available)
                self.assertTrue(evidence[monokote.DATASET_ID]['available'])
                self.assertEqual(data['rows'][0]['complete'], available)
                self.assertTrue(data['rows'][1]['complete'])
                self.assertEqual(data['rows'][1]['values']['P'], 41.94)
                workbook = load_workbook(BytesIO(build_calculator_register('steel_vermiculite', inputs)))
                text = '\n'.join(str(cell.value) for sheet in workbook for row in sheet for cell in row)
                self.assertEqual('FC21278-01-1' in text, available)
                self.assertIn('FAR4856', text)
                private_details = (monokote_digest, sha256(self.payload).hexdigest(), 'data is not installed')
                for detail in private_details:
                    self.assertNotIn(detail, text)
                for build in (build_calculator_report, build_calculator_summary_report):
                    pdf = PdfReader(BytesIO(build('steel_vermiculite', inputs)))
                    text = '\n'.join(page.extract_text() for page in pdf.pages).replace('\n', '')
                    self.assertEqual('FC21278-01-1' in text, available)
                    self.assertIn('FAR4856', text)
                    for detail in private_details:
                        self.assertNotIn(detail, text)

    def test_perlifoc_options_and_comparison_expose_all_periods_only_for_perlifoc(self):
        for product in ('PERLIFOC HP ECO+', 'CAFCO 300'):
            inputs = row_inputs(B=product)
            page = calculate_worksheet('steel_vermiculite', inputs, 'CALCULATOR')
            cells = {cell['address']: cell for row in page['rows'] for cell in row['cells']}
            options = page['option_sets'][cells['D12']['options_ref']]
            with self.subTest(product=product):
                # CAFCO uses FC13107-01-05's six printed periods; this fixture
                # selects 120, so no retained 15/45 value belongs in its choices.
                expected_periods = policy.PERIODS if product == 'PERLIFOC HP ECO+' else (30, 60, 90, 120, 180, 240)
                self.assertEqual(options, list(expected_periods))
                self.assertEqual(cells['D12']['value'], 120)
                if product == 'CAFCO 300':
                    self.assertNotIn(15, options)
                    self.assertNotIn(45, options)
                self.assertEqual([cells[f'{column}28']['value'] for column in 'BCDEFGHIJ'], list(policy.PERIODS))
                if product == 'PERLIFOC HP ECO+':
                    for omitted in ('J28:N30', 'B28:B30', 'D28:D30', 'H23:N24'):
                        self.assertNotIn(omitted, page['omitted_ranges'])
                    self.assertNotIn('J28:N30', page['merges'])
                    self.assertIn('K28:N30', page['omitted_ranges'])
                    self.assertIsInstance(cells['J29']['value'], int)
                else:
                    self.assertIn('J28:N30', page['omitted_ranges'])
            schedule = calculate_page('steel_vermiculite', inputs, 'SCHEDULE', start_row=10, row_count=1)
            period_cell = next(cell for row in schedule['rows'] for cell in row['cells'] if cell['address'] == 'H10')
            self.assertEqual(period_cell['options'], options)

    def test_settings_current_basis_and_last_schedule_row_preserve_immutable_package(self):
        package = policy.ROOT / 'data' / 'calculators' / 'steel_vermiculite.json.gz'
        self.assertEqual(sha256(package.read_bytes()).hexdigest(),
                         'd0b152c66eaffae4a9b6650ab2e59863410859d1f1f4bf280c48d4b09ec80d9a')
        engine = self.direct_engine(row_inputs('H3', period=360))
        self.assertIn('FC21278-01-1', engine.value('SETTINGS', 'A174'))
        self.assertIn('FC21278-01-1', engine.value('SETTINGS', 'D175'))
        self.assertNotIn('475', engine.value('SETTINGS', 'D187'))
        self.assertNotIn('Affected Perlifoc 120-minute entries use', engine.value('SETTINGS', 'D194'))
        self.assertEqual(engine.value('SETTINGS', 'F197'), 476)
        self.assertEqual(engine.value('SETTINGS', 'A198'), 'Hollow - 3 sides')
        self.assertIn('360', engine.value('SETTINGS', 'G198'))
        inputs = row_inputs('H3', period=360)
        inputs['SCHEDULE'] = {address[:-2] + '1009': value for address, value in inputs['SCHEDULE'].items()}
        last = self.direct_engine(inputs)
        self.assertEqual(last.value('SCHEDULE', 'P1009'), engine.value('SCHEDULE', 'P10'))
        self.assertEqual(last.value('SCHEDULE', 'S1009'), engine.value('SCHEDULE', 'S10'))
        self.assertIn('FC21278-01-1', last.value('SCHEDULE', 'X1009'))
        self.assertEqual(last.value('SCHEDULE', 'W1009'), 'QUANTIFIED - ESTIMATE')


if __name__ == '__main__':
    unittest.main()
