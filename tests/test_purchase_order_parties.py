"""Explicit purchase-order parties survive directory changes and stay scoped to their order."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.account_relations import AccountRelations
from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialDocuments, PURCHASE_PARTY_LABELS, commercial_cards, default_fields
from estimator.contact_relations import ContactRelations
from estimator.contacts import ContactsStore
from tests.test_commercial_documents import Projects
from tests.test_contact_relations import KnownProjects


class PurchaseOrderPartiesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.directory = ContactsStore(root / 'contacts.sqlite3')
        self.supplier = self.person('Supplier', 'sam@supplier.test')
        self.colleague = self.person('Supplier', 'colleague@supplier.test')
        self.site = self.person('Customer', 'sam@customer.test')
        self.projects = Projects(root)
        self.workspace = self.projects.add()
        self.commercial = CommercialDocuments(self.projects, validate_purchase_parties=self.directory.validate_purchase_parties)
        fields = default_fields('purchase_order', {'client':'Customer', 'project_no':'PN-01'})
        fields['order'].update(supplier='Supplier', supplier_account_id=self.supplier['account_id'],
                               supplier_contact='Sam', supplier_contact_id=self.supplier['id'], ship_to_name='Sam', site_contact_id=self.site['id'])
        self.payload = {'kind':'purchase_order', 'id':str(uuid4()), 'status':'Draft', 'version':0, 'fields':fields}

    def person(self, company, email):
        return self.directory.save('contacts', {'version':self.directory.list()['version'],
            'fields':{'name':'Sam', 'company':company, 'phone':'111', 'email':email}})['contact']

    def test_bad_or_foreign_directory_selections_cannot_allocate_an_order(self):
        before = self.commercial.capture(self.workspace)
        for change in ({'supplier_contact_id':self.site['id']}, {'supplier':'Other company'}, {'site_contact_id':str(uuid4())},
                       {'supplier_account_id':self.site['account_id']}, {'supplier_contact_id':'not-an-id'}):
            with self.subTest(change=change):
                payload = deepcopy(self.payload)
                payload['fields']['order'].update(change)
                with self.assertRaises(ValidationError):
                    self.commercial.save(self.workspace, payload)
                self.assertEqual(self.commercial.capture(self.workspace), before)
        saved = self.commercial.save(self.workspace, self.payload)
        self.assertEqual(saved['reference'], 'PO-01')
        self.assertEqual(self.commercial.save(self.workspace, self.payload), saved)

    def test_rename_restore_legacy_editor_and_explicit_clear(self):
        saved = self.commercial.save(self.workspace, self.payload)
        issued = self.commercial.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))
        source = self.commercial.capture(self.workspace)
        reopened = self.projects.add(source['project_id'])
        self.commercial.restore(reopened, source)
        self.directory.save('accounts', {'id':self.supplier['account_id'], 'fields':{'company':'Renamed supplier'},
                                         'version':self.directory.list()['version']})
        fields = deepcopy(issued['document']['fields'])
        for key in PURCHASE_PARTY_LABELS:
            fields['order'].pop(key)
        fields['title'] = 'Old editor changes only the title'
        def save(fields, version):
            return self.commercial.save(reopened, {**self.payload, 'version':version, 'fields':fields})
        retained = save(fields, issued['document']['version'])
        self.assertEqual(retained['fields']['order'], saved['fields']['order'])
        fields['order']['supplier'] = 'Manually entered supplier'
        changed = save(fields, retained['version'])
        self.assertFalse(changed['fields']['order'].get('supplier_account_id'))
        self.assertFalse(changed['fields']['order'].get('supplier_contact_id'))
        self.assertEqual(changed['fields']['order']['site_contact_id'], self.site['id'])
        fields['order']['site_contact_id'] = ''
        cleared = save(fields, changed['version'])
        self.assertFalse(cleared['fields']['order'].get('site_contact_id'))
        self.assertEqual(self.commercial.read_pdf(reopened, issued['id'])[1], issued['pdf'])
        self.assertEqual(self.commercial.capture(self.workspace), source)

    def test_links_only_attach_this_order_to_its_selected_parties(self):
        self.commercial.save(self.workspace, self.payload)
        snapshot = self.commercial.capture(self.workspace)
        card, = commercial_cards(snapshot)
        projects = KnownProjects()
        owner = snapshot['project_id']
        projects.files = [{'id':'source', 'source_project_id':owner, 'account_id':self.site['account_id'],
                           'client':'Customer', 'project_no':'PN-01', 'commercial_cards':[card]}]
        other = deepcopy(card)
        other['id'] = str(uuid4())
        other['fields']['order'] = {'supplier':'Supplier', 'supplier_contact':'Sam'}
        projects.documents = [{**other, 'source_file':'source'}]
        account = AccountRelations(self.directory, projects)
        person = ContactRelations(self.directory, projects)
        token = owner + ':' + card['id']
        def verify():
            supplier = account.view(self.supplier['account_id'])['linked']
            self.assertFalse(supplier['projects'])
            self.assertEqual([row['id'] for row in supplier['purchase_orders'] if row['supplier']], [token])
            self.assertEqual(person.view(self.supplier['id'])['linked']['purchase_orders'][0]['roles'], ['Supplier contact'])
            self.assertFalse(person.view(self.colleague['id'])['linked']['purchase_orders'])
            self.assertEqual(person.view(self.site['id'])['linked']['purchase_orders'][0]['roles'], ['Site contact'])
        verify()
        other_copy = deepcopy(card)
        for key in PURCHASE_PARTY_LABELS:
            other_copy['fields']['order'].pop(key)
        projects.files.append({'id':'copy', 'account_link_id':str(uuid4()), 'source_project_id':owner, 'client':'Foreign copy',
                               'project_no':'PN-OTHER', 'commercial_cards':[other_copy]})
        verify()
        self.assertIn('PN-01', account.view(self.supplier['account_id'])['linked']['purchase_orders'][0]['label'])
        projects.files.clear()
        projects.documents = [{**card, 'source_file':'local-owner', 'unfiled':True}]
        verify()
        projects.documents[0].pop('unfiled')
        self.assertFalse(account.view(self.supplier['account_id'])['linked']['purchase_orders'])
        self.assertFalse(person.view(self.site['id'])['linked']['purchase_orders'])
        projects.documents[0].pop('source_file')
        self.assertFalse(account.view(self.supplier['account_id'])['linked']['purchase_orders'])
        self.assertFalse(person.view(self.site['id'])['linked']['purchase_orders'])

    def test_exact_party_beats_project_association_and_source_order_breaks_ties(self):
        self.commercial.save(self.workspace, self.payload)
        snapshot = self.commercial.capture(self.workspace)
        card, = commercial_cards(snapshot)
        copy = deepcopy(card)
        copy['fields']['order'].pop('supplier_account_id')
        copy['fields']['order'].pop('supplier_contact_id')
        projects = KnownProjects()
        def project(source, indexed, **fields):
            return {'id':source, 'source_project_id':snapshot['project_id'], 'account_link_id':str(uuid4()),
                    'project_no':source, 'commercial_cards':[indexed], **fields}
        primary = project('A copied buyer', copy, account_id=self.supplier['account_id'], contact_id=self.supplier['id'])
        first = project('B vendor original', card)
        second = project('C vendor copy', deepcopy(card))
        for order in ([primary, first, second], [second, first, primary]):
            projects.files = order
            vendor, = AccountRelations(self.directory, projects).view(self.supplier['account_id'])['linked']['purchase_orders']
            person, = ContactRelations(self.directory, projects).view(self.supplier['id'])['linked']['purchase_orders']
            self.assertTrue(vendor['supplier'])
            self.assertEqual(person['roles'], ['Supplier contact'])
            self.assertEqual(vendor['label'], person['label'])
            self.assertIn('B vendor original', person['label'])
