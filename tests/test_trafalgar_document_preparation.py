"""Source preservation and complete page rendering for the optional import tool."""

import hashlib
from importlib.util import find_spec
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from reportlab.pdfgen.canvas import Canvas

from scripts.prepare_trafalgar_documents import prepare, safe_archive_files


class TrafalgarDocumentPreparationTests(unittest.TestCase):
    def test_archive_paths_cannot_escape_output(self):
        payload = BytesIO()
        with ZipFile(payload, "w") as archive:
            archive.writestr("../D-test.pdf", b"unsafe")
        with ZipFile(BytesIO(payload.getvalue())) as archive:
            with self.assertRaisesRegex(ValueError, "Unsafe archive"):
                safe_archive_files(archive)

    def test_duplicate_document_ids_fail_before_extraction(self):
        payload = BytesIO()
        with ZipFile(payload, "w") as archive:
            archive.writestr("one/D-test.pdf", b"a")
            archive.writestr("two/D-test.jpg", b"b")
        with ZipFile(BytesIO(payload.getvalue())) as archive:
            with self.assertRaisesRegex(ValueError, "Duplicate document"):
                safe_archive_files(archive)

    @unittest.skipUnless(find_spec("pymupdf"), "Optional diagram rendering dependency unavailable")
    def test_every_pdf_page_rendered_original_retained_and_missing_source_accounted_for(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stream = BytesIO()
            canvas = Canvas(stream, pagesize=(400, 250))
            for label in ("First installation view", "Second service table"):
                canvas.drawString(25, 200, label)
                canvas.showPage()
            canvas.save()
            pdf = stream.getvalue()
            digest = hashlib.sha256(pdf).hexdigest()
            source = root / "source.zip"
            with ZipFile(source, "w") as archive:
                archive.writestr("documents/D-first.pdf", pdf)
            before = source.read_bytes()
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"metadata": {"source_capture_sha256": "a" * 64},
                "documents": [{"document_id": "D-first", "source_url": "https://example.com/one",
                               "file_sha256": digest, "content_bytes": len(pdf)},
                              {"document_id": "D-missing", "source_url": "https://example.com/missing"}]}))
            counts = prepare(source, manifest, root / "prepared", long_edge=1600)
            self.assertEqual(counts["rendered_pages"], 2)
            self.assertEqual(counts["missing_documents"], 1)
            index = json.loads((root / "prepared/documents-index.json").read_text())
            first = index["documents"][0]
            self.assertEqual((root / "prepared" / first["pdf_filename"]).read_bytes(), pdf)
            self.assertIn("First installation view", first["pages"][0]["text"])
            self.assertIn("Second service table", first["pages"][1]["text"])
            self.assertEqual([p["page"] for p in first["pages"]], [1, 2])
            for page in first["pages"]:
                image = (root / "prepared" / page["image_filename"]).read_bytes()
                self.assertEqual(hashlib.sha256(image).hexdigest(), page["image_sha256"])
            self.assertEqual(source.read_bytes(), before)
            prepare(source, manifest, root / "prepared", long_edge=1600)
            self.assertEqual(json.loads((root / "prepared/documents-index.json").read_text()), index)
            data = json.loads(manifest.read_text())
            data["documents"][0]["file_sha256"] = "0" * 64
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
                prepare(source, manifest, root / "bad", long_edge=1600)


if __name__ == "__main__":
    unittest.main()
