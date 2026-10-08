"""Reviewed physical counts feed schedule contributions without rewriting old projects."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_library_links import assignment_quantity, validate_history
from estimator.penetration_calculator import normalize_draft
from tests import test_takeoff_library_barrier_import as import_fixtures
from tests.test_takeoff_physical_v2 import create
from tests.test_takeoff_service_plans import create as create_plan


class ServiceQuantityLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import_fixtures.LibraryBarrierImportTests.setUpClass()

    def setUp(self):
        self.case = import_fixtures.LibraryBarrierImportTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.links = self.case.fixture
        self.service, self.sid = self.case.service, self.case.sid

    def state(self):
        return self.case.state()

    def imported(self, quantity=3, barrier=None):
        proposed = self.case.proposal(barrier, item_quantity=quantity,
                                      draft_quantity=quantity, draft_location='Explicit fixture location')
        return self.case.apply(proposed)

    def record(self, identifier=None):
        records = self.state()['library_assignments']['records']
        return next(record for record in records if record['id'] == identifier) if identifier else records[-1]

    def associate(self, members, *, scope='defect_reports', mode='repeated_installations',
                  source=None, updates=None):
        library = self.links.library.takeoff_record('pkb-001')
        proposed = {'id': str(uuid4()), 'scope': scope, 'library_id': library['id'],
                    'library_fingerprint': library['metadata_sha256'], 'member_ids': members,
                    'installation': {'id': str(uuid4()), 'mode': mode,
                                     'note': 'Explicit reviewed shared installation' if mode == 'combined_installation' else ''}}
        if source is not None:
            proposed['quantity_source'] = deepcopy(source)
        if updates is not None:
            proposed['service_quantities'] = deepcopy(updates)
        request = {'op': 'draft_library_assignment', 'request_id': str(uuid4()),
                   'expected_revision': self.state()['revision'], 'assignment': proposed}
        return self.service.command(self.sid, request), request

    def services(self, quantities=(3, 4), scope='defect_reports'):
        if scope == 'service_plans':
            barrier = create_plan('barrier', substrate='Concrete', orientation='Vertical')
        else:
            barrier = create('barrier', self.case.defect['entity']['id'], substrate='Concrete', orientation='Vertical')
        commands = [barrier]
        for quantity in quantities:
            command = (create_plan if scope == 'service_plans' else create)(
                'service', barrier['entity']['id'], service_type='Single Cables')
            command['entity']['quantity'] = quantity
            commands.append(command)
        self.links.physical(commands, scope)
        graph = self.state()['service_plans' if scope == 'service_plans' else 'physical']
        selected = [entity for entity in graph['services'] if entity['id'] in {command['entity']['id'] for command in commands[1:]}]
        return next(entity for entity in graph['barriers'] if entity['id'] == barrier['entity']['id']), selected

    def blank(self):
        edit = self.links.library.edit('pkb-001')
        draft = deepcopy(edit['draft']); draft['rows'][0]['inputs']['K'] = 'Blank Seal'
        self.links.library.action('pkb-001', 'save', {'draft': draft, 'revision': edit['revision'],
                                                   'pricing_token': edit['pricing_token']})
        self.case.library = self.links.library.takeoff_record('pkb-001')

    def reject_commit(self, message):
        revision = self.state()['revision']
        validate = self.links.case.documents.validate_audit

        def reject(snapshot, **options):
            if snapshot['revision'] > revision:
                raise ValidationError(message)
            return validate(snapshot, **options)

        return patch.object(self.links.case.documents, 'validate_audit', side_effect=reject)

    def test_selected_item_quantity_is_atomic_physical_count_without_schedule_or_price_change(self):
        before = deepcopy(self.state()); stored = self.links.calculator_storage()
        result, request = self.imported(7); after = result['snapshot']
        service = after['physical']['services'][0]
        self.assertEqual(service['quantity'], 7)
        self.assertNotIn('library_quantity', service)
        record = self.record(); self.assertEqual(record['quantity_source'], {'version': 1, 'kind': 'services'})
        self.assertEqual(assignment_quantity(after, record), 7)
        self.assertEqual(record['draft_quantity'], 7)
        self.assertEqual(record['state'], 'draft'); self.assertIsNone(record['schedule_binding'])
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['barriers'][0]['marker'], before['physical']['defects'][0]['annotation'])
        self.assertEqual(self.links.calculator_storage(), stored)
        self.assertEqual(self.links.draft['rows'], [])
        self.assertEqual(self.service.command(self.sid, request), result)
        self.assertEqual(len(self.state()['physical']['services']), 1)
        self.links.assert_source_unchanged()

    def test_existing_barrier_import_preserves_old_services_and_their_quantities(self):
        barrier, old = self.services((17,))
        # Keep the exact selected library barrier literals to avoid an unrelated mismatch.
        self.links.physical([{'op': 'update', 'entity_id': barrier['id'],
                              'changes': {'fields': self.case.library['import_fields']['barrier']}}])
        barrier = next(entity for entity in self.state()['physical']['barriers'] if entity['id'] == barrier['id'])
        before = deepcopy(self.state())
        after = self.imported(5, barrier)[0]['snapshot']
        self.assertEqual(after['physical']['services'][0], before['physical']['services'][0])
        self.assertEqual(after['physical']['barriers'], before['physical']['barriers'])
        self.assertEqual(after['physical']['services'][-1]['quantity'], 5)
        self.assertEqual(assignment_quantity(after, self.record()), 5)

    def test_invalid_item_quantities_leave_no_partial_import_or_association(self):
        before = deepcopy(self.state())
        for quantity in (None, True, 0, -1, 1.0, 1.5, '2', float('inf'), 10**12 + 1):
            with self.subTest(quantity=quantity), self.assertRaises(ValidationError):
                self.imported(quantity)
            self.assertEqual(self.state(), before)
        with self.reject_commit('Fail atomic receipt'):
            with self.assertRaisesRegex(ValidationError, 'Fail atomic receipt'):
                self.imported(5)
        self.assertEqual(self.state(), before)

    def test_repeated_quantity_counts_only_distinct_explicit_services_in_both_scopes(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                barrier, services = self.services((3, 4, 99), scope)
                selected = [barrier['id'], services[0]['id'], services[1]['id']]
                result, _ = self.associate(selected, scope=scope, source={'version': 1, 'kind': 'services'})
                record = self.record()
                self.assertEqual(assignment_quantity(result['snapshot'], record), 7)
                preview = self.links.preview(record['id'], 7)
                self.assertEqual(preview['derived_quantity'], 7)
                self.links.apply(preview)
                self.assertEqual(self.record()['schedule_binding']['quantity'], 7)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 14)

    def test_combined_members_keep_their_physical_counts_but_contribute_one(self):
        _, services = self.services((3, 4))
        result, _ = self.associate([entity['id'] for entity in services], mode='combined_installation',
                                   source={'version': 1, 'kind': 'services'})
        identifier = self.record()['id']; before = deepcopy(result['snapshot']['physical'])
        self.assertEqual(assignment_quantity(self.state(), self.record()), 1)
        with self.assertRaises(ValidationError):
            self.links.preview(identifier, 7)
        preview = self.links.preview(identifier, 1)
        self.assertEqual(preview['derived_quantity'], 1)
        self.links.apply(preview)
        self.assertEqual(self.state()['physical'], before)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 1)

    def test_parent_only_services_source_is_rejected_without_inferred_descendants(self):
        barrier, _ = self.services()
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'explicit service members'):
            self.associate([barrier['id']], source={'version': 1, 'kind': 'services'})
        self.assertEqual(self.state(), before)

    def test_explicit_selected_service_quantity_edits_and_assignment_commit_together(self):
        barrier, services = self.services((3, 4, 99))
        before = deepcopy(self.state())
        updates = [{'id': services[0]['id'], 'revision': services[0]['revision'], 'quantity': 8},
                   {'id': services[1]['id'], 'revision': services[1]['revision'], 'quantity': 4}]
        result, request = self.associate([entity['id'] for entity in services[:2]],
                                        source={'version': 1, 'kind': 'services'}, updates=updates)
        after = result['snapshot']; record = self.record()
        self.assertEqual(assignment_quantity(after, record), 12)
        current = {entity['id']: entity for entity in after['physical']['services']}
        self.assertEqual(current[services[1]['id']], services[1])  # A reviewed no-op retains its exact revision.
        self.assertEqual(current[services[2]['id']], services[2])
        self.assertEqual(after['physical']['barriers'], before['physical']['barriers'])
        self.assertGreater(current[services[0]['id']]['revision'], services[0]['revision'])
        self.assertEqual(self.links.draft['rows'], [])
        self.assertEqual(self.service.command(self.sid, request), result)

    def test_invalid_or_stale_member_edit_rejects_entire_atomic_assignment(self):
        _, services = self.services((3, 4, 99))
        before = deepcopy(self.state())
        valid = {'id': services[0]['id'], 'revision': services[0]['revision'], 'quantity': 8}
        for invalid in ({'id': services[1]['id'], 'revision': services[1]['revision'] + 1, 'quantity': 9},
                        {'id': services[2]['id'], 'revision': services[2]['revision'], 'quantity': 9},
                        {**valid, 'quantity': 1.5}, valid):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                self.associate([entity['id'] for entity in services[:2]],
                               source={'version': 1, 'kind': 'services'}, updates=[valid, invalid])
            self.assertEqual(self.state(), before)
        with self.reject_commit('Fail atomic assignment'):
            with self.assertRaisesRegex(ValidationError, 'Fail atomic assignment'):
                self.associate([entity['id'] for entity in services[:2]],
                               source={'version': 1, 'kind': 'services'}, updates=[valid])
        self.assertEqual(self.state(), before)

    def test_unknown_service_requires_action_instead_of_transfer_default_one(self):
        commands, identifier, _ = self.links.unknown_import()
        self.links.physical(commands)
        self.associate([identifier], source={'version': 1, 'kind': 'services'})
        record = self.record(); before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'quantity is unknown.*View/Edit'):
            self.links.preview(record['id'], 1)
        self.assertEqual(self.state(), before)
        self.links.physical([{'op': 'update', 'entity_id': identifier, 'changes': {'quantity': 6}}])
        self.links.confirm(record['id'], 6)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 6)

    def test_update_uses_current_quantity_preserves_manual_prices_and_other_contributions(self):
        self.imported(3); first = self.record(); service = self.state()['physical']['services'][0]
        _, services = self.services((4,))
        self.associate([services[0]['id']], source={'version': 1, 'kind': 'services'})
        second = self.record()
        self.links.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual-row', 'library_item_id': 'pkb-001',
            'inputs': {'O': 10.125, 'AI': 50.123456789012, 'AJ': 100.987654321098, 'T': 'Retain exact manual text'}}]}
        original = deepcopy(self.links.draft)
        self.links.confirm(first['id'], 3); self.links.confirm(second['id'], 4)
        self.links.physical([{'op': 'update', 'entity_id': service['id'], 'changes': {'quantity': 5}}])
        self.assertEqual(self.record(first['id'])['state'], 'needs_recheck')
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 17.125)
        with self.assertRaisesRegex(ValidationError, 'current explicit physical quantity'):
            self.links.preview(first['id'], 3)
        preview = self.links.preview(first['id'], 5)
        result, request = self.links.apply(preview)
        self.assertEqual(self.service.apply_library_link(self.sid, request), result)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 19.125)
        for key in ('AI', 'AJ', 'T'):
            self.assertEqual(self.links.draft['rows'][0]['inputs'][key], original['rows'][0]['inputs'][key])
        self.assertEqual(self.links.draft['globals'], original['globals'])
        self.assertEqual(self.record(second['id'])['schedule_binding']['quantity'], 4)
        self.assertEqual(self.record(first['id'])['draft_quantity'], 3)
        self.assertEqual(self.links.preview(first['id'], 5)['change']['action'], 'unchanged')

    def test_stale_physical_schedule_or_price_capture_never_applies_derived_contribution(self):
        self.imported(3); identifier = self.record()['id']; service = self.state()['physical']['services'][0]
        preview = self.links.preview(identifier, 3)
        self.links.physical([{'op': 'update', 'entity_id': service['id'], 'changes': {'quantity': 5}}])
        with self.assertRaises(ValidationError):
            self.links.apply(preview)
        preview = self.links.preview(identifier, 5); before = deepcopy(self.state())
        for override in ({'configuration': {'labour_hourly_rate': 123.45}},
                         {'draft': {'globals': {'J': 'No'}, 'rows': [{'id': 'new-manual', 'inputs': {'O': 1}}]}}):
            with self.subTest(override=override), self.assertRaisesRegex(ValidationError, 'prices changed'):
                self.links.apply(preview, **override)
            self.assertEqual(self.state(), before)

    def test_unlink_subtracts_retained_old_contribution_not_changed_physical_quantity(self):
        self.imported(3); identifier = self.record()['id']; service = self.state()['physical']['services'][0]
        self.links.confirm(identifier, 3)
        self.links.draft['rows'][0]['inputs']['O'] = 4.125
        self.links.physical([{'op': 'update', 'entity_id': service['id'], 'changes': {'quantity': 9}}])
        preview = self.links.preview(identifier, 0, operation='unlink')
        self.assertEqual(preview['change']['prior_contribution'], 3)
        self.links.apply(preview)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 1.125)
        self.assertEqual(self.state()['physical']['services'][0]['quantity'], 9)
        self.assertEqual(self.record()['quantity_source'], {'version': 1, 'kind': 'services'})
        self.assertIsNone(self.record()['schedule_binding'])

    def test_blank_seal_count_creates_no_service_and_explicit_review_can_update_it(self):
        self.blank(); self.imported(6); identifier = self.record()['id']
        self.assertEqual(self.state()['physical']['services'], [])
        self.assertEqual(self.record()['quantity_source'], {'version': 1, 'kind': 'blank_seals', 'quantity': 6})
        self.links.confirm(identifier, 6)
        self.links.confirm(identifier, 8)
        self.assertEqual(self.record()['quantity_source']['quantity'], 8)
        self.assertEqual(self.record()['draft_quantity'], 6)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 8)
        self.assertEqual(self.state()['physical']['services'], [])
        with self.assertRaises(ValidationError):
            self.links.preview(identifier, 8.5)
        self.links.apply(self.links.preview(identifier, 0, operation='unlink'))
        self.assertEqual(self.record()['quantity_source']['quantity'], 8)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 0)

    def test_legacy_source_absence_retains_decimal_protocol_until_explicit_adoption(self):
        imported = self.case.apply(self.case.proposal(draft_quantity=2.75))[0]['snapshot']
        record = self.record(); service = imported['physical']['services'][0]
        self.assertNotIn('quantity_source', record)
        self.links.confirm(record['id'], 2.75)
        self.assertNotIn('quantity_source', self.record())
        with self.assertRaisesRegex(ValidationError, 'quantity is unknown'):
            self.links.preview(record['id'], 1, quantity_source={'version': 1, 'kind': 'services'})
        self.links.physical([{'op': 'update', 'entity_id': service['id'], 'changes': {'quantity': 7}}])
        preview = self.links.preview(record['id'], 7, quantity_source={'version': 1, 'kind': 'services'})
        self.assertNotIn('quantity_source', self.record())  # Preview is read-only.
        self.links.apply(preview)
        self.assertEqual(self.record()['quantity_source'], {'version': 1, 'kind': 'services'})
        self.assertEqual(self.record()['draft_quantity'], 2.75)
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 7)

    def test_legacy_blank_adoption_is_explicit_integer_and_kind_cannot_be_forged(self):
        self.blank(); self.case.apply(self.case.proposal(draft_quantity=.375))
        identifier = self.record()['id']; before = deepcopy(self.state())
        with self.assertRaises(ValidationError):
            self.links.preview(identifier, 2, quantity_source={'version': 1, 'kind': 'blank_seals', 'quantity': 3})
        with self.assertRaises(ValidationError):
            self.links.preview(identifier, 2, quantity_source={'version': 1, 'kind': 'services'})
        self.assertEqual(self.state(), before)
        self.links.apply(self.links.preview(identifier, 4, quantity_source={'version': 1, 'kind': 'blank_seals', 'quantity': 4}))
        self.assertEqual(self.record()['draft_quantity'], .375)
        self.assertEqual(self.record()['quantity_source']['quantity'], 4)
        self.assertEqual(self.state()['physical']['services'], [])

    def test_malformed_source_and_edits_cannot_gain_authority_or_partially_change_counts(self):
        _, services = self.services((3, 4))
        members = [entity['id'] for entity in services]
        before = deepcopy(self.state())
        for source in (None, True, [], {}, {'version': True, 'kind': 'services'},
                       {'version': 2, 'kind': 'services'}, {'version': 1, 'kind': 'other'},
                       {'version': 1, 'kind': 'services', 'quantity': 9},
                       {'version': 1, 'kind': 'blank_seals', 'quantity': True},
                       {'version': 1, 'kind': 'blank_seals', 'quantity': 2},
                       {'version': 1, 'kind': 'blank_seals', 'quantity': 1.5}):
            with self.subTest(source=source), self.assertRaises(ValidationError):
                self.associate(members, source=source,
                               updates=[{'id': services[0]['id'], 'revision': services[0]['revision'], 'quantity': 9}])
            self.assertEqual(self.state(), before)

    def test_unlink_and_deleted_member_keep_retained_counts_and_do_not_adopt_new_source(self):
        self.imported(3); identifier = self.record()['id']; service = self.state()['physical']['services'][0]
        self.links.confirm(identifier, 3)
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'Unlink preserves'):
            self.links.preview(identifier, 0, operation='unlink', quantity_source={'version': 1, 'kind': 'services'})
        self.assertEqual(self.state(), before)
        self.links.physical([{'op': 'delete', 'entity_id': service['id'], 'cascade': False}])
        with self.assertRaises(ValidationError):
            self.links.preview(identifier, 3)
        self.links.apply(self.links.preview(identifier, 0, operation='unlink'))
        self.assertEqual(self.record()['quantity_source'], {'version': 1, 'kind': 'services'})
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 0)
        self.assertEqual(self.state()['physical']['services'][0]['quantity'], 3)

    def test_combined_blank_seal_has_one_contribution_without_replacing_explicit_count(self):
        self.blank()
        self.associate([self.case.defect['entity']['id']], mode='combined_installation',
                       source={'version': 1, 'kind': 'blank_seals', 'quantity': 8})
        identifier = self.record()['id']
        self.links.confirm(identifier, 1)
        self.assertEqual(self.record()['quantity_source']['quantity'], 8)
        self.assertEqual(self.record()['schedule_binding']['quantity'], 1)
        self.assertEqual(self.state()['physical']['services'], [])

    def test_portable_save_reopen_and_history_retain_source_and_physical_count(self):
        self.imported(7); identifier = self.record()['id']; self.links.confirm(identifier, 7)
        before = deepcopy(self.state())
        self.links.case.library.save_as({**deepcopy(self.links.case.base), 'takeoffs': before,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.links.draft)}})
        payload = self.links.case.target.read_bytes()
        self.service.close(self.sid)
        self.links.case.dialogs.opened = str(self.links.case.target)
        reopened = self.links.case.library.open_file()
        restored = reopened['takeoffs']
        self.assertEqual(restored['library_assignments'], before['library_assignments'])
        self.assertEqual(restored['physical'], before['physical'])
        self.assertEqual(assignment_quantity(restored, restored['library_assignments']['records'][0]), 7)
        self.assertEqual(reopened['penetration']['draft'], normalize_draft(self.links.draft))
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.links.case.documents.validate_audit(restored, owner=reopened['takeoffs_session_id'])
        self.assertEqual(self.links.case.target.read_bytes(), payload)

    def test_audit_rejects_unreviewed_source_adoption_kind_switch_and_wrong_contribution(self):
        self.imported(3); identifier = self.record()['id']; self.links.confirm(identifier, 3)
        event = self.links.case.documents.get_blob(self.state()['audit_head'])
        validate_history(event)
        forged = deepcopy(event)
        forged['after']['library_assignments']['records'][0]['quantity_source'] = {'version': 1, 'kind': 'blank_seals', 'quantity': 3}
        with self.assertRaises(ValidationError):
            validate_history(forged)
        forged = deepcopy(event)
        forged['after']['library_assignments']['records'][0]['quantity_source'] = {'version': 1, 'kind': 'services'}
        forged['before']['library_assignments']['records'][0].pop('quantity_source')
        forged['op'] = 'apply_physical'
        with self.assertRaisesRegex(ValidationError, 'quantity source'):
            validate_history(forged)
        forged['op'] = 'apply_library_link'
        forged['after']['physical']['services'][0]['quantity'] = 8
        with self.assertRaisesRegex(ValidationError, 'exact current physical contribution'):
            validate_history(forged)


if __name__ == '__main__':
    unittest.main()
