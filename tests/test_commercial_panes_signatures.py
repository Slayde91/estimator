"""Optional signer metadata and Quote panes retain portable ownership boundaries."""
import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, CommercialDocuments, default_fields, validate_fields
from estimator.commercial_http import CommercialHTTP
from tests.test_commercial_documents import Projects
from tests.commercial_ready_fixtures import complete_quote, complete_work_order, INK
import tests.test_saved_commercial as saved_helpers


class CommercialPaneSignerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.projects = Projects(self.root)
        self.workspace = self.projects.add()
        self.project = self.projects.project_id(self.workspace)
        self.store = CommercialDocuments(self.projects)

    def save(self, kind, fields, prior=None):
        fields = deepcopy(fields)
        fields['details']['project_no'] = 'PN-01'
        return self.store.save(self.workspace, {'id':prior['id'] if prior else str(uuid4()),
            'version':prior['version'] if prior else 0,'kind':kind,'status':'Draft','fields':fields})

    def test_old_signer_fields_gain_only_empty_optional_date_without_mutating_input(self):
        fields = default_fields('work_order')
        del fields['order']['prepared_date']
        fields['order']['prepared_by'] = 'Historical signer'
        before = deepcopy(fields)
        restored = validate_fields(fields, kind='work_order')
        self.assertEqual(fields, before)
        self.assertEqual(restored['order']['prepared_by'], 'Historical signer')
        self.assertEqual(restored['order']['prepared_date'], '')
        self.assertNotIn('signatures', restored)

    def test_quote_signers_are_independent_preserved_with_legacy_saves_and_printed_on_new_revisions(self):
        fields = complete_quote(default_fields('quote'))
        fields['order'].pop('quoted_by')
        fields['order'].pop('quoted_date')
        document = self.save('quote', fields)
        first = self.store.issue(self.workspace, document['id'], document['version'], str(uuid4()))
        original = first['pdf']
        document = first['document']
        def save(draft, actions=()):
            return self.store.save(self.workspace, dict(kind='quote', id=document['id'], version=document['version'],
                status=document['status'], fields=draft, signature_actions=list(actions)))
        status = document['status']
        for key, date_key, person in [('reviewed_by','review_date','Reviewer One'),('quoted_by','quoted_date','Estimator Two')]:
            action = dict(key=key, date='2026-11-14', name=person, signature=INK)
            document = save(document['fields'], [action])
            self.assertEqual(document['status'], status)
            self.assertEqual(document['fields']['order'][key], person)
            self.assertEqual(document['fields']['order'][date_key], action['date'])
        legacy = deepcopy(document['fields'])
        legacy.pop('signatures')
        for key in ('quoted_by','quoted_date','reviewed_by','review_date'):
            legacy['order'].pop(key)
        document = save(legacy)
        self.assertEqual(document['fields']['order']['quoted_by'], 'Estimator Two')
        self.assertEqual(document['fields']['signatures'], dict(quoted_by=INK,reviewed_by=INK))
        signed = self.store.issue(self.workspace, document['id'], document['version'], str(uuid4()))
        content = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(signed['pdf'])).pages)
        for label in ('Quoted by', 'Reviewed by', 'Reviewer One', 'Estimator Two', '2026-11-14'):
            self.assertIn(label, content)
        reopened = self.projects.add(self.project)
        self.store.restore(reopened, self.store.capture(self.workspace))
        self.assertEqual(self.store.read_pdf(reopened, first['id'])[1], original)
        self.assertEqual(self.store.view(reopened)['documents'][0]['fields']['signatures'],document['fields']['signatures'])
        document = signed['document']
        document = save(document['fields'], [{'key':'quoted_by', 'clear':True}])
        self.assertEqual(document['fields']['signatures'], {'reviewed_by':INK})
        self.assertEqual(document['fields']['order']['quoted_by'], '')
        self.assertEqual(document['fields']['order']['quoted_date'], '')

    def test_three_signer_names_dates_and_vector_ink_persist_in_pdf_without_global_defaults(self):
        fields = complete_work_order(default_fields('work_order'))
        quote_fields = complete_quote(default_fields('quote')); quote_fields['terms'] = '<p>N / A</p>'
        quote = self.save('quote', quote_fields)
        issued_quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))
        fields['order']['quote_id'] = issued_quote['document']['id']
        names = {'reviewed_by':'Review Person','prepared_by':'Prepare Person','client_approved_by':'Approve Person'}
        dates = {'review_date':'2026-11-09','prepared_date':'2026-11-10','client_approval_date':'2026-11-11'}
        fields['order'].update(names | dates)
        ink = {'version':1,'ratio':3,'strokes':[[[0,0],[.5,1],[1,0]]]}
        fields = complete_work_order(fields, 'Review')
        fields['order']['approval'] = 'Approved'
        fields['signatures'].update(dict.fromkeys(names, ink))
        document = self.save('work_order', fields)
        operation = str(uuid4())
        issued = self.store.issue(self.workspace, document['id'], document['version'], operation)
        content = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(issued['pdf'])).pages)
        for text in (*names.values(), *dates.values()):
            self.assertIn(text, content)
        self.assertEqual(document['fields']['signatures'], fields['signatures'])
        portable = self.store.capture(self.workspace)
        target = self.projects.add(self.project)
        self.store.restore(target, portable)
        restored = next(row for row in self.store.view(target)['documents'] if row['id']==document['id'])
        self.assertEqual(restored['kind'], 'work_order')
        self.assertEqual(restored['fields']['order'], document['fields']['order'])
        self.assertEqual(default_fields('work_order')['order']['prepared_date'], '')
        # A legacy portable record may omit the newly optional date. Restore
        # normalizes its live view without rewriting the captured source/ink or
        # rendering/replacing any already issued PDF.
        legacy = deepcopy(portable)
        next(row for row in legacy['documents'] if row['kind'] == 'work_order')['fields']['order'].pop('prepared_date')
        before = deepcopy(legacy)
        target = self.projects.add(self.project)
        self.store.restore(target, legacy)
        self.assertEqual(legacy, before)
        self.assertEqual(next(row for row in self.store.view(target)['documents'] if row['kind']=='work_order')['fields']['order']['prepared_date'], '')
        self.assertEqual(self.store.read_pdf(target, issued['id'])[1], issued['pdf'])
        self.assertEqual(self.store.issue(self.workspace, document['id'], document['version'], operation)['pdf'], issued['pdf'])

    def test_quote_notes_and_files_use_existing_cas_owner_and_frozen_revision_rules(self):
        data = BytesIO(); canvas = Canvas(data); canvas.drawString(25, 50, 'Original Quote attachment'); canvas.save()
        attachment = self.store.files.add(self.project, 'quote-source.pdf', base64.b64encode(data.getvalue()).decode())
        fields = complete_quote(default_fields('quote')); fields['terms'] = '<p>N / A</p>'; fields['files'] = [attachment]
        fields['notes'] = [{'id':str(uuid4()),'title':'Quote note','body':'<p>Saved note</p>',
                           'author':'Fixture user','updated_at':'2026-11-08T01:00:00Z'}]
        quote = self.save('quote', fields)
        self.assertEqual(self.store.read_attachment(self.workspace, quote['id'], attachment['id'])[1], data.getvalue())
        updated = deepcopy(quote['fields']); updated['notes'][0]['title'] = 'Updated note'
        changed = self.save('quote', updated, quote)
        with self.assertRaises(CommercialConflict): self.save('quote', updated, quote)
        operation = str(uuid4())
        issued = self.store.issue(self.workspace, changed['id'], changed['version'], operation)
        self.assertIn('Original Quote attachment', PdfReader(BytesIO(issued['pdf'])).pages[-1].extract_text())
        (self.store.files.folder(self.project) / attachment['id']).write_bytes(b'changed')
        self.assertEqual(self.store.issue(self.workspace, changed['id'], changed['version'], operation)['pdf'], issued['pdf'])
        with self.assertRaises(ValidationError):
            self.store.files.read(str(uuid4()), attachment)
        purchase = default_fields('purchase_order'); purchase.update(notes=fields['notes'], files=fields['files'])
        self.assertEqual(validate_fields(purchase, kind='purchase_order')['notes'], fields['notes'])

    def test_linked_order_inherits_quote_files_on_save_and_issue_and_exclusions_stay_local(self):
        pdf = BytesIO()
        canvas = Canvas(pdf)
        canvas.drawString(25, 50, 'Original supplier drawing')
        canvas.save()
        def upload(name, content):
            return self.store.files.add(self.project, name, base64.b64encode(content).decode())
        drawing = upload('drawing.pdf', pdf.getvalue())
        instructions = upload('installer.txt', b'Install instructions for the crew')
        local = upload('order-only.txt', b'Foreman contact')
        fields = complete_quote(default_fields('quote'))
        fields['files'] = [drawing]
        quote = self.save('quote', fields)
        quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))['document']
        fields = complete_work_order(default_fields('work_order'))
        fields['order']['quote_id'] = quote['id']
        fields['files'] = [local]
        work = self.save('work_order', fields)
        self.assertCountEqual(work['fields']['files'], [local, drawing])
        self.assertEqual(self.store.read_attachment(self.workspace, work['id'], drawing['id'])[1], pdf.getvalue())

        fields = deepcopy(quote['fields'])
        fields['files'].append(instructions)
        quote = self.save('quote', fields, quote)
        issue_id = str(uuid4())
        issued = self.store.issue(self.workspace, work['id'], work['version'], issue_id)
        pdf_reader = PdfReader(BytesIO(issued['pdf']))
        self.assertIn('Original supplier drawing', '\n'.join(page.extract_text() for page in pdf_reader.pages))
        self.assertEqual(pdf_reader.attachments['installer.txt'], [b'Install instructions for the crew'])
        self.assertEqual(pdf_reader.attachments['order-only.txt'], [b'Foreman contact'])
        self.assertCountEqual(issued['document']['fields']['files'], [drawing, instructions, local])

        fields = deepcopy(issued['document']['fields'])
        del fields['files']
        after_old_editor = self.save('work_order', fields, issued['document'])
        self.assertCountEqual(after_old_editor['fields']['files'], [drawing, instructions, local])
        fields = deepcopy(after_old_editor['fields'])
        fields['files'].remove(drawing)
        changed = self.save('work_order', fields, after_old_editor)
        self.assertEqual(changed['fields']['excluded_quote_files'], [drawing['id']])
        changed = self.save('work_order', changed['fields'], changed)
        self.assertCountEqual(changed['fields']['files'], [instructions, local])
        fields = deepcopy(changed['fields'])
        fields['files'] = []
        emptied = self.save('work_order', fields, changed)
        self.assertFalse(emptied['fields'].get('files'))
        self.assertCountEqual(emptied['fields']['excluded_quote_files'], [drawing['id'], instructions['id']])
        self.assertEqual(self.store.read_attachment(self.workspace, quote['id'], drawing['id'])[1], pdf.getvalue())
        self.assertEqual(self.store.issue(self.workspace, work['id'], work['version'], issue_id)['pdf'], issued['pdf'])

    def test_unfiled_work_order_only_inherits_from_an_enrolled_quote(self):
        fields = complete_quote(default_fields('quote'))
        quote = self.save('quote', fields)
        quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))['document']
        fields = complete_work_order(default_fields('work_order'))
        fields['details']['project_no'] = quote['fields']['details']['project_no']
        fields['order']['quote_id'] = quote['id']
        work = self.store.save(self.workspace, {'kind':'work_order', 'status':'Draft', 'fields':fields}, unfiled_context={})
        attachment = self.store.files.add(self.project,'latest.txt', base64.b64encode(b'Latest Quote evidence').decode())
        fields = deepcopy(quote['fields'])
        fields['files'] = [attachment]
        quote = self.save('quote', fields, quote)
        http = CommercialHTTP(self.store)
        for enrolled in (False, True):
            if enrolled:
                self.store.save(self.workspace, {key:deepcopy(quote[key]) for key in
                    ('kind','status','id','version','fields')}, unfiled_context={})
            card = next(row for row in self.store.unfiled.cards(None) if row['id'] == work['id'])
            source = {'file_id':card['source_file'], 'revision':card['source_revision']}
            open_order = self.store.unfiled.perform('open',source,{'id':work['id']},http.execute)
            related = [item for item in open_order['related'] if item['id'] == quote['id']]
            self.assertEqual([item['fields']['files'] for item in related], [[attachment]] if enrolled else [])
            saved = self.store.unfiled.perform('save',source,{key:deepcopy(work[key]) for key in
                ('kind','status','id','version','fields')},http.execute)
            work = saved['result']
            self.assertEqual(work['fields'].get('files', []), [attachment] if enrolled else [])

    def test_claim_signature_is_optional_portable_and_old_windows_cannot_erase_it(self):
        fields = default_fields('work_order')
        for key in ('claimed_by', 'claim_date'):
            self.assertEqual(fields['order'][key], '')
        legacy = deepcopy(fields)
        for key in ('claimed_by', 'claim_date'):
            legacy['order'].pop(key)
        self.assertFalse(any(key in validate_fields(legacy, kind='work_order')['order']
                             for key in ('claimed_by', 'claim_date')))
        quote_fields = complete_quote(default_fields('quote')); quote_fields['terms'] = '<p>N / A</p>'
        quote = self.save('quote', quote_fields)
        quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))['document']
        fields = complete_work_order(fields)
        fields['order'].update(quote_id=quote['id'], claimed_by='Claim Person', claim_date='2026-11-09')
        ink = {'version':1, 'ratio':3, 'strokes':[[[0,0],[.5,1],[1,0]]]}
        work = self.save('work_order', fields)
        snapshot = self.store.capture(self.workspace)
        legacy_work = next(row for row in snapshot['documents'] if row['id'] == work['id'])
        legacy_work['fields']['signatures'] = {'claimed_by': ink}
        self.workspace = self.projects.add(self.project)
        self.store.restore(self.workspace, snapshot)
        work = next(row for row in self.store.view(self.workspace)['documents'] if row['id'] == work['id'])
        issued = self.store.issue(self.workspace, work['id'], work['version'], str(uuid4()))
        work = issued['document']
        target = self.projects.add(self.project)
        self.store.restore(target, self.store.capture(self.workspace))
        restored = next(item for item in self.store.view(target)['documents'] if item['id']==work['id'])
        self.assertEqual(restored['fields']['signatures']['claimed_by'], ink)
        self.assertEqual(restored['fields']['order']['claimed_by'], 'Claim Person')
        self.assertEqual(restored['fields']['order']['claim_date'], '2026-11-09')
        old_window = deepcopy(work['fields'])
        for key in ('claimed_by','claim_date'):
            old_window['order'].pop(key)
        old_window['signatures'].pop('claimed_by')
        old_window['title'] = 'Unrelated old-window edit'
        updated = self.save('work_order', old_window, work)
        self.assertEqual(updated['fields']['signatures']['claimed_by'], ink)
        self.assertEqual(updated['fields']['order']['claimed_by'], 'Claim Person')
        self.assertEqual(updated['fields']['order']['claim_date'], '2026-11-09')
        with self.assertRaises(CommercialConflict):
            self.save('work_order', old_window, work)
        cleared = deepcopy(updated['fields'])
        cleared['signatures'].pop('claimed_by')
        cleared['order'].update(claimed_by='',claim_date='')
        result = self.save('work_order', cleared, updated)
        self.assertNotIn('signatures', result['fields'])
        self.assertEqual(result['fields']['order']['claimed_by'], '')
        self.assertEqual(result['fields']['order']['claim_date'], '')
        self.assertEqual(self.store.read_pdf(self.workspace, issued['id'])[1], issued['pdf'])
        bad = deepcopy(fields); bad['order']['claimed_by'] = 'x' * 1001
        with self.assertRaises(ValidationError):
            validate_fields(bad, kind='work_order')

    def test_purchase_notes_and_files_keep_cas_owner_caps_and_portable_evidence(self):
        attachment = self.store.files.add(self.project, 'purchase-source.txt', base64.b64encode(b'Original PO source').decode())
        fields = default_fields('purchase_order'); fields['files'] = [attachment]
        fields['notes'] = [{'id':str(uuid4()),'title':'Purchase note','body':'<p>PO note</p>',
                           'author':'Fixture user','updated_at':'2026-11-08T01:00:00Z'}]
        purchase = self.save('purchase_order', fields)
        self.assertEqual(self.store.read_attachment(self.workspace, purchase['id'], attachment['id'])[1], b'Original PO source')
        http = CommercialHTTP(self.store)
        changed = http.execute('notes', {'workspace_id':self.workspace,'id':purchase['id'],'version':purchase['version'],
                                        'notes':[{**fields['notes'][0], 'title':'Changed PO note'}]})
        with self.assertRaises(CommercialConflict):
            http.execute('notes', {'workspace_id':self.workspace,'id':purchase['id'],'version':purchase['version'],'notes':[]})
        other = self.projects.add()
        with self.assertRaises(ValidationError): self.store.read_attachment(other, purchase['id'], attachment['id'])
        target = self.projects.add(self.project)
        self.store.restore(target, self.store.capture(self.workspace))
        restored = next(row for row in self.store.view(target)['documents'] if row['id']==purchase['id'])
        self.assertEqual(restored['fields']['notes'], changed['fields']['notes'])
        self.assertEqual(self.store.read_attachment(target, purchase['id'], attachment['id'])[1], b'Original PO source')
        operation = str(uuid4())
        issued = self.store.issue(self.workspace, changed['id'], changed['version'], operation)
        self.assertEqual(PdfReader(BytesIO(issued['pdf'])).attachments['purchase-source.txt'][0], b'Original PO source')
        (self.store.files.folder(self.project) / attachment['id']).write_bytes(b'Changed later')
        self.assertEqual(self.store.issue(self.workspace, changed['id'], changed['version'], operation)['pdf'], issued['pdf'])
        oversized = deepcopy(fields); oversized['notes'] = fields['notes'] * 201
        with self.assertRaises(ValidationError): validate_fields(oversized, kind='purchase_order')

    def test_project_identity_overrides_document_fields_and_empty_contact_snapshot_clears(self):
        http = CommercialHTTP(self.store, derive=lambda *_args, **_kwargs:{'lines':[], 'sources':[], 'scope_tables':[]})
        project = {'project_no':'PN-01','client':'Project Company','site_address':'Project site',
                   'contact_name':'Project Contact','contact_phone':'0400 123 456','contact_email':'project@example.test'}
        expected = {'project_no':'PN-01','client':'Project Company','site_address':'Project site',
                    'contact':'Project Contact','phone':'0400 123 456','email':'project@example.test','date':'2026-11-08'}
        issued_quote = None
        for kind in ('quote','work_order','purchase_order'):
            with self.subTest(kind=kind):
                fields = default_fields(kind); fields['details'] = dict.fromkeys(fields['details'], 'Forged document identity')
                fields['details']['date'] = '2026-11-08'
                if kind=='work_order':
                    fields['details']['project_no'] = 'PN-01'
                    fields['order']['quote_id'] = issued_quote['id']
                payload = {'workspace_id':self.workspace,'kind':kind,'status':'Draft','fields':fields,'project_details':project}
                saved = http.execute('save', payload)
                self.assertEqual(saved['fields']['details'], expected)
                if kind == 'quote':
                    issued_quote = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))['document']
                    saved = issued_quote
                blank = {key:('PN-01' if key=='project_no' else '') for key in project}
                cleared = http.execute('save', {**payload,'fields':saved['fields'],'id':saved['id'],'version':saved['version'],'project_details':blank})
                self.assertEqual(cleared['fields']['details'], {key:(expected[key] if key in ('date','project_no') else '') for key in expected})
        before = self.store.capture(self.workspace)
        with self.assertRaises(ValidationError):
            http.execute('save', {**payload, 'project_details':{'contact_email':'invalid'}})
        self.assertEqual(self.store.capture(self.workspace), before)

    def test_quote_rejects_project_metadata_that_changed_during_estimate_capture(self):
        derive = Mock(return_value={'lines':[], 'sources':[], 'scope_tables':[]})
        http = CommercialHTTP(self.store, derive=derive)
        captured = {'project_no':'PN-01','client':'Current Company','site_address':'Current site',
                    'contact_name':'Contact before capture','contact_phone':'0400 000 001','contact_email':'before@example.test'}
        current = {**captured, 'contact_name':'Changed during capture','contact_email':'after@example.test'}
        before = self.store.capture(self.workspace)
        with self.assertRaisesRegex(CommercialConflict, 'Project details changed'):
            http.execute('save', {'workspace_id':self.workspace,'kind':'quote','status':'Draft','fields':default_fields('quote'),
                                 'project_details':current,'active_estimate_id':'estimate-1',
                                 'estimates':[{'id':'estimate-1','name':'Estimate 1','workspace':{'estimate':captured}}]})
        self.assertEqual(self.store.capture(self.workspace), before)
        derive.assert_not_called()

    def test_bound_work_order_retains_owned_number_while_other_project_details_follow_current_project(self):
        quote = self.save('quote', complete_quote(default_fields('quote')))
        quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))['document']
        fields = complete_work_order(default_fields('work_order')); fields['order']['quote_id'] = quote['id']
        work = self.save('work_order', fields)
        current = {'project_no':'PN-99','client':'Updated Company','site_address':'Updated site',
                   'contact_name':'Updated Contact','contact_phone':'0400 999 888','contact_email':'updated@example.test'}
        http = CommercialHTTP(self.store)
        changed = complete_work_order(work['fields'], 'Review'); changed['order'].update(approval='Approved',reviewed_by='Reviewer',review_date='2026-11-08')
        changed.setdefault('signatures', {})['reviewed_by'] = deepcopy(INK)
        saved = http.execute('save', {'workspace_id':self.workspace,'id':work['id'],'version':work['version'],'kind':'work_order','status':'Review',
                                     'fields':changed,'project_details':current})
        self.assertEqual(saved['fields']['details']['project_no'], 'PN-01')
        self.assertEqual(saved['fields']['details']['contact'], 'Updated Contact')
        self.assertEqual(saved['fields']['details']['client'], 'Updated Company')
        self.assertEqual(saved['fields']['order']['work_order_reference'], work['fields']['order']['work_order_reference'])
        self.assertEqual(saved['fields']['order']['reviewed_by'], 'Reviewer')
        noted = http.execute('notes', {'workspace_id':self.workspace,'id':saved['id'],'version':saved['version'],
                                      'notes':[{'id':str(uuid4()),'title':'Review note','body':'<p>Owned review</p>','author':'Reviewer','updated_at':'2026-11-08T00:00:00Z'}]})
        self.assertEqual(noted['fields']['details']['project_no'], 'PN-01')
        for number in ('PN-FORGED',''):
            forged = deepcopy(noted['fields']); forged['details']['project_no'] = number
            before = self.store.capture(self.workspace)
            with self.assertRaisesRegex(ValidationError, 'project number cannot change'):
                http.execute('save', {'workspace_id':self.workspace,'id':noted['id'],'version':noted['version'],'kind':'work_order','status':'Review',
                                      'fields':forged,'project_details':current})
            self.assertEqual(self.store.capture(self.workspace), before)
        new_fields = default_fields('work_order');new_fields['order']['quote_id'] = quote['id']
        new_work = http.execute('save', {'workspace_id':self.workspace,'kind':'work_order','status':'Draft','fields':new_fields,'project_details':current})
        self.assertEqual(new_work['fields']['details']['project_no'], 'PN-01', 'New linked WOs use the issued Quote binding, not a mismatching active estimate number.')

    def test_project_synced_work_order_rejects_malformed_order_without_writes(self):
        http = CommercialHTTP(self.store)
        before = self.store.capture(self.workspace)
        for malformed in (None, [], 'not an order'):
            with self.subTest(order=malformed):
                fields = default_fields('work_order');fields['order'] = malformed
                with self.assertRaisesRegex(ValidationError, 'unsupported fields'):
                    http.execute('save', {'workspace_id':self.workspace,'kind':'work_order','status':'Draft',
                                         'fields':fields,'project_details':{'project_no':'PN-01'}})
                self.assertEqual(self.store.capture(self.workspace), before)

    def test_all_commercial_attachments_publish_and_restore_with_a_cold_machine_cache(self):
        expected = []
        quote = None
        for kind in ('quote','purchase_order','work_order'):
            raw = ('Original '+kind+' evidence').encode()
            attachment = self.store.files.add(self.project, kind+'-source.txt', base64.b64encode(raw).decode())
            fields = complete_quote(default_fields(kind)) if kind == 'quote' else default_fields(kind); fields['files'] = [attachment]
            if kind=='work_order':
                issued = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))
                fields['order']['quote_id'] = issued['document']['id']
            document = self.save(kind, fields)
            if kind=='quote': quote = document
            expected.append((document['id'], attachment, raw))
        snapshot = self.store.capture(self.workspace)
        project_path = self.root / 'portable' / 'owner.cf.json'
        project_path.parent.mkdir()
        self.store.files.transfer(snapshot, project_path)
        cold_projects = Projects(self.root / 'another-machine')
        cold_workspace = cold_projects.add(self.project)
        cold_store = CommercialDocuments(cold_projects)
        for _, attachment, _ in expected:
            self.assertFalse((cold_store.files.folder(self.project) / attachment['id']).exists())
        cold_store.files.transfer(snapshot, project_path, restore=True)
        cold_store.restore(cold_workspace, snapshot)
        for document_id, attachment, raw in expected:
            self.assertEqual(cold_store.read_attachment(cold_workspace, document_id, attachment['id'])[1], raw)


