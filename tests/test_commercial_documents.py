from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from html import unescape
from io import BytesIO
from pathlib import Path
import re
import tempfile
import unittest
import uuid

from pypdf import PdfReader
from reportlab.pdfgen import canvas

from estimator.catalog import ValidationError
from estimator.commercial_documents import (CommercialConflict, CommercialDocuments,
    default_fields, default_terms, format_terms, totals, validate_commercial_documents, validate_rich_text)
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from tests.commercial_ready_fixtures import complete_quote, complete_work_order


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

    def require_created_project(self, workspace):
        # Pure service fixtures represent capabilities already verified by the
        # native Project lifecycle; integration tests use the real guard.
        return self.project_id(workspace)


class CommercialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.projects = Projects(self.temporary.name)
        self.workspace = self.projects.add()
        self.store = CommercialDocuments(self.projects)

    def payload(self, kind='work_order', workspace=None):
        fields = complete_quote(default_fields(kind)) if kind == 'quote' else complete_work_order(default_fields(kind), 'Review') if kind == 'work_order' else default_fields(kind)
        fields['details'].update(client='Example client', site_address='10 Example Road', project_no='CF-10', date='2026-11-06')
        fields['lines'] = [{'estimate_id':'estimate-1', 'description':'Supply and installation', 'quantity':'2', 'unit_price':'125.25'}]
        if kind == 'work_order':
            workspace = workspace or self.workspace
            quote = next((row for row in self.store.view(workspace)['documents'] if row['kind'] == 'quote' and row['last_number']), None)
            if quote is None:
                quote_payload = self.payload('quote')
                quote_payload['fields']['terms'] = '<p>N / A</p>'
                quote = self.store.save(workspace, quote_payload)
                quote = self.store.issue(workspace, quote['id'], quote['version'], str(uuid.uuid4()))['document']
            fields['order']['quote_id'] = quote['id']
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

    def test_filing_moves_manual_logs_to_exact_source_once_for_every_commercial_kind(self):
        from estimator.commercial_sources import source_id
        actor = {'id':'staff','name':'Estimator'}
        logged = set()
        for kind in ('quote','work_order','purchase_order'):
            doc = self.store.save(self.workspace,self.payload(kind),unfiled_context={})
            logged.add(doc['id'])
            entry = {'request_id':str(uuid.uuid4()),'type':'Call','text':kind,'occurred_at':'2020-05-01T04:00:00Z'}
            self.store.activity(self.workspace,doc['id'],entry=entry,actor=actor,staff=lambda:[],version=doc['version'])
            items = self.store.activity(self.workspace,doc['id'])['events']
            self.assertEqual([row['subject'] for row in items if row['label']=='Call'],[kind])
            local = next(row for row in self.store.unfiled.cards(self.workspace) if row['id']==doc['id'])
            receipt = self.store.unfiled.activity({'file_id':local['source_file'],'revision':local['source_revision']},doc['id'])
            self.assertIn(kind,[row.get('subject') for row in receipt['events']])
        snapshot = self.store.capture(self.workspace)
        with self.store.publishing(self.workspace,snapshot,path='original.cf.json'):
            pass
        with self.store.publishing(self.workspace,snapshot,path='copy.cf.json'):
            pass
        for doc in snapshot['documents']:
            original = self.store.saved_activity(snapshot,doc['id'],source_id('original.cf.json'))
            copied = self.store.saved_activity(snapshot,doc['id'],source_id('copy.cf.json'))
            active = self.store.activity(self.workspace,doc['id'])
            self.assertFalse(any(row['label']=='Call' for row in copied['events']+active['events']))
            if doc['id'] in logged:
                self.assertIn(doc['kind'],[row.get('subject') for row in original['events']])

    def test_activity_follows_selected_version_across_reopens_and_divergent_copies(self):
        doc = self.store.save(self.workspace, self.payload('quote'))
        identity = doc['id']
        base = self.store.capture(self.workspace)
        other = self.projects.add(base['project_id'])
        self.store.restore(other, base)
        self.store.issue(self.workspace, identity, doc['version'], str(uuid.uuid4()))
        changed = deepcopy(doc['fields'])
        changed['title'] = 'Copy-only title'
        self.store.save(other, {'kind':'quote', 'id':identity, 'version':doc['version'],
                                'status':doc['status'], 'fields':changed})
        events = self.store.activity(self.workspace, identity)['events']
        self.assertEqual([event['label'] for event in events], ['PDF issued','Created'])
        self.assertTrue(events[0]['subject'])
        events = self.store.saved_activity(self.store.capture(other), identity)['events']
        self.assertEqual([event['label'] for event in events], ['Updated','Created'])
        self.assertEqual([event['label'] for event in self.store.saved_activity(base, identity)['events']], ['Created'])
        unknown = deepcopy(base)
        unknown['project_id'] = str(uuid.uuid4())
        unknown['documents'][0]['updated_at'] = '2026-11-12T00:00:00Z'
        fallback = self.store.saved_activity(unknown, identity)['events']
        self.assertEqual(fallback, [{'label':'Updated', 'at':'2026-11-12T00:00:00Z'},
                                    {'label':'Created', 'at':doc['created_at']}])
        with self.assertRaises(ValidationError):
            self.store.activity(self.projects.add(), identity)

    def test_delayed_create_retry_cannot_restore_a_deleted_document(self):
        payload = self.payload()
        saved = self.store.save(self.workspace, payload)
        self.store.delete(self.workspace, saved['id'], saved['version'])
        with self.assertRaises(CommercialConflict):
            self.store.save(self.workspace, payload)
        self.assertFalse(any(row['kind'] == 'work_order' for row in self.store.capture(self.workspace)['documents']))

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
        self.assertEqual(issued['number'], 'WO-01')
        self.assertEqual(replay['pdf'], issued['pdf'])
        with self.assertRaises(CommercialConflict):
            self.store.issue(self.workspace, saved['id'], saved['version'], request_id, {**DEFAULTS,'name':'Changed'})
        next_issue = self.store.issue(self.workspace, saved['id'], issued['document']['version'], str(uuid.uuid4()))
        self.assertEqual(next_issue['number'], 'WO-01')
        self.assertNotEqual(next_issue['filename'], issued['filename'])

    def test_failed_pdf_does_not_consume_a_number(self):
        saved = self.store.save(self.workspace, self.payload())
        def fail(*args, **kwargs):
            raise ValueError('render failed')
        self.store.renderer = fail
        with self.assertRaises(ValueError):
            self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))
        self.store.renderer = None
        self.assertEqual(self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))['number'], 'WO-01')

    def test_concurrent_projects_receive_distinct_numbers(self):
        another = self.projects.add()
        first = self.store.save(self.workspace, self.payload())
        second = self.store.save(another, self.payload(workspace=another))
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.store.issue, workspace, document['id'], document['version'], str(uuid.uuid4())) for workspace, document in [(self.workspace, first),(another,second)]]
            self.assertEqual({future.result()['number'] for future in futures}, {'WO-01','WO-02'})

    def test_imported_number_can_advance_but_not_rewind_sequence(self):
        self.store.save(self.workspace, self.payload())
        snapshot = self.store.capture(self.workspace)
        saved = next(row for row in snapshot['documents'] if row['kind'] == 'work_order')
        snapshot['reference_counters']['work_order']['WO'] = 50
        restored = self.projects.add(snapshot['project_id'])
        self.store.restore(restored, snapshot)
        issue = self.store.issue(restored, saved['id'], saved['version'], str(uuid.uuid4()))
        self.assertEqual(issue['number'], 'WO-01')
        first_new = self.store.save(restored, self.payload(workspace=restored))
        self.assertEqual(first_new['reference'], 'WO-51')
        older = self.projects.add(snapshot['project_id'])
        snapshot['reference_counters']['work_order']['WO'] = 2
        self.store.restore(older, snapshot)
        self.assertEqual(self.store.save(older, self.payload(workspace=older))['reference'], 'WO-52')

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
        self.assertIn('<b>1.1</b>', terms)
        self.assertIn('<b>(a)</b>', terms)
        self.assertIn('<b>ACL or Australian Consumer Law</b>', terms)
        self.assertIn('<b>NACE</b> refers to', terms)

    def test_generated_pdf_fonts_use_montserrat_and_keep_real_emphasis(self):
        for kind in ('quote', 'work_order', 'purchase_order'):
            with self.subTest(kind=kind):
                fields = default_fields(kind)
                fields['lines'] = [{'description': 'Installation', 'quantity': '1', 'unit_price': '100'}]
                fields['allowances'] = '<p>Regular marker <b>Bold marker</b> <i>Italic marker</i> <b><i>Combined marker</i></b></p><ul><li>List marker</li></ul>'
                fields['terms'] = '<p>1. Terms</p><p>1.1 Retain <i>terms emphasis</i>.</p>'
                spans = []
                pdf = render_commercial_pdf({'kind': kind, 'status': 'Draft', 'fields': fields}, 'QA-000001', company=DEFAULTS)
                for page in PdfReader(BytesIO(pdf)).pages:
                    page.extract_text(visitor_text=lambda value, cm, tm, font, size:
                                      spans.append((value, str((font or {}).get('/BaseFont', '')))) if value.strip() else None)
                self.assertTrue(spans)
                self.assertTrue(all('Montserrat' in font for _, font in spans), spans)
                if kind == 'quote':
                    for marker, style in [('Regular marker', 'Regular'), ('Bold marker', 'Bold'),
                                          ('Italic marker', 'Italic'), ('Combined marker', 'BoldItalic')]:
                        self.assertTrue(any(marker in value and style in font for value, font in spans), (marker, spans))
                    rendered = ''.join(value for value, _ in spans)
                    for label in ('Accepted by', 'Title', 'Signature', 'Date'):
                        self.assertIn(label, rendered)

    def test_terms_emphasis_preserves_existing_text_and_formats_older_quotes(self):
        original = ('<p><strong>19.</strong> Definitions</p>'
                    '<p><i>ACL</i> or Australian Consumer Law means A &amp; B.</p>'
                    '<p>Moral Rights has the meaning stated. NACE refers to an institute.</p>'
                    '<p>20. Interpretation</p><p>(a) First item (1) nested item.</p>'
                    '<p>1.1 Keep <u>entered wording</u> and clause 7.2 references.</p>')
        formatted = format_terms(original)
        self.assertEqual(unescape(re.sub(r'<[^>]+>', '', formatted)),
                         unescape(re.sub(r'<[^>]+>', '', original)))
        self.assertEqual(format_terms(formatted), formatted)
        self.assertIn('<b>(1)</b>', formatted)
        self.assertIn('<b>NACE</b>', formatted)
        self.assertIn('clause 7.2 references', formatted)
        fields = self.payload('quote')['fields']
        fields['terms'] = original
        pdf = render_commercial_pdf({'kind': 'quote', 'fields': fields}, 'Q-000001', company=DEFAULTS)
        spans = []
        for page in PdfReader(BytesIO(pdf)).pages:
            page.extract_text(visitor_text=lambda text, cm, tm, font, size:
                              spans.append((text, str((font or {}).get('/BaseFont', '')))))
        for label in ('1.1', '(a)', '(1)', 'NACE', 'Moral Rights'):
            self.assertTrue(any(label in text and 'Bold' in font for text, font in spans), label)

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
        scope_pages = [page.extract_text() for page in reader.pages if 'EXACT FULL SCHEDULE EVIDENCE' in page.extract_text()]
        self.assertEqual(len(scope_pages), 1)
        positions = [text.index(section) for section in ('EXACT FULL SCHEDULE EVIDENCE', 'ALLOWANCES',
                                                        'QUOTE SUMMARY', 'SCHEDULE OF RATES', 'TERMS OF TRADE')]
        self.assertEqual(positions, sorted(positions))
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
        self.assertFalse(any(row['kind'] == 'work_order' for row in self.store.capture(self.workspace)['documents']))
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
        self.assertFalse(any(row['kind'] == 'work_order' for row in snapshot['documents']))
        restored = self.projects.add(snapshot['project_id'])
        self.store.restore(restored, snapshot)
        created = self.store.save(restored, self.payload(workspace=restored))
        self.assertEqual(self.store.issue(restored, created['id'], created['version'], str(uuid.uuid4()))['number'], 'WO-02')

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
