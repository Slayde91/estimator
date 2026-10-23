"""Invented-cell extraction and exclusive private-output contracts for FX6010."""
from contextlib import redirect_stdout
from copy import deepcopy
from hashlib import sha256
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from scripts import import_firetex6010_assessment as importer


TEMPERATURES = (350, 400, 450)
FACTORS = [50, 55]
TOKENS = [['-', '1.2', '-'], ['1.234', '-', '2.3']]


class TextPage:
    def __init__(self, tokens=None):
        self.tokens = deepcopy(TOKENS if tokens is None else tokens)

    def extract_text(self):
        return '\n'.join([
            'Table 1: FIRETEX FX6010 Invented beams: Fire Resistance Period 15 Minutes',
            'Thickness (mm) Required for a Design Temperature of',
            '350 400 450',
            *(str(factor) + ' ' + ' '.join(row) for factor, row in zip(FACTORS, self.tokens)),
            'Thickness is intumescent only.', 'Invented qualification retained.'])


class CoordinatePage:
    def __init__(self, tokens=None):
        tokens = TOKENS if tokens is None else tokens
        self.words = [self.word(str(value), 200 + 40 * c, 80) for c, value in enumerate(TEMPERATURES)]
        for r, (factor, row) in enumerate(zip(FACTORS, tokens)):
            self.words.append(self.word(str(factor), 150, 100 + 15 * r))
            self.words.extend(self.word(value, 200 + 40 * c, 100 + 15 * r) for c, value in enumerate(row))

    @staticmethod
    def word(text, x, y):
        return {'text': text, 'x0': x, 'x1': x + 20, 'top': y, 'bottom': y + 10,
                'non_stroking_color': (0,)}

    def extract_words(self, **kwargs):
        return self.words


