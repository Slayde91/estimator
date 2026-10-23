"""Invented source positions check independent readers and private-output guards."""

from copy import deepcopy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from scripts import import_firetex5090_assessment as importer


class PlumberPage:
    def __init__(self):
        self.words = [dict(text=str(temp), x0=145 + 43 * col, x1=160 + 43 * col,
                           top=101, bottom=110, non_stroking_color=(0,))
                      for col, temp in enumerate(importer.TEMPERATURES)]
        self.values = [[None, 4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800],
                       [4900, None, 200, 5000, 5100, 5200, 5300, 5400, None]]
        for row, factor in enumerate((55, 60)):
            self.words.append(dict(text=str(factor), x0=102, x1=112, top=113 + row * 12,
                                   bottom=122 + row * 12, non_stroking_color=(0,)))
            for col, value in enumerate(self.values[row]):
                token = '-' if value is None else '0.2' if value == 200 else f'{value / 1000:.3f}'
                self.words.append(dict(text=token, x0=141 + col * 43, x1=164 + col * 43,
                                       top=113 + row * 12, bottom=122 + row * 12,
                                       non_stroking_color=(0,)))

    def extract_words(self, **kwargs):
        return self.words

    def find_tables(self):
        return [SimpleNamespace(bbox=(82, 74, 540, 150))]


class PypdfPage:
    def __init__(self, values):
        self.chunks = [(str(temp), 145 + col * 43, 733)
                       for col, temp in enumerate(importer.TEMPERATURES)]
        for row, factor in enumerate((55, 60)):
            self.chunks.append((str(factor), 102, 721 - row * 12))
            for col, value in enumerate(values[row]):
                token = '-' if value is None else '0.2' if value == 200 else f'{value / 1000:.3f}'
                if (row, col) == (0, 1):
                    self.chunks.extend([(token[:-1], 141 + col * 43, 721 - row * 12),
                                        (token[-1], 158 + col * 43, 721 - row * 12)])
                else:
                    self.chunks.append((token, 141 + col * 43, 721 - row * 12))

    def extract_text(self, *, visitor_text):
        for token, x, y in self.chunks:
            visitor_text(token, [1., 0., 0., 1., 0., 0.], [1., 0., 0., 1., x, y], {}, 9.)


class Firetex5090ImporterTests(unittest.TestCase):
    def test_independent_readers_keep_every_dash_and_exact_decimal_precision(self):
        page = PlumberPage()
        self.assertEqual(importer.plumber_grid(page, (55, 60)), page.values)
        self.assertEqual(importer.pypdf_grid(PypdfPage(page.values), (55, 60)), page.values)
        self.assertEqual(importer.micrometres('0.207'), 207)
        self.assertEqual(importer.micrometres('0.2'), 200)
        self.assertIsNone(importer.micrometres('-'))
        for token in ('0.0001', 'NaN', '', '200'):
            with self.subTest(token=token), self.assertRaises(ValueError):
                importer.micrometres(token)

    def test_missing_duplicate_colored_and_displaced_cells_fail(self):
        for mutation in ('missing', 'duplicate', 'colored', 'displaced'):
            page = PlumberPage()
            if mutation == 'missing':
                page.words.pop()
            elif mutation == 'duplicate':
                page.words.append(deepcopy(page.words[-1]))
            elif mutation == 'colored':
                page.words[-1]['non_stroking_color'] = (1, 0, 0)
            else:
                page.words[-1]['top'] += 2
                page.words[-1]['bottom'] += 2
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                importer.plumber_grid(page, (55, 60))
        page = PypdfPage(PlumberPage().values)
        page.chunks.pop()
        with self.assertRaises(ValueError):
            importer.pypdf_grid(page, (55, 60))

    def test_source_case_axes_have_distinct_periods_and_endpoints(self):
        self.assertEqual(importer.source_case(1), ('R3', 15, tuple(range(55, 336, 5))))
        self.assertEqual(importer.source_case(22)[0:2], ('R4', 180))
        self.assertEqual(importer.source_case(23), ('H3', 15, tuple(range(50, 256, 5))))
        self.assertEqual(importer.source_case(31)[0:2], ('H3', 150))
        self.assertEqual(importer.source_case(40), ('H4', 120, tuple(range(40, 341, 5))))

    def test_source_identity_and_exclusive_output_fail_before_private_write(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            report = folder / 'invented.pdf'
            report.write_bytes(b'not the reviewed source')
            output = folder / 'private.json'
            with self.assertRaises(ValueError):
                importer.import_assessment(report, output)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix('.verification.json').exists())
            output.write_bytes(b'protected evidence')
            with self.assertRaises(FileExistsError):
                importer.import_assessment(report, output)
            self.assertEqual(output.read_bytes(), b'protected evidence')
            output.unlink()
            output.with_suffix('.verification.json').write_text('protected receipt', encoding='utf-8')
            with self.assertRaises(FileExistsError):
                importer.import_assessment(report, output)
            self.assertFalse(output.exists())
            with self.assertRaises(ValueError):
                importer.import_assessment(report, importer.ROOT / 'private-evidence.json')


if __name__ == '__main__':
    unittest.main()
