"""Export explicit private factory content to a folder outside the repository."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from estimator.catalog import validate_configuration
from estimator.desktop_seed_content import encoded, export_library_edits, validate_library_edits, empty_library_edits
from estimator.reference_library import ReferenceLibrary
from estimator.firestopping_library import empty_library


def regular_path(path, directory=False):
    path = Path(path)
    for component in (path, *path.parents):
        if component.is_symlink() or getattr(component.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Factory paths must not contain links or reparse points.')
    if (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise ValueError('Factory source is not a regular file or directory.')
    return path


def prepare(output, library=None, database=None):
    output = Path(output).absolute()
    ancestor = next(parent for parent in output.parents if parent.exists())
    regular_path(ancestor, directory=True)
    output = output.resolve()
    if output.is_relative_to(ROOT) or output.exists():
        raise ValueError('Use a new factory seed folder outside the source repository.')
    output.mkdir(parents=True)
    reference = output / 'reference-library'
    reference.mkdir()
    if library:
        library = regular_path(Path(library).absolute(), directory=True).resolve(strict=True)
        index = regular_path(library / 'library.json')
        if index.stat().st_size > 64 * 1024 * 1024:
            raise ValueError('Factory library index exceeds its size limit.')
        payload = index.read_bytes()
        if len(payload) > 64 * 1024 * 1024:
            raise ValueError('Factory library index exceeds its size limit.')
        data = json.loads(payload)
        ReferenceLibrary(library)._validate(data)
        # The original index, including required reviewed evidence, stays local.
        (reference / 'library.json').write_bytes(payload)
        for records, folder, default_extension in ((data['documents'], 'documents', '.pdf'), (data.get('images', []), 'images', None)):
            (reference / folder).mkdir()
            for record in records:
                name = record['id'] + (default_extension or record['extension'])
                source = regular_path(library / folder / name)
                target = reference / folder / name
                checksum = hashlib.sha256()
                with source.open('rb') as incoming, target.open('xb') as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        checksum.update(chunk)
                        outgoing.write(chunk)
                if checksum.hexdigest() != record['sha256']:
                    raise ValueError('A factory library source asset has changed.')
    else:
        (reference / 'library.json').write_text(encoded(empty_library()), encoding='utf-8')
    pricing = {'inventory': {}, 'rates': {}}
    edits = empty_library_edits()
    if database:
        database = regular_path(Path(database).absolute()).resolve(strict=True)
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            connection.execute('BEGIN')
            row = connection.execute('SELECT data FROM settings WHERE id=1').fetchone()
            pricing = json.loads(row[0]) if row else pricing
            edits = export_library_edits(connection)
    validate_configuration(pricing)
    validate_library_edits(edits, reference)
    (output / 'pricing.json').write_text(encoded(pricing), encoding='utf-8')
    (output / 'library-edits.json').write_text(encoded(edits), encoding='utf-8')
    files=[]
    for path in sorted(output.rglob('*')):
        if path.is_file():
            checksum=hashlib.sha256()
            with path.open('rb') as stream:
                while chunk:=stream.read(1024 * 1024): checksum.update(chunk)
            files.append({'path':path.relative_to(output).as_posix(),'size':path.stat().st_size,'sha256':checksum.hexdigest()})
    manifest={'schema_version':1,'files':files,'pricing':{'path':'pricing.json'},
        'library':{'path':'reference-library/library.json'},'library_edits':{'path':'library-edits.json'}}
    manifest['id']=hashlib.sha256(encoded(manifest).encode('utf-8')).hexdigest()
    (output/'manifest.json').write_text(encoded(manifest),encoding='utf-8')
    return {'id':manifest['id'],'files':len(files),'bytes':sum(f['size'] for f in files),
        'library_edit_rows':{k:len(v) for k,v in edits['tables'].items()}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--library',type=Path)
    parser.add_argument('--database',type=Path)
    args=parser.parse_args()
    if bool(args.library)!=bool(args.database):
        parser.error('Supply both --library and --database for a private seed, or neither for a public test seed.')
    print(json.dumps(prepare(args.output,args.library,args.database),indent=2))

if __name__=='__main__': main()
