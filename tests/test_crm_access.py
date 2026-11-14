"""Verify named local permissions with real Scheduler identities and HTTP requests."""
from http.client import HTTPConnection
from pathlib import Path
from types import SimpleNamespace
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
import sqlite3

from estimator.crm_access import CRMAccess, AccessError
from estimator.scheduler import SchedulerStore

class AccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name)
        self.scheduler=SchedulerStore(root/'scheduler.sqlite3')
        self.admin=self.scheduler.write('setup',{'name':'Administrator','email':'admin@example.test','password':'Correct-admin-password'})
        self.worker=self.scheduler.write('members/save',{'name':'Estimator','email':'worker@example.test','password':'Correct-worker-password',
            'role':'worker','active':True,'base_rate':'42'},self.admin['token'])
        self.login=self.scheduler.write('login',{'email':'worker@example.test','password':'Correct-worker-password'})
        self.access=CRMAccess(root/'access.sqlite3',self.scheduler)

    def enable(self):
        self.access.configure({'enabled':True,'version':1},self.admin['token'])

    def handler(self,token=None,method='GET',member=None):
        headers={'Cookie':'classifire_access='+token} if token else {}
        if member:headers['X-CRM-Member']=member
        return SimpleNamespace(command=method,headers=headers)

    def assert_denied(self,code,handler,route):
        with self.assertRaises(AccessError) as caught:self.access.authorize(handler,route)
        self.assertEqual(caught.exception.status,code)

    def test_signin_is_mandatory_for_new_and_previously_disabled_installations(self):
        with self.scheduler.connect() as db:before=[tuple(r) for r in db.execute('SELECT * FROM scheduler_members ORDER BY id')]
        self.assert_denied(401,self.handler(),'/api/contacts/directory')
        with self.assertRaises(AccessError):self.access.configure({'enabled':True,'version':1},None)
        with self.assertRaises(AccessError):self.access.configure({'enabled':True,'version':1},self.login['token'])
        self.enable()
        with self.access.connect() as db:db.execute('UPDATE crm_access_settings SET enabled=0')
        self.assert_denied(401,self.handler(),'/api/contacts/directory')
        self.assertTrue(self.access.session(None)['enabled'])
        self.access=CRMAccess(self.access.path,self.scheduler)
        with self.scheduler.connect() as db:self.assertEqual(before,[tuple(r) for r in db.execute('SELECT * FROM scheduler_members ORDER BY id')])
        self.assertEqual(self.access.settings(),{'enabled':1,'version':2})
        with self.assertRaises(AccessError):self.access.configure({'enabled':False,'version':2},self.admin['token'])

    def test_roles_default_to_scheduler_only_and_minimal_roster_never_exposes_pay_or_credentials(self):
        self.enable()
        self.assert_denied(403,self.handler(self.login['token']),'/api/bootstrap')
        self.access.authorize(self.handler(self.login['token']),'/api/scheduler/state')
        self.assertEqual(self.access.staff(),[{'id':self.admin['user']['id'],'name':'Administrator'},{'id':self.worker['id'],'name':'Estimator'}])
        self.assertEqual(self.access.user(self.admin['token'])['role'],'admin')
        for row in self.access.members(self.admin['token'])['members']:
            self.assertFalse({'password','password_hash','salt','base_rate','token'} & row.keys())

    def test_viewer_cannot_mutate_unknown_routes_or_get_based_creation(self):
        self.enable();self.access.assign({'member_id':self.worker['id'],'role':'viewer','version':0},self.admin['token'])
        person=self.worker['id']
        for route in ['/api/bootstrap','/api/contacts/directory','/api/commercial/pdf/revision','/api/projects']:
            self.access.authorize(self.handler(self.login['token']),route)
        self.access.authorize(self.handler(self.login['token'],'POST',person),'/api/calculate')
        for route in ['/api/contacts/leads','/api/commercial/save','/api/project/save','/api/new-future-write',
                      '/api/contacts/leads/follow-up','/api/projects/follow-up']:
            self.assert_denied(403,self.handler(self.login['token'],'POST',person),route)
        self.assert_denied(409,self.handler(self.login['token']),'/api/libraries/technical/new')
        self.assert_denied(403,self.handler(self.login['token'],member=person),'/api/libraries/technical/new')
        self.assert_denied(409,self.handler(self.login['token'],'POST'),'/api/contacts/leads')

    def test_editor_can_edit_but_merges_and_configuration_require_admin(self):
        self.enable();self.access.assign({'member_id':self.worker['id'],'role':'editor','version':0},self.admin['token'])
        handler=self.handler(self.login['token'],'POST',self.worker['id'])
        self.access.authorize(handler,'/api/contacts/leads')
        self.assertEqual(handler.crm_actor,{'id':self.worker['id'],'name':'Estimator'})
        for route in ['/api/contacts/identity/merge','/api/contacts/identity/undo','/api/company-settings','/api/configuration','/api/projects/delete']:
            self.assert_denied(403,handler,route)
        self.assert_denied(409,self.handler(self.admin['token'],'POST',self.worker['id']),'/api/contacts/leads')

    def test_role_changes_are_versioned_and_recorded_without_mutating_source_identity(self):
        saved=self.access.assign({'member_id':self.worker['id'],'role':'editor','version':0},self.admin['token'])
        self.assertEqual(saved['version'],1)
        self.assertEqual(self.access.assign({'member_id':self.worker['id'],'role':'editor','version':1},self.admin['token']),saved)
        with self.assertRaises(AccessError):self.access.assign({'member_id':self.worker['id'],'role':'viewer','version':0},self.admin['token'])
        for bad in ({},[],None,42):
            with self.assertRaises(AccessError):self.access.assign({'member_id':bad,'role':'viewer','version':0},self.admin['token'])
        with self.access.connect() as db:
            rows=db.execute('SELECT actor_id,action,target FROM crm_access_audit').fetchall()
            self.assertEqual([tuple(r) for r in rows],[(self.admin['user']['id'],'access.role',self.worker['id'])])

    def test_deactivation_and_logout_revoke_access_without_role_or_identity_rewrite(self):
        self.enable()
        self.scheduler.write('logout',{},self.admin['token'])
        self.assert_denied(401,self.handler(self.admin['token']),'/api/bootstrap')
        with self.scheduler.connect() as db:db.execute('UPDATE scheduler_members SET active=0 WHERE id=?',(self.worker['id'],))
        self.assertIsNone(self.access.user(self.login['token']))

