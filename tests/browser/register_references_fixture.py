"""Disposable source-linked references; no installed/private catalog required."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]

from test_firestopping_library import editable_library
from estimator.server import create_server


def make_library(directory):
    data = editable_library(directory, complete_entries=True)
    original = data['libraries']['technical']['items'][0]
    items = []
    for index in range(103):
        item = deepcopy(original)
        item.update(id=f'synthetic-{index:03d}', title=f'Synthetic configuration {index}',
                    fields=[{'label': 'Manufacturer', 'value': 'Alpha' if index < 101 else 'Zulu'},
                            {'label': 'Service', 'value': 'Conduits'},
                            {'label': 'Report Number', 'value': f'SYN-{index:03d} Rev A\nPrivate report',
                             'report_links': [{'label': f'SYN-{index:03d} Rev A', 'url': 'https://tfire.com.au/documents/synthetic-report.pdf'}]},
                            {'label': 'Installation Details', 'value': f'Synthetic configuration {index}; no suitability claim.'}],
                    filter_values={})
        items.append(item)
    data['libraries']['technical']['items'] = items
    data['links'] = [{'penetration_id': 'pkb-001', 'technical_id': item['id'],
                     'relationship': 'Explicit synthetic relationship; review configuration.'} for item in items[:102]]
    (directory / 'library.json').write_text(json.dumps(data), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve(); folder.mkdir(parents=True, exist_ok=True)
    source = folder / 'library'; make_library(source)
    server = create_server(0, folder / 'qa.sqlite3', library_directory=source)
    print(json.dumps({'port': server.server_port, 'directory': str(folder), 'library': str(source)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
