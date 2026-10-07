"""Manual physical review is lossless draft metadata, never schedule authority."""

from copy import deepcopy
import json
import unittest
from uuid import UUID, uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import new_snapshot, upgrade_snapshot, validate_snapshot
from estimator.takeoff_physical import (apply_change, graph_collections, graph_parents,
                                       new_graph, preview_change, validate_graph)
from estimator.takeoff_physical_operations import prepare_changes
from estimator.takeoff_annotations import DEFAULT_APPEARANCE
from tests import test_takeoff_workspace as workspace_fixtures
from tests import test_takeoff_library_links as link_fixtures


def uid(number):
    return str(UUID(int=number))


def create(graph, kind, number, parent=None, *, confirmation=None):
    entity = {'id': uid(number), 'fields': {'label': f'Synthetic {kind} {number}'},
              'evidence': [], 'uncertainty': {'state': 'conflicting',
                  'note': 'Retained source disagreement; manual review is separate.'}}
    if kind in graph_parents(graph):
        entity[graph_parents(graph)[kind][1]] = parent
    if kind == 'service':
        entity['quantity'] = 3
        entity['fields']['diameter_mm'] = 12.3456789012345
    if confirmation is not None:
        entity['confirmation'] = confirmation
    return {'op': 'create', 'kind': kind, 'entity': entity}


def apply(graph, command):
    preview = preview_change(graph, command)
    return apply_change(graph, command, expected_revision=graph['revision'],
                        preview_digest=preview['preview_digest'])['graph'], preview


def entity(graph, identifier):
    return next(value for collection in graph_collections(graph).values()
                for value in graph[collection] if value['id'] == identifier)


def graph_fixture(version, *, confirmed=True):
    graph = new_graph(uid(90), uid(91), version=version)
    confirmation = 'confirmed' if confirmed and version in (2, 3) else None
    ids = {'root': uid(1), 'barrier': uid(2), 'service': uid(3),
           'other_root': uid(4), 'other_barrier': uid(5), 'other_service': uid(6)}
    if version == 2:
        definitions = [('defect', 1, None), ('barrier', 2, uid(1)), ('service', 3, uid(2)),
                       ('defect', 4, None), ('barrier', 5, uid(4)), ('service', 6, uid(5))]
    elif version == 3:
        ids.update(barrier=uid(1), other_barrier=uid(4))
        definitions = [('barrier', 1, None), ('service', 3, uid(1)),
                       ('barrier', 4, None), ('service', 6, uid(4))]
    else:
        definitions = [('barrier', 1, None), ('defect', 2, uid(1)),
                       ('opening', 7, uid(2)), ('service', 3, uid(7))]
    for kind, number, parent in definitions:
        graph, _ = apply(graph, create(graph, kind, number, parent,
                                      confirmation=confirmation))
    return graph, ids


