import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlencode
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.contacts import ContactsStore
from estimator.record_resources import RecordResources, ResourceConflict


class Projects:
    def __init__(self, path):
        self._lock = threading.RLock()
        self.owner = str(uuid4())
        self.path = path
        self._save_targets = {'capability': SimpleNamespace(path=str(path))}

    def participant_project(self, selector):
        if selector not in {'a' * 64, 'native:capability'}:
            raise ValidationError('Choose a saved project.')
        return {'owner': self.owner}

    def _project_path(self, selector):
        if selector != 'a' * 64:
            raise ValidationError('Choose a saved project.')
        return {}, self.path


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.contacts = ContactsStore(self.root / 'contacts.sqlite3')
        self.account = self.contacts.save('accounts', {'version': 0, 'fields': {'company': 'Resources Test'}})['id']
        self.second = self.contacts.save('accounts', {'version': 1, 'fields': {'company': 'Separate Test'}})['id']
        project = self.root / 'Project.cf.json'
        project.write_text('Original Project bytes', encoding='utf-8')
        self.projects = Projects(project)
        self.store = RecordResources(self.root / 'resources', self.projects, self.contacts)
        self.owner = {'kind': 'accounts', 'id': self.account}

    def note(self, title='A note', body='Line one\nLine two'):
        return {'id': str(uuid4()), 'title': title, 'body': body}

    def write(self, action, version, **values):
        return self.store.write(action, {'owner': self.owner, 'version': version, **values}, {'name': 'Named author'})

    def test_notes_reopen_edit_delete_and_owner_isolation_without_directory_revision_change(self):
        self.assertEqual(self.store.read(self.owner), {'version': 0, 'notes': [], 'files': []})
        note = self.note()
        saved = self.write('notes', 0, notes=[note])
        self.assertEqual(saved['notes'][0]['author'], 'Named author')
        self.assertTrue(saved['notes'][0]['updated_at'])
        reopened = RecordResources(self.root / 'resources', self.projects, self.contacts)
        self.assertEqual(reopened.read(self.owner), saved)
        self.assertEqual(reopened.read({'kind': 'accounts', 'id': self.second})['notes'], [])
        changed = self.write('notes', 1, notes=[{**note, 'body': 'Edited'}])
        self.assertEqual(changed['notes'][0]['body'], 'Edited')
        self.assertEqual(self.write('notes', 2, notes=[])['notes'], [])
        self.assertEqual(self.contacts.list()['version'], 2)

    def test_concurrent_instances_reject_stale_versions_and_keep_winning_content(self):
        second = RecordResources(self.root / 'resources', self.projects, self.contacts)
        payloads = [{'owner': self.owner, 'version': 0, 'notes': [self.note(title)]} for title in ('First', 'Second')]
        def save(pair):
            store, payload = pair
            try:
                return store.write('notes', payload)['notes'][0]['title']
            except ResourceConflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as executor:
            result = list(executor.map(save, [(self.store, payloads[0]), (second, payloads[1])]))
        self.assertEqual(result.count('conflict'), 1)
        self.assertEqual(self.store.read(self.owner)['notes'][0]['title'], next(value for value in result if value != 'conflict'))

    def test_copied_sidecar_cannot_execute_added_triggers(self):
        self.write('notes', 0, notes=[self.note()])
        folder, _ = self.store._target(self.owner)
        path = folder / 'resources.sqlite3'
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE unexpected (value TEXT)')
            db.execute("CREATE TRIGGER capture BEFORE INSERT ON resources BEGIN INSERT INTO unexpected VALUES('trigger ran'); END")
        for action in (lambda: self.store.read(self.owner), lambda: self.write('notes', 1, notes=[])):
            with self.assertRaisesRegex(ValidationError, 'unsupported format'):
                action()
        with closing(sqlite3.connect(path)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM unexpected').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT version FROM resources').fetchone()[0], 1)

    def test_merge_retains_source_resources_and_undo_restores_exact_collection(self):
        from estimator.crm_identity import IdentityService
        saved = self.write('notes', 0, notes=[self.note('Source resource')])
        service = IdentityService(self.contacts)
        pair = service.preview({'kind': 'accounts', 'source_id': self.account, 'survivor_id': self.second})
        merged = service.apply('merge', {'kind': 'accounts', 'source_id': self.account, 'survivor_id': self.second,
            'version': pair['version'], 'preview_token': pair['preview_token'], 'request_id': str(uuid4()), 'reason': 'Confirmed duplicate'})
        with self.assertRaisesRegex(ValidationError, 'merged'):
            self.store.read(self.owner)
        self.assertEqual(self.store.read({'kind': 'accounts', 'id': self.second})['notes'], [])
        service.apply('undo', {'kind': 'accounts', 'operation_id': merged['operation_id'],
            'version': merged['version'], 'request_id': str(uuid4())})
        self.assertEqual(self.store.read(self.owner), saved)

    def test_upload_download_remove_isolation_limits_and_no_rejected_blob(self):
        first = self.write('upload', 0, filename='Test.txt', content_base64=base64.b64encode(b'12345678').decode())
        item = first['files'][0]
        self.assertEqual(self.store.file(self.owner, item['id'])[1], b'12345678')
        with self.assertRaises(ValidationError):
            self.store.file({'kind': 'accounts', 'id': self.second}, item['id'])
        with patch('estimator.record_resources.MAX_TOTAL', 10):
            with self.assertRaises(ValidationError):
                self.write('upload', 1, filename='Too much.txt', content_base64=base64.b64encode(b'123').decode())
        folder, identity = self.store._target(self.owner)
        self.assertEqual(len(list((folder / 'files' / identity).iterdir())), 1)
        for name, encoded in [('../escape.txt', 'YQ=='), ('bad\r\n.txt', 'YQ=='), ('bad.txt', 'invalid!')]:
            with self.subTest(name=name), self.assertRaises(ValidationError):
                self.write('upload', 1, filename=name, content_base64=encoded)
        self.assertEqual(self.store.read(self.owner)['version'], 1)
        self.assertEqual(self.write('remove-file', 1, file_id=item['id'])['files'], [])
        with self.assertRaises(ValidationError):
            self.store.file(self.owner, item['id'])
        self.assertTrue((folder / 'files' / identity / item['id']).exists(), 'Unreferenced immutable bytes remain retained')

    def test_invalid_fields_unknown_records_and_failed_initial_write_remain_empty(self):
        with self.assertRaises(ValidationError):
            self.write('notes', 0, notes=[self.note('')])
        self.assertEqual(self.store.read(self.owner)['version'], 0)
        for owner in ({'kind': 'accounts', 'id': str(uuid4())}, {'kind': '../escape', 'id': self.account},
                      {'kind': 'accounts', 'id': '../escape'}, {'kind': 'accounts', 'id': self.account, 'path': '/private'}):
            with self.subTest(owner=owner), self.assertRaises(ValidationError):
                self.store.read(owner)
        for note in ({**self.note(), 'author': 'Forged'}, self.note(body='\x00')):
            with self.assertRaises(ValidationError):
                self.write('notes', 0, notes=[note])

    def test_project_companions_move_together_and_save_as_owns_separate_resources(self):
        self.owner = {'kind': 'projects', 'id': 'a' * 64, 'project_id': self.projects.owner}
        original = self.projects.path.read_bytes()
        saved = self.write('notes', 0, notes=[self.note()])
        self.assertEqual(self.projects.path.read_bytes(), original)
        self.assertEqual(self.store.read({**self.owner, 'id': 'native:capability'}), saved)
        source = self.projects.path.parent
        moved = self.root / 'moved'
        moved.mkdir()
        shutil.copytree(source / '.ceasefire-evidence', moved / '.ceasefire-evidence')
        self.projects.path = moved / 'Project.cf.json'
        self.projects.path.write_bytes(original)
        self.assertEqual(self.store.read(self.owner), saved)
        self.projects.path = moved / 'Save As.cf.json'
        self.projects.path.write_bytes(original)
        self.assertEqual(self.store.read(self.owner)['notes'], [])
        self.projects.path = moved / 'Project.cf.json'
        self.projects.owner = str(uuid4())
        with self.assertRaises(ResourceConflict):
            self.store.read(self.owner)
        self.assertEqual(self.store.read({**self.owner, 'project_id': self.projects.owner})['notes'], [])
        self.projects.owner = ''
        with self.assertRaisesRegex(ValidationError, 'Save this Project'):
            self.store.read(self.owner)

    def test_same_path_replaced_owner_rejects_initial_reads_writes_and_file_links(self):
        old = {'kind': 'projects', 'id': 'a' * 64, 'project_id': self.projects.owner}
        self.assertEqual(self.store.read(old)['version'], 0)
        self.projects.owner = str(uuid4())
        new = {**old, 'project_id': self.projects.owner}
        # Both collections start at version zero; a version check alone cannot
        # distinguish unrelated Projects which occupy the same saved pathname.
        with self.assertRaises(ResourceConflict):
            self.store.write('notes', {'owner': old, 'version': 0, 'notes': [self.note('Wrong owner')]})
        self.assertEqual(self.store.read(new)['notes'], [])
        saved = self.store.write('upload', {'owner': new, 'version': 0, 'filename': 'New owner.txt',
            'content_base64': base64.b64encode(b'Current Project only').decode()})
        for selector in ('a'*64, 'native:capability'):
            stale = {**old, 'id': selector}
            with self.assertRaises(ResourceConflict):
                self.store.read(stale)
            with self.assertRaises(ResourceConflict):
                self.store.file(stale, saved['files'][0]['id'])
        with self.assertRaises(ValidationError):
            self.store.read({'kind': 'projects', 'id': 'a'*64})
        self.assertEqual(self.store.file(new, saved['files'][0]['id'])[1], b'Current Project only')

    def test_malformed_kind_and_oversize_encoded_note_collection_fail_without_losing_state(self):
        for kind in ([], {}, 42, None):
            with self.assertRaises(ValidationError):
                self.store.read({'kind': kind, 'id': self.account})
        with self.assertRaises(ValidationError):
            self.write('notes', 0, notes=[self.note('Large', '\u2603' * 8000) for _ in range(50)])
        self.assertEqual(self.store.read(self.owner), {'version': 0, 'notes': [], 'files': []})


