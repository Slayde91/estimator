import hashlib
import http.client
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from uuid import uuid4
from urllib.parse import urlencode
from reportlab.pdfgen import canvas
from estimator.server import create_server


class TakeoffHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = create_server(0, Path(cls.tmp.name) / 'qa.sqlite3')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        stream = BytesIO(); pdf = canvas.Canvas(stream); pdf.drawString(40, 500, 'Takeoff upload test'); pdf.save()
        cls.pdf = stream.getvalue()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.tmp.cleanup()

    def request(self, method, path, value=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=90)
        try:
            body = json.dumps(value).encode() if isinstance(value, dict) else value
            connection.request(method, path, body, {'Content-Type':'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_pdf_ingestion_range_and_cross_session_isolation(self):
        status, _, payload = self.request('POST', '/api/takeoffs/sessions', {})
        self.assertEqual(status, 200)
        session = json.loads(payload); base = '/api/takeoffs/sessions/' + session['session_id']
        status, _, payload = self.request('POST', base+'/uploads', {'filename':'plan.pdf','size':len(self.pdf),'sha256':hashlib.sha256(self.pdf).hexdigest()})
        self.assertEqual(status, 200); upload = json.loads(payload)['upload_id']
        endpoint = base+'/uploads/'+upload
        status, _, _ = self.request('PUT', endpoint+'?offset=0', self.pdf, {'Content-Type':'application/octet-stream'})
        self.assertEqual(status, 200)
        self.assertEqual(self.request('PUT', endpoint+'?offset=0', self.pdf, {'Content-Type':'application/octet-stream'})[0], 200)
        status, _, payload = self.request('POST', endpoint+'/complete', {'expected_revision':0})
        self.assertEqual(status, 200, payload)
        result = json.loads(payload); document = result['snapshot']['documents'][0]
        route = base+'/documents/'+document['id']+'/file'
        status, headers, body = self.request('GET', route, headers={'Range':'bytes=0-7'})
        self.assertEqual(status, 206); self.assertEqual(body, self.pdf[:8])
        self.assertEqual(headers['Content-Length'], '8')
        self.assertEqual(self.request('GET', route, headers={'Range':'bytes=999999999-9999999999'})[0],416)
        _, _, other = self.request('POST', '/api/takeoffs/sessions', {})
        other_route = '/api/takeoffs/sessions/'+json.loads(other)['session_id']+'/documents/'+document['id']+'/file'
        self.assertEqual(self.request('GET',other_route)[0],400)

    def test_board_temperature_choices_use_current_member_type(self):
        for member_type, temperature in (('Beam', 620), ('Column', 550)):
            query = urlencode({'calculator': 'steel_board', 'product': 'TRAFALGAR COREX',
                               'member_type': member_type})
            status, _, payload = self.request('GET', '/api/takeoffs/options?' + query)
            self.assertEqual(status, 200, payload)
            field = next(field for field in json.loads(payload)['columns'] if field['column'] == 'J')
            self.assertIn(temperature, field['options'])
            self.assertNotIn(550 if temperature == 620 else 620, field['options'])

    def test_intumescent_temperature_choices_use_product_and_exposure(self):
        from estimator.intumescent import FX6010
        from estimator.workbook_calculators import calculator_session
        for exposure in ('I/H beam - 3 sides', 'I/H column - 4 sides', 'CHS column - 4 sides'):
            query = urlencode({'calculator': 'steel_intumescent', 'product': FX6010, 'exposure': exposure})
            status, _, payload = self.request('GET', '/api/takeoffs/options?' + query)
            self.assertEqual(status, 200, payload)
            fields = {field['column']: field for field in json.loads(payload)['columns']}
            _, engine, lock = calculator_session('steel_intumescent', {'SCHEDULE': {'B10': FX6010, 'C10': exposure}})
            with lock:
                self.assertEqual(fields['D']['options'], list(engine.temperature_options(10)))
            self.assertIn(FX6010, fields['B']['options'])
            self.assertIn(exposure, fields['C']['options'])
            self.assertTrue(fields['F']['options'])

    def test_pdf_tools_downloads_captured_pages_without_changing_session(self):
        from pypdf import PdfReader
        _, _, payload = self.request('POST', '/api/takeoffs/sessions', {})
        session = json.loads(payload); base = '/api/takeoffs/sessions/' + session['session_id']
        for name in ('first.pdf', 'second.pdf'):
            stream = BytesIO(); pdf = canvas.Canvas(stream, invariant=1)
            for number in range(1, 4):
                pdf.drawString(40, 500, f'{name} page {number}'); pdf.showPage()
            pdf.save(); source = stream.getvalue()
            status, _, payload = self.request('POST', base+'/uploads', {'filename': name, 'size': len(source)})
            self.assertEqual(status, 200, payload)
            endpoint = base+'/uploads/'+json.loads(payload)['upload_id']
            self.assertEqual(self.request('PUT', endpoint+'?offset=0', source, {'Content-Type': 'application/octet-stream'})[0], 200)
            status, _, payload = self.request('POST', endpoint+'/complete', {'expected_revision': session['revision']})
            self.assertEqual(status, 200, payload); session = json.loads(payload)
        ids = [value['id'] for value in session['snapshot']['documents']]
        before = self.request('GET', base)[2]
        cases = [('merge', ids[::-1], None, ['second.pdf page 1', 'second.pdf page 2', 'second.pdf page 3', 'first.pdf page 1', 'first.pdf page 2', 'first.pdf page 3']),
                 ('organise', [ids[0]], [3, 1], ['first.pdf page 3', 'first.pdf page 1']),
                 ('extract', [ids[1]], [2], ['second.pdf page 2'])]
        for operation, documents, pages, text in cases:
            request = {'expected_revision': session['revision'], 'operation': operation, 'document_ids': documents}
            if pages is not None: request['page_order'] = pages
            status, headers, payload = self.request('POST', base+'/pdf-tools', request)
            self.assertEqual(status, 200, payload); self.assertEqual(headers['Content-Type'], 'application/pdf')
            self.assertEqual([page.extract_text().strip() for page in PdfReader(BytesIO(payload)).pages], text)
            self.assertEqual(self.request('GET', base)[2], before)
        request = {'expected_revision': session['revision'], 'operation': 'extract', 'document_ids': [ids[0]], 'page_order': [1]}
        for invalid in ({**request, 'expected_revision': 0}, {**request, 'document_ids': [str(uuid4())]}, {**request, 'page_order': [4]}, {**request, 'path': 'C:/private.pdf'}):
            self.assertEqual(self.request('POST', base+'/pdf-tools', invalid)[0], 400)
        self.assertEqual(self.request('POST', base+'/pdf-tools?path=private.pdf', request)[0], 400)
        self.assertEqual(self.request('POST', base+'/pdf-tools', request, {'Origin': 'https://attacker.invalid'})[0], 403)
        self.assertEqual(self.request('GET', base)[2], before)

    def test_auto_calibration_reads_retained_source_and_returns_audited_preset(self):
        stream = BytesIO(); pdf = canvas.Canvas(stream, pagesize=(600, 800))
        pdf.drawString(400, 35, 'SCALE 1:100'); pdf.save(); source = stream.getvalue()
        _, _, payload = self.request('POST', '/api/takeoffs/sessions', {})
        session = json.loads(payload); base = '/api/takeoffs/sessions/' + session['session_id']
        status, _, payload = self.request('POST', base+'/uploads', {'filename': 'scale.pdf', 'size': len(source)})
        self.assertEqual(status, 200)
        upload = base+'/uploads/'+json.loads(payload)['upload_id']
        self.assertEqual(self.request('PUT', upload+'?offset=0', source, {'Content-Type': 'application/octet-stream'})[0], 200)
        status, _, payload = self.request('POST', upload+'/complete', {'expected_revision': 0})
        self.assertEqual(status, 200)
        session = json.loads(payload)
        request = {'expected_revision': session['revision'], 'request_id': str(uuid4()),
                   'document_id': session['snapshot']['documents'][0]['id'], 'page': 1}
        status, _, payload = self.request('POST', base+'/auto-calibrate', request)
        self.assertEqual(status, 200, payload)
        result = json.loads(payload)
        self.assertEqual(result['auto_calibration']['status'], 'applied')
        self.assertEqual(result['snapshot']['calibrations'][0]['scale_denominator'], 100)
        self.assertEqual(self.request('POST', base+'/auto-calibrate', request)[2], payload)
        self.assertEqual(self.request('POST', base+'/auto-calibrate', {**request, 'scale_denominator': 50})[0], 400)

    def test_vendor_manifest_and_same_origin_guards(self):
        for name in ('build/pdf.mjs','build/pdf.worker.mjs','wasm/openjpeg_nowasm_fallback.js'):
            status, headers, _ = self.request('GET','/vendor/pdfjs/'+name)
            self.assertEqual(status,200)
            self.assertIn('javascript',headers['Content-Type'])
            self.assertNotIn('unsafe-inline',headers['Content-Security-Policy'])
        for route in ('/vendor/pdfjs/../manifest.json','/vendor/pdfjs/manifest.json','/vendor/pdfjs/build/pdf.sandbox.mjs'):
            self.assertEqual(self.request('GET',route)[0],404)
        self.assertEqual(self.request('POST','/api/takeoffs/sessions',{}, {'Origin':'https://attacker.invalid'})[0],403)

    def _uploaded_workspace(self):
        status, _, payload = self.request('POST', '/api/takeoffs/sessions', {})
        self.assertEqual(status, 200, payload)
        session = json.loads(payload); base = '/api/takeoffs/sessions/' + session['session_id']
        status, _, payload = self.request('POST', base+'/uploads', {'filename': 'disposable.pdf', 'size': len(self.pdf)})
        self.assertEqual(status, 200, payload)
        upload = base+'/uploads/'+json.loads(payload)['upload_id']
        self.assertEqual(self.request('PUT', upload+'?offset=0', self.pdf, {'Content-Type': 'application/octet-stream'})[0], 200)
        status, _, payload = self.request('POST', upload+'/complete', {'expected_revision': 0})
        self.assertEqual(status, 200, payload)
        return base, json.loads(payload)

    def test_textbox_layout_http_is_read_only_guarded_and_atomic_creation_matches(self):
        base, session = self._uploaded_workspace(); document = session['snapshot']['documents'][0]
        value = {'mode': 'steel', 'document_id': document['id'], 'source_sha256': document['sha256'],
                 'page': 1, 'anchor_pdf': [40, 500], 'display_rotation': 0,
                 'text': 'HTTP fixed-font Textbox', 'appearance': {'font_size': 18}}
        request = {'expected_revision': session['revision'], **value}
        before = self.request('GET', base)[2]
        status, _, payload = self.request('POST', base+'/textbox-layout', request)
        self.assertEqual(status, 200, payload); preview = json.loads(payload)
        self.assertEqual(preview['graphic']['geometry']['quad_pdf'][0], value['anchor_pdf'])
        self.assertEqual(self.request('GET', base)[2], before)
        for invalid in ({**request, 'expected_revision': 0}, {**request, 'source_sha256': 'b'*64},
                        {**request, 'path': 'C:/private.pdf'}, {**request, 'anchor_pdf': [0, -10]}):
            self.assertEqual(self.request('POST', base+'/textbox-layout', invalid)[0], 400)
        self.assertEqual(self.request('POST', base+'/textbox-layout?path=private.pdf', request)[0], 400)
        self.assertEqual(self.request('POST', base+'/textbox-layout', request, {'Origin': 'https://attacker.invalid'})[0], 403)
        self.assertEqual(self.request('GET', base+'/textbox-layout')[0], 405)
        self.assertEqual(self.request('GET', base)[2], before)
        command = {'op': 'create_textbox', 'expected_revision': session['revision'], 'request_id': str(uuid4()), 'textbox': value}
        status, _, payload = self.request('POST', base+'/commands', command)
        self.assertEqual(status, 200, payload); created = json.loads(payload)
        self.assertEqual(created['snapshot']['graphics']['records'][0]['geometry'], preview['graphic']['geometry'])
        self.assertEqual(created['snapshot']['items'], session['snapshot']['items'])
        self.assertEqual(created['snapshot']['transfers'], session['snapshot']['transfers'])
        self.assertEqual(self.request('POST', base+'/commands', command)[2], payload)

    def test_deleted_items_http_query_never_restores_authority_and_rejects_stale_or_cross_origin(self):
        base, session = self._uploaded_workspace(); document = session['snapshot']['documents'][0]
        def command(op, **values):
            nonlocal session
            status, _, payload = self.request('POST', base+'/commands', {'op': op, 'expected_revision': session['revision'],
                'request_id': str(uuid4()), **values})
            self.assertEqual(status, 200, payload); session = json.loads(payload)
        command('create_item', item={'mode': 'steel', 'quantity': 1, 'fields': {'mark': 'Deleted HTTP row'},
            'geometry': {'document_id': document['id'], 'page': 1, 'points': [[40, 500], [100, 500]]},
            'measurement': {'method': 'cited', 'length_m': 8.35, 'citation': 'Disposable source dimension'}})
        original = session['snapshot']['items'][0]; command('delete_items', item_ids=[original['id']])
        request = {'expected_revision': session['revision'], 'mode': 'steel', 'query': 'HTTP', 'offset': 0, 'limit': 1}
        before = self.request('GET', base)[2]
        status, _, payload = self.request('POST', base+'/deleted-items', request)
        self.assertEqual(status, 200, payload); result = json.loads(payload)
        self.assertEqual(result['total'], 1); self.assertTrue(result['read_only'])
        self.assertEqual(result['records'][0]['item'], original)
        self.assertEqual(self.request('GET', base)[2], before)
        for invalid in ({**request, 'expected_revision': 0}, {**request, 'limit': 101},
                        {**request, 'mode': 'defect_reports'}, {**request, 'restore': True}):
            self.assertEqual(self.request('POST', base+'/deleted-items', invalid)[0], 400)
        self.assertEqual(self.request('POST', base+'/deleted-items?restore=true', request)[0], 400)
        self.assertEqual(self.request('POST', base+'/deleted-items', request, {'Origin': 'https://attacker.invalid'})[0], 403)
        self.assertEqual(self.request('GET', base+'/deleted-items')[0], 405)
        self.assertEqual(self.request('GET', base)[2], before)


if __name__ == '__main__':
    unittest.main()
