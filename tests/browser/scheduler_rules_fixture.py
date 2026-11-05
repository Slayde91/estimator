"""Disposable Accepted/Draft project choices for Scheduler rule acceptance."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from estimator.project_file import export_project
from estimator.server import create_server
from estimator.storage import Store

directory = Path(sys.argv[1]).resolve()
directory.mkdir(parents=True, exist_ok=True)
store = Store(directory / 'state.sqlite3')
store.set_project_folder(directory)
for status in ('Accepted', 'Draft'):
    payload = export_project(store, {'project_status': status, 'estimate': {
        'title': status + ' project', 'site_address': '12 Site Street' if status == 'Accepted' else '99 Draft Street'}})
    (directory / (status + '.cf.json')).write_bytes(payload)
server = create_server(0, store.path, library_directory=directory / 'reference-library')
print(json.dumps({'port': server.server_port}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