class SavedQuotePaneTests(unittest.TestCase):
    setUp = saved_helpers.SavedQuoteTests.setUp
    register = saved_helpers.SavedQuoteTests.register
    perform = saved_helpers.SavedQuoteTests.perform

    def test_saved_bound_work_order_keeps_its_number_after_owner_project_metadata_changes(self):
        snapshot = json.loads(self.path.read_bytes());snapshot['estimate']['project_no']='PN-01'
        snapshot['commercial_documents']['documents'][0]['fields']['details']['project_no']='PN-01'
        self.path.write_text(json.dumps(snapshot), encoding='utf-8');self.library.commercial_register(refresh=True)
        card=self.register()['documents'][0];self.source={'file_id':card['source_file'],'revision':card['source_revision']}
        issued=self.perform('issue',kind='quote',id=self.document['id'],version=self.document['version'],request_id=str(uuid4()))
        self.source['revision']=issued['revision']
        fields=complete_work_order(default_fields('work_order', {'project_no':'PN-01'}),'Review');fields['order']['quote_id']=self.document['id']
        created=self.perform('save',kind='work_order',status='Draft',fields=fields);self.source['revision']=created['revision'];work=created['result']
        snapshot=json.loads(self.path.read_bytes());snapshot['estimate'].update(project_no='PN-99',contact_name='Current owner contact',contact_email='current@example.test')
        self.path.write_text(json.dumps(snapshot),encoding='utf-8');self.library.commercial_register(refresh=True)
        card=next(row for row in self.register()['documents'] if row['id']==work['id']);self.source={'file_id':card['source_file'],'revision':card['source_revision']}
        opened=self.perform('open',id=work['id'])
        self.assertEqual(opened['project_details']['project_no'],'PN-99')
        self.assertEqual(opened['document']['fields']['details']['project_no'],'PN-01')
        self.assertEqual(opened['document']['fields']['details']['contact'],'Current owner contact')
        saved=self.perform('save',id=work['id'],version=work['version'],kind='work_order',status='Review',fields=opened['document']['fields'])
        self.source['revision']=saved['revision'];self.assertEqual(saved['result']['fields']['details']['project_no'],'PN-01')
        before=self.path.read_bytes();forged=deepcopy(saved['result']['fields']);forged['details']['project_no']='PN-FORGED'
        with self.assertRaisesRegex(ValidationError,'project number cannot change'):
            self.perform('save',id=work['id'],version=saved['result']['version'],kind='work_order',status='Review',fields=forged)
        self.assertEqual(self.path.read_bytes(),before)

    def test_saved_document_uses_owning_project_contacts_and_rejects_caller_snapshot(self):
        snapshot = json.loads(self.path.read_bytes())
        owner = {'contact_name':'Owner Contact','contact_phone':'0400 111 222','contact_email':'owner@example.test',
                 'site_address':'Owning site','client':'Owning Company'}
        snapshot['estimate'].update(owner)
        self.path.write_text(json.dumps(snapshot), encoding='utf-8')
        self.library.commercial_register(refresh=True)
        card = self.register()['documents'][0]
        self.source = {'file_id':card['source_file'],'revision':card['source_revision']}
        before = self.path.read_bytes()
        opened = self.perform('open', id=self.document['id'])
        self.assertEqual(self.path.read_bytes(), before, 'Opening current linked Project data is read-only.')
        self.assertEqual(opened['document']['fields']['details']['contact'], owner['contact_name'])
        self.assertEqual(opened['project_details']['contact_phone'], owner['contact_phone'])
        fields = deepcopy(opened['document']['fields']); fields['details'].update(contact='Another Project Contact',phone='wrong',email='wrong@example.test')
        changed = self.perform('save', id=self.document['id'], version=self.document['version'], kind='quote', status='Draft', fields=fields)
        self.source['revision'] = changed['revision']
        self.assertEqual(changed['result']['fields']['details']['contact'], owner['contact_name'])
        self.assertEqual(changed['result']['fields']['details']['phone'], owner['contact_phone'])
        self.assertEqual(changed['result']['fields']['details']['email'], owner['contact_email'])
        after = self.path.read_bytes()
        with self.assertRaises(ValidationError):
            self.perform('save', id=self.document['id'], version=changed['result']['version'], kind='quote', status='Draft', fields=fields,
                         project_details={'client':'Injected Project'})
        self.assertEqual(self.path.read_bytes(), after)

    def test_native_saved_quote_notes_and_files_keep_versions_and_original_bytes(self):
        original = self.path.read_bytes()
        attachment = self.perform('attachment', name='quote-evidence.txt', content=base64.b64encode(b'Quote evidence original').decode())
        self.assertEqual(self.path.read_bytes(), original, 'Staging an attachment does not publish document changes.')
        note = {'id':str(uuid4()),'title':'Saved Quote note','body':'<p>Original body</p>',
                'author':'Fixture user','updated_at':'2026-11-08T01:00:00Z'}
        saved = self.perform('notes', id=self.document['id'], version=self.document['version'], notes=[note])
        prior_source = dict(self.source)
        self.source['revision'] = saved['revision']
        document = saved['result']
        fields = deepcopy(document['fields']); fields['files'] = [attachment]
        written = self.perform('save', id=document['id'],version=document['version'],kind='quote',status='Draft',fields=fields)
        self.source['revision'] = written['revision']
        read = self.perform('read-attachment', id=document['id'], file_id=attachment['id'])
        self.assertEqual(base64.b64decode(read['content']), b'Quote evidence original')
        captured = json.loads(self.path.read_bytes())['commercial_documents']['documents'][0]
        self.assertEqual(captured['fields']['notes'], [note])
        self.assertEqual(captured['fields']['files'], [attachment])
        with self.assertRaises(CommercialConflict):
            self.saved.perform('notes', {'source':prior_source,'id':document['id'],'version':1,'notes':[]},self.http.execute)
        self.assertEqual(json.loads(self.path.read_bytes())['commercial_documents']['documents'][0], captured)


