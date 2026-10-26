"""Disposable Technical Library Document server and artifact inspector."""
import argparse
from contextlib import closing
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import sys
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]


def database_snapshot(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
        connection.execute('PRAGMA query_only=ON')
        return {name: sorted(json.dumps(row, default=lambda value: value.hex()) for row in connection.execute('SELECT * FROM "' + name.replace('"', '""') + '"'))
                for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")}


def inspect(pdf, xlsx):
    from openpyxl import load_workbook
    from pypdf import PdfReader
    from technical_item_fixture_data import REPORT_URL
    reader = PdfReader(str(pdf))
    text = '\n'.join(page.extract_text() for page in reader.pages)
    uris = [annotation.get_object()['/A']['/URI'] for page in reader.pages for annotation in page.get('/Annots', []) if '/A' in annotation.get_object() and '/URI' in annotation.get_object()['/A']]
    workbook = load_workbook(xlsx, data_only=False)
    cells = [cell for sheet in workbook for row in sheet for cell in row]
    links = [(cell.value, cell.hyperlink.target) for cell in cells if cell.hyperlink]
    with ZipFile(xlsx) as archive:
        xml = '\n'.join(archive.read(name).decode('utf-8') for name in archive.namelist()
                        if name.endswith(('.xml', '.rels')))
    private = ('Related firestopping records', 'Related Records', 'Source information', 'Source Information',
               'pkb-001', 'A source relationship does not establish suitability.',
               'Synthetic evidence only; retain every source condition.', 'Synthetic retained source diagram',
               'diagram-a.png')
    checks = {
        'pdf_source_image': any(image.image.size == (640, 360) for page in reader.pages for image in page.images),
        'pdf_report_hyperlink': uris == [REPORT_URL],
        'pdf_display_metadata_removed': 'Item ID:' not in text and 'Source SHA256:' not in text,
        'xlsx_display_metadata_removed': not any(cell.value in {'Id', 'Title', 'Subtitle'} for row in workbook['Item Details'] for cell in row) and not any(cell.value in {'Filename', 'Source SHA256', 'diagram-a.png'} for cell in cells),
        'pdf_source_conditions': 'Retain original conditions.' in text,
        'pdf_source_table': 'Copper pipe 25 mm' in text,
        'xlsx_report_hyperlink': links == [('SYN-123', REPORT_URL)],
        'xlsx_source_image': len(workbook['Source Diagrams']._images) == 1,
        'xlsx_literal_text': any(cell.value == '=Literal source text' and cell.data_type == 's' for cell in cells),
        'xlsx_no_formulas': all(cell.data_type != 'f' for cell in cells),
        'xlsx_source_table': any(cell.value == 'Copper pipe 25 mm' for cell in cells),
        'pdf_source_metadata_omitted': all(value not in text + str(reader.metadata) for value in private),
        'xlsx_source_metadata_omitted': all(value not in xml for value in private),
    }
    assert all(checks.values()), checks
    return {'passed': True, 'checks': checks, 'pdf_pages': len(reader.pages), 'pdf': str(pdf), 'xlsx': str(xlsx),
            'pdf_sha256': sha256(pdf.read_bytes()).hexdigest(), 'xlsx_sha256': sha256(xlsx.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--snapshot-database', type=Path)
    parser.add_argument('--inspect', nargs=2, type=Path)
    args = parser.parse_args()
    if args.snapshot_database:
        print(json.dumps(database_snapshot(args.snapshot_database)))
        return
    if args.inspect:
        print(json.dumps(inspect(*args.inspect)))
        return
    from technical_item_fixture_data import technical_library
    from estimator.server import create_server
    from estimator.storage import Store
    from estimator.native_dialogs import SaveSelection
    from estimator.project_library import file_fingerprint
    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    library = folder / 'reference-library'
    technical_library(library)
    project = folder / 'project.cf.json'
    store = Store(folder / 'qa.sqlite3')

    class Dialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), file_fingerprint(project))
        def choose_folder(self, initial_directory):
            return str(folder)

    server = create_server(0, store.path, project_dialogs=Dialogs(), library_directory=library)
    print(json.dumps({'port': server.server_port, 'directory': str(folder), 'project': str(project), 'database': str(store.path), 'library': str(library)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