class AccessHTTPTests(unittest.TestCase):
    def setUp(self):
        from estimator.server import create_server
        self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name)
        self.server=create_server(0,root/'app.sqlite3',library_directory=root/'library')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        scheduler=SchedulerStore(root/'app-scheduler.sqlite3')
        admin=scheduler.write('setup',{'name':'Manager','email':'manager@example.test','password':'Correct-manager-password'})
        access=CRMAccess(root/'app-access.sqlite3',scheduler);access.activate_named_access()
        self.member=admin['user']['id'];self.cookie=''

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()

    def request(self,path,body=None,headers=None):
        connection=HTTPConnection('127.0.0.1',self.server.server_port,timeout=20)
        h={'Cookie':self.cookie,**(headers or {})}
        if body is not None:h['Content-Type']='application/json'
        connection.request('GET' if body is None else 'POST',path,json.dumps(body) if body is not None else None,h)
        response=connection.getresponse();data=response.read();result=(response.status,dict(response.getheaders()),data);connection.close();return result

    def test_named_session_uses_httponly_cookie_and_gates_local_data_and_old_tabs(self):
        self.assertEqual(self.request('/api/bootstrap')[0],401)
        status,_,page=self.request('/');self.assertEqual(status,200);self.assertIn(b'id="staff-login"',page)
        status,_,data=self.request('/api/access/session');self.assertEqual(status,200);self.assertIsNone(json.loads(data)['user'])
        status,headers,data=self.request('/api/access/login',{'email':'manager@example.test','password':'Correct-manager-password'})
        self.assertEqual(status,200,data);self.assertNotIn('token',json.loads(data));cookie=headers['Set-Cookie']
        for expected in ('HttpOnly','SameSite=Strict','Path=/'):self.assertIn(expected,cookie)
        self.cookie=cookie.split(';')[0]
        self.assertEqual(self.request('/api/bootstrap')[0],200)
        self.assertEqual(self.request('/api/scheduler/bootstrap')[0],200)
        self.assertEqual(self.request('/api/contacts/leads',{})[0],409)
        status,_,page=self.request('/');self.assertEqual(status,200);self.assertIn(b'id="view-settings"',page)
        self.assertEqual(self.request('/api/access/logout',{})[0],200)
        self.assertEqual(self.request('/api/contacts/directory')[0],401)

    def test_cross_origin_login_is_rejected_and_unknown_admin_routes_do_not_leak(self):
        self.assertEqual(self.request('/api/access/login',{'email':'manager@example.test','password':'Correct-manager-password'},
            {'Origin':'https://other.example'})[0],403)
        self.assertEqual(self.request('/api/access/login',{'email':'manager@example.test','password':'Correct-manager-password'},
            {'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.request('/api/access/members')[0],401)
        self.assertEqual(self.request('/api/access/roles',{'role':'editor'})[0],401)

    def test_named_mutation_audit_keeps_identity_and_result_without_copying_private_body(self):
        status,headers,_=self.request('/api/access/login',{'email':'manager@example.test','password':'Correct-manager-password'})
        self.assertEqual(status,200);self.cookie=headers['Set-Cookie'].split(';')[0]
        before=json.loads(self.request('/api/contacts/directory')[2])
        status,_,raw=self.request('/api/contacts/accounts',{'version':before['version'],
            'fields':{'company':'Audited customer','billing_address':'private-address-do-not-copy','abn_acn':''}},
            {'X-CRM-Member':self.member})
        self.assertEqual(status,200,raw)
        history=json.loads(self.request('/api/access/audit')[2])
        row=history['requests'][0]
        self.assertEqual((row['actor_name'],row['route'],row['status']),('Manager','/api/contacts/accounts',200))
        self.assertNotIn('private-address-do-not-copy',json.dumps(history))
        self.assertNotIn('Correct-manager-password',json.dumps(history))

    def test_failed_attribution_prevents_write_and_missing_response_remains_unknown(self):
        status,headers,_=self.request('/api/access/login',{'email':'manager@example.test','password':'Correct-manager-password'})
        self.assertEqual(status,200);self.cookie=headers['Set-Cookie'].split(';')[0]
        before=json.loads(self.request('/api/contacts/directory')[2])
        body={'version':before['version'],'fields':{'company':'Audit guard','billing_address':'','abn_acn':''}}
        with patch.object(CRMAccess,'begin_request',side_effect=sqlite3.OperationalError('Synthetic unavailable audit store')):
            self.assertEqual(self.request('/api/contacts/accounts',body,{'X-CRM-Member':self.member})[0],500)
        self.assertEqual(before,json.loads(self.request('/api/contacts/directory')[2]))
        with patch.object(CRMAccess,'finish_request',side_effect=sqlite3.OperationalError('Synthetic lost response receipt')):
            self.assertEqual(self.request('/api/contacts/accounts',body,{'X-CRM-Member':self.member})[0],200)
        history=json.loads(self.request('/api/access/audit')[2])
        self.assertIsNone(history['requests'][0]['status'])

