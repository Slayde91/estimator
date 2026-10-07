"""Legacy draft-only Item QTY/Location retain their original saved semantics.

Every database, selected library, source PDF and portable project is disposable.
These regressions exercise real workspace transactions and audit validation.
"""
from copy import deepcopy
from decimal import Decimal
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_library_links import validate_assignments, validate_history
from estimator.takeoff_physical_markers import service_summary
from tests import test_takeoff_library_barrier_import as import_fixtures
from tests.test_takeoff_physical_v2 import create


class LibraryDraftDetailsTests(unittest.TestCase):
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

    @staticmethod
    def record(snapshot, identifier=None):
        records = snapshot['library_assignments']['records']
        return next(value for value in records if value['id'] == identifier) if identifier else records[-1]

    def import_item(self, barrier=None, **details):
        return self.case.apply(self.case.proposal(barrier, **details))[0]

    def blank_seal(self):
        edit = self.links.library.edit('pkb-001')
        draft = deepcopy(edit['draft'])
        draft['rows'][0]['inputs']['K'] = 'Blank Seal'
        self.links.library.action('pkb-001', 'save', {
            'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})
        self.case.library = self.links.library.takeoff_record('pkb-001')
        self.assertIsNone(self.case.library['import_fields']['service'])

    def direct_request(self, member, scope='defect_reports', **details):
        selected = self.links.library.takeoff_record('pkb-001')
        return {'op': 'draft_library_assignment', 'request_id': str(uuid4()),
                'expected_revision': self.state()['revision'], 'assignment': {
                    'id': str(uuid4()), 'scope': scope, 'library_id': selected['id'],
                    'library_fingerprint': selected['metadata_sha256'], 'member_ids': [member],
                    'installation': {'id': str(uuid4()), 'mode': 'repeated_installations', 'note': ''},
                    **details}}

    def assert_source_and_schedule_unchanged(self, before, stored):
        after = self.state()
        for key in ('documents', 'items', 'calibrations', 'transfers', 'render_checks'):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(self.links.calculator_storage(), stored)
        self.assertEqual(self.links.draft, {'globals': {'J': 'No'}, 'rows': []})
        self.links.assert_source_unchanged()

    def test_decimal_item_quantity_and_location_create_only_unconfirmed_service_draft(self):
        before = deepcopy(self.state())
        stored = self.links.calculator_storage()
        location = 'Level 02 / east riser\nAbove ceiling'
        after = self.import_item(draft_quantity=2.750000000123, draft_location=location)['snapshot']
        record = self.record(after)
        self.assertEqual(record['draft_quantity'], 2.750000000123)
        self.assertEqual(record['draft_location'], location)
        self.assertEqual(record['state'], 'draft')
        self.assertIsNone(record['confirmation'])
        self.assertIsNone(record['schedule_binding'])
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['barriers'][0]['fields']['location'], location)
        service = after['physical']['services'][0]
        self.assertIsNone(service['quantity'])
        self.assertEqual(service['library_quantity']['state'], 'unknown')
        self.assertIn('Quantity unknown', service_summary(service))
        for entity in (after['physical']['barriers'][0], service):
            self.assertEqual(entity['uncertainty']['state'], 'human_review_required')
        self.assert_source_and_schedule_unchanged(before, stored)
        validate_assignments(after)

    def test_blank_seal_draft_quantity_does_not_create_service_or_physical_multiplier(self):
        self.blank_seal()
        before = deepcopy(self.state())
        stored = self.links.calculator_storage()
        after = self.import_item(draft_quantity=.375, draft_location='Blank opening L3')['snapshot']
        record = self.record(after)
        self.assertEqual(record['draft_quantity'], .375)
        self.assertEqual(record['draft_location'], 'Blank opening L3')
        self.assertEqual(len(after['physical']['barriers']), 1)
        self.assertEqual(after['physical']['services'], [])
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertIsNone(record['confirmation'])
        self.assertIsNone(record['schedule_binding'])
        self.assert_source_and_schedule_unchanged(before, stored)

    def test_existing_barrier_import_preserves_every_old_identity_field_quantity_and_source(self):
        barrier = self.case.barrier(**{**self.case.library['import_fields']['barrier'],
                                      'location': 'Original barrier location', 'notes': 'Retain exact manual words'})
        marker = deepcopy(self.state()['physical']['defects'][0]['annotation'])
        marker['point'] = [141.123456789012, 321.987654321098]
        original = create('service', barrier['id'], service='Retained manual service', diameter_mm=123.456789012,
                          notes='Original service values')
        original['entity']['quantity'] = 17
        self.links.physical([{'op': 'update', 'entity_id': barrier['id'], 'changes': {'marker': marker}}, original])
        barrier = next(value for value in self.state()['physical']['barriers'] if value['id'] == barrier['id'])
        before = deepcopy(self.state())
        stored = self.links.calculator_storage()
        proposed = self.case.proposal(barrier, draft_quantity=3.125, draft_location='Item-only new location')
        proposed['selected_ids'] = [original['entity']['id']]
        after = self.case.apply(proposed)[0]['snapshot']
        for collection in ('defects', 'barriers', 'services'):
            retained = {value['id']: value for value in after['physical'][collection]}
            for old in before['physical'][collection]:
                self.assertEqual(retained[old['id']], old)
        self.assertEqual(len(after['physical']['services']), 2)
        self.assertIsNone(after['physical']['services'][-1]['quantity'])
        record = self.record(after)
        self.assertEqual(record['draft_quantity'], 3.125)
        self.assertEqual(record['draft_location'], 'Item-only new location')
        self.assertEqual(record['barrier_selection']['retained_fields'],
                         {key: barrier['fields'][key] for key in ('barrier_type', 'substrate', 'orientation')})
        self.assert_source_and_schedule_unchanged(before, stored)

    def test_existing_blank_seal_records_item_details_without_rewriting_physical_graph(self):
        self.blank_seal()
        barrier = self.case.barrier(**self.case.library['import_fields']['barrier'], location='Keep this location')
        before = deepcopy(self.state())
        stored = self.links.calculator_storage()
        after = self.import_item(barrier, draft_quantity=4.875, draft_location='Specific commercial item location')['snapshot']
        self.assertEqual(after['physical'], before['physical'])
        self.assertEqual(self.record(after)['draft_quantity'], 4.875)
        self.assertEqual(self.record(after)['draft_location'], 'Specific commercial item location')
        self.assertIsNone(self.record(after)['schedule_binding'])
        self.assert_source_and_schedule_unchanged(before, stored)

    def test_existing_defect_location_is_not_overwritten_or_shadowed_by_new_item_location(self):
        defect_id = self.case.defect['entity']['id']
        self.links.physical([{'op': 'update', 'entity_id': defect_id,
                              'changes': {'fields': {'location': 'Retained Defect location'}}}])
        before = deepcopy(self.state())
        after = self.import_item(draft_quantity=1.25, draft_location='Separate item location')['snapshot']
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertNotIn('location', after['physical']['barriers'][0]['fields'])
        self.assertEqual(self.record(after)['draft_location'], 'Separate item location')

    def test_direct_assignments_retain_optional_details_without_changing_either_physical_scope(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                member = self.links.member(scope)
                before = deepcopy(self.state())
                request = self.direct_request(member, scope, draft_quantity=2.375, draft_location='Direct chosen item location')
                after = self.service.command(self.sid, request)['snapshot']
                self.assertEqual(after['physical'], before['physical'])
                self.assertEqual(after.get('service_plans'), before.get('service_plans'))
                record = self.record(after, request['assignment']['id'])
                self.assertEqual((record['draft_quantity'], record['draft_location']), (2.375, 'Direct chosen item location'))
                self.assertEqual(record['state'], 'draft')
                self.assertIsNone(record['confirmation'])
                self.assertIsNone(record['schedule_binding'])

    def test_absent_legacy_details_remain_absent_without_default_backfill(self):
        identifier, result, _ = self.links.assignment([self.case.defect['entity']['id']])
        record = self.record(result['snapshot'], identifier)
        for key in ('draft_quantity', 'draft_location'):
            self.assertNotIn(key, record)
        validate_assignments(result['snapshot'])
        before = deepcopy(self.state())
        after = self.import_item()['snapshot']
        for value in after['library_assignments']['records']:
            for key in ('draft_quantity', 'draft_location'):
                self.assertNotIn(key, value)
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['barriers'][0]['fields'], self.case.library['import_fields']['barrier'])
        self.assertIsNone(after['physical']['services'][0]['quantity'])

    def test_invalid_quantity_type_range_or_location_never_partially_imports(self):
        before = deepcopy(self.state())
        stored = self.links.calculator_storage()
        invalid = [
            *({'draft_quantity': value} for value in
              (True, False, None, 0, -.125, float('inf'), float('-inf'), float('nan'),
               10**12 + 1, 10**400, '2.75', Decimal('2.75'), {}, [])),
            *({'draft_location': value} for value in (None, True, 42, .5, {}, [], 'x' * 2001, 'bad\0location', '\x1f')),
            {'location': 'Unsupported request key'}, {'item_quantity_extra': 2}, {'draft_location_extra': 'Unsupported request key'},
        ]
        for details in invalid:
            with self.subTest(details=details), self.assertRaises(ValidationError):
                self.import_item(**details)
            self.assertEqual(self.state(), before)
        self.assert_source_and_schedule_unchanged(before, stored)

    def test_direct_invalid_details_and_forged_record_keys_are_rejected(self):
        member = self.case.defect['entity']['id']
        before = deepcopy(self.state())
        for details in ({'draft_quantity': True}, {'draft_quantity': '1.5'}, {'draft_location': {}},
                        {'draft_location': 'x' * 2001}, {'location': 'Unsupported assignment key'}):
            with self.subTest(details=details), self.assertRaises(ValidationError):
                self.service.command(self.sid, self.direct_request(member, **details))
            self.assertEqual(self.state(), before)
        after = self.import_item(draft_quantity=2.5, draft_location='Literal location')['snapshot']
        for details in ({'draft_quantity': 0}, {'draft_location': None}, {'location': 'Unsupported retained key'}):
            forged = deepcopy(after)
            self.record(forged).update(details)
            with self.subTest(details=details), self.assertRaises(ValidationError):
                validate_assignments(forged)

    def test_optional_detail_boundaries_accept_finite_limit_and_literal_blank(self):
        after = self.import_item(draft_quantity=10**12, draft_location='')['snapshot']
        self.assertEqual(self.record(after)['draft_quantity'], 10**12)
        self.assertEqual(self.record(after)['draft_location'], '')
        self.assertNotIn('location', after['physical']['barriers'][0]['fields'])
        barrier = after['physical']['barriers'][0]
        text = 'L' * 2000
        after = self.import_item(barrier, draft_quantity=1e-9, draft_location=text)['snapshot']
        self.assertEqual(self.record(after)['draft_location'], text)
        self.assertEqual(self.record(after)['draft_quantity'], 1e-9)

    def test_failed_audit_validation_leaves_no_active_import_or_schedule_change_and_retry_succeeds(self):
        before = deepcopy(self.state())
        stored = self.links.calculator_storage()
        proposed = self.case.proposal(draft_quantity=7.125, draft_location='Never partially imported')
        validate = self.links.case.documents.validate_audit
        rejected = []

        def reject_prospective_import(snapshot, **options):
            if (snapshot['revision'] == before['revision'] + 1
                    and any(value['id'] == proposed['ids']['assignment']
                            for value in snapshot.get('library_assignments', {}).get('records', []))):
                rejected.append(deepcopy(snapshot))
                raise ValidationError('Injected audit rejection')
            return validate(snapshot, **options)

        with patch.object(self.links.case.documents, 'validate_audit', side_effect=reject_prospective_import):
            with self.assertRaisesRegex(ValidationError, 'Injected audit rejection'):
                self.case.apply(proposed)
        self.assertEqual(len(rejected), 1, 'Reject the prepared audit at commit, not a preflight source check')
        self.assertEqual(self.state(), before)
        self.assert_source_and_schedule_unchanged(before, stored)
        # The rejected immutable audit blob may remain unreferenced; it has no
        # session/physical/schedule authority and must not prevent a valid retry.
        after = self.case.apply(proposed)[0]['snapshot']
        self.assertEqual(self.record(after)['id'], proposed['ids']['assignment'])
        self.assertEqual(len(after['physical']['services']), 1)

    def test_undo_and_portable_reopen_preserve_entered_details_provenance_and_increasing_versions(self):
        before = deepcopy(self.state())
        imported = self.import_item(draft_quantity=6.125, draft_location='Retain on Undo and reopen')['snapshot']
        original = deepcopy(self.record(imported))
        event = self.links.case.documents.get_blob(imported['audit_head'])
        self.assertEqual(event['op'], 'import_library_item')
        self.assertEqual(self.record(event['after']), original)
        validate_history(event)
        undone = self.service.command(self.sid, {'op': 'undo', 'expected_revision': imported['revision'],
                                                  'request_id': str(uuid4())})['snapshot']
        record = self.record(undone, original['id'])
        for key in ('id', 'installation', 'library', 'draft_quantity', 'draft_location', 'barrier_selection'):
            self.assertEqual(record[key], original[key], key)
        self.assertGreater(record['version'], original['version'])
        self.assertEqual(record['state'], 'needs_recheck')
        self.assertTrue(undone['physical']['barriers'][0]['deleted'])
        self.assertTrue(undone['physical']['services'][0]['deleted'])
        self.assertEqual(undone['physical']['defects'], before['physical']['defects'])
        self.links.case.documents.validate_audit(undone, owner=self.sid)
        self.links.case.library.save_as({**deepcopy(self.links.case.base), 'takeoffs': undone,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.links.draft)}})
        payload = self.links.case.target.read_bytes()
        saved = json.loads(payload)
        self.assertEqual(saved['takeoffs']['library_assignments'], undone['library_assignments'])
        self.service.close(self.sid)
        self.links.case.dialogs.opened = str(self.links.case.target)
        reopened = self.links.case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['library_assignments'], undone['library_assignments'])
        self.assertEqual(reopened['takeoffs']['physical']['defects'][0]['annotation'], before['physical']['defects'][0]['annotation'])
        self.links.case.documents.validate_audit(reopened['takeoffs'], owner=reopened['takeoffs_session_id'])
        self.assertEqual(self.links.case.target.read_bytes(), payload)
        companion = self.links.case.root / saved['takeoffs']['companion_folder']
        self.assertTrue(any(path.read_bytes() == self.links.case.pdf for path in companion.rglob('*.pdf')))
        self.links.assert_source_unchanged()

    def test_preview_requires_explicit_quantity_and_draft_default_never_approves_or_updates_automatically(self):
        imported = self.import_item(draft_quantity=2.750000000123, draft_location='User-entered item location')['snapshot']
        record = self.record(imported)
        self.links.draft = {'globals': {'J': 'No'}, 'rows': [{'id': 'manual-row', 'library_item_id': 'pkb-001',
            'inputs': {'O': 10.125, 'AI': 50.123456789012, 'AJ': 100.987654321098, 'T': 'Retain manual schedule details'}}]}
        manual = deepcopy(self.links.draft)
        physical = deepcopy(imported['physical'])
        request = {'expected_revision': imported['revision'], 'assignment_id': record['id'],
                   'draft': deepcopy(manual), 'configuration': {}}
        with self.assertRaises(ValidationError):
            self.service.preview_library_link(self.sid, request)
        preview = self.links.preview(record['id'], record['draft_quantity'])
        self.assertEqual(preview['change']['confirmed_contribution'], record['draft_quantity'])
        self.assertEqual(self.state(), imported)
        self.assertEqual(self.links.draft, manual)
        confirmed = self.links.apply(preview)[0]['snapshot']
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 12.875000000123)
        for key in ('AI', 'AJ', 'T'):
            self.assertEqual(self.links.draft['rows'][0]['inputs'][key], manual['rows'][0]['inputs'][key])
        self.assertEqual(confirmed['physical'], physical)
        self.assertIsNone(confirmed['physical']['services'][0]['quantity'])
        self.assertEqual(self.record(confirmed)['draft_quantity'], record['draft_quantity'])
        override = self.links.preview(record['id'], 4.375)
        self.assertEqual(override['change']['confirmed_contribution'], 4.375)
        self.assertEqual(self.state(), confirmed)
        reconfirmed = self.links.apply(override)[0]['snapshot']
        self.assertEqual(self.links.draft['rows'][0]['inputs']['O'], 14.5)
        self.assertEqual(self.record(reconfirmed)['draft_quantity'], record['draft_quantity'])
        self.assertEqual(self.record(reconfirmed)['confirmation']['quantity'], 4.375)
        self.assertEqual(reconfirmed['physical'], physical)

    def test_later_audit_cannot_rewrite_original_entered_details_or_reuse_assignment_version(self):
        imported = self.import_item(draft_quantity=2.75, draft_location='Originally entered location')['snapshot']
        original = deepcopy(self.record(imported))
        confirmed = self.links.confirm(original['id'], 3.125)['snapshot']
        record = self.record(confirmed)
        self.assertGreater(record['version'], original['version'])
        self.assertEqual(record['draft_quantity'], original['draft_quantity'])
        self.assertEqual(record['draft_location'], original['draft_location'])
        event = self.links.case.documents.get_blob(confirmed['audit_head'])
        validate_history(event)
        for key, value in (('draft_quantity', 99.25), ('draft_location', 'Forged later location')):
            forged = deepcopy(event)
            self.record(forged['after'])[key] = value
            validate_assignments(forged['after'])
            with self.subTest(key=key), self.assertRaisesRegex(ValidationError, 'originally entered draft'):
                validate_history(forged)
        forged = deepcopy(event)
        self.record(forged['after'])['version'] = original['version']
        with self.assertRaisesRegex(ValidationError, 'increasing retained version'):
            validate_history(forged)


if __name__ == '__main__':
    unittest.main()
