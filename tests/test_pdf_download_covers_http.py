"""Every authored PDF download kind uses explicit Settings covers at its boundary."""
from contextlib import ExitStack
from io import BytesIO
import json
import unittest
import uuid
from unittest.mock import patch

from pypdf import PdfReader

from estimator.company_settings import DEFAULTS
from estimator.pdf_download_covers import KINDS, SETTINGS_KINDS
from estimator.project_library import ProjectLibrary
from estimator.takeoff_workspace import TakeoffService
import test_certification_http as helpers
from test_certification_http import pdf,cover,texts
from test_pdf_download_covers import signature


class PdfDownloadCoversHTTPTests(unittest.TestCase):
    setUp=helpers.CertificationHTTPTests.setUp
    tearDown=helpers.CertificationHTTPTests.tearDown
    request=helpers.CertificationHTTPTests.request
    json=helpers.CertificationHTTPTests.json

    def test_cover_api_methods_origins_validation_cas_and_persistent_clear(self):
        items=self.json('GET','/api/pdf-covers')['items']
        self.assertEqual([(row['kind'],row['label']) for row in items],list(SETTINGS_KINDS))
        body={'cover_pdf':cover('SPECIFIC'),'cover_pdf_name':'Specific.pdf','expected_version':1}
        saved=self.json('POST','/api/pdf-covers/estimate',body)
        self.assertEqual(saved['version'],2)
        self.assertEqual(self.json('POST','/api/pdf-covers/estimate',body),saved)
        self.json('POST','/api/pdf-covers/estimate',{**body,'cover_pdf_name':'Other.pdf'},expected=409)
        self.assertEqual(self.request('POST','/api/pdf-covers/estimate',body,headers={'Origin':'https://foreign.example'})[0],403)
        self.assertEqual(self.request('PUT','/api/pdf-covers/estimate',body)[0],405)
        self.json('POST','/api/pdf-covers/unknown',body,expected=400)
        self.json('POST','/api/pdf-covers/estimate',{**body,'extra':True},expected=400)
        self.json('POST','/api/pdf-covers/estimate',{'cover_pdf':None,'cover_pdf_name':'','expected_version':2})
        self.assertFalse(next(row for row in self.json('GET','/api/pdf-covers')['items'] if row['kind']=='estimate')['has_cover'])
        self.assertTrue(all('cover_pdf' not in row for row in self.json('GET','/api/pdf-covers')['items']))

    def test_all_eighteen_authored_pdf_kinds_get_main_specific_content_in_order(self):
        self.json('POST','/api/company-settings',{**DEFAULTS,'cover_pdf':cover('COMPANY MAIN'),'cover_pdf_name':'Main.pdf'})
        for kind,_ in KINDS:self.json('POST','/api/pdf-covers/'+kind,{'cover_pdf':cover('SPECIFIC '+kind),'cover_pdf_name':kind+'.pdf','expected_version':1})
        body=pdf('BODY CONTENT');session=self.json('POST','/api/takeoffs/sessions',{})['session_id'];covered=set()
        cases=[('estimate','/api/quote-report',{'inputs':{}}),
               ('full_schedule','/api/project/full-schedule.pdf',{}),
               ('full_product_summary','/api/project/full-product-summary.pdf',{}),
               ('technical_library_item','/api/technical/item.pdf',{}),
               ('firestopping_library_item','/api/penetration/item.pdf',{}),
               ('firestopping_schedule','/api/penetration/report.pdf',{'draft':{}})]
        for calculator in ('steel_vermiculite','steel_intumescent','steel_board','ductwork'):
            cases.extend([(calculator+'_schedule',f'/api/calculators/{calculator}/report.pdf',{}),
                          (calculator+'_product_summary',f'/api/calculators/{calculator}/summary.pdf',{})])
        prefix='/api/takeoffs/sessions/'+session
        cases.extend([('takeoff_markups',prefix+'/export/marked-pdf',{}),
                      ('takeoff_markups',prefix+'/export/markup-pdf',{}),
                      ('physical_matrix',prefix+'/physical/export/pdf',{}),
                      ('pdf_tools',prefix+'/pdf-tools',{})])
        with ExitStack() as stack:
            for target in ('estimator.report.render_quote_pdf','estimator.project_reports.build_project_report',
                    'estimator.technical_item_exports.render_technical_item_pdf','estimator.penetration_item_exports.render_item_pdf',
                    'estimator.penetration_report.render_penetration_pdf','estimator.calculator_report.build_calculator_report',
                    'estimator.calculator_report.build_calculator_summary_report','estimator.certification_report.render_certificate_pdf'):
                stack.enter_context(patch(target,return_value=body))
            stack.enter_context(patch('estimator.technical_item_exports.prepare_technical_item',return_value={}))
            stack.enter_context(patch('estimator.penetration_item_exports.prepare_item_snapshot',return_value={}))
            stack.enter_context(patch('estimator.penetration_calculator.calculate',return_value={'definition':{}}))
            stack.enter_context(patch('estimator.workbook_calculators.validate_calculator_edits',return_value={}))
            for name in ('export_workspace','export_markups','export_physical','export_pdf_tools'):
                stack.enter_context(patch.object(TakeoffService,name,return_value=(body,'application/pdf','Boundary.pdf')))
            for kind,path,request in cases:
                with self.subTest(kind=kind,path=path):
                    status,_,payload=self.request('POST',path,request)
                    self.assertEqual(status,200,payload)
                    self.assertEqual([t.strip() for t in texts(payload)],['COMPANY MAIN','SPECIFIC '+kind,'BODY CONTENT'])
                    covered.add(kind)
            document=self.json('POST','/api/certifications',{'fields':self.fields},expected=201)
            generated=self.json('POST','/api/certifications/'+document['id']+'/revisions',{'fields':self.fields,'expected_version':1,'request_id':str(uuid.uuid4())},expected=201)
            self.assertEqual([t.strip() for t in texts(self.request('GET',generated['revision']['pdf_url'])[2])],['COMPANY MAIN','SPECIFIC certification','BODY CONTENT'])
            covered.add('certification')
        self.assertEqual(covered,{kind for kind,_ in KINDS})

    def test_native_destination_and_concurrent_cover_edits_keep_one_snapshot(self):
        self.json('POST','/api/company-settings',{**DEFAULTS,'cover_pdf':cover('OLD MAIN'),'cover_pdf_name':'Main.pdf'})
        selected={'cover_pdf':cover('OLD SPECIFIC'),'cover_pdf_name':'Specific.pdf','expected_version':1}
        self.json('POST','/api/pdf-covers/estimate',selected)
        def render(*args,**kwargs):
            self.json('POST','/api/company-settings',{**DEFAULTS,'cover_pdf':cover('NEW MAIN'),'cover_pdf_name':'New.pdf'})
            self.json('POST','/api/pdf-covers/estimate',{**selected,'cover_pdf':cover('NEW SPECIFIC'),'expected_version':2})
            return pdf('BODY')
        saved={}
        def write(instance,destination,filename,payload):saved['pdf']=payload;return {'saved':True}
        with patch('estimator.report.render_quote_pdf',side_effect=render),patch.object(ProjectLibrary,'capture_download',return_value=object()),patch.object(ProjectLibrary,'write_download',write):
            self.assertTrue(self.json('POST','/api/quote-report',{'inputs':{},'download':{'destination':'downloads'}})['saved'])
        self.assertEqual([t.strip() for t in texts(saved['pdf'])],['OLD MAIN','OLD SPECIFIC','BODY'])

    def test_signature_default_http_round_trip_conflicts_and_generation_snapshot(self):
        initial=self.json('GET','/api/certifications/defaults');image=signature()
        request={**initial,'expected_version':initial['version'],'signature_image':image,'signature_name':'Signed.png'}
        request.pop('version')
        saved=self.json('POST','/api/certifications/defaults',request)
        self.assertEqual(saved['signature_image'],image)
        self.assertEqual(self.json('POST','/api/certifications/defaults',request),saved)
        self.json('POST','/api/certifications/defaults',{**request,'signature_image':None,'signature_name':''},expected=409)
        self.json('POST','/api/certifications/defaults',{**request,'signature_image':'bad','expected_version':2},expected=400)
        selected={'cover_pdf':None,'cover_pdf_name':'','scopes':[],'signature_image':image,'signature_name':'Signed.png'}
        document=self.json('POST','/api/certifications',{'fields':self.fields,'options':selected},expected=201)
        with patch('estimator.certification_report.render_certificate_pdf',return_value=pdf('SIGNED')) as render:
            generated=self.json('POST','/api/certifications/'+document['id']+'/revisions',{'fields':self.fields,'options':selected,'expected_version':1,'request_id':str(uuid.uuid4())},expected=201)
        self.assertEqual(render.call_args.kwargs['signature'],image)
        first=self.request('GET',generated['revision']['pdf_url'])[2]
        self.json('POST','/api/certifications/defaults',{**request,'signature_image':None,'signature_name':'','expected_version':2})
        self.assertEqual(self.request('GET',generated['revision']['pdf_url'])[2],first)
        self.assertEqual(self.json('GET','/api/certifications/'+document['id'])['options'],selected)