class CommercialPricingRouteTests(unittest.TestCase):
    def test_pricing_search_is_read_only_bounded_and_has_no_workspace_capability(self):
        item = {'id':'inventory:known-item','name':'Known item','description':'Known item','unit_price':42.5}
        search = Mock(return_value={'items':[item]})
        pricing = Mock(return_value={'configuration':'current canonical catalog'})
        service = Mock()
        http = CommercialHTTP(service, pricing=pricing)

        class Handler:
            command = 'GET'
            def __init__(self, path, command='GET'):
                self.path, self.command, self.result = path, command, None
            def send_payload(self, *args): self.result = args

        with patch.dict(sys.modules, {'estimator.commercial_pricing':SimpleNamespace(search_pricing=search)}):
            valid = Handler('/api/commercial/pricing?search=known%20item')
            self.assertTrue(http.dispatch(valid, '/api/commercial/pricing'))
            self.assertEqual(valid.result, (200, {'items':[item]}))
            search.assert_called_once_with(pricing.return_value, 'known item')
            for suffix, command, status in [('?workspace=foreign', 'GET', 400),('?search=one&search=two','GET',400),
                                             ('?search='+'x'*501,'GET',400),('', 'POST',405)]:
                with self.subTest(suffix=suffix,command=command):
                    invalid = Handler('/api/commercial/pricing'+suffix, command)
                    self.assertTrue(http.dispatch(invalid, '/api/commercial/pricing'))
                    self.assertEqual(invalid.result[0], status)
            self.assertEqual(search.call_count, 1)
            pricing.assert_called_once_with()
            self.assertFalse(service.mock_calls, 'Search does not read, mutate or create a document workspace.')


if __name__ == '__main__': unittest.main()
