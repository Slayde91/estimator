"""Project certificate snapshots retain exact PDFs without global ownership guesses."""
from copy import deepcopy
from contextlib import contextmanager
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import json
import tempfile
import unittest
import uuid
from unittest.mock import patch
from zipfile import ZipFile
from pypdf import PdfWriter

from estimator.catalog import ValidationError
from estimator.certification import (CertificationService, CertificationConflict,
    CertificationNotFound, FIELDS, REQUIRED_GENERATION_FIELDS, DEFAULT_OPTIONS, _fingerprint, _json)
from estimator.certification_projects import CertificationProjects, validate_manifest
from estimator.company_settings import DEFAULTS
from estimator.project_file import export_project, load_project_bytes, MAX_PROJECT_FILE
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from test_certification import pdf
from test_project_library import Chooser


def fields(**values):
    return {**dict.fromkeys(FIELDS, ''), **dict.fromkeys(REQUIRED_GENERATION_FIELDS, 'N/A'),
            'client': 'Example client', 'project': 'Project Alpha', 'address': '1 Example Street', **values}


class CertificationProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.store = Store(self.root / 'runtime' / 'state.sqlite3')
        self.legacy = CertificationService(self.store, renderer=lambda *args, **kwargs: pdf('FROZEN REVISION'))
        self.projects = CertificationProjects(self.legacy)

    def prepared(self):
        workspace = self.projects.new()
        return workspace, self.projects.service(workspace['workspace_id'])

    def capture(self, workspace, document=None, **values):
        draft = {'id': document['id'] if document else None, 'version': document['version'] if document else None,
                 'fields': {**(document['fields'] if document else fields()), **values},
                 'options': document['options'] if document else deepcopy(DEFAULT_OPTIONS)}
        return self.projects.capture({'workspace_id': workspace['workspace_id'], 'draft': draft})

    def test_project_isolation_and_portable_frozen_revisions_and_receipts(self):
        legacy = self.legacy.create({'project': 'Legacy global, unassigned'})
        workspace, service = self.prepared()
        other, other_service = self.prepared()
        document = service.create(fields(), str(uuid.uuid4()))
        request = str(uuid.uuid4())
        generated = service.generate(document['id'], document['fields'], 1, request, DEFAULTS)
        original_pdf = service.revision_pdf(document['id'], 1)
        with self.assertRaises(CertificationNotFound): other_service.get(document['id'])
        with self.assertRaises(CertificationNotFound): service.get(legacy['id'])
        self.assertEqual(other_service.list_documents(), {'items': []})
        snapshot = self.capture(workspace, generated['document'], location_area='Unsaved UI draft, captured in project')
        project_path = self.root / 'Alpha.cf.json'
        self.projects.publish(snapshot, project_path)
        # Restore on a new database, proving this is not a local-ID-only link.
        fresh = CertificationProjects(CertificationService(Store(self.root / 'portable' / 'state.sqlite3')))
        reopened = fresh.restore(snapshot, project_path)
        restored = fresh.service(reopened['workspace_id'])
        self.assertNotEqual(reopened['workspace_id'], workspace['workspace_id'])
        self.assertEqual(reopened['project_id'], workspace['project_id'])
        self.assertEqual(reopened['draft']['fields']['location_area'], 'Unsaved UI draft, captured in project')
        self.assertEqual(restored.revision_pdf(document['id'], 1), original_pdf)
        self.assertEqual(restored.generate(document['id'], document['fields'], 1, request, DEFAULTS), generated)
        self.assertEqual(len(restored.get(document['id'])['revisions']), 1)
        self.assertEqual(self.legacy.get(legacy['id']), legacy)
        self.assertEqual(self.legacy.list_documents()['items'][0]['id'], legacy['id'])
        scoped = fresh.response(reopened['workspace_id'], restored.get(document['id']))
        self.assertTrue(scoped['revisions'][0]['pdf_url'].endswith('?workspace=' + reopened['workspace_id']))

    def test_missing_and_tampered_companions_and_path_injection_fail_explicitly(self):
        workspace, _ = self.prepared()
        snapshot = self.capture(workspace)
        self.assertEqual(self.projects.restore(snapshot)['draft']['fields'], fields())
        fresh = CertificationProjects(CertificationService(Store(self.root / 'fresh' / 'state.sqlite3')))
        with self.assertRaisesRegex(ValidationError, 'Load Project'):
            fresh.restore(snapshot)
        with self.assertRaisesRegex(ValidationError, 'companion archive is missing'):
            self.projects.restore(snapshot, self.root / 'Missing.cf.json')
        self.projects.publish(snapshot, self.root / 'Saved.cf.json')
        archive = self.root / snapshot['companion_folder'] / (snapshot['archive_sha256'] + '.zip')
        archive.write_bytes(archive.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValidationError, 'SHA-256'):
            self.projects.restore(snapshot, self.root / 'Saved.cf.json')
        with self.assertRaises(ValidationError): validate_manifest({**snapshot, 'companion_folder': '../outside'})
        with self.assertRaises(ValidationError): self.projects.service('../outside')

    def test_browser_import_cache_is_verified_and_preserves_edited_draft_and_signature(self):
        from test_pdf_download_covers import signature
        workspace, _ = self.prepared()
        draft = {'id': None, 'version': None, 'fields': fields(location_area='Edited unsaved certificate draft'),
                 'options': {**deepcopy(DEFAULT_OPTIONS), 'signature_image': signature(), 'signature_name': 'Saved drawing.png'}}
        snapshot = self.projects.capture({'workspace_id': workspace['workspace_id'], 'draft': draft})
        restored = self.projects.restore(snapshot)
        self.assertEqual(restored['draft'], draft)
        self.assertNotEqual(restored['workspace_id'], workspace['workspace_id'])
        with self.assertRaisesRegex(ValidationError, 'companion archive is missing'):
            self.projects.restore(snapshot, self.root / 'StillMissing.cf.json')
        cached = self.projects.root / 'archives' / (snapshot['archive_sha256'] + '.zip')
        cached.write_bytes(cached.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValidationError, 'SHA-256'):
            self.projects.restore(snapshot)
        cached.unlink()
        with self.assertRaisesRegex(ValidationError, 'Load Project'):
            self.projects.restore(snapshot)

    def test_cancelled_save_as_preserves_current_project_and_new_project_is_empty(self):
        workspace, service = self.prepared()
        document = service.create(fields())
        chooser = Chooser()
        library = ProjectLibrary(self.store, chooser, certifications=self.projects)
        self.addCleanup(library.close)
        request = {'estimate': {'title': 'Example'}, 'certifications': {'workspace_id': workspace['workspace_id'],
                   'draft': {'id': document['id'], 'version': 1, 'fields': document['fields'], 'options': document['options']}}}
        self.assertEqual(library.save_as(request), {'cancelled': True})
        self.assertEqual(service.get(document['id']), document)
        self.assertFalse((self.root / '.ceasefire-evidence').exists())
        fresh, fresh_service = self.prepared()
        self.assertEqual(fresh_service.list_documents(), {'items': []})
        self.assertNotEqual(fresh['project_id'], workspace['project_id'])

    def test_saved_project_manifest_is_bounded_and_old_files_need_no_certificate_data(self):
        workspace, _ = self.prepared()
        manifest = self.capture(workspace)
        old = export_project(self.store, {'estimate': {'title': 'Old project'}})
        self.assertNotIn('certifications', load_project_bytes(self.store, old))
        payload = export_project(self.store, {'estimate': {'title': 'New project'}, 'certifications': manifest})
        self.assertLess(len(payload), MAX_PROJECT_FILE)
        self.assertEqual(load_project_bytes(self.store, payload)['certifications'], manifest)
        self.assertNotIn('pdf', json.loads(payload)['certifications'])
        with self.assertRaises(ValidationError):
            export_project(self.store, {'estimate': {'title': 'Invalid'}, 'certifications': {'workspace_id': workspace['workspace_id'], 'draft': None}})

    def test_save_as_copy_preserves_portable_project_and_old_snapshot_isolated(self):
        workspace, service = self.prepared()
        doc = service.create(fields())
        first = self.capture(workspace, doc)
        one, two = self.root / 'One.cf.json', self.root / 'copy' / 'Two.cf.json'
        two.parent.mkdir()
        self.projects.publish(first, one); self.projects.publish(first, two)
        service.save(doc['id'], {**doc['fields'], 'project': 'Later draft'}, 1)
        old = self.projects.restore(first, two)
        restored = self.projects.service(old['workspace_id'])
        self.assertEqual(restored.get(doc['id'])['fields']['project'], 'Project Alpha')
        self.assertEqual(service.get(doc['id'])['fields']['project'], 'Later draft')
        with self.assertRaises(CertificationConflict): self.capture(workspace, doc)
        with self.assertRaises(CertificationNotFound):
            self.capture(workspace, {**doc, 'id': str(uuid.uuid4())})

    def test_required_new_generation_and_legacy_incomplete_replay(self):
        doc = self.legacy.create({'project': 'Incomplete historical certificate'})
        with self.assertRaisesRegex(ValidationError, 'required certification fields'):
            self.legacy.generate(doc['id'], doc['fields'], 1, str(uuid.uuid4()), DEFAULTS)
        self.assertEqual(self.legacy.get(doc['id']), doc)
        operation, frozen = str(uuid.uuid4()), pdf('OLD INCOMPLETE REVISION')
        fingerprint = _fingerprint({'fields': doc['fields'], 'expected_version': 1})
        with self.store.connect() as db:
            db.execute('INSERT INTO certification_revisions(document_id,revision,created_at,fields,company,pdf,sha256,request_id,request_fingerprint) VALUES(?,?,?,?,?,?,?,?,?)',
                       (doc['id'], 1, doc['created_at'], _json(doc['fields']), _json(DEFAULTS), frozen,
                        sha256(frozen).hexdigest(), operation, fingerprint))
            db.execute('UPDATE certification_documents SET version=2 WHERE id=?', (doc['id'],))
        replay = self.legacy.generate(doc['id'], doc['fields'], 1, operation, DEFAULTS)
        self.assertEqual(replay['revision']['revision'], 1)
        self.assertEqual(self.legacy.revision_pdf(doc['id'], 1), frozen)
        with self.assertRaises(ValidationError):
            self.legacy.generate(doc['id'], doc['fields'], 2, str(uuid.uuid4()), DEFAULTS)

    def test_explicit_legacy_import_is_idempotent_portable_and_source_unchanged(self):
        source = self.legacy.create(fields(project='Consciously selected older certificate'), str(uuid.uuid4()))
        operation = str(uuid.uuid4())
        generated = self.legacy.generate(source['id'], source['fields'], 1, operation, DEFAULTS)
        before = self.legacy.get(source['id'])
        frozen = self.legacy.revision_pdf(source['id'], 1)
        workspace, service = self.prepared()
        imported = self.projects.import_legacy(workspace['workspace_id'], source['id'])
        self.assertFalse(imported['already_imported'])
        self.assertEqual(service.revision_pdf(source['id'], 1), frozen)
        edited = service.save(source['id'], {**before['fields'], 'project': 'Project-specific edit'}, before['version'])
        repeat = self.projects.import_legacy(workspace['workspace_id'], source['id'])
        self.assertTrue(repeat['already_imported'])
        self.assertEqual(repeat['document']['fields']['project'], 'Project-specific edit')
        self.assertEqual(len(service.list_documents()['items']), 1)
        snapshot = self.capture(workspace, edited)
        path = self.root / 'Imported.cf.json'
        self.projects.publish(snapshot, path)
        reopened = self.projects.restore(snapshot, path)
        self.assertTrue(self.projects.import_legacy(reopened['workspace_id'], source['id'])['already_imported'])
        self.assertEqual(self.legacy.get(source['id']), before)
        self.assertEqual(self.legacy.revision_pdf(source['id'], 1), frozen)
        # A coincident ID without an explicit provenance receipt cannot replace
        # a document already owned by the destination project.
        collision, other = self.prepared()
        with other.store.connect() as destination, self.store.connect() as original:
            row = original.execute('SELECT * FROM certification_documents WHERE id=?', (source['id'],)).fetchone()
            columns = original.execute('PRAGMA table_info(certification_documents)').fetchall()
            destination.execute('INSERT INTO certification_documents (' + ','.join(item[1] for item in columns) + ') VALUES(' + ','.join('?' for _ in columns) + ')', row)
        with self.assertRaises(CertificationConflict):
            self.projects.import_legacy(collision['workspace_id'], source['id'])

    def test_overlimit_legacy_import_rejects_before_reading_pdf_blobs(self):
        source = self.legacy.create(fields())
        self.legacy.generate(source['id'], source['fields'], 1, str(uuid.uuid4()), DEFAULTS)
        workspace, _ = self.prepared()
        connect, statements = self.store.connect, []
        class RecordedConnection:
            def __init__(self, original): self.original = original
            def execute(self, statement, *args):
                statements.append(statement)
                return self.original.execute(statement, *args)
        @contextmanager
        def recorded():
            with connect() as original:
                yield RecordedConnection(original)
        with patch.object(self.store, 'connect', recorded), patch('estimator.certification_projects.MAX_REVISIONS', 0):
            with self.assertRaisesRegex(ValidationError, 'No PDF data was loaded'):
                self.projects.import_legacy(workspace['workspace_id'], source['id'])
        self.assertTrue(any('SELECT COUNT(*) FROM certification_revisions' in statement for statement in statements))
        self.assertFalse(any(statement.startswith('SELECT pdf FROM') or ',cover_settings,pdf FROM' in statement for statement in statements))

    def test_archive_limit_counts_identical_frozen_pdf_bytes_once(self):
        buffer = BytesIO(); writer = PdfWriter(); writer.add_blank_page(width=400, height=600)
        writer.add_metadata({'/RetainedEvidence': 'x' * 120000}); writer.write(buffer)
        frozen = buffer.getvalue()
        self.legacy.renderer = lambda *args, **kwargs: frozen
        source = self.legacy.create(fields())
        first = self.legacy.generate(source['id'], source['fields'], 1, str(uuid.uuid4()), DEFAULTS)
        second = self.legacy.generate(source['id'], source['fields'], 2, str(uuid.uuid4()), DEFAULTS)
        self.assertEqual(first['revision']['sha256'], second['revision']['sha256'])
        workspace, service = self.prepared()
        limit = len(frozen) + 100000
        self.assertGreater(2 * len(frozen), limit)
        with patch('estimator.certification_projects.MAX_ARCHIVE_BYTES', limit):
            self.projects.import_legacy(workspace['workspace_id'], source['id'])
            manifest = self.capture(workspace, service.get(source['id']))
            self.assertLess(manifest['archive_size'], limit)
            path = self.root / 'Deduplicated.cf.json'
            self.projects.publish(manifest, path)
            restored = self.projects.restore(manifest, path)
            reopened = self.projects.service(restored['workspace_id'])
            self.assertEqual(reopened.revision_pdf(source['id'], 1), frozen)
            self.assertEqual(reopened.revision_pdf(source['id'], 2), frozen)

    def test_capture_rejects_oversized_metadata_before_materializing_document_rows(self):
        workspace, service = self.prepared()
        service.create(fields())
        connect, statements = service.store.connect, []
        class RecordedConnection:
            def __init__(self, original): self.original = original
            def execute(self, statement, *args):
                statements.append(statement)
                return self.original.execute(statement, *args)
        @contextmanager
        def recorded():
            with connect() as original:
                yield RecordedConnection(original)
        with patch.object(service.store, 'connect', recorded), patch('estimator.certification_projects.MAX_METADATA_BYTES', 1):
            with self.assertRaisesRegex(ValidationError, 'metadata exceeds'):
                self.projects.capture({'workspace_id': workspace['workspace_id'], 'draft': None})
        self.assertFalse(any(statement.startswith('SELECT id,fields,version') for statement in statements))

    def test_import_budgets_exact_escaped_archive_metadata_and_selected_draft(self):
        source = self.legacy.create(fields(project='Quotes and slashes: ' + '\\"' * 1000))
        reference, reference_service = self.prepared()
        self.projects.import_legacy(reference['workspace_id'], source['id'])
        manifest = self.capture(reference, reference_service.get(source['id']))
        with ZipFile(self.projects.root / 'archives' / (manifest['archive_sha256'] + '.zip')) as archive:
            encoded_size = len(archive.read('certificates.json'))
        target, target_service = self.prepared()
        with patch('estimator.certification_projects.MAX_METADATA_BYTES', encoded_size - 100):
            with self.assertRaisesRegex(ValidationError, 'encoded project certificate archive limit'):
                self.projects.import_legacy(target['workspace_id'], source['id'])
        self.assertEqual(target_service.list_documents(), {'items': []})
        self.assertEqual(self.projects._workspace(target['workspace_id'])['imports'], {})

    def test_scoped_create_quota_rolls_back_without_stranding_a_document_or_receipt(self):
        workspace, service = self.prepared()
        operation = str(uuid.uuid4())
        document = service.create(fields(), operation)
        rejected = str(uuid.uuid4())
        with patch('estimator.certification_projects.MAX_DOCUMENTS', 1):
            with self.assertRaises(ValidationError): service.create(fields(project='Too many'), rejected)
            self.assertEqual(len(service.list_documents()['items']), 1)
            # Existing committed receipts remain recoverable before quota checks.
            self.assertEqual(service.create(fields(), operation), document)
            self.capture(workspace, document)
            # The globally retained legacy store keeps its old API behavior.
            self.legacy.create(fields(project='Legacy one'))
            self.legacy.create(fields(project='Legacy two'))
        self.assertEqual(service.get(document['id']), document)
        recovered = service.create(fields(project='Too many'), rejected)
        self.assertEqual(len(service.list_documents()['items']), 2)
        self.assertEqual(recovered['version'], 1)

    def test_scoped_generation_and_save_budget_rejection_are_transactional_and_replay_safe(self):
        workspace, service = self.prepared()
        document = service.create(fields())
        operation = str(uuid.uuid4())
        original = service.generate(document['id'], document['fields'], 1, operation, DEFAULTS)
        frozen = service.revision_pdf(document['id'], 1)
        rejected = str(uuid.uuid4())
        with patch('estimator.certification_projects.MAX_REVISIONS', 1):
            with self.assertRaises(ValidationError):
                service.generate(document['id'], document['fields'], 2, rejected, DEFAULTS)
            self.assertEqual(service.get(document['id']), original['document'])
            self.assertEqual(service.generate(document['id'], document['fields'], 1, operation, DEFAULTS), original)
            self.capture(workspace, original['document'])
        with patch('estimator.certification_projects.MAX_METADATA_BYTES', 1):
            with self.assertRaises(ValidationError):
                service.save(document['id'], {**document['fields'], 'project': 'Rejected field update'}, 2)
        self.assertEqual(service.get(document['id']), original['document'])
        self.assertEqual(service.revision_pdf(document['id'], 1), frozen)
        # Rejected request IDs were rolled back along with tentative PDFs.
        recovered = service.generate(document['id'], document['fields'], 2, rejected, DEFAULTS)
        self.assertEqual(recovered['revision']['revision'], 2)

    def test_dedup_never_substitutes_a_good_pdf_for_corrupted_historical_bytes(self):
        frozen = pdf('IDENTICAL HISTORICAL CERTIFICATES')
        self.legacy.renderer = lambda *args, **kwargs: frozen
        source = self.legacy.create(fields())
        self.legacy.generate(source['id'], source['fields'], 1, str(uuid.uuid4()), DEFAULTS)
        self.legacy.generate(source['id'], source['fields'], 2, str(uuid.uuid4()), DEFAULTS)
        workspace, service = self.prepared()
        self.projects.import_legacy(workspace['workspace_id'], source['id'])
        damaged = frozen[:-1] + bytes([frozen[-1] ^ 1])
        with service.store.connect() as db:
            db.execute('UPDATE certification_revisions SET pdf=? WHERE document_id=? AND revision=2', (damaged, source['id']))
        with self.assertRaises(ValidationError): service.revision_pdf(source['id'], 2)
        with self.assertRaisesRegex(ValidationError, 'duplicate certificate PDF failed'):
            self.capture(workspace, service.get(source['id']))
        self.assertEqual(service.revision_pdf(source['id'], 1), frozen)
        target, target_service = self.prepared()
        with self.store.connect() as db:
            db.execute('UPDATE certification_revisions SET pdf=? WHERE document_id=? AND revision=2', (damaged, source['id']))
        with self.assertRaisesRegex(ValidationError, 'duplicate certificate PDF failed'):
            self.projects.import_legacy(target['workspace_id'], source['id'])
        self.assertEqual(target_service.list_documents(), {'items': []})


if __name__ == '__main__':
    unittest.main()
