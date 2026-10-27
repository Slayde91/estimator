"""Synthetic family-policy acceptance server; no installed library is opened."""
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
FAMILIES = ('FyreSHIELD', 'FyreSHIELD PLUS', 'FyreSHIELD - Screw Fixed',
            'FyreSHIELD PLUS - Screw Fixed')
REMOVED_IDS = [f'trafalgar-selector-{number}' for number in range(5413, 5417)]
REPORT = 'FAS200221 R3.0'
REPORT_URL = 'https://tfire.com.au/documents/FyreSHIELD-Range-Test-Report'


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
        tables = {name: sorted(json.dumps(row, default=lambda value: value.hex())
                              for row in connection.execute('SELECT * FROM "' + name.replace('"', '""') + '"'))
                  for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")}
    library = folder / 'reference-library'
    files = {str(path.relative_to(library)).replace('\\', '/'):
             sha256(path.read_bytes()).hexdigest()
             for path in sorted(library.rglob('*')) if path.is_file()}
    projects = {path.name: sha256(path.read_bytes()).hexdigest()
                for path in sorted(folder.glob('*.cf.json'))}
    raw = json.loads((library / 'library.json').read_text(encoding='utf-8'))
    return {'database_rows': tables, 'library_files': files, 'project_files': projects,
            'raw_record_ids': [item['id'] for item in raw['libraries']['technical']['items']]}


def make_library(directory):
    from test_firestopping_library import editable_library
    data = editable_library(directory, complete_entries=True)
    source = deepcopy(data['libraries']['technical']['items'][0])
    items, family_ids = [], {}

    def entry(key, product, *, report=None):
        item = deepcopy(source)
        item.update(id=key, title=f'Trafalgar — {product} synthetic variant',
                    subtitle='Synthetic browser policy check',
                    summary='Synthetic metadata only; no tested installation or performance is asserted.',
                    fields=[{'label': 'ID', 'value': key.removeprefix('trafalgar-selector-')},
                            {'label': 'Manufacturer', 'value': 'Trafalgar'},
                            {'label': 'System Recommendation', 'value': product},
                            {'label': 'Separating Element', 'value': 'Concrete wall'},
                            {'label': 'FRL', 'value': '-/120/120'},
                            {'label': 'Installation Details', 'value': 'Synthetic QA fixture; preserve this source condition.'}],
                    filter_values={'manufacturer': ['Trafalgar']})
        if report:
            item['fields'].append({'label': 'Report Number', 'value': report})
            item['filter_values']['document'] = [report]
        return item

    for family_number, product in enumerate(FAMILIES):
        family_ids[product] = []
        for variant in range(15):
            # Invented IDs deliberately prove that policy follows product fields,
            # rather than a hardcoded list of installed supplier record IDs.
            key = f'trafalgar-selector-{8001 + family_number * 15 + variant}'
            item = entry(key, product)
            item['summary'] += f' Fixture family {family_number + 1}, variant {variant + 1}.'
            items.append(item)
            family_ids[product].append(key)
    for number, key in enumerate(REMOVED_IDS):
        items.append(entry(key, 'FRSS' if number < 2 else 'FRSS-Screw fixed'))
    control_id = 'trafalgar-selector-8999'
    items.append(entry(control_id, 'FyreBOARD Maxilite', report='SYN-UNCHANGED Rev A'))
    accessory_id = 'trafalgar-selector-8998'
    items.append(entry(accessory_id, 'FyreSHIELD compatible accessory', report='SYN-ACCESSORY Rev A'))
    foreign_id = 'synthetic-foreign-fyreshield'
    foreign = entry(foreign_id, 'FyreSHIELD', report='SYN-FOREIGN Rev A')
    foreign['title'] = 'Other manufacturer synthetic FyreSHIELD'
    next(field for field in foreign['fields'] if field['label'] == 'Manufacturer')['value'] = 'Other manufacturer'
    foreign['filter_values']['manufacturer'] = ['Other manufacturer']
    items.append(foreign)
    data['libraries']['technical']['filters'] = [
        {'key': key, 'label': label} for key, label in (
            ('document', 'Report'), ('manufacturer', 'Manufacturer'),
            ('orientation', 'Orientation'), ('services', 'Services'), ('frl', 'FRL'))]
    data['libraries']['technical']['items'] = items
    data['links'] = []
    (directory / 'library.json').write_text(json.dumps(data), encoding='utf-8')
    return {'family_ids': family_ids, 'removed_ids': REMOVED_IDS,
            'controls': {control_id: 'SYN-UNCHANGED Rev A', accessory_id: 'SYN-ACCESSORY Rev A',
                         foreign_id: 'SYN-FOREIGN Rev A'},
            'raw_count': len(items), 'public_count': len(items) - len(REMOVED_IDS),
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
