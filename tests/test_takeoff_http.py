import hashlib
import http.client
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
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

    def test_vendor_manifest_and_same_origin_guards(self):
        for name in ('build/pdf.mjs','build/pdf.worker.mjs','wasm/openjpeg_nowasm_fallback.js'):
            status, headers, _ = self.request('GET','/vendor/pdfjs/'+name)
            self.assertEqual(status,200)
            self.assertIn('javascript',headers['Content-Type'])
            self.assertNotIn('unsafe-inline',headers['Content-Security-Policy'])
        for route in ('/vendor/pdfjs/../manifest.json','/vendor/pdfjs/manifest.json','/vendor/pdfjs/build/pdf.sandbox.mjs'):
            self.assertEqual(self.request('GET',route)[0],404)
        self.assertEqual(self.request('POST','/api/takeoffs/sessions',{}, {'Origin':'https://attacker.invalid'})[0],403)


if __name__ == '__main__':
    unittest.main()
