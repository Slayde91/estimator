"""Only a trusted file Save/Load, never browser identity fields, permits creation."""
import base64
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from uuid import uuid4

from feature_client import StaffConnection
from estimator.certification import CertificationService, FIELDS
from estimator.certification_projects import PROJECT_REQUIRED
from estimator.commercial_documents import default_fields as commercial_fields
from estimator.native_dialogs import SaveSelection
from estimator.project_file import ESTIMATE_FIELDS, export_project
from estimator.server import create_server
from estimator.storage import Store
from estimator.swms import default_fields as swms_fields
from test_project_library import complete_missing_metadata


class Dialogs:
    def __init__(self, path):
        self.path, self.cancel = path, False

    def choose_save(self, *args):
        return None if self.cancel else SaveSelection(str(self.path), None)

    def choose_open(self, *args):
        return str(self.path)


class ProjectDocumentGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as folder:
            source = json.loads(export_project(Store(Path(folder) / 'source.sqlite3'), {'estimate': {'client': 'Guard Company'}}))
        cls.request_template = {'estimate': source['estimate'], 'calculators': {
            key: {name: row[name] for name in ('inputs', 'schedule_rows') if name in row}
            for key, row in source['calculators'].items()}}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.dialogs = Dialogs(self.root / 'Guard.cf.json')
        self.database = self.root / 'state.sqlite3'
        self.server = create_server(0, self.database, project_dialogs=self.dialogs, library_directory=self.root / 'library')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.fields = dict.fromkeys(FIELDS, 'N/A')

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.temporary.cleanup()

    def json(self, route, body=None, expected=200):
        connection = StaffConnection(self.server, timeout=60)
        try:
            connection.request('GET' if body is None else 'POST', route, None if body is None else json.dumps(body),
                {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.server.server_port}'})
            response = connection.getresponse(); value = json.loads(response.read())
            self.assertEqual(response.status, expected, value)
            return value
        finally:
            connection.close()

    def workspace(self):
        return self.json('/api/certifications/workspaces', {}, 201)['workspace_id']

    def view(self, workspace):
        return self.json('/api/certifications/workspaces/' + workspace)

    def request(self, workspace):
        request = {**deepcopy(self.request_template), 'project_save_request': str(uuid4()),
                'certifications': {'workspace_id': workspace, 'draft': None}}
        request['estimate'] = complete_missing_metadata(request['estimate'])
        return request

    def save_as(self, workspace):
        return self.json('/api/project/save-as', self.request(workspace))

    def certificate(self, workspace, expected=201, **extra):
        return self.json('/api/certifications?workspace=' + workspace,
            {'fields': self.fields, 'request_id': str(uuid4()), **extra}, expected)

    def test_fresh_or_number_spoofed_workspaces_cannot_create_any_document(self):
        workspace = self.workspace()
        self.assertFalse(self.view(workspace)['created_project'])
        self.assertEqual(self.certificate(workspace, 400)['error'], PROJECT_REQUIRED)
        self.assertEqual(self.json('/api/certifications', {'fields': self.fields}, 400)['error'], PROJECT_REQUIRED)
        # Posting plausible identity fields does not activate a project capability.
        self.json('/api/certifications/workspaces', {'created_project': True, 'project_no': 'PN-999'}, 400)
        for kind in ('quote', 'work_order', 'purchase_order'):
            fields = commercial_fields(kind, {'project_no': 'PN-999', 'client': 'Spoofed'})
            result = self.json('/api/commercial/save', {'workspace_id': workspace, 'id': str(uuid4()),
                'kind': kind, 'version': 0, 'status': 'Draft', 'fields': fields}, 400)
            self.assertEqual(result['error'], PROJECT_REQUIRED)
        result = self.json('/api/swms/save', {'workspace_id': workspace, 'id': str(uuid4()), 'version': 0,
            'status': 'Draft', 'fields': swms_fields({'project_no': 'PN-999'})}, 400)
        self.assertEqual(result['error'], PROJECT_REQUIRED)
        self.assertEqual(self.json('/api/certifications?workspace=' + workspace)['items'], [])
        self.assertFalse(self.dialogs.path.exists())
        self.assertFalse(self.view(workspace)['created_project'])

    def test_cancel_does_not_activate_and_completed_save_only_activates_its_workspace(self):
        workspace, other = self.workspace(), self.workspace()
        self.dialogs.cancel = True
        self.assertTrue(self.save_as(workspace)['cancelled'])
        self.assertFalse(self.view(workspace)['created_project'])
        self.dialogs.cancel = False
        saved = self.save_as(workspace)
        self.assertTrue(saved['project']['estimate']['project_no'])
        self.assertTrue(self.view(workspace)['created_project'])
        self.assertFalse(self.view(other)['created_project'])
        self.assertEqual(self.certificate(other, 400)['error'], PROJECT_REQUIRED)
        document = self.certificate(workspace)
        self.assertEqual(document['version'], 1)

    def test_exact_legacy_create_receipt_replays_without_allowing_new_global_documents(self):
        operation = str(uuid4())
        old = CertificationService(Store(self.database)).create(self.fields, operation)
        replay = self.json('/api/certifications', {'fields': self.fields, 'request_id': operation}, 201)
        self.assertEqual(replay['id'], old['id'])
        self.assertEqual(self.json('/api/certifications', {'fields': self.fields, 'request_id': str(uuid4())}, 400)['error'], PROJECT_REQUIRED)
        self.assertEqual(len(self.json('/api/certifications')['items']), 1)

    def test_browser_import_keeps_history_editable_but_native_load_grants_new_creation(self):
        workspace = self.workspace(); saved = self.save_as(workspace)
        document = self.certificate(workspace)
        body = {'estimate': {key: value for key, value in saved['project']['estimate'].items() if key in ESTIMATE_FIELDS},
                'calculators': deepcopy(self.request_template['calculators'])}
        body.update(save_token=saved['file']['save_token'], certifications={'workspace_id': workspace,
            'draft': {key: document[key] for key in ('id', 'version', 'fields', 'options')}})
        self.json('/api/project/save', body)
        imported = self.json('/api/project/import', {'filename': self.dialogs.path.name,
            'content_base64': base64.b64encode(self.dialogs.path.read_bytes()).decode()})
        imported_workspace = imported['certification_workspace_id']
        self.assertFalse(self.view(imported_workspace)['created_project'])
        self.assertEqual(self.certificate(imported_workspace, 400)['error'], PROJECT_REQUIRED)
        opened = self.json('/api/certifications/' + document['id'] + '?workspace=' + imported_workspace)
        updated = self.json('/api/certifications/' + document['id'] + '?workspace=' + imported_workspace,
            {'fields': {**opened['fields'], 'location_area': 'Still editable'}, 'expected_version': opened['version']})
        self.assertEqual(updated['fields']['location_area'], 'Still editable')
        # Native selection reads the file itself; it never accepts a path/number claim.
        loaded = self.json('/api/project/open', {})
        loaded_workspace = loaded['certification_workspace_id']
        self.assertTrue(self.view(loaded_workspace)['created_project'])
        self.certificate(loaded_workspace)

