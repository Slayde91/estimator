"""Derived parent report unions retain every row's independent selections."""
from copy import deepcopy
from io import BytesIO
import json
from threading import RLock
import unittest
from uuid import uuid4

from openpyxl import load_workbook

from estimator.register_references import ReferenceIndex, physical_contexts
from tests.test_register_references import prepared
from tests.test_takeoff_physical import uid
from tests import test_takeoff_physical_v2_exports as graph_fixture
from tests import test_takeoff_project as project_fixture


class RollupTests(unittest.TestCase):
    def setUp(self):
        self.fixture = graph_fixture.PhysicalV2ExportTests(); self.fixture.setUp()
        self.graph = self.fixture.graph
        self.graph['defects'][0]['technical_reference_ids'] = ['a-one']
        self.graph['barriers'][0]['technical_reference_ids'] = ['a-two']
        self.graph['barriers'][1]['technical_reference_ids'] = ['a-one']
        self.graph['services'][0]['technical_reference_ids'] = ['z-three']
        self.index = ReferenceIndex(prepared(), 'e' * 64)

    def references(self, identifier, **options):
        snapshot = {'physical': self.fixture.graph}
        contexts = physical_contexts(snapshot, 'defect_reports', [identifier], **options)
        return self.index.project(contexts[identifier])

    def test_parent_selections_do_not_hide_children_and_reports_are_unique(self):
        before = deepcopy(self.graph)
        self.assertEqual({row['id'] for row in self.references(uid(1))['systems']}, {'a-one', 'a-two', 'z-three'})
        self.assertEqual({row['id'] for row in self.references(uid(2))['systems']}, {'a-two', 'z-three'})
        self.assertEqual([row['id'] for row in self.references(uid(3))['systems']], ['z-three'])
        self.assertEqual([row['label'] for row in self.references(uid(1))['reports']], ['FC-1 Rev A', 'FC-1 Rev B', 'Private report'])
        self.assertEqual([row['id'] for row in self.references(uid(1), own_only=True)['systems']], ['a-one'])
        self.assertEqual(self.graph, before)

    def test_explicit_clear_reparent_and_deletion_recompute_without_copying(self):
        self.fixture.change({'op': 'update', 'entity_id': uid(2), 'changes': {'technical_reference_ids': []}})
        self.assertEqual([row['id'] for row in self.references(uid(2))['systems']], ['z-three'])
        self.assertEqual(self.references(uid(2), own_only=True)['systems'], [])
        self.fixture.change({'op': 'reparent', 'entity_id': uid(3), 'parent_id': uid(4)})
        self.assertEqual(self.references(uid(2))['systems'], [])
        self.assertEqual({row['id'] for row in self.references(uid(4))['systems']}, {'a-one', 'z-three'})
        self.fixture.change({'op': 'delete', 'entity_id': uid(3), 'cascade': False})
        self.assertEqual([row['id'] for row in self.references(uid(1))['systems']], ['a-one'])
        self.assertEqual(self.fixture.graph['services'][0]['technical_reference_ids'], ['z-three'])

    def test_service_plans_roll_up_only_the_owning_barrier(self):
        graph = deepcopy(self.graph); graph['version'] = 3; del graph['defects']
        for barrier in graph['barriers']: del barrier['defect_id']
        snapshot = {'service_plans': graph}
        contexts = physical_contexts(snapshot, 'service_plans', [uid(2), uid(4)])
        self.assertEqual({row['id'] for row in self.index.project(contexts[uid(2)])['systems']}, {'a-two', 'z-three'})
        self.assertEqual([row['id'] for row in self.index.project(contexts[uid(4)])['systems']], ['a-one'])


class RollupProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixture.TakeoffProjectTests.setUpClass()

    def test_edit_save_reopen_and_register_export_keep_own_selections_and_rollup(self):
        case = project_fixture.TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        index = ReferenceIndex(prepared(), 'e' * 64)
        class Library:
            _lock = RLock()
            def _load(self):
                return index.data
            def register_references(self, contexts, **options):
                return {'library_revision': index.revision, 'row_references': {
                    key: index.project(value, limit=options.get('limit', 100), excel=options.get('excel', False))
                    for key, value in contexts.items()}}
        case.service.libraries = Library()
        identifiers = [str(uuid4()) for _ in range(3)]
        commands = []
        for kind, identifier, selected, parent in zip(('defect', 'barrier', 'service'), identifiers,
                (['a-one'], ['a-two'], ['z-three']), (None, identifiers[0], identifiers[1])):
            entity = {'id': identifier, 'fields': {}, 'evidence': [], 'technical_reference_ids': selected,
                      'uncertainty': {'state': 'not_assessed', 'note': ''}}
            if kind == 'barrier': entity['defect_id'] = parent
            if kind == 'service': entity.update(barrier_id=parent, quantity=3)
            commands.append({'op': 'create', 'kind': kind, 'entity': entity})
        preview = case.service.preview_physical(case.session['session_id'], {
            'expected_revision': case.session['revision'], 'commands': commands})
        state = case.service.apply_physical(case.session['session_id'], {
            'expected_revision': case.session['revision'], 'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        preview = case.service.preview_physical(case.session['session_id'], {
            'expected_revision': state['revision'], 'commands': [{'op': 'update', 'entity_id': identifiers[2],
                'changes': {'technical_reference_ids': ['z-three', 'a-one']}}]})
        state = case.service.apply_physical(case.session['session_id'], {
            'expected_revision': state['revision'], 'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        original = deepcopy(state['snapshot']['physical'])
        self.assertEqual(original['defects'][0]['technical_reference_ids'], ['a-one'])
        self.assertEqual(original['barriers'][0]['technical_reference_ids'], ['a-two'])
        self.assertEqual(original['services'][0]['technical_reference_ids'], ['z-three', 'a-one'])
        request = {'expected_revision': state['revision'], 'scope': 'defect_reports', 'entity_ids': identifiers}
        rolled = case.service.register_references(case.session['session_id'], request)['row_references']
        self.assertEqual({row['id'] for row in rolled[identifiers[0]]['systems']}, {'a-one', 'a-two', 'z-three'})
        own = case.service.register_references(case.session['session_id'], {**request, 'own_only': True})['row_references']
        self.assertEqual([row['id'] for row in own[identifiers[0]]['systems']], ['a-one'])
        self.assertEqual(case.service.get(case.session['session_id'], verify_evidence=False)['snapshot']['physical'], original)
        case.library.save_as({**deepcopy(case.base), 'takeoffs': state['snapshot'], 'takeoffs_session_id': case.session['session_id']})
        saved = json.loads(case.target.read_bytes())
        for key in ('estimate', 'calculators'): self.assertEqual(saved[key], json.loads(case.legacy)[key])
        case.dialogs.opened = str(case.target); reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs']['physical'], original)
        payload, _, _ = case.service.export_physical(reopened['takeoffs_session_id'], 'register-xlsx',
                                                    expected_revision=reopened['takeoffs']['revision'])
        workbook = load_workbook(BytesIO(payload)); self.addCleanup(workbook.close)
        rows = list(workbook.active.values); report = rows[0].index('Report')
        self.assertEqual([value.split(' — ')[0] for value in rows[1][report].split(' | ')], ['FC-1 Rev A', 'FC-1 Rev B', 'Private report'])
        self.assertEqual(case.service.get(reopened['takeoffs_session_id'], verify_evidence=False)['snapshot']['physical'], original)
