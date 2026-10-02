"""Defect -> Barrier -> Service identities and lossless legacy boundaries."""

from copy import deepcopy
import json
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.takeoff_model import new_snapshot, upgrade_snapshot, validate_snapshot
from estimator.takeoff_physical import (apply_change, graph_collections, graph_parents,
    new_graph, preview_change, validate_graph)
from estimator.takeoff_physical_operations import current_graph, prepare_changes
from tests import test_takeoff_physical_workspace as workspace_fixtures
from tests import test_takeoff_project as project_fixtures


def create(kind, parent=None, **fields):
    entity = {'id': str(uuid4()), 'fields': fields, 'evidence': [],
              'uncertainty': {'state': 'not_assessed', 'note': ''}}
    if kind in ('barrier', 'service'):
        entity[{'barrier': 'defect_id', 'service': 'barrier_id'}[kind]] = parent
    if kind == 'service':
        entity['quantity'] = 1
    return {'op': 'create', 'kind': kind, 'entity': entity}


def apply(graph, command):
    preview = preview_change(graph, command)
    return apply_change(graph, command, expected_revision=graph['revision'],
                        preview_digest=preview['preview_digest'])['graph']


class PhysicalV2Tests(unittest.TestCase):
    def setUp(self):
        self.snapshot = new_snapshot()
        self.defect = create('defect', label='Original defect')
        self.barrier = create('barrier', self.defect['entity']['id'], substrate='Concrete')
        self.service = create('service', self.barrier['entity']['id'], service='Pipe')

    def graph(self):
        return prepare_changes(self.snapshot, [self.defect, self.barrier, self.service])['graph']

    def test_new_projects_use_v2_without_rewriting_legacy_factory_or_snapshot(self):
        original = deepcopy(self.snapshot)
        graph = current_graph(self.snapshot)
        self.assertEqual(graph['version'], 2)
        self.assertEqual(list(graph_collections(graph)), ['defect', 'barrier', 'service'])
        self.assertEqual(graph_parents(graph), {'barrier': ('defect', 'defect_id'),
                                              'service': ('barrier', 'barrier_id')})
        self.assertNotIn('openings', graph)
        self.assertEqual(graph, current_graph(self.snapshot))
        self.assertEqual(original, self.snapshot)
        self.assertEqual(new_graph(self.snapshot['project_id'])['version'], 1)
        self.assertNotEqual(graph['id'], current_graph(new_snapshot())['id'])

    def test_atomic_batch_assigns_independent_ids_and_exact_preview_relationships(self):
        commands = [self.defect, self.barrier, self.service,
                    create('barrier', self.defect['entity']['id']), create('defect')]
        original = deepcopy(commands)
        result = prepare_changes(self.snapshot, commands)
        graph = result['graph']
        self.assertEqual([x['display_id'] for x in graph['defects']], ['D-0001', 'D-0002'])
        self.assertEqual([x['display_id'] for x in graph['barriers']], ['B-0001', 'B-0002'])
        self.assertEqual([x['display_id'] for x in graph['services']], ['S-0001'])
        relationships = {x['id']: x for x in result['summary']['relationships']}
        for command, label, parent in ((self.defect, 'D-0001', None),
                (self.barrier, 'B-0001', self.defect['entity']['id']),
                (self.service, 'S-0001', self.barrier['entity']['id'])):
            relation = relationships[command['entity']['id']]
            self.assertEqual(relation['display_id'], label)
            self.assertEqual(relation['parent_after'], parent)
        self.assertEqual(result, prepare_changes(self.snapshot, commands))
        self.assertEqual(commands, original)
        self.assertNotIn('physical', self.snapshot)

    def test_wrong_levels_openings_and_old_parent_fields_are_rejected_atomically(self):
        for command in (create('barrier'), create('service', self.defect['entity']['id']),
                        {'op': 'create', 'kind': 'opening', 'entity': {'id': str(uuid4())}},
                        create('defect', opening_type='Unwanted')):
            with self.subTest(command=command), self.assertRaises(ValidationError):
                prepare_changes(self.snapshot, [self.defect, command])
        wrong = deepcopy(self.barrier)
        wrong['entity']['barrier_id'] = wrong['entity'].pop('defect_id')
        with self.assertRaises(ValidationError):
            prepare_changes(self.snapshot, [self.defect, wrong])
        self.assertNotIn('physical', self.snapshot)

    def test_display_ids_cannot_be_created_or_edited_by_client(self):
        malicious = deepcopy(self.defect); malicious['entity']['display_id'] = 'D-0999'
        with self.assertRaises(ValidationError):
            preview_change(current_graph(self.snapshot), malicious)
        graph = self.graph()
        for changes in ({'display_id': 'D-0999'}, {'fields': {'display_id': 'D-0999'}}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                preview_change(graph, {'op': 'update', 'entity_id': self.defect['entity']['id'],
                                       'changes': changes})

    def test_ids_remain_stable_on_edit_reparent_delete_restore_and_next_create(self):
        graph = self.graph()
        other = create('defect')
        graph = apply(graph, other)
        graph = apply(graph, {'op': 'update', 'entity_id': self.defect['entity']['id'],
                             'changes': {'fields': {'label': 'Renamed'}}})
        move = {'op': 'reparent', 'entity_id': self.barrier['entity']['id'], 'parent_id': other['entity']['id']}
        preview = preview_change(graph, move)
        self.assertEqual(preview['descendant_ids'], [self.service['entity']['id']])
        graph = apply(graph, move)
        with self.assertRaises(ValidationError):
            preview_change(graph, {'op': 'delete', 'entity_id': other['entity']['id'], 'cascade': False})
        graph = apply(graph, {'op': 'delete', 'entity_id': other['entity']['id'], 'cascade': True})
        self.assertTrue(graph['barriers'][0]['deleted'])
        self.assertTrue(graph['services'][0]['deleted'])
        graph = apply(graph, {'op': 'restore', 'entity_id': other['entity']['id'], 'mode': 'same_deletion'})
        self.assertFalse(graph['barriers'][0]['deleted'])
        self.assertEqual(graph['barriers'][0]['defect_id'], other['entity']['id'])
        self.assertEqual(graph['barriers'][0]['display_id'], 'B-0001')
        self.assertEqual(graph['services'][0]['display_id'], 'S-0001')
        self.assertEqual(graph['services'][0]['barrier_id'], self.barrier['entity']['id'])
        graph = apply(graph, {'op': 'delete', 'entity_id': other['entity']['id'], 'cascade': True})
        graph = apply(graph, create('defect'))
        graph = apply(graph, create('barrier', self.defect['entity']['id']))
        graph = apply(graph, create('service', graph['barriers'][-1]['id']))
        self.assertEqual(graph['defects'][-1]['display_id'], 'D-0003')
        self.assertEqual(graph['barriers'][-1]['display_id'], 'B-0002')
        self.assertEqual(graph['services'][-1]['display_id'], 'S-0002')

    def test_validator_rejects_invalid_id_formats_duplicate_tombstones_and_openings(self):
        graph = self.graph()
        for value in ('D-0000', 'D-1', 'D-00001', 'D-10001', 'B-0001', True):
            invalid = deepcopy(graph); invalid['defects'][0]['display_id'] = value
            with self.subTest(value=value), self.assertRaises(ValidationError):
                validate_graph(invalid)
        duplicate = deepcopy(graph['defects'][0])
        duplicate.update(id=str(uuid4()), deleted=True, deleted_at_revision=graph['revision'])
        invalid = deepcopy(graph); invalid['defects'].append(duplicate)
        with self.assertRaisesRegex(ValidationError, 'unique'):
            validate_graph(invalid)
        invalid = deepcopy(graph); invalid['openings'] = []
        with self.assertRaises(ValidationError):
            validate_graph(invalid)
        invalid = deepcopy(graph); invalid['version'] = True
        with self.assertRaises(ValidationError):
            validate_graph(invalid)

    def test_evidence_parent_associations_follow_versioned_hierarchy(self):
        self.snapshot['documents'] = [{'id': str(uuid4()), 'name': 'source.pdf', 'sha256': '1' * 64,
            'size': 100, 'pages': [{'page': 1, 'width': 200, 'height': 200,
                                   'view': [0, 0, 200, 200], 'rotation': 0, 'user_unit': 1}]}]
        document = self.snapshot['documents'][0]
        for command, parent in ((self.barrier, 'defect_id'), (self.service, 'barrier_id')):
            command['entity']['evidence'] = [{'document_id': document['id'],
                'document_sha256': document['sha256'], 'page': 1, 'fields': [parent]}]
        graph = self.graph()
        validate_graph(graph)
        for collection, wrong in (('barriers', 'barrier_id'), ('services', 'opening_id')):
            invalid = deepcopy(graph); invalid[collection][0]['evidence'][0]['fields'] = [wrong]
            with self.subTest(collection=collection), self.assertRaises(ValidationError):
                validate_graph(invalid)


class PhysicalV2WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = workspace_fixtures.PhysicalWorkspaceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service, self.sid = self.fixture.service, self.fixture.sid

    def test_undo_create_retains_all_tombstone_ids_and_never_reuses_sequence(self):
        defect = create('defect')
        barrier = create('barrier', defect['entity']['id'])
        service = create('service', barrier['entity']['id'])
        before = self.fixture.state()['snapshot']
        applied, _ = self.fixture.apply([defect, barrier, service])
        response = self.service.command(self.sid, {'op': 'undo', 'request_id': str(uuid4()),
                                                  'expected_revision': applied['revision']})
        for collection, prefix in (('defects', 'D'), ('barriers', 'B'), ('services', 'S')):
            self.assertTrue(response['snapshot']['physical'][collection][0]['deleted'])
            self.assertEqual(response['snapshot']['physical'][collection][0]['display_id'], prefix+'-0001')
        next_defect = create('defect')
        next_barrier = create('barrier', next_defect['entity']['id'])
        next_service = create('service', next_barrier['entity']['id'])
        result, _ = self.fixture.apply([next_defect, next_barrier, next_service])
        for collection, prefix in (('defects', 'D'), ('barriers', 'B'), ('services', 'S')):
            self.assertEqual(result['snapshot']['physical'][collection][-1]['display_id'], prefix+'-0002')
        for key in ('items', 'transfers', 'calibrations', 'documents'):
            self.assertEqual(result['snapshot'][key], before[key])
        validate_snapshot(result['snapshot'])
        captured = self.service.capture(self.sid, result['snapshot'])
        self.assertEqual(captured['physical'], result['snapshot']['physical'])

    def test_legacy_user_edit_apply_and_physical_undo_are_read_only(self):
        before = self.fixture.state()['snapshot']
        legacy_graph = new_graph(before['project_id'], version=1)
        command = {'op': 'create', 'kind': 'barrier', 'entity': {'id': str(uuid4()),
            'fields': {}, 'evidence': [], 'uncertainty': {'state': 'not_assessed', 'note': ''}}}
        legacy_graph = apply(legacy_graph, command)
        after = upgrade_snapshot(before); after['physical'] = legacy_graph
        response = self.service._commit(self.sid, {'op': 'apply_physical', 'request_id': str(uuid4()),
            'expected_revision': before['revision']}, before, after)
        frozen = deepcopy(response['snapshot'])
        actions = (
            lambda: self.service.preview_physical(self.sid, {'expected_revision': response['revision'],
                'commands': [{'op': 'delete', 'entity_id': command['entity']['id'], 'cascade': True}]}),
            lambda: self.service.apply_physical(self.sid, {'expected_revision': response['revision'],
                'request_id': str(uuid4()), 'preview_id': str(uuid4())}),
            lambda: self.service.command(self.sid, {'expected_revision': response['revision'],
                'request_id': str(uuid4()), 'op': 'undo'}))
        for action in actions:
            with self.assertRaisesRegex(ValidationError, 'read-only'):
                action()
            self.assertEqual(self.fixture.state()['snapshot'], frozen)
        self.assertIn(command['entity']['id'].encode(), self.service.export_physical(self.sid, 'csv')[0])
        self.assertEqual(self.service.capture(self.sid, frozen)['physical'], legacy_graph)
        # Read-only applies to the legacy hierarchy, not unrelated takeoffs.
        self.fixture.case.state = response
        self.fixture.case.create()
        result = self.fixture.case.command('undo')
        self.assertEqual(result['snapshot']['physical'], legacy_graph)
        self.assertEqual(result['snapshot']['items'], frozen['items'])


class PhysicalV2ProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def test_real_save_reopen_retains_serials_tombstones_and_next_numbers(self):
        case = project_fixtures.TakeoffProjectTests()
        case.setUp(); self.addCleanup(case.doCleanups)
        sid = case.session['session_id']

        def commit(commands):
            current = case.service.get(sid, verify_evidence=False)
            preview = case.service.preview_physical(sid, {
                'expected_revision': current['revision'], 'commands': commands})
            return case.service.apply_physical(sid, {'expected_revision': current['revision'],
                'preview_id': preview['preview_id'], 'request_id': str(uuid4())})

        defect = create('defect'); barrier = create('barrier', defect['entity']['id'])
        service = create('service', barrier['entity']['id'])
        commit([defect, barrier, service])
        state = commit([{'op': 'delete', 'entity_id': barrier['entity']['id'], 'cascade': True}])
        graph = deepcopy(state['snapshot']['physical'])
        case.library.save_as({**deepcopy(case.base), 'takeoffs': state['snapshot'], 'takeoffs_session_id': sid})
        original_file = json.loads(case.target.read_bytes())
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['physical'], graph)
        sid = reopened['takeoffs_session_id']
        next_barrier = create('barrier', defect['entity']['id'])
        next_service = create('service', next_barrier['entity']['id'])
        state = commit([next_barrier, next_service])
        self.assertEqual(state['snapshot']['physical']['barriers'][-1]['display_id'], 'B-0002')
        self.assertEqual(state['snapshot']['physical']['services'][-1]['display_id'], 'S-0002')
        self.assertEqual(state['snapshot']['physical']['defects'][0]['display_id'], 'D-0001')
        self.assertEqual(state['snapshot']['physical']['barriers'][0], graph['barriers'][0])
        second_target = case.root / 'continued.json'
        case.dialogs.selection = SaveSelection(str(second_target), None)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': state['snapshot'], 'takeoffs_session_id': sid})
        final_file = json.loads(second_target.read_bytes())
        self.assertEqual(json.loads(case.target.read_bytes()), original_file)
        for key in ('estimate', 'calculators'):
            self.assertEqual(final_file[key], original_file[key])
        case.dialogs.opened = str(second_target)
        reopened_again = case.library.open_file()
        self.assertEqual(reopened_again['takeoffs_issues'], [])
        self.assertEqual(reopened_again['takeoffs']['physical'], state['snapshot']['physical'])


if __name__ == '__main__':
    unittest.main()
