"""Editable documents follow Project identity; historical overrides remain readable."""
from copy import deepcopy
import json
from uuid import uuid4
import unittest

from estimator.catalog import ValidationError
from estimator.commercial_documents import (default_fields, validate_fields, apply_project_document_details,
                                             commercial_cards, CommercialDocuments)
from estimator.commercial_http import CommercialHTTP
from tests import test_commercial_panes_signatures as helpers


class DocumentOverrideTests(unittest.TestCase):
    setUp=helpers.CommercialPaneSignerTests.setUp
    save=helpers.CommercialPaneSignerTests.save
    # Reuse fixture setup only; avoid inheriting/rerunning unrelated tests.
    def test_override_keys_are_bounded_deterministic_optional_and_cannot_include_number(self):
        original=default_fields('quote')
        self.assertNotIn('detail_overrides', validate_fields(original,kind='quote'))
        for malformed in (None,{},'client',['project_no'],['date'],['client','client'],[[]],['client']*6):
            value=deepcopy(original);value['detail_overrides']=malformed
            with self.subTest(value=malformed), self.assertRaisesRegex(ValidationError,'valid document detail overrides'):
                validate_fields(value,kind='quote')
        value=deepcopy(original);value['detail_overrides']=['site_address','client']
        before=deepcopy(value)
        self.assertEqual(validate_fields(value,kind='quote')['detail_overrides'],['client','site_address'])
        self.assertEqual(value,before)

    def test_http_project_metadata_supersedes_legacy_document_overrides(self):
        http=CommercialHTTP(self.store,derive=lambda *_args,**_kwargs:{'lines':[],'sources':[],'scope_tables':[]})
        project={'project_no':'PN-01','client':'Project Company','site_address':'Project site','contact_name':'Project Contact',
                 'contact_phone':'111','contact_email':'project@example.test'}
        original=deepcopy(project)
        quote=None
        for kind in ('quote','purchase_order','work_order'):
            with self.subTest(kind=kind):
                fields=default_fields(kind)
                fields['detail_overrides']=['client','contact','email','site_address']
                fields['details'].update(project_no='PN-01',client='Document Company',contact='Document Contact',email='document@example.test',site_address='Document site')
                if kind=='work_order':
                    fields['order']['quote_id']=quote['id']
                body={'workspace_id':self.workspace,'kind':kind,'status':'Draft','fields':fields,'project_details':project}
                if kind=='quote':body.update(active_estimate_id='estimate-1',estimates=[{'id':'estimate-1','name':'Estimate1','workspace':{'estimate':project}}])
                saved=http.execute('save',body)
                self.assertEqual(saved['fields']['details']['client'],'Project Company')
                self.assertEqual(saved['fields']['details']['contact'],'Project Contact')
                self.assertEqual(saved['fields']['details']['site_address'],'Project site')
                self.assertEqual(saved['fields']['details']['email'],'project@example.test')
                self.assertEqual(saved['fields']['details']['phone'],'111')
                changed_project={**project,'contact_phone':'222'}
                again=http.execute('save',{**body,'id':saved['id'],'version':saved['version'],'fields':saved['fields'],'project_details':changed_project,
                    **({'estimates':[{'id':'estimate-1','name':'Estimate1','workspace':{'estimate':changed_project}}]} if kind=='quote' else {})})
                self.assertEqual(again['fields']['details']['phone'],'222')
                self.assertEqual(again['fields']['details']['site_address'],'Project site')
                if kind=='quote':quote=self.store.issue(self.workspace,again['id'],again['version'],str(uuid4()))['document']
        snapshot=self.store.capture(self.workspace)
        cards=commercial_cards(snapshot)
        self.assertTrue(all('detail_overrides' not in card['fields'] for card in cards))
        cold_projects=type(self.projects)(self.root/'cold')
        cold_workspace=cold_projects.add(self.project)
        cold=CommercialDocuments(cold_projects)
        cold.restore(cold_workspace,snapshot)
        for doc in cold.view(cold_workspace)['documents']:
            self.assertEqual(doc['fields']['details']['client'],'Project Company')
            self.assertEqual(doc['fields']['details']['site_address'],'Project site')
        self.assertEqual(project,original,'Saving document edits must not modify captured Project metadata.')

    def test_invalid_override_or_delivery_option_never_writes_and_legacy_option_can_remain(self):
        fields=default_fields('purchase_order');fields['order']['delivery_method']='Delivery'
        doc=self.save('purchase_order',fields)
        fields=deepcopy(doc['fields']);fields['order']['delivery_method']='Pickup'
        doc=self.save('purchase_order',fields,doc)
        before=self.store.capture(self.workspace)
        for value in ('Drone', 'delivery'):
            fields=deepcopy(doc['fields']);fields['order']['delivery_method']=value
            with self.assertRaisesRegex(ValidationError,'Choose Delivery or Pickup'):
                self.save('purchase_order',fields,doc)
            self.assertEqual(self.store.capture(self.workspace),before)
        fields=deepcopy(doc['fields']);fields['detail_overrides']=['project_no']
        with self.assertRaises(ValidationError):self.save('purchase_order',fields,doc)
        self.assertEqual(self.store.capture(self.workspace),before)
        legacy=deepcopy(before);legacy['documents'][0]['fields']['order']['delivery_method']='Historical courier notes'
        fresh=self.projects.add(self.project);self.store.restore(fresh,legacy)
        row=self.store.view(fresh)['documents'][0]
        saved=self.store.save(fresh,{key:row[key] for key in ('id','version','kind','status','fields')})
        self.assertEqual(saved['fields']['order']['delivery_method'],'Historical courier notes')
        saved['fields']['order']['delivery_method']='New unlisted instruction'
        with self.assertRaisesRegex(ValidationError,'Choose Delivery or Pickup'):
            self.store.save(fresh,{key:saved[key] for key in ('id','version','kind','status','fields')})