class PhysicalConfirmationModelTests(unittest.TestCase):
    def assert_unchanged_except(self, before, after, allowed):
        self.assertEqual({key: value for key, value in before.items() if key not in allowed},
                         {key: value for key, value in after.items() if key not in allowed})

    def test_legacy_absence_is_not_synthesized_by_validation_or_unrelated_edits(self):
        for version in (1, 2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version, confirmed=False)
                encoded = json.dumps(graph, sort_keys=True)
                validated = validate_graph(graph)
                self.assertEqual(validated, graph)
                self.assertEqual(json.dumps(graph, sort_keys=True), encoded)
                self.assertTrue(all('confirmation' not in value for collection in
                    graph_collections(graph).values() for value in validated[collection]))
                updated, _ = apply(graph, {'op': 'update', 'entity_id': ids['service'],
                    'changes': {'fields': {'label': 'Explicit updated service'}}})
                self.assertTrue(all('confirmation' not in value for collection in
                    graph_collections(updated).values() for value in updated[collection]))

    def test_version_one_rejects_confirmation_in_snapshot_create_and_update(self):
        graph, ids = graph_fixture(1)
        for value in ('confirmed', 'unconfirmed'):
            with self.subTest(value=value):
                altered = deepcopy(graph); altered['services'][0]['confirmation'] = value
                with self.assertRaises(ValidationError):
                    validate_graph(altered)
                with self.assertRaises(ValidationError):
                    preview_change(graph, {'op': 'update', 'entity_id': ids['service'],
                                          'changes': {'confirmation': value}})
                command = create(graph, 'barrier', 20, confirmation=value)
                with self.assertRaises(ValidationError):
                    preview_change(graph, command)

    def test_only_exact_lowercase_string_states_are_accepted_at_all_boundaries(self):
        invalid = (None, True, False, 1, 0, [], {}, 'Confirmed', 'Unconfirmed',
                   'approved', 'none_reported', '', ' confirmed', 'confirmed ')
        for version in (2, 3):
            graph, ids = graph_fixture(version)
            root_kind = 'defect' if version == 2 else 'barrier'
            for value in invalid:
                with self.subTest(version=version, value=value):
                    altered = deepcopy(graph); entity(altered, ids['root'])['confirmation'] = value
                    with self.assertRaises(ValidationError):
                        validate_graph(altered)
                    command = create(graph, root_kind, 20)
                    command['entity']['confirmation'] = value
                    with self.assertRaises(ValidationError):
                        preview_change(graph, command)
                    with self.assertRaises(ValidationError):
                        preview_change(graph, {'op': 'update', 'entity_id': ids['root'],
                                              'changes': {'confirmation': value}})
            for value in ('confirmed', 'unconfirmed'):
                with self.subTest(version=version, valid=value):
                    command = create(graph, root_kind, 20, confirmation=value)
                    updated, _ = apply(graph, command)
                    self.assertEqual(entity(updated, uid(20))['confirmation'], value)

    def test_review_only_toggle_changes_target_revision_without_erasing_uncertainty_or_descendants(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                original = deepcopy(graph)
                unconfirmed, preview = apply(graph, {'op': 'update', 'entity_id': ids['root'],
                                                    'changes': {'confirmation': 'unconfirmed'}})
                self.assertEqual(graph, original)
                self.assertEqual(preview['changed_ids'], [ids['root']])
                self.assertEqual(preview['authority'], 'none'); self.assertEqual(preview['state'], 'draft')
                self.assert_unchanged_except(entity(graph, ids['root']),
                    entity(unconfirmed, ids['root']), {'confirmation', 'revision'})
                for identifier in set(ids.values()) - {ids['root']}:
                    if any(value['id'] == identifier for collection in graph_collections(graph).values()
                           for value in graph[collection]):
                        self.assertEqual(entity(unconfirmed, identifier), entity(graph, identifier))
                confirmed, _ = apply(unconfirmed, {'op': 'update', 'entity_id': ids['root'],
                                                  'changes': {'confirmation': 'confirmed'}})
                self.assertEqual(entity(confirmed, ids['root'])['confirmation'], 'confirmed')
                self.assertEqual(entity(confirmed, ids['root'])['uncertainty'],
                                 entity(graph, ids['root'])['uncertainty'])
                self.assertEqual(confirmed['state'], 'draft')

    def test_redundant_confirmed_review_is_no_op_and_identical_fact_submission_keeps_review(self):
        for version in (2, 3):
            graph, ids = graph_fixture(version)
            for changes in ({'confirmation': 'confirmed'},
                    {'fields': deepcopy(entity(graph, ids['root'])['fields']),
                     'confirmation': 'confirmed'}):
                with self.subTest(version=version, changes=changes), self.assertRaisesRegex(
                        ValidationError, 'does not change'):
                    preview_change(graph, {'op': 'update', 'entity_id': ids['root'],
                                           'changes': changes})
            self.assertEqual(entity(graph, ids['root'])['confirmation'], 'confirmed')

    def test_changed_root_facts_reset_only_its_reviewed_subtree_with_explicit_preview_ids(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                updated, preview = apply(graph, {'op': 'update', 'entity_id': ids['root'],
                    'changes': {'fields': {'label': 'Reviewed facts changed', 'location': 'Level 2'}}})
                subtree = {ids['root'], ids['barrier'], ids['service']}
                self.assertEqual(set(preview['changed_ids']), subtree)
                self.assertEqual(set(preview['affected_ids']), subtree)
                for identifier in subtree:
                    self.assertEqual(entity(updated, identifier)['confirmation'], 'unconfirmed')
                    self.assertEqual(entity(updated, identifier)['revision'], entity(graph, identifier)['revision'] + 1)
                    self.assertEqual(entity(updated, identifier)['uncertainty'], entity(graph, identifier)['uncertainty'])
                for identifier in {ids['other_root'], ids['other_barrier'], ids['other_service']}:
                    self.assertEqual(entity(updated, identifier), entity(graph, identifier))
                self.assertEqual(entity(updated, ids['service'])['quantity'], 3)
                self.assertEqual(entity(updated, ids['service'])['fields']['diameter_mm'], 12.3456789012345)

    def test_barrier_fact_change_resets_child_service_but_preserves_ancestor_and_other_branch(self):
        graph, ids = graph_fixture(2)
        updated, preview = apply(graph, {'op': 'update', 'entity_id': ids['barrier'],
            'changes': {'fields': {'label': 'Barrier revised', 'substrate': 'Masonry'}}})
        self.assertEqual(set(preview['changed_ids']), {ids['barrier'], ids['service']})
        self.assertEqual(entity(updated, ids['root']), entity(graph, ids['root']))
        self.assertEqual(entity(updated, ids['other_service']), entity(graph, ids['other_service']))
        self.assertEqual(entity(updated, ids['barrier'])['confirmation'], 'unconfirmed')
        self.assertEqual(entity(updated, ids['service'])['confirmation'], 'unconfirmed')

    def test_service_quantity_or_evidence_change_resets_only_that_service_and_keeps_exact_facts(self):
        for version in (2, 3):
            graph, ids = graph_fixture(version)
            evidence = [{'document_id': uid(30), 'document_sha256': 'a' * 64, 'page': 1,
                         'fields': ['quantity'], 'note': 'Explicit source annotation'}]
            for changes in ({'quantity': 7}, {'evidence': evidence}):
                with self.subTest(version=version, changes=changes):
                    updated, preview = apply(graph, {'op': 'update', 'entity_id': ids['service'],
                                                    'changes': changes})
                    self.assertEqual(preview['changed_ids'], [ids['service']])
                    self.assertEqual(entity(updated, ids['service'])['confirmation'], 'unconfirmed')
                    for key, value in changes.items():
                        self.assertEqual(entity(updated, ids['service'])[key], value)
                    self.assertEqual(entity(updated, ids['barrier']), entity(graph, ids['barrier']))

    def test_marker_and_annotation_presentation_preserve_review_but_source_locator_changes_reset_it(self):
        for version, source_key in ((2, 'marker'), (2, 'annotation'), (3, 'marker')):
            with self.subTest(version=version, source_key=source_key):
                graph, ids = graph_fixture(version, confirmed=False)
                target = ids['root'] if source_key == 'annotation' else ids['barrier']
                source = {'document_id': uid(30), 'document_sha256': 'a' * 64,
                          'page': 1, 'point': [50.123456789, 60.987654321]}
                graph, _ = apply(graph, {'op': 'update', 'entity_id': target,
                                        'changes': {source_key: source}})
                for identifier in {ids['root'], ids['barrier'], ids['service']}:
                    graph, _ = apply(graph, {'op': 'update', 'entity_id': identifier,
                                            'changes': {'confirmation': 'confirmed'}})
                presentation = {**source, 'appearance': deepcopy(DEFAULT_APPEARANCE),
                    'callout': {'offset': [12.125, -4.875], 'width': 120.5,
                                'height': 45.5, 'appearance': deepcopy(DEFAULT_APPEARANCE)}}
                decorated, preview = apply(graph, {'op': 'update', 'entity_id': target,
                                                  'changes': {source_key: presentation}})
                self.assertEqual(preview['changed_ids'], [target])
                for identifier in {ids['root'], ids['barrier'], ids['service']}:
                    self.assertEqual(entity(decorated, identifier)['confirmation'], 'confirmed')
                    if identifier != target:
                        self.assertEqual(entity(decorated, identifier), entity(graph, identifier))
                self.assertEqual(entity(decorated, target)[source_key], presentation)
                for patch in ({'point': [55.125, 65.875]}, {'document_sha256': 'b' * 64},
                              {'page': 2}, {'document_id': uid(31)}):
                    moved, source_preview = apply(decorated, {'op': 'update', 'entity_id': target,
                        'changes': {source_key: {**presentation, **patch}}})
                    expected = {target, ids['service']} | ({ids['barrier']} if source_key == 'annotation' else set())
                    self.assertEqual(set(source_preview['changed_ids']), expected)
                    for identifier in expected:
                        self.assertEqual(entity(moved, identifier)['confirmation'], 'unconfirmed')
                    self.assertEqual(entity(moved, ids['service'])['quantity'], 3)
                    self.assertEqual(entity(moved, ids['service'])['fields']['diameter_mm'], 12.3456789012345)

    def test_resubmitting_old_confirmed_value_with_changed_facts_cannot_keep_review(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                updated, _ = apply(graph, {'op': 'update', 'entity_id': ids['service'],
                    'changes': {'quantity': 9, 'confirmation': 'confirmed'}})
                self.assertEqual(entity(updated, ids['service'])['confirmation'], 'unconfirmed')
                self.assertEqual(entity(updated, ids['service'])['quantity'], 9)

    def test_explicit_unconfirmed_to_confirmed_review_may_accept_new_values_without_confirming_children(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                graph, _ = apply(graph, {'op': 'update', 'entity_id': ids['root'],
                                        'changes': {'confirmation': 'unconfirmed'}})
                updated, preview = apply(graph, {'op': 'update', 'entity_id': ids['root'],
                    'changes': {'fields': {'label': 'Explicitly reviewed new facts'},
                                'confirmation': 'confirmed'}})
                self.assertEqual(entity(updated, ids['root'])['confirmation'], 'confirmed')
                for identifier in {ids['barrier'], ids['service']} - {ids['root']}:
                    self.assertEqual(entity(updated, identifier)['confirmation'], 'unconfirmed')
                    self.assertIn(identifier, preview['changed_ids'])
                self.assertEqual(entity(updated, ids['root'])['uncertainty'], entity(graph, ids['root'])['uncertainty'])

    def test_reparent_resets_moved_record_and_context_descendants_without_changing_quantity_or_ids(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                target = ids['barrier'] if version == 2 else ids['service']
                parent = ids['other_root'] if version == 2 else ids['other_barrier']
                updated, preview = apply(graph, {'op': 'reparent', 'entity_id': target, 'parent_id': parent})
                moved = {ids['barrier'], ids['service']} if version == 2 else {ids['service']}
                self.assertEqual(set(preview['changed_ids']), moved)
                for identifier in moved:
                    self.assertEqual(entity(updated, identifier)['confirmation'], 'unconfirmed')
                    self.assertEqual(entity(updated, identifier)['id'], entity(graph, identifier)['id'])
                    self.assertEqual(entity(updated, identifier)['display_id'], entity(graph, identifier)['display_id'])
                self.assertEqual(entity(updated, ids['service'])['quantity'], entity(graph, ids['service'])['quantity'])
                self.assertEqual(entity(updated, ids['other_root']), entity(graph, ids['other_root']))

    def test_copy_gets_new_unreviewed_identity_and_delete_restore_never_revives_review(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                source = entity(graph, ids['service'])
                command = create(graph, 'service', 20, source['barrier_id'], confirmation='confirmed')
                command['entity'].update(fields=deepcopy(source['fields']), quantity=source['quantity'],
                    evidence=deepcopy(source['evidence']), uncertainty=deepcopy(source['uncertainty']),
                    copied_from={'entity_id': source['id'], 'revision': source['revision']})
                copied, _ = apply(graph, command)
                self.assertNotIn('confirmation', entity(copied, uid(20)))
                self.assertEqual(entity(copied, uid(20))['quantity'], source['quantity'])
                self.assertEqual(entity(copied, ids['service']), source)
                deleted, _ = apply(graph, {'op': 'delete', 'entity_id': ids['root'], 'cascade': True})
                subtree = {ids['root'], ids['barrier'], ids['service']}
                for identifier in subtree:
                    self.assertTrue(entity(deleted, identifier)['deleted'])
                    self.assertEqual(entity(deleted, identifier)['confirmation'], 'unconfirmed')
                restored, _ = apply(deleted, {'op': 'restore', 'entity_id': ids['root'], 'mode': 'same_deletion'})
                for identifier in subtree:
                    self.assertFalse(entity(restored, identifier)['deleted'])
                    self.assertEqual(entity(restored, identifier)['confirmation'], 'unconfirmed')
                    self.assertEqual(entity(restored, identifier)['fields'], entity(graph, identifier)['fields'])
                    self.assertEqual(entity(restored, identifier)['uncertainty'], entity(graph, identifier)['uncertainty'])

    def test_preview_binds_confirmation_choice_exact_facts_and_graph_revision(self):
        for version in (2, 3):
            with self.subTest(version=version):
                graph, ids = graph_fixture(version)
                command = {'op': 'update', 'entity_id': ids['root'], 'changes': {'confirmation': 'unconfirmed'}}
                preview = preview_change(graph, command)
                altered = deepcopy(command); altered['changes']['fields'] = {'label': 'Not previewed'}
                with self.assertRaisesRegex(ValidationError, 'fresh preview'):
                    apply_change(graph, altered, expected_revision=graph['revision'], preview_digest=preview['preview_digest'])
                current, _ = apply(graph, {'op': 'update', 'entity_id': ids['other_service'],
                                          'changes': {'quantity': 99}})
                with self.assertRaisesRegex(ValidationError, 'fresh preview'):
                    apply_change(current, command, expected_revision=graph['revision'], preview_digest=preview['preview_digest'])
                self.assertEqual(entity(graph, ids['root'])['confirmation'], 'confirmed')

    def test_operation_batches_are_atomic_and_review_metadata_stays_optional_in_portable_snapshots(self):
        for version, scope, key in ((2, 'defect_reports', 'physical'), (3, 'service_plans', 'service_plans')):
            with self.subTest(scope=scope):
                graph, ids = graph_fixture(version, confirmed=False)
                snapshot = upgrade_snapshot(new_snapshot())
                graph['project_id'] = snapshot['project_id']; snapshot[key] = graph
                original = deepcopy(snapshot)
                review = {'op': 'update', 'entity_id': ids['root'],
                          'changes': {'confirmation': 'confirmed'}}
                result = prepare_changes(snapshot, [review], scope=scope)
                self.assertEqual(result['summary']['authority'], 'none')
                self.assertEqual(result['summary']['state'], 'draft')
                self.assertEqual(entity(result['graph'], ids['root'])['confirmation'], 'confirmed')
                self.assertNotIn('confirmation', entity(result['graph'], ids['service']))
                self.assertEqual(snapshot, original)
                with self.assertRaises(ValidationError):
                    prepare_changes(snapshot, [review, {'op': 'update', 'entity_id': ids['service'],
                        'changes': {'confirmation': True}}], scope=scope)
                self.assertEqual(snapshot, original)
                self.assertEqual(validate_snapshot(original), original)


class PhysicalConfirmationWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.case = workspace_fixtures.TakeoffWorkspaceTests()
        self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.service, self.sid = self.case.service, self.case.sid

    def state(self):
        return self.service.get(self.sid, verify_evidence=False)

    def physical(self, commands, scope):
        before = self.state()
        preview = self.service.preview_physical(self.sid, {
            'expected_revision': before['revision'], 'commands': commands, 'scope': scope})
        request = {'expected_revision': before['revision'], 'request_id': str(uuid4()),
                   'preview_id': preview['preview_id'], 'scope': scope}
        return self.service.apply_physical(self.sid, request), request

    def test_batch_review_audit_idempotent_replay_capture_and_reopen_preserve_both_scopes_and_other_inputs(self):
        for version, scope, key in ((2, 'defect_reports', 'physical'), (3, 'service_plans', 'service_plans')):
            with self.subTest(scope=scope):
                graph = new_graph(self.state()['snapshot']['project_id'], version=version)
                kind = 'defect' if version == 2 else 'barrier'
                target = create(graph, kind, 10 + version)
                self.physical([target], scope)
                before = self.state()['snapshot']; identifier = target['entity']['id']
                result, request = self.physical([{'op': 'update', 'entity_id': identifier,
                                                 'changes': {'confirmation': 'confirmed'}}], scope)
                after = result['snapshot']
                self.assertEqual(entity(after[key], identifier)['confirmation'], 'confirmed')
                self.assertEqual(entity(after[key], identifier)['uncertainty'], entity(before[key], identifier)['uncertainty'])
                for name in ('documents', 'items', 'calibrations', 'transfers', 'render_checks'):
                    self.assertEqual(after[name], before[name])
                other_key = 'service_plans' if key == 'physical' else 'physical'
                self.assertEqual(after.get(other_key), before.get(other_key))
                self.assertNotIn('penetration', result); self.assertNotIn('calculator', result)
                self.assertEqual(self.service.apply_physical(self.sid, request), result)
                event = self.case.documents.get_blob(after['audit_head'])
                self.assertEqual(event['op'], 'apply_physical')
                self.assertEqual(event['affected_ids'][key], [identifier])
                self.assertEqual(event['before'][key], before[key]); self.assertEqual(event['after'][key], after[key])
                self.assertEqual(validate_snapshot(after), after)
                self.assertEqual(self.service.capture(self.sid, after), after)
                reopened = self.service.open(after, source_path='synthetic-reviewed-project.json')
                self.assertEqual(reopened['snapshot'][key], after[key])

    def test_stale_workspace_review_preview_cannot_overwrite_a_newer_fact_edit(self):
        for version, scope, key in ((2, 'defect_reports', 'physical'), (3, 'service_plans', 'service_plans')):
            with self.subTest(scope=scope):
                graph = new_graph(self.state()['snapshot']['project_id'], version=version)
                kind = 'defect' if version == 2 else 'barrier'
                target = create(graph, kind, 20 + version)
                self.physical([target], scope); before = self.state()
                preview = self.service.preview_physical(self.sid, {'expected_revision': before['revision'],
                    'scope': scope, 'commands': [{'op': 'update', 'entity_id': target['entity']['id'],
                                                'changes': {'confirmation': 'confirmed'}}]})
                current, _ = self.physical([{'op': 'update', 'entity_id': target['entity']['id'],
                                            'changes': {'fields': {'label': 'Newer source assertion'}}}], scope)
                with self.assertRaises(ValidationError):
                    self.service.apply_physical(self.sid, {'expected_revision': before['revision'],
                        'request_id': str(uuid4()), 'preview_id': preview['preview_id'], 'scope': scope})
                self.assertEqual(self.state()['snapshot'], current['snapshot'])
                self.assertNotIn('confirmation', entity(current['snapshot'][key], target['entity']['id']))

    def test_undo_review_returns_previous_absence_without_rewriting_legacy_uncertainty(self):
        graph = new_graph(self.state()['snapshot']['project_id'], version=2)
        target = create(graph, 'defect', 50)
        self.physical([target], 'defect_reports'); before = self.state()['snapshot']
        self.physical([{'op': 'update', 'entity_id': target['entity']['id'],
                       'changes': {'confirmation': 'confirmed'}}], 'defect_reports')
        restored = self.service.command(self.sid, {'op': 'undo', 'expected_revision': self.state()['revision'],
                                                  'request_id': str(uuid4())})['snapshot']
        reviewed = entity(restored['physical'], target['entity']['id'])
        self.assertNotIn('confirmation', reviewed)
        self.assertEqual(reviewed['uncertainty'], entity(before['physical'], target['entity']['id'])['uncertainty'])
        self.assertEqual(reviewed['fields'], entity(before['physical'], target['entity']['id'])['fields'])
        self.assertEqual(restored['transfers'], before['transfers'])
        self.assertEqual(validate_snapshot(restored), restored)


class PhysicalConfirmationCommercialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        link_fixtures.TakeoffLibraryLinkTests.setUpClass()

    def setUp(self):
        self.case = link_fixtures.TakeoffLibraryLinkTests()
        self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def test_confirming_physical_review_cannot_confirm_or_populate_draft_schedule_link(self):
        for scope, key in (('defect_reports', 'physical'), ('service_plans', 'service_plans')):
            with self.subTest(scope=scope):
                member = self.case.member(scope)
                identifier, _, _ = self.case.assignment([member], scope=scope)
                schedule = deepcopy(self.case.draft); protected = self.case.calculator_storage()
                prior = deepcopy(self.case.record(identifier))
                response = self.case.physical([{'op': 'update', 'entity_id': member,
                                                'changes': {'confirmation': 'confirmed'}}], scope)
                record = self.case.record(identifier)
                self.assertEqual(entity(response['snapshot'][key], member)['confirmation'], 'confirmed')
                self.assertEqual(response['snapshot'][key]['state'], 'draft')
                self.assertNotEqual(record['state'], 'confirmed')
                self.assertIsNone(record['confirmation']); self.assertIsNone(record['schedule_binding'])
                self.assertEqual(record['members'], prior['members'])
                self.assertEqual(self.case.draft, schedule); self.assertEqual(self.case.calculator_storage(), protected)
                self.assertNotIn('penetration', response); self.case.assert_source_unchanged()

    def test_review_change_cannot_add_update_or_unlink_an_existing_commercial_contribution(self):
        member = self.case.member(); identifier, _, _ = self.case.assignment([member])
        self.case.confirm(identifier, 2.125)
        schedule = deepcopy(self.case.draft); protected = self.case.calculator_storage()
        contribution = deepcopy(self.case.record(identifier)['schedule_binding'])
        commercial_review = deepcopy(self.case.record(identifier)['confirmation'])
        for confirmation in ('confirmed', 'unconfirmed'):
            response = self.case.physical([{'op': 'update', 'entity_id': member,
                                           'changes': {'confirmation': confirmation}}])
            record = self.case.record(identifier)
            self.assertEqual(record['schedule_binding'], contribution)
            self.assertEqual(record['confirmation'], commercial_review)
            self.assertEqual(self.case.draft, schedule); self.assertEqual(self.case.calculator_storage(), protected)
            self.assertNotIn('penetration', response)
        self.case.assert_source_unchanged()


if __name__ == '__main__':
    unittest.main()
