"""Disposable standard-edition server with deterministic native file choices."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from estimator.catalog import baseline
from estimator.native_dialogs import SaveSelection
from estimator.project_file import export_project
from estimator.project_library import file_fingerprint
from estimator.server import create_server
from estimator.storage import Store


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    folder = parser.parse_args().directory.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    project_folder = folder / 'projects'
    project_folder.mkdir(exist_ok=True)
    legacy_path = project_folder / 'legacy-v1.cf.json'
    saved_path = project_folder / 'standard-project.cf.json'
    # Keep the intentionally incompatible file outside the linked catalog so
    # the save-as overwrite check is reached after automatic-number validation.
    protected_path = folder / 'protected-v2.cf.json'
    store = Store(folder / 'qa.sqlite3')
    rate = baseline()['rate_groups']['sprays'][1]['id']
    store.save_configuration({'rates': {rate: {'price': 987.65}}})
    legacy = export_project(store, {'estimate': {'project_no': 'STANDARD-FIXTURE',
                            'client': 'Synthetic acceptance', 'site_address': '1 Synthetic Standard Street',
                            'contact_name': 'Synthetic Standard Contact', 'contact_phone': '0400 000 001',
                            'contact_email': 'standard@example.test', 'measurements': 'Frozen legacy project'},
                            'calculators': {}}, edition='standard')
    legacy_path.write_bytes(legacy)
    protected = json.loads(legacy)
    protected.update(version=2, takeoffs={'evidence': 'Must remain untouched'})
    protected_path.write_text(json.dumps(protected), encoding='utf-8')
    store.save_configuration({'rates': {rate: {'price': 123.45}}})
    control = folder / 'dialog-mode.json'
    control.write_text('{}', encoding='utf-8')

    class Dialogs:
        def mode(self):
            return json.loads(control.read_text(encoding='utf-8'))
        def choose_open(self, initial_directory):
            return str({'saved': saved_path, 'takeoffs': protected_path}.get(self.mode().get('open'), legacy_path))
        def choose_save(self, initial_directory, filename):
            target = protected_path if self.mode().get('save') == 'takeoffs' else saved_path
            return SaveSelection(str(target), file_fingerprint(target))
        def choose_folder(self, initial_directory):
            return str(project_folder)

    server = create_server(0, store.path, project_dialogs=Dialogs(),
                           library_directory=folder / 'reference-library', edition='standard')
    print(json.dumps({'port': server.server_port, 'directory': str(folder),
                      'legacy': str(legacy_path), 'saved': str(saved_path), 'protected': str(protected_path)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