class Firetex6010ImporterTests(unittest.TestCase):
    def invoke(self, report, output, receipt):
        argv = ['importer', '--report', str(report), '--output', str(output), '--receipt', str(receipt)]
        with patch('sys.argv', argv), redirect_stdout(io.StringIO()):
            importer.main()

    def synthetic_readers(self, report, *, tokens=None, coordinate_tokens=None, pages=47):
        text = TextPage(tokens)
        coordinates = CoordinatePage(coordinate_tokens if coordinate_tokens is not None else tokens)
        reader = SimpleNamespace(pages=[TextPage() for _ in range(pages)])
        reader.pages[1] = text
        plumber = MagicMock()
        plumber.__enter__.return_value = SimpleNamespace(pages=[coordinates for _ in range(47)])
        return (patch.object(importer, 'REPORT_SHA256', sha256(report.read_bytes()).hexdigest()),
                patch.object(importer, 'PdfReader', return_value=reader),
                patch.object(importer.pdfplumber, 'open', return_value=plumber),
                patch.object(importer, 'GROUPS', (('R3', 1, 1, 50, 55, TEMPERATURES),)),
                patch.object(importer, 'PERIODS', (15,)),
                patch.object(importer, 'authority_for', return_value=SimpleNamespace(
                    validate_assessment_payload=MagicMock())))

    def test_decimal_millimetres_convert_exactly_including_short_decimals_and_dash(self):
        for token, expected in {'0.001': 1, '0.010': 10, '1.2': 1200, '1.20': 1200,
                                '1.234': 1234, '8.214': 8214, '8': 8000, '-': None}.items():
            with self.subTest(token=token):
                self.assertEqual(importer.micrometres(token), expected)
        for token in ('0', '0.000', '-1.2', '1.2345', 'NaN', 'Infinity', '1e-3', '', '+1.2'):
            with self.subTest(token=token), self.assertRaises(ValueError):
                importer.micrometres(token)

    def test_independent_readers_keep_leading_internal_and_trailing_unavailable_cells(self):
        text, notes = importer.text_table(TextPage(), 1, FACTORS, TEMPERATURES, 15)
        coordinates, colours = importer.coordinate_table(CoordinatePage(), 1, FACTORS, TEMPERATURES)
        self.assertEqual(text, [[None, 1200, None], [1234, None, 2300]])
        self.assertEqual(coordinates, text)
        self.assertEqual(sum(colours.values()), 6)
        self.assertIn('Invented qualification retained.', notes['footnotes'])

    def test_text_reader_rejects_missing_cells_rows_and_wrong_source_axes(self):
        for page, table, factors, temperatures, period in (
                (TextPage([['-', '1.2'], TOKENS[1]]), 1, FACTORS, TEMPERATURES, 15),
                (TextPage([TOKENS[0]]), 1, FACTORS, TEMPERATURES, 15),
                (TextPage(), 2, FACTORS, TEMPERATURES, 15),
                (TextPage(), 1, FACTORS, (350, 400, 500), 15),
                (TextPage(), 1, FACTORS, TEMPERATURES, 20)):
            with self.subTest(table=table, factors=factors, temperatures=temperatures, period=period), self.assertRaises(ValueError):
                importer.text_table(page, table, factors, temperatures, period)

    def test_coordinate_reader_rejects_missing_duplicate_and_unmapped_cells(self):
        missing = CoordinatePage(); missing.words.pop(-1)
        duplicate = CoordinatePage(); duplicate.words.append(deepcopy(duplicate.words[-1]))
        extra = CoordinatePage(); extra.words.append(extra.word('1.234', 340, 100))
        header = CoordinatePage(); header.words.pop(0)
        for page in (missing, duplicate, extra, header):
            with self.subTest(words=page.words), self.assertRaises(ValueError):
                importer.coordinate_table(page, 1, FACTORS, TEMPERATURES)

    def test_wrong_report_bytes_are_rejected_before_either_reader_or_output(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(importer, 'PdfReader') as reader, \
                patch.object(importer.pdfplumber, 'open') as plumber:
            root = Path(folder); report = root / 'invented.pdf'; report.write_bytes(b'not the reviewed report')
            output, receipt = root / 'data.json', root / 'proof.json'
            with self.assertRaisesRegex(ValueError, 'reviewed FC21221'):
                self.invoke(report, output, receipt)
            reader.assert_not_called(); plumber.assert_not_called()
            self.assertFalse(output.exists()); self.assertFalse(receipt.exists())

    def test_wrong_page_count_and_reader_disagreement_never_publish_outputs(self):
        for pages, altered in ((46, None), (47, [['-', '1.201', '-'], TOKENS[1]])):
            with self.subTest(pages=pages), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); report = root / 'invented.pdf'; report.write_bytes(b'invented source')
                output, receipt = root / 'data.json', root / 'proof.json'
                patches = self.synthetic_readers(report, pages=pages, coordinate_tokens=altered)
                with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                    with self.assertRaises(ValueError):
                        self.invoke(report, output, receipt)
                self.assertFalse(output.exists()); self.assertFalse(receipt.exists())
                self.assertEqual(report.read_bytes(), b'invented source')

    def test_synthetic_output_is_deterministic_exact_and_does_not_fill_dashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); report = root / 'renamed-invented.pdf'; report.write_bytes(b'invented source')
            patches = self.synthetic_readers(report)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5] as authority:
                for prefix in ('first', 'second'):
                    self.invoke(report, root / f'{prefix}.json', root / f'{prefix}-proof.json')
            first, second = root / 'first.json', root / 'second.json'
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual((root / 'first-proof.json').read_bytes(), (root / 'second-proof.json').read_bytes())
            data = json.loads(first.read_bytes()); proof = json.loads((root / 'first-proof.json').read_bytes())
            self.assertEqual(data['source']['filename'], importer.REPORT_FILENAME)
            self.assertEqual(data['tables'][0]['dft_um'], [[None, 1200, None], [1234, None, 2300]])
            self.assertEqual(proof['positions_matched'], 6)
            self.assertEqual((proof['numeric'], proof['unavailable_dashes'], proof['mismatches']), (3, 3, 0))
            self.assertEqual(proof['dataset_sha256'], sha256(first.read_bytes()).hexdigest())
            self.assertNotIn('dft_um', proof)
            self.assertEqual(authority.call_args_list, [unittest.mock.call('FIRETEX FX6010')] * 2)
            self.assertEqual(authority.return_value.validate_assessment_payload.call_args_list,
                             [unittest.mock.call(first.read_bytes())] * 2)

    def test_one_bounded_payload_detaches_both_readers_from_later_source_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); report = root / 'invented.pdf'; original = b'invented source'
            report.write_bytes(original)
            patches = self.synthetic_readers(report)
            with patches[0], patches[1] as reader, patches[2] as plumber, patches[3], patches[4], patches[5]:
                reader_value, plumber_value = reader.return_value, plumber.return_value
                def mutate_after_capture(stream):
                    self.assertIsInstance(stream, io.BytesIO)
                    self.assertEqual(stream.getvalue(), original)
                    report.write_bytes(b'externally replaced after capture')
                    return reader_value
                def detached_second_reader(stream):
                    self.assertIsInstance(stream, io.BytesIO)
                    self.assertEqual(stream.getvalue(), original)
                    return plumber_value
                reader.side_effect = mutate_after_capture
                plumber.side_effect = detached_second_reader
                self.invoke(report, root / 'data.json', root / 'proof.json')
                reader.assert_called_once(); plumber.assert_called_once()
            self.assertEqual(json.loads((root / 'data.json').read_bytes())['source']['sha256'], sha256(original).hexdigest())
            self.assertEqual(report.read_bytes(), b'externally replaced after capture')

    def test_oversized_report_and_unapproved_final_bytes_never_publish_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); report = root / 'invented.pdf'; report.write_bytes(b'invented source')
            output, receipt = root / 'data.json', root / 'proof.json'
            with patch.object(importer, 'MAX_REPORT_BYTES', 3), patch.object(importer, 'PdfReader') as reader:
                with self.assertRaisesRegex(ValueError, 'bounded input'):
                    self.invoke(report, output, receipt)
                reader.assert_not_called()
            patches = self.synthetic_readers(report)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5] as authority:
                authority.return_value.validate_assessment_payload.side_effect = ValueError('unapproved output digest')
                with self.assertRaisesRegex(ValueError, 'unapproved output digest'):
                    self.invoke(report, output, receipt)
                authority.return_value.validate_assessment_payload.assert_called_once()
            self.assertFalse(output.exists()); self.assertFalse(receipt.exists())

    def test_existing_outputs_and_aliased_paths_are_never_overwritten(self):
        for scenario in ('output', 'receipt', 'same_output_receipt', 'report_output', 'report_receipt'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); report = root / 'invented.pdf'; report.write_bytes(b'preserved report')
                output, receipt = root / 'data.json', root / 'proof.json'
                if scenario in ('output', 'receipt'):
                    (output if scenario == 'output' else receipt).write_bytes(b'preserved existing evidence')
                elif scenario == 'same_output_receipt':
                    receipt = output
                elif scenario == 'report_output':
                    output = report
                else:
                    receipt = report
                before = {path: path.read_bytes() for path in (report, output, receipt) if path.exists()}
                with patch.object(importer, 'PdfReader') as reader, self.assertRaisesRegex(ValueError, 'distinct new files'):
                    self.invoke(report, output, receipt)
                reader.assert_not_called()
                self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_relative_paths_and_git_directory_or_worktree_file_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'absolute'):
            importer.require_external(Path('relative.json'), 'Output')
        for git_kind in ('directory', 'worktree_file'):
            with self.subTest(git_kind=git_kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); checkout = root / 'checkout'; checkout.mkdir()
                if git_kind == 'directory':
                    (checkout / '.git').mkdir()
                else:
                    (checkout / '.git').write_text('gitdir: invented-location', encoding='utf-8')
                for label in ('Report', 'Output', 'Receipt'):
                    with self.subTest(label=label), self.assertRaisesRegex(ValueError, 'outside the Git checkout'):
                        importer.require_external(checkout / 'nested' / 'private.json', label)
                allowed = root / 'outside.json'
                self.assertEqual(importer.require_external(allowed, 'Output'), allowed.resolve())
                self.assertFalse((checkout / 'nested').exists())


if __name__ == '__main__':
    unittest.main()
