"""Reviewed commercial links preserve physical drafts and exact schedule inputs.

All storage, PDFs, library edits, projects and HTTP listeners are disposable.
These tests exercise the retained transaction protocol, not inferred matching.
"""

from copy import deepcopy
import csv
import http.client
from io import BytesIO, StringIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary
from estimator.penetration_calculator import normalize_draft
from estimator.server import create_server
from estimator.takeoff_library_links import status, validate_assignments
from estimator.takeoff_model import validate_snapshot
from estimator.takeoff_physical import confirmation_owner, graph_collections, graph_parents, validate_graph
from estimator.takeoff_physical_markers import service_summary
from tests.test_firestopping_library import editable_library
from tests.test_takeoff_physical_v2 import create
from tests.test_takeoff_service_plans import create as create_plan
from tests import test_takeoff_project as project_fixtures


class TakeoffLibraryLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = project_fixtures.TakeoffProjectTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.service, self.sid = self.case.service, self.case.session['session_id']
        editable_library(self.case.root / 'library', complete_entries=True)
        self.library = FirestoppingLibrary(self.case.root / 'library', self.case.store)
        self.service.libraries = self.library
        self.source_bytes = (self.case.root / 'library/library.json').read_bytes()
        self.draft = {'globals': {'J': 'No'}, 'rows': []}
        self.configuration = {}

    def state(self):
        return self.service.get(self.sid)

    def physical(self, commands, scope='defect_reports'):
        revision = self.state()['revision']
        preview = self.service.preview_physical(self.sid, {
            'expected_revision': revision, 'commands': commands, 'scope': scope})
        return self.service.apply_physical(self.sid, {
            'expected_revision': revision, 'request_id': str(uuid4()),
            'preview_id': preview['preview_id'], 'scope': scope})

    def member(self, scope='defect_reports'):
        command = (create_plan('barrier', substrate='Explicit retained substrate') if scope == 'service_plans'
                   else create('defect', label='Explicit retained member'))
        self.physical([command], scope)
        return command['entity']['id']

    def review_physical(self, member_ids, scope='defect_reports'):
        """Explicit fixture review, separate from the read-only link preview."""
        graph = self.state()['snapshot']['physical' if scope == 'defect_reports' else 'service_plans']
        index = {entity['id']: (kind, entity) for kind, collection in graph_collections(graph).items()
                 for entity in graph[collection]}
        reviewed, commands = set(), []
        for identifier in member_ids:
            _, owner = confirmation_owner(graph, identifier, _index=index)
            if owner['id'] not in reviewed and owner.get('confirmation') != 'confirmed':
                commands.append({'op': 'update', 'entity_id': owner['id'],
                                 'changes': {'confirmation': 'confirmed'}})
            reviewed.add(owner['id'])
        if commands:
            self.physical(commands, scope)

    def review_members(self, identifier):
        record = self.record(identifier)
        self.review_physical([member['id'] for member in record['members']], record['scope'])

    def assignment(self, members, mode='repeated_installations', note='', scope='defect_reports', library_id='pkb-001'):
        selected = self.library.takeoff_record(library_id)
        proposal = {'id': str(uuid4()), 'scope': scope, 'library_id': library_id,
            'library_fingerprint': selected['metadata_sha256'], 'member_ids': members,
            'installation': {'id': str(uuid4()), 'mode': mode, 'note': note}}
        request = {'op': 'draft_library_assignment', 'request_id': str(uuid4()),
            'expected_revision': self.state()['revision'], 'assignment': proposal}
        result = self.service.command(self.sid, request)
        return proposal['id'], result, request

    def preview(self, identifier, quantity, **overrides):
        request = {'expected_revision': self.state()['revision'], 'assignment_id': identifier,
            'quantity': quantity, 'draft': deepcopy(self.draft), 'configuration': deepcopy(self.configuration), **overrides}
        return self.service.preview_library_link(self.sid, request)

    def apply(self, preview, **overrides):
        request = {'expected_revision': preview['revision'], 'request_id': str(uuid4()),
            'preview_id': preview['preview_id'], 'draft': deepcopy(self.draft),
            'configuration': deepcopy(self.configuration), **overrides}
        result = self.service.apply_library_link(self.sid, request)
        self.draft = deepcopy(result['penetration']['draft'])
        return result, request

    def confirm(self, identifier, quantity):
        return self.apply(self.preview(identifier, quantity))[0]

    def record(self, identifier):
        return next(r for r in self.state()['snapshot']['library_assignments']['records'] if r['id'] == identifier)

    def change_library_description(self):
        edit = self.library.edit('pkb-001')
        draft = deepcopy(edit['draft'])
        draft['rows'][0]['inputs']['T'] = 'Explicitly saved new library description'
        self.library.action('pkb-001', 'save', {
            'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})

    def assert_source_unchanged(self):
        self.assertEqual((self.case.root / 'library/library.json').read_bytes(), self.source_bytes)

    def calculator_storage(self):
        with self.case.store.connect() as database:
            return {name: [tuple(row) for row in database.execute(f'SELECT * FROM {name} ORDER BY 1')]
                    for name in ('settings', 'quotes', 'calculator_states', 'app_preferences')}

    def unknown_import(self, scope='defect_reports'):
        selected = self.library.takeoff_record('pkb-001')
        imported = selected['import_fields']
        if scope == 'service_plans':
            barrier = create_plan('barrier', **imported['barrier'])
            commands = [barrier]
        else:
            defect = create('defect', **imported['defect'])
            barrier = create('barrier', defect['entity']['id'], **imported['barrier'])
            commands = [defect, barrier]
        service = create('service', barrier['entity']['id'], **imported['service'])
        service['entity'].update(quantity=None, library_quantity={
            'version': 1, 'state': 'unknown', 'library_id': selected['id'],
            'metadata_sha256': selected['metadata_sha256']})
        commands.append(service)
        return commands, service['entity']['id'], selected

    def test_selection_is_a_draft_without_schedule_quantity_or_physical_approval(self):
        member = self.member()
        before, schedule = self.state()['snapshot'], deepcopy(self.draft)
        identifier, result, request = self.assignment([member])
        record = self.record(identifier)
        self.assertEqual(record['state'], 'draft')
        self.assertIsNone(record['confirmation'])
        self.assertIsNone(record['schedule_binding'])
        self.assertEqual(record['members'], [{'id': member, 'kind': 'defect', 'revision': 1}])
        for key in ('physical', 'documents', 'items', 'calibrations', 'transfers', 'render_checks'):
            self.assertEqual(result['snapshot'][key], before[key])
        self.assertEqual(self.draft, schedule)
        self.assertNotIn('penetration', result)
        self.assertEqual(self.service.command(self.sid, request), result)
        self.assertEqual(len(result['snapshot']['library_assignments']['records']), 1)
        audit = self.case.documents.get_blob(result['snapshot']['audit_head'])
        self.assertEqual(audit['op'], 'draft_library_assignment')
        self.assertEqual(audit['affected_ids']['library_assignments'], [identifier])
        self.assert_source_unchanged()

    def test_new_transfer_requires_metadata_but_existing_incomplete_rows_can_be_updated(self):
        edit = self.library.edit('pkb-001')
        edit['draft']['rows'][0]['inputs']['J'] = None
        saved = self.library.action('pkb-001', 'save', {
            name: edit[name] for name in ('draft', 'revision', 'pricing_token')})
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        before, draft = self.state(), deepcopy(self.draft)
        with self.assertRaisesRegex(ValidationError, 'Complete Category before adding'):
            self.preview(identifier, 2)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft, draft)
        self.draft['rows'] = [{'id': 'retained-row', 'library_item_id': 'pkb-001',
                              'inputs': {**saved['draft']['rows'][0]['inputs'], 'O': 3.1234567890123}}]
        original = deepcopy(self.draft['rows'][0]['inputs'])
        result = self.confirm(identifier, 2)
        row = result['penetration']['draft']['rows'][0]
        self.assertEqual(row['id'], 'retained-row')
        self.assertEqual(row['inputs'], {**original, 'O': 5.1234567890123})
        self.assertIsNone(row['inputs']['J'])

    def test_preview_is_read_only_and_requires_reviewed_finite_positive_quantity(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        before, schedule = self.state(), deepcopy(self.draft)
        preview = self.preview(identifier, 1.234567890123)
        self.assertEqual(preview['change']['next_quantity'], 1.234567890123)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft, schedule)
        for quantity in (0, -1, True, float('inf'), float('nan'), 10**12 + 1, 10**400):
            with self.subTest(quantity=quantity), self.assertRaises(ValidationError):
                self.preview(identifier, quantity)
        self.assertEqual(self.state(), before)

    def test_confirmation_replay_and_reconfirmation_do_not_duplicate_contribution(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        before = self.state()['snapshot']
        protected = self.calculator_storage()
        result, request = self.apply(self.preview(identifier, 3.123456789012))
        self.assertEqual(self.service.apply_library_link(self.sid, request), result)
        self.assertEqual(len(self.draft['rows']), 1)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 3.123456789012)
        self.assertEqual(self.record(identifier)['schedule_binding']['quantity'], 3.123456789012)
        preview = self.preview(identifier, 3.123456789012)
        self.assertEqual(preview['change']['action'], 'unchanged')
        self.assertEqual(preview['draft'], self.draft)
        again = self.apply(preview)[0]
        self.assertEqual(again['penetration']['draft'], result['penetration']['draft'])
        self.assertEqual(len(again['snapshot']['library_assignments']['records']), 1)
        for key in ('physical', 'documents', 'items', 'calibrations', 'transfers'):
            self.assertEqual(again['snapshot'][key], before[key])
        audit = self.case.documents.get_blob(again['snapshot']['audit_head'])
        self.assertEqual(audit['op'], 'apply_library_link')
        self.assertEqual(audit['affected_ids']['library_assignments'], [identifier])
        self.assertEqual(self.calculator_storage(), protected)
        self.assert_source_unchanged()

    def test_existing_manual_quantity_globals_prices_and_other_rows_are_retained(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        self.draft = {'globals': {'J': 'No'}, 'rows': [
            {'id': 'manual-row', 'library_item_id': 'pkb-001', 'inputs': {
                'O': 10.125, 'AI': 123.123456789012, 'AJ': 45.987654321098,
                'T': 'Human wording <literal>', 'U': 'Frozen manual specification'}},
            {'id': 'unrelated-row', 'inputs': {'O': 2.75, 'AI': 19.012345678901, 'T': 'Other line'}}]}
        before = deepcopy(self.draft)
        self.confirm(identifier, 3.5)
        expected = deepcopy(before); expected['rows'][0]['inputs']['O'] = 13.625
        self.assertEqual(self.draft, expected)
        self.confirm(identifier, 1.125)
        expected['rows'][0]['inputs']['O'] = 11.25
        self.assertEqual(self.draft, expected)
        self.assertEqual(self.record(identifier)['schedule_binding'], {'row_id': 'manual-row', 'quantity': 1.125})

    def test_aggregate_contributions_preserve_manual_baseline_and_reject_negative_remainder(self):
        first_member, second_member = self.member(), self.member()
        first, _, _ = self.assignment([first_member]); self.review_members(first); second, _, _ = self.assignment([second_member])
        self.review_members(second)
        self.confirm(first, 3); self.confirm(second, 4)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 7)
        self.draft['rows'][0]['inputs']['O'] = 9.125
        self.confirm(first, 5)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 11.125)
        self.assertEqual(sum(r['schedule_binding']['quantity'] for r in self.state()['snapshot']['library_assignments']['records']), 9)
        self.physical([{'op': 'update', 'entity_id': second_member, 'changes': {'fields': {'label': 'Needs context review'}}}])
        self.assertEqual(self.record(second)['state'], 'needs_recheck')
        self.draft['rows'][0]['inputs']['O'] = 6
        before = self.state()
        with self.assertRaisesRegex(ValidationError, 'retained contribution'):
            self.preview(first, 5)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 6)

    def test_unchanged_decimal_contribution_preserves_exact_manual_quantity(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        self.confirm(identifier, .1)
        self.draft['rows'][0]['inputs']['O'] = .3
        before = deepcopy(self.draft)
        result = self.confirm(identifier, .1)
        self.assertEqual(result['penetration']['draft'], before)
        self.assertEqual(result['penetration']['draft']['rows'][0]['inputs']['O'].hex(), (.3).hex())

    def test_decimal_aggregate_accepts_literal_point_three_and_rejects_true_deficit(self):
        first, _, _ = self.assignment([self.member()]); self.review_members(first); second, _, _ = self.assignment([self.member()])
        self.review_members(second)
        self.confirm(first, .1); self.confirm(second, .2)
        self.draft['rows'][0]['inputs']['O'] = .3
        self.draft['rows'][0]['inputs']['AI'] = 51.123456789012
        before = deepcopy(self.draft)
        result = self.confirm(first, .1)
        self.assertEqual(result['library_link']['action'], 'unchanged')
        self.assertEqual(result['penetration']['draft'], before)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'].hex(), (.3).hex())
        self.draft['rows'][0]['inputs']['O'] = .299999999999
        before_state = self.state()
        with self.assertRaisesRegex(ValidationError, 'retained contribution'):
            self.preview(first, .1)
        self.assertEqual(self.state(), before_state)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], .299999999999)
        self.assertEqual(self.draft['rows'][0]['inputs']['AI'], 51.123456789012)

    def test_decimal_repeated_replacement_keeps_aggregate_reconfirmable_and_manual_prices(self):
        first, _, _ = self.assignment([self.member()]); self.review_members(first); second, _, _ = self.assignment([self.member()])
        self.review_members(second)
        self.confirm(first, .1); self.confirm(second, .1)
        self.draft['rows'][0]['inputs'].update(AI=123.123456789012, AJ=234.987654321098,
            T='Literal manual value stays exact')
        before = deepcopy(self.draft)
        self.confirm(second, 1.123456789)
        expected = deepcopy(before); expected['rows'][0]['inputs']['O'] = 1.223456789
        self.assertEqual(self.draft, expected)
        preview = self.preview(second, 1.123456789)
        self.assertEqual(preview['change']['action'], 'unchanged')
        self.assertEqual(preview['draft'], expected)
        self.apply(preview)
        self.assertEqual(self.draft, expected)
        self.confirm(second, .1)
        expected['rows'][0]['inputs']['O'] = .2
        self.assertEqual(self.draft, expected)
        self.confirm(second, 1.123456789)
        expected['rows'][0]['inputs']['O'] = 1.223456789
        self.assertEqual(self.draft, expected)

    def test_exact_member_set_duplicate_is_rejected_even_with_fresh_installation_and_mode(self):
        members = [self.member(), self.member()]
        identifier, _, _ = self.assignment(members)
        before = self.state()
        for mode, note in (('repeated_installations', ''), ('combined_installation', 'Reviewed group')):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValidationError, 'exact physical members'):
                self.assignment(list(reversed(members)), mode, note)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.record(identifier)['state'], 'draft')

    def test_explicit_distinct_overlapping_groups_are_disclosed_without_inferred_opening(self):
        defect = create('defect', label='D1')
        barrier = create('barrier', defect['entity']['id'], substrate='Concrete')
        service = create('service', barrier['entity']['id'], service='Copper')
        self.physical([defect, barrier, service])
        first, _, _ = self.assignment([barrier['entity']['id']])
        self.review_members(first)
        second, _, _ = self.assignment([barrier['entity']['id'], service['entity']['id']],
            'combined_installation', 'Explicitly reviewed one system around this service')
        self.review_members(second)
        preview = self.preview(second, 1)
        self.assertEqual(preview['overlapping_assignment_ids'], [first])
        self.assertEqual(preview['assignment']['installation']['mode'], 'combined_installation')
        self.assertEqual({m['id'] for m in preview['assignment']['members']},
            {barrier['entity']['id'], service['entity']['id']})
        self.assertEqual(len(self.state()['snapshot']['physical']['barriers']), 1)

    def test_combined_group_requires_explicit_note_and_exactly_one_quantity(self):
        members = [self.member(), self.member()]
        before = self.state()
        with self.assertRaisesRegex(ValidationError, 'Describe the explicit'):
            self.assignment(members, 'combined_installation')
        self.assertEqual(self.state(), before)
        identifier, _, _ = self.assignment(members, 'combined_installation', 'One explicitly reviewed combined installation')
        self.review_members(identifier)
        for quantity in (.5, 2):
            with self.subTest(quantity=quantity), self.assertRaisesRegex(ValidationError, 'one quantity'):
                self.preview(identifier, quantity)
        self.confirm(identifier, 1)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 1)
        self.assertEqual(len(self.record(identifier)['members']), 2)

    def test_stale_schedule_and_frozen_configuration_reject_atomically(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        self.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual', 'library_item_id': 'pkb-001',
            'inputs': {'O': 10, 'AI': 50.123456789, 'AJ': 100.987654321}}]}
        preview, before = self.preview(identifier, 1), self.state()
        changed = deepcopy(self.draft); changed['rows'][0]['inputs']['AI'] = 65.123456789
        for overrides in ({'draft': changed}, {'configuration': {'labour_hourly_rate': 123.45}}):
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValidationError, 'prices changed'):
                self.apply(preview, **overrides)
            self.assertEqual(self.state(), before)

    def test_saved_library_change_after_preview_rejects_and_repreview_captures_new_metadata(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        preview, before = self.preview(identifier, 1), self.state()
        old = self.library.takeoff_record('pkb-001')
        self.change_library_description()
        current = self.library.takeoff_record('pkb-001')
        self.assertNotEqual(current['metadata_sha256'], old['metadata_sha256'])
        self.assertEqual(status(before['snapshot'], self.record(identifier), current), 'needs_recheck')
        with self.assertRaisesRegex(ValidationError, 'metadata or physical context changed'):
            self.apply(preview)
        self.assertEqual(self.state(), before)
        result = self.confirm(identifier, 1)
        self.assertEqual(result['snapshot']['library_assignments']['records'][0]['library']['metadata_sha256'], current['metadata_sha256'])
        self.assertEqual(self.draft['rows'][0]['inputs']['T'], current['inputs']['T'])
        self.assert_source_unchanged()

    def test_parent_edit_invalidates_context_retains_contribution_and_expires_preview(self):
        defect = create('defect', label='D1')
        barrier = create('barrier', defect['entity']['id'], substrate='Concrete')
        self.physical([defect, barrier])
        identifier, _, _ = self.assignment([barrier['entity']['id']])
        self.review_members(identifier)
        self.confirm(identifier, 2.125)
        captured = deepcopy(self.record(identifier)); preview = self.preview(identifier, 2.125)
        self.physical([{'op': 'update', 'entity_id': defect['entity']['id'], 'changes': {'fields': {'label': 'Explicit changed parent'}}}])
        changed = self.record(identifier)
        self.assertEqual(changed['state'], 'needs_recheck')
        self.assertEqual(changed['schedule_binding'], captured['schedule_binding'])
        self.assertEqual(changed['confirmation'], captured['confirmation'])
        before, schedule = self.state(), deepcopy(self.draft)
        with self.assertRaises(ValidationError):
            self.apply(preview)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft, schedule)
        self.review_members(identifier)
        self.confirm(identifier, 2.125)
        self.assertEqual(self.draft, schedule)
        self.assertEqual(self.record(identifier)['state'], 'confirmed')
        self.assertNotEqual(self.record(identifier)['context_sha256'], captured['context_sha256'])

    def test_deleted_member_and_missing_or_replaced_schedule_row_cannot_be_confirmed(self):
        member = self.member(); identifier, _, _ = self.assignment([member])
        self.review_members(identifier)
        self.confirm(identifier, 2)
        retained = deepcopy(self.draft)
        for replacement in ([], [{**deepcopy(retained['rows'][0]), 'id': 'replacement'}]):
            with self.subTest(replacement=replacement), self.assertRaisesRegex(ValidationError, 'removed or replaced'):
                self.preview(identifier, 2, draft={'globals': retained['globals'], 'rows': replacement})
        self.physical([{'op': 'delete', 'entity_id': member, 'cascade': True}])
        self.assertEqual(self.record(identifier)['state'], 'needs_recheck')
        with self.assertRaisesRegex(ValidationError, 'removed or is unavailable'):
            self.preview(identifier, 2)
        self.assertEqual(self.draft, retained)

    def test_other_session_and_expired_replay_never_apply_cached_schedule_twice(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        preview = self.preview(identifier, 3)
        other = self.service.open()
        self.addCleanup(self.service.close, other['session_id'])
        with self.assertRaisesRegex(ValidationError, 'preview expired'):
            self.service.apply_library_link(other['session_id'], {'expected_revision': 0,
                'request_id': str(uuid4()), 'preview_id': preview['preview_id'],
                'draft': deepcopy(self.draft), 'configuration': {}})
        result, request = self.apply(preview)
        self.member()
        before = self.state()
        with self.assertRaisesRegex(ValidationError, 'already applied'):
            self.service.apply_library_link(self.sid, request)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft, result['penetration']['draft'])

    def test_ordinary_undo_cannot_discard_draft_or_confirmed_commercial_receipts(self):
        member = self.member()
        self.review_physical([member])
        identifier, _, _ = self.assignment([member])
        for confirmed in (False, True):
            if confirmed:
                self.confirm(identifier, 1)
            before = self.state()
            with self.subTest(confirmed=confirmed), self.assertRaisesRegex(ValidationError, 'Undo|undo'):
                self.service.command(self.sid, {'op': 'undo', 'request_id': str(uuid4()),
                    'expected_revision': before['revision']})
            self.assertEqual(self.state(), before)

    def test_physical_edit_undo_retains_new_commercial_provenance_and_marks_recheck(self):
        member = self.member(); identifier, _, _ = self.assignment([member])
        self.review_members(identifier)
        self.confirm(identifier, 1.25)
        retained = deepcopy(self.record(identifier)); schedule = deepcopy(self.draft)
        edited = self.physical([{'op': 'update', 'entity_id': member, 'changes': {'fields': {'label': 'Changed'}}}])
        undone = self.service.command(self.sid, {'op': 'undo', 'request_id': str(uuid4()),
            'expected_revision': edited['revision']})
        record = self.record(identifier)
        self.assertEqual(record['state'], 'needs_recheck')
        self.assertEqual(record['schedule_binding'], retained['schedule_binding'])
        self.assertEqual(record['confirmation'], retained['confirmation'])
        self.assertEqual(record['installation'], retained['installation'])
        self.assertEqual(self.draft, schedule)
        self.assertEqual(undone['snapshot']['physical']['defects'][0]['fields']['label'], 'Explicit retained member')
        self.case.documents.validate_audit(undone['snapshot'], owner=self.sid)

    def test_explicit_unlink_subtracts_only_retained_contribution_and_preserves_manual_row(self):
        first, _, _ = self.assignment([self.member()]); self.review_members(first); second, _, _ = self.assignment([self.member()])
        self.review_members(second)
        self.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual', 'library_item_id': 'pkb-001',
            'inputs': {'O': 10.125, 'AI': 100.123456789012, 'AJ': 200.987654321098,
                'T': 'Retain all manual words', 'U': 'Retain system text'}}]}
        original = deepcopy(self.draft)
        self.confirm(first, 3); self.confirm(second, 4)
        retained = deepcopy(self.record(first))
        preview = self.preview(first, 0, operation='unlink')
        self.assertEqual(preview['change']['operation'], 'unlink')
        self.assertEqual(preview['change']['prior_contribution'], 3)
        self.assertEqual(preview['change']['next_quantity'], 14.125)
        result, request = self.apply(preview)
        expected = deepcopy(original); expected['rows'][0]['inputs']['O'] = 14.125
        self.assertEqual(self.draft, expected)
        self.assertEqual(self.service.apply_library_link(self.sid, request), result)
        unlinked = self.record(first)
        self.assertEqual(unlinked['id'], retained['id'])
        self.assertEqual(unlinked['installation'], retained['installation'])
        self.assertEqual(unlinked['library'], retained['library'])
        self.assertEqual(unlinked['state'], 'draft')
        self.assertIsNone(unlinked['schedule_binding'])
        self.assertIsNone(unlinked['confirmation'])
        self.confirm(first, 2)
        expected['rows'][0]['inputs']['O'] = 16.125
        self.assertEqual(self.draft, expected)
        self.assertEqual(self.record(second)['schedule_binding']['quantity'], 4)

    def test_unlink_deleted_member_keeps_zero_quantity_row_and_all_literal_fields(self):
        member = self.member(); identifier, _, _ = self.assignment([member])
        self.review_members(identifier)
        self.confirm(identifier, 2)
        self.draft['rows'][0]['inputs'].update(AI=12.123456789, AJ=34.987654321, T='Keep zero row')
        original = deepcopy(self.draft)
        self.physical([{'op': 'delete', 'entity_id': member, 'cascade': True}])
        result = self.apply(self.preview(identifier, 0, operation='unlink'))[0]
        expected = deepcopy(original); expected['rows'][0]['inputs']['O'] = 0
        self.assertEqual(self.draft, expected)
        self.assertEqual(result['snapshot']['physical']['defects'][0]['deleted'], True)
        self.assertIsNone(self.record(identifier)['schedule_binding'])
        self.assertIsNone(self.record(identifier)['confirmation'])
        self.case.documents.validate_audit(result['snapshot'], owner=self.sid)
        before = self.state()
        with self.assertRaisesRegex(ValidationError, 'no confirmed schedule contribution'):
            self.preview(identifier, 0, operation='unlink')
        self.assertEqual(self.state(), before)

    def test_unlink_rejects_stale_capture_invalid_new_quantity_and_negative_manual_remainder(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        self.confirm(identifier, 2)
        preview = self.preview(identifier, 0, operation='unlink')
        edited = deepcopy(self.draft); edited['rows'][0]['inputs']['T'] = 'New human edit after review'
        before = self.state()
        with self.assertRaisesRegex(ValidationError, 'prices changed'):
            self.apply(preview, draft=edited)
        for quantity in (1, -1, True):
            with self.subTest(quantity=quantity), self.assertRaises(ValidationError):
                self.preview(identifier, quantity, operation='unlink')
        self.draft['rows'][0]['inputs']['O'] = 1
        with self.assertRaisesRegex(ValidationError, 'retained contribution'):
            self.preview(identifier, 0, operation='unlink')
        self.assertEqual(self.state(), before)

    def test_retained_confirmed_link_can_unlink_without_current_library_but_cannot_reconfirm(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        self.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual', 'library_item_id': 'pkb-001',
            'inputs': {'O': 10.125, 'AI': 50.123456789012, 'AJ': 100.987654321098,
                'T': 'Keep manual words even without shared library'}}]}
        manual = deepcopy(self.draft); self.confirm(identifier, 2.75)
        confirmed = deepcopy(self.record(identifier))
        snapshot = self.state()['snapshot']
        self.case.library.save_as({**deepcopy(self.case.base), 'takeoffs': snapshot,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.draft)}})
        self.service.close(self.sid); self.case.dialogs.opened = str(self.case.target)
        reopened = self.case.library.open_file(); self.sid = reopened['takeoffs_session_id']
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(self.record(identifier), confirmed)
        self.service.libraries = None
        try:
            result = self.apply(self.preview(identifier, 0, operation='unlink'))[0]
            self.assertEqual(self.draft, manual)
            self.assertEqual(self.record(identifier)['id'], confirmed['id'])
            self.assertEqual(self.record(identifier)['installation'], confirmed['installation'])
            self.assertEqual(self.record(identifier)['library'], confirmed['library'])
            self.assertIsNone(self.record(identifier)['schedule_binding'])
            self.assertIsNone(self.record(identifier)['confirmation'])
            self.case.documents.validate_audit(result['snapshot'], owner=self.sid)
            before = self.state()
            with self.assertRaisesRegex(ValidationError, 'Library is unavailable'):
                self.preview(identifier, 1)
            self.assertEqual(self.state(), before)
            self.assertEqual(self.draft, manual)
        finally:
            self.service.libraries = self.library

    def test_service_plan_scope_is_independent_and_does_not_populate_defect_reports(self):
        member = self.member('service_plans')
        identifier, _, _ = self.assignment([member], scope='service_plans')
        self.review_members(identifier)
        result = self.confirm(identifier, 2)
        self.assertEqual(self.record(identifier)['scope'], 'service_plans')
        self.assertIsNone(result['snapshot']['physical'])
        self.assertEqual(result['snapshot']['service_plans']['barriers'][0]['id'], member)
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 2)

    def test_saved_project_reopens_exact_assignment_ids_audit_sources_and_schedule_values(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        self.confirm(identifier, 1.234567890123)
        record, snapshot = deepcopy(self.record(identifier)), self.state()['snapshot']
        self.case.library.save_as({**deepcopy(self.case.base), 'takeoffs': snapshot,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.draft)}})
        payload = self.case.target.read_bytes(); saved = json.loads(payload)
        self.assertEqual(saved['takeoffs']['library_assignments']['records'], [record])
        self.assertEqual(saved['penetration']['draft'], normalize_draft(self.draft))
        self.service.close(self.sid)
        self.case.dialogs.opened = str(self.case.target)
        reopened = self.case.library.open_file()
        self.sid = reopened['takeoffs_session_id']
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['library_assignments']['records'], [record])
        self.case.documents.validate_audit(reopened['takeoffs'], owner=self.sid)
        self.assertEqual(self.service.capture(self.sid, reopened['takeoffs'])['library_assignments']['records'], [record])
        self.assertEqual(self.case.target.read_bytes(), payload)
        companion = self.case.root / saved['takeoffs']['companion_folder']
        self.assertTrue(any(path.read_bytes() == self.case.pdf for path in companion.rglob('*.pdf')))
        self.assert_source_unchanged()

    def test_forged_assignment_hashes_and_uncontrolled_audit_transitions_are_rejected(self):
        identifier, _, _ = self.assignment([self.member()]); self.review_members(identifier); result = self.confirm(identifier, 1)
        for field in ('context_sha256', 'library_sha256'):
            invalid = deepcopy(result['snapshot'])
            invalid['library_assignments']['records'][0]['confirmation'][field] = 'b' * 64
            with self.subTest(field=field), self.assertRaises(ValidationError):
                validate_snapshot(invalid)
        event = self.case.documents.get_blob(result['snapshot']['audit_head'])
        forged = deepcopy(event); forged['op'] = 'record_render'
        bad = deepcopy(result['snapshot']); bad['audit_head'] = self.case.documents.put_blob(forged)
        with self.assertRaisesRegex(ValidationError, 'commercial contribution'):
            self.case.documents.validate_audit(bad, owner=self.sid)
        forged = deepcopy(event)
        forged['after']['library_assignments']['records'][0]['installation']['id'] = str(uuid4())
        bad['audit_head'] = self.case.documents.put_blob(forged)
        with self.assertRaisesRegex(ValidationError, 'identities cannot be rewritten'):
            self.case.documents.validate_audit(bad, owner=self.sid)
        self.assertEqual(self.record(identifier)['schedule_binding']['quantity'], 1)

    def test_version_bounds_and_duplicate_members_reject_malformed_portable_collection(self):
        identifier, _, _ = self.assignment([self.member()])
        original = self.state()['snapshot']
        changes = []
        changed = deepcopy(original); changed['library_assignments']['version'] = True; changes.append(changed)
        changed = deepcopy(original); changed['library_assignments']['records'][0]['members'] *= 2; changes.append(changed)
        changed = deepcopy(original); changed['library_assignments']['records'][0]['version'] = 0; changes.append(changed)
        changed = deepcopy(original); changed['library_assignments']['records'][0]['physical_approval'] = True; changes.append(changed)
        for changed in changes:
            with self.subTest(changed=changed['library_assignments']), self.assertRaises(ValidationError):
                validate_assignments(changed)
        self.assertEqual(self.record(identifier)['version'], 1)

    def test_malformed_assignment_members_are_validation_errors_and_preserve_current_state(self):
        member = self.member(); selected = self.library.takeoff_record('pkb-001'); before = self.state()
        proposal = {'id': str(uuid4()), 'scope': 'defect_reports', 'library_id': selected['id'],
            'library_fingerprint': selected['metadata_sha256'], 'member_ids': [member],
            'installation': {'id': str(uuid4()), 'mode': 'repeated_installations', 'note': ''}}
        for members in ([{}], [[]], [member, {}], [member, member], [], 'not a list'):
            invalid = {**deepcopy(proposal), 'member_ids': members}
            with self.subTest(members=members), self.assertRaises(ValidationError):
                self.service.command(self.sid, {'op': 'draft_library_assignment', 'request_id': str(uuid4()),
                    'expected_revision': before['revision'], 'assignment': invalid})
            self.assertEqual(self.state(), before)

    def test_unavailable_library_preserves_all_current_state(self):
        identifier, _, _ = self.assignment([self.member()])
        self.review_members(identifier)
        before = self.state()
        with patch.object(self.library, 'takeoff_record', side_effect=ValidationError('Selected library unavailable')):
            with self.assertRaisesRegex(ValidationError, 'unavailable'):
                self.preview(identifier, 1)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft['rows'], [])

    def test_imported_service_uses_exact_selected_descriptor_without_inventing_quantity(self):
        commands, identifier, selected = self.unknown_import()
        before, schedule = self.state()['snapshot'], deepcopy(self.draft)
        preview = self.service.preview_physical(self.sid, {
            'expected_revision': before['revision'], 'commands': deepcopy(commands)})
        self.assertEqual(self.state()['snapshot'], before)
        result = self.service.apply_physical(self.sid, {'expected_revision': before['revision'],
            'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        graph = result['snapshot']['physical']
        self.assertEqual(graph['state'], 'draft')
        self.assertEqual([graph[key][0]['display_id'] for key in ('defects', 'barriers', 'services')],
            ['D-0001', 'B-0001', 'S-0001'])
        service = graph['services'][0]
        self.assertEqual(service['id'], identifier)
        self.assertIsNone(service['quantity'])
        self.assertEqual(service['library_quantity'], commands[-1]['entity']['library_quantity'])
        self.assertEqual(service['fields'], selected['import_fields']['service'])
        self.assertEqual(service['barrier_id'], graph['barriers'][0]['id'])
        self.assertEqual(graph['barriers'][0]['defect_id'], graph['defects'][0]['id'])
        self.assertIn('Quantity unknown', service_summary(service))
        self.assertNotIn('None', service_summary(service))
        self.assertEqual(self.draft, schedule)
        for key in ('items', 'transfers', 'documents', 'calibrations'):
            self.assertEqual(result['snapshot'][key], before[key])
        self.assertNotIn('library_assignments', result['snapshot'])
        validate_snapshot(result['snapshot'])
        assignment, _, _ = self.assignment([command['entity']['id'] for command in commands])
        self.review_members(assignment)
        graph = deepcopy(self.state()['snapshot']['physical'])
        confirmed = self.confirm(assignment, 4.125)
        self.assertEqual(confirmed['snapshot']['physical'], graph)
        self.assertIsNone(confirmed['snapshot']['physical']['services'][0]['quantity'])
        self.assertEqual(self.draft['rows'][0]['inputs']['O'], 4.125)
        self.assert_source_unchanged()

    def test_unknown_import_rejects_wrong_hash_unavailable_library_and_malformed_descriptor(self):
        commands, _, _ = self.unknown_import()
        before = self.state()
        changes = []
        wrong = deepcopy(commands); wrong[-1]['entity']['library_quantity']['metadata_sha256'] = 'b' * 64; changes.append(wrong)
        for descriptor in ([], True, {'version': True, 'state': 'unknown', 'library_id': 'pkb-001',
                'metadata_sha256': commands[-1]['entity']['library_quantity']['metadata_sha256']}):
            wrong = deepcopy(commands); wrong[-1]['entity']['library_quantity'] = descriptor; changes.append(wrong)
        for wrong in changes:
            with self.subTest(entity=wrong[-1]['entity']), self.assertRaises(ValidationError):
                self.service.preview_physical(self.sid, {'expected_revision': before['revision'], 'commands': wrong})
            self.assertEqual(self.state(), before)
        self.service.libraries = None
        try:
            with self.assertRaisesRegex(ValidationError, 'Library is unavailable'):
                self.service.preview_physical(self.sid, {'expected_revision': before['revision'], 'commands': commands})
        finally:
            self.service.libraries = self.library
        self.assertEqual(self.state(), before)

    def test_unknown_import_preview_expires_when_actual_library_metadata_changes(self):
        commands, _, _ = self.unknown_import(); before = self.state()
        preview = self.service.preview_physical(self.sid, {
            'expected_revision': before['revision'], 'commands': commands})
        self.change_library_description()
        with self.assertRaisesRegex(ValidationError, 'exact currently selected'):
            self.service.apply_physical(self.sid, {'expected_revision': before['revision'],
                'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        self.assertEqual(self.state(), before)
        self.assertEqual(self.draft['rows'], [])

    def test_unknown_service_unrelated_edits_copy_and_undo_preserve_descriptor(self):
        commands, identifier, _ = self.unknown_import(); self.physical(commands)
        source = deepcopy(self.state()['snapshot']['physical']['services'][0])
        fields = {**deepcopy(source['fields']), 'label': 'Human descriptive edit'}
        edited = self.physical([{'op': 'update', 'entity_id': identifier, 'changes': {'fields': fields}}])
        service = edited['snapshot']['physical']['services'][0]
        self.assertIsNone(service['quantity'])
        self.assertEqual(service['library_quantity'], source['library_quantity'])
        self.service.command(self.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': edited['revision']})
        restored = self.state()['snapshot']['physical']['services'][0]
        self.assertEqual(restored['fields'], source['fields'])
        self.assertEqual(restored['library_quantity'], source['library_quantity'])
        copy_entity = {key: deepcopy(restored[key]) for key in ('fields', 'evidence', 'uncertainty',
            'barrier_id', 'quantity', 'library_quantity')}
        copy_entity.update(id=str(uuid4()), copied_from={'entity_id': identifier, 'revision': restored['revision']})
        copied = self.physical([{'op': 'create', 'kind': 'service', 'entity': copy_entity}])
        duplicate = copied['snapshot']['physical']['services'][1]
        self.assertEqual(duplicate['display_id'], 'S-0002')
        self.assertIsNone(duplicate['quantity'])
        self.assertEqual(duplicate['library_quantity'], source['library_quantity'])
        self.assertEqual(duplicate['copied_from'], copy_entity['copied_from'])
        undone = self.service.command(self.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': copied['revision']})
        tombstone = undone['snapshot']['physical']['services'][1]
        self.assertTrue(tombstone['deleted'])
        self.assertIsNone(tombstone['quantity'])
        self.assertEqual(tombstone['library_quantity'], source['library_quantity'])
        self.case.documents.validate_audit(undone['snapshot'], owner=self.sid)

    def test_copy_after_library_edit_retains_historical_unknown_provenance_and_rejects_forgery(self):
        commands, identifier, _ = self.unknown_import(); self.physical(commands)
        source = deepcopy(self.state()['snapshot']['physical']['services'][0])
        self.change_library_description()
        current_library = self.library.takeoff_record('pkb-001')
        self.assertNotEqual(current_library['metadata_sha256'], source['library_quantity']['metadata_sha256'])
        copied = {key: deepcopy(source[key]) for key in ('fields', 'evidence', 'uncertainty',
            'barrier_id', 'quantity', 'library_quantity')}
        copied.update(id=str(uuid4()), copied_from={'entity_id': identifier, 'revision': source['revision']})
        before = self.state()
        invalid = []
        forged = deepcopy(copied); forged['copied_from']['revision'] += 1; invalid.append(forged)
        forged = deepcopy(copied); forged['copied_from']['entity_id'] = str(uuid4()); invalid.append(forged)
        forged = deepcopy(copied); forged['library_quantity']['metadata_sha256'] = 'b' * 64; invalid.append(forged)
        forged = deepcopy(copied); forged.pop('copied_from'); invalid.append(forged)
        for forged in invalid:
            with self.subTest(entity=forged), self.assertRaises(ValidationError):
                self.service.preview_physical(self.sid, {'expected_revision': before['revision'],
                    'commands': [{'op': 'create', 'kind': 'service', 'entity': forged}]})
            self.assertEqual(self.state(), before)
        result = self.physical([{'op': 'create', 'kind': 'service', 'entity': copied}])
        duplicate = result['snapshot']['physical']['services'][1]
        self.assertIsNone(duplicate['quantity'])
        self.assertEqual(duplicate['library_quantity'], source['library_quantity'])
        self.assertEqual(duplicate['fields'], source['fields'])
        self.assertEqual(duplicate['copied_from'], copied['copied_from'])
        self.assertEqual(duplicate['display_id'], 'S-0002')
        self.assertNotIn('library_assignments', result['snapshot'])
        self.assertEqual(self.draft['rows'], [])
        self.case.documents.validate_audit(result['snapshot'], owner=self.sid)
        self.assert_source_unchanged()

    def test_explicit_positive_integer_replaces_unknown_descriptor_and_undo_restores_it(self):
        commands, identifier, _ = self.unknown_import(); self.physical(commands)
        original = deepcopy(self.state()['snapshot']['physical']['services'][0])
        before = self.state()
        for quantity in (0, -1, True, 1.0, 1.5, '2'):
            with self.subTest(quantity=quantity), self.assertRaises(ValidationError):
                self.service.preview_physical(self.sid, {'expected_revision': before['revision'],
                    'commands': [{'op': 'update', 'entity_id': identifier, 'changes': {'quantity': quantity}}]})
        changed = self.physical([{'op': 'update', 'entity_id': identifier, 'changes': {'quantity': 3}}])
        service = changed['snapshot']['physical']['services'][0]
        self.assertEqual(service['quantity'], 3)
        self.assertNotIn('library_quantity', service)
        self.assertEqual(service['fields'], original['fields'])
        undone = self.service.command(self.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': changed['revision']})
        restored = undone['snapshot']['physical']['services'][0]
        self.assertIsNone(restored['quantity'])
        self.assertEqual(restored['library_quantity'], original['library_quantity'])
        self.assertEqual(self.draft['rows'], [])

    def test_unqualified_null_and_missing_quantities_still_reject_in_current_physical_graphs(self):
        for scope in ('defect_reports', 'service_plans'):
            commands, _, _ = self.unknown_import(scope)
            for missing in (False, True):
                wrong = deepcopy(commands); wrong[-1]['entity'].pop('library_quantity')
                if missing:
                    wrong[-1]['entity'].pop('quantity')
                before = self.state()
                with self.subTest(scope=scope, missing=missing), self.assertRaises(ValidationError):
                    self.service.preview_physical(self.sid, {'expected_revision': before['revision'],
                        'commands': wrong, 'scope': scope})
                self.assertEqual(self.state(), before)
            applied = self.physical(commands, scope)
            graph = applied['snapshot']['service_plans' if scope == 'service_plans' else 'physical']
            self.assertIsNone(graph['services'][0]['quantity'])
            wrong = deepcopy(graph); wrong['services'][0].pop('library_quantity')
            with self.assertRaises(ValidationError):
                validate_graph(wrong)

    def test_unknown_service_portable_project_and_diagnostic_exports_preserve_provenance(self):
        commands, identifier, _ = self.unknown_import(); result = self.physical(commands)
        service = deepcopy(result['snapshot']['physical']['services'][0])
        payload, _, _ = self.service.export_physical(self.sid, 'csv')
        rows = list(csv.DictReader(StringIO(payload.decode('utf-8-sig'))))
        exported = next(row for row in rows if row['entity_id'] == identifier)
        self.assertEqual(exported['quantity'], '')
        self.assertEqual(json.loads(exported['library_quantity_json']), service['library_quantity'])
        self.assertEqual(exported['display_id'], 'S-0001')
        payload, _, _ = self.service.export_physical(self.sid, 'xlsx')
        workbook = load_workbook(BytesIO(payload), data_only=False)
        try:
            values = list(workbook['Services'].values)
            exported = dict(zip(values[0], values[1]))
            self.assertIsNone(exported['quantity'])
            self.assertEqual(json.loads(exported['library_quantity_json']), service['library_quantity'])
            self.assertEqual(exported['display_id'], 'S-0001')
        finally:
            workbook.close()
        payload, _, _ = self.service.export_physical(self.sid, 'pdf', expected_revision=result['revision'])
        text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)
        self.assertIn('S-0001', text)
        self.assertNotIn('None', text)
        self.assertNotIn('null', text)
        self.case.library.save_as({**deepcopy(self.case.base), 'takeoffs': result['snapshot'],
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.draft)}})
        saved_bytes = self.case.target.read_bytes()
        self.service.close(self.sid); self.case.dialogs.opened = str(self.case.target)
        reopened = self.case.library.open_file(); self.sid = reopened['takeoffs_session_id']
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['physical']['services'][0], service)
        self.assertEqual(self.service.capture(self.sid, reopened['takeoffs'])['physical']['services'][0], service)
        self.assertEqual(self.case.target.read_bytes(), saved_bytes)
        self.assert_source_unchanged()

    def test_actual_library_import_maps_literal_columns_without_technical_inference(self):
        path = self.case.root / 'library/library.json'
        source = json.loads(path.read_text(encoding='utf-8'))
        inputs = source['libraries']['penetration']['items'][0]['estimate']['draft']['rows'][0]['inputs']
        inputs.update(J='Category literal', K='Copper service', L='Penetration literal', M='Horizontal',
            N='120/120/120', P='Concrete literal', Q='Application literal', R='Installation literal',
            T='Description literal <script>', U='System literal', V='Manufacturer literal',
            AL=25.123456789012, AQ=50.234567890123, AR=75.345678901234)
        path.write_text(json.dumps(source), encoding='utf-8'); before = path.read_bytes()
        selected = FirestoppingLibrary(self.case.root / 'library', self.case.store).takeoff_record('pkb-001')
        imported = selected['import_fields']
        self.assertEqual(imported['defect']['label'], 'FL-ID-001')
        self.assertEqual(imported['defect']['frl'], '120/120/120')
        self.assertEqual(imported['barrier']['substrate'], 'Concrete literal')
        self.assertEqual(imported['barrier']['orientation'], 'Horizontal')
        self.assertEqual(imported['barrier']['barrier_type'], 'Penetration literal')
        self.assertEqual(imported['service']['service_type'], 'Copper service')
        self.assertEqual(imported['service']['service'], 'Category literal')
        self.assertNotEqual(imported['service']['service'], inputs['L'])
        for column, name in (('AL', 'diameter_mm'), ('AQ', 'width_mm'), ('AR', 'height_mm')):
            self.assertEqual(imported['service'][name], inputs[column])
        for column in ('J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'T', 'U', 'V'):
            self.assertIn(str(inputs[column]), imported['defect']['notes'])
        self.assertEqual(path.read_bytes(), before)
        inputs['K'] = 'Blank Seal'; path.write_text(json.dumps(source), encoding='utf-8')
        selected = FirestoppingLibrary(self.case.root / 'library', self.case.store).takeoff_record('pkb-001')
        self.assertIsNone(selected['import_fields']['service'])


class TakeoffLibraryLinkApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); cls.root = Path(cls.temp.name)
        editable_library(cls.root / 'library', complete_entries=True)
        cls.server = create_server(0, cls.root / 'api.sqlite3', library_directory=cls.root / 'library')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def request(self, path, body=None, method='POST', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None,
                headers={'Content-Type': 'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_real_http_preview_apply_replay_and_origin_guards(self):
        code, state = self.request('/api/takeoffs/sessions', {})
        self.assertEqual(code, 200)
        base = '/api/takeoffs/sessions/' + state['session_id']
        command = create('defect', label='API draft')
        command['entity']['confirmation'] = 'confirmed'
        code, preview = self.request(base + '/physical/preview', {'expected_revision': 0, 'commands': [command]})
        self.assertEqual(code, 200, preview)
        code, state = self.request(base + '/physical/apply', {'expected_revision': 0,
            'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        self.assertEqual(code, 200, state)
        code, selected = self.request('/api/libraries/penetration/pkb-001/takeoff', method='GET')
        self.assertEqual(code, 200, selected)
        assignment = {'id': str(uuid4()), 'scope': 'defect_reports', 'library_id': 'pkb-001',
            'library_fingerprint': selected['metadata_sha256'], 'member_ids': [command['entity']['id']],
            'installation': {'id': str(uuid4()), 'mode': 'repeated_installations', 'note': ''}}
        code, state = self.request(base + '/commands', {'op': 'draft_library_assignment',
            'expected_revision': state['revision'], 'request_id': str(uuid4()), 'assignment': assignment})
        self.assertEqual(code, 200, state)
        draft = {'globals': {}, 'rows': []}
        review = {'expected_revision': state['revision'], 'assignment_id': assignment['id'],
            'quantity': 2.123456789012, 'draft': draft, 'configuration': {}}
        self.assertEqual(self.request(base + '/library/preview', review, headers={'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request(base + '/library/preview', review, method='PUT')[0], 405)
        code, preview = self.request(base + '/library/preview', review)
        self.assertEqual(code, 200, preview)
        self.assertEqual(self.request(base, method='GET')[1], state)
        apply = {'expected_revision': state['revision'], 'request_id': str(uuid4()),
            'preview_id': preview['preview_id'], 'draft': draft, 'configuration': {}}
        code, result = self.request(base + '/library/apply', apply)
        self.assertEqual(code, 200, result)
        code, replay = self.request(base + '/library/apply', apply)
        self.assertEqual(code, 200, replay)
        self.assertEqual(replay, result)
        self.assertEqual(result['penetration']['draft']['rows'][0]['inputs']['O'], 2.123456789012)
        self.assertEqual(result['snapshot']['physical'], state['snapshot']['physical'])
        self.assertEqual(len(result['snapshot']['library_assignments']['records']), 1)

    def test_selected_unknown_service_http_import_rejects_malformed_provenance_as_client_error(self):
        code, state = self.request('/api/takeoffs/sessions', {})
        self.assertEqual(code, 200)
        base = '/api/takeoffs/sessions/' + state['session_id']
        code, selected = self.request('/api/libraries/penetration/pkb-001/takeoff', method='GET')
        self.assertEqual(code, 200, selected)
        defect = create('defect', **selected['import_fields']['defect'])
        barrier = create('barrier', defect['entity']['id'], **selected['import_fields']['barrier'])
        service = create('service', barrier['entity']['id'], **selected['import_fields']['service'])
        service['entity'].update(quantity=None, library_quantity={'version': 1, 'state': 'unknown',
            'library_id': selected['id'], 'metadata_sha256': selected['metadata_sha256']})
        commands = [defect, barrier, service]
        for descriptor in ([], True, {**service['entity']['library_quantity'], 'metadata_sha256': 'b' * 64}):
            invalid = deepcopy(commands); invalid[-1]['entity']['library_quantity'] = descriptor
            code, result = self.request(base + '/physical/preview', {'expected_revision': 0, 'commands': invalid})
            self.assertEqual(code, 400, result)
            self.assertEqual(self.request(base, method='GET')[1], state)
        code, preview = self.request(base + '/physical/preview', {'expected_revision': 0, 'commands': commands})
        self.assertEqual(code, 200, preview)
        code, result = self.request(base + '/physical/apply', {'expected_revision': 0,
            'request_id': str(uuid4()), 'preview_id': preview['preview_id']})
        self.assertEqual(code, 200, result)
        service = result['snapshot']['physical']['services'][0]
        self.assertEqual(service['display_id'], 'S-0001')
        self.assertIsNone(service['quantity'])
        self.assertEqual(service['library_quantity']['metadata_sha256'], selected['metadata_sha256'])
        self.assertNotIn('library_assignments', result['snapshot'])


if __name__ == '__main__':
    unittest.main()
