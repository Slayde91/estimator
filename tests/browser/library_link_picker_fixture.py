"""Synthetic library picker server; every writable path is disposable."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--filter-groups', action='store_true')
    args = parser.parse_args()
    from test_firestopping_library import editable_library
    from estimator.server import create_server

    folder = args.directory.resolve()
    allowed = (ROOT / '.runtime' / 'browser-qa').resolve()
    if allowed not in folder.parents or folder.exists():
        raise ValueError('A new disposable QA directory is required')
    folder.mkdir(parents=True)
    library = folder / 'reference-library'
    data = editable_library(library, complete_entries=True)
    keys = [('report', 'Report'), ('substrate', 'Substrate'), ('orientation', 'Orientation'),
            ('manufacturer', 'Manufacturer'), ('category', 'Category'), ('services', 'Services'), ('frl', 'FRL')]
    data['libraries']['technical']['filters'] = [{'key': key, 'label': label} for key, label in keys]
    records = []
    for index in range(1, 46):
        primary = index <= 40
        records.append({
            'id': f'technical-{index:03d}', 'title': f'Synthetic reference {index:03d}',
            'summary': 'Synthetic & / reference; no actual passive-fire applicability.',
            'fields': [{'label': 'Service', 'value': 'Copper pipe' if primary else 'Power cables'},
                       {'label': 'System Products', 'value': 'FIREFLYBatt' if primary else 'Sealant'},
                       {'label': 'Barrier Construction', 'value': 'Concrete wall' if primary else 'Concrete floor'},
                       {'label': 'FRL', 'value': '-/120/120' if primary else '-/60/60'}],
            'filter_values': {'report': ['Synthetic report & / fixture' if primary else 'Alternate report'],
                              'manufacturer': ['Synthetic manufacturer' if primary else 'Alternate manufacturer'],
                              'orientation': ['Vertical' if primary else 'Horizontal']}})
    data['libraries']['technical']['items'] = records
    if args.filter_groups:
        # This mode exercises the installed document key and native grouped
        # controls with invented brands/reports/IDs only. Default link fixtures
        # retain their existing 45-record query and pagination contract.
        data['libraries']['technical']['filters'][0]['key'] = 'document'
        for index, item in enumerate(records):
            manufacturer = ('Promat', 'Trafalgar', 'BOSS', 'Firefly')[index % 4]
            identity = str(index + 1) if index == 0 else 'sys_var_2_au' if index == 1 else f'synthetic-source-{index + 1}'
            item['fields'].extend([{'label': 'Manufacturer', 'value': manufacturer},
                                   {'label': 'ID', 'value': identity}])
            item['filter_values'].pop('report')
            item['filter_values']['document'] = [f'{manufacturer} synthetic report']
            item['filter_values']['manufacturer'] = [manufacturer]
            rating = ('-/30/30', '-/60/60', '-/90/60', '-/120/30',
                      '-/180/120', '-/240/180', '-/300/180')[index % 7]
            next(field for field in item['fields'] if field['label'] == 'FRL')['value'] = rating
    data['links'] = []
    # This original, immutable JSON is deliberately distinct from the saved
    # overlay where explicit reference links belong.
    (library / 'library.json').write_text(json.dumps(deepcopy(data)), encoding='utf-8')
    server = create_server(0, folder / 'qa.sqlite3', library_directory=library)
    if server.server_port == 8765:
        raise ValueError('Live application port is forbidden')
    print(json.dumps({'port': server.server_port, 'directory': str(folder), 'library': str(library),
                      'item_id': data['libraries']['penetration']['items'][0]['id']}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
