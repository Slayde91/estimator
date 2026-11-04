"""A locked advisory progress file must not discard a valid drawing export."""
from contextlib import nullcontext
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.takeoff_markup_pdf_worker import render_batch


class MarkupProgressTests(unittest.TestCase):
    def test_windows_read_lock_keeps_atomic_progress_and_complete_pdf(self):
        for denied_updates in (1, 2):
            with self.subTest(denied_updates=denied_updates), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary); progress = folder / 'progress.json'; output = folder / 'out.pdf'
                progress.write_text(json.dumps({'completed': 0, 'total': 2}), encoding='utf-8')
                updates = []; attempts = 0; replace = Path.replace

                def locked_replace(source, target):
                    nonlocal attempts
                    attempts += 1
                    if attempts <= denied_updates:
                        error = PermissionError('Windows reader holds the previous progress file')
                        error.winerror = 32
                        raise error
                    return replace(source, target)

                def render(source, spec, destination, *, writer, progress):
                    for _ in spec['selected_pages']:
                        writer.add_blank_page(width=100, height=100)
                        progress()
                        updates.append(json.loads((folder / 'progress.json').read_bytes()))

                with patch('estimator.takeoff_markup_pdf_worker._verified_source', return_value=nullcontext(BytesIO(b'original'))), \
                        patch('estimator.takeoff_markup_pdf_worker.render_document', side_effect=render), \
                        patch.object(Path, 'replace', locked_replace):
                    render_batch({'copies': [{'source': 'original.pdf', 'spec': {'selected_pages': [1, 2]}}]}, output, progress)
                self.assertEqual(attempts, denied_updates + 2)
                self.assertEqual(updates[0], {'completed': 1, 'total': 2})
                self.assertEqual(updates[1], {'completed': 2, 'total': 2})
                self.assertEqual(len(PdfReader(output, strict=True).pages), 2)

    def test_other_progress_io_errors_still_fail_the_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)

            def render(source, spec, destination, *, writer, progress):
                writer.add_blank_page(width=100, height=100)
                progress()

            with patch('estimator.takeoff_markup_pdf_worker._verified_source', return_value=nullcontext(BytesIO(b'original'))), \
                    patch('estimator.takeoff_markup_pdf_worker.render_document', side_effect=render), \
                    patch.object(Path, 'replace', side_effect=OSError('Disk is full')), \
                    self.assertRaisesRegex(OSError, 'Disk is full'):
                render_batch({'copies': [{'source': 'original.pdf', 'spec': {'selected_pages': [1]}}]}, folder / 'out.pdf', folder / 'progress.json')
            self.assertFalse((folder / 'out.pdf').exists())
