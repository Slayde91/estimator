"""Disposable full/standard SWMS browser server; no user files are touched."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from estimator.native_dialogs import SaveSelection
from estimator.project_library import file_fingerprint

parser = argparse.ArgumentParser()
parser.add_argument('--directory', required=True)
parser.add_argument('--edition', choices=['full', 'standard'], required=True)
parser.add_argument('--real-auth', action='store_true')
args = parser.parse_args()
if args.real_auth:
    from estimator.server import create_server
else:
    from feature_server import create_server
directory = Path(args.directory).resolve(); directory.mkdir(parents=True, exist_ok=True)
project = directory / 'swms-project.cf.json'

class Dialogs:
    def choose_save(self, initial_directory, filename):
        return SaveSelection(str(project), file_fingerprint(project))
    def choose_open(self, initial_directory):
        return str(project)
    def choose_folder(self, initial_directory):
        return str(directory)

server = create_server(0, directory / 'state.sqlite3', project_dialogs=Dialogs(), edition=args.edition)
print(json.dumps({'port': server.server_port, 'project': str(project)}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
