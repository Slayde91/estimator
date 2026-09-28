"""Controlled draft graph edits, image provenance and revision races."""

from copy import deepcopy
from contextlib import ExitStack
import json
from pathlib import Path
from threading import Event, Thread
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import digest, validate_snapshot
from tests import test_takeoff_workspace as workspace_fixtures


class Images:
    def __init__(self):
        self.blocked = False; self.calls = 0; self.manifests = {}; self.entered = None; self.release = None; self.read_ids = []

    def extract(self, document, first_page, page_count):
        self.calls += 1
        if self.entered:
            self.entered.set(); self.release.wait(10)
        identifier, asset, occurrence = (str(uuid4()) for _ in range(3))
        issue = {'code': 'UNSUPPORTED_APPEARANCE', 'message': 'A retained diagnostic appearance needs review.'}
        manifest = {'assets': [{'id': asset, 'rendition': {'sha256': 'b'*64}, 'issues': [issue]}],
            'occurrences': [{'id': occurrence, 'asset_id': asset, 'page': first_page,
                'quad_pdf': [[20, 30], [30, 30], [30, 40], [20, 40]],
                'appearance_status': 'unverified', 'issues': [issue]}],
            'pages': [{'page': first_page, 'status': 'partial', 'occurrence_ids': [occurrence], 'issues': [issue]}],
            'coverage': {'requested_pages': [first_page], 'processed_pages': [first_page],
                         'complete_pages': [], 'failed_pages': [first_page], 'unrequested_pages': []}, 'issues': [issue]}
        self.manifests[identifier] = manifest
        return {'id': identifier, 'document_id': document['id'], 'source_sha256': document['sha256'],
                'manifest_sha256': digest(manifest), 'manifest_size': 100, 'total_bytes': 1000, 'pages': [first_page]}

    def read(self, descriptor, document, verify_assets=False):
        self.read_ids.append(descriptor['id'])
        if self.blocked:
            raise ValidationError('Changed image bytes.')
        return deepcopy(self.manifests[descriptor['id']])

    def registered(self, descriptor):
        return True

    def assert_evidence(self, descriptors, documents, owner=None, require_registered=False):
        if self.blocked:
            raise ValidationError('Changed image bytes.')

    def rendition(self, descriptor, document, asset_id, owner=None):
        self.assert_evidence([descriptor], [document], owner)
        if not any(asset['id'] == asset_id for asset in self.manifests[descriptor['id']]['assets']):
            raise ValidationError('Unknown image asset.')
        return b'fixture image bytes', 'image/png'


class PhysicalWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.case = workspace_fixtures.TakeoffWorkspaceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.service, self.sid = self.case.service, self.case.sid
        self.images = Images(); self.case.documents.images = self.images

    def state(self):
        return self.service.get(self.sid, verify_evidence=False)

    def barrier(self, identifier=None, evidence=None):
        return {'op': 'create', 'kind': 'barrier', 'entity': {'id': identifier or str(uuid4()),
            'fields': {'label': 'B1', 'substrate': 'Concrete'}, 'evidence': evidence or [],
            'uncertainty': {'state': 'unresolved', 'note': 'Draft source assertion'}}}

    def apply(self, commands):
        before = self.state()
        preview = self.service.preview_physical(self.sid, {'expected_revision': before['revision'], 'commands': commands})
        request = {'expected_revision': before['revision'], 'request_id': str(uuid4()), 'preview_id': preview['preview_id']}
        return self.service.apply_physical(self.sid, request), request

    def extract(self):
        request = {'expected_revision': self.state()['revision'], 'request_id': str(uuid4()),
                   'document_id': self.case.doc['id'], 'first_page': 1, 'page_count': 1}
        return self.service.extract_images(self.sid, request), request

    def test_first_physical_apply_upgrades_with_actor_audit_and_idempotent_replay(self):
        before = self.state(); command = self.barrier()
        result, request = self.apply([command])
        self.assertEqual(before['snapshot']['version'], 1)
        self.assertEqual(result['snapshot']['version'], 2)
        self.assertEqual(result['revision'], before['revision']+1)
        self.assertEqual(result['snapshot']['physical']['barriers'][0]['id'], command['entity']['id'])
        event = self.case.documents.get_blob(result['snapshot']['audit_head'])
        self.assertEqual(event['version'], 2)
        self.assertEqual(event['before']['version'], 1)
        self.assertEqual(event['op'], 'apply_physical')
        self.assertEqual(event['affected_ids']['physical'], [command['entity']['id']])
        self.assertEqual(event['actor']['session_id'], self.sid)
        self.assertEqual(self.service.apply_physical(self.sid, request), result)
        self.assertEqual(validate_snapshot(result['snapshot']), result['snapshot'])

    def test_preview_is_read_only_and_stale_or_other_session_preview_is_rejected(self):
        before = self.state()
        preview = self.service.preview_physical(self.sid, {'expected_revision': before['revision'], 'commands': [self.barrier()]})
        self.assertEqual(self.state(), before)
        other = self.service.open()
        with self.assertRaises(ValidationError):
            self.service.apply_physical(other['session_id'], {'expected_revision': 0, 'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        self.apply([self.barrier()])
        with self.assertRaises(ValidationError):
            self.service.apply_physical(self.sid, {'expected_revision': before['revision'], 'request_id': str(uuid4()), 'preview_id': preview['preview_id']})

    def test_request_identity_cannot_be_reused_for_different_operation_and_replay_returns_current(self):
        first, request = self.apply([self.barrier()])
        second, _ = self.apply([self.barrier()])
        replay = self.service.apply_physical(self.sid, request)
        self.assertEqual(replay['snapshot'], second['snapshot'])
        with self.assertRaises(ValidationError):
            self.service.apply_physical(self.sid, {**request, 'preview_id': str(uuid4())})
        self.assertGreater(second['revision'], first['revision'])

    def test_image_extraction_inventory_is_diagnostic_idempotent_and_tuple_bound(self):
        result, request = self.extract()
        self.assertEqual(result['snapshot']['version'], 2)
        self.assertIsNone(result['snapshot']['physical'])
        self.assertEqual(self.service.extract_images(self.sid, request), result)
        self.assertEqual(self.images.calls, 1)
        inventory = self.service.images(self.sid)
        self.assertEqual(inventory['extractions'][0]['page_results'][0]['status'], 'partial')
        image = inventory['items'][0]
        self.assertEqual(image['appearance_status'], 'unverified')
        self.assertEqual(len(image['issues']), 1)
        reference = {key: image[key] for key in ('document_id', 'document_sha256', 'page', 'image_id', 'image_sha256', 'occurrence_id')}
        reference['region'] = [[21, 31], [22, 31], [22, 32]]
        applied, _ = self.apply([self.barrier(evidence=[reference])])
        self.assertEqual(applied['snapshot']['physical']['state'], 'draft')
        for key, value in (('image_sha256', 'c'*64), ('occurrence_id', str(uuid4())), ('image_id', str(uuid4()))):
            changed = {**reference, key: value}
            with self.subTest(key=key), self.assertRaises(ValidationError):
                self.apply([self.barrier(evidence=[changed])])
        self.assertEqual(self.service.image_file(self.sid, image['extraction_id'], image['asset_id']), (b'fixture image bytes', 'image/png'))

    def test_image_or_source_tamper_blocks_apply_inventory_file_export_and_cached_apply(self):
        self.extract(); inventory = self.service.images(self.sid); image = inventory['items'][0]
        reference = {key: image[key] for key in ('document_id', 'document_sha256', 'page', 'image_id', 'image_sha256', 'occurrence_id')}
        self.apply([self.barrier(evidence=[reference])])
        before = self.state()
        preview = self.service.preview_physical(self.sid, {'expected_revision': before['revision'], 'commands': [self.barrier()]})
        request = {'expected_revision': before['revision'], 'request_id': str(uuid4()), 'preview_id': preview['preview_id']}
        self.images.blocked = True
        actions = (lambda: self.service.apply_physical(self.sid, request), lambda: self.service.images(self.sid),
                   lambda: self.service.image_file(self.sid, image['extraction_id'], image['asset_id']),
                   lambda: self.service.export_physical(self.sid, 'csv'),
                   lambda: self.service.capture(self.sid, before['snapshot']))
        for action in actions:
            with self.assertRaises(ValidationError): action()
        self.assertEqual(self.state(), before)
        self.images.blocked = False
        result = self.service.apply_physical(self.sid, request)
        self.case.documents.blocked = True
        with self.assertRaises(ValidationError): self.service.apply_physical(self.sid, request)
        self.assertEqual(self.state()['snapshot'], result['snapshot'])

    def test_inventory_is_scoped_and_pagination_never_silently_drops_occurrences(self):
        first, _ = self.extract(); second, _ = self.extract()
        identifier = second['extraction_id']; manifest = self.images.manifests[identifier]
        template = manifest['occurrences'][0]
        manifest['occurrences'] = [{**deepcopy(template), 'id': str(uuid4())} for _ in range(205)]
        self.images.read_ids.clear()
        pages = [self.service.images(self.sid, identifier, offset, 100) for offset in (0, 100, 200)]
        self.assertEqual([len(page['items']) for page in pages], [100, 100, 5])
        self.assertEqual([page['has_more'] for page in pages], [True, True, False])
        self.assertEqual({page['total'] for page in pages}, {205})
        self.assertEqual(self.images.read_ids, [identifier]*3)
        self.assertNotEqual(identifier, first['extraction_id'])
        with self.assertRaises(ValidationError): self.service.images(self.sid, identifier, 0, 101)

    def test_source_marker_clipping_omits_outside_or_degenerate_regions(self):
        from estimator.takeoff_workspace import image_annotation_region
        self.assertIsNone(image_annotation_region([[0, 0], [1, 0], [1, 1], [0, 1]], [2, 2, 3, 3]))
        self.assertIsNone(image_annotation_region([[0, 0], [1, 0], [2, 0], [3, 0]], [0, 0, 3, 3]))
        quad = [[1, 1], [2, 1], [2, 2], [1, 2]]
        self.assertEqual(image_annotation_region(quad, [0, 0, 3, 3]), quad)

    def test_extract_releases_global_lock_and_stale_completion_cannot_mutate_draft(self):
        self.images.entered, self.images.release = Event(), Event()
        errors = []
        def run():
            try: self.extract()
            except Exception as error: errors.append(error)
        thread = Thread(target=run); thread.start()
        self.assertTrue(self.images.entered.wait(3))
        try:
            # Both another session and this session remain responsive while
            # the simulated child is held outside the workspace lock.
            other = self.service.open(); self.assertEqual(self.service.get(other['session_id'])['revision'], 0)
            current, _ = self.apply([self.barrier()])
        finally:
            self.images.release.set(); thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1); self.assertIsInstance(errors[0], ValidationError)
        self.assertEqual(self.state()['snapshot'], current['snapshot'])
        self.assertEqual(self.service._image_jobs, set())

    def test_closing_session_during_extraction_prevents_late_commit(self):
        self.images.entered, self.images.release = Event(), Event(); errors = []
        def run():
            try: self.extract()
            except Exception as error: errors.append(error)
        thread = Thread(target=run); thread.start(); self.assertTrue(self.images.entered.wait(3))
        self.service.close(self.sid); self.images.release.set(); thread.join(5)
        self.assertFalse(thread.is_alive()); self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValidationError)
        self.assertEqual(self.service._image_jobs, set())

    def test_delete_document_rejects_image_history_or_physical_tombstone_references(self):
        reference = {'document_id': self.case.doc['id'], 'document_sha256': self.case.doc['sha256'], 'page': 1}
        command = self.barrier(evidence=[reference]); self.apply([command])
        self.apply([{'op': 'delete', 'entity_id': command['entity']['id'], 'cascade': False}])
        request = {'op': 'delete_document', 'expected_revision': self.state()['revision'], 'request_id': str(uuid4()), 'document_id': self.case.doc['id']}
        with self.assertRaisesRegex(ValidationError, 'tombstones'):
            self.service.command(self.sid, request)
        self.extract()
        with self.assertRaisesRegex(ValidationError, 'extraction history'):
            self.service.command(self.sid, {**request, 'expected_revision': self.state()['revision'], 'request_id': str(uuid4())})

    def test_undo_first_physical_creation_preserves_ids_as_tombstones_and_v2(self):
        command = self.barrier(); self.apply([command])
        result = self.service.command(self.sid, {'op': 'undo', 'expected_revision': self.state()['revision'], 'request_id': str(uuid4())})
        graph = result['snapshot']['physical']
        self.assertEqual(result['snapshot']['version'], 2)
        self.assertEqual(graph['revision'], 2)
        self.assertEqual(graph['barriers'][0]['id'], command['entity']['id'])
        self.assertTrue(graph['barriers'][0]['deleted'])
        self.assertEqual(graph['barriers'][0]['revision'], 2)
        with self.assertRaises(ValidationError): self.apply([command])

    def test_undo_updates_and_legacy_edits_keep_graph_revisions_and_retained_images(self):
        self.extract(); command = self.barrier(); self.apply([command])
        identifier = command['entity']['id']
        self.apply([{'op': 'update', 'entity_id': identifier, 'changes': {'fields': {'label': 'Changed'}}}])
        result = self.service.command(self.sid, {'op': 'undo', 'expected_revision': self.state()['revision'], 'request_id': str(uuid4())})
        graph = result['snapshot']['physical']; self.assertEqual(graph['barriers'][0]['fields']['label'], 'B1')
        self.assertEqual(graph['revision'], 3); self.assertEqual(graph['barriers'][0]['revision'], 3)
        self.assertEqual(len(result['snapshot']['image_extractions']), 1)
        self.case.state = result
        self.case.create()
        result = self.service.command(self.sid, {'op': 'undo', 'expected_revision': self.state()['revision'], 'request_id': str(uuid4())})
        self.assertEqual(result['snapshot']['physical'], graph)
        self.assertEqual(len(result['snapshot']['image_extractions']), 1)

    def test_extraction_cannot_be_undone_and_diagnostic_export_is_not_approval(self):
        self.extract()
        with self.assertRaises(ValidationError):
            self.service.command(self.sid, {'op': 'undo', 'expected_revision': self.state()['revision'], 'request_id': str(uuid4())})
        self.apply([self.barrier()])
        payload, mime, filename = self.service.export_physical(self.sid, 'csv')
        self.assertIn(b'UNAPPROVED DRAFT', payload); self.assertIn('DRAFT', filename)
        self.assertIn(b'UNVERIFIED ASSERTIONS', payload)
        self.assertEqual(self.state()['snapshot']['physical']['state'], 'draft')

    def test_intact_foreign_registry_reopen_remains_diagnostic_and_can_save_as_or_reextract(self):
        from estimator.native_dialogs import SaveSelection
        from estimator.project_file import export_project
        from estimator.project_library import ProjectLibrary
        from estimator.storage import Store
        from estimator.takeoff_documents import TakeoffDocuments
        from estimator.takeoff_workspace import TakeoffService
        from tests.test_takeoff_images_worker import make_pdf
        from tests.test_takeoff_receipts_integration import Dialogs
        root = Path(self.case.directory.name)
        with ExitStack() as resources:
            documents = TakeoffDocuments(root/'local-evidence'); resources.callback(documents.close)
            service = TakeoffService(self.case.store, documents)
            state = service.open(); sid = state['session_id']; payload = make_pdf()
            upload = documents.begin_upload(sid, 'synthetic.pdf', len(payload))
            documents.write_chunk(sid, upload['upload_id'], 0, payload)
            document = documents.finish_upload(sid, upload['upload_id'])
            state = service.add_document(sid, document, state['revision'])
            state = service.extract_images(sid, {'expected_revision': state['revision'], 'request_id': str(uuid4()),
                'document_id': document['id'], 'first_page': 1, 'page_count': 1})
            descriptor = state['snapshot']['image_extractions'][0]
            dialogs = Dialogs(); library = ProjectLibrary(self.case.store, dialogs, takeoffs=service)
            resources.callback(library.close)
            target = root/'original.json'; dialogs.selection = SaveSelection(str(target), None)
            baseline = json.loads(export_project(self.case.store, {'estimate': {'title': 'Synthetic portable image test'}}))
            calculators = {key: {field: value[field] for field in ('inputs', 'schedule_rows')} for key, value in baseline['calculators'].items()}
            library.save_as({'estimate': baseline['estimate'], 'calculators': calculators,
                'takeoffs': state['snapshot'], 'takeoffs_session_id': sid})
            saved = json.loads(target.read_bytes())['takeoffs']
            foreign_store = Store(root/'foreign.sqlite3')
            foreign_docs = TakeoffDocuments(root/'foreign-evidence'); resources.callback(foreign_docs.close)
            foreign = TakeoffService(foreign_store, foreign_docs)
            reopened = foreign.open(saved, source_path=target); foreign_sid = reopened['session_id']
            self.assertIn('IMAGE_EXTRACTION_UNREGISTERED', {issue['code'] for issue in reopened['issues']})
            self.assertFalse(foreign_docs.images.registered(descriptor))
            self.assertEqual(len(foreign.images(foreign_sid)['items']), 1)
            foreign.capture(foreign_sid, reopened['snapshot'])
            foreign_dialogs = Dialogs(); foreign_library = ProjectLibrary(foreign_store, foreign_dialogs, takeoffs=foreign)
            resources.callback(foreign_library.close)
            destination = root/'copied.json'; foreign_dialogs.selection = SaveSelection(str(destination), None)
            result = foreign_library.save_as({'estimate': baseline['estimate'], 'calculators': calculators,
                'takeoffs': reopened['snapshot'], 'takeoffs_session_id': foreign_sid})
            self.assertFalse(result['cancelled']); self.assertTrue(destination.exists())
            self.assertFalse(foreign_docs.images.registered(descriptor))
            fresh = foreign.extract_images(foreign_sid, {'expected_revision': reopened['revision'], 'request_id': str(uuid4()),
                'document_id': document['id'], 'first_page': 1, 'page_count': 1})
            self.assertEqual(len(fresh['snapshot']['image_extractions']), 2)
            self.assertTrue(foreign_docs.images.registered(fresh['snapshot']['image_extractions'][-1]))
            self.assertFalse(foreign_docs.images.registered(descriptor))
