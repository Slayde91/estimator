"""Invented cells exercise selection and integrity without distributing publisher data."""
from dataclasses import replace
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator import firetex_assessment as policy


def fixture(authority):
    return {'schema_version': 1, 'id': authority.DATASET_ID, 'product': authority.product,
            'source': dict(report=authority.report, date=authority.date, sha256=authority.REPORT_SHA256,
                           filename=authority.filename, pages=authority.page_count),
            'thickness_unit': 'micrometre', 'tables': [
                dict(case='R3', period_min=60, table=1, pages=[2], factors=[50, 55],
                     temperatures_c=[350, 550, 750], dft_um=[[1000, 900, 800], [1100, 1000, None]]),
                dict(case='R4', period_min=60, table=2, pages=[3], factors=[50, 55, 60],
                     temperatures_c=[350, 550, 750], dft_um=[[6000, 1000, 900]] * 3),
                dict(case='H3', period_min=60, table=3, pages=[4], factors=[40, 45],
                     temperatures_c=[350, 550, 750], dft_um=[[1200, 1000, 900]] * 2),
                dict(case='H4', period_min=60, table=4, pages=[5], factors=[40, 45, 50],
                     temperatures_c=[350, 550, 750], dft_um=[[6000, 1000, 900]] * 3)]}


class FiretexAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.authority = replace(policy.AUTHORITIES[0], table_count=4)
        self.data = fixture(self.authority)
        self.bind(self.data)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': self.folder.name}).start()

    def bind(self, data):
        payload = (json.dumps(data, separators=(',', ':')) + '\n').encode()
        self.authority = replace(self.authority, DATASET_SHA256=sha256(payload).hexdigest())
        self.path = Path(self.folder.name) / self.authority.DATASET_FILENAME
        self.path.write_bytes(payload)

    def lookup(self, factor=50, temp=550, period=60, case='R3'):
        with patch.object(policy, 'AUTHORITIES', (self.authority,)):
            return policy.lookup(policy.load_assessment(self.authority), factor, temp, period, case=case)

    def test_exact_cells_blanks_and_bounded_conservative_selection(self):
        self.assertEqual(self.lookup()['dft'], 900)
        self.assertEqual(self.lookup(50.01, 550)['dft'], 1000)
        self.assertEqual(self.lookup(50.01, 550)['factor'], 55)
        self.assertIn('CONSERVATIVE', self.lookup(50.01, 550)['status'])
        self.assertIn('NOT TABULATED', self.lookup(50, 580)['status'])
        self.assertIn('Table 1', self.lookup()['source'])
        self.assertIsNone(self.lookup(55, 750)['dft'])
        self.assertIn('NOT PUBLISHED', self.lookup(55, 750)['status'])
        for factor, temp, period in [(49, 550, 60), (56, 550, 60), (50, 349, 60),
                                     (50, 751, 60), (50, 550, 61), (True, 550, 60)]:
            with self.subTest(factor=factor, temp=temp, period=period):
                self.assertIsNone(self.lookup(factor, temp, period)['dft'])

    def test_four_sided_beams_enforce_both_cap_and_beam_factor_range(self):
        self.assertEqual(self.lookup(50, 350, case='R4C')['dft'], 6000)
        self.assertIn('THICKNESS LIMIT', self.lookup(50, 350, case='R4B')['status'])
        self.assertEqual(self.lookup(50, 550, case='R4B')['dft'], 1000)
        self.assertIn('FACTOR OUT', self.lookup(60, 550, case='R4B')['status'])
        self.assertIn('THICKNESS LIMIT', self.lookup(40, 350, case='H4B')['status'])
        self.assertEqual(self.lookup(45, 550, case='H4B')['dft'], 1000)
        self.assertIsNone(self.lookup(50, 550, case='H4B')['dft'])
        self.assertEqual(self.lookup(50, 550, case='CHS')['dft'], 1000)

    def test_changed_missing_oversized_and_redirected_sources_never_use_cached_cells(self):
        snapshot = policy.load_assessment(self.authority)
        self.assertIsInstance(hash(snapshot), int)
        self.assertFalse(snapshot.error)
        self.path.write_bytes(self.path.read_bytes().replace(b'1000', b'1001'))
        self.assertEqual(policy.load_assessment(self.authority).digest, 'invalid')
        self.path.write_bytes(b'x' * (self.authority.MAX_DATASET_BYTES + 1))
        self.assertEqual(policy.load_assessment(self.authority).digest, 'invalid')
        self.path.unlink()
        self.assertEqual(policy.load_assessment(self.authority).digest, 'missing')
        with patch.dict(os.environ, {'CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY': 'relative-evidence'}):
            self.assertEqual(policy.load_assessment(self.authority).digest, 'invalid')

    def test_beam_transfer_does_not_extend_below_the_beam_cover_range(self):
        data = fixture(self.authority)
        data['tables'][2]['factors'] = [45, 50]
        self.bind(data)
        self.assertIsNone(self.lookup(40, 550, case='H4B')['dft'])
        self.assertIsNone(self.lookup(44.99, 550, case='H4B')['dft'])
        self.assertEqual(self.lookup(45, 550, case='H4B')['dft'], 1000)

    def test_source_units_axes_and_cell_types_are_validated_after_digest(self):
        edits = [lambda d: d.update(thickness_unit='millimetre'),
                 lambda d: d['source'].update(report='another-report'),
                 lambda d: d['tables'][0].update(factors=[50, 60]),
                 lambda d: d['tables'][0]['dft_um'][0].__setitem__(0, True),
                 lambda d: d['tables'][0]['dft_um'][0].pop()]
        for edit in edits:
            data = fixture(self.authority)
            edit(data)
            self.bind(data)
            self.assertEqual(policy.load_assessment(self.authority).digest, 'invalid')


if __name__ == '__main__':
    unittest.main()
