from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from pypdf import PdfReader
from test_pdf_download_covers import signed_options
from estimator.catalog import ValidationError
from estimator.certification import CertificationService, FIELDS
from estimator.certification_projects import CertificationProjects
from estimator.commercial_documents import CommercialDocuments, default_fields
from estimator.company_settings import DEFAULTS
from estimator.document_numbers import migrate_saved_orders
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from estimator.swms import SwmsDocuments, default_fields as swms_fields
from swms_ready_fixtures import complete_swms
from commercial_ready_fixtures import complete_quote, complete_work_order


def uid():
    return str(uuid.uuid4())


class DocumentNumberingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root/'app.sqlite3')
        self.certs = CertificationProjects(CertificationService(self.store))
        self.numbers = self.certs.numbering
        self.commercial = CommercialDocuments(self.certs)
        self.swms = SwmsDocuments(self.certs)
        self.workspace = self.certs.new()['workspace_id']

    def configure(self, **changes):
        settings = {k:{'prefix':v['prefix'],'start_number':v['start_number']} for k,v in self.numbers.settings().items()}
        for kind,(prefix, start) in changes.items():
            settings[kind] = {'prefix':prefix, 'start_number':start}
        return self.numbers.save_settings(settings)

    def order(self, kind, workspace=None, quote=None):
        fields = default_fields(kind, {'project_no':'PN-00001'})
        fields['terms'] = '<p>N / A</p>'
        if kind == 'quote':
            fields = complete_quote(fields)
        elif kind == 'work_order':
            fields = complete_work_order(fields)
        if quote:
            fields['order']['quote_id'] = quote['id']
        return self.commercial.save(workspace or self.workspace, {'id':uid(), 'kind':kind,'status':'Draft','version':0,'fields':fields})

    def issue(self, row):
        return self.commercial.issue(self.workspace, row['id'], row['version'], uid())

    def test_configured_independent_numbers_retries_and_portable_certification(self):
        self.configure(quote=('qt',41), work_order=('job',7), purchase_order=('buy',8), swms=('safe',9), certification=('inst',10))
        q = self.order('quote')
        self.assertEqual(q['last_number'], '')
        with patch.object(self.commercial,'renderer',side_effect=ValueError('unavailable')):
            with self.assertRaises(ValueError):
                self.issue(q)
        receipt = self.issue(q)
        q = receipt['document']
        self.assertEqual(q['last_number'], 'QT-41')
        with ThreadPoolExecutor(max_workers=3) as pool:
            orders = list(pool.map(lambda _:self.order('work_order', quote=q),range(3)))
        self.assertEqual({o['reference'] for o in orders},{'JOB-07','JOB-08','JOB-09'})
        wo = orders[0]
        self.assertEqual(wo['fields']['order']['quote_reference'],'QT-41')
        self.assertEqual(self.issue(wo)['number'],wo['reference'])
        po = self.order('purchase_order')
        first = self.issue(po); second = self.issue(first['document'])
        self.assertEqual((po['reference'], first['number'],second['number']),('BUY-08','BUY-08','BUY-08'))
        self.assertNotEqual(first['filename'],second['filename'])
        self.assertIn('BUY-08',PdfReader(BytesIO(second['pdf'])).pages[0].extract_text())
        from estimator.native_dialogs import SaveSelection
        from test_project_library import Chooser
        chooser = Chooser(); chooser.selection = SaveSelection(str(self.root/'Numbered project.cf.json'), None)
        library = ProjectLibrary(self.store, chooser, certifications=self.certs)
        try:
            library.save_as({'estimate': {'project_no':'PN-FIXTURE','client':'Synthetic Company','site_address':'Synthetic Site',
                                         'contact_name':'Synthetic Contact','contact_phone':'0400 000 001','contact_email':'project@example.test'},
                'certifications': {'workspace_id':self.workspace,'draft':None}})
        finally:
            library.close()
        p = {'id':uid(),'version':0, 'status':'Draft', 'fields':complete_swms(swms_fields())}
        swms = self.swms.save(self.workspace,p)
        self.assertEqual(swms['reference'],'SAFE-09')
        self.assertEqual(self.swms.save(self.workspace,p),swms)
        data = self.swms.issue(self.workspace,swms['id'],1,uid())
        self.assertIn('SAFE-09',' '.join(page.extract_text() for page in PdfReader(BytesIO(data['pdf'])).pages))
        service = self.certs.service(self.workspace)
        values = {key:'Example' for key in FIELDS}
        request = uid()
        cert = service.create(values,request)
        self.assertEqual(cert['reference'],'INST-10')
        self.assertEqual(service.create(values,request)['reference'],'INST-10')
        rev = service.generate(cert['id'], values, cert['version'], uid(), DEFAULTS, options=signed_options())
        self.assertIn('INST-10', PdfReader(BytesIO(service.revision_pdf(cert['id'],rev['revision']['revision']))).pages[0].extract_text())
        archive = self.certs.capture({'workspace_id':self.workspace,'draft':None})
        self.assertEqual(self.certs.restore(archive)['items'][0]['reference'],'INST-10')
        self.configure(work_order=('other',1),purchase_order=('buy',1))
        self.assertEqual(self.order('work_order',quote=q)['reference'],'OTHER-01')
        self.assertEqual(self.order('purchase_order')['reference'],'BUY-09')
        self.configure(work_order=('job',1))
        self.assertEqual(self.order('work_order',quote=q)['reference'],'JOB-10')
        self.assertEqual(self.issue(q)['number'],'QT-42')

    def test_new_quote_series_starts_at_one_and_legacy_import_cannot_advance_it(self):
        with self.commercial._connect() as db:
            self.numbers.attach(db)
            self.numbers.observe_reference(db,'quote','Q-000010')
        self.assertEqual(self.numbers.settings()['quote']['next_reference'],'Q-01')
        quote = self.order('quote'); issued = self.issue(quote)
        self.assertEqual(issued['number'],'Q-01')
        snapshot = self.commercial.capture(self.workspace)
        legacy = deepcopy(snapshot); legacy.pop('short_quote_counters',None)
        legacy['number_counters']['quote'] = 100
        legacy['reference_counters'] = {'quote':{'Q':100}}
        legacy['documents'][0]['last_number'] = 'Q-000100'
        imported = self.certs.new()['workspace_id']; legacy['project_id'] = self.certs.project_id(imported)
        self.commercial.restore(imported,legacy)
        self.assertEqual(self.numbers.settings()['quote']['next_reference'],'Q-02')
        self.assertEqual(self.commercial.capture(imported)['documents'][0]['last_number'],'Q-000100')
        self.assertEqual(self.commercial.read_pdf(self.workspace,issued['id'])[1],issued['pdf'])

    def test_short_quote_deleted_high_watermark_survives_portable_restore(self):
        quote = self.order('quote'); first = self.issue(quote); second = self.issue(first['document'])
        self.assertEqual((first['number'],second['number']),('Q-01','Q-02'))
        self.commercial.delete(self.workspace,quote['id'],second['document']['version'])
        snapshot = self.commercial.capture(self.workspace)
        self.assertEqual(snapshot['documents'],[])
        self.assertEqual(snapshot['short_quote_counters'],{'Q':2})
        other_store = Store(self.root/'other.sqlite3')
        other_certs = CertificationProjects(CertificationService(other_store))
        other = CommercialDocuments(other_certs)
        workspace = other_certs.new()['workspace_id']; snapshot['project_id'] = other_certs.project_id(workspace)
        other.restore(workspace,snapshot)
        self.assertEqual(other.numbering.settings()['quote']['next_reference'],'Q-03')
        from estimator.commercial_documents import validate_commercial_documents
        for bad in ({'Q':True},{'Q':0},{'../Q':2}):
            invalid=deepcopy(snapshot);invalid['short_quote_counters']=bad
            with self.assertRaises(ValidationError): validate_commercial_documents(invalid)

    def test_exact_historic_quote_label_collision_is_skipped_in_preview_and_allocation(self):
        with self.commercial._connect() as db:
            self.numbers.attach(db)
            self.numbers.observe_reference(db,'quote','Q-100000')
        self.configure(quote=('Q',100000))
        self.assertEqual(self.numbers.settings()['quote']['next_reference'],'Q-100001')
        self.assertEqual(self.issue(self.order('quote'))['number'],'Q-100001')


    def test_counter_only_legacy_history_reserves_the_six_digit_overlap(self):
        with self.commercial._connect() as db:
            self.numbers.attach(db)
            self.numbers.observe(db,'quote','Q',200000)
        self.configure(quote=('Q',100000))
        self.assertEqual(self.numbers.settings()['quote']['next_reference'],'Q-200001')
        self.assertEqual(self.issue(self.order('quote'))['number'],'Q-200001')

    def test_concurrent_short_quote_issues_and_exact_retries_use_distinct_numbers(self):
        quotes = [self.order('quote') for _ in range(3)]
        requests = [uid() for _ in quotes]
        def issue(pair):
            quote, request = pair
            return self.commercial.issue(self.workspace,quote['id'],quote['version'],request)
        with ThreadPoolExecutor(max_workers=3) as pool:
            issued=list(pool.map(issue,zip(quotes,requests)))
        self.assertEqual({row['number'] for row in issued},{'Q-01','Q-02','Q-03'})
        for pair,result in zip(zip(quotes,requests),issued):
            replay=issue(pair)
            self.assertEqual((replay['number'],replay['pdf']),(result['number'],result['pdf']))
        self.assertEqual(self.numbers.settings()['quote']['next_reference'],'Q-04')

    def test_folder_migration_is_repeatable_preserves_content_and_updates_linked_po(self):
        folder = self.root / 'projects'; folder.mkdir()
        self.store.set_project_folder(folder)
        library = ProjectLibrary(self.store, certifications=self.certs)
        self.addCleanup(library.close)
        library.commercial = self.commercial
        files = []
        for index in range(2):
            ws = self.certs.new()['workspace_id']
            pid = self.certs.project_id(ws)
            date = f'2026-01-0{index+1}T00:00:00+00:00'
            base = {'version':1,'status':'Draft','created_at':date,'updated_at':date,'last_number':''}
            details = {'project_no':f'PN-0000{index+1}'}
            q = {**base,'id':uid(),'kind':'quote','fields':default_fields('quote',details),'last_number':f'Q-00000{index+1}'}
            wo = {**base,'id':uid(),'kind':'work_order','fields':default_fields('work_order',details)}
            old = f"PN{index+1}Q{index+1}-01"
            wo['fields']['order'].update(quote_id=q['id'],quote_reference=q['last_number'],work_order_reference=old)
            po = {**base,'id':uid(),'kind':'purchase_order','fields':default_fields('purchase_order',details)}
            po['fields']['order'].update(work_order_id=wo['id'],work_order_reference=old)
            manifest=self.certs.capture({'workspace_id':ws,'draft':None})
            path = folder/f'project-{index}.cf.json'
            self.certs.publish(manifest, path)
            path.write_bytes(export_project(self.store,{'estimate':{'title':'Migration fixture',**details},'certifications':manifest,
                'commercial_documents':{'version':1,'project_id':pid,'number_counters':{'quote':2,'work_order':0,'purchase_order':0},'documents':[q,wo,po]}}))
            files.append((path,json.loads(path.read_bytes()),wo['id']))
        historical = folder/'issued.pdf'; historical.write_bytes(b'%PDF-immutable test content')
        result = migrate_saved_orders(library)
        while result['scan_pending']:
            result = migrate_saved_orders(library)
        self.assertEqual((result['updated_files'], result['updated_orders'],result['errors']),(2,4,[]))
        for index,(path,previous,wo_id) in enumerate(files,1):
            new = json.loads(path.read_bytes())
            expected = deepcopy(previous)
            for doc in expected['commercial_documents']['documents']:
                if doc['kind'] == 'quote':
                    continue
                doc['reference'] = ('WO' if doc['kind']=='work_order' else 'PO') + f'-{index:02}'
                doc['fields']['order']['work_order_reference'] = f'WO-{index:02}'
                if doc['kind']=='purchase_order':
                    self.assertEqual(doc['fields']['order']['work_order_id'],wo_id)
            self.assertEqual(new, expected)
        self.assertEqual(migrate_saved_orders(library)['updated_files'],0)
        self.assertEqual(historical.read_bytes(),b'%PDF-immutable test content')
        self.assertEqual(self.issue(self.order('quote'))['number'], 'Q-01')


