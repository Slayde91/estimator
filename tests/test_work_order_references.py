"""Issued-Quote work order references remain stable, atomic and portable."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialDocuments, default_fields, validate_commercial_documents
from estimator.commercial_http import CommercialHTTP
from tests.test_commercial_documents import Projects


class WorkOrderReferences(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.projects = Projects(self.temp.name)
        self.workspace = self.projects.add()
        self.store = CommercialDocuments(self.projects)
        self.quote = self.create_quote()

    def payload(self, kind='work_order', quote=None):
        fields = default_fields(kind)
        fields['details']['project_no'] = 'CF-123'
        if kind == 'work_order':
            fields['order']['quote_id'] = (quote or self.quote)['id']
        return {'id': str(uuid.uuid4()), 'version': 0, 'kind': kind, 'status': 'Draft', 'fields': fields}

    def create_quote(self, issue=True):
        payload = self.payload('quote')
        payload['fields']['terms'] = ''
        quote = self.store.save(self.workspace, payload)
        if issue:
            quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid.uuid4()))['document']
        return quote

    @staticmethod
    def edit(document):
        return {key: deepcopy(document[key]) for key in ('id', 'version', 'kind', 'status', 'fields')}

    def test_allocates_only_on_save_and_exact_retry_does_not_consume(self):
        payload = self.payload()
        self.assertEqual(self.store.capture(self.workspace)['work_order_counters'], {})
        first = self.store.save(self.workspace, payload)
        self.assertEqual(first['fields']['order']['work_order_reference'], 'WO-01')
        self.assertEqual(self.store.save(self.workspace, payload), first)
        second = self.store.save(self.workspace, self.payload())
        self.assertEqual(second['fields']['order']['work_order_reference'], 'WO-02')
        self.assertEqual(self.store.capture(self.workspace)['reference_counters']['work_order'], {'WO': 2})

    def test_requires_project_and_issued_quote_and_rejects_injected_reference(self):
        unissued = self.create_quote(False)
        attempts = [self.payload(quote=unissued)]
        for field, value in [('quote_id', ''), ('quote_reference', 'Q-999999'), ('work_order_reference', 'CF-123-Q-000001-50'), ('work_order_id', self.quote['id'])]:
            payload = self.payload()
            payload['fields']['order'][field] = value
            attempts.append(payload)
        for project_no in ('', '  ', 'CF-123\nInjected'):
            payload = self.payload()
            payload['fields']['details']['project_no'] = project_no
            attempts.append(payload)
        for payload in attempts:
            with self.subTest(payload=payload['fields']['order']):
                with self.assertRaises(ValidationError):
                    self.store.save(self.workspace, payload)
        self.assertEqual(self.store.capture(self.workspace)['work_order_counters'], {})

    def test_compact_reference_and_gst_inclusive_default_with_editable_cost(self):
        quote = self.edit(self.quote)
        quote['fields']['lines'] = [{'description': 'Installation', 'quantity': '3', 'unit_price': '140.50'}]
        quote = self.store.save(self.workspace, quote)
        settings = {k:{'prefix':v['prefix'], 'start_number':v['start_number']} for k,v in self.store.numbering.settings().items()}
        settings['quote']['start_number'] = 10
        self.store.numbering.save_settings(settings)
        quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid.uuid4()))['document']
        payload = self.payload(quote=quote)
        payload['fields']['details']['project_no'] = 'PN-00002'
        saved = self.store.save(self.workspace, payload)
        self.assertEqual(saved['fields']['order']['work_order_reference'], 'WO-01')
        self.assertEqual(saved['fields']['order']['estimated_cost'], '463.65')
        self.assertEqual(self.store.save(self.workspace, payload), saved)
        override = self.edit(saved)
        override['fields']['order']['estimated_cost'] = '500.00'
        saved = self.store.save(self.workspace, override)
        self.assertEqual(saved['fields']['order']['estimated_cost'], '500.00')
        explicit_zero = self.payload(quote=quote)
        explicit_zero['fields']['order']['estimated_cost'] = '0'
        self.assertEqual(self.store.save(self.workspace, explicit_zero)['fields']['order']['estimated_cost'], '0')

    def test_legacy_order_links_compact_on_read_and_keep_issued_pdf(self):
        from estimator.commercial_pdf import render_commercial_pdf
        from estimator.document_numbers import SERIES
        with patch.dict(SERIES, {'quote':('Q',6)}):
            self.quote = self.create_quote()
        legacy_ref = 'CF-123-' + self.quote['last_number'] + '-01'
        with patch.object(self.store, 'renderer', lambda document, number, **kwargs: render_commercial_pdf(document, legacy_ref, **kwargs)):
            old = self.store.save(self.workspace, self.payload())
            purchase = self.payload('purchase_order')
            purchase['fields']['order']['work_order_id'] = old['id']
            self.store.save(self.workspace, purchase)
            request_id = str(uuid.uuid4())
            issued = self.store.issue(self.workspace, old['id'], old['version'], request_id)
            snapshot = self.store.capture(self.workspace)
        for row in snapshot['documents']:
            if row['kind'] != 'quote':
                row.pop('reference')
                row['fields']['order']['work_order_reference'] = legacy_ref
        self.assertIn(legacy_ref, PdfReader(BytesIO(issued['pdf'])).pages[0].extract_text())
        self.assertEqual(self.store.read_pdf(self.workspace, issued['id'])[1], issued['pdf'])
        replay = self.store.issue(self.workspace, old['id'], old['version'], request_id)
        self.assertEqual(replay['pdf'], issued['pdf'])
        self.assertEqual(replay['document']['fields']['order']['work_order_reference'], 'WO-01')
        portable = self.projects.add(snapshot['project_id'])
        self.store.restore(portable, snapshot)
        for workspace in (self.workspace, portable):
            documents = {row['kind']: row for row in self.store.view(workspace)['documents']}
            self.assertEqual(documents['purchase_order']['fields']['order']['work_order_id'], old['id'])
            for kind in ('purchase_order', 'work_order'):
                self.assertEqual(documents[kind]['fields']['order']['work_order_reference'], 'WO-01')
        next_order = self.store.save(portable, self.payload())
        self.assertEqual(next_order['fields']['order']['work_order_reference'], 'WO-02')

    def test_cost_follows_pinned_issue_through_draft_edits_reissue_and_portable_restore(self):
        def set_price(document, amount):
            changed = self.edit(document)
            changed['fields']['lines'] = [{'description': 'Work', 'quantity': '1', 'unit_price': amount}]
            return self.store.save(self.workspace, changed)

        quote = set_price(self.quote, '100')
        issue = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid.uuid4()))
        number = issue['number']
        quote = set_price(issue['document'], '300')
        # The unissued edit is 330.00 including GST, but the linked issue is 110.00.
        order = self.store.save(self.workspace, self.payload(quote=quote))
        self.assertEqual(order['fields']['order']['estimated_cost'], '110.00')
        new_issue = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid.uuid4()))
        snapshot = self.store.capture(self.workspace)
        blank = next(item for item in snapshot['documents'] if item['id'] == order['id'])
        blank['fields']['order']['estimated_cost'] = ''
        reopened = self.projects.add(snapshot['project_id'])
        self.store.restore(reopened, snapshot)
        state = self.store.view(reopened, include_quote_totals=True)
        self.assertEqual(state['quote_totals'][quote['id']], {number: '110.00', new_issue['number']: '330.00'})
        self.assertEqual(self.store.capture(reopened), snapshot)
        self.assertEqual(self.store.save(reopened, self.edit(blank))['fields']['order']['estimated_cost'], '110.00')
        override = self.payload(quote=new_issue['document'])
        override['fields']['order']['estimated_cost'] = '42.00'
        self.assertEqual(self.store.save(reopened, override)['fields']['order']['estimated_cost'], '42.00')
        self.assertEqual(self.store.read_pdf(reopened, issue['id'])[1], issue['pdf'])
        fresh = self.projects.add(snapshot['project_id'])
        self.store.restore(fresh, snapshot)
        order_pdf = self.store.issue(fresh, blank['id'], blank['version'], str(uuid.uuid4()))
        self.assertEqual(order_pdf['document']['fields']['order']['estimated_cost'], '110.00')
        self.assertIn('110.00', PdfReader(BytesIO(order_pdf['pdf'])).pages[0].extract_text())

        different_project = self.projects.add()
        self.store.restore(different_project, {**snapshot, 'project_id': self.projects.project_id(different_project)})
        state = self.store.view(different_project, include_quote_totals=True)
        self.assertEqual(state['quote_totals'][quote['id']][number], '')

        imported_projects = Projects(Path(self.temp.name) / 'portable-no-history')
        workspace = imported_projects.add(snapshot['project_id'])
        portable = CommercialDocuments(imported_projects)
        portable.restore(workspace, snapshot)
        state = portable.view(workspace, include_quote_totals=True)
        self.assertEqual(state['quote_totals'][quote['id']], {number: '', new_issue['number']: '330.00'})
        self.assertEqual(portable.save(workspace, self.edit(blank))['fields']['order']['estimated_cost'], '')
        self.assertEqual(portable.save(workspace, self.payload(quote=new_issue['document']))['fields']['order']['estimated_cost'], '330.00')

    def test_concurrent_creates_are_sequential_and_project_scoped(self):
        payloads = [self.payload() for _ in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            documents = list(pool.map(lambda payload: self.store.save(self.workspace, payload), payloads))
        self.assertEqual({row['fields']['order']['work_order_reference'] for row in documents},
                         {f'WO-{number:02d}' for number in range(1, 9)})
        reopened = self.projects.add(self.projects.project_id(self.workspace))
        self.store.restore(reopened, self.store.capture(self.workspace))
        next_document = self.store.save(reopened, self.payload())
        self.assertTrue(next_document['fields']['order']['work_order_reference'].endswith('-09'))

    def test_freezes_reference_and_project_after_quote_is_issued_again(self):
        original = self.store.save(self.workspace, self.payload())
        newer_quote = self.store.issue(self.workspace, self.quote['id'], self.quote['version'], str(uuid.uuid4()))['document']
        edit = self.edit(original)
        edit['fields']['title'] = 'Updated title'
        saved = self.store.save(self.workspace, edit)
        self.assertEqual(saved['fields']['order']['quote_reference'], 'Q-01')
        for section, key, value in [('details', 'project_no', 'OTHER'), ('order', 'quote_id', str(uuid.uuid4())),
                                    ('order', 'quote_reference', newer_quote['last_number']), ('order', 'work_order_reference', 'replacement')]:
            changed = self.edit(saved)
            changed['fields'][section][key] = value
            with self.assertRaises(ValidationError):
                self.store.save(self.workspace, changed)
        new = self.store.save(self.workspace, self.payload())
        self.assertEqual(new['fields']['order']['work_order_reference'], 'WO-02')
        first_issue = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))
        second_issue = self.store.issue(self.workspace, saved['id'], first_issue['document']['version'], str(uuid.uuid4()))
        for issued in (first_issue, second_issue):
            text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(issued['pdf'])).pages)
            self.assertIn('WO-01', text)
            self.assertEqual(issued['number'], 'WO-01')

    def test_deleted_reference_counter_survives_fresh_database_restore(self):
        first = self.store.save(self.workspace, self.payload())
        self.store.delete(self.workspace, first['id'], first['version'])
        snapshot = self.store.capture(self.workspace)
        other_projects = Projects(Path(self.temp.name) / 'other-computer')
        workspace = other_projects.add(snapshot['project_id'])
        other = CommercialDocuments(other_projects)
        other.restore(workspace, snapshot)
        next_document = other.save(workspace, self.payload())
        self.assertEqual(next_document['fields']['order']['work_order_reference'], 'WO-02')
        older = deepcopy(snapshot)
        older['work_order_counters'] = {}
        reopened = other_projects.add(snapshot['project_id'])
        other.restore(reopened, older)
        final = other.save(reopened, self.payload())
        self.assertEqual(final['fields']['order']['work_order_reference'], 'WO-03')

    def test_purchase_reference_is_derived_and_historical_link_survives_delete(self):
        work_order = self.store.save(self.workspace, self.payload())
        payload = self.payload('purchase_order')
        payload['fields']['order']['work_order_id'] = work_order['id']
        saved = self.store.save(self.workspace, payload)
        self.assertEqual(saved['fields']['order']['work_order_reference'], 'WO-01')
        self.assertEqual(self.store.save(self.workspace, payload), saved)
        injected = self.edit(saved)
        injected['fields']['order']['work_order_reference'] = 'manual reference'
        with self.assertRaises(ValidationError):
            self.store.save(self.workspace, injected)
        unlinked = self.payload('purchase_order')
        unlinked['fields']['order']['work_order_reference'] = 'manual reference'
        with self.assertRaises(ValidationError):
            self.store.save(self.workspace, unlinked)
        self.store.delete(self.workspace, work_order['id'], work_order['version'])
        changed = self.edit(saved)
        changed['fields']['title'] = 'Still editable'
        self.assertEqual(self.store.save(self.workspace, changed)['fields']['order']['work_order_reference'], 'WO-01')

    def test_cross_project_links_are_rejected(self):
        other = self.projects.add()
        with self.assertRaises(ValidationError):
            self.store.save(other, self.payload())
        work_order = self.store.save(self.workspace, self.payload())
        purchase = self.payload('purchase_order')
        purchase['fields']['order']['work_order_id'] = work_order['id']
        with self.assertRaises(ValidationError):
            self.store.save(other, purchase)

    def test_legacy_snapshot_normalises_and_can_still_edit_existing_orders(self):
        saved = self.store.save(self.workspace, self.payload())
        snapshot = self.store.capture(self.workspace)
        snapshot.pop('work_order_counters')
        for doc in snapshot['documents']:
            doc['fields']['order'].pop('quote_id')
            doc['fields']['order'].pop('work_order_id')
        normalised = validate_commercial_documents(snapshot)
        self.assertEqual(normalised['work_order_counters'], {})
        other_projects = Projects(Path(self.temp.name) / 'legacy')
        workspace = other_projects.add(snapshot['project_id'])
        other = CommercialDocuments(other_projects)
        other.restore(workspace, snapshot)
        restored = next(row for row in other.view(workspace)['documents'] if row['id'] == saved['id'])
        edit = self.edit(restored)
        edit['fields']['title'] = 'Legacy edit'
        self.assertEqual(other.save(workspace, edit)['fields']['title'], 'Legacy edit')

    def test_counter_validation_and_restore_recover_saved_reference_highwater(self):
        self.store.save(self.workspace, self.payload())
        snapshot = self.store.capture(self.workspace)
        for counters in ({'wrong': 1}, {'Q-000001': True}, {'Q-000001': -1}, []):
            with self.assertRaises(ValidationError):
                validate_commercial_documents({**snapshot, 'work_order_counters': counters})
        snapshot.pop('work_order_counters')
        self.assertEqual(validate_commercial_documents(snapshot)['reference_counters']['work_order'], {'WO': 1})

    def test_http_save_returns_derived_reference_and_rejects_manual_override(self):
        payload = self.payload()
        payload['workspace_id'] = self.workspace
        class Handler:
            command = 'POST'
            path = '/api/commercial/save'
            headers = {}
            def read_json(self):
                return deepcopy(payload)
            def send_payload(self, status, result, *args, **kwargs):
                self.result = status, result
        handler = Handler()
        adapter = CommercialHTTP(self.store)
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 200)
        self.assertEqual(handler.result[1]['fields']['order']['work_order_reference'], 'WO-01')
        payload = {**self.edit(handler.result[1]), 'workspace_id': self.workspace}
        payload['fields']['order']['work_order_reference'] = 'tampered'
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 400)


if __name__ == '__main__':
    unittest.main()
