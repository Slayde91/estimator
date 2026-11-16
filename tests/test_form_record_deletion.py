import unittest
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
