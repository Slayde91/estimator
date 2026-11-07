from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.certification import CertificationService, FIELDS
from estimator.certification_projects import CertificationProjects
from estimator.commercial_documents import CommercialDocuments, default_fields
from estimator.company_settings import DEFAULTS
from estimator.document_numbers import migrate_saved_orders
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from estimator.swms import SwmsDocuments, default_fields as swms_fields


def uid():
    return str(uuid.uuid4())


class DocumentNumberingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root/'app.sqlite3')
        self.certs = CertificationProjects(CertificationService(self.store))
        self.numbers = self.certs.numbering
        self.commercial = CommercialDocuments(self.certs)
        self.swms = SwmsDocuments(self.certs)
        self.workspace = self.certs.new()['workspace_id']

    def configure(self, **changes):
        settings = {k:{'prefix':v['prefix'],'start_number':v['start_number']} for k,v in self.numbers.settings().items()}
        for kind,(prefix, start) in changes.items():
            settings[kind] = {'prefix':prefix, 'start_number':start}
        return self.numbers.save_settings(settings)

    def order(self, kind, workspace=None, quote=None):
        fields = default_fields(kind, {'project_no':'PN-00001'})
        fields['terms'] = ''
        if quote:
            fields['order']['quote_id'] = quote['id']
        return self.commercial.save(workspace or self.workspace, {'id':uid(), 'kind':kind,'status':'Draft','version':0,'fields':fields})

    def issue(self, row):
        return self.commercial.issue(self.workspace, row['id'], row['version'], uid())

    def test_configured_independent_numbers_retries_and_portable_certification(self):
        self.configure(quote=('qt',41), work_order=('job',7), purchase_order=('buy',8), swms=('safe',9), certification=('inst',10))
        q = self.order('quote')
        self.assertEqual(q['last_number'], '')
        with patch.object(self.commercial,'renderer',side_effect=ValueError('unavailable')):
            with self.assertRaises(ValueError):
                self.issue(q)
        receipt = self.issue(q)
        q = receipt['document']
        self.assertEqual(q['last_number'], 'QT-000041')
        with ThreadPoolExecutor(max_workers=3) as pool:
            orders = list(pool.map(lambda _:self.order('work_order', quote=q),range(3)))
        self.assertEqual({o['reference'] for o in orders},{'JOB-07','JOB-08','JOB-09'})
        wo = orders[0]
        self.assertEqual(wo['fields']['order']['quote_reference'],'QT-000041')
        self.assertEqual(self.issue(wo)['number'],wo['reference'])
        po = self.order('purchase_order')
        first = self.issue(po); second = self.issue(first['document'])
        self.assertEqual((po['reference'], first['number'],second['number']),('BUY-08','BUY-08','BUY-08'))
        self.assertNotEqual(first['filename'],second['filename'])
        self.assertIn('BUY-08',PdfReader(BytesIO(second['pdf'])).pages[0].extract_text())
        p = {'id':uid(),'version':0, 'status':'Draft', 'fields':swms_fields()}
        swms = self.swms.save(self.workspace,p)
        self.assertEqual(swms['reference'],'SAFE-09')
        self.assertEqual(self.swms.save(self.workspace,p),swms)
        data = self.swms.issue(self.workspace,swms['id'],1,uid())
        self.assertIn('SAFE-09',' '.join(page.extract_text() for page in PdfReader(BytesIO(data['pdf'])).pages))
        service = self.certs.service(self.workspace)
        values = {key:'Example' for key in FIELDS}
        request = uid()
        cert = service.create(values,request)
        self.assertEqual(cert['reference'],'INST-10')
        self.assertEqual(service.create(values,request)['reference'],'INST-10')
        rev = service.generate(cert['id'], values, cert['version'], uid(), DEFAULTS)
        self.assertIn('INST-10', PdfReader(BytesIO(service.revision_pdf(cert['id'],rev['revision']['revision']))).pages[0].extract_text())
        archive = self.certs.capture({'workspace_id':self.workspace,'draft':None})
        self.assertEqual(self.certs.restore(archive)['items'][0]['reference'],'INST-10')
        self.configure(work_order=('other',1),purchase_order=('buy',1))
        self.assertEqual(self.order('work_order',quote=q)['reference'],'OTHER-01')
        self.assertEqual(self.order('purchase_order')['reference'],'BUY-09')
        self.configure(work_order=('job',1))
        self.assertEqual(self.order('work_order',quote=q)['reference'],'JOB-10')
        self.assertEqual(self.issue(q)['number'],'QT-000042')

    def test_folder_migration_is_repeatable_preserves_content_and_updates_linked_po(self):
        folder = self.root / 'projects'; folder.mkdir()
        self.store.set_project_folder(folder)
        library = ProjectLibrary(self.store, certifications=self.certs)
        self.addCleanup(library.close)
        library.commercial = self.commercial
        files = []
        for index in range(2):
            ws = self.certs.new()['workspace_id']
            pid = self.certs.project_id(ws)
            date = f'2026-01-0{index+1}T00:00:00+00:00'
            base = {'version':1,'status':'Draft','created_at':date,'updated_at':date,'last_number':''}
            details = {'project_no':f'PN-0000{index+1}'}
            q = {**base,'id':uid(),'kind':'quote','fields':default_fields('quote',details),'last_number':f'Q-00000{index+1}'}
            wo = {**base,'id':uid(),'kind':'work_order','fields':default_fields('work_order',details)}
            old = f"PN{index+1}Q{index+1}-01"
            wo['fields']['order'].update(quote_id=q['id'],quote_reference=q['last_number'],work_order_reference=old)
            po = {**base,'id':uid(),'kind':'purchase_order','fields':default_fields('purchase_order',details)}
            po['fields']['order'].update(work_order_id=wo['id'],work_order_reference=old)
            manifest=self.certs.capture({'workspace_id':ws,'draft':None})
            path = folder/f'project-{index}.cf.json'
            self.certs.publish(manifest, path)
            path.write_bytes(export_project(self.store,{'estimate':{'title':'Migration fixture',**details},'certifications':manifest,
                'commercial_documents':{'version':1,'project_id':pid,'number_counters':{'quote':2,'work_order':0,'purchase_order':0},'documents':[q,wo,po]}}))
            files.append((path,json.loads(path.read_bytes()),wo['id']))
        historical = folder/'issued.pdf'; historical.write_bytes(b'%PDF-immutable test content')
        result = migrate_saved_orders(library)
        while result['scan_pending']:
            result = migrate_saved_orders(library)
        self.assertEqual((result['updated_files'], result['updated_orders'],result['errors']),(2,4,[]))
        for index,(path,previous,wo_id) in enumerate(files,1):
            new = json.loads(path.read_bytes())
            expected = deepcopy(previous)
            for doc in expected['commercial_documents']['documents']:
                if doc['kind'] == 'quote':
                    continue
                doc['reference'] = ('WO' if doc['kind']=='work_order' else 'PO') + f'-{index:02}'
                doc['fields']['order']['work_order_reference'] = f'WO-{index:02}'
                if doc['kind']=='purchase_order':
                    self.assertEqual(doc['fields']['order']['work_order_id'],wo_id)
            self.assertEqual(new, expected)
        self.assertEqual(migrate_saved_orders(library)['updated_files'],0)
        self.assertEqual(historical.read_bytes(),b'%PDF-immutable test content')
        self.assertEqual(self.issue(self.order('quote'))['number'], 'Q-000003')
