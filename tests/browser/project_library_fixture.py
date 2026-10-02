"""Disposable project/library acceptance server; never uses live app storage."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]


def database_snapshot(path):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as connection:
        connection.execute('PRAGMA query_only=ON')
        records = {}
        for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            if name == 'app_preferences':
                continue  # Native Save As records its disposable project folder.
            rows = sorted(json.dumps(row, default=lambda value: value.hex()) for row in connection.execute('SELECT * FROM "' + name.replace('"', '""') + '"'))
            records[name] = {'rows': len(rows), 'sha256': hashlib.sha256(json.dumps(rows).encode()).hexdigest()}
        return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--snapshot-database', type=Path)
    args = parser.parse_args()
    if args.snapshot_database:
        print(json.dumps(database_snapshot(args.snapshot_database)))
        return
    from test_firestopping_library import editable_library
    from estimator.server import create_server
    from estimator.storage import Store
    from estimator.native_dialogs import SaveSelection
    from estimator.project_library import file_fingerprint
    from estimator.project_file import export_project
    from estimator.penetration_calculator import definition
    from fixtures import make_pdf

    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    library = folder / 'reference-library'
    library.mkdir()
    data = editable_library(library)
    store = Store(folder / 'qa.sqlite3')
    composer = definition()['defaults']
    composer['rows'][0]['inputs'].update(T='Unscheduled composer retained', O=3)
    project = folder / 'project.json'
    seed = folder / 'seed.json'
    seed.write_bytes(export_project(store, {'estimate': {'project_no': 'PROJECT-LIBRARY-QA', 'client': 'Synthetic client', 'measurements': 'Quote notes retained'}, 'calculators': {}, 'penetration': {'composer': composer, 'draft': {'globals': {}, 'rows': []}}}))
    fixture = folder / 'drawing.pdf'
    make_pdf(fixture)
    control = folder / 'dialog-mode.json'
    control.write_text('{}')

    class Dialogs:
        def mode(self):
            return json.loads(control.read_text())
        def choose_save(self, initial_directory, filename):
            if self.mode().get('cancel'):
                return None
            return SaveSelection(str(project), file_fingerprint(project))
        def choose_open(self, initial_directory):
            return str(seed if self.mode().get('seed') else project)
        def choose_folder(self, initial_directory):
            return str(folder)

    server = create_server(0, store.path, project_dialogs=Dialogs(), library_directory=library)
    print(json.dumps({'port': server.server_port, 'directory': str(folder), 'project': str(project), 'seed': str(seed), 'database': str(store.path), 'fixture': str(fixture), 'item_id': data['libraries']['penetration']['items'][0]['id'], 'diagram': str(library / 'images/diagram-a.png')}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
