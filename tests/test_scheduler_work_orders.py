from pathlib import Path
from hashlib import sha256
import json
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.certification import CertificationService
from estimator.certification_projects import CertificationProjects
from estimator.commercial_documents import CommercialDocuments, default_fields
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from tests.commercial_ready_fixtures import complete_quote


class SchedulerOrderSourceTests(unittest.TestCase):
    def test_exact_file_copy_revision_and_work_order_kind_are_required(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);directory=root/'bids';directory.mkdir()
            store=Store(root/'state.sqlite3');store.set_project_folder(directory)
            certs=CertificationProjects(CertificationService(store))
            manifest=certs.capture({'workspace_id':certs.new()['workspace_id'],'draft':None})
            owner,identity=manifest['project_id'],str(uuid4())
            fields=default_fields('work_order', {'project_no':'PN-01','client':'Customer'})
            fields['order']['work_order_reference']='WO-01'
            order={'id':identity,'kind':'work_order','status':'Draft','version':1,'reference':'WO-01','last_number':'',
                   'fields':fields,'created_at':'2026-11-01','updated_at':'2026-11-01'}
            service=ProjectLibrary(store,certifications=certs);service.commercial=CommercialDocuments(certs)
            try:
                paths={}
                for client in ('Alpha','Beta'):
                    path=directory/(client+'.cf.json');paths[client]=path
                    path.write_bytes(export_project(store,{'estimate':{'client':client,'site_address':'Shared site','project_no':'PN-01'},
                        'certifications':manifest,'commercial_documents':{'version':1,'project_id':owner,'documents':[order],
                        'number_counters':{'quote':0,'work_order':0,'purchase_order':0}}}))
                rows=service.scheduler_work_orders(0)['orders']
                self.assertEqual({row['client'] for row in rows},{'Alpha','Beta'})
                first,second=rows
                self.assertNotEqual(first['id'],second['id'])
                self.assertEqual(first['document_id'],second['document_id'])
                self.assertEqual(service.scheduler_work_order(second['id'],second['revision']),second)
                snapshot=json.loads(paths[first['client']].read_bytes())
                snapshot['commercial_documents']['documents'][0]['kind']='quote'
                paths[first['client']].write_text(json.dumps(snapshot))
                with self.assertRaises(ValidationError):
                    service.scheduler_work_order(first['id'],first['revision'])
                with self.assertRaises(ValidationError):
                    service.scheduler_work_order(first['id'],sha256(paths[first['client']].read_bytes()).hexdigest())
                with self.assertRaises(ValidationError):
                    service.scheduler_work_order(str(paths[first['client']]),first['revision'])
                paths[first['client']].unlink()
                self.assertEqual(service.scheduler_work_order(second['id'],second['revision']),second)
                service._commercial_sources.ignore_owner(owner)
                with self.assertRaises(ValidationError):
                    service.scheduler_work_order(second['id'],second['revision'])
            finally:
                service.close()

    def test_saved_unfiled_order_is_available_until_its_owner_is_filed(self):
        with tempfile.TemporaryDirectory() as folder:
            store=Store(Path(folder)/'state.sqlite3')
            certs=CertificationProjects(CertificationService(store))
            service=ProjectLibrary(store,certifications=certs)
            try:
                commercial=service.commercial=CommercialDocuments(certs)
                workspace=certs.new()['workspace_id']
                quote=commercial.save(workspace,{'kind':'quote','status':'Draft',
                    'fields':complete_quote(default_fields('quote',{'project_no':'PN-LOCAL'}))})
                issued=commercial.issue(workspace,quote['id'],quote['version'],str(uuid4()))['document']
                fields=default_fields('work_order',{'project_no':'PN-LOCAL','client':'Local client'})
                fields['order']['quote_id']=issued['id']
                order=commercial.save(workspace,{'kind':'work_order','status':'Draft','fields':fields},unfiled_context={})
                only,=service.scheduler_work_orders(0)['orders']
                self.assertTrue(only['source_id'].startswith('local-'))
                self.assertEqual(only['document_id'],order['id'])
                self.assertEqual(service.scheduler_work_order(only['id'],only['revision']),only)
                interrupted = Path(folder)/'interrupted.cf.json'
                interrupted.write_bytes(b'Unexpected content after interrupted file publication')
                digest = '1'*64
                commercial.unfiled.prepare_publication(workspace,interrupted,digest,'2'*64)
                with self.assertRaisesRegex(ValidationError,'cannot be verified'):
                    service.scheduler_work_order(only['id'],only['revision'])
                commercial.unfiled.cancel_publication(workspace,interrupted,digest)
                with commercial._connect() as db:
                    commercial.unfiled.bind_file(db,workspace)
                with self.assertRaises(ValidationError):
                    service.scheduler_work_order(only['id'],only['revision'])
            finally:
                service.close()