class ResourceHTTPAccessTests(unittest.TestCase):
    def setUp(self):
        from estimator.crm_access import CRMAccess
        from estimator.scheduler import SchedulerStore
        from estimator.server import create_server
        temp = tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.server = create_server(0, root / 'state.sqlite3', library_directory=root / 'library')
        thread = threading.Thread(target=self.server.serve_forever, daemon=True);thread.start()
        self.addCleanup(thread.join);self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        contacts = ContactsStore(root / 'state-contacts.sqlite3')
        self.owner = {'kind': 'accounts', 'id': contacts.save('accounts', {'version': 0, 'fields': {'company': 'Private Resource'}})['id']}
        scheduler = SchedulerStore(root / 'state-scheduler.sqlite3')
        self.password = 'Synthetic-resource-password-2026'
        admin = scheduler.write('setup', {'name': 'Admin', 'email': 'admin@example.test', 'password': self.password})
        self.access = CRMAccess(root / 'state-access.sqlite3', scheduler)
        self.admin_token = admin['token']
        self.members = {}
        for role in ('editor', 'viewer', 'none'):
            member = scheduler.write('members/save', {'name': role, 'email': role+'@example.test', 'password': self.password,
                'role': 'worker', 'active': True, 'base_rate': '0'}, admin['token'])
            if role != 'none':
                self.access.assign({'member_id': member['id'], 'role': role, 'version': 0}, admin['token'])
            self.members[role] = member['id']
        self.access.activate_named_access()
        self.cookies = {role: self.call('/api/access/login', {'email': role+'@example.test', 'password': self.password})[1]['Set-Cookie'].split(';',1)[0] for role in self.members}

    def call(self, path, body=None, role=None, extra=None, raw=False):
        headers = {'Content-Type': 'application/json', **(extra or {})}
        if role:
            headers.update(Cookie=self.cookies[role]);headers.setdefault('X-CRM-Member', self.members[role])
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        try:
            connection.request('GET' if body is None else 'POST', path, None if body is None else json.dumps(body), headers)
            response = connection.getresponse();payload=response.read()
            return response.status, dict(response.getheaders()), payload if raw else json.loads(payload)
        finally:
            connection.close()

    def test_reader_editor_scheduler_only_anonymous_and_changed_identity_boundaries(self):
        route = '/api/record-resources?'+urlencode(self.owner)
        self.assertEqual(self.call(route)[0], 401)
        self.assertEqual(self.call(route, role='none')[0], 403)
        self.assertEqual(self.call(route, role='viewer')[0], 200)
        payload = {'owner': self.owner, 'version': 0, 'notes': [{'id': str(uuid4()), 'title': 'Private', 'body': 'Record details'}]}
        self.assertEqual(self.call('/api/record-resources/notes', payload, 'viewer')[0], 403)
        self.assertEqual(self.call('/api/record-resources/notes', payload, 'editor', {'X-CRM-Member': self.members['viewer']})[0], 409)
        self.assertEqual(self.call('/api/record-resources/notes', payload, 'editor')[0], 200)
        self.assertEqual(self.call('/api/record-resources/notes', payload, 'editor')[0], 409)
        self.assertEqual(self.call(route, role='viewer')[2]['notes'][0]['body'], 'Record details')
        self.assertEqual(self.call(route, role='viewer', extra={'X-CRM-Member': self.members['editor']})[0], 409)
        self.assertEqual(self.call('/api/record-resources/notes', {**payload, 'version': 1}, 'editor', {'Sec-Fetch-Site': 'cross-site'})[0], 403)

    def test_file_read_is_authorized_and_viewer_cannot_upload_or_remove(self):
        payload = {'owner': self.owner, 'version': 0, 'filename': 'Evidence.txt', 'content_base64': base64.b64encode(b'Test file').decode()}
        self.assertEqual(self.call('/api/record-resources/upload', payload, 'viewer')[0], 403)
        saved = self.call('/api/record-resources/upload', payload, 'editor')
        self.assertEqual(saved[0], 200)
        identity = saved[2]['files'][0]['id']
        route = '/api/record-resources/file?'+urlencode({**self.owner, 'file': identity})
        self.assertEqual(self.call(route, raw=True)[0], 401)
        self.assertEqual(self.call(route, role='none', raw=True)[0], 403)
        result = self.call(route, role='viewer', raw=True)
        self.assertEqual(result[0], 200);self.assertEqual(result[2], b'Test file')
        self.assertTrue(result[1]['Content-Disposition'].startswith('attachment;'))
        remove = {'owner': self.owner, 'version': 1, 'file_id': identity}
        self.assertEqual(self.call('/api/record-resources/remove-file', remove, 'viewer')[0], 403)
        self.assertEqual(self.call('/api/record-resources/remove-file', remove, 'editor')[0], 200)
        self.assertEqual(self.call(route, role='viewer', raw=True)[0], 400)
