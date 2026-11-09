from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.contacts import ContactsStore
from estimator.crm_participants import CRMParticipants, ParticipantConflict


class Projects:
    def __init__(self):
        self.rows={id:{'source':id,'owner':str(uuid4()),'project_no':'PN-'+id,'client':'Builder '+id,
                       'site_address':'Shared address','revision':'current'} for id in ('A','B','C')}

    def participant_project(self, id):
        if id not in self.rows:
            raise ValidationError('Unknown project')
        return self.rows[id]

    def participant_availability(self,rows):
        known={(r['source'],r['owner'],r['project_no']) for r in self.rows.values()}
        return {key:('available' if key in known else 'unavailable') for key in
                ((r['source'],r['owner'],r['project_no']) for r in rows)}


class ParticipantTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        root=Path(temp.name)
        self.projects=Projects();self.contacts=ContactsStore(root/'directory.sqlite3')
        self.service=CRMParticipants(root/'participants.sqlite3',self.projects,self.contacts)
        company=self.contacts.save('accounts',{'fields':{'company':'Engineering Co'},'version':0})
        self.participant={'role':'consultant','kind':'accounts','id':company['id']}
        self.actor={'id':'staff','name':'Synthetic staff'}

    def link(self,project,version=0,site=None,rows=None,revision='current'):
        return self.service.save({'project':project,'project_revision':revision,'version':version,
            'participants':rows or [],'site_id':site},self.actor)

    def test_explicit_site_cross_bid_links_preserve_project_and_directory_records(self):
        before=deepcopy(self.projects.rows),self.contacts.list()
        site={'id':str(uuid4()),'name':'School','address':'Shared address'}
        self.assertEqual(self.service.create_site(site,self.actor),site)
        self.assertEqual(self.service.create_site(site,self.actor),site)
        self.assertEqual(self.service.sites('SHARED')['sites'],[site])
        separate=self.service.create_site({**site,'id':str(uuid4())},self.actor)
        self.assertNotEqual(separate['id'],site['id'])
        self.link('A',site=site['id'],rows=[self.participant])
        self.link('B',site=site['id'])
        peer,=self.service.view('A')['linked_bids']
        self.assertEqual((peer['client'],peer['project_no'],peer['site_address'],peer['availability']),
                         ('Builder B','PN-B','Shared address','available'))
        self.assertIsNone(self.service.view('C')['site'])
        self.assertEqual(self.service.view('A')['participants'][0]['label'],'Engineering Co')
        alias_group=[str(uuid4()),self.participant['id']]
        role,=self.service.related('accounts',alias_group)
        self.assertEqual((role['role'],role['party_id'],role['project_no']),('consultant',self.participant['id'],'PN-A'))
        self.assertEqual((self.projects.rows,self.contacts.list()),before)
        with self.assertRaises(ParticipantConflict):
            self.link('A',site=separate['id'])
        self.assertEqual(self.link('A',version=1,rows=[self.participant])['linked_bids'],[])
        self.assertEqual(self.service.view('B')['linked_bids'],[])

    def test_unavailable_sources_retain_site_and_role_snapshots_without_scanning_directory(self):
        with patch.object(self.contacts,'list',side_effect=AssertionError('Do not materialize the directory to validate exact IDs')):
            site=self.service.create_site({'id':str(uuid4()),'name':'Hub','address':'Old street'},self.actor)
            self.link('A',site=site['id'],rows=[self.participant])
            self.link('B',site=site['id'])
        del self.projects.rows['A']
        peer,=self.service.view('B')['linked_bids']
        self.assertEqual((peer['client'],peer['availability']),('Builder A','unavailable'))
        self.assertEqual({r['project_no']:r['availability'] for r in self.service.site(site['id'])['linked_bids']},
                         {'PN-A':'unavailable','PN-B':'available'})
        role,=self.service.related('accounts',[self.participant['id']])
        self.assertEqual((role['project_no'],role['availability']),('PN-A','unavailable'))

    def test_rejects_unknown_changed_or_forged_associations_before_writing(self):
        before=self.service.view('A')
        for kwargs in ({'rows':[dict(self.participant,id=str(uuid4()))]}, {'rows':[dict(self.participant,role='typo')]},
                       {'rows':[self.participant,self.participant]}, {'site':str(uuid4())}, {'revision':'stale'}):
            with self.subTest(kwargs=kwargs),self.assertRaises(ValidationError):
                self.link('A',**kwargs)
            self.assertEqual(self.service.view('A'),before)
        self.link('A',rows=[self.participant])
        self.projects.rows['A']['owner']=str(uuid4())
        self.assertEqual(self.service.view('A')['participants'],[])
