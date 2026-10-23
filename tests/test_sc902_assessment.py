"""SC902 policy checks use invented cells, never the private publisher matrix."""

from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator import sc902_assessment as policy


def synthetic_dataset():
    tables = []
    for case_index, case in enumerate(policy.CASES):
        for period_index, period in enumerate(policy.PERIODS):
            temperatures = policy.table_temperatures(case)
            factors = list(policy.table_factors(case, period))
            pages = policy.table_pages(case, period)
            row_pages = [pages[0] if row < 55 or len(pages) == 1 else pages[1]
                         for row in range(len(factors))]
            tables.append({'case': case, 'period_min': period,
                           'table': 3 + case_index * 8 + period_index,
                           'source_heading': policy.SOURCE_HEADINGS[case_index],
                           'temperatures_c': list(temperatures), 'pages': list(pages),
                           'factors': factors,
                           'dft_um': [[(case_index + 1) * 1000 + period_index * 100 + row * 10 + column
                                       for column in range(len(temperatures))]
                                      for row in range(len(factors))],
                           'red_applicable': [[False] * len(temperatures) for _ in factors],
                           'source_pages_by_row': row_pages, 'mesh_required': case == 'RHS'})
    return {'schema_version': 1, 'id': policy.DATASET_ID,
            'source': {'report': 'FC18580-01-01', 'date': '2024-03-20',
                       'sha256': policy.REPORT_SHA256,
                       'filename': 'FC18580-01-01-Nullifire-SC902-2020-REPORT-Final.pdf', 'pages': 53},
            'thickness_unit': 'micrometre',
            'source_table_unit': 'decimal millimetres; exact integer micrometres',
            'temperatures_c': list(policy.TEMPERATURES), 'periods_min': list(policy.PERIODS),
            'tables': tables}


def encoded(data):
    return (json.dumps(data, separators=(',', ':'), allow_nan=False) + '\n').encode()


