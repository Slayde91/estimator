"""Physical reference choices are explicit, portable, reversible metadata."""
from copy import deepcopy
from io import BytesIO
import json
import unittest
from uuid import uuid4

from openpyxl import load_workbook

from estimator.catalog import ValidationError
from estimator.penetration_references import resolve_schedule_references, capture_transfer_references
from estimator.register_references import physical_contexts
from estimator.takeoff_model import validate_snapshot
from estimator.takeoff_physical import apply_change, preview_change
from estimator.takeoff_register_xlsx import export_physical_register


class PhysicalExplicitReferenceTests(unittest.TestCase):
    def setUp(self):
        from tests.test_penetration_references import PenetrationReferenceTests
        self.fixture = PenetrationReferenceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def update(self, graph, identifier, value):
        command = {'op': 'update', 'entity_id': identifier,
                   'changes': {'technical_reference_ids': value}}
        preview = preview_change(graph, command)
        return apply_change(graph, command, expected_revision=graph['revision'],
                            preview_digest=preview['preview_digest'])['graph']

    def test_recorded_facts_prefilter_without_selecting_and_library_links_still_win(self):
        for scope in ('defect_reports', 'service_plans'):
            draft, snapshot = self.fixture.legacy_takeoff(scope)
            graph = snapshot['physical' if scope == 'defect_reports' else 'service_plans']
            identifier = graph['services'][0]['id']
            contexts = physical_contexts(snapshot, scope, [identifier])
            before = deepcopy(snapshot)
            result = self.fixture.library.register_references(contexts)['row_references'][identifier]
            self.assertEqual((result['reports'], result['systems']), ([], []))
            self.assertEqual(result['initial_filters']['orientation'], 'Vertical')
            snapshot['library_assignments'] = {'records': [{'scope': scope, 'library': {'id': 'pkb-001'},
                                                            'members': [{'id': identifier}]}]}
            linked = physical_contexts(snapshot, scope, [identifier])
            result = self.fixture.library.register_references(linked)['row_references'][identifier]
            self.assertEqual([item['id'] for item in result['systems']], ['report-a-v1'])
            snapshot.pop('library_assignments')
            self.assertEqual(snapshot, before)

    def test_choices_roundtrip_keep_physical_facts_and_confirmation_and_capture_on_transfer(self):
        for scope in ('defect_reports', 'service_plans'):
            draft, snapshot = self.fixture.legacy_takeoff(scope)
            graph_key = 'physical' if scope == 'defect_reports' else 'service_plans'
            graph = snapshot[graph_key]
            original = deepcopy(graph)
            identifier = graph['services'][0]['id']
            snapshot[graph_key] = self.update(graph, identifier, ['report-a-v2', 'report-a-v1'])
            restored = validate_snapshot(json.loads(json.dumps(snapshot)))
            self.assertEqual(restored[graph_key], snapshot[graph_key])
            for key in ('defects', 'barriers', 'services'):
                for old, new in zip(original.get(key, []), restored[graph_key].get(key, [])):
                    self.assertEqual(old['fields'], new['fields'])
                    self.assertEqual(old.get('quantity'), new.get('quantity'))
                    self.assertEqual(old.get('confirmation'), new.get('confirmation'))
                    self.assertEqual(old['evidence'], new['evidence'])
            references = resolve_schedule_references(draft, self.fixture.library, snapshot=restored)
            self.assertEqual([item['id'] for item in references['row_references'][draft['rows'][0]['id']]['systems']], ['report-a-v2', 'report-a-v1'])
            captured = capture_transfer_references(draft, {'globals': {}, 'rows': []}, restored, self.fixture.library)
            self.assertEqual(captured['rows'][0]['takeoff_reference_ids'], ['report-a-v2', 'report-a-v1'])
            portable = resolve_schedule_references(captured, self.fixture.library)
            self.assertEqual(len(portable['row_references'][draft['rows'][0]['id']]['reports']), 2)

    def test_explicit_clear_suppresses_linked_and_parent_fallback_until_inherit_is_selected(self):
        draft, snapshot = self.fixture.legacy_takeoff('service_plans')
        graph = snapshot['service_plans']; identifier = graph['services'][0]['id']
        snapshot['library_assignments'] = {'records': [{'scope': 'service_plans', 'library': {'id': 'pkb-001'},
                                                        'members': [{'id': identifier}]}]}
        graph = self.update(graph, identifier, [])
        snapshot['service_plans'] = graph
        ids = [graph['barriers'][0]['id'], identifier]
        references = self.fixture.library.register_references(physical_contexts(snapshot, 'service_plans', ids))
        self.assertTrue(all(value['systems'] == [] for value in references['row_references'].values()))
        graph = self.update(graph, identifier, None)
        self.assertNotIn('technical_reference_ids', graph['services'][0])
        snapshot['service_plans'] = graph
        references = self.fixture.library.register_references(physical_contexts(snapshot, 'service_plans', [identifier]))
        self.assertEqual(references['row_references'][identifier]['systems'][0]['id'], 'report-a-v1')

    def test_unselected_transfer_captures_empty_and_existing_schedule_selections_survive(self):
        draft, snapshot = self.fixture.legacy_takeoff('service_plans')
        selected = {'id': 'existing', 'inputs': {}, 'technical_reference_ids': ['report-a-v2']}
        draft['rows'].insert(0, deepcopy(selected))
        captured = capture_transfer_references(draft, {'rows': [selected]}, snapshot, self.fixture.library)
        self.assertEqual(captured['rows'][0], selected)
        self.assertEqual(captured['rows'][1]['takeoff_reference_ids'], [])

    def test_register_download_uses_only_explicit_or_linked_references(self):
        _, snapshot = self.fixture.legacy_takeoff('service_plans')
        graph = snapshot['service_plans']; identifier = graph['services'][0]['id']

        def exported():
            contexts = physical_contexts(snapshot, 'service_plans', [identifier])
            references = self.fixture.library.register_references(contexts)['row_references']
            workbook = load_workbook(BytesIO(export_physical_register(graph, confirmation='all', references=references)[0]))
            try:
                return [cell.value for row in workbook.active for cell in row]
            finally:
                workbook.close()

        self.assertFalse(any('TEST-100' in str(value) or 'TEST-200' in str(value) for value in exported()))
        graph = self.update(graph, identifier, ['report-a-v2'])
        snapshot['service_plans'] = graph
        cells = exported()
        self.assertTrue(any('TEST-200 Rev B' in str(value) for value in cells))
        self.assertFalse(any('TEST-100 Rev A' in str(value) for value in cells))

    def test_invalid_choices_fail_without_changing_graph(self):
        _, snapshot = self.fixture.legacy_takeoff('service_plans')
        graph = snapshot['service_plans']; before = deepcopy(graph)
        for value in ('report-a-v1', [None], ['../bad'], ['a', 'a'], ['a'] * 129):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                self.update(graph, graph['services'][0]['id'], value)
            self.assertEqual(graph, before)

    def test_real_save_reopen_and_undo_keep_selected_metadata_and_other_project_values(self):
        from tests.test_takeoff_project import TakeoffProjectTests
        from tests.test_takeoff_physical_v2 import create
        TakeoffProjectTests.setUpClass()
        case = TakeoffProjectTests(); case.setUp(); self.addCleanup(case.doCleanups)
        case.service.libraries = self.fixture.library
        sid = case.session['session_id']

        def commit(commands):
            current = case.service.get(sid, verify_evidence=False)
            preview = case.service.preview_physical(sid, {'expected_revision': current['revision'], 'commands': commands})
            return case.service.apply_physical(sid, {'expected_revision': current['revision'],
                'preview_id': preview['preview_id'], 'request_id': str(uuid4())})

        defect = create('defect'); barrier = create('barrier', defect['entity']['id'])
        service = create('service', barrier['entity']['id'])
        commit([defect, barrier, service])
        identifier = service['entity']['id']
        chosen = commit([{'op': 'update', 'entity_id': identifier,
                          'changes': {'technical_reference_ids': ['report-a-v2']}}])
        request = {**deepcopy(case.base), 'takeoffs': chosen['snapshot'], 'takeoffs_session_id': sid}
        case.library.save_as(request)
        saved = json.loads(case.target.read_bytes())
        case.dialogs.opened = str(case.target)
        reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['physical'], chosen['snapshot']['physical'])
        self.assertEqual(reopened['takeoffs']['physical']['services'][0]['technical_reference_ids'], ['report-a-v2'])
        for key in ('estimate', 'calculators'):
            self.assertEqual(saved[key], json.loads(case.legacy)[key])
        # Recover the reference-only edit in its original owned session.
        undone = case.service.command(sid, {'op': 'undo', 'expected_revision': chosen['revision'],
                                           'request_id': str(uuid4())})
        self.assertNotIn('technical_reference_ids', undone['snapshot']['physical']['services'][0])
        self.assertEqual(undone['snapshot']['physical']['services'][0]['fields'], service['entity']['fields'])

    def test_preview_rejects_missing_choice_and_rechecks_removed_system_before_apply(self):
        from tests.test_takeoff_physical_workspace import PhysicalWorkspaceTests
        fixture = PhysicalWorkspaceTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        fixture.service.libraries = self.fixture.library
        fixture.apply([fixture.defect()])
        state = fixture.state(); identifier = state['snapshot']['physical']['defects'][0]['id']
        commands = [{'op': 'update', 'entity_id': identifier,
                     'changes': {'technical_reference_ids': ['missing-record']}}]
        request = {'expected_revision': state['revision'], 'commands': commands}
        with self.assertRaisesRegex(ValidationError, 'unavailable'):
            fixture.service.preview_physical(fixture.sid, request)
        self.assertEqual(fixture.state(), state)
        commands[0]['changes']['technical_reference_ids'] = ['report-a-v2']
        preview = fixture.service.preview_physical(fixture.sid, request)
        self.fixture.data['libraries']['technical']['items'].pop()
        self.fixture.write()
        with self.assertRaisesRegex(ValidationError, 'unavailable'):
            fixture.service.apply_physical(fixture.sid, {'expected_revision': state['revision'],
                'preview_id': preview['preview_id'], 'request_id': str(uuid4())})
        self.assertEqual(fixture.state(), state)


if __name__ == '__main__':
    unittest.main()
