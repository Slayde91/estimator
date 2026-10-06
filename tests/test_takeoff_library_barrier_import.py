"""Additional manually selected library items retain one Defect and commercial boundaries."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_library_links import validate_assignments, validate_history
from estimator.takeoff_physical_markers import export_physical_pdf, inherited_library_barrier_parent
from tests import test_takeoff_library_links as link_fixtures
from tests.test_takeoff_physical_v2 import create


class LibraryBarrierImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        link_fixtures.TakeoffLibraryLinkTests.setUpClass()

    def setUp(self):
        self.fixture = link_fixtures.TakeoffLibraryLinkTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service, self.sid = self.fixture.service, self.fixture.sid
        document = self.state()['documents'][0]
        self.defect = create('defect', label='Retained Defect', frl='-/120/120', notes='Retain original notes')
        self.defect['entity']['annotation'] = {'document_id': document['id'], 'document_sha256': document['sha256'],
            'page': 1, 'point': [130.123456789, 330.987654321]}
        self.fixture.physical([self.defect])
        edit = self.fixture.library.edit('pkb-001'); draft = deepcopy(edit['draft'])
        draft['rows'][0]['inputs'].update(P='Concrete/masonry wall', M='Vertical', L='Core Hole')
        self.fixture.library.action('pkb-001', 'save', {'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})
        self.library = self.fixture.library.takeoff_record('pkb-001')

    def state(self):
        return self.fixture.state()['snapshot']

    def proposal(self, barrier=None, **changes):
        defect = next(value for value in self.state()['physical']['defects'] if value['id'] == self.defect['entity']['id'])
        value = {'version': 1, 'scope': 'defect_reports', 'defect_id': defect['id'], 'defect_revision': defect['revision'],
            'selected_ids': [defect['id']], 'barrier_id': barrier['id'] if barrier else None,
            'barrier_revision': barrier['revision'] if barrier else None, 'library_id': self.library['id'],
            'library_fingerprint': self.library['metadata_sha256'], 'accept_mismatch': False,
            'ids': {'barrier': None if barrier else str(uuid4()), 'service': str(uuid4()) if self.library['import_fields']['service'] else None,
                    'assignment': str(uuid4()), 'installation': str(uuid4())}}
        value.update(changes)
        return value

    def apply(self, proposed, **changes):
        request = {'expected_revision': self.state()['revision'], 'request_id': str(uuid4()),
                   'op': 'import_library_item', 'import': proposed, **changes}
        return self.service.command(self.sid, request), request

    def barrier(self, **fields):
        command = create('barrier', self.defect['entity']['id'], **fields)
        self.fixture.physical([command])
        return next(value for value in self.state()['physical']['barriers'] if value['id'] == command['entity']['id'])

    def test_new_barrier_import_is_atomic_literal_unknown_and_source_preserving(self):
        before = deepcopy(self.state()); stored = self.fixture.calculator_storage()
        proposed = self.proposal(); result, request = self.apply(proposed); after = result['snapshot']
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['barriers'][0]['defect_id'], proposed['defect_id'])
        self.assertEqual(after['physical']['barriers'][0]['marker'], before['physical']['defects'][0]['annotation'])
        self.assertEqual(after['physical']['barriers'][0]['fields'], self.library['import_fields']['barrier'])
        self.assertEqual(after['physical']['barriers'][0]['fields'].get('barrier_type'), self.library['inputs'].get('L'))
        service = after['physical']['services'][0]
        self.assertIsNone(service['quantity']); self.assertEqual(service['barrier_id'], proposed['ids']['barrier'])
        self.assertEqual(service['uncertainty']['state'], 'human_review_required')
        self.assertEqual(service['library_quantity']['metadata_sha256'], self.library['metadata_sha256'])
        assignment = after['library_assignments']['records'][0]
        self.assertEqual(assignment['state'], 'draft'); self.assertIsNone(assignment['confirmation'])
        self.assertIsNone(assignment['schedule_binding']); self.assertEqual(assignment['barrier_selection']['choice'], 'new')
        for key in ('documents', 'items', 'calibrations', 'transfers', 'render_checks'):
            self.assertEqual(after[key], before[key])
        self.assertNotIn('penetration', result); self.assertEqual(self.fixture.calculator_storage(), stored)
        self.assertEqual(self.service.command(self.sid, request), result)
        self.assertEqual(len(self.state()['physical']['services']), 1)
        self.fixture.assert_source_unchanged()

    def test_existing_matching_barrier_adds_only_service_and_preserves_originals(self):
        barrier = self.barrier(**self.library['import_fields']['barrier'])
        original_service = create('service', barrier['id'], service='Original retained service', notes='Keep manual values')
        original_service['entity']['quantity'] = 17
        self.fixture.physical([original_service]); before = deepcopy(self.state())
        result, _ = self.apply(self.proposal(barrier)); after = result['snapshot']
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['barriers'], before['physical']['barriers'])
        self.assertEqual(after['physical']['services'][0], before['physical']['services'][0])
        self.assertEqual(len(after['physical']['services']), 2)
        selection = after['library_assignments']['records'][0]['barrier_selection']
        self.assertEqual(selection['choice'], 'existing'); self.assertEqual(selection['differences'], [])
        self.assertFalse(selection['mismatch_accepted'])

    def test_mismatch_requires_continue_retains_barrier_and_confirm_is_separate(self):
        barrier = self.barrier(barrier_type='Oversized', substrate='Retained brick', orientation='Horizontal')
        before = deepcopy(self.state()); proposed = self.proposal(barrier)
        with self.assertRaisesRegex(ValidationError, 'mismatch'):
            self.apply(proposed)
        self.assertEqual(self.state(), before)
        proposed['accept_mismatch'] = True; after = self.apply(proposed)[0]['snapshot']
        self.assertEqual(after['physical']['barriers'][0], barrier)
        assignment = after['library_assignments']['records'][0]
        selection = assignment['barrier_selection']
        self.assertTrue(selection['mismatch_accepted']); self.assertTrue(selection['differences'])
        self.assertEqual(selection['retained_fields'], barrier['fields'])
        self.assertIsNone(assignment['schedule_binding']); self.assertEqual(self.fixture.draft['rows'], [])
        self.fixture.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual-row', 'library_item_id': self.library['id'],
            'inputs': {'O': 3.125, 'AI': 50.123456789012, 'AJ': 100.987654321098, 'T': 'Manual fields remain'}}]}
        manual = deepcopy(self.fixture.draft)
        result = self.fixture.confirm(assignment['id'], 2.75)
        self.assertEqual(self.fixture.draft['rows'][0]['inputs']['O'], 5.875)
        for key in ('AI', 'AJ', 'T'):
            self.assertEqual(self.fixture.draft['rows'][0]['inputs'][key], manual['rows'][0]['inputs'][key])
        self.assertIsNone(result['snapshot']['physical']['services'][0]['quantity'])
        self.assertEqual(result['snapshot']['physical']['barriers'][0], barrier)
        self.assertEqual(result['snapshot']['library_assignments']['records'][0]['barrier_selection'], selection)

    def test_cross_defect_wrong_parent_and_stale_barrier_are_rejected_without_change(self):
        barrier = self.barrier(**self.library['import_fields']['barrier'])
        other = create('defect', label='Other Defect'); self.fixture.physical([other])
        other_barrier = create('barrier', other['entity']['id'], substrate='Concrete'); self.fixture.physical([other_barrier])
        before = deepcopy(self.state())
        cases = [self.proposal(barrier, selected_ids=[self.defect['entity']['id'], other['entity']['id']]),
                 self.proposal(barrier, barrier_revision=barrier['revision'] + 1),
                 self.proposal(barrier, defect_revision=0),
                 self.proposal(barrier, barrier_id=other_barrier['entity']['id'])]
        for proposed in cases:
            with self.subTest(proposed=proposed), self.assertRaises(ValidationError):
                self.apply(proposed)
            self.assertEqual(self.state(), before)

    def test_stale_library_invalid_shape_and_reused_ids_do_not_partially_create(self):
        proposed = self.proposal(); self.fixture.change_library_description(); before = deepcopy(self.state())
        with self.assertRaisesRegex(ValidationError, 'metadata changed'):
            self.apply(proposed)
        self.assertEqual(self.state(), before)
        self.library = self.fixture.library.takeoff_record('pkb-001')
        for change in ({'accept_mismatch': 1}, {'selected_ids': []}, {'defect_revision': 10**400}, {'scope': 'service_plans'}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                self.apply(self.proposal(**change))
            self.assertEqual(self.state(), before)
        proposed = self.proposal(); proposed['ids']['service'] = self.defect['entity']['id']
        with self.assertRaises(ValidationError):
            self.apply(proposed)
        self.assertEqual(self.state(), before)

    def test_atomic_import_undo_and_portable_project_retain_provenance_and_sources(self):
        before = deepcopy(self.state()); proposed = self.proposal(); imported = self.apply(proposed)[0]['snapshot']
        undone = self.service.command(self.sid, {'op': 'undo', 'expected_revision': imported['revision'], 'request_id': str(uuid4())})['snapshot']
        self.assertEqual(undone['physical']['defects'], before['physical']['defects'])
        self.assertTrue(undone['physical']['barriers'][0]['deleted']); self.assertTrue(undone['physical']['services'][0]['deleted'])
        record = undone['library_assignments']['records'][0]
        self.assertEqual(record['id'], proposed['ids']['assignment']); self.assertEqual(record['state'], 'needs_recheck')
        self.assertEqual(record['barrier_selection'], imported['library_assignments']['records'][0]['barrier_selection'])
        self.fixture.case.library.save_as({**deepcopy(self.fixture.case.base), 'takeoffs': undone,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.fixture.draft)}})
        saved = json.loads(self.fixture.case.target.read_text(encoding='utf-8'))
        self.assertEqual(saved['takeoffs']['library_assignments'], undone['library_assignments'])
        self.fixture.case.dialogs.opened = str(self.fixture.case.target)
        reopened = self.fixture.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['library_assignments'], undone['library_assignments'])
        self.assertEqual(reopened['takeoffs']['physical']['defects'][0]['annotation'], before['physical']['defects'][0]['annotation'])

    def test_old_assignment_shape_compatible_and_forged_import_history_rejected(self):
        identifier, _, _ = self.fixture.assignment([self.defect['entity']['id']])
        validate_assignments(self.state())
        self.assertNotIn('barrier_selection', self.fixture.record(identifier))
        imported = self.apply(self.proposal())[0]['snapshot']
        event = self.fixture.case.documents.get_blob(imported['audit_head'])
        forged = deepcopy(event); forged['after']['physical']['defects'][0]['fields']['notes'] = 'Overwrite original'
        with self.assertRaisesRegex(ValidationError, 'cannot change retained'):
            validate_history(forged)
        forged = deepcopy(event); forged['after']['library_assignments']['records'][-1]['barrier_selection']['mismatch_accepted'] = True
        with self.assertRaises(ValidationError):
            validate_history(forged)

    def test_blank_seal_existing_barrier_only_association_undo_rejects_without_receipt(self):
        edit = self.fixture.library.edit('pkb-001'); draft = deepcopy(edit['draft'])
        draft['rows'][0]['inputs']['K'] = 'Blank Seal'
        self.fixture.library.action('pkb-001', 'save', {'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})
        self.library = self.fixture.library.takeoff_record('pkb-001')
        self.assertIsNone(self.library['import_fields']['service'])
        barrier = self.barrier(**self.library['import_fields']['barrier']); before = deepcopy(self.state())
        imported = self.apply(self.proposal(barrier))[0]['snapshot']
        self.assertEqual(imported['physical'], before['physical'])
        self.assertEqual(len(imported['library_assignments']['records']), 1)
        with self.assertRaisesRegex(ValidationError, 'cannot be reversed by Takeoff-only Undo'):
            self.service.command(self.sid, {'op': 'undo', 'expected_revision': imported['revision'], 'request_id': str(uuid4())})
        self.assertEqual(self.state(), imported)

    def test_commercial_confirmation_cannot_rewrite_original_barrier_review(self):
        imported = self.apply(self.proposal())[0]['snapshot']
        identifier = imported['library_assignments']['records'][0]['id']
        confirmed = self.fixture.confirm(identifier, 1)['snapshot']
        event = self.fixture.case.documents.get_blob(confirmed['audit_head'])
        self.assertEqual(event['op'], 'apply_library_link')
        validate_history(event)
        forged = deepcopy(event)
        selection = forged['after']['library_assignments']['records'][0]['barrier_selection']
        selection['source_fields']['substrate'] = 'Forged later review'
        selection['retained_fields']['substrate'] = 'Forged later review'
        validate_assignments(forged['after'])  # Internally consistent but historically false.
        with self.assertRaisesRegex(ValidationError, 'original explicit barrier selection'):
            validate_history(forged)

    def test_pdf_inherited_label_combines_only_requested_parent_and_preserves_negative_controls(self):
        proposed = self.proposal(); imported = self.apply(proposed)[0]['snapshot']; before = deepcopy(imported)
        defect = imported['physical']['defects'][0]; barrier = imported['physical']['barriers'][0]
        self.assertEqual(inherited_library_barrier_parent(imported, imported['physical'], barrier), defect['id'])

        def rows(snapshot, identifiers):
            request = {'expected_revision': snapshot['revision'], 'mode': 'penetrations',
                'physical_scope': 'defect_reports', 'document_id': defect['annotation']['document_id'], 'item_ids': identifiers}
            with patch('estimator.takeoff_markup_pdf.export_marked_pdf', return_value=(b'pdf', 'application/pdf', 'draft.pdf')) as export:
                export_physical_pdf(snapshot, request, self.fixture.case.documents)
            return export.call_args.kwargs['physical_rows']

        combined = rows(imported, [barrier['id'], defect['id']])
        self.assertEqual([value['id'] for value in combined], [defect['id']])
        self.assertEqual(combined[0]['geometry']['points'], [defect['annotation']['point']])
        self.assertTrue(any(barrier['display_id'] in value for value in combined[0]['physical_summary']))
        self.assertTrue(any(imported['physical']['services'][0]['display_id'] in value for value in combined[0]['physical_summary']))
        self.assertEqual([value['id'] for value in rows(imported, [barrier['id']])], [barrier['id']])
        self.assertEqual(imported, before)

        moved = deepcopy(barrier['marker']); moved['point'][0] += 1.123456789
        self.fixture.physical([{'op': 'update', 'entity_id': barrier['id'], 'changes': {'marker': moved}}])
        moved_snapshot = self.state(); moved_barrier = moved_snapshot['physical']['barriers'][0]
        self.assertIsNone(inherited_library_barrier_parent(moved_snapshot, moved_snapshot['physical'], moved_barrier))
        self.assertEqual(len(rows(moved_snapshot, [barrier['id'], defect['id']])), 2)
        explicit = deepcopy(imported); explicit['library_assignments']['records'][0].pop('barrier_selection')
        self.assertEqual(len(rows(explicit, [barrier['id'], defect['id']])), 2)


if __name__ == '__main__':
    unittest.main()
