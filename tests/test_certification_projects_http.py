"""HTTP project membership, explicit recovery and native save/reopen contracts."""
import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid

from estimator.native_dialogs import SaveSelection
from estimator.project_file import export_project
from estimator.server import create_server
from estimator.storage import Store
import test_certification_http as helpers
from test_certification_projects import fields
from test_project_library import Chooser


class CertificationProjectsHTTPTests(unittest.TestCase):
    request = helpers.CertificationHTTPTests.request
    json = helpers.CertificationHTTPTests.json

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.database = self.root / 'state.sqlite3'
        self.chooser = Chooser()
        self.server = create_server(0, self.database, project_dialogs=self.chooser, library_directory=self.root / 'library')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def test_scoped_membership_required_new_generation_and_explicit_legacy_recovery(self):
        first = self.json('POST', '/api/certifications/workspaces', {}, expected=201)
        second = self.json('POST', '/api/certifications/workspaces', {}, expected=201)
        a, b = '?workspace=' + first['workspace_id'], '?workspace=' + second['workspace_id']
        legacy = self.json('POST', '/api/certifications', {'fields': fields(project='Older certificate')}, expected=201)
        self.assertEqual(self.json('GET', '/api/certifications' + a), {'items': []})
        self.assertEqual(self.json('GET', '/api/certifications/legacy')['items'][0]['id'], legacy['id'])
        doc = self.json('POST', '/api/certifications' + a, {'fields': fields()}, expected=201)
        path = '/api/certifications/' + doc['id']
        self.assertEqual(self.request('GET', path + b)[0], 404)
        self.assertEqual(self.request('GET', path)[0], 404)
        self.assertEqual(self.request('GET', path + a + '&workspace=' + second['workspace_id'])[0], 400)
        request = {'fields': {**doc['fields'], 'location_area': '  '}, 'expected_version': 1, 'request_id': str(uuid.uuid4())}
        self.assertEqual(self.request('POST', path + '/revisions' + a, request)[0], 400)
        self.assertEqual(self.json('GET', path + a)['version'], 1)
        request.update(fields=doc['fields'], request_id=str(uuid.uuid4()))
        generated = self.json('POST', path + '/revisions' + a, request, expected=201)
        url = generated['revision']['pdf_url']
        self.assertTrue(url.endswith(a))
        self.assertEqual(self.request('GET', url)[0], 200)
        self.assertEqual(self.request('GET', url.replace(a, b))[0], 404)
        importing = '/api/certifications/workspaces/' + first['workspace_id'] + '/import'
        imported = self.json('POST', importing, {'document_id': legacy['id']})
        self.assertFalse(imported['already_imported'])
        self.assertTrue(self.json('POST', importing, {'document_id': legacy['id']})['already_imported'])
        self.assertEqual(len(self.json('GET', '/api/certifications' + a)['items']), 2)
        self.assertEqual(self.json('GET', '/api/certifications' + b), {'items': []})
        self.assertEqual(self.json('GET', '/api/certifications/' + legacy['id']), legacy)

    def test_native_save_reopen_retains_draft_and_revisions_cancellation_and_missing_companion(self):
        workspace = self.json('POST', '/api/certifications/workspaces', {}, expected=201)
        scope = '?workspace=' + workspace['workspace_id']
        document = self.json('POST', '/api/certifications' + scope, {'fields': fields()}, expected=201)
        generated = self.json('POST', '/api/certifications/' + document['id'] + '/revisions' + scope,
            {'fields': document['fields'], 'expected_version': 1, 'request_id': str(uuid.uuid4())}, expected=201)
        frozen = self.request('GET', generated['revision']['pdf_url'])[2]
        capture = {'workspace_id': workspace['workspace_id'], 'draft': {'id': document['id'], 'version': 2,
                   'fields': {**document['fields'], 'location_area': 'Uncommitted current UI field'}, 'options': document['options']}}
        request = {'estimate': {'title': 'Alpha'}, 'certifications': capture}
        # A cancelled native save creates neither a project JSON nor companion.
        self.assertEqual(self.json('POST', '/api/project/save-as', request), {'cancelled': True})
        self.assertFalse((self.root / '.ceasefire-evidence').exists())
        target = self.root / 'Alpha.cf.json'
        self.chooser.selection = SaveSelection(str(target), None)
        saved = self.json('POST', '/api/project/save-as', request)
        self.assertTrue(target.is_file())
        protected = target.read_bytes()
        incomplete_save = {'save_token': saved['file']['save_token'], 'estimate': saved['project']['estimate'],
                           'calculators': {key: {'inputs': value['inputs'], 'schedule_rows': value.get('schedule_rows')}
                                           for key, value in saved['project']['calculators'].items()}}
        self.assertEqual(self.request('POST', '/api/project/save', incomplete_save)[0], 400)
        self.assertEqual(target.read_bytes(), protected, 'An older window cannot omit certificate membership while overwriting a project')
        manifest = json.loads(target.read_text('utf-8'))['certifications']
        self.assertNotIn('workspace_id', manifest)
        archive = self.root / manifest['companion_folder'] / (manifest['archive_sha256'] + '.zip')
        self.assertTrue(archive.is_file())
        self.chooser.opened = str(target)
        reopened = self.json('POST', '/api/project/open', {})
        self.assertNotEqual(reopened['certification_workspace_id'], workspace['workspace_id'])
        restored = self.json('GET', '/api/certifications/workspaces/' + reopened['certification_workspace_id'])
        self.assertEqual(restored['draft']['fields']['location_area'], 'Uncommitted current UI field')
        restored_doc = self.json('GET', '/api/certifications/' + document['id'] + '?workspace=' + restored['workspace_id'])
        self.assertEqual(self.request('GET', restored_doc['revisions'][0]['pdf_url'])[2], frozen)
        # A browser-only upload cannot silently omit the companion's evidence.
        self.json('POST', '/api/project/import', {'filename': target.name,
                  'content_base64': base64.b64encode(target.read_bytes()).decode()}, expected=400)
        archive.unlink()
        self.assertEqual(self.request('POST', '/api/project/open', {})[0], 400)
        self.assertEqual(self.request('GET', generated['revision']['pdf_url'])[2], frozen)

    def test_older_project_without_certificates_still_opens_empty_and_cancel_drops_only_prepared(self):
        legacy = self.json('POST', '/api/certifications', {'fields': fields()}, expected=201)
        target = self.root / 'Older.cf.json'
        target.write_bytes(export_project(Store(self.database), {'estimate': {'title': 'Older'}}))
        self.chooser.opened = str(target)
        opened = self.json('POST', '/api/project/open', {})
        workspace = opened['certification_workspace_id']
        self.assertEqual(self.json('GET', '/api/certifications?workspace=' + workspace), {'items': []})
        self.json('POST', '/api/certifications/workspaces/' + workspace + '/discard', {})
        self.assertEqual(self.request('GET', '/api/certifications?workspace=' + workspace)[0], 400)
        self.assertEqual(self.json('GET', '/api/certifications/' + legacy['id']), legacy)


if __name__ == '__main__':
    unittest.main()
