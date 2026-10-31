"""Immutable project export history never guesses ownership from filenames."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import stat
import tempfile
from threading import Barrier
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from openpyxl import Workbook

from estimator.catalog import ValidationError
from estimator.certification import CertificationService
from estimator.certification_projects import CertificationProjects
from estimator.documentation_catalog import document_catalog
from estimator.native_dialogs import SaveSelection
from estimator.project_documentation import (ProjectDocumentation, DocumentationConflict,
    DocumentationNotFound, PDF, XLSX, validate_manifest)
from estimator.project_file import export_project, load_project_bytes
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from test_certification import fields, pdf
from test_project_library import Chooser


KINDS = {'estimate': 'Estimate', 'schedule': 'Schedule', 'certification': 'Certification'}


def fingerprint(value):
    return sha256(value.encode()).hexdigest()


def workbook():
    book = Workbook(); book.active['A1'] = 'Frozen spreadsheet'
    output = BytesIO(); book.save(output); book.close()
    return output.getvalue()


class ProjectDocumentationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.store = Store(self.root / 'runtime' / 'state.sqlite3')
        self.legacy = CertificationService(self.store, renderer=lambda *args, **kwargs: pdf('CERTIFICATE'))
        self.certificates = CertificationProjects(self.legacy)
        self.docs = ProjectDocumentation(self.certificates, kinds=KINDS)
        self.workspace = self.certificates.new()['workspace_id']
        self.body = pdf('ORIGINAL FINAL PDF INCLUDING ITS COVERS')

    def record(self, *, workspace=None, kind='estimate', logical_key='current', filename='Estimate.pdf',
               media_type=PDF, payload=None, request_id=None, input_fingerprint=None):
        return self.docs.record(workspace or self.workspace, kind, logical_key, filename, media_type,
            self.body if payload is None else payload, request_id or str(uuid.uuid4()), input_fingerprint or fingerprint(str(uuid.uuid4())))

    def capture(self, workspace=None):
        workspace = workspace or self.workspace
        return self.docs.capture({'workspace_id': workspace, 'expected_revision': self.docs.view(workspace)['workspace_revision']})

    def portable(self):
        path = self.root / 'Project.cf.json'
        certificate = self.certificates.capture({'workspace_id': self.workspace, 'draft': None})
        documents = self.capture()
        self.certificates.publish(certificate, path); self.docs.publish(documents, path)
        return path, certificate, documents

    def test_revision_numbers_bind_kind_source_and_format_not_display_filename(self):
        first = self.record()
        second = self.record(filename='Renamed.pdf')
        spreadsheet = self.record(filename='Schedule.xlsx', media_type=XLSX, payload=workbook())
        other = self.record(kind='schedule')
        self.assertEqual(first['item']['document_id'], second['item']['document_id'])
        self.assertNotEqual(first['item']['document_id'], spreadsheet['item']['document_id'])
        self.assertNotEqual(first['item']['document_id'], other['item']['document_id'])
        self.assertEqual([first['item']['revision'], second['item']['revision'], spreadsheet['item']['revision'], other['item']['revision']], [1, 2, 1, 1])
        self.assertEqual(second['workspace_revision'], 2)
        self.assertEqual(self.docs.read(self.workspace, first['item']['id'])['payload'], self.body)
        self.assertEqual(self.docs.read(self.workspace, second['item']['id'])['item']['filename'], 'Renamed-R2.pdf')

    def test_actual_server_catalog_kinds_support_both_editions_and_project_main_key(self):
        for edition in ('full', 'standard'):
            rows = document_catalog(edition)
            documents = ProjectDocumentation(self.certificates, kinds={row['id']: row['label'] for row in rows}, root=self.root / ('catalog-' + edition))
            result = documents.record(self.workspace, 'estimate.summary.pdf', '', 'Estimate.pdf', PDF, self.body,
                                      str(uuid.uuid4()), fingerprint('catalog main document'))
            self.assertEqual(result['item']['logical_key'], '')
            self.assertEqual(documents.read(self.workspace, result['item']['id'])['payload'], self.body)
            snapshot = documents.capture({'workspace_id': self.workspace, 'expected_revision': 1})
            self.assertEqual(snapshot['revision_count'], 1)
        for kind in ('../escape', '.leading', 'trailing.', 'doubled..part', 'a' * 81, 'Uppercase'):
            with self.subTest(kind=kind), self.assertRaises(ValidationError):
                ProjectDocumentation(self.certificates, kinds={kind: 'Invalid'})

    def test_legacy_public_revision_names_leave_stored_metadata_and_pdf_bytes_exact(self):
        registry={row['id']:row['label'] for row in document_catalog('full')}
        documents=ProjectDocumentation(self.certificates,kinds=registry,root=self.root/'legacy-names')
        request_id=str(uuid.uuid4());stamp=fingerprint('unchanged source inputs')
        receipt=documents.record(self.workspace,'estimate.summary.pdf','','Old.pdf',PDF,self.body,request_id,stamp)
        item=receipt['item'];self.assertEqual(item['filename'],'BREAKDOWN-R1.pdf')
        current=documents._workspace(self.workspace)
        with documents._connect(current) as db:
            db.execute('UPDATE documentation_revisions SET filename=? WHERE id=?',('CEASEFIRE-Estimate.pdf',item['id']))
        before=documents._history(current)
        self.assertEqual(documents.view(self.workspace)['items'][0]['filename'],'BREAKDOWN-R1.pdf')
        self.assertEqual(documents.replay(self.workspace,request_id,stamp)['item']['filename'],'BREAKDOWN-R1.pdf')
        self.assertEqual(documents.read(self.workspace,item['id'])['payload'],self.body)
        self.assertEqual(documents._history(current),before)
        next_item=documents.record(self.workspace,'estimate.summary.pdf','','Changed caller name.pdf',PDF,self.body,str(uuid.uuid4()),fingerprint('next'))['item']
        self.assertEqual(next_item['filename'],'BREAKDOWN-R2.pdf')

    def test_frozen_full_edition_history_can_be_read_with_standard_generation_catalog(self):
        registry = {row['id']: row['label'] for row in document_catalog('full')}
        self.docs = ProjectDocumentation(self.certificates, kinds=registry)
        revision = self.record(kind='takeoff.markups.pdf', logical_key='retained-drawing')
        path, certificate, snapshot = self.portable()
        fresh_certificates = CertificationProjects(CertificationService(Store(self.root / 'standard' / 'state.sqlite3')))
        standard = ProjectDocumentation(fresh_certificates, kinds=registry)
        workspace = fresh_certificates.restore(certificate, path)['workspace_id']
        standard.restore(snapshot, workspace, path)
        available = {row['id'] for row in document_catalog('standard')}
        self.assertNotIn(revision['item']['kind'], available)
        self.assertEqual(standard.read(workspace, revision['item']['id'])['payload'], self.body)

    def test_failed_staging_never_closes_a_descriptor_reused_by_another_writer(self):
        self.docs.view(self.workspace)
        original_fdopen = os.fdopen
        descriptors = []
        @contextmanager
        def close_then_reuse(descriptor, *args, **kwargs):
            try:
                with original_fdopen(descriptor, *args, **kwargs) as stream:
                    yield stream
            finally:
                replacement = os.open(self.root / 'unrelated-writer.txt', os.O_CREAT | os.O_RDWR)
                descriptors.append((descriptor, replacement))
        try:
            with patch('estimator.project_documentation.os.fdopen', close_then_reuse):
                with self.assertRaises(ValidationError): self.record(payload=b'not a valid PDF')
            self.assertEqual(len(descriptors), 1)
            original, replacement = descriptors[0]
            self.assertEqual(replacement, original, 'The probe must decisively reuse the just-closed descriptor.')
            os.fstat(replacement)
            os.write(replacement, b'the unrelated writer still owns this descriptor')
        finally:
            for _, descriptor in descriptors:
                try: os.close(descriptor)
                except OSError: pass
        self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 0)
        self.assertEqual(list((self.docs.root / 'staging').iterdir()), [])

    def test_explicit_project_capability_isolates_same_named_documents(self):
        first = self.record()
        other = self.certificates.new()['workspace_id']
        self.assertEqual(self.docs.view(other)['items'], [])
        with self.assertRaises(DocumentationNotFound): self.docs.read(other, first['item']['id'])
        self.assertNotEqual(self.record(workspace=other)['item']['document_id'], first['item']['document_id'])
        with self.assertRaises(ValidationError): self.docs.view(str(uuid.uuid4()))
        with self.assertRaises(ValidationError): self.docs.view('../outside')
        self.certificates.discard(other)
        with self.assertRaises(ValidationError): self.docs.view(other)

    def test_committed_operation_replays_exact_bytes_and_survives_new_write_quota(self):
        request = str(uuid.uuid4()); basis = fingerprint('same semantic export inputs')
        first = self.record(request_id=request, input_fingerprint=basis)
        class MustNotRenderOrRead:
            def read(self, size): raise AssertionError('A committed replay read new renderer output')
        with patch('estimator.project_documentation.MAX_REVISIONS', 0):
            replay = self.record(request_id=request, input_fingerprint=basis, payload=MustNotRenderOrRead())
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['item'], first['item'])
        self.assertEqual(self.docs.read(self.workspace, first['item']['id'])['payload'], self.body)
        with self.assertRaises(DocumentationConflict): self.record(request_id=request, input_fingerprint=fingerprint('changed'))
        with self.assertRaises(DocumentationConflict): self.record(request_id=request, input_fingerprint=basis, kind='schedule')
        self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 1)

    def test_parallel_same_request_is_one_revision_and_parallel_new_requests_are_ordered(self):
        request = str(uuid.uuid4()); basis = fingerprint('parallel request'); gate = Barrier(4)
        def repeated(_):
            gate.wait(); return self.record(request_id=request, input_fingerprint=basis)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(repeated, range(4)))
        self.assertEqual(len({result['item']['id'] for result in results}), 1)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.record(), range(4)))
        items = self.docs.view(self.workspace)['items']
        self.assertEqual(sorted(item['revision'] for item in items), [1, 2, 3, 4, 5])
        self.assertEqual(sorted(item['sequence'] for item in items), [1, 2, 3, 4, 5])
        self.assertEqual(list((self.docs.root / 'staging').iterdir()), [])

    def test_quota_failures_roll_back_history_and_request_id_without_hiding_old_bytes(self):
        first = self.record()
        request = str(uuid.uuid4()); basis = fingerprint('reusable failed operation')
        for limit, value in (('MAX_REVISIONS', 1), ('MAX_METADATA_BYTES', 1), ('MAX_PROJECT_BYTES', 1)):
            with self.subTest(limit=limit), patch('estimator.project_documentation.' + limit, value):
                with self.assertRaises(ValidationError): self.record(request_id=request, input_fingerprint=basis)
            self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 1)
            self.assertEqual(self.docs.read(self.workspace, first['item']['id'])['payload'], self.body)
        recovered = self.record(request_id=request, input_fingerprint=basis)
        self.assertEqual(recovered['item']['revision'], 2)
        with patch('estimator.project_documentation.MAX_ARTIFACT_BYTES', 8):
            with self.assertRaises(ValidationError): self.record()
        self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 2)
        self.assertEqual(list((self.docs.root / 'staging').iterdir()), [])

    def test_same_frozen_bytes_are_deduplicated_and_corruption_never_silently_healed(self):
        first = self.record(); self.record(kind='schedule')
        manifest = self.capture()
        self.assertEqual(manifest['unique_bytes'], len(self.body))
        self.assertEqual(len(list((self.docs.root / 'blobs').iterdir())), 1)
        blob = self.docs.root / 'blobs' / (first['item']['sha256'] + '.pdf')
        blob.write_bytes(self.body[:-1] + bytes([self.body[-1] ^ 1]))
        with self.assertRaises(ValidationError): self.docs.read(self.workspace, first['item']['id'])
        with self.assertRaises(ValidationError): self.capture()
        with self.assertRaises(ValidationError):
            self.record(request_id=self._request_id(first), input_fingerprint=self._basis(first))

    def _request_id(self, receipt):
        with self.docs._connect(self.docs._workspace(self.workspace)) as db:
            return db.execute('SELECT request_id FROM documentation_revisions WHERE id=?', (receipt['item']['id'],)).fetchone()[0]

    def _basis(self, receipt):
        with self.docs._connect(self.docs._workspace(self.workspace)) as db:
            return db.execute('SELECT input_fingerprint FROM documentation_revisions WHERE id=?', (receipt['item']['id'],)).fetchone()[0]

    def test_capture_cas_rejects_history_changed_after_ui_snapshot(self):
        self.record()
        with self.assertRaises(DocumentationConflict):
            self.docs.capture({'workspace_id': self.workspace, 'expected_revision': 0})
        for value in (-1, True, '1'):
            with self.assertRaises(ValidationError): self.docs.capture({'workspace_id': self.workspace, 'expected_revision': value})

    def test_native_companion_copy_reopens_on_fresh_runtime_and_browser_cache_is_exact(self):
        first = self.record(); second = self.record(payload=pdf('LATER FROZEN PDF'))
        path, certificate, snapshot = self.portable()
        fresh_certificates = CertificationProjects(CertificationService(Store(self.root / 'fresh' / 'state.sqlite3')))
        fresh_docs = ProjectDocumentation(fresh_certificates, kinds=KINDS)
        workspace = fresh_certificates.restore(certificate, path)['workspace_id']
        with self.assertRaisesRegex(ValidationError, 'not cached locally'): fresh_docs.restore(snapshot, workspace)
        reopened = fresh_docs.restore(snapshot, workspace, path)
        self.assertEqual(reopened['workspace_revision'], 2)
        self.assertEqual(fresh_docs.read(workspace, first['item']['id'])['payload'], self.body)
        self.assertEqual(fresh_docs.read(workspace, second['item']['id'])['item']['sha256'], second['item']['sha256'])
        copied = self.root / 'copied' / 'Copied.cf.json'; copied.parent.mkdir()
        fresh_docs.publish(snapshot, copied); fresh_certificates.publish(certificate, copied)
        another = fresh_certificates.restore(certificate, copied)['workspace_id']
        fresh_docs.restore(snapshot, another, copied)
        self.assertEqual(fresh_docs.read(another, first['item']['id'])['payload'], self.body)
        cached_scope = fresh_certificates.restore(certificate)['workspace_id']
        fresh_docs.restore(snapshot, cached_scope)
        self.assertEqual(fresh_docs.view(cached_scope)['workspace_revision'], 2)
        manifest_file = path.parent / snapshot['companion_folder'] / (snapshot['manifest_sha256'] + '.json')
        manifest_file.unlink()
        isolated = fresh_certificates.restore(certificate, path)['workspace_id']
        with self.assertRaises(ValidationError): fresh_docs.restore(snapshot, isolated, path)
        self.assertEqual(fresh_docs.view(isolated)['items'], [])

    def test_restore_never_replaces_active_history_or_accepts_other_project_identity(self):
        first = self.record(); path, certificate, original = self.portable()
        self.record()
        with self.assertRaises(DocumentationConflict): self.docs.restore(original, self.workspace, path)
        self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 2)
        other = self.certificates.new()['workspace_id']
        with self.assertRaises(DocumentationConflict): self.docs.restore(original, other, path)
        with self.assertRaises(DocumentationConflict): self.docs.restore(None, self.workspace)
        self.assertEqual(self.docs.read(self.workspace, first['item']['id'])['payload'], self.body)

    def test_certificates_are_derived_from_current_scope_and_never_duplicated_in_docs_blobs(self):
        legacy = self.legacy.create(fields(project='Unassigned global'))
        service = self.certificates.service(self.workspace)
        document = service.create(fields(project='Current project'))
        generated = service.generate(document['id'], document['fields'], 1, str(uuid.uuid4()), self.store.company_settings())
        frozen = service.revision_pdf(document['id'], 1)
        view = self.docs.view(self.workspace)
        self.assertEqual(view['workspace_revision'], 0)
        self.assertEqual(len(view['items']), 1)
        item = view['items'][0]
        self.assertEqual(item['source'], 'certification')
        self.assertEqual(item['logical_key'], document['id'])
        self.assertEqual(item['sha256'], generated['revision']['sha256'])
        self.assertEqual(self.docs.read(self.workspace, item['id'])['payload'], frozen)
        manifest = self.capture()
        self.assertEqual(manifest['revision_count'], 0); self.assertEqual(manifest['unique_bytes'], 0)
        self.assertFalse((self.docs.root / 'blobs').exists())
        other = self.certificates.new()['workspace_id']
        self.assertEqual(self.docs.view(other)['items'], [])
        with self.assertRaises(DocumentationNotFound): self.docs.read(other, item['id'])
        with self.assertRaises(ValidationError): self.record(kind='certification')
        self.assertEqual(self.legacy.get(legacy['id']), legacy)

    def test_invalid_formats_paths_and_manifest_shapes_reject_before_state_change(self):
        for patch_values in ({'filename': '../outside.pdf'}, {'filename': 'bad\r\n.pdf'}, {'filename': 'wrong.xlsx'},
                             {'kind': 'not_registered'}, {'media_type': 'text/html'}, {'payload': b'not a pdf'},
                             {'payload': str(self.root / 'private.pdf')}, {'logical_key': '\x00'}, {'media_type': []}):
            with self.subTest(values=patch_values), self.assertRaises(ValidationError): self.record(**patch_values)
        self.assertEqual(self.docs.view(self.workspace)['items'], [])
        snapshot = self.capture()
        for changed in ({'companion_folder': '../elsewhere'}, {'project_id': '../escape'}, {'manifest_sha256': '../bad'},
                        {'revision_count': True}, {'manifest_size': -1}, {'unexpected': 'field'}):
            with self.subTest(changed=changed), self.assertRaises(ValidationError): validate_manifest({**snapshot, **changed})


    def test_project_save_reopen_cancel_omit_and_scope_binding(self):
        first = self.record()
        chooser = Chooser()
        library = ProjectLibrary(self.store, chooser, certifications=self.certificates, documentation=self.docs)
        self.addCleanup(library.close)
        captured = {'workspace_id': self.workspace, 'expected_revision': 1}
        request = {'estimate': {'title': 'Documentation project'},
                   'certifications': {'workspace_id': self.workspace, 'draft': None}, 'documentation': captured}
        self.assertEqual(library.save_as(request), {'cancelled': True})
        self.assertFalse((self.root / '.ceasefire-evidence').exists())
        target = self.root / 'Saved.cf.json'
        chooser.selection = SaveSelection(str(target), None)
        saved = library.save_as(request)
        portable = json.loads(target.read_text('utf-8'))
        self.assertIn('documentation', portable)
        self.assertNotIn('workspace_id', portable['documentation'])
        self.assertEqual(portable['documentation']['project_id'], portable['certifications']['project_id'])
        chooser.opened = str(target)
        reopened = library.open_file()
        active = reopened['certification_workspace_id']
        self.assertNotEqual(active, self.workspace)
        self.assertEqual(self.docs.read(active, first['item']['id'])['payload'], self.body)
        previous = target.read_bytes()
        stripped = {'save_token': saved['file']['save_token'], 'estimate': portable['estimate'],
                    'calculators': {key: {'inputs': value['inputs'], 'schedule_rows': value.get('schedule_rows')} for key, value in saved['project']['calculators'].items()},
                    'certifications': request['certifications']}
        with self.assertRaisesRegex(ValidationError, 'document history'): library.save(stripped)
        self.assertEqual(target.read_bytes(), previous)
        wrong = self.certificates.new()['workspace_id']
        with self.assertRaisesRegex(ValidationError, 'same explicit project workspace'):
            library.save_as({**request, 'documentation': {'workspace_id': wrong, 'expected_revision': 0}})
        with self.assertRaisesRegex(ValidationError, 'reserved'):
            library.save_attachment({'project_token': saved['file']['save_token'], 'filename': '.ceasefire-evidence', 'content_base64': base64.b64encode(b'bad shadow file').decode()})

    def test_old_project_stays_supported_and_docs_manifest_requires_matching_identity(self):
        old = export_project(self.store, {'estimate': {'title': 'Old project'}})
        self.assertNotIn('documentation', load_project_bytes(self.store, old))
        snapshot = self.capture()
        with self.assertRaisesRegex(ValidationError, 'same explicit project identity'):
            export_project(self.store, {'estimate': {'title': 'Missing identity'}, 'documentation': snapshot})
        certificate = self.certificates.capture({'workspace_id': self.workspace, 'draft': None})
        payload = export_project(self.store, {'estimate': {'title': 'Document identity'}, 'certifications': certificate, 'documentation': snapshot})
        self.assertEqual(load_project_bytes(self.store, payload)['documentation'], snapshot)
        changed = json.loads(payload); changed['documentation']['project_id'] = str(uuid.uuid4())
        changed['documentation']['companion_folder'] = '.ceasefire-evidence/' + changed['documentation']['project_id'] + '/documentation'
        with self.assertRaises(ValidationError): load_project_bytes(self.store, json.dumps(changed).encode())

    def _alter_portable_manifest(self, path, snapshot, transform=None, payload=None):
        original = path.parent / snapshot['companion_folder'] / (snapshot['manifest_sha256'] + '.json')
        if payload is None:
            value = json.loads(original.read_bytes())
            transform(value)
            payload = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        changed = {**snapshot, 'manifest_sha256': sha256(payload).hexdigest(), 'manifest_size': len(payload)}
        (original.parent / (changed['manifest_sha256'] + '.json')).write_bytes(payload)
        return changed

    def test_portable_manifest_rejects_duplicate_fields_bad_rows_and_inconsistent_counts(self):
        self.record()
        path, certificate, snapshot = self.portable()
        original = (path.parent / snapshot['companion_folder'] / (snapshot['manifest_sha256'] + '.json')).read_bytes()
        malformed = [
            self._alter_portable_manifest(path, snapshot, payload=original.replace(b'"version":1', b'"version":1,"version":1')),
            self._alter_portable_manifest(path, snapshot, lambda value: value['revisions'][0].update(kind=[])),
            self._alter_portable_manifest(path, snapshot, lambda value: value['revisions'][0].update(media_type=[])),
            self._alter_portable_manifest(path, snapshot, lambda value: value['revisions'][0].update(document_id=str(uuid.uuid4()))),
            self._alter_portable_manifest(path, snapshot, lambda value: value['revisions'][0].update(sequence=2)),
            self._alter_portable_manifest(path, snapshot, lambda value: value['revisions'][0].update(created_at='2026-10-30T10:00:00')),
            self._alter_portable_manifest(path, snapshot, lambda value: value.update(workspace_revision=True)),
            self._alter_portable_manifest(path, snapshot, payload=original + b'\n'),
            {**snapshot, 'unique_bytes': snapshot['unique_bytes'] + 1},
            {**snapshot, 'revision_count': 0},
        ]
        for candidate in malformed:
            with self.subTest(digest=candidate['manifest_sha256']):
                workspace = self.certificates.restore(certificate, path)['workspace_id']
                with self.assertRaises(ValidationError): self.docs.restore(candidate, workspace, path)
                self.assertEqual(self.docs.view(workspace)['items'], [])

    def test_missing_or_tampered_native_blob_cannot_fall_back_to_cached_bytes(self):
        first = self.record(); path, certificate, snapshot = self.portable()
        blob = path.parent / snapshot['companion_folder'] / 'blobs' / (first['item']['sha256'] + '.pdf')
        blob.unlink()
        workspace = self.certificates.restore(certificate, path)['workspace_id']
        with self.assertRaisesRegex(ValidationError, 'complete .ceasefire-evidence'): self.docs.restore(snapshot, workspace, path)
        self.assertEqual(self.docs.view(workspace)['items'], [])
        blob.write_bytes(self.body[:-1] + bytes([self.body[-1] ^ 1]))
        with self.assertRaises(ValidationError): self.docs.restore(snapshot, workspace, path)
        self.assertEqual(self.docs.view(workspace)['items'], [])
        # A verified runtime cache still restores only when no native file was selected.
        self.docs.restore(snapshot, workspace)
        self.assertEqual(self.docs.read(workspace, first['item']['id'])['payload'], self.body)

    def test_project_load_discards_prepared_capability_when_document_companion_fails(self):
        self.record(); path, certificate, snapshot = self.portable()
        path.write_bytes(export_project(self.store, {'estimate': {'title': 'Failed companion'}, 'certifications': certificate, 'documentation': snapshot}))
        chooser = Chooser(); chooser.opened = str(path)
        library = ProjectLibrary(self.store, chooser, certifications=self.certificates, documentation=self.docs)
        self.addCleanup(library.close)
        (path.parent / snapshot['companion_folder'] / (snapshot['manifest_sha256'] + '.json')).unlink()
        with patch.object(self.certificates, 'discard', wraps=self.certificates.discard) as discarded:
            with self.assertRaises(ValidationError): library.open_file()
        discarded.assert_called_once()
        with self.assertRaises(ValidationError): self.certificates.project_id(discarded.call_args.args[0])
        self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 1)

    def test_companions_refuse_symbolic_links_instead_of_following_them(self):
        self.record(); path, certificate, snapshot = self.portable()
        manifest = path.parent / snapshot['companion_folder'] / (snapshot['manifest_sha256'] + '.json')
        elsewhere = self.root / 'elsewhere.json'; elsewhere.write_bytes(manifest.read_bytes())
        manifest.unlink()
        try:
            os.symlink(elsewhere, manifest)
        except OSError:
            self.skipTest('Creating Windows symbolic links needs a privilege unavailable in this environment.')
        workspace = self.certificates.restore(certificate, path)['workspace_id']
        with self.assertRaises(ValidationError): self.docs.restore(snapshot, workspace, path)
        self.assertEqual(self.docs.view(workspace)['items'], [])

    def test_manifest_redirect_marker_is_rejected_without_reading_target_bytes(self):
        self.record(); path, certificate, snapshot = self.portable()
        manifest = path.parent / snapshot['companion_folder'] / (snapshot['manifest_sha256'] + '.json')
        workspace = self.certificates.restore(certificate, path)['workspace_id']
        actual_lstat = Path.lstat
        def redirected(candidate, *args, **kwargs):
            original = actual_lstat(candidate, *args, **kwargs)
            if candidate == manifest:
                return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
            return original
        with patch.object(Path, 'lstat', redirected):
            with self.assertRaises(ValidationError): self.docs.restore(snapshot, workspace, path)
        self.assertEqual(self.docs.view(workspace)['items'], [])

    def test_export_generated_while_save_dialog_is_open_remains_a_separate_unsaved_revision(self):
        first = self.record()
        target = self.root / 'Snapshot.cf.json'
        chooser = Chooser()
        def choose_save(*args):
            self.record(payload=pdf('GENERATED WHILE SAVE DIALOG WAS OPEN'))
            return SaveSelection(str(target), None)
        chooser.choose_save = choose_save
        library = ProjectLibrary(self.store, chooser, certifications=self.certificates, documentation=self.docs)
        self.addCleanup(library.close)
        saved = library.save_as({'estimate': {'title': 'Snapshot'},
            'certifications': {'workspace_id': self.workspace, 'draft': None},
            'documentation': {'workspace_id': self.workspace, 'expected_revision': 1}})
        self.assertEqual(saved['project']['documentation']['revision_count'], 1)
        self.assertEqual(self.docs.view(self.workspace)['workspace_revision'], 2)
        chooser.opened = str(target)
        reopened = library.open_file()
        self.assertEqual(self.docs.view(reopened['certification_workspace_id'])['workspace_revision'], 1)
        self.assertEqual(self.docs.read(reopened['certification_workspace_id'], first['item']['id'])['payload'], self.body)


if __name__ == '__main__':
    unittest.main()