class SC902AssessmentTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.data = synthetic_dataset()
        self.data['tables'][-1]['dft_um'][-1][-1] = None
        self.data['tables'][0]['red_applicable'][0][0] = True
        self.payload = encoded(self.data)
        self.path = Path(self.folder.name) / policy.DATASET_FILENAME
        self.path.write_bytes(self.payload)
        self.pin = patch.object(policy, 'DATASET_SHA256', sha256(self.payload).hexdigest())
        self.pin.start()
        self.addCleanup(self.pin.stop)
        env = patch.dict(os.environ, {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': self.folder.name})
        env.start()
        self.addCleanup(env.stop)

    def test_bound_snapshot_is_hashable_and_every_synthetic_address_is_preserved(self):
        assessment = policy.load_assessment()
        self.assertFalse(assessment.error)
        self.assertEqual(assessment.digest, sha256(self.payload).hexdigest())
        self.assertEqual(assessment.report_sha256, policy.REPORT_SHA256)
        self.assertEqual(len(assessment.tables), 32)
        self.assertIsInstance(hash(assessment), int)
        for table_index, item in enumerate(self.data['tables']):
            for row, factor in enumerate(item['factors']):
                for column, temperature in enumerate(item['temperatures_c']):
                    result = policy.lookup(assessment, factor, temperature, item['period_min'], case=item['case'])
                    self.assertEqual(result['dft'], item['dft_um'][row][column], (table_index, row, column))
                    self.assertEqual(result['factor'], factor)
                    self.assertIn(f"p{item['source_pages_by_row'][row]} Table {item['table']}", result['source'])
                    self.assertEqual('NP - NOT PUBLISHED' if result['dft'] is None else 'PUBLISHED - ASSESSMENT TABLE', result['status'])

    def test_factor_ceil_temperature_floor_and_lower_bound_are_explicit(self):
        assessment = policy.load_assessment()
        for case in policy.CASES:
            minimum = 40 if case == 'CHS' else 50
            exact = policy.lookup(assessment, minimum, 500, 60, case=case)
            below = policy.lookup(assessment, minimum - 1, 519, 60, case=case)
            self.assertEqual(exact['dft'], below['dft'])
            self.assertEqual(below['factor'], minimum)
            self.assertIn('minimum published row', below['note'])
            self.assertIn('lower published temperature', below['note'])
            next_row = policy.lookup(assessment, minimum + 5, 500, 60, case=case)
            between = policy.lookup(assessment, minimum + .01, 549, 60, case=case)
            selected_temp = 520 if case in ('RHS', 'CHS') else 500
            expected = policy.lookup(assessment, minimum + 5, selected_temp, 60, case=case)
            self.assertEqual(expected['dft'], between['dft'])
            self.assertEqual(between['factor'], minimum + 5)
            self.assertEqual(between['status'], 'ESTIMATE - CONSERVATIVE ASSESSMENT')
            self.assertIn('next higher published row', between['note'])
            self.assertGreater(next_row['dft'], exact['dft'])

    def test_blank_cell_stays_blank_after_conservative_selection(self):
        result = policy.lookup(policy.load_assessment(), 174.1, 750, 120, case='CHS')
        self.assertIsNone(result['dft'])
        self.assertEqual(result['status'], 'NP - NOT PUBLISHED')
        self.assertEqual(result['factor'], 175)
        self.assertIn('blank', result['note'])

    def test_red_value_is_allowed_and_mesh_requirement_and_units_are_reported(self):
        assessment = policy.load_assessment()
        red = policy.lookup(assessment, 50, 350, 15)
        self.assertEqual(red['dft'], 1000)
        self.assertIn('red printed value is expressly applicable', red['note'])
        self.assertIn('1 mm = 1000 µm DFT', red['source'])
        self.assertIn('converted exactly', red['note'])
        rhs = policy.lookup(assessment, 50, 520, 120, case='RHS')
        self.assertIn('Mesh is required', rhs['note'])
        self.assertNotIn('Mesh is required', policy.lookup(assessment, 40, 520, 120, case='CHS')['note'])

    def test_invalid_or_outside_inputs_never_return_thickness(self):
        assessment = policy.load_assessment()
        cases = [dict(case='H3'), dict(case='H4'), dict(temperature=349.99), dict(temperature=750.01),
                 dict(temperature=True), dict(temperature=float('nan')), dict(period=180), dict(period=360),
                 dict(period=59.99), dict(period=True), dict(factor=0), dict(factor=-1),
                 dict(factor=True), dict(factor=float('inf')), dict(factor='50')]
        for changes in cases:
            args = {'factor': 50, 'temperature': 550, 'period': 60, 'case': 'R3'} | changes
            with self.subTest(changes=changes):
                self.assertIsNone(policy.lookup(assessment, **args)['dft'])
        for case in policy.CASES:
            maximum = policy.table_factors(case, 120)[-1]
            self.assertIsNone(policy.lookup(assessment, maximum + .01, 750, 120, case=case)['dft'])
        self.assertIsNone(policy.lookup(policy.Assessment('missing', error='Missing'), 50, 550, 60)['dft'])

    def test_live_bytes_are_read_fresh_and_invalid_source_never_falls_back(self):
        self.assertFalse(policy.load_assessment().error)
        self.path.write_bytes(self.payload.replace(b'1000', b'1001', 1))
        self.assertEqual(policy.load_assessment().digest, 'invalid')
        self.path.unlink()
        self.assertEqual(policy.load_assessment().digest, 'missing')
        self.path.mkdir()
        self.assertEqual(policy.load_assessment().digest, 'invalid')

    def test_rehashed_but_malformed_payloads_fail_the_independent_schema_gate(self):
        changes = [lambda d: d.update(thickness_unit='mm'),
                   lambda d: d['source'].update(date='2020-01-01'),
                   lambda d: d['source'].update(sha256='0' * 64),
                   lambda d: d['source'].update(pages=52),
                   lambda d: d['temperatures_c'].reverse(),
                   lambda d: d['temperatures_c'].__setitem__(0, 350.0),
                   lambda d: d['periods_min'].append(180),
                   lambda d: d['tables'].pop(),
                   lambda d: d['tables'][0].update(case='R4'),
                   lambda d: d['tables'][0].update(table=4),
                   lambda d: d['tables'][0].update(pages=[10]),
                   lambda d: d['tables'][0].update(source_heading='Other'),
                   lambda d: d['tables'][0]['temperatures_c'].insert(4, 520),
                   lambda d: d['tables'][0]['factors'].pop(1),
                   lambda d: d['tables'][-1]['factors'].append(180),
                   lambda d: d['tables'][0]['source_pages_by_row'].__setitem__(0, 10),
                   lambda d: d['tables'][0]['dft_um'][0].__setitem__(0, True),
                   lambda d: d['tables'][0]['dft_um'][0].__setitem__(0, 1.5),
                   lambda d: d['tables'][0]['dft_um'][0].__setitem__(0, 0),
                   lambda d: d['tables'][0]['dft_um'][0].__setitem__(0, None),
                   lambda d: d['tables'][0]['red_applicable'][0].__setitem__(0, 1),
                   lambda d: d['tables'][16].update(mesh_required=False)]
        for index, change in enumerate(changes):
            data = deepcopy(self.data)
            change(data)
            payload = encoded(data)
            with self.subTest(index=index), patch.object(policy, 'DATASET_SHA256', sha256(payload).hexdigest()):
                with self.assertRaises(ValueError):
                    policy.validate_assessment_payload(payload)
        with self.assertRaises(ValueError):
            policy.validate_assessment_payload(b' ' * (policy.MAX_DATASET_BYTES + 1))
        with self.assertRaises(ValueError):
            policy.validate_assessment_payload('not bytes')

    def test_relative_and_source_checkout_evidence_overrides_are_rejected(self):
        for folder in ('calculator-evidence', str(policy.ROOT / 'calculator-evidence')):
            with self.subTest(folder=folder), patch.dict(os.environ, {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': folder}):
                self.assertEqual(policy.load_assessment().digest, 'invalid')


if __name__ == '__main__':
    unittest.main()
