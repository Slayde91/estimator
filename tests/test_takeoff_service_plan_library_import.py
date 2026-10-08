"""Service Plans imports append literal drafts within an explicit root context."""
from copy import deepcopy
import json
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_library_links import member_context, validate_assignments, validate_history
from tests import test_takeoff_library_links as fixtures
from tests.test_takeoff_physical_v2 import create as create_defect
from tests.test_takeoff_service_plans import create


class ServicePlanLibraryImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.TakeoffLibraryLinkTests.setUpClass()

    def setUp(self):
        self.fixture = fixtures.TakeoffLibraryLinkTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service, self.sid = self.fixture.service, self.fixture.sid
        self.fixture.physical([create_defect('defect', label='Unrelated Defect')])
        document = self.state()['documents'][0]
        self.marker = {'document_id': document['id'], 'document_sha256': document['sha256'],
                       'page': 1, 'point': [130.123456789, 330.987654321]}
        self.root = create(marker=self.marker, location='Observed level 2', frl='-/60/60',
            substrate='Observed brick', orientation='Horizontal', barrier_type='Oversized', notes='Retained notes')
        self.original_service = create('service', self.root['entity']['id'], quantity=17,
            service='Original retained service', diameter_mm=25.123456789012, notes='Retain manual details')
        self.fixture.physical([self.root, self.original_service], scope='service_plans')
        edit = self.fixture.library.edit('pkb-001'); draft = deepcopy(edit['draft'])
        draft['rows'][0]['inputs'].update(P='Concrete/masonry wall', M='Vertical', L='Core Hole', N='-/120/120')
        self.fixture.library.action('pkb-001', 'save', {'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})
        self.library = self.fixture.library.takeoff_record('pkb-001')

    def state(self):
        return self.fixture.state()['snapshot']

    def barrier(self):
        return next(value for value in self.state()['service_plans']['barriers'] if value['id'] == self.root['entity']['id'])

    def proposal(self, existing=False, **changes):
        barrier = self.barrier()
        proposal = {'version': 1, 'scope': 'service_plans', 'context_barrier_id': barrier['id'],
            'context_barrier_revision': barrier['revision'], 'selected_ids': [self.original_service['entity']['id']],
            'barrier_id': barrier['id'] if existing else None, 'barrier_revision': barrier['revision'] if existing else None,
            'library_id': self.library['id'], 'library_fingerprint': self.library['metadata_sha256'],
            'accept_mismatch': existing, 'item_quantity': 700, 'draft_quantity': 700, 'draft_location': 'Selected library location',
            'ids': {'barrier': None if existing else str(uuid4()),
                    'service': str(uuid4()) if self.library['import_fields']['service'] is not None else None,
                    'assignment': str(uuid4()), 'installation': str(uuid4())}}
        proposal.update(changes)
        return proposal

    def apply(self, proposal, **changes):
        request = {'op': 'import_library_item', 'expected_revision': self.state()['revision'],
                   'request_id': str(uuid4()), 'import': proposal, **changes}
        return self.service.command(self.sid, request), request

    def blank_seal(self):
        edit = self.fixture.library.edit('pkb-001'); draft = deepcopy(edit['draft'])
        draft['rows'][0]['inputs']['K'] = 'Blank Seal'
        self.fixture.library.action('pkb-001', 'save', {'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})
        self.library = self.fixture.library.takeoff_record('pkb-001')
        self.assertIsNone(self.library['import_fields']['service'])

    def assert_unchanged_outside_scope(self, before, after):
        for key in ('physical', 'documents', 'items', 'calibrations', 'transfers', 'render_checks'):
            self.assertEqual(after.get(key), before.get(key))
        self.assertEqual(self.fixture.draft['rows'], [])

    def test_new_root_adopts_literal_fields_frl_location_and_explicit_count_without_source_copy(self):
        before = deepcopy(self.state()); stored = self.fixture.calculator_storage()
        proposal = self.proposal(); result, request = self.apply(proposal); after = result['snapshot']
        graph = after['service_plans']; barrier, service = graph['barriers'][-1], graph['services'][-1]
        self.assertEqual(graph['version'], 3); self.assertNotIn('defects', graph)
        self.assertNotIn('defect_id', barrier); self.assertNotIn('marker', barrier); self.assertEqual(barrier['evidence'], [])
        self.assertEqual(barrier['fields'], {**self.library['import_fields']['barrier'],
            'frl': self.library['import_fields']['defect']['frl'], 'location': proposal['draft_location']})
        self.assertEqual(service['fields'], self.library['import_fields']['service'])
        self.assertEqual(service['barrier_id'], barrier['id']); self.assertEqual(service['quantity'], 700)
        self.assertEqual(graph['barriers'][0], before['service_plans']['barriers'][0])
        self.assertEqual(graph['services'][0], before['service_plans']['services'][0])
        assignment = after['library_assignments']['records'][-1]
        self.assertEqual({member['id'] for member in assignment['members']}, {barrier['id'], service['id']})
        self.assertEqual(assignment['barrier_selection']['version'], 2)
        self.assertEqual(assignment['barrier_selection']['context_barrier_id'], self.barrier()['id'])
        self.assertEqual(assignment['state'], 'draft'); self.assertIsNone(assignment['schedule_binding'])
        self.assertEqual(assignment['quantity_source'], {'version': 1, 'kind': 'services'})
        self.assert_unchanged_outside_scope(before, after); self.assertEqual(self.fixture.calculator_storage(), stored)
        self.assertEqual(self.service.command(self.sid, request), result)
        self.assertEqual(len(self.state()['service_plans']['services']), 2)
        validate_history(self.fixture.case.documents.get_blob(after['audit_head']))

    def test_existing_root_appends_sibling_service_and_keeps_observed_substrate_frl_source_and_quantity(self):
        before = deepcopy(self.state()); proposal = self.proposal(existing=True)
        after = self.apply(proposal)[0]['snapshot']
        self.assertEqual(after['service_plans']['barriers'], before['service_plans']['barriers'])
        self.assertEqual(after['service_plans']['services'][0], before['service_plans']['services'][0])
        added = after['service_plans']['services'][-1]
        self.assertEqual(added['barrier_id'], self.root['entity']['id']); self.assertEqual(added['quantity'], 700)
        selection = after['library_assignments']['records'][-1]['barrier_selection']
        self.assertTrue(selection['mismatch_accepted']); self.assertEqual(len(selection['differences']), 3)
        self.assertEqual(selection['retained_fields']['substrate'], 'Observed brick')
        self.assertEqual(selection['source_fields']['substrate'], 'Concrete/masonry wall')
        self.assert_unchanged_outside_scope(before, after)

    def test_existing_matching_root_needs_no_mismatch_and_unknown_quantity_stays_unknown(self):
        self.fixture.physical([{'op': 'update', 'entity_id': self.root['entity']['id'],
            'changes': {'fields': {**self.barrier()['fields'], **self.library['import_fields']['barrier']}}}], scope='service_plans')
        proposal = self.proposal(existing=True, accept_mismatch=False)
        proposal.pop('item_quantity'); proposal.pop('draft_quantity')
        after = self.apply(proposal)[0]['snapshot']; service = after['service_plans']['services'][-1]
        self.assertIsNone(service['quantity']); self.assertEqual(service['library_quantity']['metadata_sha256'], self.library['metadata_sha256'])
        selection = after['library_assignments']['records'][-1]['barrier_selection']
        self.assertEqual(selection['differences'], []); self.assertFalse(selection['mismatch_accepted'])

    def test_mismatch_without_continue_is_atomic_and_prior_services_never_recounted(self):
        before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'mismatch'):
            self.apply(self.proposal(existing=True, accept_mismatch=False))
        self.assertEqual(self.state(), before)
        self.assertEqual(self.state()['service_plans']['services'][0]['quantity'], 17)

    def test_selected_service_blank_seal_associates_barrier_only_and_association_only_undo_rejects(self):
        self.blank_seal(); before = deepcopy(self.state())
        after = self.apply(self.proposal(existing=True))[0]['snapshot']
        self.assertEqual(after['service_plans'], before['service_plans'])
        record = after['library_assignments']['records'][-1]
        self.assertEqual([(value['kind'], value['id']) for value in record['members']], [('barrier', self.root['entity']['id'])])
        self.assertEqual(record['quantity_source'], {'version': 1, 'kind': 'blank_seals', 'quantity': 700})
        with self.assertRaisesRegex(ValidationError, 'cannot be reversed by Takeoff-only Undo'):
            self.service.command(self.sid, {'op': 'undo', 'expected_revision': after['revision'], 'request_id': str(uuid4())})
        self.assertEqual(self.state(), after)

    def test_cross_root_stale_scope_context_library_and_reused_ids_fail_without_partial_mutation(self):
        other = create(substrate='Other root'); self.fixture.physical([other], scope='service_plans')
        before = deepcopy(self.state()); current = self.barrier()
        cases = [self.proposal(selected_ids=[current['id'], other['entity']['id']]),
            self.proposal(context_barrier_id=other['entity']['id']),
            self.proposal(context_barrier_revision=current['revision']+1),
            self.proposal(existing=True, barrier_id=other['entity']['id']),
            self.proposal(existing=True, barrier_revision=current['revision']+1),
            self.proposal(scope='defect_reports'), self.proposal(library_fingerprint='f'*64),
            self.proposal(selected_ids=[]), self.proposal(selected_ids=[self.state()['physical']['defects'][0]['id']])]
        reused = self.proposal(); reused['ids']['service'] = current['id']; cases.append(reused)
        forged = self.proposal(); forged['defect_id'] = self.state()['physical']['defects'][0]['id']; cases.append(forged)
        for proposal in cases:
            with self.subTest(proposal=proposal), self.assertRaises(ValidationError):
                self.apply(proposal)
            self.assertEqual(self.state(), before)
        with self.assertRaises(ValidationError):
            self.apply(self.proposal(), expected_revision=before['revision']-1)
        self.assertEqual(self.state(), before)
        stale = self.proposal(); self.fixture.change_library_description(); before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'metadata changed'):
            self.apply(stale)
        self.assertEqual(self.state(), before)

    def test_undo_new_import_tombstones_only_new_entities_and_roundtrip_keeps_versioned_provenance(self):
        before = deepcopy(self.state()); proposal = self.proposal(); imported = self.apply(proposal)[0]['snapshot']
        undone = self.service.command(self.sid, {'op': 'undo', 'expected_revision': imported['revision'], 'request_id': str(uuid4())})['snapshot']
        self.assertEqual(undone['service_plans']['barriers'][0], before['service_plans']['barriers'][0])
        self.assertEqual(undone['service_plans']['services'][0], before['service_plans']['services'][0])
        self.assertTrue(undone['service_plans']['barriers'][-1]['deleted']); self.assertTrue(undone['service_plans']['services'][-1]['deleted'])
        record = undone['library_assignments']['records'][-1]
        self.assertEqual(record['state'], 'needs_recheck'); self.assertEqual(record['barrier_selection'], imported['library_assignments']['records'][-1]['barrier_selection'])
        self.assert_unchanged_outside_scope(before, undone)
        self.fixture.case.library.save_as({**deepcopy(self.fixture.case.base), 'takeoffs': undone,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.fixture.draft)}})
        saved = json.loads(self.fixture.case.target.read_text(encoding='utf-8'))
        self.assertEqual(saved['takeoffs']['library_assignments'], undone['library_assignments'])
        self.fixture.case.dialogs.opened = str(self.fixture.case.target)
        reopened = self.fixture.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['service_plans'], undone['service_plans'])
        self.assertEqual(reopened['takeoffs']['library_assignments'], undone['library_assignments'])

    def test_undo_existing_import_retains_root_and_prior_service(self):
        before = deepcopy(self.state()); imported = self.apply(self.proposal(existing=True))[0]['snapshot']
        undone = self.service.command(self.sid, {'op': 'undo', 'expected_revision': imported['revision'], 'request_id': str(uuid4())})['snapshot']
        self.assertEqual(undone['service_plans']['barriers'], before['service_plans']['barriers'])
        self.assertEqual(undone['service_plans']['services'][0], before['service_plans']['services'][0])
        self.assertTrue(undone['service_plans']['services'][-1]['deleted'])
        self.assertEqual(undone['library_assignments']['records'][-1]['state'], 'needs_recheck')

    def test_forged_history_scope_context_source_and_existing_mutation_are_rejected(self):
        imported = self.apply(self.proposal())[0]['snapshot']
        event = self.fixture.case.documents.get_blob(imported['audit_head']); validate_history(event)
        for mutation in ('old_fields', 'new_marker', 'context_revision', 'scope', 'parent', 'other_graph'):
            forged = deepcopy(event); after = forged['after']; record = after['library_assignments']['records'][-1]
            if mutation == 'old_fields': after['service_plans']['barriers'][0]['fields']['substrate'] = 'Forged'
            elif mutation == 'new_marker': after['service_plans']['barriers'][-1]['marker'] = deepcopy(self.marker)
            elif mutation == 'context_revision': record['barrier_selection']['context_barrier_revision'] += 1
            elif mutation == 'scope': record['scope'] = 'defect_reports'
            elif mutation == 'parent': after['service_plans']['services'][-1]['barrier_id'] = self.root['entity']['id']
            else: after['physical']['defects'][0]['fields']['label'] = 'Forged other scope'
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                validate_history(forged)
        validate_assignments(imported)

    def test_forged_import_membership_cannot_recount_old_service_or_extra_root_or_new_services(self):
        for existing in (False, True):
            imported = self.apply(self.proposal(existing=existing))[0]['snapshot']
            event = self.fixture.case.documents.get_blob(imported['audit_head'])
            for mutation in ('old_service', 'extra_root', 'extra_new_service'):
                forged = deepcopy(event); after = forged['after']; record = after['library_assignments']['records'][-1]
                identifiers = [member['id'] for member in record['members']]
                if mutation == 'old_service':
                    identifiers.append(self.original_service['entity']['id'])
                elif mutation == 'extra_root':
                    # An explicit context owner is not a member of a new root import.
                    if existing:
                        continue
                    identifiers.append(self.root['entity']['id'])
                else:
                    extra = deepcopy(after['service_plans']['services'][-1]); extra['id'] = str(uuid4())
                    extra['display_id'] = f"S-{len(after['service_plans']['services'])+1:04d}"
                    after['service_plans']['services'].append(extra); identifiers.append(extra['id'])
                record['members'], record['context_sha256'] = member_context(after, 'service_plans', identifiers, record['installation'])
                validate_assignments(after)  # Consistent members/context still cannot rewrite import policy.
                with self.subTest(existing=existing, mutation=mutation), self.assertRaisesRegex(ValidationError, 'associates only'):
                    validate_history(forged)


if __name__ == '__main__':
    unittest.main()
