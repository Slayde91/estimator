"""Directory associations use exact saved files, never shared display names."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.account_relations import AccountRelations
from estimator.catalog import ValidationError
from estimator.certification import CertificationService, FIELDS
from estimator.certification_projects import CertificationProjects
from estimator.contact_relations import ContactRelations
from estimator.contacts import ContactsStore, LINK_KINDS
from estimator.directory_documents import certificate_cards, snapshot_cards
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from estimator.swms import default_fields
from test_contact_relations import KnownProjects


class DirectoryRelatedDocumentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = ContactsStore(self.root/'contacts.sqlite3')
        self.company = self.save('accounts', {'company':'Exact Company'})['account']
        self.person = self.save('contacts', {'name':'Exact Contact','company':'Exact Company','phone':'111','email':'first@example.test'})['contact']
        self.other = self.save('contacts', {'name':'Exact Contact','company':'Exact Company','phone':'222','email':'other@example.test'})['contact']
        self.owner = str(uuid4())
        self.source = 'a'*64
        self.project = {'id':self.source,'path':str(self.root/'saved.cf.json'),'source_project_id':self.owner,
                        'account_link_id':str(uuid4()),'account_id':self.company['id'],'contact_id':self.person['id'],
                        'client':'Exact Company','project_no':'PN-01','site_address':'Exact site'}
        self.projects = KnownProjects()
        self.projects.files = [self.project]

    def save(self, kind, fields, **options):
        return self.directory.save(kind, {'version':self.directory.list()['version'],'fields':fields,**options})

    def card(self, kind, **options):
        return {'id':str(uuid4()),'project_id':self.owner,'kind':kind,'reference':kind+'-01',
                'fields':{'title':'Exact '+kind,'details':{'client':'Exact Company'}},**options}

    def test_indexed_commercial_cards_remain_visible_during_bounded_register_scan(self):
        cards = [self.card(kind) for kind in ('quote','work_order','purchase_order')]
        self.project['commercial_cards'] = cards
        self.projects.pending = True
        for relations, identity in ((AccountRelations(self.directory,self.projects),self.company['id']),
                                    (ContactRelations(self.directory,self.projects),self.person['id'])):
            view = relations.view(identity)
            for group,card in zip(('quotes','work_orders','purchase_orders'),cards):
                self.assertEqual([entry['id'] for entry in view['linked'][group]],[self.owner+':'+card['id']])
            self.assertTrue(view['scan_pending'])
        self.assertFalse(ContactRelations(self.directory,self.projects).view(self.other['id'])['linked']['quotes'])

    def test_certifications_and_swms_display_without_changing_manual_link_contract(self):
        self.project['directory_cards'] = [self.card(kind) for kind in ('certification','swms')]
        before = self.directory.list()
        view = AccountRelations(self.directory,self.projects).view(self.company['id'])
        self.assertEqual(set(view['linked']),set(LINK_KINDS))
        self.assertEqual(set(view['choices']),set(LINK_KINDS))
        self.assertEqual([len(view['related'][key]) for key in ('certifications','swms')],[1,1])
        self.assertEqual(before,self.directory.list())
        self.project['account_id'] = str(uuid4())
        self.assertFalse(any(AccountRelations(self.directory,self.projects).view(self.company['id'])['related'].values()))

    def test_contact_leads_use_exact_contact_id_and_remain_clickable_directory_ids(self):
        lead = self.save('leads',{'name':'Exact Contact','company':'Exact Company'},contact_id=self.person['id'])
        mine = ContactRelations(self.directory,self.projects).view(self.person['id'])['linked']['leads']
        self.assertEqual(mine,[{'id':lead['id'],'label':'Exact Contact','available':True}])
        self.assertEqual(ContactRelations(self.directory,self.projects).view(self.other['id'])['linked']['leads'],[])

    def test_unknown_source_and_duplicate_foreign_copy_never_relabel_owned_documents(self):
        card = self.card('quote')
        self.projects.documents = [{**card,'source_file':self.source}]
        foreign = {**self.project,'id':'b'*64,'account_link_id':str(uuid4()),'account_id':str(uuid4()),'client':'Foreign private label'}
        self.projects.files.append(foreign)
        self.projects.documents.extend([{**card,'source_file':'b'*64},{**self.card('quote'),'source_file':'unknown'}])
        entries=AccountRelations(self.directory,self.projects).view(self.company['id'])['linked']['quotes']
        self.assertEqual(len(entries),1)
        self.assertIn('Exact Company',entries[0]['label'])
        self.assertNotIn('Foreign',entries[0]['label'])

    def test_swms_snapshot_cards_require_canonical_project_owner(self):
        document={'id':str(uuid4()),'version':1,'status':'Draft','fields':default_fields(),
                  'created_at':'2026-11-09T00:00:00+00:00','updated_at':'2026-11-09T00:00:00+00:00'}
        saved={'swms':{'version':1,'project_id':self.owner,'documents':[document]}}
        self.assertEqual(snapshot_cards(saved,self.owner)[0]['id'],document['id'])
        self.assertEqual(snapshot_cards(saved,str(uuid4())),[])

    def test_verified_certificate_archive_is_read_without_restoring_a_workspace(self):
        store=Store(self.root/'runtime'/'state.sqlite3')
        certificates=CertificationProjects(CertificationService(store))
        workspace=certificates.new();owner=workspace['project_id']
        certificates.activate_created_project(workspace['workspace_id'],'PN-01')
        service=certificates.service(workspace['workspace_id'])
        document=service.create(dict.fromkeys(FIELDS,''),str(uuid4()))
        manifest=certificates.capture({'workspace_id':workspace['workspace_id'],'draft':None})
        path=self.root/'saved.cf.json';certificates.publish(manifest,path)
        cache={}
        with patch.object(CertificationProjects,'restore',side_effect=AssertionError('No restore is allowed')):
            cards=certificate_cards(manifest,path,owner,cache)
            self.assertEqual(cards[0]['id'],document['id'])
            with patch.object(CertificationProjects,'_read_archive',side_effect=AssertionError('Exact cached archive must not be reparsed')):
                self.assertEqual(certificate_cards(manifest,path,owner,cache),cards)
        archive=path.parent/manifest['companion_folder']/(manifest['archive_sha256']+'.zip')
        archive.write_bytes(b'x'*archive.stat().st_size)
        with self.assertRaises(ValidationError):certificate_cards(manifest,path,owner,cache)
        archive.unlink()
        with self.assertRaises(ValidationError):certificate_cards(manifest,path,owner,cache)

    def test_actual_project_index_exposes_saved_swms_and_certificate_cards_only(self):
        store=Store(self.root/'runtime'/'state.sqlite3')
        certificates=CertificationProjects(CertificationService(store))
        workspace=certificates.new();owner=workspace['project_id']
        certificates.activate_created_project(workspace['workspace_id'],'PN-01')
        document=certificates.service(workspace['workspace_id']).create(dict.fromkeys(FIELDS,''),str(uuid4()))
        manifest=certificates.capture({'workspace_id':workspace['workspace_id'],'draft':None})
        folder=self.root/'Projects';folder.mkdir();store.set_project_folder(folder)
        path=folder/'Saved.cf.json';certificates.publish(manifest,path)
        statement={'id':str(uuid4()),'version':1,'status':'Draft','fields':default_fields(),
                   'created_at':'2026-11-09T00:00:00+00:00','updated_at':'2026-11-09T00:00:00+00:00'}
        path.write_bytes(export_project(store,{'estimate':{'project_no':'PN-01','client':'Exact Company','account_id':self.company['id']},
            'certifications':manifest,'swms':{'version':1,'project_id':owner,'documents':[statement]}}))
        library=ProjectLibrary(store,certifications=certificates)
        self.addCleanup(library.close)
        for _ in range(20):
            view=AccountRelations(self.directory,library).view(self.company['id'])
            if not view['scan_pending']:break
        self.assertEqual(view['related']['certifications'][0]['id'],owner+':'+document['id'])
        self.assertEqual(view['related']['swms'][0]['id'],owner+':'+statement['id'])
        archive=path.parent/manifest['companion_folder']/(manifest['archive_sha256']+'.zip');archive.unlink()
        after=AccountRelations(self.directory,library).view(self.company['id'])
        self.assertFalse(after['related']['certifications'])
        self.assertTrue(after['related']['swms'])
        self.assertGreater(after['error_count'],0)


if __name__=='__main__':unittest.main()