class CombinedNumberingTests(unittest.TestCase):
    def setUp(self):
        from estimator.document_numbers import DocumentNumbers
        from estimator.project_details import ProjectDetails
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.numbers = DocumentNumbers(root/'documents.sqlite3')
        self.projects = ProjectDetails(root/'projects.sqlite3'); self.addCleanup(self.projects.close)

    def values(self):
        all_settings = self.numbers.combined_settings(self.projects)
        return {'project':{key:all_settings['project'][key] for key in ('prefix','start_number')},
                'documents':{kind:{key:value[key] for key in ('prefix','start_number')} for kind,value in all_settings['documents'].items()}}

    def test_combined_validation_never_partially_saves_settings(self):
        before = self.numbers.combined_settings(self.projects)
        values = self.values(); values['documents']['work_order']['prefix'] = 'JOB'
        values['project']['start_number'] = True
        with self.assertRaises(ValidationError): self.numbers.save_combined_settings(self.projects, values)
        self.assertEqual(self.numbers.combined_settings(self.projects),before)
        values = self.values(); values['project']['prefix'] = 'NEW'; values['documents']['quote']['start_number'] = 0
        with self.assertRaises(ValidationError): self.numbers.save_combined_settings(self.projects, values)
        self.assertEqual(self.numbers.combined_settings(self.projects),before)
        for bad in ({}, {'project':values['project'],'documents':values['documents'],'extra':True}):
            with self.assertRaises(ValidationError): self.numbers.save_combined_settings(self.projects,bad)

    def test_second_database_failure_rolls_back_first_database_settings(self):
        before = self.numbers.combined_settings(self.projects)
        with self.projects.connect() as db:
            db.execute("CREATE TRIGGER fail_update BEFORE UPDATE ON preferences WHEN NEW.prefix='FAIL' BEGIN SELECT RAISE(ABORT,'injected project write failure'); END")
        values = self.values(); values['documents']['quote']['prefix'] = 'QT'; values['project']['prefix'] = 'FAIL'
        with self.assertRaises(sqlite3.IntegrityError): self.numbers.save_combined_settings(self.projects,values)
        self.assertEqual(self.numbers.combined_settings(self.projects),before)
        values['project']['prefix'] = 'SITE'; values['project']['start_number'] = 42
        saved = self.numbers.save_combined_settings(self.projects,values)
        self.assertEqual(saved['project']['next_reference'],'SITE-42')
        self.assertEqual(saved['documents']['quote']['next_reference'],'QT-01')

    def test_combined_get_holds_one_snapshot_across_concurrent_save(self):
        from threading import Event
        old = self.numbers.combined_settings(self.projects)
        values = self.values(); values['project']['prefix'] = 'SITE'; values['documents']['quote']['prefix'] = 'QT'
        original = self.projects.settings_from_connection
        started = Event(); futures = []; scheduled = False
        with ThreadPoolExecutor(max_workers=1) as pool:
            def save():
                started.set()
                return self.numbers.save_combined_settings(self.projects,values)
            def project_read(db,schema=''):
                nonlocal scheduled
                self.assertTrue(db.in_transaction)
                value = original(db,schema)
                if not scheduled:
                    scheduled = True; futures.append(pool.submit(save))
                    self.assertTrue(started.wait(5))
                    self.assertFalse(futures[0].done())
                return value
            with patch.object(self.projects,'settings_from_connection',side_effect=project_read):
                observed = self.numbers.combined_settings(self.projects)
                saved = futures[0].result(timeout=10)
        self.assertEqual(observed,old)
        self.assertEqual((saved['project']['prefix'],saved['documents']['quote']['prefix']),('SITE','QT'))

    def test_save_response_uses_the_write_transaction_snapshot(self):
        original=self.numbers._combined_settings; transactions=[]
        def capture(db,projects):
            transactions.append(db.in_transaction)
            return original(db,projects)
        values=self.values();values['project']['prefix']='ABC';values['documents']['quote']['prefix']='QT'
        with patch.object(self.numbers,'_combined_settings',side_effect=capture):
            saved=self.numbers.save_combined_settings(self.projects,values)
        self.assertEqual(transactions,[True])
        self.assertEqual((saved['project']['prefix'],saved['documents']['quote']['prefix']),('ABC','QT'))

    def test_exhausted_preview_stays_editable_and_new_prefix_recovers(self):
        from estimator.document_numbers import LIMIT
        with closing(sqlite3.connect(self.numbers.path)) as db, db:
            db.execute("INSERT INTO series VALUES('quote_short','Q',?)",(LIMIT,))
        exhausted=self.numbers.combined_settings(self.projects)
        self.assertEqual(exhausted['documents']['quote']['next_reference'],'')
        self.assertTrue(exhausted['documents']['quote']['exhausted'])
        with closing(sqlite3.connect(Path(self.temp.name)/'owner.sqlite3')) as db, db:
            self.numbers.attach(db);self.numbers.initialize_history(db)
            with self.assertRaisesRegex(ValidationError,'exhausted'):
                self.numbers.assign(db,'quote','owner')
        values=self.values();values['documents']['quote']['prefix']='QT'
        saved=self.numbers.save_combined_settings(self.projects,values)
        self.assertEqual(saved['documents']['quote']['next_reference'],'QT-01')
