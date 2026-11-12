"""HTTP boundaries for named access, including losing privileges and audit privacy."""
from http.client import HTTPConnection
from base64 import b64encode
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4
from PIL import Image

from test_pdf_download_covers import signed_options
from estimator.crm_access import CRMAccess
from estimator.certification import CertificationService, SIGNER_FIELDS, FIELDS
from estimator.company_settings import DEFAULTS
from estimator.storage import Store
from estimator.scheduler import SchedulerStore
from estimator.server import create_server


class AccessBoundaryTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root=Path(tmp.name)
        self.server=create_server(0,root/'isolated.sqlite3',library_directory=root/'libraries')
        self.signers=CertificationService(Store(root/'isolated.sqlite3'))
        thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        scheduler=SchedulerStore(root/'isolated-scheduler.sqlite3')
        self.access=CRMAccess(root/'isolated-access.sqlite3',scheduler)
        self.password='Synthetic-secret-for-boundary-test'
        admin=scheduler.write('setup',{'name':'Admin','email':'admin@example.test','password':self.password})
        editor=scheduler.write('members/save',{'name':'Sales','email':'sales@example.test','password':self.password,
                                               'role':'worker','active':True,'base_rate':'0'},admin['token'])
        self.access.assign({'member_id':editor['id'],'role':'editor','version':0},admin['token'])
        self.access.activate_named_access()
        self.admin_id=admin['user']['id'];self.editor_id=editor['id']
        self.admin=self.login('admin@example.test');self.editor=self.login('sales@example.test')

    def call(self,path,body=None,*,cookie='',member=None,method=None,extra_headers=None,raw=False):
        conn=HTTPConnection('127.0.0.1',self.server.server_port,timeout=20)
        headers={'Cookie':cookie,'Content-Type':'application/json',**(extra_headers or {})}
        if member is not None:
            headers['X-CRM-Member']=member
        try:
            conn.request(method or ('GET' if body is None else 'POST'),path,
                         json.dumps(body) if body is not None else None,headers)
            response=conn.getresponse()
            data=response.read()
            return response.status,dict(response.getheaders()),data if raw else json.loads(data)
        finally:
            conn.close()

    def login(self,email):
        status,headers,_=self.call('/api/access/login',{'email':email,'password':self.password})
        self.assertEqual(status,200)
        return headers['Set-Cookie'].split(';',1)[0]

    def test_frozen_pdf_export_progress_preserves_auth_and_viewer_read_only_policy(self):
        fields=dict.fromkeys(FIELDS,'N/A')
        created=self.signers.create(fields, options=signed_options())
        generated=self.signers.generate(created['id'],fields,1,str(uuid4()),DEFAULTS)
        route=generated['revision']['pdf_url']
        status,_,receipt=self.call('/api/download-progress',{},cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200);token=receipt['token'];headers={'X-Estimator-Download-Progress':token}
        self.access.assign({'member_id':self.editor_id,'role':'viewer','version':1},
                           self.access.scheduler.write('login',{'email':'admin@example.test','password':self.password})['token'])
        before=self.signers.get(created['id'])
        self.assertEqual(self.call(route,{'download':{}},extra_headers=headers)[0],401)
        self.assertEqual(self.call(route,{'download':{}},cookie=self.admin,member=self.editor_id,extra_headers=headers)[0],409)
        self.assertEqual(self.call(route,{'download':{}},cookie=self.editor,member=self.editor_id,extra_headers=headers)[0],403)
        status,response_headers,payload=self.call(route,cookie=self.editor,raw=True)
        self.assertEqual(status,200);self.assertTrue(response_headers['Content-Type'].startswith('application/pdf'))
        self.assertEqual(payload,self.signers.revision_pdf(created['id'],1))
        self.assertEqual(self.signers.get(created['id']),before)
        self.assertEqual(self.call('/api/download-progress/'+token,cookie=self.editor)[2],{'percent':0,'state':'waiting'},
                         'Auth denial must occur before claiming the single-use progress receipt.')

    def test_directory_sync_requires_editor_and_records_its_fixed_route(self):
        route='/api/contacts/sync-project-details'
        directory=self.call('/api/contacts/directory',cookie=self.editor)[2]
        status,_,account=self.call('/api/contacts/accounts',{'version':directory['version'],'fields':{'company':'Test Company'}},
                                   cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        project={'revision':'saved-revision','directory_details':{'account_id':account['id'],'billing_address':'Office A'}}
        body={'project':'test-project','revision':project['revision'],'fields':['billing_address']}
        with patch('estimator.project_library.ProjectLibrary.participant_project',return_value=project) as resolve:
            self.assertEqual(self.call(route,body,cookie=self.editor,member=self.admin_id)[0],409)
            self.assertEqual(self.call(route,body,cookie=self.editor,member=self.editor_id)[0],200)
            self.assertEqual(self.call('/api/access/roles',{'member_id':self.editor_id,'role':'viewer','version':1},
                                       cookie=self.admin,member=self.admin_id)[0],200)
            self.assertEqual(self.call(route,body,cookie=self.editor,member=self.editor_id)[0],403)
            resolve.assert_called_once_with(body['project'],directory_only=True)
        saved=self.call('/api/contacts/directory',cookie=self.editor)[2]['accounts']
        self.assertEqual(next(row for row in saved if row['id']==account['id'])['billing_address'],'Office A')
        ledger=self.call('/api/access/audit',cookie=self.admin)[2]['requests']
        self.assertTrue(any(row['route']==route and row['actor_name']=='Sales' and row['status']==200 for row in ledger))

    def test_editor_cannot_run_native_number_migration_and_switched_tab_cannot_administer_access(self):
        with patch('estimator.document_numbers.migrate_saved_orders') as migrate:
            status,_,_=self.call('/api/document-numbering/migrate-orders',{},cookie=self.editor,member=self.editor_id)
            self.assertEqual(status,403)
            migrate.assert_not_called()
        configuration=self.access.settings()
        role={'member_id':self.editor_id,'role':'viewer','version':1}
        for header in (None,self.editor_id):
            for route,body in [('roles',role),('settings',{'enabled':False,'version':configuration['version']})]:
                with self.subTest(header=header,route=route):
                    self.assertEqual(self.call('/api/access/'+route,body,cookie=self.admin,member=header)[0],409)
        self.assertEqual(self.access.settings(),configuration)
        self.assertEqual(self.call('/api/access/session',cookie=self.editor)[2]['user']['role'],'editor')
        self.assertEqual(self.call('/api/access/roles',role,cookie=self.admin,member=self.admin_id)[0],200)
        before=self.call('/api/contacts/directory',cookie=self.editor)[2]
        status,_,_=self.call('/api/contacts/leads',{'version':before['version'],'fields':{'name':'Blocked','company':'Blocked'}},
                             cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,403)
        self.assertEqual(before,self.call('/api/contacts/directory',cookie=self.editor)[2])
        # A viewer may read project details; the mutation path next to it must fail before lookup.
        self.assertEqual(self.call('/api/projects/details',{'id':'missing'},cookie=self.editor)[0],400)
        self.assertEqual(self.call('/api/projects/details/save',{},cookie=self.editor,member=self.editor_id)[0],403)
        self.assertEqual(self.call('/api/access/audit',cookie=self.editor)[0],403)

    def test_firestopping_definition_is_a_read_for_viewers_and_editors_without_saving_configuration(self):
        route='/api/penetration/definition'
        body={'configuration':{'inventory':{},'rates':{}}}
        self.assertEqual(self.call(route,body)[0],401)
        before=self.call('/api/bootstrap',cookie=self.editor)[2]['configuration']
        directory=self.call('/api/contacts/directory',cookie=self.editor)[2]
        status,_,definition=self.call(route,body,cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        self.assertTrue(definition['groups'])
        self.assertEqual(self.call('/api/configuration',{},cookie=self.editor,member=self.editor_id)[0],403)
        self.assertEqual(self.call('/api/contacts/contacts',{},cookie=self.editor,member=self.admin_id)[0],409)
        admin_token=self.access.scheduler.write('login',{'email':'admin@example.test','password':self.password})['token']
        scheduler_only=self.access.scheduler.write('members/save',{
            'name':'Scheduler only','email':'scheduler@example.test','password':self.password,
            'role':'worker','active':True,'base_rate':'0'},admin_token)
        scheduler_cookie=self.login('scheduler@example.test')
        self.assertEqual(self.call(route,body,cookie=scheduler_cookie,member=scheduler_only['id'])[0],403)
        self.access.assign({'member_id':self.editor_id,'role':'viewer','version':1},
                           admin_token)
        status,_,viewed=self.call(route,body,cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        self.assertEqual(viewed,definition)
        self.assertEqual(self.call(route,{**body,'save':True},cookie=self.editor,member=self.editor_id)[0],400)
        for mutation in ('/api/configuration','/api/company-settings','/api/project/save','/api/contacts/contacts','/api/new-future-write'):
            with self.subTest(route=mutation):
                self.assertEqual(self.call(mutation,{},cookie=self.editor,member=self.editor_id)[0],403)
                self.assertEqual(self.call(mutation,{},cookie=self.editor,member=self.admin_id)[0],409)
        self.assertEqual(self.call('/api/bootstrap',cookie=self.editor)[2]['configuration'],before)
        self.assertEqual(self.call('/api/contacts/directory',cookie=self.editor)[2],directory)

    def test_viewer_prepares_nonempty_project_library_records_without_shared_authority(self):
        from copy import deepcopy
        from test_firestopping_library import editable_library
        from estimator.firestopping_library import FirestoppingLibrary
        from estimator.project_library_drafts import prepare_library_drafts
        root=self.signers.store.path.parent/'libraries'
        editable_library(root)
        library=FirestoppingLibrary(root,self.signers.store)
        edit=library.edit('pkb-001')
        submitted={key:deepcopy(edit[key]) for key in ('draft','revision','pricing_token')}
        submitted['draft']['rows'][0]['inputs']['AI']=75
        packed=library.project_draft('pkb-001',submitted)
        snapshot={'version':1,'source_sha256':packed['source_sha256'],'records':[packed['record']]}
        expected=prepare_library_drafts(snapshot)
        self.assertEqual(expected['records'][0]['price']['amount'],175)
        self.assertEqual(b64encode((root/'images/diagram-a.png').read_bytes()).decode(),snapshot['records'][0]['diagram']['content_base64'])
        before_files={str(path.relative_to(root)):path.read_bytes() for path in root.rglob('*') if path.is_file()}
        with self.signers.store.connect() as db:before_database=tuple(db.iterdump())
        body={'library_drafts':snapshot};route='/api/project/library-drafts/prepare'
        self.assertEqual(self.call(route,{},cookie='')[0],401)
        status,_,prepared=self.call(route,body,cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        self.assertEqual(prepared['library_drafts'],snapshot)
        admin_token=self.access.scheduler.write('login',{'email':'admin@example.test','password':self.password})['token']
        worker=self.access.scheduler.write('members/save',{'name':'Scheduler','email':'schedule@example.test',
            'password':self.password,'role':'worker','active':True,'base_rate':'0'},admin_token)
        self.assertEqual(self.call(route,{},cookie=self.login('schedule@example.test'),member=worker['id'])[0],403)
        self.access.assign({'member_id':self.editor_id,'role':'viewer','version':1},admin_token)
        status,_,viewed=self.call(route,body,cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        self.assertEqual(viewed['library_drafts'],snapshot)
        self.assertEqual(viewed['records'][0]['price']['amount'],175)
        self.assertEqual(viewed['records'][0]['diagram']['url'],'data:image/png;base64,'+snapshot['records'][0]['diagram']['content_base64'])
        self.assertEqual(self.call(route,{**body,'save':True},cookie=self.editor,member=self.editor_id)[0],400)
        for mutation in ('/api/configuration','/api/project/save','/api/libraries/penetration/pkb-001/save',
                         '/api/libraries/penetration/pkb-001/delete','/api/new-future-write'):
            with self.subTest(route=mutation):
                self.assertEqual(self.call(mutation,{},cookie=self.editor,member=self.editor_id)[0],403)
                self.assertEqual(self.call(mutation,{},cookie=self.editor,member=self.admin_id)[0],409)
        with self.signers.store.connect() as db:self.assertEqual(tuple(db.iterdump()),before_database)
        self.assertEqual({str(path.relative_to(root)):path.read_bytes() for path in root.rglob('*') if path.is_file()},before_files)

    def test_audit_does_not_persist_payload_query_arbitrary_path_or_bearer_identifiers(self):
        marker='ConfidentialCustomerAB765'
        workspace=str(uuid4())
        version=self.call('/api/contacts/directory',cookie=self.editor)[2]['version']
        status,_,saved=self.call('/api/contacts/leads?hint='+marker,{'fields':{'name':'Person','company':marker},'version':version},
                                 cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        for route,body in [
            ('/api/contacts/leads',{'id':marker,'version':saved['version'],'fields':{'name':marker,'company':'X'}}),
            ('/api/quotes/'+marker,{'id':marker}),
            ('/api/certifications/workspaces/'+workspace+'/discard',{}),
        ]:
            self.assertGreaterEqual(self.call(route,body,cookie=self.editor,member=self.editor_id)[0],400)
        status,_,ledger=self.call('/api/access/audit',cookie=self.admin)
        self.assertEqual(status,200)
        contents=json.dumps(ledger)
        for secret in (marker,self.password,self.admin,self.editor,workspace):
            self.assertNotIn(secret,contents)
        self.assertTrue(any(row['target_id']==saved['id'] and row['status']==200 and row['actor_name']=='Sales'
                            for row in ledger['requests']))
        self.assertTrue(all(row['target_id'] is None for row in ledger['requests'] if row['status']>=400))
        # Inspect both attempts and responses rather than trusting a sanitized UI projection.
        with self.access.connect() as db:
            persisted=json.dumps([tuple(r) for r in db.execute('SELECT * FROM crm_request_events')])
        for secret in (marker,workspace,self.password,self.editor.split('=',1)[1]):
            self.assertNotIn(secret,persisted)

    def test_named_profiles_begin_empty_and_only_authenticate_their_own_signer_artwork(self):
        route='/api/certifications/defaults'
        empty={'fields':dict.fromkeys(SIGNER_FIELDS,''),'version':1,'signature_image':None,'signature_name':''}
        def body(name,colour):
            stream=BytesIO()
            Image.new('RGB',(8,3),colour).save(stream,format='PNG')
            image='data:image/png;base64,'+b64encode(stream.getvalue()).decode('ascii')
            return {'fields':{**empty['fields'],'name':name},'signature_image':image,'signature_name':name+'.png',
                    'expected_version':1}
        legacy=self.signers.save_defaults(**body('Historical signer','red'))
        with self.signers.store.connect() as db:
            original=tuple(db.execute('SELECT * FROM certification_signer_defaults').fetchone())
        self.assertEqual(self.call(route+'/legacy',cookie=self.admin)[2],legacy)
        self.assertEqual(self.call(route+'/legacy',cookie=self.editor)[0],403)
        self.assertEqual(self.call(route+'/legacy')[0],401)
        for cookie,stale in ((self.admin,self.editor_id),(self.admin,'anonymous'),(self.editor,self.admin_id)):
            self.assertEqual(self.call(route,cookie=cookie,member=stale)[0],409)
        for cookie in (self.admin,self.editor):
            self.assertEqual(self.call(route,cookie=cookie)[2],empty)
        with self.signers.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM staff_signer_defaults').fetchone()[0],0)
        first=body('First staff','blue')
        second=body('Second staff','green')
        for cookie,member,profile in ((self.admin,self.admin_id,first),(self.editor,self.editor_id,second)):
            for attempt in range(2):
                status,_,saved=self.call(route,profile,cookie=cookie,member=member)
                self.assertEqual(status,200)
                self.assertEqual(saved,{**{k:v for k,v in profile.items() if k!='expected_version'},'version':2})
        for cookie,member in ((self.admin,self.editor_id),(self.editor,self.admin_id)):
            self.assertEqual(self.call(route,second,cookie=cookie,member=member)[0],409)
        self.assertEqual(self.call(route,{**first,'owner_id':self.admin_id},cookie=self.editor,member=self.editor_id)[0],400)
        renamed={'fields':{**second['fields'],'name':'Edited'},'expected_version':1}
        self.assertEqual(self.call(route,renamed,cookie=self.editor,member=self.editor_id)[0],409)
        status,_,saved=self.call(route,{**renamed,'expected_version':2},cookie=self.editor,member=self.editor_id)
        self.assertEqual(status,200)
        self.assertEqual((saved['version'],saved['signature_image'],saved['signature_name']),
                         (3,second['signature_image'],second['signature_name']))
        self.assertEqual(self.call(route,cookie=self.admin)[2]['signature_image'],first['signature_image'])
        with self.signers.store.connect() as db:
            self.assertEqual(tuple(db.execute('SELECT * FROM certification_signer_defaults').fetchone()),original)
        configuration=self.access.settings()
        self.assertEqual(self.call('/api/access/settings',{'enabled':False,'version':configuration['version']},
                                   cookie=self.admin,member=self.admin_id)[0],200)
        self.assertEqual(self.call(route+'/legacy')[0],401)
        self.assertEqual(self.call(route,member='anonymous')[2],legacy)
        self.assertEqual(self.call(route,member=self.admin_id)[0],409)
        self.assertEqual(self.call(route,first,member=self.admin_id)[0],409)
        self.assertEqual(self.call(route,second,cookie=self.admin,member='anonymous')[0],409)
        self.assertEqual(self.call(route,first,cookie=self.admin)[0],409)
        self.assertEqual(self.signers.get_defaults(),legacy)
