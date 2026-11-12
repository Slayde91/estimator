"""Merges change how stable IDs are read and preserve the original records."""

import hashlib
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.account_relations import AccountRelations
from estimator.contacts import ContactsStore, LINK_KINDS
from estimator.contact_relations import ContactRelations
from estimator import crm_identity


class Sources:
    def __init__(self):
        self.files = []
        self.documents = []

    def account_relation_projects(self):
        return {'files':self.files}

    def commercial_register(self):
        return {'documents':self.documents}


class IdentityTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)
        self.store = ContactsStore(self.folder/'directory.sqlite3')
        self.service = crm_identity.IdentityService(self.store)
        self.sources = Sources()

    def version(self):
        return self.store.list()['version']

    def save(self, kind, fields, **extra):
        return self.store.save(kind, {'version':self.version(), 'fields':fields, **extra})['id']

    def merge(self, kind, source, survivor):
        args = {'kind':kind,'source_id':source,'survivor_id':survivor}
        preview = self.service.preview(args)
        body = {**args,'version':preview['version'],'preview_token':preview['preview_token'],'reason':'Verified by phone',
                'request_id':str(uuid4())}
        merged = self.service.apply('merge',body)
        self.assertEqual(merged,self.service.apply('merge',body))
        return merged['operation_id']

    def undo(self, kind, operation):
        body = {'kind':kind,'operation_id':operation,'request_id':str(uuid4()),'version':self.version()}
        self.assertEqual(self.service.apply('undo',body),self.service.apply('undo',body))

    def originals(self):
        with self.store.connection() as db:
            return {table:list(map(tuple,db.execute(f'SELECT * FROM {table} ORDER BY rowid')))
                    for table in ('contacts','accounts','leads','converted_leads','lead_conversion_details','account_links')}

    def person(self, name, company):
        return self.save('contacts', {'name':name,'company':company,'email':'office@example.test','phone':'123'})

    def test_short_company_names_and_whole_word_extensions_suggest_each_other(self):
        names = ('Ceasefire','Ceasefire PFP','Ambient','Ambient Services Group','Ambiental','Services','Services Group')
        ids = {name:self.save('accounts',{'company':name}) for name in names}
        with self.store.connection() as db:
            for name, expected in [('Ceasefire',['Ceasefire PFP']), ('Ceasefire PFP',['Ceasefire']),
                                   ('Ambient',['Ambient Services Group']), ('Ambient Services Group',['Ambient']),
                                   ('Ambiental',[]), ('Services',[])]:
                rows = crm_identity.suggestions(db,'accounts',{'company':name},ids[name])['matches']
                self.assertEqual([item['id'] for item in rows],[ids[item] for item in expected],name)
                self.assertFalse(any(item['strong'] for item in rows))

    def test_company_merge_and_saved_form_do_not_reparent_people_or_copy_manual_links(self):
        old = self.save('accounts',{'company':'Previous firm','abn_acn':'Example 123456'})
        new = self.save('accounts',{'company':'Current firm','abn_acn':'Example 123456'})
        self.person('First contact','Previous firm')
        self.person('Second contact','Current firm')
        with self.store.connection() as db:
            db.execute('INSERT INTO account_links VALUES (?,?,?,?)',(old,'projects',str(uuid4()),'Archived project'))
        before = self.originals()
        operation = self.merge('accounts',old,new)
        self.assertEqual(len(self.store.list()['accounts']),1)
        relations = AccountRelations(self.store,self.sources).view(new)
        self.assertEqual(sum(bool(row.get('inherited')) for row in relations['linked']['contacts']),1)
        self.assertTrue(relations['linked']['projects'][0]['inherited'])
        body = {'version':self.version(),'id':new,'fields':{'company':'Current firm'},
                'links':{key:[row['id'] for row in relations['linked'][key]] for key in LINK_KINDS}}
        with self.assertRaises(crm_identity.IdentityConflict):
            self.store.save('accounts',body,link_catalog=relations)
        self.store.save('accounts',{**body,'identity_version':1},link_catalog=relations)
        self.assertEqual(self.originals(),before)
        self.undo('accounts',operation)
        self.assertEqual(self.originals(),before)
        self.assertEqual(len(self.store.list()['accounts']),2)

    def test_contact_merge_exact_source_roles_reversible_and_original_enquiry_converts(self):
        old, new = self.person('Previous name','Agency'), self.person('Current name','Agency')
        fields = {'name':'Enquiry name','phone':'0412','email':'old@example.test','company':'Customer','site_address':'Work site'}
        lead = self.save('leads',fields,contact_id=old)
        before = self.originals()
        owner, doc = str(uuid4()), str(uuid4())
        file_hashes = {}
        for name, contact in [('copy-a', old),('copy-b','')]:
            path = self.folder/(name+'.cf.json')
            path.write_text('{"project_id":"'+owner+'","contact_id":"'+contact+'"}')
            file_hashes[path] = hashlib.sha256(path.read_bytes()).digest()
            self.sources.files.append({'id':name,'source_project_id':owner,'account_link_id':str(uuid4()),'contact_id':contact,'path':str(path)})
            self.sources.documents.append({'id':doc,'project_id':owner,'kind':'purchase_order','source_file':name,'reference':name,
                                          'fields':{'order':{'site_contact_id':contact}}})
        pdf = self.folder/'issued.pdf'
        from reportlab.pdfgen.canvas import Canvas
        canvas = Canvas(str(pdf)); canvas.drawString(20,20,'Issued for Enquiry name');canvas.save()
        file_hashes[pdf] = hashlib.sha256(pdf.read_bytes()).digest()
        operation = self.merge('contacts',old,new)
        self.assertEqual(self.originals(),before)
        self.assertEqual(self.store.list()['leads'][0]['contact_id'],old)
        view = ContactRelations(self.store,self.sources).view(new)['linked']
        self.assertEqual(len(view['projects']),1)
        self.assertEqual(view['purchase_orders'][0]['roles'],['Site contact'])
        self.assertIn('copy-a',view['purchase_orders'][0]['label'])
        self.assertEqual(view['leads'][0]['id'],lead)
        self.undo('contacts',operation)
        self.assertEqual(self.originals(),before)
        self.assertFalse(ContactRelations(self.store,self.sources).view(new)['linked']['leads'])
        self.merge('contacts',old,new)
        converted = []
        def create(snapshot):
            converted.append(snapshot)
            return {'project_no':'PN-01','path':str(self.folder/'new-project.cf.json')}
        self.store.convert({'id':lead,'version':self.version()},create)
        self.assertEqual((converted[0]['contact_id'],converted[0]['company'],converted[0]['name']),(old,'Customer','Enquiry name'))
        self.assertEqual(ContactRelations(self.store,self.sources).view(new)['converted_leads'][0]['lead_id'],lead)
        self.assertEqual(file_hashes,{p:hashlib.sha256(p.read_bytes()).digest() for p in file_hashes})

    def test_duplicate_review_on_edit_is_bound_to_fields_version_and_meaningful_identifiers(self):
        first = self.save('accounts',{'company':'North Pty Ltd','abn_acn':'ABN 12 345 678 901'})
        second = self.save('accounts',{'company':'North Services','abn_acn':'123456'})
        fields = {'company':'North Services','abn_acn':'12345678901'}
        body = {'id':second,'fields':fields,'version':self.version()}
        with self.assertRaises(crm_identity.DuplicateReview) as caught:
            self.store.save('accounts',body)
        review = caught.exception.decision
        self.assertTrue(review['matches'][0]['strong'])
        self.assertEqual(review['matches'][0]['id'],first)
        with self.assertRaises(crm_identity.DuplicateReview):
            self.store.save('accounts',{**body,'fields':{**fields,'company':'Renamed'},'review_token':review['review_token']})
        self.store.save('accounts',{**body,'review_token':review['review_token']})
        with self.store.connection() as db:
            weak = crm_identity.suggestions(db,'accounts',{'company':'North Limited','abn_acn':'ABN 123456'})
        self.assertFalse(weak['matches'][0]['strong'])
        self.assertEqual(weak['matches'][0]['reasons'],['Similar company name'])

    def test_stale_preview_alias_subject_or_merge_chain_requires_new_review(self):
        ids = [self.person(name,'Agency') for name in ['First','Second','Third']]
        args = {'kind':'contacts','source_id':ids[0],'survivor_id':ids[1]}
        preview = self.service.preview(args)
        self.save('accounts',{'company':'Unrelated'})
        with self.assertRaises(crm_identity.IdentityConflict):
            self.service.apply('merge',{**args,**preview,'request_id':str(uuid4()),'reason':'Reviewed'})
        self.merge('contacts',ids[0],ids[1])
        for source,survivor in [(ids[0],ids[2]),(ids[1],ids[2]),(ids[2],ids[0]),(ids[1],ids[1])]:
            with self.assertRaises(crm_identity.IdentityConflict):
                self.service.preview({'kind':'contacts','source_id':source,'survivor_id':survivor})

    def test_pre_snapshot_lead_and_edited_contact_retain_original_account_foreign_key(self):
        original = self.save('accounts',{'company':'Old employer'})
        active = self.save('accounts',{'company':'Current employer'})
        person = self.person('Taylor','Old employer')
        fields = {'name':'Taylor','company':'Old employer','email':'office@example.test','phone':'123','site_address':'Site'}
        lead = self.save('leads',fields,contact_id=person)
        with self.store.connection() as db:
            db.execute('UPDATE leads SET person_snapshot=NULL WHERE id=?',(lead,))
        self.merge('accounts',original,active)
        self.save('leads',{**fields,'status':'Qualified'},id=lead,contact_id=person,account_id=original)
        edited = self.store.save('contacts',{'version':self.version(),'id':person,'fields':{
            'name':'Taylor','title':'Manager','phone':'456','email':'office@example.test','company':'Current employer'}})
        self.assertEqual(edited['contact']['account_id'],active)
        with self.store.connection() as db:
            self.assertEqual(db.execute('SELECT account_id FROM contacts WHERE id=?',(person,)).fetchone()[0],original)
        self.assertEqual(self.store.list()['leads'][0]['company'],'Old employer')
