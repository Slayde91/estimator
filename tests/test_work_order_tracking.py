"""Issued Quote provenance, portable tracking and deliberate Work Order signatures."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialDocuments, default_fields, validate_fields, validate_commercial_documents
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from estimator.project_file import export_project, load_project_bytes
from estimator.storage import Store
from estimator.certification import CertificationService
from estimator.certification_projects import CertificationProjects
from estimator.work_order_tracking import template
from tests.test_commercial_documents import Projects
from test_certification import pdf

INK={'version':1,'ratio':3,'strokes':[[[0,0],[.5,1],[1,0]]]}


class WorkOrderTrackingTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        self.catalog=Store(self.root/'runtime'/'source.sqlite3')
        self.certifications=CertificationProjects(CertificationService(self.catalog))
        self.cert_workspace=self.certifications.new()['workspace_id']
        self.project=self.certifications.project_id(self.cert_workspace)
        self.projects=Projects(self.root); self.workspace=self.projects.add(self.project)
        self.store=CommercialDocuments(self.projects,renderer=lambda *args,**kwargs:pdf('Immutable fixture receipt'))
        fields=default_fields('quote'); fields['terms']=''
        fields['lines']=[{'estimate_id':'same-estimate','description':label,'quantity':'1','unit_price':price,'size':'','comments':''}
                         for label,price in [('Paid item','125.25'),('Free item','0'),('Credit item','-5'),('Paid item','125.25')]]
        self.quote=self.save('quote',fields)
        self.receipt=self.store.issue(self.workspace,self.quote['id'],self.quote['version'],str(uuid4()))
        self.quote=self.receipt['document']

    def save(self,kind,fields,previous=None,store=None,workspace=None):
        return (store or self.store).save(workspace or self.workspace,{'id':previous['id'] if previous else str(uuid4()),
            'version':previous['version'] if previous else 0,'kind':kind,'status':'Draft','fields':fields})

    def fields(self):
        fields=default_fields('work_order');fields['details']['project_no']='PN-01'
        fields['order'].update(quote_id=self.quote['id'],quote_reference=self.quote['last_number'])
        fields['work_tracking']=self.store.view(self.workspace,include_quote_totals=True)['quote_rows'][self.quote['id']][self.quote['last_number']]
        return fields

    def test_all_issued_rows_have_stable_unique_ids_and_ignore_changed_quote_draft(self):
        fields=self.fields();before=deepcopy(fields['work_tracking'])
        self.assertEqual([row['unit_price'] for row in before['rows']],['125.25','0','-5','125.25'])
        self.assertEqual(len({row['line_id'] for row in before['rows']}),4)
        changed=deepcopy(self.quote['fields']);changed['lines'][0]['description']='Unissued changed draft'
        self.save('quote',changed,self.quote)
        self.assertEqual(self.fields()['work_tracking'],before)
        self.assertEqual(self.store.read_pdf(self.workspace,self.receipt['id'])[1],self.receipt['pdf'])

    def test_percentages_allow_blank_or_one_to_one_hundred_including_free_credit(self):
        fields=self.fields()
        for row,value in zip(fields['work_tracking']['rows'],['','1','37.5','100']):
            row.update(completed_percent=value,claimed_percent=value)
        saved=self.save('work_order',fields)
        self.assertEqual(saved['fields']['work_tracking'],fields['work_tracking'])
        for invalid in ['0','0.5','100.1','-1','NaN','Infinity','1.1234567',True,None,{}]:
            with self.subTest(invalid=invalid):
                changed=deepcopy(saved['fields']);changed['work_tracking']['rows'][0]['claimed_percent']=invalid
                with self.assertRaises(ValidationError):self.save('work_order',changed,saved)
        self.assertEqual(self.store.capture(self.workspace)['documents'],self.store.view(self.workspace)['documents'])

    def test_claim_has_no_invented_completion_or_cumulative_constraint(self):
        fields=self.fields();fields['work_tracking']['rows'][2]['claimed_percent']='100'
        self.assertEqual(self.save('work_order',fields)['fields']['work_tracking']['rows'][2]['claimed_percent'],'100')

    def test_notes_are_editable_without_changing_issued_prices_or_row_provenance(self):
        fields=self.fields();source=deepcopy(fields['work_tracking'])
        for row,note in zip(fields['work_tracking']['rows'],['Paid note','Free note','Credit note','Duplicate note']):row['notes']=note
        fields['work_tracking']['rows'][0]['completed_percent']='1'
        fields['signatures']={'progress_by':INK};fields['order'].update(progress_by='Progress Signer',progress_date='2026-11-09')
        saved=self.save('work_order',fields)
        changed=deepcopy(saved['fields']);changed['work_tracking']['rows'][2]['notes']='Credit note updated\nSecond line'
        updated=self.save('work_order',changed,saved)
        actual=updated['fields']['work_tracking']
        self.assertEqual(actual['source_hash'],source['source_hash'])
        self.assertEqual([row['line_id'] for row in actual['rows']],[row['line_id'] for row in source['rows']])
        self.assertEqual([row['unit_price'] for row in actual['rows']],['125.25','0','-5','125.25'])
        self.assertEqual(actual['rows'][2]['notes'],'Credit note updated\nSecond line')
        self.assertEqual(updated['fields']['signatures']['progress_by'],INK)
        # Explicit signature clearing owns only its existing signer/date fields.
        cleared=deepcopy(updated['fields']);cleared['signatures']={};cleared['order'].update(progress_by='',progress_date='')
        self.assertEqual(self.save('work_order',cleared,updated)['fields']['work_tracking'],actual)
        for invalid in [None,{},'x'*2001]:
            with self.subTest(invalid=type(invalid).__name__):
                rejected=deepcopy(saved['fields']);rejected['work_tracking']['rows'][0]['notes']=invalid
                with self.assertRaises(ValidationError):validate_fields(rejected,kind='work_order')

    def test_older_window_omitting_notes_preserves_saved_notes_and_explicit_empty_clears(self):
        fields=self.fields()
        for row in fields['work_tracking']['rows']:row.pop('notes')
        saved=self.save('work_order',fields)
        self.assertTrue(all(row['notes']=='' for row in saved['fields']['work_tracking']['rows']))
        changed=deepcopy(saved['fields']);changed['work_tracking']['rows'][0]['notes']='Keep this field from an older window'
        saved=self.save('work_order',changed,saved)
        legacy=deepcopy(saved['fields'])
        for row in legacy['work_tracking']['rows']:row.pop('notes')
        legacy['order']['description']='Unrelated old-window edit'
        saved=self.save('work_order',legacy,saved)
        self.assertEqual(saved['fields']['work_tracking']['rows'][0]['notes'],'Keep this field from an older window')
        changed=deepcopy(saved['fields']);changed['work_tracking']['rows'][0]['notes']=''
        self.assertEqual(self.save('work_order',changed,saved)['fields']['work_tracking']['rows'][0]['notes'],'')

    def test_purchase_site_contact_number_keeps_legacy_name_and_manual_phone(self):
        fields=default_fields('purchase_order');fields['order'].update(ship_to_name='Legacy delivery recipient',site_contact_number='+61 400 123 456 ext 7',ship_to_address='Delivery address')
        saved=self.save('purchase_order',fields)
        self.assertEqual(saved['fields']['order']['site_contact_number'],'+61 400 123 456 ext 7')
        legacy=deepcopy(saved['fields']);legacy['order'].pop('site_contact_number');legacy['order']['payment_terms']='An unrelated old-window edit'
        saved=self.save('purchase_order',legacy,saved)
        self.assertEqual(saved['fields']['order']['ship_to_name'],'Legacy delivery recipient')
        self.assertEqual(saved['fields']['order']['ship_to_address'],'Delivery address')
        self.assertEqual(saved['fields']['order']['site_contact_number'],'+61 400 123 456 ext 7')
        portable=self.store.capture(self.workspace);target=self.projects.add(self.project);self.store.restore(target,portable)
        restored=next(row for row in self.store.view(target)['documents'] if row['id']==saved['id'])
        self.assertEqual(restored['fields']['order'],saved['fields']['order'])
        changed=deepcopy(saved['fields']);changed['order']['site_contact_number']=''
        self.assertEqual(self.save('purchase_order',changed,saved)['fields']['order']['site_contact_number'],'')
        for invalid in [None,{},'x'*61]:
            with self.subTest(invalid=type(invalid).__name__):
                rejected=deepcopy(saved['fields']);rejected['order']['site_contact_number']=invalid
                with self.assertRaises(ValidationError):validate_fields(rejected,kind='purchase_order')
        for kind in ['quote','work_order']:
            rejected=default_fields(kind);rejected['order']['site_contact_number']='123'
            with self.assertRaises(ValidationError):validate_fields(rejected,kind=kind)

    def test_retry_retains_exact_tracking_and_server_rejects_non_quote_receipt(self):
        fields=self.fields();fields['work_tracking']['rows'][0]['completed_percent']='25'
        saved=self.save('work_order',fields)
        retry={'id':saved['id'],'version':0,'kind':'work_order','status':'Draft','fields':fields}
        self.assertEqual(self.store.save(self.workspace,retry),saved)
        issued=self.store.issue(self.workspace,saved['id'],saved['version'],str(uuid4()))
        with self.store._connect() as db:
            self.assertIsNone(self.store._quote_tracking(db,self.project,saved['id'],issued['number']))

    def test_progress_signature_requires_positive_completion_and_optional_closed_signature_does_not(self):
        fields=self.fields();fields['signatures']={'progress_by':INK}
        with self.assertRaisesRegex(ValidationError,'completed percentage'):self.save('work_order',fields)
        fields['work_tracking']['rows'][1]['completed_percent']='1';fields['order'].update(progress_by='Progress Signer',progress_date='2026-11-09')
        saved=self.save('work_order',fields)
        self.assertEqual(saved['fields']['signatures']['progress_by'],INK)
        changed=deepcopy(saved['fields']);changed['work_tracking']['rows'][1]['completed_percent']=''
        with self.assertRaisesRegex(ValidationError,'completed percentage'):self.save('work_order',changed,saved)
        changed['signatures']={'closed_by':INK};changed['order'].update(progress_by='',progress_date='',closed_by='Closure Signer',closed_date='2026-11-10')
        self.assertEqual(self.save('work_order',changed,saved)['fields']['order']['closed_by'],'Closure Signer')

    def test_forged_edited_reordered_and_foreign_baselines_never_write(self):
        fields=self.fields();saved=self.save('work_order',fields)
        before=self.store.capture(self.workspace)
        for mutation in ('description','reorder','project','quote','line_id','strip'):
            changed=deepcopy(saved['fields']);tracking=changed['work_tracking']
            if mutation=='description':
                tracking['rows'][0]['description']='Forged';changed['work_tracking']=template(self.project,self.quote['id'],self.quote['last_number'],tracking['rows'])
            elif mutation=='reorder':
                changed['work_tracking']=template(self.project,self.quote['id'],self.quote['last_number'],list(reversed(tracking['rows'])))
            elif mutation in ('project','quote'):
                changed['work_tracking']=template(str(uuid4()) if mutation=='project' else self.project,str(uuid4()) if mutation=='quote' else self.quote['id'],self.quote['last_number'],tracking['rows'])
            elif mutation=='line_id':tracking['rows'][0]['line_id']='0'*64
            else:changed.pop('work_tracking')
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValidationError):self.save('work_order',changed,saved)
                self.assertEqual(self.store.capture(self.workspace),before)

    def test_snapshot_binding_rejects_cross_project_and_quote_but_accepts_legacy_omissions(self):
        saved=self.save('work_order',self.fields());snapshot=self.store.capture(self.workspace)
        for key in ('project_id','quote_id','quote_reference'):
            changed=deepcopy(snapshot);fields=next(row for row in changed['documents'] if row['id']==saved['id'])['fields'];old=fields['work_tracking']
            args=[old['project_id'],old['quote_id'],old['quote_reference']];args[('project_id','quote_id','quote_reference').index(key)]='Q-99' if key=='quote_reference' else str(uuid4())
            fields['work_tracking']=template(*args,old['rows'])
            with self.assertRaises(ValidationError):validate_commercial_documents(changed)
        legacy=deepcopy(snapshot);fields=next(row for row in legacy['documents'] if row['id']==saved['id'])['fields']
        fields.pop('work_tracking');fields['order']['progress']='Historic narrative';fields['order']['claim']='Historic claim'
        for key in ('progress_by','progress_date','closed_date'):fields['order'].pop(key)
        original=deepcopy(legacy);self.assertEqual(validate_commercial_documents(legacy),legacy);self.assertEqual(legacy,original)

    def test_status_choices_and_unchanged_legacy_text(self):
        fields=self.fields();fields['order'].update(certification='Certification not issued',completion='On hold')
        saved=self.save('work_order',fields)
        changed=deepcopy(saved['fields']);changed['order']['completion']='Invented value'
        with self.assertRaises(ValidationError):self.save('work_order',changed,saved)
        snapshot=self.store.capture(self.workspace);old=next(row for row in snapshot['documents'] if row['id']==saved['id']);old['fields']['order'].update(certification='Old certification narrative',completion='Old completion narrative')
        target=self.projects.add(self.project);self.store.restore(target,snapshot)
        restored=next(row for row in self.store.view(target)['documents'] if row['id']==saved['id'])
        changed=deepcopy(restored['fields']);changed['order']['description']='Unrelated legacy update'
        result=self.save('work_order',changed,restored,workspace=target)
        self.assertEqual(result['fields']['order']['completion'],'Old completion narrative')

    def test_project_export_import_cold_cache_keeps_baseline_percentages_and_can_issue_new_pdf(self):
        fields=self.fields();fields['work_tracking']['rows'][0].update(completed_percent='40',claimed_percent='80',notes='Portable paid progress note')
        fields['work_tracking']['rows'][1]['notes']='Portable free progress note';fields['work_tracking']['rows'][2]['notes']='Portable credit progress note'
        fields['order'].update(progress='Legacy progress stays stored',claim='Legacy claim stays stored',progress_by='Progress Signer',progress_date='2026-11-09',closed_by='Closed Signer',closed_date='2026-11-10',certification='Certification issued',completion='Completed')
        fields['signatures']={'progress_by':INK,'closed_by':INK}
        saved=self.save('work_order',fields)
        self.store.renderer=render_commercial_pdf
        historic=self.store.issue(self.workspace,saved['id'],saved['version'],str(uuid4()),company=DEFAULTS)
        saved=historic['document']
        manifest=self.certifications.capture({'workspace_id':self.cert_workspace,'draft':None})
        encoded=export_project(self.catalog,{'estimate':{'title':'Portable tracking fixture'},'certifications':manifest,'commercial_documents':self.store.capture(self.workspace)})
        target_catalog=Store(self.root/'cold'/'store.sqlite3');loaded=load_project_bytes(target_catalog,encoded)
        target_projects=Projects(self.root/'cold');workspace=target_projects.add(self.project)
        target=CommercialDocuments(target_projects)
        target.restore(workspace,loaded['commercial_documents'])
        with target._connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM commercial_issued').fetchone()[0],0)
        restored=next(row for row in target.view(workspace)['documents'] if row['id']==saved['id'])
        self.assertEqual(restored['fields'],saved['fields'])
        # New uploads cannot nominate an invented cold-cache source baseline.
        forged=deepcopy(restored['fields']);old=forged['work_tracking'];old['rows'][0]['description']='Changed import source';forged['work_tracking']=template(self.project,self.quote['id'],self.quote['last_number'],old['rows'])
        with self.assertRaises(ValidationError):self.save('work_order',forged,restored,store=target,workspace=workspace)
        changed=deepcopy(restored['fields']);changed['work_tracking']['rows'][2]['claimed_percent']='100'
        updated=self.save('work_order',changed,restored,store=target,workspace=workspace)
        request=str(uuid4());issued=target.issue(workspace,updated['id'],updated['version'],request,company=DEFAULTS)
        text='\n'.join(page.extract_text() for page in PdfReader(BytesIO(issued['pdf'])).pages)
        normalized=' '.join(text.split())
        for value in ('Free item','Credit item','40','80','100','Progress Signer','Closed Signer','2026-11-10','Certification issued','Completed','Legacy progress stays stored','Portable paid progress note','Portable free progress note','Portable credit progress note'):self.assertIn(value,normalized)
        self.assertEqual(target.issue(workspace,updated['id'],updated['version'],request,company=DEFAULTS)['pdf'],issued['pdf'])
        self.assertEqual(self.store.read_pdf(self.workspace,historic['id'])[1],historic['pdf'])
        import os
        if os.environ.get('CLASSIFIRE_TRACKING_PDF'):Path(os.environ['CLASSIFIRE_TRACKING_PDF']).write_bytes(issued['pdf'])

    def test_legacy_cold_cache_without_receipt_cannot_accept_client_baseline(self):
        fields=self.fields();tracking=fields.pop('work_tracking');saved=self.save('work_order',fields)
        projects=Projects(self.root/'cold');workspace=projects.add(self.project);target=CommercialDocuments(projects)
        target.restore(workspace,self.store.capture(self.workspace))
        fields=deepcopy(saved['fields']);fields['work_tracking']=tracking
        with self.assertRaisesRegex(ValidationError,'unavailable'):self.save('work_order',fields,saved,store=target,workspace=workspace)
        self.assertIsNone(target.view(workspace,include_quote_totals=True)['quote_rows'][self.quote['id']][self.quote['last_number']])

    def test_deprecated_transport_retained_in_data_but_absent_in_new_quote_pdf(self):
        fields=deepcopy(self.quote['fields']);fields['rate_schedule']['rates']['access_equipment_transport']='98765'
        document={**self.quote,'fields':fields}
        text='\n'.join(page.extract_text() for page in PdfReader(BytesIO(render_commercial_pdf(document,'Q-01',company=DEFAULTS))).pages)
        self.assertNotIn('Access Equipment Transport',text);self.assertNotIn('98,765',text)
        self.assertEqual(validate_fields(fields,kind='quote')['rate_schedule']['rates']['access_equipment_transport'],'98765')

    def test_tracking_pdf_splits_a_maximum_length_description_without_losing_rows(self):
        fields=self.fields();long_line={**fields['work_tracking']['rows'][0],'description':('Long description with line wrapping. '*170)[:6000]}
        fields['work_tracking']=template(self.project,self.quote['id'],self.quote['last_number'],[long_line,fields['work_tracking']['rows'][2]])
        document={'kind':'work_order','fields':fields,'status':'Draft'}
        content=render_commercial_pdf(document,'WO-01',company=DEFAULTS)
        pages=PdfReader(BytesIO(content)).pages
        text='\n'.join(page.extract_text() for page in pages)
        self.assertGreater(len(pages),3)
        self.assertEqual(text.count('Credit item'),2)
