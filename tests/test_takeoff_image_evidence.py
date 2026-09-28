"""Parent trust boundary, immutable companions and local extraction provenance."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.storage import Store
from estimator.takeoff_documents import TakeoffDocuments, _canonical
from estimator.takeoff_pdf_worker import parse_pdf
from estimator import takeoff_image_evidence as evidence
from estimator import takeoff_image_worker as worker
from tests.test_takeoff_images_worker import image, make_pdf


class TakeoffImageEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.documents = TakeoffDocuments(self.root/"cache")
        self.addCleanup(self.documents.close)
        self.store = Store(self.root/"test.sqlite3")
        self.manager = evidence.TakeoffImageEvidence(self.store, self.documents)
        self.document = self.add_document(make_pdf())

    def add_document(self, payload):
        digest = sha256(payload).hexdigest()
        path = self.documents.root/"documents"/(digest+".pdf")
        path.write_bytes(payload)
        pages = parse_pdf(path)["pages"]
        self.documents._parsed[digest] = deepcopy(pages)
        return {"id": str(uuid4()), "name": "synthetic.pdf", "sha256": digest, "size": len(payload), "pages": pages}

    def extract(self, document=None, first=1, count=1, mutate=None):
        # Exercise the full parent boundary quickly with synthetic worker output;
        # a separate test also invokes the actual isolated subprocess.
        def run(arguments, **kwargs):
            manifest = worker.extract_images(arguments[3], arguments[4], arguments[5], int(arguments[6]), int(arguments[7]))
            if mutate:
                mutate(manifest, Path(arguments[4]))
            kwargs["stdout"].write(_canonical(manifest))
            return subprocess.CompletedProcess(arguments, 0)
        with patch.object(evidence.subprocess, "run", side_effect=run):
            return self.manager.extract(document or self.document, first, count)

    def published(self, descriptor, folder=None):
        folder = folder or self.root/"portable"
        self.manager.publish([descriptor], [self.document], folder)
        return folder

    def test_real_restricted_child_registers_exact_files_and_scoped_png(self):
        descriptor = self.manager.extract(self.document, 1, 1)
        manifest = self.manager.read(descriptor, self.document, verify_assets=True)
        self.assertTrue(self.manager.registered(descriptor))
        self.assertEqual(descriptor["total_bytes"], descriptor["manifest_size"]+sum(entry["size"] for entry in manifest["files"]))
        self.assertEqual(manifest["source"]["sha256"], self.document["sha256"])
        payload, mime = self.manager.rendition(descriptor, self.document, manifest["assets"][0]["id"])
        self.assertEqual(mime, "image/png")
        self.assertEqual(sha256(payload).hexdigest(), manifest["assets"][0]["rendition"]["sha256"])
        self.manager.assert_evidence([descriptor], [self.document], require_registered=True)
        self.assertEqual(list((self.documents.root/"image-jobs").iterdir()), [])
        self.assertFalse(self.manager.registered({**descriptor, "id": str(uuid4())}))

    def test_all_synthetic_supported_original_shapes_validate_in_parent(self):
        sources = [make_pdf(b""), make_pdf(b"q 40 0 0 20 10 20 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID ff 00 00 > EI Q"),
                   make_pdf(pages=2), make_pdf(source=image(b"bad jpeg", filter="/DCTDecode"))]
        for payload in sources:
            with self.subTest(digest=sha256(payload).hexdigest()):
                document = self.add_document(payload)
                descriptor = self.extract(document)
                manifest = self.manager.read(descriptor, document, verify_assets=True)
                self.assertTrue(self.manager.registered(descriptor))
                self.manager.assert_evidence([descriptor], [document], require_registered=True)
                if len(document["pages"]) == 2:
                    self.assertEqual(manifest["issues"][0]["code"], "PARTIAL_DOCUMENT_RANGE")

    def test_descriptor_is_pure_exact_and_bounded(self):
        descriptor = self.extract()
        bad = [{**descriptor, "pages": [True]}, {**descriptor, "pages": [1, 3]}, {**descriptor, "pages": []},
            {**descriptor, "manifest_size": 0}, {**descriptor, "total_bytes": 1}, {**descriptor, "id": "../bad"},
            {**descriptor, "source_sha256": "0"*63}, {**descriptor, "extra": True}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                evidence.validate_descriptor(value)

    def test_portable_reopen_save_as_and_empty_blobs_remain_immutable(self):
        self.document = self.add_document(make_pdf(b""))
        descriptor = self.extract()
        portable = self.published(descriptor)
        receiver_documents = TakeoffDocuments(self.root/"receiver-cache")
        self.addCleanup(receiver_documents.close)
        receiver = evidence.TakeoffImageEvidence(self.store, receiver_documents)
        self.assertEqual(receiver.restore([descriptor], [self.document], portable, owner="window"), [])
        manifest = receiver.read(descriptor, self.document, verify_assets=True)
        self.assertTrue(any(entry["size"] == 0 for entry in manifest["files"]))
        copied = self.root/"save-as"
        receiver.publish([descriptor], [self.document], copied)
        for entry in manifest["files"]:
            self.assertEqual((portable/"image-files"/entry["relative_path"]).read_bytes(),
                             (copied/"image-files"/entry["relative_path"]).read_bytes())

    def test_warm_cache_does_not_hide_missing_or_tampered_portable_files(self):
        descriptor = self.extract()
        portable = self.published(descriptor)
        manifest = self.manager.read(descriptor, self.document)
        asset = manifest["assets"][0]
        self.manager.bind_source("window", [descriptor], portable)
        path = portable/"image-files"/asset["rendition"]["relative_path"]
        original = path.read_bytes(); path.write_bytes(b"tampered")
        self.assertEqual(self.manager.restore([descriptor], [self.document], portable, "window")[0]["code"], "IMAGE_EVIDENCE_UNAVAILABLE")
        with self.assertRaises(ValidationError):
            self.manager.assert_evidence([descriptor], [self.document], owner="window")
        with self.assertRaises(ValidationError):
            self.manager.rendition(descriptor, self.document, asset["id"], owner="window")
        path.write_bytes(original)
        (portable/"image-manifests"/(descriptor["manifest_sha256"]+".json")).unlink()
        with self.assertRaises(ValidationError):
            self.manager.assert_evidence([descriptor], [self.document], owner="window")

    def test_unknown_imported_manifest_stays_diagnostic_until_local_extraction(self):
        descriptor = self.extract()
        portable = self.published(descriptor)
        receiver = evidence.TakeoffImageEvidence(Store(self.root/"other.sqlite3"), self.documents)
        issues = receiver.restore([descriptor], [self.document], portable, owner="import")
        self.assertEqual(issues[0]["code"], "IMAGE_EXTRACTION_UNREGISTERED")
        self.assertFalse(receiver.registered(descriptor))
        receiver.assert_evidence([descriptor], [self.document], owner="import")
        with self.assertRaisesRegex(ValidationError, "fresh|again|provenance"):
            receiver.assert_evidence([descriptor], [self.document], owner="import", require_registered=True)
        receiver.publish([descriptor], [self.document], self.root/"import-save-as")
        self.manager = receiver
        fresh = self.extract()
        self.assertTrue(receiver.registered(fresh))
        old_manifest = receiver.read(descriptor, self.document)
        new_manifest = receiver.read(fresh, self.document)
        self.assertEqual(old_manifest["assets"][0]["id"], new_manifest["assets"][0]["id"])
        self.assertEqual(old_manifest["occurrences"][0]["id"], new_manifest["occurrences"][0]["id"])
        self.assertFalse(receiver.registered(descriptor))

    def test_forged_self_consistent_manifest_cannot_acquire_registry_authority(self):
        descriptor = self.extract()
        manifest = self.manager.read(descriptor, self.document)
        manifest["extraction"]["id"] = str(uuid4())
        payload = _canonical(manifest)
        forged = self.manager._descriptor(manifest, self.document["id"], payload)
        self.manager._manifest_path(forged).write_bytes(payload)
        self.manager.read(forged, self.document, verify_assets=True)
        self.assertFalse(self.manager.registered(forged))
        with self.assertRaises(ValidationError):
            self.manager.assert_evidence([forged], [self.document], require_registered=True)

    def test_wrong_source_metadata_and_unscoped_asset_are_rejected(self):
        descriptor = self.extract()
        with self.assertRaises(ValidationError):
            self.manager.read(descriptor, {**self.document, "id": str(uuid4())})
        changed = deepcopy(self.document); changed["pages"][0]["rotation"] = 90
        with self.assertRaises(ValidationError):
            self.manager.read(descriptor, changed)
        with self.assertRaises(ValidationError):
            self.manager.rendition(descriptor, self.document, str(uuid4()))
        self.documents.document_path(self.document, verify=False).write_bytes(b"%PDF-source changed")
        with self.assertRaises(ValidationError):
            self.manager.assert_evidence([descriptor], [self.document], require_registered=True)

    def test_imported_typed_schema_and_png_dimension_forgery_fail_closed(self):
        descriptor = self.extract()
        original = self.manager.read(descriptor, self.document)
        for mutation in ("asset-reference", "coverage-boolean", "page-boolean", "png-dimensions", "huge-number"):
            with self.subTest(mutation=mutation):
                manifest = deepcopy(original)
                if mutation == "asset-reference":
                    manifest["occurrences"][0]["asset_id"] = []
                elif mutation == "coverage-boolean":
                    manifest["coverage"]["complete_pages"] = [True]
                elif mutation == "page-boolean":
                    manifest["pages"][0]["page"] = True
                elif mutation == "png-dimensions":
                    manifest["assets"][0]["rendition"]["width"] += 1
                else:
                    manifest["occurrences"][0]["ctm"][0] = 10**1000
                payload = _canonical(manifest)
                forged = self.manager._descriptor(manifest, self.document["id"], payload)
                self.manager._manifest_path(forged).write_bytes(payload)
                with self.assertRaises(ValidationError):
                    self.manager.read(forged, self.document, verify_assets=True)

    def test_linked_output_file_is_rejected_before_cache_publication(self):
        target = self.root/"foreign.bin"
        target.write_bytes(b"foreign bytes")
        probe = self.root/"probe-link.bin"
        try:
            probe.symlink_to(target)
        except OSError:
            self.skipTest("This host cannot create test symlinks without elevated privileges.")
        probe.unlink()
        def replace(manifest, folder):
            path = folder/manifest["files"][0]["relative_path"]
            path.unlink()
            path.symlink_to(target)
        with self.assertRaises(ValidationError):
            self.extract(mutate=replace)
        self.assertEqual(target.read_bytes(), b"foreign bytes")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM takeoff_image_extractions").fetchone()[0], 0)

    def test_extra_file_path_traversal_inventory_mismatch_and_byte_tamper_reject_child(self):
        def extra(manifest, folder):
            (folder/"arbitrary.txt").write_text("unlisted")
        def traversal(manifest, folder):
            manifest["files"][0]["relative_path"] = "../outside.bin"
        def mismatch(manifest, folder):
            manifest["files"][0]["size"] += 1
        def tamper(manifest, folder):
            (folder/manifest["files"][0]["relative_path"]).write_bytes(b"tampered")
        def quad(manifest, folder):
            manifest["occurrences"][0]["quad_pdf"][0][0] += 1
        def coverage(manifest, folder):
            manifest["coverage"]["complete_pages"] = []
        for mutate in (extra, traversal, mismatch, tamper, quad, coverage):
            with self.subTest(case=mutate.__name__), self.assertRaises(ValidationError):
                self.extract(mutate=mutate)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM takeoff_image_extractions").fetchone()[0], 0)
        self.assertEqual(list((self.documents.root/"image-jobs").iterdir()), [])

    def test_child_timeout_termination_disk_and_slot_exhaustion_do_not_register(self):
        with patch.object(evidence.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 40)):
            with self.assertRaisesRegex(ValidationError, "time limit"):
                self.manager.extract(self.document, 1, 1)
        with patch.object(evidence.subprocess, "run", return_value=subprocess.CompletedProcess("worker", 1)):
            with self.assertRaisesRegex(ValidationError, "resource limits"):
                self.manager.extract(self.document, 1, 1)
        with patch.object(self.documents, "_space", side_effect=ValidationError("disk exhausted")):
            with self.assertRaisesRegex(ValidationError, "disk exhausted"):
                self.manager.extract(self.document, 1, 1)
        self.assertTrue(evidence._SLOTS.acquire(blocking=False)); self.assertTrue(evidence._SLOTS.acquire(blocking=False))
        try:
            with self.assertRaisesRegex(ValidationError, "Two image"):
                self.manager.extract(self.document, 1, 1)
        finally:
            evidence._SLOTS.release(); evidence._SLOTS.release()
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM takeoff_image_extractions").fetchone()[0], 0)
        self.assertEqual(list((self.documents.root/"image-jobs").iterdir()), [])
        self.assertTrue(self.manager.registered(self.extract()))

    def test_collection_capacity_and_duplicate_descriptors_fail_before_publish(self):
        descriptor = self.extract()
        with self.assertRaises(ValidationError):
            self.manager.publish([descriptor, descriptor], [self.document], self.root/"bad-copy")
        with patch.object(evidence, "MAX_IMAGE_PROJECT_BYTES", descriptor["total_bytes"]-1):
            with self.assertRaisesRegex(ValidationError, "4 GiB"):
                self.manager.publish([descriptor], [self.document], self.root/"too-large")
        self.assertFalse((self.root/"too-large").exists())
        with patch.object(evidence, "MAX_IMAGE_DESCRIPTORS", 0):
            with self.assertRaises(ValidationError):
                self.manager.assert_evidence([descriptor], [self.document])

    def test_failed_copy_cannot_register_or_replace_previous_manifest(self):
        descriptor = self.extract()
        previous = self.manager._manifest_path(descriptor).read_bytes()
        original_copy = self.documents._copy
        def fail_copy(source, destination, *args, **kwargs):
            if "image-manifests" in Path(destination).parts:
                raise ValidationError("simulated failed immutable publication")
            return original_copy(source, destination, *args, **kwargs)
        with patch.object(self.documents, "_copy", side_effect=fail_copy), self.assertRaises(ValidationError):
            self.extract()
        self.assertEqual(self.manager._manifest_path(descriptor).read_bytes(), previous)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM takeoff_image_extractions").fetchone()[0], 1)

    def test_closed_owner_and_missing_portable_folder_cannot_fall_back_to_cache(self):
        descriptor = self.extract()
        self.manager.bind_source("missing", [descriptor], self.root/"missing"/"companion")
        with self.assertRaises(ValidationError):
            self.manager.assert_evidence([descriptor], [self.document], owner="missing")
        self.manager.close_owner("missing")
        with self.assertRaises(ValidationError):
            self.manager.bind_source("missing", [descriptor], self.root/"portable")
        with self.assertRaises(ValidationError):
            self.manager.assert_evidence([descriptor], [self.document], owner="missing")


if __name__ == "__main__":
    unittest.main()
