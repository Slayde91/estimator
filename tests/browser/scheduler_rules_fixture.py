"""Active, Draft and Completed Work Orders in two projects sharing an address."""
import json
from pathlib import Path
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from estimator.project_file import export_project
from estimator.server import create_server
from estimator.storage import Store
from estimator.certification import CertificationService
from estimator.certification_projects import CertificationProjects
from estimator.commercial_documents import default_fields

directory = Path(sys.argv[1]).resolve()
directory.mkdir(parents=True, exist_ok=True)
store = Store(directory / 'state.sqlite3')
store.set_project_folder(directory)
certs = CertificationProjects(CertificationService(store))
for status in ('Accepted', 'Draft'):
    manifest = certs.capture({'workspace_id':certs.new()['workspace_id'], 'draft':None})
    fields = default_fields('work_order', {'project_no':'PN-02', 'client':'Client','site_address':'12 Site Street'})
    fields['order']['work_order_reference'] = 'WO-02'
    doc = {'id':str(uuid4()), 'kind':'work_order','status':'In progress','version':1,'reference':'WO-02','last_number':'',
           'created_at':'2026-11-01T00:00:00Z','updated_at':'2026-11-01T00:00:00Z','fields':fields}
    documents = [doc] if status == 'Draft' else [
        {**doc,'id':str(uuid4()),'status':stage,'reference':ref,
         'fields':{**fields,'order':{**fields['order'],'work_order_reference':ref}}}
        for stage, ref in [('Draft','WO-04'),('Completed','WO-03')]]
    payload = export_project(store, {'project_status':status, 'estimate':{'title':status+' project','client':'Client',
        'project_no':'PN-02','site_address':'12 Site Street'}, 'certifications':manifest,
        'commercial_documents':{'version':1,'project_id':manifest['project_id'],'documents':documents,
                                'number_counters':{'quote':0,'work_order':0,'purchase_order':0}}})
    (directory / (status + '.cf.json')).write_bytes(payload)
server = create_server(0, store.path, library_directory=directory / 'reference-library')
print(json.dumps({'port': server.server_port}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
