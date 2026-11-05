from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
import uuid

from pypdf import PdfReader
from reportlab.pdfgen import canvas

from estimator.catalog import ValidationError
from estimator.commercial_documents import (CommercialConflict, CommercialDocuments,
    default_fields, default_terms, totals, validate_commercial_documents, validate_rich_text)
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS


class Projects:
    def __init__(self, root):
        self.root = Path(root) / 'certification-projects'
        self.ids = {}

    def add(self, project=None):
        workspace = str(uuid.uuid4())
        self.ids[workspace] = project or str(uuid.uuid4())
        return workspace

    def project_id(self, workspace):
        if workspace not in self.ids:
            raise ValidationError('Unknown project capability')
        return self.ids[workspace]


class CommercialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.projects = Projects(self.temporary.name)
        self.workspace = self.projects.add()
        self.store = CommercialDocuments(self.projects)

    def payload(self, kind='work_order'):
        fields = default_fields(kind)
        fields['details'].update(client='Example client', site_address='10 Example Road', project_no='CF-10', date='2026-11-06')
        fields['lines'] = [{'estimate_id':'estimate-1', 'description':'Supply and installation', 'quantity':'2', 'unit_price':'125.25'}]
        return {'id':str(uuid.uuid4()), 'version':0, 'kind':kind, 'status':'Draft', 'fields':fields}

    def test_create_retry_and_stale_update(self):
        payload = self.payload()
        saved = self.store.save(self.workspace, payload)
        self.assertEqual(self.store.save(self.workspace, payload), saved)
        with self.assertRaises(CommercialConflict):
            self.store.save(self.workspace, {**payload, 'status':'Review'})
        moved = self.store.status(self.workspace, saved['id'], saved['version'], 'Review')
        self.assertEqual(moved['status'], 'Review')
        with self.assertRaises(CommercialConflict):
            self.store.status(self.workspace, saved['id'], saved['version'], 'Completed')

    def test_portable_restore_ownership_and_exact_capture(self):
        saved = self.store.save(self.workspace, self.payload())
        snapshot = self.store.capture(self.workspace)
        restored_workspace = self.projects.add(self.projects.project_id(self.workspace))
        self.store.restore(restored_workspace, snapshot)
        self.assertEqual(self.store.capture(restored_workspace), snapshot)
        self.store.status(self.workspace, saved['id'], saved['version'], 'Review')
        with self.assertRaises(CommercialConflict):
            self.store.capture(self.workspace, snapshot)
        with self.assertRaises(CommercialConflict):
            self.store.restore(self.projects.add(), snapshot)

    def test_numbers_are_atomic_and_replayable(self):
        saved = self.store.save(self.workspace, self.payload())
        request_id = str(uuid.uuid4())
        issued = self.store.issue(self.workspace, saved['id'], saved['version'], request_id)
        replay = self.store.issue(self.workspace, saved['id'], saved['version'], request_id)
        self.assertEqual(issued['number'], 'WO-000001')
        self.assertEqual(replay['pdf'], issued['pdf'])
        with self.assertRaises(CommercialConflict):
            self.store.issue(self.workspace, saved['id'], saved['version'], request_id, {**DEFAULTS,'name':'Changed'})
        next_issue = self.store.issue(self.workspace, saved['id'], issued['document']['version'], str(uuid.uuid4()))
        self.assertEqual(next_issue['number'], 'WO-000002')

    def test_failed_pdf_does_not_consume_a_number(self):
        saved = self.store.save(self.workspace, self.payload())
        def fail(*args, **kwargs):
            raise ValueError('render failed')
        self.store.renderer = fail
        with self.assertRaises(ValueError):
            self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))
        self.store.renderer = None
        self.assertEqual(self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))['number'], 'WO-000001')

    def test_concurrent_projects_receive_distinct_numbers(self):
        another = self.projects.add()
        first = self.store.save(self.workspace, self.payload())
        second = self.store.save(another, self.payload())
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.store.issue, workspace, document['id'], document['version'], str(uuid.uuid4())) for workspace, document in [(self.workspace, first),(another,second)]]
            self.assertEqual({future.result()['number'] for future in futures}, {'WO-000001','WO-000002'})

    def test_imported_number_can_advance_but_not_rewind_sequence(self):
        self.store.save(self.workspace, self.payload())
        snapshot = self.store.capture(self.workspace)
        snapshot['documents'][0]['last_number'] = 'WO-000050'
        restored = self.projects.add(snapshot['project_id'])
        self.store.restore(restored, snapshot)
        saved = snapshot['documents'][0]
        issue = self.store.issue(restored, saved['id'], saved['version'], str(uuid.uuid4()))
        self.assertEqual(issue['number'], 'WO-000051')
        older = self.projects.add(snapshot['project_id'])
        snapshot['documents'][0]['last_number'] = 'WO-000002'
        self.store.restore(older, snapshot)
        self.assertEqual(self.store.issue(older, saved['id'], saved['version'], str(uuid.uuid4()))['number'], 'WO-000052')

    def test_rich_text_rejects_active_content_and_preserves_formatting(self):
        for unsafe in ['<script>alert(1)</script>','<img src=x>','<p onclick="bad()">Text</p>','<a href="https://example.com">Link</a>']:
            with self.assertRaises(ValidationError):
                validate_rich_text(unsafe)
        self.assertEqual(validate_rich_text('<p><b>Bold</b> &amp; <i>italic</i></p>'), '<p><b>Bold</b> &amp; <i>italic</i></p>')

    def test_ordered_lists_and_dynamic_company_survive_pdf_export(self):
        fields = self.payload('quote')['fields']
        fields['scope'] = '<ol><li>First task</li><li>Second task<ul><li>Nested bullet</li></ul></li><li>Third task</li></ol>'
        fields['terms'] = ''
        pdf = render_commercial_pdf({'kind':'quote','fields':fields}, 'Q-000001', company=DEFAULTS)
        text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(pdf)).pages)
        self.assertIn('1. First task', text)
        self.assertIn('2. Second task', text)
        self.assertIn('3. Third task', text)
        self.assertIn('Nested bullet', text)
        terms = default_terms({**DEFAULTS,'name':'Example Fire Pty Ltd','abn':'12 345 678 901'})
        self.assertNotIn('Ceasefire', terms)
        self.assertNotIn('ceasefire.com.au', terms)
        self.assertIn('Example Fire Pty Ltd (ABN 12 345 678 901)', terms)

    def test_decimal_totals_and_invalid_numbers(self):
        fields = self.payload()['fields']
        self.assertEqual(totals(fields), {'lines':['250.50'],'subtotal':'250.50','gst':'25.05','grand_total':'275.55'})
        for value in ['NaN','Infinity','-1',True]:
            payload = self.payload()
            payload['fields']['lines'][0]['quantity'] = value
            with self.assertRaises(ValidationError):
                self.store.save(self.workspace, payload)

    def test_credit_unit_prices_keep_signed_amounts_and_positive_quantities(self):
        payload = self.payload('quote')
        payload['fields']['lines'][0]['unit_price'] = '-740.00'
        saved = self.store.save(self.workspace, payload)
        self.assertEqual(totals(saved['fields'])['grand_total'], '-1628.00')
        self.assertEqual(saved['fields']['lines'][0]['quantity'], '2')

    def test_pdf_contents_company_and_exact_scope_pages(self):
        payload = self.payload('quote')
        company = {**DEFAULTS,'name':'Example Fire Pty Ltd','abn':'12 345 678 901'}
        payload['fields']['terms'] = default_terms(company)
        payload['fields']['allowances'] = '<p><b>Access</b> provided by client.</p>'
        scope = BytesIO()
        page = canvas.Canvas(scope)
        page.drawString(40, 700, 'EXACT FULL SCHEDULE EVIDENCE')
        page.save()
        saved = self.store.save(self.workspace, payload)
        pdf = render_commercial_pdf(saved, 'Q-000001', company=company, scope_documents=[scope.getvalue()])
        reader = PdfReader(BytesIO(pdf))
        text = '\n'.join(page.extract_text() for page in reader.pages)
        self.assertIn('EXACT FULL SCHEDULE EVIDENCE', reader.pages[1].extract_text())
        self.assertIn('Example Fire Pty Ltd', text)
        self.assertIn('ABN 12 345 678 901', text)
        self.assertNotIn('ACN 612 231 562', text)
        self.assertIn('$275.55', text)
        self.assertIn('TERMS OF TRADE', text)
        self.assertIn('Page 1 of', text)
        self.assertGreater(len(reader.pages), 3)

    def test_deleted_draft_retains_issued_pdf_with_project_access(self):
        saved = self.store.save(self.workspace, self.payload())
        issued = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))
        self.store.delete(self.workspace, saved['id'], issued['document']['version'])
        self.assertEqual(self.store.capture(self.workspace)['documents'], [])
        self.assertEqual(self.store.read_pdf(self.workspace, issued['id'])[1], issued['pdf'])
        with self.assertRaises(ValidationError):
            self.store.read_pdf(self.projects.add(), issued['id'])

    def test_deleted_draft_replays_without_recalculation_and_preserves_highwater(self):
        saved = self.store.save(self.workspace, self.payload())
        request_id = str(uuid.uuid4())
        issued = self.store.issue(self.workspace, saved['id'], saved['version'], request_id)
        self.store.delete(self.workspace, saved['id'], issued['document']['version'])
        replay = self.store.replay(self.workspace, request_id, saved['id'], saved['version'])
        self.assertEqual(replay['pdf'], issued['pdf'])
        snapshot = self.store.capture(self.workspace)
        self.assertEqual(snapshot['number_counters']['work_order'], 1)
        self.assertEqual(snapshot['documents'], [])
        restored = self.projects.add(snapshot['project_id'])
        self.store.restore(restored, snapshot)
        created = self.store.save(restored, self.payload())
        self.assertEqual(self.store.issue(restored, created['id'], created['version'], str(uuid.uuid4()))['number'], 'WO-000002')

    def test_http_replaces_tampered_price_and_scope_with_authoritative_values(self):
        from estimator.commercial_http import CommercialHTTP
        payload = self.payload('quote')
        payload['workspace_id'] = self.workspace
        payload['fields']['lines'][0]['unit_price'] = '999'
        calls = []
        def derive(body, include_pdfs=False):
            calls.append(body['selected_ids'])
            return {'lines':[{'estimate_id':'estimate-1','unit_price':'125.25'}], 'scope_tables':[], 'sources':[{'estimate_id':'estimate-1','sha256':'a'*64}]}
        class Handler:
            command = 'POST'
            path = '/api/commercial/save'
            headers = {}
            result = None
            def read_json(self):
                return payload
            def send_payload(self, code, value, *args, **kwargs):
                self.result = code, value
        handler = Handler()
        adapter = CommercialHTTP(self.store, derive=derive)
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 200)
        self.assertEqual(handler.result[1]['fields']['lines'][0]['unit_price'], '125.25')
        self.assertEqual(calls, [['estimate-1']])
        handler.headers = {'X-Estimator-Documentation-Workspace': self.projects.add()}
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 409)


if __name__ == '__main__':
    unittest.main()
