"""SWMS content, persistence, project isolation and actual export regressions."""
import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from pypdf import PdfReader
from reportlab.pdfgen import canvas

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.project_file import export_project, load_project_bytes
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from estimator.swms import SwmsDocuments, SwmsConflict, default_fields, template_options, validate_fields, validate_swms_snapshot
from estimator.swms_http import SwmsHTTP
from estimator.swms_pdf import render_swms_pdf


class Projects:
    def __init__(self, root):
        self.root = Path(root) / 'certifications'
        self.ids = {}

    def add(self, project=None):
        identity = str(uuid.uuid4())
        self.ids[identity] = project or str(uuid.uuid4())
        return identity

    def project_id(self, workspace):
        if workspace not in self.ids:
            raise ValidationError('Unknown project capability')
        return self.ids[workspace]


class Handler:
    command, path = 'POST', '/api/swms/issue'

    def __init__(self, body, capture=None):
        self.body, self.capture, self.headers, self.result = body, capture, {}, None

    def read_json(self):
        return deepcopy(self.body)

    def capture_commercial_download(self, options, workspace):
        return self.capture(options, workspace)

    def send_payload(self, status, value, *args, **kwargs):
        self.result = status, value

    def send_download(self, pdf, media_type, filename, destination, **options):
        self.result = 200, dict(pdf=pdf, filename=filename, destination=destination, **options)


class SwmsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = Projects(self.root)
        self.workspace = self.projects.add()
        self.calls = []
        def render(document, **kwargs):
            self.calls.append(deepcopy(document))
            return b'%PDF-1.4 immutable fixture'
        self.service = SwmsDocuments(self.projects, renderer=render)

    def payload(self):
        return dict(id=str(uuid.uuid4()), version=0, status='Draft', fields=default_fields({'project_no': 'CF-SWMS'}))

    def test_template_choices_and_blank_real_world_signatures(self):
        fields = self.payload()['fields']
        self.assertEqual({key: len(rows) for key, rows in fields['steps'].items()}, {
            'Protective Coatings': 16, 'Passive Firestopping': 13, 'Installation of Passive Fire Protection Works': 16})
        self.assertEqual(len(template_options()['activities']), 2)
        self.assertEqual(fields['details']['job_reference'], 'CF-SWMS')
        for key in ['reviewers', 'consultation']:
            self.assertTrue(all(row['signature'] is None and row['name'] == '' for row in fields[key]))
        self.assertEqual(fields['signoffs'], [])
        self.assertIsNone(fields['manual_signature'])
        self.assertNotIn('Slayde', json.dumps(fields))

    def test_create_retry_stale_update_delete_and_resurrection(self):
        payload = self.payload()
        saved = self.service.save(self.workspace, payload)
        self.assertEqual(saved, self.service.save(self.workspace, payload))
        with self.assertRaises(SwmsConflict):
            self.service.save(self.workspace, {**payload, 'status': 'Review'})
        updated = self.service.save(self.workspace, {**payload, 'version': saved['version'], 'status': 'Review'})
        with self.assertRaises(SwmsConflict):
            self.service.delete(self.workspace, saved['id'], saved['version'])
        self.service.delete(self.workspace, updated['id'], updated['version'])
        with self.assertRaises(SwmsConflict):
            self.service.save(self.workspace, payload)

    def test_portable_snapshot_and_exact_capture(self):
        self.service.save(self.workspace, self.payload())
        snapshot = self.service.capture(self.workspace)
        self.assertEqual(snapshot, validate_swms_snapshot(json.loads(json.dumps(snapshot))))
        other = self.projects.add(snapshot['project_id'])
        self.service.restore(other, snapshot)
        self.assertEqual(self.service.capture(other), snapshot)
        forged = self.projects.add()
        with self.assertRaises(SwmsConflict):
            self.service.restore(forged, snapshot)
        with self.assertRaises(SwmsConflict):
            self.service.capture(self.workspace, {**snapshot, 'documents': []})
        with self.assertRaises(ValidationError):
            self.service.view(str(uuid.uuid4()))

    def test_immutable_issue_replay_and_cross_project_denied(self):
        saved = self.service.save(self.workspace, self.payload())
        request = str(uuid.uuid4())
        issued = self.service.issue(self.workspace, saved['id'], 1, request)
        repeated = self.service.issue(self.workspace, saved['id'], 1, request)
        self.assertEqual(issued['pdf'], repeated['pdf'])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.service.read_pdf(self.workspace, issued['id'])[1], issued['pdf'])
        with self.assertRaises(SwmsConflict):
            self.service.issue(self.workspace, saved['id'], 1, request, {**DEFAULTS, 'name': 'Changed company'})
        with self.assertRaises(ValidationError):
            self.service.read_pdf(self.projects.add(), issued['id'])

    def test_bounded_schema_rejects_executable_or_malformed_data(self):
        for mutate in [lambda f: f.update(script='<script>'),
                       lambda f: f.update(work_types=[]),
                       lambda f: f['steps']['Passive Firestopping'][0].update(initial_risk='4'),
                       lambda f: f.update(manager_signature={'version': 1, 'ratio': 1, 'strokes': [[[float('nan'), 0]]]}),
                       lambda f: f.update(manager_signature={'version': 1, 'ratio': 1, 'strokes': [[[0, 0]] * 4001]}),
                       lambda f: f.update(attachments=[{'name': '../bad.pdf', 'media_type': 'application/pdf', 'data': 'data:application/pdf;base64,AA=='}]),
                       lambda f: f.update(attachments=[{'name': 'bad.svg', 'media_type': 'image/svg+xml', 'data': '<svg/>'}])]:
            fields = default_fields()
            mutate(fields)
            with self.subTest(mutate=mutate), self.assertRaises(ValidationError):
                validate_fields(fields)

    def test_damaged_image_returns_validation_error(self):
        fields = default_fields()
        fields['attachments'] = [{'name': 'bad.png', 'media_type': 'image/png', 'data': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII='}]
        with self.assertRaisesRegex(ValidationError, 'damaged'):
            validate_fields(fields)

    def test_http_workspace_guard_cross_site_and_stale_version(self):
        saved = self.service.save(self.workspace, self.payload())
        body = dict(workspace_id=self.workspace, id=saved['id'], version=1, request_id=str(uuid.uuid4()))
        adapter = SwmsHTTP(self.service)
        wrong = Handler(body); wrong.headers['X-Estimator-Documentation-Workspace'] = str(uuid.uuid4())
        adapter.dispatch(wrong, '/api/swms/issue')
        self.assertEqual(wrong.result[0], 409)
        cross = Handler(body); cross.headers['Sec-Fetch-Site'] = 'cross-site'
        adapter.dispatch(cross, '/api/swms/issue')
        self.assertEqual(cross.result[0], 400)
        stale = Handler({**body, 'version': 0})
        adapter.dispatch(stale, '/api/swms/issue')
        self.assertEqual(stale.result[0], 409)
        self.assertFalse(self.calls)

    def test_http_capture_rejects_cross_project_before_issue_and_catches_race(self):
        saved = self.service.save(self.workspace, self.payload())
        body = dict(workspace_id=self.workspace, id=saved['id'], version=1, request_id=str(uuid.uuid4()), download={'project_token': 'foreign'})
        def reject(options, workspace):
            raise ValidationError('This token belongs to a different project.')
        adapter = SwmsHTTP(self.service)
        handler = Handler(body, reject); adapter.dispatch(handler, '/api/swms/issue')
        self.assertEqual(handler.result[0], 400); self.assertFalse(self.calls)
        def race(options, workspace):
            self.service.save(workspace, {key: saved[key] for key in ['id', 'version', 'status', 'fields']})
            return 'captured destination'
        handler = Handler(body, race); adapter.dispatch(handler, '/api/swms/issue')
        self.assertEqual(handler.result[0], 409); self.assertFalse(self.calls)

    def test_http_unknown_query_and_frozen_pdf(self):
        saved = self.service.save(self.workspace, self.payload())
        adapter = SwmsHTTP(self.service)
        duplicate = Handler({}); duplicate.command = 'GET'; duplicate.path = '/api/swms/state?workspace=a&workspace=b'
        adapter.dispatch(duplicate, '/api/swms/state'); self.assertEqual(duplicate.result[0], 400)
        handler = Handler(dict(workspace_id=self.workspace, id=saved['id'], version=1, request_id=str(uuid.uuid4())))
        adapter.dispatch(handler, '/api/swms/issue')
        self.assertEqual(handler.result[0], 200); self.assertTrue(handler.result[1]['frozen_pdf'])

    def test_project_roundtrip_cross_project_and_old_client_omission(self):
        self.service.save(self.workspace, self.payload())
        swms = self.service.capture(self.workspace)
        project = swms['project_id']
        manifest = dict(version=1, project_id=project, archive_sha256='a' * 64, archive_size=1, document_count=0, revision_count=0, companion_folder=f'.ceasefire-evidence/{project}/certifications')
        store = Store(self.root / 'project.sqlite3')
        request = {'estimate': {'project_no': 'CF-SWMS'}, 'certifications': manifest, 'swms': swms}
        payload = export_project(store, request)
        loaded = load_project_bytes(store, payload)
        self.assertEqual(loaded['swms'], swms)
        forged = deepcopy(request); forged['swms']['project_id'] = str(uuid.uuid4())
        with self.assertRaises(ValidationError):
            export_project(store, forged)
        path = self.root / 'test.cf.json'; path.write_bytes(payload)
        library = ProjectLibrary(store); self.addCleanup(library.close)
        with self.assertRaisesRegex(ValidationError, 'SWMS'):
            library._preserve_takeoffs(path, {'estimate': request['estimate'], 'certifications': manifest})
        library.swms = self.service
        library.certifications = type('Capture', (), {'capture': lambda self, value: manifest})()
        snapshot = library._capture_workspace({**request, 'certifications': {'workspace_id': self.workspace}})
        self.assertEqual(snapshot['swms'], swms)
        changed = deepcopy(request); changed['swms']['documents'] = []
        with self.assertRaises(SwmsConflict):
            library._capture_workspace({**changed, 'certifications': {'workspace_id': self.workspace}})


class SwmsPdfTests(unittest.TestCase):
    def test_template_page_geometry_repeated_headers_numbering_and_actual_content(self):
        fields = default_fields({'project_no': 'CF-PDF', 'site_address': '<script>literal</script>'})
        pdf = render_swms_pdf({'version': 3, 'fields': fields}, company=DEFAULTS)
        reader = PdfReader(BytesIO(pdf))
        self.assertEqual(len(reader.pages), 13)
        for index, page in enumerate(reader.pages, 1):
            self.assertGreater(float(page.mediabox.width), float(page.mediabox.height))
            text = page.extract_text()
            self.assertIn(f'Page {index} of 13', text)
            self.assertEqual(text.count('Printed version is uncontrolled'), 1)
            if 7 <= index <= 10:
                self.assertIn('Responsible Person', text)
        text = '\n'.join(page.extract_text() for page in reader.pages)
        self.assertIn('<script>literal</script>', text)
        self.assertIn('Site emergency', text)
        self.assertIn('EMERGENCY RESPONSE PLAN', text)
        self.assertNotIn('Slayde', text)

    def test_all_work_types_long_rows_signature_and_appendix_preserved(self):
        fields = default_fields()
        fields['work_types'] = list(fields['steps'])
        fields['steps']['Passive Firestopping'][0]['controls'] = ('Long control remains legible and complete.\n' * 80) + 'LAST-CONTROL'
        fields['manager_signature'] = {'version': 1, 'ratio': 3, 'strokes': [[[0, .8], [.5, .1], [1, .6]]]}
        fields['signoffs'] = [{'name': 'TEST PERSON', 'company': 'TEST COMPANY', 'signature': fields['manager_signature'], 'date': '2026-11-06', 'time': '09:30', 'latitude': '-33.86', 'longitude': '151.2'}]
        attachment = BytesIO(); c = canvas.Canvas(attachment, pagesize=(300, 400)); c.drawString(30, 300, 'ATTACHMENT-END'); c.save()
        fields['attachments'] = [{'name': 'Appendix.pdf', 'media_type': 'application/pdf', 'data': 'data:application/pdf;base64,' + base64.b64encode(attachment.getvalue()).decode()}]
        fields['emergency_notify'] = ('Long emergency notification. ' * 150) + 'LAST-NOTIFICATION'
        reader = PdfReader(BytesIO(render_swms_pdf({'version': 2, 'fields': fields}, company=DEFAULTS)))
        text = '\n'.join(page.extract_text() for page in reader.pages)
        for value in [*fields['work_types'], 'LAST-CONTROL', 'LAST-NOTIFICATION', 'TEST PERSON', 'ATTACHMENT-END']:
            self.assertIn(value, text)
        self.assertIn(f'Page {len(reader.pages)} of {len(reader.pages)}', reader.pages[-1].extract_text())


if __name__ == '__main__':
    unittest.main()
