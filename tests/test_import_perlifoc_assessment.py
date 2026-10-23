"""Synthetic extraction and private-output checks; no publisher matrix fixtures."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import import_perlifoc_assessment as importer


class SyntheticPage:
    def __init__(self, values):
        self.columns = [[{'text': '≤68' if factor == 68 else str(factor),
                          'top': i * 12, 'bottom': i * 12 + 8}
                         for i, factor in enumerate(importer.FACTORS)]]
        self.columns += [[{'text': str(row[j]), 'top': i * 12, 'bottom': i * 12 + 8}
                           for i, row in enumerate(values) if row[j] is not None]
                          for j in range(len(importer.PERIODS))]

    def find_tables(self):
        return [SimpleNamespace(rows=[SimpleNamespace(cells=list(range(10)))])]

    def crop(self, box):
        return SimpleNamespace(extract_words=lambda: self.columns[box])


class PerlifocImporterTests(unittest.TestCase):
    def values(self):
        return [[10 + j if j < 7 else None for j in range(9)] for _ in importer.FACTORS]

    def text(self, values):
        return '\n'.join(('≤68' if factor == 68 else str(factor)) + ' '
                         + ' '.join(str(value) for value in row if value is not None)
                         for factor, row in zip(importer.FACTORS, values))

    def test_two_independent_extractors_match_every_synthetic_position(self):
        values = self.values()
        self.assertEqual(importer._coordinate_values(SyntheticPage(values)), values)
        self.assertEqual(importer._text_values(self.text(values)), values)

    def test_coordinates_preserve_internal_blanks_and_expose_text_disagreement(self):
        values = self.values()
        values[12][3] = None
        coordinate = importer._coordinate_values(SyntheticPage(values))
        self.assertEqual(coordinate, values)
        self.assertNotEqual(importer._text_values(self.text(values)), coordinate)

    def test_missing_rows_duplicate_rows_and_ambiguous_numeric_positions_fail(self):
        values = self.values()
        text = self.text(values)
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            importer._text_values('\n'.join(text.splitlines()[1:]))
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            importer._text_values(text + '\n' + text.splitlines()[0])
        page = SyntheticPage(values)
        page.columns[1].append(deepcopy(page.columns[1][0]))
        with self.assertRaisesRegex(ValueError, 'unambiguously'):
            importer._coordinate_values(page)

    def test_source_identity_gate_rejects_unreviewed_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'synthetic.pdf'
            path.write_bytes(b'unreviewed source')
            with self.assertRaisesRegex(ValueError, 'reviewed FC21278'):
                importer.extract_dataset(path)

    def test_output_is_explicit_private_deterministic_and_never_overwritten(self):
        values = self.values()
        data = {'schema_version': 1, 'id': importer.DATASET_ID,
                'source': {'sha256': importer.REPORT_SHA256},
                'tables': [{'values': values}]}
        with tempfile.TemporaryDirectory() as folder, patch.object(importer, 'extract_dataset', return_value=data):
            root = Path(folder)
            first, second = root / 'a/data.json', root / 'b/data.json'
            receipt = importer.import_assessment('explicit.pdf', first)
            other = importer.import_assessment('explicit.pdf', second)
            self.assertEqual(receipt, other)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(sha256(first.read_bytes()).hexdigest(), receipt['dataset_sha256'])
            self.assertEqual(json.loads(first.with_suffix('.verification.json').read_text()), receipt)
            with self.assertRaises(FileExistsError):
                importer.import_assessment('explicit.pdf', first)
            self.assertEqual(json.loads(first.read_text()), data)
            with patch.object(importer, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, 'outside the repository'):
                    importer.import_assessment('explicit.pdf', root / 'no.json')


if __name__ == '__main__':
    unittest.main()
