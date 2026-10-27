"""Synthetic existing-report facet server; never opens the installed library."""
import argparse
from contextlib import closing
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
REPORT = '148393'
REPORT_URL = 'https://media.promat.com/synthetic-browser/report-148393.pdf'
PLACEHOLDERS = ('', 'N/A', 'unknown', 'not recorded', 'not supplied', '...')


def owned_folder(value):
    folder = value.resolve()
    if (ROOT / '.runtime' / 'browser-qa').resolve() not in folder.parents:
        raise ValueError('Only a disposable browser-QA subdirectory is allowed')
    return folder


def state_snapshot(folder):
    folder = owned_folder(folder)
    database = folder / 'qa.sqlite3'
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
        connection.execute('PRAGMA query_only=ON')
        rows = {name: sorted(json.dumps(row, default=lambda value: value.hex())
                             for row in connection.execute('SELECT * FROM "' + name.replace('"', '""') + '"'))
                for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")}
    library = folder / 'reference-library'
    return {'database_rows': rows, 'database_sha256': sha256(database.read_bytes()).hexdigest(),
            'library_files': {str(path.relative_to(library)).replace('\\', '/'):
                              sha256(path.read_bytes()).hexdigest()
                              for path in sorted(library.rglob('*')) if path.is_file()},
            'project_files': {path.name: sha256(path.read_bytes()).hexdigest()
                              for path in sorted(folder.glob('*.cf.json'))}}


def make_library(directory):
    from test_firestopping_library import editable_library
    data = editable_library(directory, complete_entries=True)
    template = deepcopy(data['libraries']['technical']['items'][0])

    def entry(key, *, report=REPORT, manufacturer='Promat', assignment=None, linked=True):
        item = deepcopy(template)
        item.update(id=key, title=f'{manufacturer} synthetic report 148393 fixture {key}',
                    subtitle='Synthetic metadata acceptance only',
                    summary='Synthetic report 148393 mention; not a tested installation or performance claim.',
                    fields=[{'label': 'Manufacturer', 'value': manufacturer},
                            {'label': 'System Products', 'value': 'Synthetic fixture product'},
                            {'label': 'Barrier Construction', 'value': 'Concrete wall'},
                            {'label': 'Installation Details', 'value': 'Retain this synthetic source condition.'},
                            {'label': 'Report Number', 'value': report}],
                    filter_values={'manufacturer': [manufacturer], 'document': assignment or []})
        if linked:
            item['fields'][-1]['report_links'] = [{'label': report, 'url': REPORT_URL}]
        return item

    missing_ids = [f'promat-fixture-missing-{number:02d}' for number in range(1, 18)]
    items = [entry(key) for key in missing_ids]
    assigned_id = 'promat-fixture-already-assigned'
    items.append(entry(assigned_id, assignment=[REPORT]))
    preserved_id = 'promat-fixture-preserved-other-facet'
    items.append(entry(preserved_id, assignment=['SYN-KEEP Rev A']))
    foreign_id = 'synthetic-other-manufacturer'
    items.append(entry(foreign_id, manufacturer='Other manufacturer'))
    placeholder_ids = []
    for number, value in enumerate(PLACEHOLDERS):
        key = f'promat-fixture-placeholder-{number}'
        items.append(entry(key, report=value, linked=False))
        placeholder_ids.append(key)
    data['libraries']['technical']['filters'] = [
        {'key': key, 'label': label} for key, label in (
            ('document', 'Report'), ('manufacturer', 'Manufacturer'),
            ('orientation', 'Orientation'), ('services', 'Services'), ('frl', 'FRL'))]
    data['libraries']['technical']['items'] = items
    data['links'] = []
    (directory / 'library.json').write_text(json.dumps(data), encoding='utf-8')
    return {'missing_ids': missing_ids, 'assigned_id': assigned_id,
            'preserved_id': preserved_id, 'foreign_id': foreign_id,
            'placeholder_ids': placeholder_ids, 'raw_count': len(items),
            'report': REPORT, 'report_url': REPORT_URL,
            'penetration_id': data['libraries']['penetration']['items'][0]['id']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--snapshot', action='store_true')
    args = parser.parse_args()
    folder = owned_folder(args.directory)
    if args.snapshot:
        print(json.dumps(state_snapshot(folder)))
        return
    if folder.exists():
        raise ValueError('A new disposable fixture directory is required')
    folder.mkdir(parents=True)
    library = folder / 'reference-library'
    metadata = make_library(library)
    from estimator.server import create_server
    server = create_server(0, folder / 'qa.sqlite3', library_directory=library)
    if server.server_port == 8765:
        raise ValueError('The live application port is forbidden')
    print(json.dumps({'port': server.server_port, 'directory': str(folder),
                      'library': str(library), **metadata}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
