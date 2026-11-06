"""Issued-Quote work order references remain stable, atomic and portable."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
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
        self.assertEqual(first['fields']['order']['work_order_reference'], 'CF-123-Q-000001-01')
        self.assertEqual(self.store.save(self.workspace, payload), first)
        second = self.store.save(self.workspace, self.payload())
        self.assertEqual(second['fields']['order']['work_order_reference'], 'CF-123-Q-000001-02')
        self.assertEqual(self.store.capture(self.workspace)['work_order_counters'], {'Q-000001': 2})

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

    def test_concurrent_creates_are_sequential_and_project_scoped(self):
        payloads = [self.payload() for _ in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            documents = list(pool.map(lambda payload: self.store.save(self.workspace, payload), payloads))
        self.assertEqual({row['fields']['order']['work_order_reference'] for row in documents},
                         {f'CF-123-Q-000001-{number:02d}' for number in range(1, 9)})
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
        self.assertEqual(saved['fields']['order']['quote_reference'], 'Q-000001')
        for section, key, value in [('details', 'project_no', 'OTHER'), ('order', 'quote_id', str(uuid.uuid4())),
                                    ('order', 'quote_reference', newer_quote['last_number']), ('order', 'work_order_reference', 'replacement')]:
            changed = self.edit(saved)
            changed['fields'][section][key] = value
            with self.assertRaises(ValidationError):
                self.store.save(self.workspace, changed)
        new = self.store.save(self.workspace, self.payload())
        self.assertEqual(new['fields']['order']['work_order_reference'], 'CF-123-Q-000002-01')
        first_issue = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))
        second_issue = self.store.issue(self.workspace, saved['id'], first_issue['document']['version'], str(uuid.uuid4()))
        for issued in (first_issue, second_issue):
            text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(issued['pdf'])).pages)
            self.assertIn('CF-123-Q-000001-01', text)
            self.assertNotIn(issued['number'], text)

    def test_deleted_reference_counter_survives_fresh_database_restore(self):
        first = self.store.save(self.workspace, self.payload())
        self.store.delete(self.workspace, first['id'], first['version'])
        snapshot = self.store.capture(self.workspace)
        other_projects = Projects(Path(self.temp.name) / 'other-computer')
        workspace = other_projects.add(snapshot['project_id'])
        other = CommercialDocuments(other_projects)
        other.restore(workspace, snapshot)
        next_document = other.save(workspace, self.payload())
        self.assertEqual(next_document['fields']['order']['work_order_reference'], 'CF-123-Q-000001-02')
        older = deepcopy(snapshot)
        older['work_order_counters'] = {}
        reopened = other_projects.add(snapshot['project_id'])
        other.restore(reopened, older)
        final = other.save(reopened, self.payload())
        self.assertEqual(final['fields']['order']['work_order_reference'], 'CF-123-Q-000001-03')

    def test_purchase_reference_is_derived_and_historical_link_survives_delete(self):
        work_order = self.store.save(self.workspace, self.payload())
        payload = self.payload('purchase_order')
        payload['fields']['order']['work_order_id'] = work_order['id']
        saved = self.store.save(self.workspace, payload)
        self.assertEqual(saved['fields']['order']['work_order_reference'], 'CF-123-Q-000001-01')
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
        self.assertEqual(self.store.save(self.workspace, changed)['fields']['order']['work_order_reference'], 'CF-123-Q-000001-01')

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
        self.assertEqual(validate_commercial_documents(snapshot)['work_order_counters'], {'Q-000001': 1})

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
        self.assertEqual(handler.result[1]['fields']['order']['work_order_reference'], 'CF-123-Q-000001-01')
        payload = {**self.edit(handler.result[1]), 'workspace_id': self.workspace}
        payload['fields']['order']['work_order_reference'] = 'tampered'
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 400)


if __name__ == '__main__':
    unittest.main()
