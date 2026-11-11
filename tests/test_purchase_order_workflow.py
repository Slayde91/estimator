"""A saved Work Order can seed a separate, unnumbered procurement draft."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
import uuid
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, CommercialDocuments, default_fields
from tests.commercial_ready_fixtures import complete_quote
from estimator.commercial_http import CommercialHTTP
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from tests.test_commercial_documents import Projects


class PurchaseOrderWorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.projects = Projects(Path(temporary.name))
        self.workspace = self.projects.add()
        self.service = CommercialDocuments(self.projects, renderer=lambda *args, **kwargs: b'%PDF-1.4 fixture')
        quote = default_fields('quote', {'project_no':'PN-01', 'client':'Receiving client', 'site_address':'7 Site Road',
                                         'contact':'Site contact', 'phone':'123', 'email':'site@example.test'})
        quote['terms'] = '<p>N / A</p>'
        quote = complete_quote(quote)
        saved = self.service.save(self.workspace, {'kind':'quote', 'status':'Draft', 'fields':quote})
        self.quote = self.service.issue(self.workspace, saved['id'], saved['version'], str(uuid.uuid4()))['document']
        fields = default_fields('work_order', quote['details'])
        fields['order'].update(quote_id=self.quote['id'], description='Install selected work', estimated_cost='9999')
        fields['lines'] = [{'estimate_id':'estimate-1', 'description':'Supply equipment', 'quantity':'3',
                            'unit_price':'500', 'size':'Large', 'comments':'Manual procurement description'}]
        self.work = self.service.save(self.workspace, {'kind':'work_order', 'status':'Draft', 'fields':fields})
        self.http = CommercialHTTP(self.service)

    def defaults(self, **updates):
        return self.http.execute('purchase-order-defaults', {'workspace_id':self.workspace,
            'work_order_id':self.work['id'], 'work_order_version':self.work['version'], **updates})['fields']

    @staticmethod
    def payload(document):
        return {key:deepcopy(document[key]) for key in ('id', 'version', 'kind', 'status', 'fields')}

    def test_defaults_copy_relevant_information_without_mutation_number_or_supplier_price_assumptions(self):
        before = self.service.capture(self.workspace)
        fields = self.defaults()
        self.assertEqual(self.service.capture(self.workspace), before)
        self.assertEqual(fields['details'], self.work['fields']['details'])
        self.assertEqual(fields['order']['work_order_id'], self.work['id'])
        self.assertEqual(fields['order']['work_order_reference'], self.work['reference'])
        self.assertEqual(fields['order']['ship_to_address'], '7 Site Road')
        for key in ('supplier', 'supplier_contact', 'supplier_email', 'ship_to_name', 'site_contact_number',
                    'payment_terms', 'requested_by', 'estimated_cost'):
            self.assertEqual(fields['order'][key], '')
        self.assertEqual(fields['lines'], [{**self.work['fields']['lines'][0], 'estimate_id':'', 'unit_price':'0'}])

    def test_unknown_foreign_kind_and_stale_versions_do_not_create_a_purchase_order(self):
        before = self.service.capture(self.workspace)
        for values in ({'work_order_id':str(uuid.uuid4())}, {'work_order_id':self.quote['id']},
                       {'work_order_version':0}, {'work_order_version':True}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                self.defaults(**values)
            self.assertEqual(self.service.capture(self.workspace), before)
        with self.assertRaises(ValidationError):
            self.http.execute('purchase-order-defaults', {'workspace_id':self.projects.add(),
                'work_order_id':self.work['id'], 'work_order_version':self.work['version']})
        changed = self.service.save(self.workspace, {**self.payload(self.work), 'fields':{**self.work['fields'], 'title':'Updated source'}})
        with self.assertRaises(CommercialConflict):
            self.defaults()
        self.assertEqual(len(self.service.capture(self.workspace)['documents']), 2)
        self.assertEqual(changed['version'], self.work['version'] + 1)

    def test_save_establishes_link_and_number_without_changing_source_work_order(self):
        fields = self.defaults()
        fields['order']['expense_type'] = 'Materials'
        fields['lines'][0]['unit_price'] = '40'
        saved = self.service.save(self.workspace, {'kind':'purchase_order', 'status':'Draft', 'fields':fields})
        self.assertEqual(saved['reference'], 'PO-01')
        self.assertEqual(saved['last_number'], '')
        self.assertEqual(saved['fields']['order']['work_order_id'], self.work['id'])
        self.assertEqual(saved['fields']['order']['work_order_reference'], self.work['reference'])
        self.assertEqual(next(doc for doc in self.service.view(self.workspace)['documents'] if doc['id']==self.work['id']), self.work)
        forged = deepcopy(fields); forged['order']['work_order_reference'] = 'WO-99'
        with self.assertRaises(ValidationError):
            self.service.save(self.workspace, {'kind':'purchase_order', 'status':'Draft', 'fields':forged})

    def test_legacy_custom_expense_is_retained_until_explicit_selection(self):
        fields = self.defaults()
        saved = self.service.save(self.workspace, {'kind':'purchase_order', 'status':'Draft', 'fields':fields})
        snapshot = self.service.capture(self.workspace)
        legacy = next(doc for doc in snapshot['documents'] if doc['id']==saved['id'])
        legacy['fields']['order']['expense_type'] = 'Historic subcontract category'
        restored = self.projects.add(snapshot['project_id'])
        self.service.restore(restored, snapshot)
        legacy = next(doc for doc in self.service.view(restored)['documents'] if doc['id']==saved['id'])
        retained = self.service.save(restored, {**self.payload(legacy), 'fields':{**legacy['fields'], 'title':'Keep existing category'}})
        self.assertEqual(retained['fields']['order']['expense_type'], 'Historic subcontract category')
        reopened = next(doc for doc in self.service.view(restored)['documents'] if doc['id']==saved['id'])
        text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(render_commercial_pdf(reopened, reopened['reference'], company=DEFAULTS))).pages)
        self.assertIn('Historic subcontract category', text)
        retained['fields']['order']['expense_type'] = 'Services'
        selected = self.service.save(restored, self.payload(retained))
        self.assertEqual(selected['fields']['order']['expense_type'], 'Services')
        unsupported = self.payload(selected); unsupported['fields']['order']['expense_type'] = 'Changed unsupported category'
        with self.assertRaises(ValidationError):
            self.service.save(restored, unsupported)
        fields['order']['expense_type'] = 'New unsupported category'
        with self.assertRaises(ValidationError):
            self.service.save(self.workspace, {'kind':'purchase_order', 'status':'Draft', 'fields':fields})

    def test_hire_is_a_supported_expense_without_changing_supplier_prices(self):
        fields = self.defaults()
        fields['order']['expense_type'] = 'Hire'
        before = deepcopy(fields['lines'])
        saved = self.service.save(self.workspace, {'kind':'purchase_order', 'status':'Draft', 'fields':fields})
        self.assertEqual(saved['fields']['order']['expense_type'], 'Hire')
        self.assertEqual(saved['fields']['lines'], before)
        target = self.projects.add(self.projects.project_id(self.workspace))
        self.service.restore(target, self.service.capture(self.workspace))
        restored = next(item for item in self.service.view(target)['documents'] if item['id']==saved['id'])
        self.assertEqual(restored['fields']['order']['expense_type'], 'Hire')

    def test_uncreated_project_rejects_new_defaults_and_new_save_before_derivation(self):
        def reject(_workspace):
            raise ValidationError('Create or load a project before creating documents.')
        self.projects.require_created_project = reject
        before = self.service.capture(self.workspace)
        for action, body in [('defaults', {'kind':'quote'}), ('purchase-order-defaults',
            {'work_order_id':self.work['id'], 'work_order_version':self.work['version']}),
            ('save', {'kind':'purchase_order', 'status':'Draft', 'fields':default_fields('purchase_order')})]:
            with self.subTest(action=action), self.assertRaisesRegex(ValidationError, 'Create or load'):
                self.http.execute(action, {'workspace_id':self.workspace, **body})
        self.assertEqual(self.service.capture(self.workspace), before)
        updated = self.http.execute('save', {'workspace_id':self.workspace, **self.payload(self.work),
            'fields':{**self.work['fields'], 'title':'Existing document can still be edited'}})
        self.assertEqual(updated['fields']['title'], 'Existing document can still be edited')