class SavedDocumentOverrideTests(unittest.TestCase):
    setUp=helpers.SavedQuotePaneTests.setUp
    register=helpers.SavedQuotePaneTests.register
    perform=helpers.SavedQuotePaneTests.perform
    def test_saved_file_open_save_and_registry_use_project_metadata_over_legacy_overrides(self):
        opened=self.perform('open',id=self.document['id'])
        fields=opened['document']['fields']
        fields['detail_overrides']=['client','site_address','contact','phone','email']
        fields['details'].update(client='Different Company',site_address='Different site',contact='Document Person',phone='333',email='doc@example.test')
        project=json.loads(self.path.read_bytes())['estimate']
        result=self.perform('save',kind='quote',status='Draft',id=self.document['id'],version=self.document['version'],fields=fields)
        self.source['revision']=result['revision']
        reopened=self.perform('open',id=self.document['id'])
        self.assertEqual(reopened['document']['fields']['details']['client'],project['client'])
        self.assertEqual(reopened['document']['fields']['details']['site_address'],project['site_address'])
        self.assertEqual(json.loads(self.path.read_bytes())['estimate'],project)
        self.library.commercial_register(refresh=True)
        card=next(card for card in self.register()['documents'] if card['id']==self.document['id'])
        self.assertEqual(card['fields']['details']['client'],project['client'])
        self.assertEqual(card['fields']['details']['site_address'],project['site_address'])

    def test_saved_sidebar_updates_project_and_all_estimates_in_one_conditional_write(self):
        from estimator.contacts import ContactsStore
        from estimator.saved_commercial import SavedCommercial
        directory=ContactsStore(self.root/'directory.sqlite3')
        account=directory.save('accounts',{'version':0,'fields':{'company':'Changed Company','billing_address':'Billing HQ','abn_acn':'ABN-1'}})['account']
        contact=directory.save('contacts',{'version':directory.list()['version'],'fields':{'name':'Changed Person','company':account['company'],'phone':'222','email':'changed@example.test'}})['contact']
        self.saved=SavedCommercial(self.library,directory=directory.list)
        before=json.loads(self.path.read_bytes())
        from estimator.project_file import WORKSPACE_FIELDS
        first={'id':'estimate-1','name':'Original','workspace':{key:deepcopy(value) for key,value in before.items() if key in WORKSPACE_FIELDS}}
        second=deepcopy(first);second.update(id='estimate-'+uuid4().hex,name='Other estimate');second['workspace']['estimate']['project_no']='PN-HISTORICAL'
        before['estimates']=[first,second];before['active_estimate_id']='estimate-1'
        self.path.write_text(json.dumps(before),encoding='utf-8');self.library.commercial_register(refresh=True)
        card=next(card for card in self.register()['documents'] if card['id']==self.document['id'])
        self.source={'file_id':card['source_file'],'revision':card['source_revision']}
        opened=self.perform('open',id=self.document['id'])
        updates={'client':account['company'],'account_id':account['id'],'contact_name':contact['name'],'contact_id':contact['id'],
                 'contact_phone':contact['phone'],'contact_email':contact['email'],'site_address':'Changed site',
                 'billing_address':account['billing_address'],'abn_acn':account['abn_acn']}
        previous_source=deepcopy(self.source)
        result=self.perform('save',kind='quote',status='Draft',id=self.document['id'],version=self.document['version'],fields=opened['document']['fields'],project_updates=updates)
        written=json.loads(self.path.read_bytes())
        for estimate in [written['estimate'],*[row['workspace']['estimate'] for row in written.get('estimates',[])]]:
            for key,value in updates.items():self.assertEqual(estimate[key],value)
        self.assertEqual(written['estimate']['project_no'],before['estimate']['project_no'])
        self.assertEqual(written['estimates'][1]['workspace']['estimate']['project_no'],'PN-HISTORICAL')
        self.assertEqual(result['result']['fields']['details']['contact'],'Changed Person')
        self.assertEqual(result['result']['fields']['details']['site_address'],'Changed site')
        self.source['revision']=result['revision']
        reopened=self.perform('open',id=self.document['id'])
        self.assertEqual(reopened['project_details']['account_id'],account['id'])
        self.library.commercial_register(refresh=True)
        card=next(card for card in self.register()['documents'] if card['id']==self.document['id'])
        self.assertEqual(card['fields']['details']['client'],account['company'])
        self.assertEqual(card['fields']['details']['site_address'],'Changed site')
        self.assertEqual(card['fields']['details']['contact'],'Changed Person')
        self.assertEqual(card['fields']['details']['phone'],'222')
        self.source=previous_source
        current=self.path.read_bytes()
        with self.assertRaisesRegex(Exception,'saved project changed'):
            self.perform('save',kind='quote',status='Draft',id=self.document['id'],version=result['result']['version'],fields=result['result']['fields'],project_updates={'site_address':'Stale change'})
        self.assertEqual(self.path.read_bytes(),current)

    def test_invalid_project_updates_never_write_or_reassign_number(self):
        opened=self.perform('open',id=self.document['id'])
        before=self.path.read_bytes()
        for updates in ({'project_no':'FORGED'},{'client':'Unlinked New Company'},{'unknown':'value'},{'contact_id':str(uuid4()),'contact_name':'Unknown'}):
            with self.subTest(updates=updates),self.assertRaises(ValidationError):
                self.perform('save',kind='quote',status='Draft',id=self.document['id'],version=self.document['version'],fields=opened['document']['fields'],project_updates=updates)
            self.assertEqual(self.path.read_bytes(),before)

if __name__=='__main__':unittest.main()
