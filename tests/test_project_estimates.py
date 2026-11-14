import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.follow_up import legacy_actions
from estimator.project_file import WORKSPACE_FIELDS, export_project, load_project_bytes
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from test_project_library import complete_missing_metadata


def editable(workspace):
    result = {key: copy.deepcopy(workspace[key]) for key in WORKSPACE_FIELDS if key in workspace}
    result['calculators'] = {key: {'inputs': value['inputs'], 'schedule_rows': value['schedule_rows']}
                             for key, value in result['calculators'].items()}
    return result


def complete_save_metadata(request):
    request['estimate'] = complete_missing_metadata(request['estimate'])
    for entry in request.get('estimates', []):
        workspace = entry['workspace']
        workspace['estimate'] = complete_missing_metadata(workspace['estimate'])
    return request


class ProjectEstimatesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as directory:
            cls.snapshot = json.loads(export_project(Store(Path(directory) / 'initial.sqlite3'), {'estimate': {'title': 'Project'}}))

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = Store(self.root / 'test.sqlite3')
        self.path = self.root / 'Project.cf.json'
        self.library = ProjectLibrary(self.store)
        self.addCleanup(self.library.close)
        self.first = editable(self.snapshot)
        self.second = copy.deepcopy(self.first)
        self.second['estimate']['measurements'] = 'Alternative scope'
        self.other_id = 'estimate-' + '2' * 32
        self.request = {**self.first, 'active_estimate_id':'estimate-1', 'estimates':[
            {'id':'estimate-1', 'name':'Original', 'workspace':self.first},
            {'id':self.other_id, 'name':'Alternative', 'workspace':self.second}]}

    def test_all_estimate_workspaces_round_trip_and_active_mirror_is_checked(self):
        payload = export_project(self.store, self.request)
        loaded = load_project_bytes(self.store, payload)
        self.assertEqual([entry['name'] for entry in loaded['estimates']], ['Original', 'Alternative'])
        self.assertEqual(loaded['estimates'][1]['workspace']['estimate']['measurements'], 'Alternative scope')
        changed = json.loads(payload)
        changed['active_estimate_id'] = self.other_id
        with self.assertRaisesRegex(ValidationError, 'active estimate'):
            load_project_bytes(self.store, json.dumps(changed).encode())

    def test_duplicate_ids_nested_collections_and_incomplete_workspaces_are_rejected(self):
        for mutation in ('duplicate', 'nested', 'incomplete'):
            request = copy.deepcopy(self.request)
            if mutation == 'duplicate':
                request['estimates'][1]['id'] = 'estimate-1'
            elif mutation == 'nested':
                request['estimates'][1]['workspace']['estimates'] = []
            else:
                request['estimates'][1]['workspace']['calculators'] = {}
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                export_project(self.store, request)

    def test_save_and_switch_retain_inactive_estimate_and_reject_older_client_omission(self):
        self.path.write_bytes(export_project(self.store, self.request))
        self.store.set_project_folder(self.root)
        listed = self.library.listing()['files'][0]
        self.assertEqual(len(listed['estimates']), 2)
        selected = self.library.load(listed['id'])
        request = copy.deepcopy(self.request)
        request.update(self.second)
        request['active_estimate_id'] = self.other_id
        request['save_token'] = selected['file']['save_token']
        result = self.library.save(complete_save_metadata(request))
        self.assertEqual(result['project']['active_estimate_id'], self.other_id)
        self.assertEqual(result['project']['estimates'][0]['workspace']['estimate']['measurements'], '')
        older = {**self.second, 'save_token':result['file']['save_token']}
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValidationError, 'every named estimate'):
            self.library.save(older)
        self.assertEqual(self.path.read_bytes(), before)

    def test_legacy_file_still_loads_without_a_collection(self):
        legacy = json.dumps(self.snapshot).encode()
        self.assertNotIn('estimates', load_project_bytes(self.store, legacy))

    def test_switching_estimates_preserves_project_follow_up_on_older_client_save(self):
        follow_up = {'next_action': 'Confirm access with the client', 'follow_up_date': '2026-11-18'}
        old = json.loads(export_project(self.store, self.request))
        old['project_follow_up'] = follow_up
        self.path.write_bytes(json.dumps(old).encode())
        self.store.set_project_folder(self.root)
        file_id = self.library.listing()['files'][0]['id']
        opened = self.library.load(file_id)

        # An older client can switch named estimates without sending this project-level field.
        request = {**copy.deepcopy(self.request), **self.second, 'active_estimate_id': self.other_id,
                   'save_token': opened['file']['save_token']}
        self.library.save(complete_save_metadata(request))

        reopened = load_project_bytes(self.store, self.path.read_bytes())
        self.assertEqual(reopened['project_follow_up'], {'actions':legacy_actions(follow_up)})
        self.assertEqual(reopened['active_estimate_id'], self.other_id)
        self.assertEqual(reopened['estimate']['measurements'], 'Alternative scope')

    def test_active_mirror_does_not_repeat_expensive_quote_preparation(self):
        # Two distinct estimates should be prepared twice, not once again for
        # the active estimate duplicated at the project root.
        with patch.object(self.store, 'prepare_quote', wraps=self.store.prepare_quote) as prepare:
            payload = export_project(self.store, self.request)
            self.assertEqual(prepare.call_count, 2)
        with patch.object(self.store, 'prepare_quote', wraps=self.store.prepare_quote) as prepare:
            loaded = load_project_bytes(self.store, payload)
            self.assertEqual(prepare.call_count, 2)
        active = loaded['estimates'][0]['workspace']
        self.assertEqual(active['estimate']['inputs'], loaded['estimate']['inputs'])
        active['estimate']['inputs']['B15'] = 123
        active['calculators']['steel_vermiculite']['inputs'].clear()
        active['fields'].clear()
        self.assertNotEqual(active['estimate']['inputs'], loaded['estimate']['inputs'])
        self.assertTrue(loaded['calculators']['steel_vermiculite']['inputs'])
        self.assertTrue(loaded['fields'])

    def test_active_mirror_with_equal_boolean_and_number_must_still_be_validated(self):
        request = copy.deepcopy(self.request)
        request['estimates'][0]['workspace'] = copy.deepcopy(request['estimates'][0]['workspace'])
        request['estimate']['inputs']['B15'] = 1
        request['estimates'][0]['workspace']['estimate']['inputs']['B15'] = True
        with self.assertRaises(ValidationError):
            export_project(self.store, request)
        snapshot = json.loads(export_project(self.store, self.request))
        snapshot['estimate']['inputs']['B15'] = 1
        snapshot['estimates'][0]['workspace']['estimate']['inputs']['B15'] = True
        with self.assertRaises(ValidationError):
            load_project_bytes(self.store, json.dumps(snapshot).encode())

    def test_changed_or_invalid_inactive_estimate_is_never_reused(self):
        original = export_project(self.store, self.request)
        for mutation in ('surrogate', 'source', 'boolean'):
            snapshot = json.loads(original)
            other = snapshot['estimates'][1]['workspace']
            if mutation == 'surrogate':
                other['estimate']['measurements'] = '\ud800'
            elif mutation == 'source':
                other['calculators']['steel_board']['source_sha256'] = '0' * 64
            else:
                other['estimate']['inputs']['B15'] = True
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                load_project_bytes(self.store, json.dumps(snapshot).encode())
        # A later request is normalized from its current values, not a cache
        # of a prior successful load or export.
        self.request['estimates'][1]['workspace']['estimate']['measurements'] = 'Changed after export'
        updated = load_project_bytes(self.store, export_project(self.store, self.request))
        self.assertEqual(updated['estimates'][1]['workspace']['estimate']['measurements'], 'Changed after export')

    def test_scheduler_resolver_rechecks_current_file_status(self):
        self.path.write_bytes(export_project(self.store, self.request))
        self.store.set_project_folder(self.root)
        listed = self.library.listing()['files'][0]
        changed = json.loads(self.path.read_bytes())
        changed['project_status'] = 'Accepted'
        self.path.write_text(json.dumps(changed), encoding='utf-8')
        self.assertEqual(self.library.scheduler_project(listed['id'])['project_status'], 'Won')

    def test_commercial_download_requires_the_same_saved_project_identity(self):
        project_id = '11111111-1111-4111-8111-111111111111'
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['certifications'] = {'version':1, 'project_id':project_id, 'archive_sha256':'a' * 64,
            'archive_size':1, 'document_count':0, 'revision_count':0,
            'companion_folder':f'.ceasefire-evidence/{project_id}/certifications'}
        self.path.write_text(json.dumps(snapshot), encoding='utf-8')
        self.store.set_project_folder(self.root)
        listed = self.library.listing()['files'][0]
        selected = self.library.load(listed['id'])['file']
        request = {'project_token':selected['save_token']}
        self.library.capture_download(request, project_id=project_id)
        with self.assertRaisesRegex(ValidationError, 'different project'):
            self.library.capture_download(request, project_id='22222222-2222-4222-8222-222222222222')
        self.library.capture_download(request)
        del snapshot['certifications']
        self.path.write_text(json.dumps(snapshot), encoding='utf-8')
        legacy = self.library.load(listed['id'])['file']
        with self.assertRaisesRegex(ValidationError, 'Save the current project before downloading'):
            self.library.capture_download({'project_token':legacy['save_token']}, project_id=project_id)

    def test_inactive_estimate_cannot_lose_its_firestopping_composer(self):
        from estimator.penetration_calculator import definition
        defaults = definition({})['defaults']
        self.request['estimates'][1]['workspace']['penetration'] = {
            'draft':{**copy.deepcopy(defaults), 'rows':[]},
            'composer':copy.deepcopy(defaults), 'library_tracking_version':1}
        self.path.write_bytes(export_project(self.store, self.request))
        self.store.set_project_folder(self.root)
        selected = self.library.load(self.library.listing()['files'][0]['id'])
        request = copy.deepcopy(self.request)
        request['save_token'] = selected['file']['save_token']
        del request['estimates'][1]['workspace']['penetration']['composer']
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValidationError, 'Firestopping Estimator inputs'):
            self.library.save(request)
        self.assertEqual(self.path.read_bytes(), before)

    def test_legacy_estimate_can_become_inactive_without_losing_its_composer(self):
        from estimator.penetration_calculator import definition
        defaults = definition({})['defaults']
        self.first['penetration'] = {'draft':{**copy.deepcopy(defaults), 'rows':[]},
                                    'composer':copy.deepcopy(defaults), 'library_tracking_version':1}
        self.path.write_bytes(export_project(self.store, self.first))
        self.store.set_project_folder(self.root)
        selected = self.library.load(self.library.listing()['files'][0]['id'])
        request = copy.deepcopy(self.request)
        request.update(self.second)
        request.pop('penetration', None)
        request['active_estimate_id'] = self.other_id
        request['save_token'] = selected['file']['save_token']
        saved = self.library.save(complete_save_metadata(request))
        self.assertIn('composer', saved['project']['estimates'][0]['workspace']['penetration'])
        self.assertNotIn('penetration', saved['project'])


if __name__ == '__main__':
    unittest.main()
