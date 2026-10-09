"""One-click register transfer requires current review and explicit physical counts."""
from copy import deepcopy
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_physical import confirmation_owner_kind, graph_collections
from tests import test_takeoff_library_links as fixtures
from tests.test_takeoff_physical_v2 import create
from tests.test_takeoff_service_plans import create as create_plan


class ConfirmedRegisterTransferTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.TakeoffLibraryLinkTests.setUpClass()

    def setUp(self):
        self.links = fixtures.TakeoffLibraryLinkTests()
        self.links.setUp()
        self.addCleanup(self.links.doCleanups)
        self.service, self.sid = self.links.service, self.links.sid

    def state(self):
        return self.links.state()['snapshot']

    def records(self):
        return self.state().get('library_assignments', {}).get('records', [])

    def branch(self, scope='service_plans', quantities=(3,), *, confirmed=True, barrier=None):
        commands = []
        if barrier is None:
            if scope == 'defect_reports':
                defect = create('defect', label='Retained source Defect', frl='-/120/120')
                commands.append(defect)
                barrier = create('barrier', defect['entity']['id'], substrate='Concrete', orientation='Vertical')
            else:
                barrier = create_plan('barrier', substrate='Concrete', orientation='Vertical', frl='-/120/120')
            commands.append(barrier)
            barrier_id = barrier['entity']['id']
        else:
            barrier_id = barrier
        services = []
        for quantity in quantities:
            command = (create_plan if scope == 'service_plans' else create)(
                'service', barrier_id, service_type='Single Cables')
            command['entity']['quantity'] = quantity
            commands.append(command); services.append(command['entity']['id'])
        self.links.physical(commands, scope)
        if confirmed:
            self.links.review_physical([barrier_id, *services], scope)
        return barrier_id, services

    def associate(self, members, *, scope='service_plans', mode='repeated_installations', source='services', library_id='pkb-001'):
        library = self.links.library.takeoff_record(library_id)
        proposed = {'id': str(uuid4()), 'scope': scope, 'library_id': library['id'],
            'library_fingerprint': library['metadata_sha256'], 'member_ids': members,
            'installation': {'id': str(uuid4()), 'mode': mode,
                'note': 'Explicit shared installation' if mode == 'combined_installation' else ''}}
        if source is not None:
            proposed['quantity_source'] = {'version': 1, 'kind': 'services'} if source == 'services' else source
        self.service.command(self.sid, {'op': 'draft_library_assignment', 'request_id': str(uuid4()),
            'expected_revision': self.state()['revision'], 'assignment': proposed})
        return proposed['id']

    def review(self, scope='service_plans'):
        graph = self.state()['physical' if scope == 'defect_reports' else 'service_plans']
        commands = [{'op': 'update', 'entity_id': entity['id'], 'changes': {'confirmation': 'confirmed'}}
            for entity in graph[graph_collections(graph)[confirmation_owner_kind(graph)]]
            if not entity['deleted'] and entity.get('confirmation') != 'confirmed']
        if commands:
            self.links.physical(commands, scope)

    def request(self, scope='service_plans', **overrides):
        return {'scope': scope, 'expected_revision': self.state()['revision'], 'request_id': str(uuid4()),
                'draft': deepcopy(self.links.draft), 'configuration': deepcopy(self.links.configuration), **overrides}

    def transfer(self, scope='service_plans', **overrides):
        request = self.request(scope, **overrides)
        result = self.service.transfer_confirmed_library(self.sid, request)
        self.links.draft = deepcopy(result['penetration']['draft'])
        return result, request

    def blank_library(self, library_id='pkb-001'):
        edit = self.links.library.edit(library_id)
        draft = deepcopy(edit['draft']); draft['rows'][0]['inputs']['K'] = 'Blank Seal'
        self.links.library.action(library_id, 'save', {'draft': draft, 'revision': edit['revision'],
                                                     'pricing_token': edit['pricing_token']})

    def test_all_confirmed_assignments_in_scope_transfer_once_using_service_counts(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                barrier, services = self.branch(scope, (3, 4))
                first = self.associate([barrier, services[0]], scope=scope)
                second = self.associate([barrier, services[1]], scope=scope)
                before = deepcopy(self.state()); stored = self.links.calculator_storage()
                result, request = self.transfer(scope)
                self.assertEqual(result['revision'], before['revision'] + 1)
                self.assertEqual(result['library_link']['transferred'], 2)
                self.assertEqual({change['assignment_id'] for change in result['library_link']['changes']}, {first, second})
                self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 7 if scope == 'defect_reports' else 14)
                for key in ('physical', 'service_plans', 'items', 'documents', 'calibrations', 'transfers'):
                    self.assertEqual(result['snapshot'].get(key), before.get(key))
                self.assertEqual(self.links.calculator_storage(), stored)
                self.assertEqual(self.service.transfer_confirmed_library(self.sid, request), result)
                unchanged = deepcopy(self.state())
                with self.assertRaisesRegex(ValidationError, 'already linked'):
                    self.transfer(scope)
                self.assertEqual(self.state(), unchanged)
                event = self.links.case.documents.get_blob(result['snapshot']['audit_head'])
                self.assertEqual(event['op'], 'apply_library_link')
                self.assertEqual(set(event['affected_ids']['library_assignments']), {first, second})
                self.links.case.documents.validate_audit(result['snapshot'], owner=self.sid)
        self.links.assert_source_unchanged()

    def test_unconfirmed_and_unassociated_records_are_skipped_without_approval(self):
        _, ready = self.branch(quantities=(3,))
        self.associate(ready)
        _, pending = self.branch(quantities=(9,), confirmed=False)
        pending_id = self.associate(pending)
        self.branch(quantities=(20,))  # Confirmed service without an association.
        before = deepcopy(self.state()['service_plans'])
        result, _ = self.transfer()
        self.assertEqual(result['library_link']['skipped'], {'unconfirmed': 1, 'already_linked': 0, 'unassociated': 1})
        self.assertEqual(result['library_link']['transferred'], 1)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 3)
        self.assertEqual(result['snapshot']['service_plans'], before)
        self.assertIsNone(next(record for record in self.records() if record['id'] == pending_id)['schedule_binding'])

    def test_later_capacity_failure_cannot_publish_an_earlier_compiled_assignment(self):
        from estimator.penetration_calculator import definition
        _, services = self.branch(quantities=(3, 4))
        self.associate([services[0]])
        self.associate([services[1]], library_id='pkb-002')
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        with patch('estimator.penetration_calculator.definition',
                   side_effect=lambda configuration: {**definition(configuration), 'capacity': 1}):
            with self.assertRaisesRegex(ValidationError, 'Schedule is full'):
                self.transfer()
        self.assertEqual(self.state(), before)
        self.assertEqual(self.links.draft, draft)

    def test_every_parent_must_be_confirmed_and_old_confirm_api_has_same_gate(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                barrier, services = self.branch(scope)
                identifier = self.associate(services, scope=scope)
                graph = self.state()['physical' if scope == 'defect_reports' else 'service_plans']
                parent = graph['defects'][0]['id'] if scope == 'defect_reports' else barrier
                self.links.physical([{'op': 'update', 'entity_id': parent,
                                      'changes': {'confirmation': 'unconfirmed'}}], scope)
                before = deepcopy(self.state())
                with self.assertRaisesRegex(ValidationError, 'No confirmed unlinked'):
                    self.transfer(scope)
                with self.assertRaisesRegex(ValidationError, 'Confirm '):
                    self.links.preview(identifier, 3)
                self.assertEqual(self.state(), before)
                self.review(scope)
                result, _ = self.transfer(scope)
                self.assertEqual(result['library_link']['transferred'], 1)

    def test_fresh_human_review_recaptures_changed_context_and_current_quantity(self):
        _, services = self.branch(quantities=(3,))
        identifier = self.associate(services)
        original = deepcopy(self.records()[0])
        self.links.physical([{'op': 'update', 'entity_id': services[0], 'changes': {'quantity': 8}}], 'service_plans')
        self.assertEqual(self.records()[0]['state'], 'needs_recheck')
        with self.assertRaisesRegex(ValidationError, 'No confirmed unlinked'):
            self.transfer()
        self.review()
        before = deepcopy(self.state()['service_plans'])
        result, _ = self.transfer()
        record = next(value for value in self.records() if value['id'] == identifier)
        self.assertEqual(record['schedule_binding']['quantity'], 8)
        self.assertNotEqual(record['context_sha256'], original['context_sha256'])
        self.assertEqual(result['snapshot']['service_plans'], before)
        self.links.physical([{'op': 'update', 'entity_id': services[0], 'changes': {'quantity': 9}}], 'service_plans')
        with self.assertRaisesRegex(ValidationError, 'Confirm '):
            self.links.preview(identifier, 9)
        self.review()
        self.links.confirm(identifier, 9)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 9)

    def test_combined_installation_contributes_one_without_erasing_service_counts(self):
        _, services = self.branch(quantities=(3, 4))
        self.associate(services, mode='combined_installation')
        before = deepcopy(self.state()['service_plans'])
        self.transfer()
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 1)
        self.assertEqual(self.state()['service_plans'], before)

    def test_manual_association_adopts_only_explicit_service_quantity_source(self):
        _, services = self.branch(quantities=(6, 99))
        self.associate([services[0]], source=None)
        self.transfer()
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 6)
        self.assertEqual(self.records()[0]['quantity_source'], {'version': 1, 'kind': 'services'})

    def test_parent_only_service_item_never_infers_descendant_counts(self):
        barrier, _ = self.branch(quantities=(6,))
        self.associate([barrier], source=None)
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'explicit service members'):
            self.transfer()
        self.assertEqual(self.state(), before)

    def test_blank_seal_uses_retained_explicit_count_and_never_marker_count(self):
        self.blank_library()
        barrier, _ = self.branch(quantities=())
        self.associate([barrier], source={'version': 1, 'kind': 'blank_seals', 'quantity': 5})
        self.transfer()
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 5)
        self.assertEqual(self.state()['service_plans']['services'], [])

    def test_blank_seal_without_explicit_count_is_rejected(self):
        self.blank_library()
        barrier, _ = self.branch(quantities=())
        self.associate([barrier], source=None)
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'explicit retained seal count'):
            self.transfer()
        self.assertEqual(self.state(), before)

    def test_unknown_quantity_rejects_whole_batch_without_partial_links(self):
        _, good = self.branch(quantities=(3,))
        self.associate(good)
        commands, unknown, _ = self.links.unknown_import('service_plans')
        self.links.physical(commands, 'service_plans')
        self.links.review_physical([unknown], 'service_plans')
        self.associate([unknown])
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        with self.assertRaisesRegex(ValidationError, 'quantity is unknown'):
            self.transfer()
        self.assertEqual(self.state(), before); self.assertEqual(self.links.draft, draft)

    def test_changed_library_rejects_entire_batch(self):
        _, first = self.branch(); self.associate(first)
        _, second = self.branch(); self.associate(second, library_id='pkb-002')
        before = deepcopy(self.state())
        lookup, calls = self.service._selected_library, []

        def changed(identifier):
            result = deepcopy(lookup(identifier)); calls.append(identifier)
            if len(calls) == 2:
                result['metadata_sha256'] = '0' * 64
            return result

        with patch.object(self.service, '_selected_library', side_effect=changed):
            with self.assertRaisesRegex(ValidationError, 'library item changed'):
                self.transfer()
        self.assertEqual(self.state(), before)
        self.assertTrue(all(record['schedule_binding'] is None for record in self.records()))

    def test_batch_reuses_metadata_and_definition_only_inside_each_transaction(self):
        from estimator.penetration_calculator import definition, normalize_draft
        from estimator.takeoff_library_links import _physical_context
        _, services = self.branch(quantities=(3, 4))
        self.associate([services[0]]); self.associate([services[1]])
        self.links.draft['rows'] = [{'id': 'retained', 'library_item_id': 'pkb-001', 'inputs': {'O': 10}}]
        with patch.object(self.service, '_selected_library', wraps=self.service._selected_library) as lookup, \
                patch('estimator.penetration_calculator.definition', wraps=definition) as definitions, \
                patch('estimator.penetration_calculator.normalize_draft', wraps=normalize_draft) as normalizations, \
                patch('estimator.takeoff_library_links._physical_context', wraps=_physical_context) as indexes:
            self.transfer()
            self.assertEqual(lookup.call_count, 1)
            self.assertEqual(definitions.call_count, 1)
            self.assertEqual(normalizations.call_count, 2)
            self.assertEqual(indexes.call_count, 1)
            first_index_graph = indexes.call_args.args[0]['service_plans']
        _, additional = self.branch(quantities=(6,))
        self.associate(additional)
        with patch.object(self.service, '_selected_library', wraps=self.service._selected_library) as lookup, \
                patch('estimator.takeoff_library_links._physical_context', wraps=_physical_context) as indexes:
            self.transfer()
            self.assertEqual(lookup.call_count, 1)
            self.assertEqual(indexes.call_count, 1)
            self.assertIsNot(indexes.call_args.args[0]['service_plans'], first_index_graph)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 23)

    def test_batch_matches_successive_ordinary_previews_exactly(self):
        from estimator.catalog import baseline, validate_configuration
        from estimator.takeoff_library_links import (assignment_quantity, confirmation_preview,
                                                     confirmed_transfer_preview)
        self.blank_library('pkb-002')
        _, services = self.branch(quantities=(3, 4, 7))
        self.associate([services[0]])
        self.associate(services[1:], mode='combined_installation')
        barrier, _ = self.branch(quantities=())
        self.associate([barrier], library_id='pkb-002',
                       source={'version': 1, 'kind': 'blank_seals', 'quantity': 5})
        self.links.draft = {'globals': {'J': 'No', 'waste_board': .123456789, 'register_allowance_hours': .456789012},
            'rows': [{'id': 'manual', 'library_item_id': 'pkb-001', 'inputs': {'O': 10.125,
                'AI': 50.123456789012, 'AJ': 100.987654321098, 'T': 'Retained manual words'}},
                {'id': 'unrelated', 'inputs': {'O': 1.25, 'AI': 123.987654321}}]}
        configuration = validate_configuration({'inventory': {baseline()['inventory'][0]['id']: {'markup': .4567890123}}})
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        ordinary, output, changes = deepcopy(before), deepcopy(draft), []
        for record in before['library_assignments']['records']:
            result = confirmation_preview(ordinary, record['id'], assignment_quantity(ordinary, record), output,
                self.service._selected_library(record['library']['id']), configuration,
                quantity_source=record['quantity_source'])
            ordinary['library_assignments']['records'] = [result['assignment'] if entry['id'] == record['id'] else entry
                for entry in ordinary['library_assignments']['records']]
            output = result['draft']
            changes.append({**result['change'], 'assignment_id': record['id']})
        result = confirmed_transfer_preview(before, 'service_plans', draft, self.service._selected_library, configuration)
        self.assertEqual(result['snapshot'], ordinary)
        self.assertEqual(result['penetration']['draft'], output)
        self.assertEqual(result['library_link']['changes'], changes)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.links.draft, draft)

    def test_maximum_graph_index_matches_ordinary_previews_in_both_scopes(self):
        from estimator.takeoff_library_links import (assignment_quantity, confirmation_preview,
                                                     confirmed_transfer_preview)
        from estimator.takeoff_physical import validate_graph
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                _, services = self.branch(scope, quantities=(3, 4))
                self.associate([services[0]], scope=scope); self.associate([services[1]], scope=scope)
                snapshot = deepcopy(self.state())
                graph = snapshot['physical' if scope == 'defect_reports' else 'service_plans']
                prototype = deepcopy(graph['services'][0])
                total = sum(len(graph[collection]) for collection in graph_collections(graph).values())
                for ordinal in range(3, 3 + 10000 - total):
                    entity = deepcopy(prototype)
                    entity.update(id=str(uuid4()), display_id=f'S-{ordinal:04d}')
                    graph['services'].append(entity)
                validate_graph(graph, copy_result=False)
                before, ordinary, output = deepcopy(snapshot), deepcopy(snapshot), deepcopy(self.links.draft)
                for record in snapshot['library_assignments']['records']:
                    if record['scope'] != scope:
                        continue
                    result = confirmation_preview(ordinary, record['id'], assignment_quantity(ordinary, record), output,
                        self.service._selected_library(record['library']['id']), {}, quantity_source=record['quantity_source'])
                    ordinary['library_assignments']['records'] = [result['assignment'] if entry['id'] == record['id'] else entry
                        for entry in ordinary['library_assignments']['records']]
                    output = result['draft']
                compiled = confirmed_transfer_preview(snapshot, scope, self.links.draft, self.service._selected_library, {})
                self.assertEqual(compiled['snapshot'], ordinary)
                self.assertEqual(compiled['penetration']['draft'], output)
                self.assertEqual(snapshot, before)

    def test_physical_indexes_are_scope_pinned_and_keep_current_rejection_checks(self):
        from estimator.takeoff_library_links import (assignment_quantity, assert_members_confirmed,
            confirmed_transfer_preview, member_context, _physical_context)
        self.branch('defect_reports')
        _, services = self.branch(quantities=(3,))
        first = self.associate(services)
        barrier, pending = self.branch(quantities=(4,))
        self.associate(pending)
        snapshot = deepcopy(self.state()); records = snapshot['library_assignments']['records']
        record = next(record for record in records if record['id'] == first)
        context = _physical_context(snapshot, 'service_plans')
        for check in (lambda: member_context(snapshot, 'defect_reports', services, record['installation'], _physical=context),
                      lambda: assert_members_confirmed(deepcopy(snapshot), record, _physical=context),
                      lambda: assignment_quantity(deepcopy(snapshot), record, _physical=context)):
            with self.assertRaisesRegex(ValidationError, 'exact scope and graph'):
                check()
        for kind in ('deleted', 'parent_unconfirmed'):
            with self.subTest(kind=kind):
                altered = deepcopy(snapshot); graph = altered['service_plans']
                if kind == 'deleted':
                    entity = next(entity for entity in graph['services'] if entity['id'] == pending[0])
                    entity.update(deleted=True, deleted_at_revision=graph['revision'])
                else:
                    next(entity for entity in graph['barriers'] if entity['id'] == barrier)['confirmation'] = 'unconfirmed'
                result = confirmed_transfer_preview(altered, 'service_plans', self.links.draft,
                                                     self.service._selected_library, {})
                self.assertEqual(result['library_link']['transferred'], 1)
                self.assertEqual(result['library_link']['skipped']['unconfirmed'], 1)
                self.assertEqual(result['penetration']['draft']['rows'][0]['inputs']['O'], 3)

    def test_late_invalid_row_or_total_quantity_rejects_batch_atomically(self):
        _, services = self.branch(quantities=(1, 10**12))
        self.associate([services[0]]); self.associate([services[1]])
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        with self.assertRaisesRegex(ValidationError, 'positive finite installation quantity'):
            self.transfer()
        self.assertEqual(self.state(), before); self.assertEqual(self.links.draft, draft)
        # Another library item is a new row and must pass all entry requirements.
        _, additional = self.branch(quantities=(3,))
        self.associate(additional, library_id='pkb-002')
        snapshot = deepcopy(self.state())
        for record in snapshot['library_assignments']['records'][:2]:
            record['schedule_binding'] = {'row_id': 'existing', 'quantity': 1}
            record['confirmation'] = {'quantity': 1, 'context_sha256': record['context_sha256'],
                                      'library_sha256': record['library']['metadata_sha256']}
            record['state'] = 'confirmed'
        lookup = self.service._selected_library
        def incomplete(identifier):
            selected = deepcopy(lookup(identifier)); selected['inputs']['N'] = None
            return selected
        from estimator.takeoff_library_links import confirmed_transfer_preview
        with self.assertRaisesRegex(ValidationError, 'Complete FRL'):
            confirmed_transfer_preview(snapshot, 'service_plans', draft, incomplete, {})
        self.assertEqual(self.state()['service_plans'], snapshot['service_plans'])
        self.assertEqual(self.links.draft, draft)

    def test_request_rejects_caller_selection_quantity_filters_and_unknown_scope(self):
        _, services = self.branch(); self.associate(services)
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        for override in ({'quantity': 99}, {'assignment_ids': []}, {'selected_ids': []},
                         {'filter': 'confirmed'}, {'scope': 'unknown'}):
            with self.subTest(override=override), self.assertRaises(ValidationError):
                self.transfer(**override)
            self.assertEqual(self.state(), before); self.assertEqual(self.links.draft, draft)

    def test_overlapping_services_reject_atomically_instead_of_double_counting(self):
        _, services = self.branch(quantities=(3, 4))
        self.associate([services[0]])
        self.associate(services)
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'overlapping schedule'):
            self.transfer()
        self.assertEqual(self.state(), before)

    def test_new_overlap_with_previously_linked_service_is_rejected(self):
        _, services = self.branch(quantities=(3, 4))
        self.associate([services[0]]); self.transfer()
        self.associate(services)
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        with self.assertRaisesRegex(ValidationError, 'overlapping schedule'):
            self.transfer()
        self.assertEqual(self.state(), before); self.assertEqual(self.links.draft, draft)

    def test_legacy_blank_link_still_occupies_its_explicit_barrier(self):
        self.blank_library(); self.blank_library('pkb-002')
        barrier, _ = self.branch(quantities=())
        legacy = self.associate([barrier], source=None)
        self.links.confirm(legacy, 5)
        self.associate([barrier], library_id='pkb-002',
                       source={'version': 1, 'kind': 'blank_seals', 'quantity': 7})
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        with self.assertRaisesRegex(ValidationError, 'overlapping schedule'):
            self.transfer()
        self.assertEqual(self.state(), before); self.assertEqual(self.links.draft, draft)

    def test_explicit_defect_only_blank_associations_cannot_count_same_member_twice(self):
        self.blank_library(); self.blank_library('pkb-002')
        self.branch('defect_reports', quantities=())
        defect = self.state()['physical']['defects'][0]['id']
        for library_id in ('pkb-001', 'pkb-002'):
            self.associate([defect], scope='defect_reports', library_id=library_id,
                           source={'version': 1, 'kind': 'blank_seals', 'quantity': 5})
        before, draft = deepcopy(self.state()), deepcopy(self.links.draft)
        with self.assertRaisesRegex(ValidationError, 'overlapping schedule'):
            self.transfer('defect_reports')
        self.assertEqual(self.state(), before); self.assertEqual(self.links.draft, draft)

    def test_manual_schedule_prices_globals_and_fractional_baseline_are_exactly_preserved(self):
        _, services = self.branch(quantities=(3, 4))
        self.associate([services[0]]); self.associate([services[1]])
        self.links.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual', 'library_item_id': 'pkb-001',
            'inputs': {'O': 10.125, 'AI': 50.123456789012, 'AJ': 100.987654321098,
                       'T': 'Retained manual words', 'U': 'Retained specification'}},
            {'id': 'unrelated', 'inputs': {'O': 1.25, 'AI': 123.987654321}}]}
        before = deepcopy(self.links.draft)
        self.transfer()
        expected = deepcopy(before); expected['rows'][0]['inputs']['O'] = 17.125
        self.assertEqual(self.links.draft, expected)

    def test_duplicate_schedule_rows_and_response_limit_leave_everything_unchanged(self):
        _, services = self.branch(); self.associate(services)
        self.links.draft['rows'] = [{'id': name, 'library_item_id': 'pkb-001', 'inputs': {'O': 2}}
                                   for name in ('one', 'two')]
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'only once|duplicate rows'):
            self.transfer()
        self.assertEqual(self.state(), before)
        self.links.draft['rows'] = []
        with patch('estimator.takeoff_workspace.SESSION_CACHE_BYTES', 1):
            with self.assertRaisesRegex(ValidationError, 'response memory limit'):
                self.transfer()
        self.assertEqual(self.state(), before)

    def test_stale_revision_and_reused_request_id_never_duplicate_a_transfer(self):
        _, services = self.branch(); self.associate(services)
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'draft changed'):
            self.transfer(expected_revision=before['revision'] - 1)
        result, request = self.transfer()
        with self.assertRaisesRegex(ValidationError, 'different operation'):
            self.service.transfer_confirmed_library(self.sid, {**request, 'configuration': {'inventory': {}}})
        cached = self.service._session(self.sid)['requests'][request['request_id']]
        cached.pop('payload')
        with self.assertRaisesRegex(ValidationError, 'already applied'):
            self.service.transfer_confirmed_library(self.sid, request)
        self.assertEqual(self.state(), result['snapshot'])
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 3)

    def test_apply_receipt_failure_does_not_publish_partial_assignments(self):
        _, services = self.branch(quantities=(3, 4))
        self.associate([services[0]]); self.associate([services[1]])
        before = deepcopy(self.state()); validate = self.links.case.documents.validate_audit

        def reject(snapshot, **options):
            if snapshot['revision'] > before['revision']:
                raise ValidationError('Injected audit rejection')
            return validate(snapshot, **options)

        with patch.object(self.links.case.documents, 'validate_audit', side_effect=reject):
            with self.assertRaisesRegex(ValidationError, 'Injected audit rejection'):
                self.transfer()
        self.assertEqual(self.state(), before)
        self.assertEqual(self.links.draft['rows'], [])

    def test_unlink_remains_available_after_physical_review_is_invalidated(self):
        _, services = self.branch(); identifier = self.associate(services)
        self.transfer()
        self.links.physical([{'op': 'update', 'entity_id': services[0], 'changes': {'quantity': 8}}], 'service_plans')
        self.links.apply(self.links.preview(identifier, 0, operation='unlink'))
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 0)
        self.assertEqual(self.state()['service_plans']['services'][0]['quantity'], 8)


if __name__ == '__main__':
    unittest.main()
