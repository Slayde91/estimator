"""Disposable schedule reference library and project save/open targets."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
from test_firestopping_library import editable_library
from estimator.server import create_server
from estimator.native_dialogs import SaveSelection
from estimator.project_library import file_fingerprint

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve(); folder.mkdir(parents=True, exist_ok=True)
    library = folder / 'library'; data = editable_library(library, complete_entries=True)
    original = data['libraries']['technical']['items'][0]
    items = []
    for number in range(23):
        item = deepcopy(original)
        item.update(id=f'system-{number:02d}', title=f'Synthetic system {number:02d}',
                    subtitle='Synthetic report reference',
                    fields=[{'label': 'Manufacturer', 'value': 'Sample manufacturer'},
                            {'label': 'Service', 'value': 'Copper Pipes'},
                            {'label': 'Orientation', 'value': 'Vertical'},
                            {'label': 'Report Number', 'value': f'SYN-{number:02d} Rev A'},
                            {'label': 'Installation Details', 'value': 'Synthetic fixture; not a tested installation.'}],
                    filter_values={'orientation': ['Vertical'], 'services': ['Copper Pipes'], 'report': [f'SYN-{number:02d} Rev A']})
        items.append(item)
    data['libraries']['technical']['items'] = items
    data['libraries']['technical']['filters'].extend([{'key': 'orientation', 'label': 'Orientation'}, {'key': 'services', 'label': 'Service Type'}])
    data['links'] = [{'penetration_id': 'pkb-001', 'technical_id': item['id'], 'relationship': 'Synthetic test relationship.'} for item in items[:2]]
    (library / 'library.json').write_text(json.dumps(data), encoding='utf-8')
    project = folder / 'reference-project.cf.json'
    class Dialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), file_fingerprint(project))
        def choose_open(self, initial_directory):
            return str(project) if project.exists() else None
        def choose_folder(self, initial_directory):
            return str(folder)
    server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs(), library_directory=library)
    print(json.dumps({'port': server.server_port, 'library': str(library), 'project': str(project)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
