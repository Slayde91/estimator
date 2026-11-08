"""PO approvals, signature evidence and optional delivery times survive old editors."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.commercial_documents import (CommercialConflict, CommercialDocuments,
    default_fields, validate_fields)
from estimator.commercial_http import CommercialHTTP
from tests.test_commercial_documents import Projects


INK = {'version': 1, 'ratio': 3, 'strokes': [[[0, 0], [.5, 1], [1, 0]]]}
SIGNERS = {'requested_by': 'requested_date', 'reviewed_by': 'review_date',
           'sent_by': 'sent_date', 'verified_by': 'verified_date'}


class PurchaseOrderSignatureDeliveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.projects = Projects(Path(temporary.name))
        self.workspace = self.projects.add()
        self.store = CommercialDocuments(self.projects, renderer=lambda *_args, **_kwargs: b'%PDF-1.4 frozen PO fixture')

    @staticmethod
    def payload(document):
        return {key: deepcopy(document[key]) for key in ('id', 'version', 'kind', 'status', 'fields')}

    def save(self, fields, previous=None, workspace=None):
        payload = self.payload(previous) if previous else {'kind': 'purchase_order', 'status': 'Draft'}
        return self.store.save(workspace or self.workspace, {**payload, 'fields': deepcopy(fields)})

    def test_four_signatures_round_trip_and_clear_without_rewriting_issued_evidence(self):
        fields = default_fields('purchase_order')
        fields['signatures'] = {key: deepcopy(INK) for key in SIGNERS}
        for index, (name, date) in enumerate(SIGNERS.items(), 1):
            fields['order'].update({name: f'Person {index}', date: f'2026-11-{index:02d}'})
        fields['order'].update(delivery_date='2026-11-21', delivery_time='14:35', approval='Rejected',
                               rejection_reason='Damaged specification', ship_to_address='Manual receiving depot')
        purchase = self.save(fields)
        operation = str(uuid4())
        issued_version = purchase['version']
        issued = self.store.issue(self.workspace, purchase['id'], issued_version, operation)
        purchase = issued['document']
        snapshot = self.store.capture(self.workspace)
        original = deepcopy(snapshot)
        restored_workspace = self.projects.add(snapshot['project_id'])
        self.store.restore(restored_workspace, snapshot)
        restored = next(row for row in self.store.view(restored_workspace)['documents'] if row['id'] == purchase['id'])
        self.assertEqual(restored['fields'], purchase['fields'])
        self.assertEqual(snapshot, original)
        self.assertEqual(self.store.read_pdf(restored_workspace, issued['id'])[1], issued['pdf'])

        cleared = deepcopy(restored['fields'])
        cleared['signatures'] = {}
        for name, date in SIGNERS.items():
            cleared['order'].update({name: '', date: ''})
        changed = self.save(cleared, restored, restored_workspace)
        self.assertNotIn('signatures', changed['fields'])
        for name, date in SIGNERS.items():
            self.assertEqual(changed['fields']['order'][name], '')
            self.assertEqual(changed['fields']['order'][date], '')
        with self.assertRaises(CommercialConflict):
            self.save(cleared, restored, restored_workspace)
        self.assertEqual(self.store.read_pdf(restored_workspace, issued['id'])[1], issued['pdf'])
        self.assertEqual(self.store.issue(self.workspace, purchase['id'], issued_version, operation)['pdf'], issued['pdf'])

    def test_old_editor_omissions_preserve_new_fields_and_ink_but_explicit_blanks_clear(self):
        fields = default_fields('purchase_order')
        fields['order'].update(delivery_date='2026-11-21', delivery_time='09:05',
                               rejection_reason='Historic decision note', site_contact_number='0400 000 000')
        fields['signatures'] = {'requested_by': deepcopy(INK)}
        fields['order'].update(requested_by='Request person', requested_date='2026-11-09')
        saved = self.save(fields)
        old_fields = deepcopy(saved['fields'])
        old_fields.pop('signatures')
        for key in ('delivery_time', 'rejection_reason', 'site_contact_number'):
            old_fields['order'].pop(key)
        old_fields['title'] = 'Unrelated older-window edit'
        preserved = self.save(old_fields, saved)
        for key in ('delivery_time', 'rejection_reason', 'site_contact_number'):
            self.assertEqual(preserved['fields']['order'][key], saved['fields']['order'][key])
        self.assertEqual(preserved['fields']['signatures'], saved['fields']['signatures'])
        clear_fields = deepcopy(preserved['fields'])
        clear_fields['signatures'] = {}
        for key in ('delivery_time', 'rejection_reason', 'site_contact_number'):
            clear_fields['order'][key] = ''
        cleared = self.save(clear_fields, preserved)
        self.assertNotIn('signatures', cleared['fields'])
        for key in ('delivery_time', 'rejection_reason', 'site_contact_number'):
            self.assertEqual(cleared['fields']['order'][key], '')

    def test_signature_kinds_and_vector_values_are_validated(self):
        for kind, forbidden in (('purchase_order', 'prepared_by'), ('purchase_order', 'claimed_by'),
                                ('work_order', 'requested_by'), ('work_order', 'sent_by'),
                                ('quote', 'reviewed_by')):
            with self.subTest(kind=kind, key=forbidden), self.assertRaises(ValidationError):
                fields = default_fields(kind)
                fields['signatures'] = {forbidden: deepcopy(INK)}
                validate_fields(fields, kind=kind)
        for invalid in ([], 'signature', {'requested_by': True},
                        {'requested_by': {**INK, 'strokes': [[[2, 0]]]}}):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                fields = default_fields('purchase_order')
                fields['signatures'] = invalid
                validate_fields(fields, kind='purchase_order')
        fields = default_fields('work_order')
        fields['signatures'] = {key: deepcopy(INK) for key in ('reviewed_by', 'prepared_by', 'client_approved_by', 'closed_by', 'claimed_by')}
        self.assertEqual(validate_fields(fields, kind='work_order')['signatures'], fields['signatures'])

    def test_delivery_time_is_local_minute_precision_and_legacy_date_remains_date_only(self):
        fields = default_fields('purchase_order')
        fields['order']['delivery_date'] = '2026-11-21'
        fields['order'].pop('delivery_time')
        saved = self.save(fields)
        snapshot = self.store.capture(self.workspace)
        target = self.projects.add(snapshot['project_id'])
        self.store.restore(target, snapshot)
        restored = next(row for row in self.store.view(target)['documents'] if row['id'] == saved['id'])
        self.assertNotIn('delivery_time', restored['fields']['order'])
        self.assertEqual(restored['fields']['order']['delivery_date'], '2026-11-21')
        for valid in ('', '00:00', '09:05', '23:59'):
            fields['order']['delivery_time'] = valid
            self.assertEqual(validate_fields(fields, kind='purchase_order')['order']['delivery_time'], valid)
        for invalid in ('24:00', '23:60', '9:05', '12:30:00', '12:00Z', ' 12:00', 1200, True, None, []):
            with self.subTest(time=invalid), self.assertRaises(ValidationError):
                fields['order']['delivery_time'] = invalid
                validate_fields(fields, kind='purchase_order')
        for kind in ('work_order', 'quote'):
            with self.subTest(kind=kind), self.assertRaises(ValidationError):
                invalid_fields = default_fields(kind)
                invalid_fields['order']['delivery_time'] = '09:00'
                validate_fields(invalid_fields, kind=kind)

    def test_approval_choices_preserve_legacy_decisions_and_do_not_require_a_reason(self):
        fields = default_fields('purchase_order')
        fields['order']['approval'] = 'Rejected'
        saved = self.save(fields)
        self.assertEqual(saved['fields']['order']['rejection_reason'], '')
        snapshot = self.store.capture(self.workspace)
        snapshot['documents'][0]['fields']['order']['approval'] = 'Denied under previous process'
        snapshot['documents'][0]['fields']['order']['ship_to_address'] = ''
        target = self.projects.add(snapshot['project_id'])
        self.store.restore(target, snapshot)
        legacy = self.store.view(target)['documents'][0]
        retained_fields = deepcopy(legacy['fields'])
        retained_fields['title'] = 'Unrelated edit'
        retained = self.save(retained_fields, legacy, target)
        self.assertEqual(retained['fields']['order']['approval'], 'Denied under previous process')
        self.assertEqual(retained['fields']['order']['ship_to_address'], '')
        retained_fields['order']['approval'] = 'Approved'
        approved = self.save(retained_fields, retained, target)
        self.assertEqual(approved['fields']['order']['approval'], 'Approved')
        retained_fields['order']['approval'] = 'Another unsupported value'
        with self.assertRaises(ValidationError):
            self.save(retained_fields, approved, target)
        for invalid in ('x' * 1001, True, None, []):
            with self.subTest(reason=invalid), self.assertRaises(ValidationError):
                fields['order']['rejection_reason'] = invalid
                validate_fields(fields, kind='purchase_order')

    def test_new_direct_defaults_use_project_site_and_manual_shipping_survives_saves(self):
        http = CommercialHTTP(self.store)
        project = {'project_no': 'PN-01', 'client': 'Client', 'site_address': 'Canonical Project site',
                   'contact_name': '', 'contact_phone': '', 'contact_email': ''}
        body = {'workspace_id': self.workspace, 'kind': 'purchase_order',
                'details': {'site_address': 'Stale document address'}, 'project_details': project}
        before = deepcopy(body)
        fields = http.execute('defaults', body)['fields']
        self.assertEqual(fields['order']['ship_to_address'], 'Canonical Project site')
        self.assertEqual(body, before)
        fields['order']['ship_to_address'] = 'Manual supplier receiving address'
        saved = self.save(fields)
        changed_fields = deepcopy(saved['fields'])
        changed_fields['details']['site_address'] = 'Updated Project site'
        changed = self.save(changed_fields, saved)
        self.assertEqual(changed['fields']['order']['ship_to_address'], 'Manual supplier receiving address')
        changed_fields['order']['ship_to_address'] = ''
        cleared = self.save(changed_fields, changed)
        self.assertEqual(cleared['fields']['order']['ship_to_address'], '')


if __name__ == '__main__':
    unittest.main()
