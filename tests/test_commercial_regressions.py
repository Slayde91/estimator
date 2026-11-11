"""Independent regressions for portable numbering and HTTP project capabilities."""
from copy import deepcopy
from contextlib import nullcontext
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialDocuments, default_fields
from estimator.commercial_http import CommercialHTTP
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from tests.commercial_ready_fixtures import complete_quote, complete_work_order
if __package__:
    from .test_commercial_documents import Projects
else:
    from test_commercial_documents import Projects


class Handler:
    command = 'POST'
    path = '/api/commercial/issue'

    def __init__(self, body, capture=None):
        self.body = body
        self.headers = {}
        self.capture = capture
        self.result = None

    def read_json(self):
        return deepcopy(self.body)

    def capture_commercial_download(self, options, workspace):
        return self.capture(options, workspace)

    def send_payload(self, status, value, *args, **kwargs):
        self.result = status, value

    def send_download(self, pdf, media_type, filename, destination, **options):
        self.result = 200, {'pdf': pdf, 'filename': filename, 'destination': destination}


class CommercialRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = Projects(self.root)
        self.workspace = self.projects.add()
        self.service = CommercialDocuments(self.projects, renderer=lambda *args, **kwargs: b'%PDF-1.4 immutable test bytes')

    def create(self, kind='work_order'):
        fields = complete_quote(default_fields(kind)) if kind == 'quote' else complete_work_order(default_fields(kind)) if kind == 'work_order' else default_fields(kind)
        fields['details']['project_no'] = 'CF-TEST'
        if kind == 'work_order':
            quote = self.create('quote')
            quote = self.service.issue(self.workspace, quote['id'], quote['version'], str(uuid.uuid4()))['document']
            fields['order']['quote_id'] = quote['id']
        fields['sources'] = [{'estimate_id': 'estimate-1', 'sha256': 'a'*64}] if kind == 'quote' else []
        return self.service.save(self.workspace, {'id': str(uuid.uuid4()), 'version': 0, 'kind': kind, 'status': 'Draft', 'fields': fields})

    def test_deleted_document_highwater_survives_restore_into_fresh_database(self):
        saved = self.create()
        issued = self.service.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))
        self.service.delete(self.workspace, saved['id'], issued['document']['version'])
        snapshot = self.service.capture(self.workspace)
        self.assertFalse(any(row['kind'] == 'work_order' for row in snapshot['documents']))
        other_projects = Projects(self.root/'another-computer')
        other_workspace = other_projects.add(snapshot['project_id'])
        restored = CommercialDocuments(other_projects, renderer=self.service.renderer)
        restored.restore(other_workspace, snapshot)
        fields = complete_work_order(default_fields('work_order'))
        fields['details']['project_no'] = 'CF-TEST'
        fields['order']['quote_id'] = next(row['id'] for row in snapshot['documents'] if row['kind'] == 'quote')
        next_document = restored.save(other_workspace, {'kind': 'work_order', 'status': 'Draft', 'fields': fields})
        next_issue = restored.issue(other_workspace, next_document['id'], next_document['version'], str(uuid.uuid4()))
        self.assertEqual(issued['number'], 'WO-01')
        self.assertEqual(next_issue['number'], 'WO-02')

    def test_saved_draft_size_cache_enforces_exact_utf8_limit_and_detects_other_edits(self):
        from estimator.commercial_documents import _json
        first = self.create('quote')
        second = self.create('quote')
        def update(doc, title):
            return self.service.save(self.workspace, {**{k: doc[k] for k in ('id','kind','version','status')},
                'fields': {**doc['fields'], 'title':title}})
        first = update(first, 'Café')
        baseline = len(_json(self.service.capture(self.workspace)).encode('utf-8'))
        # An equal-byte edit fits. A second window changing a previously cached
        # draft must be reflected in the next save, and a failed edit stays atomic.
        with patch('estimator.commercial_documents.MAX_SNAPSHOT_BYTES', baseline):
            first = update(first, 'Zoës')
            with self.assertRaisesRegex(ValidationError, '8 MiB'):
                update(second, second['fields']['title'] + 'é')
        second = update(second, second['fields']['title'] + 'é')
        with patch('estimator.commercial_documents.MAX_SNAPSHOT_BYTES', baseline):
            with self.assertRaisesRegex(ValidationError, '8 MiB'):
                update(first, 'Zoës')
        self.assertEqual({doc['id']:doc['version'] for doc in self.service.capture(self.workspace)['documents']},
                         {first['id']:first['version'], second['id']:second['version']})

    def test_existing_workspace_can_load_while_another_save_owns_the_write_lock(self):
        saved = self.create('quote')
        with self.service._connect() as writer, self.service._connect() as reader:
            writer.execute('BEGIN IMMEDIATE')
            reader.execute('PRAGMA query_only=ON')
            with patch.object(self.service, '_connect', return_value=nullcontext(reader)):
                self.assertEqual(self.service.capture(self.workspace)['documents'], [saved])

    def test_editor_and_project_snapshot_routes_return_the_same_portable_documents(self):
        self.create('quote')
        http = CommercialHTTP(self.service)
        def get(action, extra=''):
            route = '/api/commercial/' + action
            handler = Handler({})
            handler.command, handler.path = 'GET', route + '?workspace=' + self.workspace + extra
            self.assertTrue(http.dispatch(handler, route))
            self.assertEqual(handler.result[0], 200)
            return handler.result[1]
        compact = get('state', '&compact=1')
        self.assertIsNone(compact['snapshot']['documents'])
        compact['snapshot']['documents'] = compact['documents']
        self.assertEqual(compact, get('state'))
        self.assertEqual(compact['snapshot'], get('snapshot'))

    def test_http_exact_retry_after_delete_uses_original_pdf_without_derivation(self):
        saved = self.create('quote')
        calls = []

        def derive(body, include_pdfs=False):
            calls.append(body)
            return {'sources': saved['fields']['sources'], 'scope_documents': []}

        adapter = CommercialHTTP(self.service, derive=derive)
        body = {'workspace_id': self.workspace, 'id': saved['id'], 'kind': 'quote', 'version': saved['version'],
                'request_id': str(uuid.uuid4()), 'estimates': [], 'active_estimate_id': 'estimate-1'}
        first = Handler(body)
        adapter.dispatch(first, first.path)
        self.assertEqual(first.result[0], 200)
        latest = self.service.view(self.workspace)['documents'][0]
        self.service.delete(self.workspace, saved['id'], latest['version'])
        retry = Handler(body)
        adapter.dispatch(retry, retry.path)
        self.assertEqual(retry.result, first.result)
        self.assertEqual(len(calls), 1)
        altered = Handler({**body, 'active_estimate_id': 'different-estimate'})
        adapter.dispatch(altered, altered.path)
        self.assertEqual(altered.result[0], 409)
        self.assertEqual(len(calls), 1)

    def test_http_rejects_valid_download_token_from_another_project(self):
        store = Store(self.root/'projects.sqlite3')
        store.set_project_folder(self.root)
        files = {}
        for name, project_id in [('own', self.projects.project_id(self.workspace)), ('other', str(uuid.uuid4()))]:
            snapshot = json.loads(export_project(store, {'estimate': {'title': name}}))
            snapshot['certifications'] = {'version': 1, 'project_id': project_id, 'archive_sha256': 'a'*64,
                'archive_size': 1, 'document_count': 0, 'revision_count': 0,
                'companion_folder': f'.ceasefire-evidence/{project_id}/certifications'}
            (self.root/(name+'.cf.json')).write_text(json.dumps(snapshot), encoding='utf-8')
        library = ProjectLibrary(store)
        self.addCleanup(library.close)
        # A scan may yield after the first file, including in small project folders.
        with patch('estimator.project_library.MAX_PROJECT_FILES', 1):
            listing = library.listing()
            self.assertTrue(listing['scan_pending'])
            for _ in range(100):
                listing = library.listing()
                if not listing['scan_pending']:
                    break
        self.assertFalse(listing['scan_pending'])
        self.assertEqual(listing['errors'], [])
        for item in listing['files']:
            files[Path(item['name']).name] = library.load(item['id'])['file']
        self.assertEqual(set(files), {'own.cf.json', 'other.cf.json'})
        saved = self.create()
        body = {'workspace_id': self.workspace, 'id': saved['id'], 'kind': 'work_order', 'version': saved['version'],
                'request_id': str(uuid.uuid4()), 'download': {'project_token': files['other.cf.json']['save_token']}}
        capture = lambda options, workspace: library.capture_download(options, project_id=self.projects.project_id(workspace))
        handler = Handler(body, capture)
        adapter = CommercialHTTP(self.service)
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 400)
        self.assertIn('different project', handler.result[1]['error'])
        self.assertEqual(self.service.capture(self.workspace)['number_counters']['work_order'], 0)
        with self.assertRaises(ValidationError):
            library.capture_download({'project_token': None}, project_id=self.projects.project_id(self.workspace))
        body['download']['project_token'] = files['own.cf.json']['save_token']
        accepted = Handler(body, capture)
        adapter.dispatch(accepted, accepted.path)
        self.assertEqual(accepted.result[0], 200)
        self.assertEqual(accepted.result[1]['filename'], 'Work-Order-WO-01-R2.pdf')


if __name__ == '__main__':
    unittest.main()
