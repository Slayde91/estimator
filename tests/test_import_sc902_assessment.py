"""Independent coordinate/exclusive private-output checks with invented cells."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from estimator import sc902_assessment as policy
from scripts import import_sc902_assessment as importer
from tests.test_sc902_assessment import synthetic_dataset


class SyntheticPlumberPage:
    def __init__(self, values, *, continuation=False):
        top = 101 if continuation else 76
        self.words = [{'text': str(t), 'x0': 200 + 40 * column, 'x1': 220 + 40 * column,
                       'top': top, 'bottom': top + 10, 'non_stroking_color': (0,)}
                      for column, t in enumerate(importer.TEMPERATURES)]
        for row, (factor, cells) in enumerate(values.items()):
            self.words.append({'text': str(factor), 'x0': 160, 'x1': 180,
                               'top': top + 14 + row * 12, 'bottom': top + 24 + row * 12,
                               'non_stroking_color': (0,)})
            for column, value in enumerate(cells):
                if value is not None:
                    self.words.append({'text': f'{value / 1000:.3f}',
                                       'x0': 197.5 + 40 * column, 'x1': 222.5 + 40 * column,
                                       'top': top + 14 + row * 12, 'bottom': top + 24 + row * 12,
                                       'non_stroking_color': (1, 0, 0) if (row, column) == (0, 0) else (0,)})

    def extract_words(self, **kwargs):
        return self.words

    def find_tables(self):
        return [SimpleNamespace(bbox=(150, 50, 710, 250))]


class SyntheticPypdfPage:
    def __init__(self, values, *, continuation=False, split_digit=False):
        baseline = 733 if continuation else 758
        self.chunks = [(str(t), 200 + 40 * column, baseline)
                       for column, t in enumerate(importer.TEMPERATURES)]
        for row, (factor, cells) in enumerate(values.items()):
            self.chunks.append((str(factor), 160, baseline - 14 - row * 12))
            for column, value in enumerate(cells):
                if value is not None:
                    text = f'{value / 1000:.3f}'
                    x, y = 195.8 + 40 * column, baseline - 14 - row * 12
                    if split_digit and (row, column) == (0, 0):
                        self.chunks.extend([(text[:-1], x, y), (text[-1], x + 19.44, y)])
                    else:
                        self.chunks.append((text, x, y))

    def extract_text(self, *, visitor_text):
        for text, x, y in self.chunks:
            visitor_text(text, [1., 0., 0., 1., 0., 0.], [1., 0., 0., 1., x, y], {}, 9.96)


class SC902ImporterTests(unittest.TestCase):
    def values(self):
        return {50: [2345, None, 2456, None, 2567, 2678, 2789, 2890, None, 2912, 3123, 3234],
                55: [None, 3345, 3456, 3567, 3678, 3789, None, 3890, 3912, 4123, 4234, None]}

    def test_independent_coordinates_preserve_leading_internal_and_trailing_blanks(self):
        values = self.values()
        for continuation in (False, True):
            with self.subTest(continuation=continuation):
                grid, red = importer.plumber_grid(SyntheticPlumberPage(values, continuation=continuation), importer.TEMPERATURES)
                other = importer.pypdf_grid(SyntheticPypdfPage(values, continuation=continuation, split_digit=True), importer.TEMPERATURES)
                self.assertEqual(grid, values)
                self.assertEqual(other, values)
                self.assertTrue(red[50][0])
                self.assertFalse(red[50][1])
                self.assertFalse(red[55][1])

    def test_duplicate_cells_ambiguous_positions_and_missing_headers_fail(self):
        values = self.values()
        page = SyntheticPlumberPage(values)
        page.words.append(deepcopy(next(w for w in page.words if w['text'] == '2.345')))
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            importer.plumber_grid(page, importer.TEMPERATURES)
        page = SyntheticPlumberPage(values)
        page.words.pop(0)
        with self.assertRaisesRegex(ValueError, 'header'):
            importer.plumber_grid(page, importer.TEMPERATURES)
        page = SyntheticPypdfPage(values)
        page.chunks.append(('2.345', 195.8, 744))
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            importer.pypdf_grid(page, importer.TEMPERATURES)
        page = SyntheticPypdfPage(values)
        page.chunks[0] = ('349', 200, 758)
        with self.assertRaisesRegex(ValueError, 'header'):
            importer.pypdf_grid(page, importer.TEMPERATURES)

    def test_unknown_text_color_and_non_micrometre_precision_fail(self):
        values = self.values()
        page = SyntheticPlumberPage(values)
        next(w for w in page.words if w['text'] == '2.345')['non_stroking_color'] = (0, 1, 0)
        with self.assertRaisesRegex(ValueError, 'color'):
            importer.plumber_grid(page, importer.TEMPERATURES)
        page = SyntheticPypdfPage(values)
        index = next(i for i, chunk in enumerate(page.chunks) if chunk[0] == '2.345')
        _, x, y = page.chunks[index]
        page.chunks[index] = ('2.3456', x, y)
        with self.assertRaisesRegex(ValueError, 'precision'):
            importer.pypdf_grid(page, importer.TEMPERATURES)

    def test_source_identity_is_checked_before_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'synthetic.pdf'
            path.write_bytes(b'unreviewed source')
            with self.assertRaisesRegex(ValueError, 'reviewed FC18580'):
                importer.extract_dataset(path)

    def test_output_is_private_bound_deterministic_and_never_overwritten(self):
        data = synthetic_dataset()
        payload = importer.encode(data)
        with tempfile.TemporaryDirectory() as folder, patch.object(importer, 'extract_dataset', return_value=data), \
                patch.object(policy, 'DATASET_SHA256', sha256(payload).hexdigest()):
            root = Path(folder)
            first, second = root / 'a/data.json', root / 'b/data.json'
            receipt = importer.import_assessment('explicit.pdf', first)
            other = importer.import_assessment('explicit.pdf', second)
            self.assertEqual(receipt, other)
            self.assertEqual(first.read_bytes(), payload)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(json.loads(first.with_suffix('.verification.json').read_text()), receipt)
            self.assertEqual(receipt['dataset_sha256'], sha256(payload).hexdigest())
            self.assertEqual(receipt['tables'], 32)
            self.assertEqual(receipt['table_pages'], 45)
            self.assertNotIn('dft_um', receipt)
            self.assertNotIn('factors', receipt)
            with self.assertRaises(FileExistsError):
                importer.import_assessment('explicit.pdf', first)
            with patch.object(importer, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, 'outside the repository'):
                    importer.import_assessment('explicit.pdf', root / 'no.json')
            with patch.object(policy, 'DATASET_SHA256', '0' * 64):
                with self.assertRaisesRegex(ValueError, 'digest'):
                    importer.import_assessment('explicit.pdf', root / 'unbound.json')
            self.assertFalse((root / 'unbound.json').exists())


if __name__ == '__main__':
    unittest.main()
