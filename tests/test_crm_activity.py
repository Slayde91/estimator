"""Traceable local CRM activity: only observed writes establish dates and actors."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.contacts import ContactsConflict, ContactsStore, LEAD_STATUSES
from estimator import crm_activity


class CrmActivityTests(TestCase):
    def setUp(self):
        tmp=TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.actor={'id':str(uuid4()),'name':'Local agent'}
        self.owner={'id':str(uuid4()),'name':'Site estimator'}
        self.roster=[self.actor,self.owner]
        self.store=ContactsStore(Path(tmp.name)/'directory.sqlite3',staff_provider=lambda:self.roster)
        self.fields={'name':'Buyer','company':'Enquiry client','site_address':'Site one','email':'a@example.test','phone':'111'}

    def version(self):
        return self.store.list()['version']

    def save(self,kind,fields,**extra):
        return self.store.save(kind,{'version':self.version(),'fields':fields,**extra},actor=self.actor)

    def events(self,kind,ident,before=None):
        with self.store.connection() as db:
            return crm_activity.timeline(db,kind,ident,before)

    def log(self,body,actor=None):
        return crm_activity.log_activity(self.store,body,actor or self.actor,ContactsConflict)

    def test_generated_people_and_companies_get_real_creation_times_no_op_saves_do_not_change_history(self):
        self.save('leads',self.fields,owner_id=self.owner['id'],region='Interstate')
        directory=self.store.list()
        lead=directory['leads'][0]
        for kind in ('leads','contacts','accounts'):
            row=directory[kind][0]
            self.assertEqual(row['created_at'],row['updated_at'])
            own=[e for e in self.events(kind,row['id'])['events'] if e['record_id']==row['id']]
            self.assertEqual([e['event_type'] for e in own],['Created'])
            self.assertEqual(own[0]['actor_id'],self.actor['id'])
        self.assertEqual((lead['owner_name'],lead['region']),('Site estimator','Interstate'))
        self.roster.remove(self.owner)
        self.save('leads',self.fields,id=lead['id'],owner_id=self.owner['id'])
        self.assertEqual(self.store.list()['leads'][0],lead)
        self.assertEqual(len(self.events('leads',lead['id'])['events']),1)
        self.save('leads',{**self.fields,'status':'Quoting'},id=lead['id'])
        newer=self.store.list()['leads'][0];entry=self.events('leads',lead['id'])['events'][0]
        self.assertEqual((entry['event_type'],entry['detail']['previous_status'],entry['detail']['status']),('Stage changed','New','Quoting'))
        self.assertEqual((newer['region'],newer['owner_id'],newer['created_at']),('Interstate',self.owner['id'],lead['created_at']))
        self.assertGreater(newer['updated_at'],newer['created_at'])

    def test_legacy_rows_and_old_stage_never_acquire_invented_dates_or_implicit_win(self):
        account,contact,ident=[str(uuid4()) for _ in range(3)]
        with self.store.connection() as db:
            db.execute('INSERT INTO accounts VALUES(?,?,?,?,?)',(account,'A','a','',''))
            db.execute('INSERT INTO contacts VALUES(?,?,?,?,?,?)',(contact,'Older buyer','123','','a@example.test',account))
            db.execute('INSERT INTO leads VALUES(?,?,?,?,?,?,NULL)',(ident,contact,'Site','','','Interstate'))
        before=self.store.list()
        self.assertEqual(tuple(before['sales_stages']),LEAD_STATUSES)
        self.assertIn('Interstate',before['statuses'])
        self.assertNotIn('created_at',before['leads'][0])
        self.assertEqual(self.events('leads',ident)['events'],[])
        fields={**self.fields,'name':'Older buyer','company':'A','site_address':'Site'}
        self.save('leads',fields,id=ident,region='Victoria')
        lead=self.store.list()['leads'][0]
        self.assertEqual(lead['status'],'Interstate')
        self.assertIn('updated_at',lead);self.assertNotIn('created_at',lead)
        body={'id':ident,'version':self.version()}
        receipt=self.store.convert(body,lambda _: {'project_no':'PN-001','path':'fixture/project.cf.json'},actor=self.actor)
        self.store.convert(body,lambda _: self.fail('unexpected duplicate project'),actor=self.owner)
        converted=self.store.list(history_account_id=account)['converted_leads'][0]
        self.assertEqual(converted['snapshot'],lead)
        self.assertEqual(converted['actor_name'],self.actor['name'])
        events=self.events('leads',ident)['events']
        self.assertEqual([e['event_type'] for e in events],['Converted','Updated'])
        self.assertEqual(events[0]['detail']['status'],'Interstate')
        self.assertEqual(events[0]['detail']['project_no'],receipt['project_no'])

    def test_authored_events_agree_on_owner_customer_and_person_and_retry_without_duplicates(self):
        person=self.save('contacts',{**{key:self.fields[key] for key in ('name','email','phone')},'company':'Employer'})['contact']
        self.save('leads',self.fields,contact_id=person['id'])
        lead=self.store.list()['leads'][0]
        body={'id':lead['id'],'kind':'leads','type':'Call','text':'Asked for a revised scope','owner_id':self.owner['id'],
              'request_id':str(uuid4()),'version':self.version()}
        result=self.log(body)
        self.assertEqual(self.log(body),result)
        with self.assertRaises(ContactsConflict):self.log(body,actor=self.owner)
        with self.assertRaises(ContactsConflict):self.log({**body,'text':'Changed call'})
        for kind,ident in (('leads',lead['id']),('contacts',person['id']),('accounts',lead['account_id'])):
            entry=self.events(kind,ident)['events'][0]
            self.assertEqual((entry['id'],entry['actor_name'],entry['owner_name']),(result['activity_id'],self.actor['name'],self.owner['name']))
            current=next(x for x in self.store.list()[kind] if x['id']==ident)
            self.assertEqual(current['last_interaction_at'],entry['recorded_at'])
        self.assertNotIn('Call',[e['event_type'] for e in self.events('accounts',person['account_id'])['events']])
        with self.assertRaises(ValidationError):self.log({**body,'actor_id':'forged'})
        with self.assertRaises(ContactsConflict):self.log({**body,'request_id':str(uuid4())})

    def test_task_completion_preserves_original_company_after_contact_changes_employer(self):
        fields={key:self.fields[key] for key in ('name','company','email','phone')}
        person=self.save('contacts',fields)['contact']
        body={'kind':'contacts','id':person['id'],'version':self.version(),'type':'Task','due_date':'2027-10-20',
              'text':'Check received quote','owner_id':self.owner['id'],'request_id':str(uuid4())}
        with self.assertRaises(ValidationError):self.log({**body,'due_date':'2027-02-30'})
        task=self.log(body)
        moved=self.save('contacts',{**fields,'company':'New employer'},id=person['id'])['contact']
        done={'kind':'contacts','id':person['id'],'version':self.version(),'type':'Task completed','task_id':task['activity_id'],'request_id':str(uuid4())}
        self.log(done)
        self.assertEqual(self.log(done)['version'],self.version())
        with self.assertRaises(ContactsConflict):self.log({**done,'request_id':str(uuid4()),'version':self.version()})
        old_events=self.events('accounts',person['account_id'])['events']
        task_row=next(e for e in old_events if e['id']==task['activity_id'])
        self.assertEqual(task_row['due_date'],'2027-10-20')
        self.assertEqual(task_row['completed_at'],next(e['recorded_at'] for e in old_events if e['event_type']=='Task completed'))
        self.assertNotIn('Task completed',[e['event_type'] for e in self.events('accounts',moved['account_id'])['events']])
        self.assertNotIn('last_interaction_at',self.store.list()['contacts'][0])

    def test_backdated_meeting_tracks_actual_time_without_overwriting_newer_interaction(self):
        record=self.save('accounts',{'company':'Site manager'})['id']
        def log(when):
            return self.log({'id':record,'kind':'accounts','request_id':str(uuid4()),'version':self.version(),
                             'type':'Meeting','text':'Walkthrough','occurred_at':when})
        log('2001-01-02T13:00:00+11:00')
        second=log('2000-12-31T20:00:00Z')
        old=self.events('accounts',record)['events'][0]
        self.assertEqual(old['id'],second['activity_id'])
        self.assertGreater(old['recorded_at'],old['occurred_at'])
        self.assertEqual(self.store.list()['accounts'][0]['last_interaction_at'],'2001-01-02T02:00:00.000000+00:00')
        before=self.version()
        for invalid in ['2026-01-01','2099-04-10T12:00:00Z',{}]:
            with self.assertRaises(ValidationError):log(invalid)
        self.assertEqual(self.version(),before)

    def test_invalid_owner_rolls_back_nested_creation_and_import_dates_are_observed(self):
        before=self.store.list()
        with self.assertRaises(ValidationError):self.save('leads',self.fields,owner_id=str(uuid4()))
        self.assertEqual(self.store.list(),before)
        fields={key:self.fields[key] for key in ('name','company','email','phone')}
        self.store.import_rows('contacts',[(2,fields)],self.version(),actor=self.actor)
        after=self.store.list()
        self.store.import_rows('contacts',[(2,fields)],self.version(),actor=self.actor)
        self.assertEqual(after['contacts'],self.store.list()['contacts'])
        self.assertIn('created_at',after['contacts'][0])

    def test_merge_and_undo_project_original_events_and_last_interaction_without_reassigning_them(self):
        from estimator.crm_identity import IdentityService
        source=self.save('accounts',{'company':'Original organisation'})['id']
        survivor=self.save('accounts',{'company':'Current organisation'})['id']
        body={'kind':'accounts','id':source,'request_id':str(uuid4()),'version':self.version(),'type':'Meeting','text':'Site brief'}
        meeting=self.log(body)['activity_id']
        original=next(e for e in self.events('accounts',source)['events'] if e['id']==meeting)
        service=IdentityService(self.store)
        args={'kind':'accounts','source_id':source,'survivor_id':survivor}
        preview=service.preview(args)
        merged=service.apply('merge',{**args,'version':preview['version'],'preview_token':preview['preview_token'],
                             'reason':'Staff verified both records','request_id':str(uuid4())},self.actor)
        projected=next(e for e in self.events('accounts',survivor)['events'] if e['id']==meeting)
        self.assertEqual(projected,original)
        self.assertEqual(self.store.list()['accounts'][0]['last_interaction_at'],original['recorded_at'])
        service.apply('undo',{'kind':'accounts','version':self.version(),'operation_id':merged['operation_id'],'request_id':str(uuid4())},self.actor)
        self.assertNotIn(meeting,[e['id'] for e in self.events('accounts',survivor)['events']])
        self.assertIn(meeting,[e['id'] for e in self.events('accounts',source)['events']])
        self.assertNotIn('last_interaction_at',next(r for r in self.store.list()['accounts'] if r['id']==survivor))
