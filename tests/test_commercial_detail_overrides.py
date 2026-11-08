"""Document searches keep explicit overrides separate from canonical Project identity."""
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

    def test_http_overrides_portably_keep_each_document_edit_and_sync_untouched_fields(self):
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
                self.assertEqual(saved['fields']['details']['client'],'Document Company')
                self.assertEqual(saved['fields']['details']['contact'],'Document Contact')
                self.assertEqual(saved['fields']['details']['site_address'],'Document site')
                self.assertEqual(saved['fields']['details']['email'],'document@example.test')
                self.assertEqual(saved['fields']['details']['phone'],'111')
                changed_project={**project,'contact_phone':'222'}
                again=http.execute('save',{**body,'id':saved['id'],'version':saved['version'],'fields':saved['fields'],'project_details':changed_project,
                    **({'estimates':[{'id':'estimate-1','name':'Estimate1','workspace':{'estimate':changed_project}}]} if kind=='quote' else {})})
                self.assertEqual(again['fields']['details']['phone'],'222')
                self.assertEqual(again['fields']['details']['site_address'],'Document site')
                if kind=='quote':quote=self.store.issue(self.workspace,again['id'],again['version'],str(uuid4()))['document']
        snapshot=self.store.capture(self.workspace)
        cards=commercial_cards(snapshot)
        self.assertTrue(all(card['fields']['detail_overrides']==['client','contact','email','site_address'] for card in cards))
        cold_projects=type(self.projects)(self.root/'cold')
        cold_workspace=cold_projects.add(self.project)
        cold=CommercialDocuments(cold_projects)
        cold.restore(cold_workspace,snapshot)
        for doc in cold.view(cold_workspace)['documents']:
            self.assertEqual(doc['fields']['details']['client'],'Document Company')
            self.assertEqual(doc['fields']['details']['site_address'],'Document site')
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
    def test_saved_file_open_save_and_registry_keep_overrides_without_changing_project(self):
        opened=self.perform('open',id=self.document['id'])
        fields=opened['document']['fields']
        fields['detail_overrides']=['client','site_address','contact','phone','email']
        fields['details'].update(client='Different Company',site_address='Different site',contact='Document Person',phone='333',email='doc@example.test')
        project=json.loads(self.path.read_bytes())['estimate']
        result=self.perform('save',kind='quote',status='Draft',id=self.document['id'],version=self.document['version'],fields=fields)
        self.source['revision']=result['revision']
        reopened=self.perform('open',id=self.document['id'])
        self.assertEqual(reopened['document']['fields']['details']['client'],'Different Company')
        self.assertEqual(reopened['document']['fields']['details']['site_address'],'Different site')
        self.assertEqual(json.loads(self.path.read_bytes())['estimate'],project)
        self.library.commercial_register(refresh=True)
        card=next(card for card in self.register()['documents'] if card['id']==self.document['id'])
        self.assertEqual(card['fields']['details']['client'],'Different Company')
        self.assertEqual(card['fields']['details']['site_address'],'Different site')

if __name__=='__main__':unittest.main()
