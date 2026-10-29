"""Real HTTP contract for revision storage and the shared PDF cover boundary."""
import base64
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
import http.client
from unittest.mock import patch

from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.certification import FIELDS, SIGNER_FIELDS
from estimator.company_settings import DEFAULTS
from estimator.server import create_server
from estimator.storage import Store


def pdf(text, width=400, height=600):
    output = BytesIO()
    canvas = Canvas(output, pagesize=(width, height))
    canvas.drawString(25, height-40, text)
    canvas.save()
    return output.getvalue()


def cover(text):
    return 'data:application/pdf;base64,' + base64.b64encode(pdf(text)).decode()


def texts(payload):
    return [page.extract_text() for page in PdfReader(BytesIO(payload)).pages]


class CertificationHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name)/'state.sqlite3'
        self.server = create_server(0, self.database, library_directory=Path(self.temp.name)/'library')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.fields = {name: '' for name in FIELDS}
        self.fields.update(dict.fromkeys(FIELDS[:13], 'N/A'))
        self.fields.update(client='Example client', project='Example project', address='Example address',
                           name='Example preparer', statement_of_compliance='Entered by the user.')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, value=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=60)
        try:
            data = json.dumps(value) if value is not None else None
            connection.request(method, path, data, {'Content-Type':'application/json', **(headers or {})})
            response = connection.getresponse()
            payload = response.read()
            return response.status, dict(response.getheaders()), payload
        finally:
            connection.close()

    def json(self, method, path, value=None, expected=200):
        status, _, payload = self.request(method, path, value)
        self.assertEqual(status, expected, payload)
        return json.loads(payload)

    def test_settings_cover_applies_to_browser_pdf_download_and_native_destination_once(self):
        settings = {**DEFAULTS, 'name':'Cover Company', 'cover_pdf':cover('FIRST COVER'), 'cover_pdf_name':'Cover.pdf'}
        self.json('POST', '/api/company-settings', settings)
        body = pdf('BODY CONTENT', 600, 400)
        with patch('estimator.report.render_quote_pdf', return_value=body):
            status, headers, payload = self.request('POST', '/api/quote-report', {'inputs':{}})
            self.assertEqual(status, 200)
            self.assertTrue(headers['Content-Type'].startswith('application/pdf'))
            pages = texts(payload)
            self.assertEqual(len(pages), 2)
            self.assertIn('FIRST COVER', pages[0]); self.assertIn('BODY CONTENT', pages[1])
            from estimator.project_library import ProjectLibrary
            saved = {}
            def capture(instance, destination, filename, content):
                saved['content'] = content
                return {'saved': True, 'path':'example.pdf','filename':filename,'destination':'downloads'}
            with patch.object(ProjectLibrary, 'capture_download', return_value=object()), \
                    patch.object(ProjectLibrary, 'write_download', capture):
                result = self.json('POST','/api/quote-report',{'inputs':{},'download':{'destination':'downloads'}})
            self.assertTrue(result['saved'])
            self.assertEqual(len(texts(saved['content'])),2)
            self.assertIn('FIRST COVER', texts(saved['content'])[0])
        self.json('POST','/api/company-settings',{**settings,'cover_pdf':None,'cover_pdf_name':''})
        with patch('estimator.report.render_quote_pdf', return_value=body):
            status, _, result = self.request('POST','/api/quote-report',{'inputs':{}})
            self.assertEqual(status,200); self.assertEqual(result,body)

    def test_revision_pdf_is_frozen_and_generation_retries_do_not_duplicate(self):
        self.json('POST','/api/company-settings',{**DEFAULTS,'name':'Original company',
                  'cover_pdf':cover('ORIGINAL COVER'),'cover_pdf_name':'Original.pdf'})
        doc = self.json('POST','/api/certifications',{'fields':self.fields,
                'request_id':'36a7dfcb-d73e-4536-aa24-df04827c63f3'}, expected=201)
        path = '/api/certifications/'+doc['id']
        operation = {'fields':self.fields,'expected_version':doc['version'],
                     'request_id':'f00f8afe-b53b-4a8a-bb12-ef3ca677bdb4'}
        generated = self.json('POST',path+'/revisions',operation,expected=201)
        replay = self.json('POST',path+'/revisions',operation,expected=201)
        self.assertEqual(generated['revision'],replay['revision'])
        self.assertEqual(len(replay['document']['revisions']),1)
        url = generated['revision']['pdf_url']
        status, _, first = self.request('GET',url)
        self.assertEqual(status,200); self.assertIn('ORIGINAL COVER',texts(first)[0])
        self.assertIn('Original company',' '.join(texts(first)))
        self.json('POST','/api/company-settings',{**DEFAULTS,'name':'Updated company',
                  'cover_pdf':cover('NEW COVER'),'cover_pdf_name':'Updated.pdf'})
        self.assertEqual(self.request('GET',url)[2],first)
        changed = {**self.fields,'location_area':'Area B'}
        second = self.json('POST',path+'/revisions',{'fields':changed,
                  'expected_version':generated['document']['version'],
                  'request_id':'ebdcd8da-8f2f-4466-83b3-5945b7bd760a'},expected=201)
        self.assertEqual(second['revision']['revision'],2)
        self.assertIn('NEW COVER',texts(self.request('GET',second['revision']['pdf_url'])[2])[0])
        self.assertEqual(self.request('GET',url)[2],first)
        self.assertEqual(len(self.json('GET',path)['revisions']),2)
        status, _, _ = self.request('POST',path,{'fields':self.fields,'expected_version':1})
        self.assertEqual(status,409)
        reopened = Store(self.database)
        from estimator.certification import CertificationService
        self.assertEqual(CertificationService(reopened).revision_pdf(doc['id'],1),first)

    def test_export_freezes_company_and_cover_together_during_concurrent_setting_change(self):
        original = {**DEFAULTS, 'name':'Original company', 'cover_pdf':cover('ORIGINAL COVER'),
                    'cover_pdf_name':'Original.pdf'}
        self.json('POST','/api/company-settings',original)
        def render(quote, *, company):
            Store(self.database).save_company_settings({**original,'name':'Changed company',
                   'cover_pdf':cover('CHANGED COVER'),'cover_pdf_name':'Changed.pdf'})
            return pdf('BODY '+company['name'])
        with patch('estimator.report.render_quote_pdf',side_effect=render):
            status, _, payload = self.request('POST','/api/quote-report',{'inputs':{}})
        self.assertEqual(status,200)
        pages = texts(payload)
        self.assertIn('ORIGINAL COVER',pages[0]); self.assertIn('Original company',pages[1])
        self.assertNotIn('CHANGED COVER',' '.join(pages))

    def test_validation_origins_methods_and_static_routes(self):
        self.assertEqual(self.json('GET','/api/certifications'),{'items':[]})
        for route in ('/certification.js','/certification.css'):
            self.assertEqual(self.request('GET',route)[0],200)
        self.assertEqual(self.request('PUT','/api/certifications',{'fields':self.fields})[0],405)
        self.assertEqual(self.request('POST','/api/certifications',{'unknown':'x'})[0],400)
        self.assertEqual(self.request('POST','/api/certifications',{'fields':self.fields},
                         headers={'Origin':'https://untrusted.example'})[0],403)
        self.assertEqual(self.request('GET','/api/certifications/36a7dfcb-d73e-4536-aa24-df04827c63f3')[0],404)
        self.assertEqual(self.json('GET','/api/certifications'),{'items':[]})

    def test_certificate_global_cover_order_and_frozen_retry_contract(self):
        self.json('POST', '/api/company-settings', {**DEFAULTS, 'cover_pdf': cover('GLOBAL COVER'),
                  'cover_pdf_name': 'Global.pdf'})
        selected = {'cover_pdf': cover('LOCAL COVER'), 'cover_pdf_name': 'Local.pdf',
                    'scopes': ['service_penetrations', 'ductwork']}
        self.json('POST', '/api/pdf-covers/certification', {'cover_pdf': cover('SETTINGS COVER'),
                  'cover_pdf_name': 'Settings.pdf', 'expected_version': 1})
        doc = self.json('POST', '/api/certifications', {'fields': self.fields, 'options': selected,
                        'request_id': '3bad93f1-a4bb-4d95-98e1-bdfd0331ad52'}, expected=201)
        path = '/api/certifications/' + doc['id']
        self.assertEqual(doc['options'], selected)
        self.assertEqual(self.json('GET', path)['options'], selected)
        revised = {**selected, 'scopes': ['structural_steel_columns']}
        saved = self.json('POST', path, {'fields': self.fields, 'options': revised, 'expected_version': 1})
        self.assertEqual(saved['version'], 2)
        self.assertEqual(saved['revisions'], [])
        self.json('POST', path, {'fields': self.fields, 'options': selected, 'expected_version': 1}, expected=409)
        request = {'fields': self.fields, 'options': revised, 'expected_version': 2,
                   'request_id': '540b3ba2-5bca-4c5f-a2d1-d9bad6c03f70'}
        with patch('estimator.certification_report.render_certificate_pdf', return_value=pdf('CERTIFICATE BODY')):
            generated = self.json('POST', path+'/revisions', request, expected=201)
        first = self.request('GET', generated['revision']['pdf_url'])[2]
        self.assertEqual(len(texts(first)), 3)
        self.assertIn('GLOBAL COVER', texts(first)[0])
        self.assertIn('SETTINGS COVER', texts(first)[1])
        self.assertNotIn('LOCAL COVER', ' '.join(texts(first)))
        self.json('POST', '/api/company-settings', {**DEFAULTS, 'cover_pdf': cover('CHANGED GLOBAL'),
                  'cover_pdf_name': 'Changed.pdf'})
        replay = self.json('POST', path+'/revisions', request, expected=201)
        self.assertEqual(replay['revision'], generated['revision'])
        self.assertEqual(replay['document']['options'], revised)
        self.assertEqual(self.request('GET', generated['revision']['pdf_url'])[2], first)
        for bad in ({**revised, 'scopes': ['unapproved']}, None, {**revised, 'extra': True}):
            self.json('POST', path, {'fields': self.fields, 'options': bad, 'expected_version': 3}, expected=400)
        self.assertEqual(self.json('GET', path), replay['document'])

    def test_signer_defaults_endpoint_cas_validation_and_document_isolation(self):
        initial = self.json('GET', '/api/certifications/defaults')
        self.assertEqual(initial, {'fields': dict.fromkeys(SIGNER_FIELDS, ''), 'version': 1, 'signature_image': None, 'signature_name': ''})
        doc = self.json('POST', '/api/certifications', {'fields': self.fields}, expected=201)
        entered = {'name': 'Saved signer', 'position': 'Entered position',
                   'qualification': 'Entered qualification', 'accreditation': 'Entered accreditation'}
        saved = self.json('POST', '/api/certifications/defaults', {'fields': entered, 'expected_version': 1})
        self.assertEqual(saved, {'fields': entered, 'version': 2, 'signature_image': None, 'signature_name': ''})
        self.assertEqual(self.json('POST', '/api/certifications/defaults',
                                  {'fields': entered, 'expected_version': 1}), saved)
        self.json('POST', '/api/certifications/defaults', {'fields': {**entered, 'name': 'Other'},
                  'expected_version': 1}, expected=409)
        self.json('POST', '/api/certifications/defaults', {'fields': {**entered, 'client': 'Wrong field'},
                  'expected_version': 2}, expected=400)
        self.assertEqual(self.request('PUT', '/api/certifications/defaults',
                         {'fields': entered, 'expected_version': 2})[0], 405)
        self.assertEqual(self.request('POST', '/api/certifications/defaults',
                         {'fields': entered, 'expected_version': 2}, headers={'Origin': 'https://untrusted.example'})[0], 403)
        self.assertEqual(self.json('GET', '/api/certifications/'+doc['id']), doc)


if __name__ == '__main__':
    unittest.main()
