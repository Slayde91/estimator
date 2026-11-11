from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.contacts import ContactsStore
from estimator.crm_participants import CRMParticipants, ParticipantConflict
from estimator.project_relationships import address_key, address_site, project_link_id


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

    def participant_sites(self):
        return {'projects':[{key:row[key] for key in ('source','owner','project_no','client','site_address')}
                            for row in self.rows.values()], 'scan_pending':False}


class ParticipantTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        root=Path(temp.name)
        self.projects=Projects();self.contacts=ContactsStore(root/'directory.sqlite3')
        for row in self.projects.rows.values():
            row['site_address']='Address '+row['source']
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
                         ('Builder B','PN-B','Address B','available'))
        self.assertEqual(self.service.view('C')['linked_sites'],[address_site('Address C')])
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

    def test_automatic_exact_address_links_keep_distinct_copies_and_never_write_on_read(self):
        self.projects.rows['A']['site_address']='  Unit 2, ４２ Example Lane\nSydney '
        self.projects.rows['B'].update(site_address='unit 2, 42  EXAMPLE lane Sydney',owner=self.projects.rows['A']['owner'])
        self.projects.rows['C']['site_address']='Unit 2 42 Example Lane Sydney'  # Punctuation remains significant.
        before=self.service.path.read_bytes(),deepcopy(self.projects.rows),self.contacts.list()
        view=self.service.view('A')
        self.assertEqual(view['site_mode'],'automatic')
        self.assertIsNone(view['site_id'])
        self.assertEqual([row['source'] for row in view['linked_bids']],['B'])
        self.assertEqual(view['linked_bids'][0]['owner'],self.projects.rows['A']['owner'])
        self.assertEqual(view['site']['id'],address_site(self.projects.rows['B']['site_address'])['id'])
        self.assertEqual((self.service.path.read_bytes(),self.projects.rows,self.contacts.list()),before)
        self.assertEqual(self.service.sites('UNIT 2, 42')['sites'][0]['id'],view['site']['id'])
        for address in ('Unit 3, 42 Example Lane Sydney','Unit 2, 42 Example Ln Sydney','Unit 2, 42 Example Lane, Sydney'):
            self.projects.rows['B']['site_address']=address
            self.assertEqual(self.service.view('A')['linked_bids'],[],address)

    def test_direct_link_materializes_only_authorized_address_and_automatic_follows_saved_edits(self):
        target=address_site(self.projects.rows['B']['site_address'])
        with self.assertRaises(ParticipantConflict):
            self.link('A',site=target['id'],revision='stale')
        self.assertEqual(self.service.sites('Address B')['sites'],[target])
        with self.service.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM sites').fetchone()[0],0)
        linked=self.link('A',site=target['id'],rows=[self.participant])
        self.assertEqual(linked['site_mode'],'automatic')
        self.assertEqual([site['address'] for site in linked['linked_sites']],['Address A','Address B'])
        self.assertEqual([row['source'] for row in linked['linked_bids']],['B'])
        self.assertEqual(linked['site_id'],target['id'])
        self.projects.rows['A']['site_address']='Address C'
        self.assertEqual([row['source'] for row in self.service.view('A')['linked_bids']],['B','C'])
        automatic=self.link('A',version=linked['version'],rows=[self.participant])
        self.assertEqual(automatic['site_mode'],'automatic')
        self.assertEqual([row['source'] for row in automatic['linked_bids']],['C'])
        self.assertEqual(automatic['participants'],linked['participants'])
        self.assertEqual(automatic['site']['id'],address_site('Address C')['id'])

    def test_duplicate_named_sites_are_not_merged_and_partial_scans_are_reported(self):
        first=self.service.create_site({'id':str(uuid4()),'name':'East campus','address':'Address A'},self.actor)
        second=self.service.create_site({'id':str(uuid4()),'name':'West campus','address':'ADDRESS A'},self.actor)
        choices=self.service.sites('address a')
        self.assertEqual({row['id'] for row in choices['sites']},{first['id'],second['id']})
        self.assertEqual(self.service.view('A')['linked_sites'],[address_site('Address A')])
        self.assertEqual(self.service.site(first['id'])['linked_bids'],[])
        self.assertEqual(self.link('A',site=second['id'])['linked_sites'],[second])
        self.projects.rows['B']['site_address']='Address A'
        self.link('B',site=first['id'])
        self.assertEqual(self.service.view('A')['linked_bids'],[])
        self.assertEqual(self.service.view('B')['linked_bids'],[])
        self.assertEqual([bid['source'] for bid in self.service.site(first['id'])['linked_bids']],['B'])
        with patch.object(self.projects,'participant_sites',return_value={'projects':[], 'scan_pending':True}):
            self.assertTrue(self.service.view('A')['scan_pending'])
            self.assertTrue(self.service.sites()['scan_pending'])
        with patch.object(self.projects,'participant_sites',side_effect=OSError):
            self.assertTrue(self.service.sites()['scan_pending'])

    def test_linked_companies_use_exact_source_token_not_portable_owner_or_company_name(self):
        token=project_link_id(self.projects.rows['A']['source'])
        self.projects.rows['A'].update(account_link_id=token,linked_parties=[{'kind':'contacts','id':str(uuid4()),'role':'Billing contact'}])
        self.projects.rows['B'].update(owner=self.projects.rows['A']['owner'],account_link_id=project_link_id('B'))
        with self.contacts.connection() as db:
            db.execute('INSERT INTO account_links VALUES(?,?,?,?)',(self.participant['id'],'projects',token,'Exact Project A'))
        view=self.service.view('A')
        self.assertEqual(view['linked_parties'][-1],{'id':self.participant['id'],'kind':'accounts','role':'Linked company','label':'Engineering Co'})
        self.assertEqual(self.service.view('B')['linked_parties'],[])
        self.assertEqual(view['linked_parties'][0],self.projects.rows['A']['linked_parties'][0])

    def test_automatic_and_previous_manual_sites_are_symmetric_and_reads_preserve_every_record(self):
        self.projects.rows['A']['site_address']='East address'
        self.projects.rows['B']['site_address']='EAST ADDRESS'
        self.projects.rows['C']['site_address']='West address'
        site=self.service.create_site({'id':str(uuid4()),'name':'Manual West','address':'WEST address'},self.actor)
        self.link('B',site=site['id'])
        before=self.service.path.read_bytes(),deepcopy(self.projects.rows)
        self.assertEqual([row['source'] for row in self.service.view('A')['linked_bids']],['B'])
        self.assertEqual([row['source'] for row in self.service.view('B')['linked_bids']],['A','C'])
        self.assertEqual([row['source'] for row in self.service.view('C')['linked_bids']],['B'],'Effective-address matches are symmetric')
        self.assertEqual((self.service.path.read_bytes(),self.projects.rows),before)
        self.assertEqual(self.service.site(site['id'])['linked_bids'][0]['source'],'B')

    def test_single_project_links_on_open_and_follows_saved_address_without_writes(self):
        named=self.service.create_site({'id':str(uuid4()),'name':'Campus','address':'ADDRESS A'},self.actor)
        before=self.service.path.read_bytes()
        self.assertEqual(self.service.view('A')['linked_sites'],[named])
        self.assertEqual([bid['source'] for bid in self.service.site(named['id'])['linked_bids']],['A'])
        self.projects.rows['A']['site_address']='Unit 3, Address A'
        self.assertEqual(self.service.view('A')['linked_sites'],[address_site('Unit 3, Address A')])
        self.assertEqual(self.service.site(named['id'])['linked_bids'],[])
        self.projects.rows['A']['site_address']=' '
        self.assertEqual(self.service.view('A')['linked_sites'],[])
        with patch.object(self.projects,'participant_sites',side_effect=OSError):
            self.projects.rows['A']['site_address']='Address A'
            self.assertEqual(self.service.view('A')['linked_sites'],[named])
        self.assertEqual(self.service.path.read_bytes(),before)
