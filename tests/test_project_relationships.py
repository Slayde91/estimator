"""Saved-file source authority and ID-only parties for Project relationship cards."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.project_relationships import address_key, project_parties
from estimator.storage import Store


class ProjectRelationshipsTests(unittest.TestCase):
    def test_party_snapshot_keeps_only_canonical_ids_under_the_exact_commercial_owner(self):
        owner,primary,company,other,supplier,billing=[str(uuid4()) for _ in range(6)]
        details={'contact_id':primary,'contact_name':'Same name','account_id':company,'client':'Builder'}
        snapshot={'commercial_documents':{'project_id':owner,'documents':[
            {'kind':'quote','fields':{'details':{'contact_id':other,'contact':'Same name'}}},
            {'kind':'work_order','fields':{'billing':{'account_id':company,'contact_id':billing,'name':'Accounts'}}},
            {'kind':'purchase_order','fields':{'order':{'supplier_account_id':supplier,'supplier':'Supplier','site_contact_id':other}}}]}}
        rows=project_parties(snapshot,details,owner)
        self.assertEqual({row['id'] for row in rows if row['kind']=='contacts'},{primary,other,billing})
        self.assertEqual({row['id'] for row in rows if row['kind']=='accounts'},{company,supplier})
        self.assertEqual(len([row for row in rows if row['id']==other]),2,'Different roles retained for exact same ID')
        snapshot['commercial_documents']['project_id']=str(uuid4())
        self.assertEqual([row['id'] for row in project_parties(snapshot,details,owner)],[company,primary])
        self.assertEqual(project_parties({},dict(contact_id='Same name'),owner),[],'Names never resolve identity')

    def test_authorized_address_catalog_omits_changed_cached_files_and_never_exposes_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=root/'projects';folder.mkdir();store=Store(root/'state.sqlite3')
            details={'project_no':'PN-1','client':'Builder','site_address':'Unit 2, 42 Lane','contact_name':'Person','contact_email':'person@example.test','contact_phone':'111'}
            payload=export_project(store,{'estimate':details,'calculators':{}})
            path=folder/'one.cf.json';path.write_bytes(payload)
            library=ProjectLibrary(store,SimpleNamespace(choose_folder=lambda initial:folder))
            self.addCleanup(library.close)
            listing=library.link_folder()
            for _ in range(100):
                if not listing['scan_pending']:break
                listing=library.listing()
            selected=listing['files'][0]
            catalog=library.participant_sites()
            self.assertEqual(catalog['projects'][0]['site_address'],details['site_address'])
            self.assertNotIn('path',catalog['projects'][0])
            identity=library.participant_project(selected['id'])
            self.assertEqual(catalog['projects'][0]['source'],identity['source'])
            frozen=library.account_relation_projects()
            changed=json.loads(payload);changed['estimate']['site_address']='Different site';path.write_text(json.dumps(changed),encoding='utf8')
            with patch.object(library,'account_relation_projects',return_value=frozen):
                after=library.participant_sites()
            self.assertEqual(after['projects'],[])
            self.assertTrue(after['scan_pending'])
            self.assertNotEqual(address_key(details['site_address']),address_key(changed['estimate']['site_address']))
