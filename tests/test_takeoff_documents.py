"""Retained source identity, upload isolation and portable evidence regression tests."""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

from pypdf import PdfWriter
from pypdf.generic import FloatObject, NameObject, RectangleObject

from estimator.catalog import ValidationError
from estimator.takeoff_documents import TakeoffDocuments, CHUNK_SIZE, MAX_DOCUMENT_SIZE
from estimator import takeoff_pdf_worker


def pdf_bytes(*, pages=1, rotated=False, encrypted=False, title=None):
    writer = PdfWriter()
    if title is not None:
        writer.add_metadata({"/Title": title})
    for _ in range(pages):
        page = writer.add_blank_page(width=612, height=792)
        if rotated:
            page.cropbox = RectangleObject([12, 24, 600, 770])
            page.rotate(90)
            page[NameObject("/UserUnit")] = FloatObject(2)
    if encrypted:
        writer.encrypt("secret")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class TakeoffDocumentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = TakeoffDocuments(self.root / "cache")
        self.addCleanup(self.store.close)
        self.owner = "opaque-window-capability"

    def upload(self, payload=None, name="source.pdf", owner=None):
        payload = pdf_bytes() if payload is None else payload
        owner = owner or self.owner
        upload = self.store.begin_upload(owner, name, len(payload), hashlib.sha256(payload).hexdigest())
        for offset in range(0, len(payload), CHUNK_SIZE):
            self.store.write_chunk(owner, upload["upload_id"], offset, payload[offset:offset + CHUNK_SIZE])
        return self.store.finish_upload(owner, upload["upload_id"])

    def snapshot(self, documents):
        return {"version": 1, "project_id": str(uuid.uuid4()), "revision": 0,
                "documents": documents, "items": [], "calibrations": [], "transfers": [], "render_checks": [], "audit_head": None}

    def test_original_exact_bytes_and_pdf_geometry_survive_restart(self):
        original = pdf_bytes(rotated=True)
        document = self.upload(original)
        self.assertEqual(self.store.document_path(document).read_bytes(), original)
        page = document["pages"][0]
        self.assertEqual(page["view"], [12, 24, 600, 770])
        self.assertEqual((page["width"], page["height"], page["rotation"], page["user_unit"]), (588, 746, 90, 2))
        restarted = TakeoffDocuments(self.root / "cache")
        self.assertEqual(restarted.validate_project_documents([document]), [])
        self.assertEqual(document["sha256"], hashlib.sha256(original).hexdigest())

    def test_owner_offset_retry_and_finalization_are_explicit(self):
        original = pdf_bytes()
        identifier = self.store.begin_upload(self.owner, "plan.pdf", len(original))["upload_id"]
        with self.assertRaises(ValidationError):
            self.store.write_chunk("another-window", identifier, 0, original)
        with self.assertRaises(ValidationError):
            self.store.finish_upload(self.owner, identifier)
        with self.assertRaises(ValidationError):
            self.store.write_chunk(self.owner, identifier, 1, original[:10])
        result = self.store.write_chunk(self.owner, identifier, 0, original[:100])
        self.assertEqual(result["offset"], 100)
        self.assertEqual(self.store.write_chunk(self.owner, identifier, 0, original[:100]), result)
        with self.assertRaises(ValidationError):
            self.store.write_chunk(self.owner, identifier, 0, b"x" * 100)
        self.store.write_chunk(self.owner, identifier, 100, original[100:])
        first = self.store.finish_upload(self.owner, identifier)
        self.assertEqual(self.store.finish_upload(self.owner, identifier), first)

    def test_bad_names_sizes_chunks_and_hashes_never_publish_an_original(self):
        for filename in ("../source.pdf", "C:\\source.pdf", "CON.pdf", "document.exe", "quote\r\n.pdf"):
            with self.subTest(filename=filename), self.assertRaises(ValidationError):
                self.store.begin_upload(self.owner, filename, 10)
        for size in (True, 0, -1, MAX_DOCUMENT_SIZE + 1):
            with self.subTest(size=size), self.assertRaises(ValidationError):
                self.store.begin_upload(self.owner, "valid.pdf", size)
        original = pdf_bytes()
        identifier = self.store.begin_upload(self.owner, "valid.pdf", len(original), "0" * 64)["upload_id"]
        with self.assertRaises(ValidationError):
            self.store.write_chunk(self.owner, identifier, 0, b"x" * (CHUNK_SIZE + 1))
        self.store.write_chunk(self.owner, identifier, 0, original)
        with self.assertRaisesRegex(ValidationError, "declared hash"):
            self.store.finish_upload(self.owner, identifier)
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])

    def test_encrypted_malformed_and_oversized_page_sets_fail_closed(self):
        for payload in (b"%PDF-not-a-document", pdf_bytes(encrypted=True)):
            with self.subTest(payload=payload[:20]), self.assertRaises(ValidationError):
                self.upload(payload)
        with patch("estimator.takeoff_documents.MAX_PROJECT_PAGES", 1), self.assertRaises(ValidationError):
            self.upload(pdf_bytes(pages=2))
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])

    def test_parser_timeout_and_failed_resource_isolation_do_not_accept_pdf(self):
        with patch("estimator.takeoff_documents.subprocess.run", side_effect=subprocess.TimeoutExpired("parser", 40)):
            with self.assertRaisesRegex(ValidationError, "time limit"):
                self.upload()
        with patch.object(takeoff_pdf_worker, "restrict_process", side_effect=RuntimeError("limits unavailable")), \
             patch.object(takeoff_pdf_worker, "parse_pdf") as parser, \
             patch("sys.stdout", new_callable=lambda: __import__("io").StringIO()) as output:
            takeoff_pdf_worker.main()
            parser.assert_not_called()
            self.assertEqual(json.loads(output.getvalue()), {"error": "limits unavailable"})
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])

    def test_real_parser_timeout_terminates_and_reaps_child_without_publishing(self):
        original = pdf_bytes()
        identifier = self.store.begin_upload(self.owner, "timeout.pdf", len(original))["upload_id"]
        self.store.write_chunk(self.owner, identifier, 0, original)
        processes = []
        real_popen = subprocess.Popen

        def observe_child(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        # Keep the real subprocess.run/Popen execution and cleanup path. This
        # deadline expires during child startup, without a slow hostile PDF.
        with patch("estimator.takeoff_documents.PARSER_TIMEOUT", 0.0001), \
             patch("estimator.takeoff_documents.subprocess.Popen", side_effect=observe_child):
            with self.assertRaisesRegex(ValidationError, "exceeded its time limit"):
                self.store.finish_upload(self.owner, identifier)
        self.assertEqual(len(processes), 1)
        process = processes[0]
        self.assertEqual(Path(process.args[2]).name, "takeoff_pdf_worker.py")
        self.assertIsNotNone(process.poll(), "The actual parser child is still running")
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(process.wait(timeout=0), process.returncode)
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])
        self.assertEqual(self.store._parsed, {})
        self.assertFalse(self.store._uploads[identifier]["finishing"])

    def test_session_document_page_and_free_space_limits(self):
        with patch("estimator.takeoff_documents.MAX_DOCUMENTS", 1):
            self.upload()
            with self.assertRaisesRegex(ValidationError, "100 PDFs"):
                self.store.begin_upload(self.owner, "next.pdf", 10)
        with patch("estimator.takeoff_documents.MAX_PROJECT_PAGES", 1), self.assertRaisesRegex(ValidationError, "2,000 pages"):
            self.upload()
        with patch("estimator.takeoff_documents.shutil.disk_usage") as disk:
            disk.return_value.free = 0
            with self.assertRaisesRegex(ValidationError, "disk space"):
                self.store.begin_upload("new-owner", "next.pdf", 10)

    def test_cancel_is_owner_scoped_and_does_not_delete_completed_original(self):
        identifier = self.store.begin_upload(self.owner, "cancel.pdf", 10)["upload_id"]
        with self.assertRaises(ValidationError):
            self.store.cancel_upload("other", identifier)
        self.store.cancel_upload(self.owner, identifier)
        self.assertEqual(list((self.store.root / "uploads").iterdir()), [])
        document = self.upload()
        identifier = next(iter(self.store._uploads))
        self.store.cancel_upload(self.owner, identifier)
        self.assertTrue(self.store.document_path(document).exists())

    def test_changed_staging_bytes_without_client_hash_cannot_be_accepted(self):
        original = pdf_bytes()
        identifier = self.store.begin_upload(self.owner, "source.pdf", len(original))["upload_id"]
        self.store.write_chunk(self.owner, identifier, 0, original)
        path = self.store._uploads[identifier]["path"]
        path.write_bytes(original.replace(b"612", b"613"))
        with self.assertRaisesRegex(ValidationError, "uploaded chunks"):
            self.store.finish_upload(self.owner, identifier)
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])

    def test_cancel_does_not_remove_a_replacement_file(self):
        identifier = self.store.begin_upload(self.owner, "source.pdf", 10)["upload_id"]
        path = self.store._uploads[identifier]["path"]
        original = self.root / "original-staging-file"
        path.rename(original)
        path.write_bytes(b"unrelated replacement")
        self.store.cancel_upload(self.owner, identifier)
        self.assertEqual(path.read_bytes(), b"unrelated replacement")

    def test_close_owner_abandons_only_pending_uploads_and_source_context(self):
        document = self.upload()
        snapshot = self.snapshot([document])
        saved = self.store.publish(snapshot, self.root / "project.json")
        self.store.bind_source(self.owner, saved, self.root / "project.json")
        upload = self.store.begin_upload(self.owner, "pending.pdf", 10)["upload_id"]
        other = self.store.begin_upload("other-owner", "other.pdf", 10)["upload_id"]
        pending = self.store._uploads[upload]["path"]
        self.store.close_owner(self.owner)
        self.assertFalse(pending.exists())
        self.assertNotIn(self.owner, self.store._sources)
        self.assertIn(other, self.store._uploads)
        self.assertTrue(self.store.document_path(document).exists())
        with self.assertRaisesRegex(ValidationError, "closed"):
            self.store.begin_upload(self.owner, "new.pdf", 10)

    def test_parser_process_concurrency_is_globally_bounded_at_two(self):
        ready = threading.Barrier(3)
        release = threading.Event()

        def parser(*args, **kwargs):
            ready.wait(timeout=10)
            if not release.wait(timeout=10):
                raise AssertionError("Parser test was not released")
            return subprocess.CompletedProcess(args[0], 0, json.dumps({"pages": [], "sha256": "a"*64}).encode(), b"")

        with patch("estimator.takeoff_documents.subprocess.run", side_effect=parser), ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.store._parse, self.root / "one.pdf", "a"*64)
            second = executor.submit(self.store._parse, self.root / "two.pdf", "a"*64)
            try:
                ready.wait(timeout=10)
                with self.assertRaisesRegex(ValidationError, "Two PDFs"):
                    self.store._parse(self.root / "three.pdf", "a"*64)
            finally:
                release.set()
            self.assertEqual(first.result(timeout=10), [])
            self.assertEqual(second.result(timeout=10), [])

    def test_closing_owner_during_parse_cannot_publish_uncommitted_pdf(self):
        original = pdf_bytes()
        parsed = self.store._parse(self._temporary_pdf(original), hashlib.sha256(original).hexdigest())
        identifier = self.store.begin_upload(self.owner, "pending.pdf", len(original))["upload_id"]
        self.store.write_chunk(self.owner, identifier, 0, original)
        ready, release = threading.Event(), threading.Event()

        def parser(path, expected_sha256):
            ready.set()
            if not release.wait(timeout=10):
                raise AssertionError("Parser test was not released")
            return parsed

        with patch.object(self.store, "_parse", side_effect=parser), ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.store.finish_upload, self.owner, identifier)
            try:
                self.assertTrue(ready.wait(timeout=10))
                self.store.close_owner(self.owner)
            finally:
                release.set()
            with self.assertRaisesRegex(ValidationError, "session closed"):
                future.result(timeout=10)
        self.assertNotIn(identifier, self.store._uploads)
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])

    def test_worker_hashes_and_parses_one_private_snapshot_when_source_changes(self):
        original, replacement = pdf_bytes(rotated=True), pdf_bytes(pages=2)
        path = self._temporary_pdf(original)
        real_parse = takeoff_pdf_worker.parse_pdf_stream

        def replace_before_parse(stream):
            path.write_bytes(replacement)
            return real_parse(stream)

        with patch.object(takeoff_pdf_worker, "parse_pdf_stream", side_effect=replace_before_parse):
            parsed = takeoff_pdf_worker.parse_pdf(path)
        self.assertEqual(parsed["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(len(parsed["pages"]), 1)
        self.assertEqual(parsed["pages"][0]["rotation"], 90)
        self.assertEqual(path.read_bytes(), replacement)

    def test_parent_rejects_pdf_replacement_between_hash_and_parser_start(self):
        original, replacement = pdf_bytes(), pdf_bytes(rotated=True)
        identifier = self.store.begin_upload(self.owner, "pending.pdf", len(original))["upload_id"]
        self.store.write_chunk(self.owner, identifier, 0, original)
        run = subprocess.run

        def swap_for_child(arguments, **kwargs):
            source = Path(arguments[-1])
            saved = source.read_bytes()
            source.write_bytes(replacement)
            try:
                return run(arguments, **kwargs)
            finally:
                source.write_bytes(saved)

        with patch("estimator.takeoff_documents.subprocess.run", side_effect=swap_for_child):
            with self.assertRaisesRegex(ValidationError, "changed before inspection"):
                self.store.finish_upload(self.owner, identifier)
        self.assertEqual(list((self.store.root / "documents").iterdir()), [])
        self.assertEqual(self.store._parsed, {})
        document = self.store.finish_upload(self.owner, identifier)
        self.store._parsed.clear()
        with patch("estimator.takeoff_documents.subprocess.run", side_effect=swap_for_child):
            with self.assertRaisesRegex(ValidationError, "changed before inspection"):
                self.store.document_path(document)
        self.assertEqual(self.store._parsed, {})
        self.assertEqual(self.store.document_path(document).read_bytes(), original)

    def test_oversized_integer_geometry_is_a_validation_error(self):
        document = self.upload()
        document["pages"][0]["width"] = 10**400
        issues = self.store.validate_project_documents([document])
        self.assertEqual(issues[0]["code"], "EVIDENCE_UNAVAILABLE")

    def _temporary_pdf(self, payload):
        path = self.root / "parser-fixture.pdf"
        path.write_bytes(payload)
        return path

    def test_metadata_forgery_and_original_tampering_are_detected(self):
        document = self.upload()
        forged = deepcopy(document)
        forged["pages"][0].update(width=611, view=[0, 0, 611, 792], crop_box=[0, 0, 611, 792])
        with self.assertRaisesRegex(ValidationError, "page geometry"):
            self.store.document_path(forged)
        path = self.store.document_path(document)
        original = path.read_bytes()
        path.write_bytes(original.replace(b"612", b"613"))
        self.assertTrue(self.store.validate_project_documents([document]))
        with self.assertRaises(ValidationError):
            self.store.assert_documents([document])

    def test_range_reads_return_verified_bytes_without_loading_whole_pdf(self):
        original = pdf_bytes()
        document = self.upload(original)
        for requested, expected, status in ((None, original, 200), ("bytes=5-18", original[5:19], 206),
                                             ("bytes=-10", original[-10:], 206), ("bytes=10-", original[10:], 206)):
            with self.subTest(range=requested), self.store.iter_document(document, requested) as response:
                code, headers, chunks = response
                self.assertEqual(code, status)
                self.assertEqual(b"".join(chunks), expected)
                self.assertEqual(int(headers["Content-Length"]), len(expected))
        for requested in ("bytes=0-1,4-5", "bytes=-0", "bytes=999999-", "bytes=5-1"):
            with self.subTest(range=requested), self.store.iter_document(document, requested) as response:
                self.assertEqual(response[0], 416)
                self.assertEqual(b"".join(response[2]), b"")

    def test_stream_snapshot_cannot_change_after_headers_are_returned(self):
        original = pdf_bytes()
        document = self.upload(original)
        with self.store.iter_document(document) as (_, _, chunks):
            self.store.document_path(document, verify=False).write_bytes(b"changed externally")
            self.assertEqual(b"".join(chunks), original)
        with self.assertRaises(ValidationError):
            self.store.document_path(document)

    def test_repeated_range_requests_reuse_bounded_verified_spool(self):
        document = self.upload()
        with self.store.iter_document(document, "bytes=0-10") as response:
            first = b"".join(response[2])
        with patch.object(self.store, "document_path", side_effect=AssertionError("Range reread full PDF")):
            with self.store.iter_document(document, "bytes=0-10") as response:
                self.assertEqual(b"".join(response[2]), first)
        with patch("estimator.takeoff_documents.MAX_SPOOLS", 1):
            second = self.upload(pdf_bytes(rotated=True))
            with self.store.iter_document(second) as response:
                self.assertTrue(b"".join(response[2]).startswith(b"%PDF-"))
            self.assertEqual(list(self.store._spools), [second["sha256"]])

    def test_confirmation_checks_each_owners_companion_not_only_cached_original(self):
        document = self.upload()
        snapshot = self.snapshot([document])
        saved = self.store.publish(snapshot, self.root / "first.json")
        self.store.bind_source("first-owner", saved, self.root / "first.json")
        other = self.root / "other"
        other.mkdir()
        self.store.publish(snapshot, other / "second.json")
        self.store.bind_source("second-owner", saved, other / "second.json")
        portable = self.root / saved["companion_folder"] / "documents" / (document["sha256"] + ".pdf")
        portable.write_bytes(b"damaged portable original")
        self.store.assert_documents([document], owner="second-owner")
        with self.assertRaisesRegex(ValidationError, "hash has changed"):
            self.store.assert_documents([document], owner="first-owner")

    def test_publish_restore_and_save_as_keep_original_and_removed_history(self):
        original = pdf_bytes()
        document = self.upload(original)
        before = self.snapshot([document])
        after = {**deepcopy(before), "documents": [], "revision": 1}
        event = {"version": 1, "project_id": before["project_id"], "revision": 1, "previous": None,
                 "request_id": str(uuid.uuid4()), "op": "remove_document", "at": "2026-09-28T00:00:00Z",
                 "before": deepcopy(before), "after": deepcopy(after)}
        after["audit_head"] = self.store.put_blob(event)
        for folder in (self.root / "project-one", self.root / "project-copy"):
            folder.mkdir()
            saved = self.store.publish(after, folder / "quote.json")
            receiver = TakeoffDocuments(folder / "receiver")
            self.addCleanup(receiver.close)
            self.assertEqual(receiver.restore(saved, folder / "quote.json"), [])
            self.assertEqual(receiver.document_path(document).read_bytes(), original)
            self.assertEqual(receiver.get_blob(saved["audit_head"]), event)
            portable = folder / saved["companion_folder"] / "documents" / (document["sha256"] + ".pdf")
            self.assertEqual(portable.read_bytes(), original)
            self.assertNotEqual(portable.stat().st_ino, self.store.document_path(document).stat().st_ino)

    def test_missing_portable_evidence_is_diagnosed_even_when_cached(self):
        document = self.upload()
        snapshot = self.snapshot([document])
        saved = self.store.publish(snapshot, self.root / "quote.json")
        portable = self.root / saved["companion_folder"] / "documents" / (document["sha256"] + ".pdf")
        portable.unlink()
        self.assertTrue(self.store.restore(saved, self.root / "quote.json"))
        self.assertEqual(saved["documents"], [document])

    def test_audit_hash_foreign_project_and_rewritten_source_fail_closed(self):
        document = self.upload()
        snapshot = self.snapshot([document])
        foreign = self.snapshot([])
        event = {"version": 1, "project_id": foreign["project_id"], "revision": 1, "previous": None,
                 "request_id": str(uuid.uuid4()), "op": "change", "at": "2026-09-28T00:00:00Z",
                 "before": foreign, "after": {**deepcopy(foreign), "revision": 1}}
        snapshot["audit_head"] = self.store.put_blob(event)
        with self.assertRaisesRegex(ValidationError, "different project"):
            self.store.publish(snapshot, self.root / "quote.json")
        event["project_id"] = snapshot["project_id"]
        changed = {**deepcopy(document), "name": "different.pdf"}
        before = {**deepcopy(snapshot), "documents": [changed]}
        snapshot["revision"] = 1
        event.update(version=1, revision=1, request_id=str(uuid.uuid4()), op="change", at="2026-09-28T00:00:00Z",
                     before=before, after=deepcopy(snapshot))
        snapshot["audit_head"] = self.store.put_blob(event)
        with self.assertRaisesRegex(ValidationError, "identity was rewritten"):
            self.store.publish(snapshot, self.root / "quote.json")
        path = self.store.root / "audit" / (snapshot["audit_head"] + ".json")
        path.write_bytes(b"{}")
        with self.assertRaisesRegex(ValidationError, "hash has changed"):
            self.store.get_blob(snapshot["audit_head"])

    def test_portable_paths_and_reparse_points_are_rejected(self):
        document = self.upload()
        snapshot = self.snapshot([document])
        snapshot["companion_folder"] = "../outside"
        with self.assertRaises(ValidationError):
            self.store.publish(snapshot, self.root / "quote.json")
        self.assertTrue(self.store.restore(snapshot, self.root / "quote.json"))
        link = self.root / "redirected"
        try:
            link.symlink_to(self.store.root, target_is_directory=True)
        except OSError:
            pass  # Not every Windows test account can create symlinks.
        else:
            with self.assertRaises(ValidationError):
                TakeoffDocuments(link)
        with patch("estimator.takeoff_documents._linked", return_value=True), self.assertRaises(ValidationError):
            TakeoffDocuments(self.root / "blocked-reparse")

    def test_duplicate_ids_and_project_capacity_are_not_silent(self):
        document = self.upload()
        self.assertTrue(self.store.validate_project_documents([document, document]))
        with patch("estimator.takeoff_documents.MAX_DOCUMENTS", 0):
            self.assertTrue(self.store.validate_project_documents([document]))

    def test_actual_100_document_2000_page_project_capacity(self):
        # Real PDFs and child parsing, without allocating production-size files.
        documents = [self.upload(pdf_bytes(pages=20, title=f"Drawing {index}"), name=f"drawing-{index}.pdf")
                     for index in range(100)]
        self.assertEqual(len({document["sha256"] for document in documents}), 100)
        self.assertEqual(sum(len(document["pages"]) for document in documents), 2000)
        self.assertEqual(self.store.validate_project_documents(documents), [])
        with self.assertRaisesRegex(ValidationError, "100 PDFs"):
            self.store.begin_upload(self.owner, "one-too-many.pdf", 10)
        excessive = [*documents, {**deepcopy(documents[0]), "id": str(uuid.uuid4())}]
        self.assertEqual(self.store.validate_project_documents(excessive)[0]["code"], "DOCUMENT_LIMIT")

    def test_actual_2000_page_parser_and_aggregate_2001_rejection(self):
        document = self.upload(pdf_bytes(pages=2000))
        self.assertEqual(len(document["pages"]), 2000)
        self.assertEqual(document["pages"][-1]["page"], 2000)
        with self.assertRaisesRegex(ValidationError, "2,000 pages"):
            self.upload(pdf_bytes(title="Page 2001"), name="one-too-many-pages.pdf")
        self.assertEqual(len(list((self.store.root / "documents").iterdir())), 1)

    def test_actual_chunk_boundary_and_maximum_declared_pdf_size(self):
        # Exercise an actual full 8 MiB chunk plus its final byte. The 250 MiB
        # reservation boundary needs no artificial 250 MiB or 25 GiB payload.
        data = b"x" * CHUNK_SIZE
        upload = self.store.begin_upload(self.owner, "boundary.pdf", CHUNK_SIZE + 1)["upload_id"]
        self.assertEqual(self.store.write_chunk(self.owner, upload, 0, data)["offset"], CHUNK_SIZE)
        self.assertEqual(self.store.write_chunk(self.owner, upload, 0, data)["offset"], CHUNK_SIZE)
        self.assertTrue(self.store.write_chunk(self.owner, upload, CHUNK_SIZE, b"y")["complete"])
        self.store.cancel_upload(self.owner, upload)
        maximum = self.store.begin_upload(self.owner, "maximum.pdf", MAX_DOCUMENT_SIZE)
        self.assertEqual(maximum["offset"], 0)
        self.store.cancel_upload(self.owner, maximum["upload_id"])
        with self.assertRaises(ValidationError):
            self.store.begin_upload(self.owner, "oversized.pdf", MAX_DOCUMENT_SIZE + 1)

    def test_hash_valid_audit_chain_cannot_hide_an_unrecorded_state_change(self):
        first = self.snapshot([])
        second = {**deepcopy(first), "revision": 1}
        event1 = {"version": 1, "project_id": first["project_id"], "revision": 1, "previous": None,
                  "request_id": str(uuid.uuid4()), "op": "test_operation", "at": "2026-09-28T00:00:00Z",
                  "before": deepcopy(first), "after": deepcopy(second)}
        head1 = self.store.put_blob(event1)
        third = {**deepcopy(second), "revision": 2}
        forged_before = deepcopy(second)
        forged_before["calibrations"] = [{"unaudited": "geometry changed"}]
        event2 = {**deepcopy(event1), "revision": 2, "previous": head1, "request_id": str(uuid.uuid4()),
                  "before": forged_before, "after": deepcopy(third)}
        third["audit_head"] = self.store.put_blob(event2)
        with self.assertRaisesRegex(ValidationError, "unrecorded physical-state"):
            self.store.validate_audit(third)
        event2["before"] = deepcopy(second)
        third["audit_head"] = self.store.put_blob(event2)
        self.store.validate_audit(third)
        missing = {**deepcopy(third), "audit_head": None}
        with self.assertRaisesRegex(ValidationError, "missing its audit"):
            self.store.validate_audit(missing)

    def test_source_audit_tampering_is_not_hidden_by_a_valid_cached_blob(self):
        first = self.snapshot([])
        second = {**deepcopy(first), "revision": 1}
        event = {"version": 1, "project_id": first["project_id"], "revision": 1, "previous": None,
                 "request_id": str(uuid.uuid4()), "op": "test_operation", "at": "2026-09-28T00:00:00Z",
                 "before": deepcopy(first), "after": deepcopy(second)}
        second["audit_head"] = self.store.put_blob(event)
        saved = self.store.publish(second, self.root / "project.json")
        self.store.bind_source(self.owner, saved, self.root / "project.json")
        self.store.validate_audit(saved, owner=self.owner)
        portable = self.root / saved["companion_folder"] / "audit" / (saved["audit_head"] + ".json")
        portable.write_bytes(b"{}")
        self.store.validate_audit(saved)  # The cached original remains intact.
        with self.assertRaisesRegex(ValidationError, "hash has changed"):
            self.store.validate_audit(saved, owner=self.owner)

    def _audit_chain(self, document, count=3):
        snapshot = self.snapshot([document])
        for revision in range(1, count+1):
            after = {**deepcopy(snapshot), "revision": revision}
            event = {"version": 1, "project_id": snapshot["project_id"], "revision": revision,
                     "previous": snapshot["audit_head"], "request_id": str(uuid.uuid4()),
                     "op": "test_operation", "at": "2026-09-28T00:00:00Z",
                     "before": deepcopy(snapshot), "after": deepcopy(after)}
            after["audit_head"] = self.store.put_blob(event)
            snapshot = after
        return snapshot

    def test_warm_audit_cache_reuses_semantics_but_rehashes_every_original_blob(self):
        document = self.upload()
        snapshot = self._audit_chain(document)
        first = self.store._graph(snapshot, self.store._audit_record)
        public_blob = self.store.get_blob(snapshot["audit_head"])
        public_blob["after"]["documents"][0]["name"] = "mutated-return-value.pdf"
        with patch("estimator.takeoff_model.audit_state_digest", side_effect=AssertionError("Unexpected repeated semantic work")):
            self.assertEqual(self.store._graph(snapshot, self.store._audit_record), first)
        self.assertEqual(len(self.store._audit_records), 3)
        self.assertEqual(len(self.store._audit_documents), 1)
        # An older ancestor is still read and hashed, even after all its derived
        # semantic values are present in memory and the head remains unchanged.
        ancestor = first[1][-1]
        (self.store.root / "audit" / (ancestor + ".json")).write_bytes(b"{}")
        with self.assertRaisesRegex(ValidationError, "hash has changed"):
            self.store.validate_audit(snapshot)

    def test_audit_semantic_cache_has_entry_and_byte_bounds(self):
        snapshot = self._audit_chain(self.upload())
        with patch("estimator.takeoff_documents.MAX_AUDIT_RECORDS", 2):
            self.store.validate_audit(snapshot)
        self.assertEqual(len(self.store._audit_records), 2)
        self.assertEqual(self.store._audit_cache_bytes, sum(record["weight"] for record in self.store._audit_records.values()))
        fresh = TakeoffDocuments(self.store.root)
        self.addCleanup(fresh.close)
        with patch("estimator.takeoff_documents.MAX_AUDIT_CACHE_BYTES", 1):
            fresh.validate_audit(snapshot)
        self.assertEqual(len(fresh._audit_records), 0)
        self.assertEqual(fresh._audit_cache_bytes, 0)

    def test_metadata_interning_cannot_hide_boolean_page_identity(self):
        snapshot = self._audit_chain(self.upload(), count=1)
        self.store.validate_audit(snapshot)
        event = self.store.get_blob(snapshot["audit_head"])
        event["after"]["documents"][0]["pages"][0]["page"] = True
        snapshot["audit_head"] = self.store.put_blob(event)
        with self.assertRaisesRegex(ValidationError, "page identity"):
            self.store.validate_audit(snapshot)

    def test_audit_attribution_is_optional_for_legacy_and_exact_when_present(self):
        document = self.upload()
        snapshot = self._audit_chain(document, count=1)
        self.store.validate_audit(snapshot)  # Existing version-one events remain readable.
        event = self.store.get_blob(snapshot["audit_head"])
        event["actor"] = {"kind": "local-session", "session_id": str(uuid.uuid4())}
        event["affected_ids"] = {name: [] for name in ("items", "documents", "calibrations", "transfers")}
        event["after"]["documents"] = []
        event["affected_ids"]["documents"] = [document["id"]]
        snapshot = {**event["after"], "audit_head": self.store.put_blob(event)}
        self.store.validate_audit(snapshot)
        self.assertEqual(self.store.get_blob(snapshot["audit_head"])["actor"], event["actor"])

        changes = [
            {"actor": None},
            {"actor": {"kind": "authenticated-user", "session_id": str(uuid.uuid4())}},
            {"actor": {"kind": "local-session", "session_id": "not-a-session"}},
            {"actor": {**event["actor"], "user": "invented"}},
            {"affected_ids": []},
            {"affected_ids": {"items": []}},
            {"affected_ids": {**event["affected_ids"], "documents": [document["id"], document["id"]]}},
            {"affected_ids": {**event["affected_ids"], "documents": ["invalid"]}},
            {"affected_ids": {**event["affected_ids"], "documents": []}},
            {"affected_ids": {**event["affected_ids"], "documents": sorted(str(uuid.uuid4()) for _ in range(201))}},
        ]
        for change in changes:
            with self.subTest(change=change):
                changed = {**deepcopy(event), **change}
                invalid = {**snapshot, "audit_head": self.store.put_blob(changed)}
                with self.assertRaises(ValidationError):
                    self.store.validate_audit(invalid)
        for omitted in ("actor", "affected_ids"):
            changed = deepcopy(event)
            del changed[omitted]
            with self.subTest(omitted=omitted), self.assertRaises(ValidationError):
                self.store.validate_audit({**snapshot, "audit_head": self.store.put_blob(changed)})

    def test_add_capacity_includes_deleted_originals_before_creating_draft(self):
        original = self.upload()
        before = self.snapshot([original])
        after = {**deepcopy(before), "revision": 1, "documents": []}
        event = {"version": 1, "project_id": before["project_id"], "revision": 1, "previous": None,
                 "request_id": str(uuid.uuid4()), "op": "delete_document", "at": "2026-09-28T00:00:00Z",
                 "before": deepcopy(before), "after": deepcopy(after)}
        after["audit_head"] = self.store.put_blob(event)
        additional = {**deepcopy(original), "id": str(uuid.uuid4())}
        with patch("estimator.takeoff_documents.MAX_DOCUMENTS", 1), self.assertRaisesRegex(ValidationError, "deleted-document history"):
            self.store.assert_add_capacity(after, additional)
        with patch("estimator.takeoff_documents.MAX_PROJECT_PAGES", 1), self.assertRaisesRegex(ValidationError, "deleted-document history"):
            self.store.assert_add_capacity(after, additional)
        self.store.assert_add_capacity(after, additional)


if __name__ == "__main__":
    unittest.main()
