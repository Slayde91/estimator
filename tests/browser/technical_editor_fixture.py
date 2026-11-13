"""Disposable Technical editor source/overlay server; never uses live stores."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    folder = args.directory.resolve()
    assert ROOT / '.runtime' / 'browser-qa' in folder.parents
    folder.mkdir(parents=True, exist_ok=True)
    from technical_item_fixture_data import technical_library
    from feature_server import create_server
    from estimator.storage import Store
    from estimator.technical_library_edits import ManualTechnicalLibrary, FACETS

    library = folder / 'reference-library'
    data = technical_library(library)
    technical = data['libraries']['technical']
    technical['filters'] = [{'key': key, 'label': label} for key, label in FACETS]
    record = technical['items'][0]
    record['title'] = 'Technical editor retained multivalue fixture'
    record['filter_values'].update(manufacturer=['QA Manufacturer'],
        substrate=['Concrete/masonry wall', 'Plasterboard wall'],
        orientation=['Vertical', 'Horizontal'], type=['Core Hole', 'Blank Seal'],
        category=['Plumbing & Hydraulic', 'Electrical'],
        services=['Copper Pipes', 'Retained legacy QA value'], frl=['-/120/120', '-/90/90'])
    record['fields'].extend([
        {'label': 'Additional description', 'value': ''},
        {'label': 'Loaded long description', 'value': 'Existing retained source text. ' * 100},
    ])
    source = library / 'library.json'
    source.write_text(json.dumps(data), encoding='utf-8')
    store = Store(folder / 'qa.sqlite3')
    context = ManualTechnicalLibrary(library, store).technical_edit(record['id'])
    server = create_server(0, store.path, library_directory=library)
    print(json.dumps({'port': server.server_port, 'directory': str(folder),
        'database': str(store.path), 'library': str(library), 'id': record['id'],
        'initial_facets': context['record']['filter_values'],
        'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest()}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
