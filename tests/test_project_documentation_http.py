"""Final authored bytes, immutable retries and current-project HTTP isolation."""
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path
import unittest
import threading
import uuid
from unittest.mock import patch

from openpyxl import load_workbook

from estimator.company_settings import DEFAULTS
from estimator.documentation_catalog import document_catalog, export_identity
import test_certification_http as helpers
from test_certification_http import cover, pdf, texts
from estimator.pricing_workbook import COMBINED_SHEET


class DocumentationHTTPTests(unittest.TestCase):
    setUp = helpers.CertificationHTTPTests.setUp
    tearDown = helpers.CertificationHTTPTests.tearDown
    request = helpers.CertificationHTTPTests.request
    json = helpers.CertificationHTTPTests.json

    def workspace(self):
        return self.json('POST','/api/certifications/workspaces',{},expected=201)['workspace_id']

    def headers(self, workspace, operation=None):
        return {'X-Estimator-Documentation-Workspace':workspace,
                'X-Estimator-Documentation-Request':operation or str(uuid.uuid4())}

    def retained(self, workspace):
        return self.json('GET','/api/documentation?workspace='+workspace)

    def test_catalog_and_explicit_scope_exclude_unrelated_global_certificates(self):
        self.json('POST','/api/certifications',{'fields':self.fields},expected=201)
        current = self.workspace()
        self.assertEqual(self.retained(current)['items'],[])
        catalog = self.json('GET','/api/documentation/catalog')['documents']
        self.assertEqual(catalog,document_catalog('full'))
        self.assertEqual(len({row['id'] for row in catalog}),len(catalog))
        for asset, media in [('/documentation.js','text/javascript'),('/documentation.css','text/css')]:
            status, headers, content = self.request('GET',asset)
            self.assertEqual(status,200,content)
            self.assertTrue(headers['Content-Type'].startswith(media),headers)
        self.json('GET','/api/documentation',expected=400)
        self.json('GET','/api/documentation?workspace='+current+'&workspace='+current,expected=400)
        self.assertIn(self.request('GET','/api/documentation?workspace='+str(uuid.uuid4()))[0],{400,404})

    def test_actual_xlsx_exports_append_only_in_the_captured_project_and_read_without_new_revision(self):
        a,b=self.workspace(),self.workspace()
        destination=Path(self.temp.name)/'Downloads'
        with patch('estimator.download_files.standard_downloads_directory',return_value=destination):
            status,_,payload=self.request('POST','/api/pricing/export',{'download':{'project_token':None}},self.headers(a))
            self.assertEqual(status,200,payload)
            receipt=json.loads(payload)
            self.assertTrue(receipt['saved'])
            item=receipt['documentation']['item']
            self.assertEqual(item['revision'],1)
            saved=Path(receipt['path']).read_bytes()
            workbook=load_workbook(BytesIO(saved),read_only=True)
            self.assertIn('Manufacturer',list(next(workbook[COMBINED_SHEET].values)))
            workbook.close()
            self.assertEqual(self.request('GET',item['url'])[2],saved)
            self.assertEqual(self.request('GET',item['url'].replace(a,b))[0],404)
            self.assertEqual(self.retained(b)['items'],[])
            self.assertEqual(self.retained(a)['workspace_revision'],1)
            status,_,payload=self.request('POST','/api/pricing/export',{'download':{'project_token':None}},self.headers(a))
            self.assertEqual(status,200,payload)
            self.assertEqual(json.loads(payload)['documentation']['item']['revision'],2)
            self.assertEqual(self.request('GET',item['url'])[2],saved)
            self.assertEqual(self.retained(a)['workspace_revision'],2)

    def test_final_covers_are_frozen_and_exact_replay_bypasses_renderer_and_later_settings(self):
        workspace=self.workspace();operation=str(uuid.uuid4())
        self.json('POST','/api/company-settings',{**DEFAULTS,'cover_pdf':cover('ORIGINAL MAIN'),'cover_pdf_name':'Main.pdf'})
        self.json('POST','/api/pdf-covers/estimate',{'cover_pdf':cover('ORIGINAL SPECIFIC'),'cover_pdf_name':'Specific.pdf','expected_version':1})
        body={'inputs':{}}
        with patch('estimator.report.render_quote_pdf',return_value=pdf('ORIGINAL BODY')):
            status,headers,payload=self.request('POST','/api/quote-report',body,self.headers(workspace,operation))
        self.assertEqual(status,200,payload)
        self.assertIn('BREAKDOWN-R1.pdf',headers['Content-Disposition'])
        self.assertEqual([value.strip() for value in texts(payload)],['ORIGINAL MAIN','ORIGINAL SPECIFIC','ORIGINAL BODY'])
        first=self.retained(workspace)['items'][0]
        self.json('POST','/api/company-settings',{**DEFAULTS,'cover_pdf':cover('CHANGED MAIN'),'cover_pdf_name':'New.pdf'})
        with patch('estimator.report.render_quote_pdf',side_effect=AssertionError('An exact replay must not render again.')):
            status,replay_headers,replayed=self.request('POST','/api/quote-report',body,self.headers(workspace,operation))
        self.assertEqual(status,200,replayed)
        self.assertEqual(replay_headers['Content-Disposition'],headers['Content-Disposition'])
        self.assertEqual(replayed,payload)
        self.assertEqual(self.retained(workspace)['workspace_revision'],1)
        self.assertEqual(self.request('GET',first['url'])[2],payload)
        self.assertEqual(self.request('POST','/api/quote-report',{'inputs':{'B8':2}},self.headers(workspace,operation))[0],409)

    def test_certificate_revisions_are_derived_from_the_same_project_scope(self):
        a,b=self.workspace(),self.workspace();scope='?workspace='+a
        document=self.json('POST','/api/certifications'+scope,{'fields':self.fields},expected=201)
        generated=self.json('POST','/api/certifications/'+document['id']+'/revisions'+scope,
            {'fields':self.fields,'expected_version':1,'request_id':str(uuid.uuid4())},expected=201)
        view=self.retained(a)
        self.assertEqual(view['workspace_revision'],0,'Certificate PDFs remain in their existing store.')
        self.assertEqual(len(view['items']),1)
        item=view['items'][0]
        self.assertEqual(item['kind'],'certification')
        self.assertEqual(self.request('GET',item['url'])[2],self.request('GET',generated['revision']['pdf_url'])[2])
        self.assertEqual(self.request('GET',item['url'].replace(a,b))[0],404)
        self.assertEqual(self.retained(b)['items'],[])

    def test_concurrent_same_operation_saves_only_the_winning_immutable_bytes(self):
        workspace=self.workspace();operation=str(uuid.uuid4());barrier=threading.Barrier(2);lock=threading.Lock();calls=[]
        def render(*args,**kwargs):
            with lock:
                number=len(calls);calls.append(number)
            barrier.wait(timeout=20)
            return pdf('Concurrent generated output '+str(number))
        body={'inputs':{},'download':{'project_token':None}}
        with patch('estimator.report.render_quote_pdf',side_effect=render),patch(
                'estimator.download_files.standard_downloads_directory',return_value=Path(self.temp.name)/'Concurrent downloads'):
            with ThreadPoolExecutor(max_workers=2) as pool:
                replies=list(pool.map(lambda _:self.request('POST','/api/quote-report',body,self.headers(workspace,operation)),range(2)))
        receipts=[]
        for status,_,payload in replies:
            self.assertEqual(status,200,payload);receipts.append(json.loads(payload))
        self.assertEqual(len(calls),2,'Both preparations deliberately pass the early replay check.')
        self.assertEqual(self.retained(workspace)['workspace_revision'],1)
        first,second=receipts
        self.assertEqual(first['documentation']['item'],second['documentation']['item'])
        frozen=self.request('GET',first['documentation']['item']['url'])[2]
        for receipt in receipts:
            saved=Path(receipt['path']).read_bytes()
            self.assertEqual(saved,frozen)
            self.assertEqual(sha256(saved).hexdigest(),receipt['documentation']['item']['sha256'])

    def test_history_headers_reject_unsupported_actions_and_cross_origin_requests(self):
        workspace=self.workspace()
        self.assertEqual(self.request('POST','/api/calculate',{'inputs':{}},self.headers(workspace))[0],400)
        self.assertEqual(self.request('POST','/api/pricing/export',{},self.headers(workspace)|{'Origin':'https://unrelated.example'})[0],403)
        self.assertEqual(self.request('POST','/api/pricing/export',{}, {'X-Estimator-Documentation-Workspace':workspace})[0],400)
        self.assertEqual(self.retained(workspace)['items'],[])


class DocumentCatalogTests(unittest.TestCase):
    def test_server_source_classification_is_independent_of_filename_and_caller_labels(self):
        self.assertEqual(export_identity('/api/quote-report',{'kind':'forged','filename':'other.xlsx'}),('estimate.summary.pdf',''))
        self.assertEqual(export_identity('/api/technical/item.pdf',{'id':'promat-example'}),('library.technical.item.pdf','promat-example'))
        self.assertEqual(export_identity('/api/penetration/item.xlsx',{'item':{'id':'composer','library_item_id':'record-1'}}),('firestopping.current_item.xlsx','record-1'))
        self.assertIsNone(export_identity('/api/calculate',{}))
        full,standard=document_catalog('full'),document_catalog('standard')
        self.assertTrue(any(row['id'].startswith('takeoff.') for row in full))
        self.assertFalse(any(row['id'].startswith('takeoff.') for row in standard))
