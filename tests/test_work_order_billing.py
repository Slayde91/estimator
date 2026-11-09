from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
import unittest
from uuid import uuid4

from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, validate_fields
from estimator.commercial_http import CommercialHTTP
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from estimator.contact_relations import ContactRelations
from estimator.contacts import ContactsStore
from estimator.crm_identity import DuplicateReview
from estimator.work_order_billing import WorkOrderBilling
from tests import test_work_order_tracking as tracking


class WorkOrderBillingTests(unittest.TestCase):
    def setUp(self):
        self.fixture=tracking.WorkOrderTrackingTests()
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.store=self.fixture.store
        self.directory=ContactsStore(self.fixture.root/'people.sqlite3')
        self.sources=SimpleNamespace(commercial=self.store,_commercial_sources=SimpleNamespace(ignored_owners=lambda:set()))
        self.billing=WorkOrderBilling(self.directory,self.sources)
        self.http=CommercialHTTP(self.store,billing=self.billing)
        self.account=self.directory.save('accounts',{'version':0,'fields':{'company':'Client Pty Ltd','billing_address':'Main office','abn_acn':'Company reference'}})['id']
        self.details={'project_no':'PN-01','client':'Client Pty Ltd','site_address':'10 Work Street','account_id':self.account,
                      'contact_name':'Project Manager','contact_email':'manager@example.test','contact_phone':'0400 111 333'}
        self.values={'address':'Accounts office','abn_acn':'Claim reference','name':'Alex Accounts','email':'alex@example.test',
                     'phone':'0400 111 222','account_id':self.account,'new_contact_key':str(uuid4())}

    def save(self, values=None, previous=None, **extra):
        fields=deepcopy(previous['fields']) if previous else self.fixture.fields()
        if values is not None:fields['billing']=values
        else:fields.pop('billing',None)
        return self.http.execute('save',{'workspace_id':self.fixture.workspace,'kind':'work_order',
            'id':previous['id'] if previous else str(uuid4()),'version':previous['version'] if previous else 0,'status':'Draft',
            'fields':fields,'project_details':self.details,'retain_unfiled':True,**extra})

    def source(self, doc):
        card=next(row for row in self.store.unfiled.cards(None) if row['id']==doc['id'])
        return {'source':{'file_id':card['source_file'],'revision':card['source_revision']},
                'id':doc['id'],'version':doc['version'],'new_contact_key':doc['fields']['billing']['new_contact_key']}

    def test_saved_unfiled_work_order_controls_creation_and_exact_retry(self):
        doc=self.save(self.values);first=self.source(doc); original=self.directory.list()
        self.directory.save('accounts',{'id':self.account,'version':original['version'],'fields':{'company':'Renamed client','billing_address':'Main office'}})
        self.assertFalse(self.directory.list()['contacts'])
        with self.assertRaises(ValidationError):self.billing.complete({**first,'new_contact_key':str(uuid4())})
        with self.assertRaises(CommercialConflict):self.billing.complete({**first,'source':{**first['source'],'revision':'0'*64}})
        self.assertFalse(self.directory.list()['contacts'])
        result=self.billing.complete(first)
        version=self.directory.list()['version']
        person=self.directory.list()['contacts'][0]
        self.assertEqual((result['created'],person['company'],person['account_id'],person['name'],person['email'],person['phone']),
                         (True,'Renamed client',self.account,self.values['name'],self.values['email'],self.values['phone']))
        self.assertEqual(self.directory.list()['accounts'][0]['billing_address'],'Main office')
        self.assertEqual(self.billing.complete(first),{'created':False,'contact_id':result['contact_id']})
        self.assertEqual(self.directory.list()['version'],version)
        changed=self.save(previous=doc)
        self.assertEqual(doc['fields']['billing'],changed['fields']['billing'],'An older client omitting billing retains its snapshot')
        with self.assertRaises(CommercialConflict):self.billing.complete(first)
        self.assertFalse(self.billing.complete(self.source(changed))['created'])
        with self.assertRaisesRegex(ValidationError,'request changed'):
            self.save({**self.values,'email':'other@example.test'},changed)
        cards=self.store.unfiled.cards(None)
        self.sources.commercial_register=lambda:{'documents':cards}
        self.sources.account_relation_projects=lambda:{'files':[]}
        group=ContactRelations(self.directory,self.sources).view(person['id'])['linked']['work_orders']
        self.assertEqual([(item['id'],item['roles']) for item in group],[(self.fixture.project+':'+doc['id'],['Billing contact'])])
        cleared=self.save({},changed)
        self.assertNotIn('billing',cleared['fields']);self.assertEqual(len(self.directory.list()['contacts']),1)

    def test_duplicate_requires_review_and_reselect_does_not_edit_contact(self):
        person=self.directory.save('contacts',{'version':self.directory.list()['version'],'fields':{
            'name':self.values['name'],'email':self.values['email'],'phone':self.values['phone'],'company':'Client Pty Ltd'}})['id']
        before=self.directory.list()
        with self.assertRaises(DuplicateReview) as found:self.save(self.values)
        self.assertEqual([item['id'] for item in found.exception.decision['matches'] if item['strong']],[person])
        with self.assertRaisesRegex(ValidationError,'name, email and phone'):self.save({**self.values,'email':''})
        picked={**self.values,'contact_id':person,'phone':'Claim-only phone'};del picked['new_contact_key']
        doc=self.save(picked)
        self.assertEqual(doc['fields']['billing']['contact_id'],person);self.assertEqual(self.directory.list(),before)
        wrong=self.directory.save('accounts',{'version':before['version'],'fields':{'company':'Other Company'}})['id']
        with self.assertRaisesRegex(ValidationError,'linked to this Company'):
            self.save({**picked,'account_id':wrong},doc,project_details={**self.details,'account_id':wrong})
        with self.assertRaisesRegex(ValidationError,'Link this project'):self.save(self.values,project_details={**self.details,'account_id':''})
        self.assertEqual(len(self.directory.list()['contacts']),1)

    def test_claim_pdf_order_wrapping_escaping_and_issued_revision(self):
        fields={**self.values,'address':'Level 2, Accounts <East> & West\n'+'Billing office, Science and Engineering Campus, '*7,
                'name':'Accounting and Administration Services, Eastern Region <EA>','email':'long.accounts.receivable.and.payable.department@example.test'}
        self.store.renderer=render_commercial_pdf
        doc=self.save(fields)
        issued=self.store.issue(self.fixture.workspace,doc['id'],doc['version'],str(uuid4()),company=DEFAULTS)
        text=' '.join(' '.join(page.extract_text().split()) for page in PdfReader(BytesIO(issued['pdf'])).pages)
        claim=text.split('WORK ORDER CLAIM',1)[1]
        self.assertTrue(claim.index('Billing address')<claim.index('ABN/ACN')<claim.index('Accounts name')<claim.index('Accounts email')<
                        claim.index('Accounts phone')<claim.index('Product / Service'))
        self.assertIn('Accounts <East> & West',claim);self.assertIn('Eastern Region <EA>',claim)
        self.assertIn(self.values['phone'],claim)
        updated=self.save({**fields,'address':'New billing instructions'},issued['document'])
        self.assertEqual(self.store.read_pdf(self.fixture.workspace,issued['id'])[1],issued['pdf'])
        latest=render_commercial_pdf(updated,'WO-01',company=DEFAULTS)
        self.assertIn('New billing instructions',' '.join(page.extract_text() for page in PdfReader(BytesIO(latest)).pages))
        legacy=deepcopy(updated);del legacy['fields']['billing']
        self.assertNotIn('billing',validate_fields(legacy['fields'],kind='work_order'))
        self.assertNotIn('Accounts email',' '.join(page.extract_text() for page in PdfReader(BytesIO(render_commercial_pdf(legacy,'WO-01',company=DEFAULTS))).pages))
