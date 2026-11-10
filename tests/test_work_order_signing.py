"""Signing events advance exactly once without rewriting old ink or issued PDFs."""
from copy import deepcopy
from io import BytesIO
import json
import unittest
from uuid import uuid4
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, default_fields, validate_fields
from estimator.work_order_signing import STEPS, actions
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from tests.commercial_ready_fixtures import complete_work_order
from tests import test_work_order_tracking as tracking_fixtures
from tests.test_work_order_tracking import INK


class WorkOrderSigningTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tracking_fixtures.WorkOrderTrackingTests('test_all_issued_rows_have_stable_unique_ids_and_ignore_changed_quote_draft')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store, self.workspace = self.fixture.store, self.fixture.workspace
        self.fields = complete_work_order(self.fixture.fields(), 'Completed')

    def payload(self, fields=None, previous=None, signed=None, identity=None):
        result = {'id': previous['id'] if previous else identity or str(uuid4()),
                  'version': previous['version'] if previous else 0, 'kind':'work_order',
                  'status': previous['status'] if previous else 'Draft', 'fields':deepcopy(fields or self.fields)}
        if signed is not None:
            result['signature_actions'] = signed
        return result

    def action(self, fields, key):
        result = {'key':key,'signature':deepcopy(INK),'name':fields['order'][key],
                  'date':fields['order'][STEPS[key][0]]}
        if key == 'closed_by':
            result.update(completion=fields['order']['completion'],certification=fields['order']['certification'])
        return result

    def audit(self, identity):
        with self.store._connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM commercial_audit WHERE workspace=? AND document_id=? ORDER BY sequence',
                                                    (self.workspace,identity))]

    def test_each_deliberate_signature_advances_its_outgoing_stage_even_when_ink_is_reused(self):
        document = self.store.save(self.workspace,self.payload())
        self.assertEqual(document['status'],'Draft')
        for key, expected in [('details_by','Review'),('reviewed_by','OHS Docs'),('prepared_by','Client Approval'),
                              ('client_approved_by','In progress'),('progress_by','Claim'),('claimed_by','Certify'),('closed_by','Completed')]:
            with self.subTest(key=key):
                fields = deepcopy(document['fields'])
                document = self.store.save(self.workspace,self.payload(fields,document,[self.action(fields,key)]))
                self.assertEqual(document['status'],expected)
                self.assertEqual(document['fields']['signatures'][key],INK)
                event = self.audit(document['id'])[-1]
                self.assertEqual(event['action'],'signatures')
                self.assertEqual(json.loads(event['after_data'])['actions'][0]['key'],key)
        self.assertEqual(len([row for row in self.audit(document['id']) if row['action']=='signatures']),7)

    def test_loading_saving_or_editing_old_names_dates_and_ink_is_not_a_signing_action(self):
        document = self.store.save(self.workspace,self.payload())
        fields = deepcopy(document['fields'])
        fields['order'].update(reviewed_by='Edited name only',review_date='2026-11-10')
        document = self.store.save(self.workspace,self.payload(fields,document))
        self.assertEqual(document['status'],'Draft')
        snapshot = self.store.capture(self.workspace)
        target = self.fixture.projects.add(snapshot['project_id'])
        self.store.restore(target,snapshot)
        self.assertEqual(self.store.view(target)['documents'][-1]['status'],'Draft')
        self.assertFalse(any(row['action']=='signatures' for row in self.audit(document['id'])))

    def test_review_signing_keeps_the_explicit_approval_choice(self):
        fields=deepcopy(self.fields);fields['order']['approval']='Denied'
        document=self.store.save(self.workspace,self.payload(fields,signed=[self.action(fields,'reviewed_by')]))
        self.assertEqual(document['status'],'OHS Docs')
        self.assertEqual(document['fields']['order']['approval'],'Denied')

    def test_other_existing_completion_choices_are_not_cleared_or_reinterpreted(self):
        for choice in ('On hold','Not completed'):
            with self.subTest(choice=choice):
                fields=deepcopy(self.fields);fields['order']['completion']=choice
                document=self.store.save(self.workspace,self.payload(fields,signed=[self.action(fields,'closed_by')]))
                self.assertEqual(document['status'],'Draft')
                self.assertEqual(document['fields']['order']['completion'],choice)
                self.assertEqual(document['fields']['signatures']['closed_by'],INK)

    def test_ongoing_closure_clears_only_cycle_signoffs_and_completion_and_retains_receipt_and_quantities(self):
        document = self.store.save(self.workspace,self.payload())
        issued = self.store.issue(self.workspace,document['id'],document['version'],str(uuid4()))
        document = issued['document']
        fields = deepcopy(document['fields'])
        fields['order']['completion'] = 'Ongoing'
        before_tracking = deepcopy(fields['work_tracking'])
        before_order = deepcopy(fields['order'])
        event = self.action(fields,'closed_by')
        document = self.store.save(self.workspace,self.payload(fields,document,[event]))
        self.assertEqual(document['status'],'In progress')
        for key in ('certification','completion','closed_by','closed_date','progress_by','progress_date','claimed_by','claim_date'):
            self.assertEqual(document['fields']['order'][key],'',key)
        for key in ('closed_by','progress_by','claimed_by'):
            self.assertNotIn(key,document['fields']['signatures'])
        for key in ('details_by','reviewed_by','prepared_by','client_approved_by'):
            self.assertEqual(document['fields']['signatures'][key],INK)
            self.assertEqual(document['fields']['order'][key],before_order[key])
        self.assertEqual(document['fields']['work_tracking'],before_tracking)
        self.assertEqual(self.store.read_pdf(self.workspace,issued['id'])[1],issued['pdf'])
        stored_event=json.loads(self.audit(document['id'])[-1]['after_data'])['actions'][0]
        self.assertEqual(stored_event,event)
        self.assertEqual(stored_event['completion'],'Ongoing')
        # A new progress cycle can deliberately reuse the same saved signature.
        fields=deepcopy(document['fields'])
        fields['signatures']['progress_by']=deepcopy(INK)
        fields['order'].update(progress_by='Second cycle signer',progress_date='2026-11-11')
        document=self.store.save(self.workspace,self.payload(fields,document,[self.action(fields,'progress_by')]))
        self.assertEqual(document['status'],'Claim')
        self.assertEqual(document['fields']['work_tracking'],before_tracking)

    def test_ongoing_new_save_retry_is_idempotent_and_stale_existing_save_cannot_clear_newer_edits(self):
        fields=deepcopy(self.fields);fields['order']['completion']='Ongoing'
        payload=self.payload(fields,signed=[self.action(fields,'closed_by')])
        document=self.store.save(self.workspace,payload)
        count=len(self.audit(document['id']))
        self.assertEqual(self.store.save(self.workspace,payload),document)
        self.assertEqual(len(self.audit(document['id'])),count)
        updated=deepcopy(document['fields']);updated['order']['description']='Newer business edit'
        newer=self.store.save(self.workspace,self.payload(updated,document))
        before=self.store.capture(self.workspace)
        with self.assertRaises(CommercialConflict):
            self.store.save(self.workspace,self.payload(fields,document,[self.action(fields,'closed_by')]))
        self.assertEqual(self.store.capture(self.workspace),before)
        saved=next(item for item in self.store.view(self.workspace)['documents'] if item['id']==newer['id'])
        self.assertEqual(saved['fields']['order']['description'],'Newer business edit')

    def test_old_client_omissions_preserve_new_details_signature_without_progressing(self):
        document=self.store.save(self.workspace,self.payload())
        fields=deepcopy(document['fields'])
        for key in ('details_by','details_date'):fields['order'].pop(key)
        fields['signatures'].pop('details_by')
        updated=self.store.save(self.workspace,self.payload(fields,document))
        self.assertEqual(updated['fields']['order']['details_by'],document['fields']['order']['details_by'])
        self.assertEqual(updated['fields']['signatures']['details_by'],INK)
        self.assertEqual(updated['status'],'Draft')

    def test_new_cycle_signature_after_ongoing_before_save_keeps_the_new_signoff(self):
        fields=deepcopy(self.fields);fields['order']['completion']='Ongoing'
        closing=self.action(fields,'closed_by')
        fields['order'].update(progress_by='New progress cycle',progress_date='2026-11-13')
        progressing=self.action(fields,'progress_by')
        document=self.store.save(self.workspace,self.payload(fields,signed=[closing,progressing]))
        self.assertEqual(document['status'],'Claim')
        self.assertEqual(document['fields']['order']['progress_by'],'New progress cycle')
        self.assertEqual(document['fields']['signatures']['progress_by'],INK)
        for key in ('completion','certification','closed_by','closed_date','claimed_by','claim_date'):
            self.assertEqual(document['fields']['order'][key],'')

    def test_deliberate_new_input_after_ongoing_clear_is_not_erased_by_save(self):
        fields=deepcopy(self.fields);fields['order']['completion']='Ongoing'
        closing=self.action(fields,'closed_by')
        closing['after_signing_edits']=['certification','progress_by']
        fields['order'].update(certification='Certification not issued',progress_by='New draft progress name')
        document=self.store.save(self.workspace,self.payload(fields,signed=[closing]))
        self.assertEqual(document['status'],'In progress')
        self.assertEqual(document['fields']['order']['certification'],'Certification not issued')
        self.assertEqual(document['fields']['order']['progress_by'],'New draft progress name')
        self.assertEqual(document['fields']['order']['progress_date'],'')
        self.assertNotIn('progress_by',document['fields']['signatures'])

    def test_explicit_manual_status_after_signing_preserves_the_signing_audit_and_readiness(self):
        fields=deepcopy(self.fields);fields['order']['completion']='Ongoing'
        closing=self.action(fields,'closed_by');closing['status_override']='On Hold'
        document=self.store.save(self.workspace,self.payload(fields,signed=[closing]))
        self.assertEqual(document['status'],'On Hold')
        self.assertEqual(document['fields']['order']['completion'],'')
        self.assertEqual(json.loads(self.audit(document['id'])[-1]['after_data'])['actions'][0],closing)

    def test_malformed_signing_actions_reject_atomically_and_other_document_kinds_cannot_use_them(self):
        document=self.store.save(self.workspace,self.payload())
        before=self.store.capture(self.workspace)
        good=self.action(document['fields'],'details_by')
        for bad in ([{**good,'key':[]}],[{**good,'date':'2026-02-30'}],[{**good,'signature':None}],
                    [{**good,'extra':'unsupported'}],good,[good]*33):
            with self.subTest(bad=bad),self.assertRaises(ValidationError):
                self.store.save(self.workspace,self.payload(document['fields'],document,bad))
            self.assertEqual(self.store.capture(self.workspace),before)
        with self.assertRaises(ValidationError):actions([good],'purchase_order')
        fields=deepcopy(document['fields']);fields['signatures'].pop('details_by')
        with self.assertRaisesRegex(ValidationError,'signature changed'):
            self.store.save(self.workspace,self.payload(fields,document,[good]))

    def test_new_details_fields_remain_optional_for_legacy_snapshot_reads(self):
        fields=default_fields('work_order')
        for key in ('details_by','details_date'):fields['order'].pop(key)
        normalized=validate_fields(fields,kind='work_order')
        self.assertNotIn('details_by',normalized['order'])
        self.assertNotIn('signatures',normalized)

    def test_old_completed_record_can_edit_and_issue_without_retroactive_details_signoff(self):
        document=self.store.save(self.workspace,self.payload())
        snapshot=self.store.capture(self.workspace)
        legacy=next(item for item in snapshot['documents'] if item['id']==document['id'])
        legacy['status']='Completed'
        for key in ('details_by','details_date'):legacy['fields']['order'].pop(key)
        legacy['fields']['signatures'].pop('details_by')
        target=self.fixture.projects.add(snapshot['project_id']);self.store.restore(target,snapshot)
        loaded=next(item for item in self.store.view(target)['documents'] if item['id']==document['id'])
        self.assertEqual(loaded['fields'],legacy['fields'])
        fields=deepcopy(loaded['fields']);fields['order']['description']='An unrelated legacy edit'
        saved=self.store.save(target,self.payload(fields,loaded))
        self.assertEqual(saved['status'],'Completed')
        self.assertNotIn('details_by',saved['fields']['order'])
        self.assertNotIn('details_date',saved['fields']['order'])
        self.assertNotIn('details_by',saved['fields']['signatures'])
        self.assertEqual(saved['fields'],fields)
        issued=self.store.issue(target,saved['id'],saved['version'],str(uuid4()))
        self.assertEqual(issued['document']['status'],'Completed')
        self.assertNotIn('details_by',issued['document']['fields']['order'])

    def test_new_details_signer_prints_in_new_pdf_without_replacing_issued_bytes(self):
        fields=deepcopy(self.fields)
        fields['order'].update(details_by='Initial Details Signer',details_date='2026-11-12')
        document=self.store.save(self.workspace,self.payload(fields))
        raw=render_commercial_pdf(document,'WO-DETAILS-QA',company=DEFAULTS)
        text=' '.join(page.extract_text() for page in PdfReader(BytesIO(raw)).pages)
        self.assertIn('Initial Details Signer',text)
        self.assertIn('2026-11-12',text)
        self.assertIn('WORK ORDER REVIEW',text)


if __name__=='__main__':unittest.main()
