import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

from estimator.forms import FormError, Forms
from test_forms import entry, field, identifier, template


class FormDeletionTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Forms(Path(directory.name) / 'forms.db', lambda: [], lambda: {})
        self.owner = {'id': 'owner', 'name': 'Owner', 'role': 'editor'}
        self.admin = {'id': 'admin', 'name': 'Admin', 'role': 'admin'}
        self.template = self.store.save_template(self.owner, template(fields=[field('counter', 'counter')]))

    def test_deleting_a_submitted_record_reserves_its_id_and_number(self):
        payload = entry(self.template, {}, status='submitted')
        first = self.store.save_entry(self.owner, payload)
        second = self.store.save_entry(self.owner, entry(self.template, {}))
        request = {'id': first['id'], 'version': first['version']}
        self.assertTrue(self.store.delete_entry(self.owner, request)['deleted'])
        self.assertTrue(self.store.delete_entry(self.owner, request)['deleted'])
        for action in (lambda: self.store.entry(self.admin, first['id']),
                       lambda: self.store.save_entry(self.owner, payload)):
            with self.assertRaises(FormError) as denied:
                action()
            self.assertEqual(denied.exception.status, 404)
        self.assertEqual([r['id'] for r in self.store.entries(self.admin)['entries']], [second['id']])
        third = self.store.save_entry(self.owner, entry(self.template, {}))
        self.assertEqual((first['values']['counter'], second['values']['counter'], third['values']['counter']), (1, 2, 3))

    def test_read_access_does_not_grant_delete_and_stale_version_is_rejected(self):
        record = self.store.save_entry(self.owner, entry(self.template, {}, status='submitted'))
        request = {'id': record['id'], 'version': record['version']}
        for role in ('editor', 'viewer'):
            reader = {'id': 'reader', 'name': 'Reader', 'role': role}
            self.assertFalse(self.store.entry(reader, record['id'])['can_delete'])
            with self.assertRaises(FormError) as denied:
                self.store.delete_entry(reader, request)
            self.assertEqual(denied.exception.status, 403)
        with self.assertRaises(FormError) as conflict:
            self.store.delete_entry(self.admin, {**request, 'version': 0})
        self.assertEqual(conflict.exception.status, 409)
        self.assertTrue(self.store.entry(self.admin, record['id'])['can_delete'])
        self.assertTrue(self.store.delete_entry(self.admin, request)['deleted'])

    def test_retrying_an_assignment_cannot_recreate_a_deleted_request(self):
        self.store.staff = lambda: [self.owner]
        request = {'id': identifier(), 'template_id': self.template['id'],
                   'template_version': self.template['version'], 'member_id': self.owner['id']}
        self.store.assign_entry(self.admin, request)
        version = self.store.entry(self.owner, request['id'])['version']
        self.store.delete_entry(self.admin, {'id': request['id'], 'version': version})
        with self.assertRaises(FormError) as denied:
            self.store.assign_entry(self.admin, request)
        self.assertEqual(denied.exception.status, 404)
        self.assertEqual(self.store.entries(self.owner)['entries'], [])

    def test_template_deletion_keeps_pinned_records_and_rejects_recreation(self):
        initial = self.template
        submitted = self.store.save_entry(self.owner, entry(initial, {}, status='submitted'))
        draft = self.store.save_entry(self.owner, entry(initial, {}))
        update = template(id=initial['id'], version=initial['version'], name='Inspection revised')
        current = self.store.save_template(self.owner, update)
        request = {'id': current['id'], 'version': current['version']}
        viewer = {'id': 'reader', 'name': 'Reader', 'role': 'viewer'}
        with self.store.connect() as db:
            versions = db.execute('SELECT * FROM form_versions ORDER BY version').fetchall()
            rows = db.execute('SELECT * FROM form_entries ORDER BY id').fetchall()
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(lambda _: self.store.delete_template(self.owner, request), range(2)))
        self.assertEqual(receipts, [{'id': current['id'], 'deleted': True}] * 2)
        reopened = Forms(self.store.path, lambda: [], lambda: {})
        self.assertEqual(reopened.templates(self.owner)['templates'], [])
        for action in (lambda: reopened.template(self.admin, current['id'], 1),
                       lambda: reopened.history(self.admin, current['id']),
                       lambda: reopened.assignees(self.owner, current['id'], current['version']),
                       lambda: reopened.save_template(self.owner, update),
                       lambda: reopened.save_template(self.owner, {**update, 'version': current['version']}),
                       lambda: reopened.save_entry(self.owner, entry(current, {'site': 'New'}))):
            with self.assertRaises(FormError) as denied:
                action()
            self.assertEqual(denied.exception.status, 404)
        for result in (reopened.entries(viewer), reopened.entries(viewer, current['id'])):
            self.assertEqual([r['id'] for r in result['entries']], [submitted['id']])
        historical = reopened.entry(viewer, submitted['id'])
        self.assertEqual(historical['name'], initial['name'])
        self.assertEqual(historical['template_version'], initial['version'])
        self.assertEqual(historical['values'], submitted['values'])
        self.assertEqual(historical['form_counter'], 1)
        self.assertFalse(historical['template']['can_fill'])
        self.assertFalse(reopened.entry(self.owner, draft['id'])['can_edit'])
        with reopened.connect() as db:
            self.assertEqual(db.execute('SELECT * FROM form_versions ORDER BY version').fetchall(), versions)
            self.assertEqual(db.execute('SELECT * FROM form_entries ORDER BY id').fetchall(), rows)

    def test_template_deletion_checks_creator_role_and_last_revision_on_legacy_storage(self):
        with self.store.connect(True) as db:
            db.execute('ALTER TABLE form_templates DROP COLUMN deleted')
        reopened = Forms(self.store.path, lambda: [], lambda: {})
        request = {'id': self.template['id'], 'version': self.template['version']}
        for role in ('viewer', 'editor'):
            user = {'id': 'other', 'name': 'Other', 'role': role}
            with self.assertRaises(FormError) as denied:
                reopened.delete_template(user, request)
            self.assertEqual(denied.exception.status, 403)
        with self.assertRaises(FormError) as conflict:
            reopened.delete_template(self.admin, {**request, 'version': 0})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(reopened.template(self.owner, request['id'])['version'], request['version'])
        self.assertTrue(reopened.delete_template(self.admin, request)['deleted'])
