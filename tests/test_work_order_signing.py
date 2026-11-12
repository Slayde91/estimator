"""Signing events advance exactly once without rewriting old ink or issued PDFs."""
from copy import deepcopy
from io import BytesIO
import json
import unittest
from uuid import uuid4
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, commercial_cards, default_fields, validate_fields
from estimator.commercial_http import CommercialHTTP
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
        fields = deepcopy(self.fields)
        fields.pop('signatures')
        document = self.store.save(self.workspace,self.payload(fields))
        self.assertEqual(document['status'],'Draft')
        for key, expected in [('details_by','Review'),('reviewed_by','OHS Docs'),('prepared_by','Client Approval'),
                              ('client_approved_by','In progress'),('progress_by','Claim'),('claimed_by','Certify'),('closed_by','Completed')]:
            with self.subTest(key=key):
                fields = deepcopy(document['fields'])
                fields.setdefault('signatures', {})[key] = deepcopy(INK)
                document = self.store.save(self.workspace,self.payload(fields,document,[self.action(fields,key)]))
                self.assertEqual(document['status'],expected)
                self.assertEqual(document['fields']['signatures'][key],INK)
                event = self.audit(document['id'])[-1]
                self.assertEqual(event['action'],'signatures')
                self.assertEqual(json.loads(event['after_data'])['actions'][0]['key'],key)
        self.assertEqual(len([row for row in self.audit(document['id']) if row['action']=='signatures']),7)

    def test_loading_and_saving_old_ink_does_not_sign_again_and_evidence_is_bound(self):
        document = self.store.save(self.workspace,self.payload())
        fields = deepcopy(document['fields'])
        fields['order'].update(reviewed_by='Edited name only',review_date='2026-11-10')
        with self.assertRaisesRegex(ValidationError, 'signing details'):
            self.store.save(self.workspace,self.payload(fields,document))
        document = self.store.save(self.workspace,self.payload(document['fields'],document))
        self.assertEqual(document['status'],'Draft')
        snapshot = self.store.capture(self.workspace)
        target = self.fixture.projects.add(snapshot['project_id'])
        self.store.restore(target,snapshot)
        self.assertEqual(self.store.view(target)['documents'][-1]['status'],'Draft')
        self.assertFalse(any(row['action']=='signatures' for row in self.audit(document['id'])))

    def test_review_requires_approval_and_denial_cancels(self):
        fields = deepcopy(self.fields)
        fields['signatures'] = {'details_by': INK}
        doc = self.store.save(self.workspace, self.payload(fields))
        fields = deepcopy(doc['fields'])
        fields['signatures']['reviewed_by'] = INK
        fields['order']['approval'] = ''
        with self.assertRaisesRegex(ValidationError, 'approval decision'):
            self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'reviewed_by')]))
        fields['order']['approval'] = 'Denied'
        doc = self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'reviewed_by')]))
        self.assertEqual(doc['status'], 'Cancelled')
        fields = deepcopy(doc['fields'])
        fields['signatures']['prepared_by'] = INK
        with self.assertRaisesRegex(ValidationError, 'approved review'):
            self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'prepared_by')]))

    def test_completion_choices_apply_their_status_and_preserve_decisions(self):
        for choice, status in [('On hold', 'On Hold'), ('Not completed', 'In progress')]:
            with self.subTest(choice=choice):
                doc = self.store.save(self.workspace, self.payload())
                fields = deepcopy(doc['fields'])
                fields['order']['completion'] = choice
                doc = self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'closed_by')]))
                self.assertEqual(doc['status'], status)
                self.assertEqual(doc['fields']['order']['completion'], choice)
                self.assertEqual(doc['fields']['order']['certification'], fields['order']['certification'])
                for key in ('progress_by', 'claimed_by', 'closed_by'):
                    if choice == 'On hold':
                        self.assertEqual(doc['fields']['signatures'][key], INK)
                    else:
                        self.assertNotIn(key, doc['fields']['signatures'])
                        self.assertEqual(doc['fields']['order'][key], '')
                        self.assertEqual(doc['fields']['order'][STEPS[key][0]], '')

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
        for key in ('closed_by','closed_date','progress_by','progress_date','claimed_by','claim_date'):
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

    def test_first_signature_create_retry_and_stale_save_are_atomic(self):
        fields = deepcopy(self.fields)
        fields['signatures'] = {'details_by': INK}
        payload = self.payload(fields, signed=[self.action(fields, 'details_by')])
        doc = self.store.save(self.workspace, payload)
        count = len(self.audit(doc['id']))
        self.assertEqual(self.store.save(self.workspace, payload), doc)
        self.assertEqual(len(self.audit(doc['id'])), count)
        updated = deepcopy(doc['fields'])
        updated['order']['description'] = 'Newer business edit'
        newer = self.store.save(self.workspace, self.payload(updated, doc))
        before = self.store.capture(self.workspace)
        with self.assertRaises(CommercialConflict):
            self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'details_by')]))
        self.assertEqual(self.store.capture(self.workspace), before)
        self.assertEqual(newer['fields']['order']['description'], 'Newer business edit')

    def test_old_client_omissions_preserve_new_details_signature_without_progressing(self):
        document=self.store.save(self.workspace,self.payload())
        fields=deepcopy(document['fields'])
        for key in ('details_by','details_date'):fields['order'].pop(key)
        fields['signatures'].pop('details_by')
        updated=self.store.save(self.workspace,self.payload(fields,document))
        self.assertEqual(updated['fields']['order']['details_by'],document['fields']['order']['details_by'])
        self.assertEqual(updated['fields']['signatures']['details_by'],INK)
        self.assertEqual(updated['status'],'Draft')

    def test_skipped_stage_and_unacknowledged_predecessor_ink_are_rejected(self):
        fields = deepcopy(self.fields)
        fields['signatures'] = {}
        doc = self.store.save(self.workspace, self.payload(fields))
        before = self.store.capture(self.workspace)
        fields = deepcopy(doc['fields'])
        fields.setdefault('signatures', {})
        fields['signatures']['reviewed_by'] = INK
        with self.assertRaisesRegex(ValidationError, 'preceding sections'):
            self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'reviewed_by')]))
        with self.assertRaisesRegex(ValidationError, 'preceding sections'):
            self.store.save(self.workspace, self.payload(fields, doc))
        fields['signatures']['details_by'] = INK
        with self.assertRaisesRegex(ValidationError, 'signing button'):
            self.store.save(self.workspace, self.payload(fields, doc, [self.action(fields, 'reviewed_by')]))
        self.assertEqual(self.store.capture(self.workspace), before)

    def test_signing_does_not_accept_status_override_or_multiple_stages_in_one_save(self):
        doc = self.store.save(self.workspace, self.payload())
        fields = deepcopy(doc['fields'])
        closing = self.action(fields, 'closed_by')
        for events in ([{**closing, 'status_override': 'On Hold'}], [closing, closing]):
            with self.assertRaises(ValidationError):
                self.store.save(self.workspace, self.payload(fields, doc, events))

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
        with self.assertRaisesRegex(ValidationError,'later signatures'):
            self.store.save(self.workspace,self.payload(fields,document,[good]))

    def test_new_details_fields_remain_optional_for_legacy_snapshot_reads(self):
        fields=default_fields('work_order')
        for key in ('details_by','details_date'):fields['order'].pop(key)
        normalized=validate_fields(fields,kind='work_order')
        self.assertNotIn('details_by',normalized['order'])
        self.assertNotIn('signatures',normalized)

    def test_clearing_each_section_rewinds_and_retains_tracking_billing_and_issued_files(self):
        fields = deepcopy(self.fields)
        fields['order'].update(end_date='2027-01-20', attachments='Drawing 21', justification='Ready',
                               swms='SWMS-4', sds='SDS-3', sop='SOP-1', other_documents='Plan',
                               client_approval='Initial approval', progress='Existing progress note', claim='Legacy claim',
                               certification='Certification issued', completion='Completed')
        fields['work_tracking']['rows'][0]['notes'] = 'Retain this note'
        fields['billing'] = {'address':'17 Retain Street','abn_acn':'123456','name':'A. Example',
                             'email':'a@example.com','phone':'5550123','account_id':str(uuid4()),'contact_id':str(uuid4())}
        targets = ['Draft', 'Review', 'OHS Docs', 'Client Approval', 'In progress', 'Claim', 'Certify']
        for index, (key, target) in enumerate(zip(STEPS, targets)):
            with self.subTest(key=key):
                doc = self.store.save(self.workspace, {**self.payload(fields), 'status':'Completed'})
                issued = self.store.issue(self.workspace,doc['id'],doc['version'],str(uuid4()))
                doc = issued['document']
                save = self.payload(doc['fields'], doc, [{'key':key,'clear':True}])
                changed = self.store.save(self.workspace, save)
                self.assertEqual(changed['status'],target)
                result = changed['fields']
                self.assertEqual(set(result.get('signatures',{})), set(list(STEPS)[:index]))
                for signer in list(STEPS)[index:]:
                    self.assertEqual(result['order'][signer], '')
                    self.assertEqual(result['order'][STEPS[signer][0]], '')
                self.assertEqual(result['billing'], doc['fields']['billing'])
                self.assertEqual(result['work_tracking'], doc['fields']['work_tracking'])
                self.assertEqual(result['order']['progress'], 'Existing progress note')
                self.assertEqual(result['order']['certification'], '')
                self.assertEqual(result['order']['completion'], '')
                self.assertEqual(result['order']['justification'], '' if index <= 1 else 'Ready')
                self.assertEqual(result['order']['sds'], '' if index <= 2 else 'SDS-3')
                if index == 0:
                    self.assertEqual(result['order']['attachments'], '')
                    self.assertEqual(result['order']['estimated_cost'], '')
                    self.assertTrue(result['estimated_cost_cleared'])
                    reopened = self.store.save(self.workspace,self.payload(result,changed))
                    self.assertEqual(reopened['fields']['order']['estimated_cost'],'')
                    cards = commercial_cards(self.store.capture(self.workspace))
                    card = next(card for card in cards if card['id'] == doc['id'])
                    card['source_file'] = 'Saved Project'
                    self.store.apply_register_numbers([card])
                    self.assertFalse(card['grand_total'])
                self.assertEqual(self.store.read_pdf(self.workspace,issued['id'])[1],issued['pdf'])
                with self.assertRaises(CommercialConflict):
                    self.store.save(self.workspace, save)

    def test_clearing_an_unfiled_order_updates_its_board_and_reopened_editor(self):
        doc = self.store.save(self.workspace, {**self.payload(), 'status':'Completed'}, unfiled_context={})
        card, = self.store.unfiled.cards(None)
        source = {'file_id':card['source_file'], 'revision':card['source_revision']}
        save = self.payload(doc['fields'], doc, [{'key':'claimed_by', 'clear':True}])
        http = CommercialHTTP(self.store)
        saved = self.store.unfiled.perform('save', source, save, http.execute)
        self.assertEqual(saved['result']['status'], 'Claim')
        card, = self.store.unfiled.cards(None)
        self.assertEqual(card['status'], 'Claim')
        opened = self.store.unfiled.perform('open', {**source, 'revision':saved['revision']}, {'id':doc['id']}, http.execute)
        self.assertEqual(opened['document'], saved['result'])
        self.assertNotIn('claimed_by', opened['document']['fields']['signatures'])
        self.assertEqual(opened['document']['fields']['work_tracking'], doc['fields']['work_tracking'])

    def test_unfiled_order_can_add_only_a_quote_available_to_its_board(self):
        fields = default_fields('work_order', {'project_no':'PN-01'})
        order = self.store.save(self.workspace, self.payload(fields), unfiled_context={})
        edit = deepcopy(order['fields'])
        edit['order']['quote_id'] = self.fixture.quote['id']
        def link():
            card = next(row for row in self.store.unfiled.cards(None) if row['id'] == order['id'])
            source = {'file_id':card['source_file'], 'revision':card['source_revision']}
            return self.store.unfiled.perform('save', source, self.payload(edit, order), CommercialHTTP(self.store).execute)
        with self.assertRaises((ValidationError, CommercialConflict)):
            link()
        self.assertEqual(self.store.document_context(self.workspace, order['id'])[1], order)
        quote = self.fixture.quote
        self.store.save(self.workspace, {key:quote[key] for key in ('id','version','kind','status','fields')}, unfiled_context={})
        linked = link()['result']
        self.assertEqual(linked['fields']['order']['quote_reference'], quote['last_number'])
        self.assertEqual(linked['reference'], order['reference'])

    def test_clearing_a_signature_saves_existing_and_newly_blank_fields_together(self):
        doc = self.store.save(self.workspace, {**self.payload(), 'status':'Completed'})
        snapshot = self.store.capture(self.workspace)
        legacy = next(row for row in snapshot['documents'] if row['id'] == doc['id'])
        legacy['fields']['details']['phone'] = ''
        target = self.fixture.projects.add(snapshot['project_id'])
        self.store.restore(target, snapshot)
        action = [{'key':'reviewed_by', 'clear':True}]
        fields = deepcopy(legacy['fields'])
        fields['order']['urgency'] = ''
        changed = self.store.save(target, self.payload(fields, legacy, action))
        self.assertEqual(changed['status'],'Review')
        self.assertEqual(changed['fields']['details']['phone'], '')
        self.assertEqual(changed['fields']['order']['urgency'], '')
        self.assertEqual(set(changed['fields']['signatures']), {'details_by'})
        edited = deepcopy(changed['fields'])
        edited['order']['description'] = 'Ready for the next review'
        saved = self.store.save(target, self.payload(edited, changed))
        self.assertEqual(saved['status'], 'Review')
        issued = self.store.issue(target, saved['id'], saved['version'], str(uuid4()))
        self.assertEqual(issued['document']['fields']['details']['phone'], '')

    def test_historical_unrecognised_completion_does_not_authorise_completed_status(self):
        completed = self.store.save(self.workspace, {**self.payload(), 'status':'Completed'})
        snapshot = self.store.capture(self.workspace)
        historical = next(row for row in snapshot['documents'] if row['id'] == completed['id'])
        historical['fields']['order']['completion'] = 'Legacy completion text'
        target = self.fixture.projects.add(snapshot['project_id'])
        self.store.restore(target, snapshot)
        saved = self.store.save(target, self.payload(historical['fields'], historical))
        self.assertEqual(saved['status'], 'Certify')
        self.assertEqual(saved['fields']['order']['completion'], 'Legacy completion text')
        self.assertEqual(saved['fields']['signatures'], historical['fields']['signatures'])

    def test_save_and_pdf_repair_claim_with_missing_progress_signature(self):
        fields = complete_work_order(self.fixture.fields(), 'In progress')
        fields['work_tracking']['rows'][0].update(notes='Inspection in progress', completed_percent='35')
        existing = self.store.save(self.workspace, {**self.payload(fields), 'status': 'In progress'})
        snapshot = self.store.capture(self.workspace)
        recorded = next(row for row in snapshot['documents'] if row['id'] == existing['id'])
        recorded['status'] = 'Claim'
        recorded['fields']['details']['email'] = ''
        for operation in ('save', 'issue'):
            with self.subTest(operation=operation):
                target = self.fixture.projects.add(snapshot['project_id'])
                self.store.restore(target, snapshot)
                if operation == 'save':
                    corrected = self.store.save(target, self.payload(recorded['fields'], recorded))
                else:
                    corrected = self.store.issue(target, recorded['id'], recorded['version'], str(uuid4()))['document']
                self.assertEqual(corrected['status'], 'In progress')
                self.assertEqual(corrected['fields']['signatures'], recorded['fields']['signatures'])
                self.assertEqual(corrected['fields']['details']['email'], '')
                self.assertEqual(corrected['fields']['work_tracking'], recorded['fields']['work_tracking'])
                card = next(row for row in commercial_cards(self.store.capture(target)) if row['id'] == existing['id'])
                self.assertEqual(card['status'], 'In progress')

    def test_cleared_client_approval_persists_when_incomplete_order_is_saved_and_printed(self):
        fields = complete_work_order(self.fixture.fields(), 'Claim')
        existing = self.store.save(self.workspace, {**self.payload(fields), 'status': 'Claim'})
        first = self.store.issue(self.workspace, existing['id'], existing['version'], str(uuid4()))
        order = first['document']
        cleared = self.store.save(self.workspace, self.payload(order['fields'], order, [{'key':'client_approved_by', 'clear':True}]))
        incomplete = deepcopy(cleared['fields'])
        incomplete['details']['phone'] = ''
        incomplete['order']['start_date'] = ''
        updated = self.store.save(self.workspace, self.payload(incomplete, cleared))
        self.assertEqual(updated['status'], 'Client Approval')
        issued = self.store.issue(self.workspace, updated['id'], updated['version'], str(uuid4()))
        self.assertEqual(issued['document']['status'], 'Client Approval')
        snapshot = self.store.capture(self.workspace)
        target = self.fixture.projects.add(snapshot['project_id'])
        self.store.restore(target, snapshot)
        reopened = next(row for row in self.store.view(target)['documents'] if row['id'] == order['id'])
        self.assertEqual(reopened['status'], 'Client Approval')
        self.assertEqual(reopened['fields']['details']['phone'], '')
        self.assertNotIn('client_approved_by', reopened['fields']['signatures'])
        self.assertEqual(self.store.read_pdf(target, first['id'])[1], first['pdf'])

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
