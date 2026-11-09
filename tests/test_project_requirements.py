"""Required Project writes must not prevent importing incomplete historical files."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.contacts import ContactsStore
from estimator.native_dialogs import SaveSelection
from estimator.project_details import ProjectDetails
from estimator.project_file import ESTIMATE_FIELDS, export_project, load_project_bytes
from estimator.project_library import ProjectLibrary
from estimator.project_requirements import REQUIRED_PROJECT_DETAILS, require_project_details
from estimator.storage import Store


COMPLETE = dict(project_no='PN-01',client='Synthetic Company',site_address='Synthetic Site',
                contact_name='Synthetic Contact',contact_phone='0400 000 001',contact_email='project@example.test')


class Chooser:
    def __init__(self,path): self.path=path; self.calls=0
    def choose_save(self,*args):
        self.calls+=1
        return SaveSelection(str(self.path),None)


class ProjectRequirementsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.path=self.root/'saved.cf.json'
        self.store=Store(self.root/'state.sqlite3')
        self.numbers=ProjectDetails(self.root/'numbers.sqlite3'); self.addCleanup(self.numbers.close)
        self.chooser=Chooser(self.path)
        self.library=ProjectLibrary(self.store,self.chooser,project_details=self.numbers); self.addCleanup(self.library.close)

    def request(self,details):
        return {'estimate':details,'project_save_request':str(uuid4())}

    def test_every_required_identity_value_is_checked_without_treating_zero_or_boolean_as_text(self):
        for key,_ in REQUIRED_PROJECT_DETAILS:
            for blank in ('',' \n\t','\u200b\u2060',None,0,False):
                with self.subTest(key=key,value=blank), self.assertRaisesRegex(ValidationError,'Complete required Project details'):
                    require_project_details({**COMPLETE,key:blank})
        require_project_details({**COMPLETE,'project_no':''},automatic_number=True)
        require_project_details(COMPLETE)

    def test_missing_identity_cannot_allocate_a_number_open_a_chooser_or_write_a_file(self):
        initial=self.numbers.settings()['next_reference']
        for key in ('client','site_address','contact_name','contact_email','contact_phone'):
            with self.subTest(key=key), self.assertRaisesRegex(ValidationError,'Complete required Project details'):
                self.library.save_as(self.request({**COMPLETE,key:''}))
            self.assertEqual(self.numbers.settings()['next_reference'],initial)
            self.assertEqual(self.chooser.calls,0)
            self.assertFalse(self.path.exists())
        saved=self.library.save_as(self.request({**COMPLETE,'project_no':''}))
        self.assertEqual(saved['file']['project_no'],initial)
        self.assertEqual(self.chooser.calls,1)

    def test_historical_incomplete_file_can_load_and_export_but_explicit_save_requires_correction(self):
        self.path.write_bytes(export_project(self.store,{'estimate':{'project_no':'PN-OLD','client':'Historical Client'}}))
        original=self.path.read_bytes()
        legacy=load_project_bytes(self.store,original)
        self.assertEqual(legacy['estimate']['contact_name'],'')
        estimate={key:value for key,value in legacy['estimate'].items() if key in ESTIMATE_FIELDS}
        self.assertTrue(export_project(self.store,{'estimate':estimate}))
        self.store.set_project_folder(str(self.root))
        listing=self.library.listing()
        while listing['scan_pending']: listing=self.library.listing()
        opened=self.library.load(next(row['id'] for row in listing['files'] if Path(row['path'])==self.path))
        request={'save_token':opened['file']['save_token'],'estimate':estimate,
                 'calculators':{key:{'inputs':value['inputs']} for key,value in legacy['calculators'].items()}}
        with self.assertRaisesRegex(ValidationError,'Complete required Project details'):
            self.library.save(request)
        self.assertEqual(self.path.read_bytes(),original)

    def test_pane_missing_identity_is_rejected_without_changing_file_bytes(self):
        self.store.set_project_folder(str(self.root))
        self.path.write_bytes(export_project(self.store,{'estimate':COMPLETE}))
        listing=self.library.listing()
        while listing['scan_pending']: listing=self.library.listing()
        file=next(row for row in listing['files'] if Path(row['path'])==self.path)
        current=self.library.read_details({'id':file['id']})
        original=self.path.read_bytes()
        accounts=ContactsStore(self.root/'contacts.sqlite3')
        for key,_ in REQUIRED_PROJECT_DETAILS:
            request={'id':file['id'],'revision':current['revision'],'request_id':str(uuid4()),
                     'details':{**deepcopy(current['details']),key:''}}
            with self.subTest(key=key), self.assertRaisesRegex(ValidationError,'Complete required Project details'):
                self.library.save_details(request,accounts=accounts)
            self.assertEqual(self.path.read_bytes(),original)


if __name__=='__main__': unittest.main()
