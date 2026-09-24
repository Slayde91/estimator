"""Install a reviewed local reference bundle without publishing supplier files.

Usage: python scripts/install_reference_library.py BUNDLE_DIRECTORY
Add --destination PATH for an isolated test installation. --replace retains a
timestamped backup of an existing library. The original XLSB/PDFs are not edited.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from estimator.reference_library import ReferenceLibrary


def install(source, destination, replace=False):
    source, destination = Path(source).resolve(), Path(destination).absolute()
    if source == destination.resolve() or source.is_relative_to(destination.resolve()) or destination.resolve().is_relative_to(source):
        raise ValueError('Choose separate source and destination folders.')
    if destination.exists() and not replace:
        raise ValueError('A library is already installed. Use --replace to retain a backup and install another reviewed bundle.')
    library = ReferenceLibrary(source)
    data = library._load()
    if data is None:
        raise ValueError('The bundle does not contain library.json.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # tempfile.mkdtemp creates an owner-only directory on Windows. Renaming
    # that directory into place can leave the desktop server account unable to
    # read the installed library. A normal mkdir inherits the destination
    # parent's access rules; the random name still isolates this operation.
    stage = destination.parent / f'.reference-library-{uuid.uuid4().hex}'
    stage.mkdir()
    backup = None
    try:
        (stage / 'documents').mkdir()
        (stage / 'images').mkdir()
        for asset in data['_assets'].values():
            content, _, filename = library.asset(asset['id'], asset['pdf'])
            (stage / ('documents' if asset['pdf'] else 'images') / filename).write_bytes(content)
        public_data = {key: value for key, value in data.items() if not key.startswith('_')}
        (stage / 'library.json').write_text(json.dumps(public_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        staged = ReferenceLibrary(stage)
        summary = staged.overview()
        for asset in data['_assets'].values():
            staged.asset(asset['id'], asset['pdf'])
        if destination.exists():
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            backup = destination.with_name(destination.name + '-backup-' + stamp + '-' + uuid.uuid4().hex[:8])
            destination.rename(backup)
        try:
            stage.rename(destination)
        except OSError:
            if backup is not None and not destination.exists():
                backup.rename(destination)
            raise
        return {'installed': True, 'destination': str(destination), 'backup': str(backup) if backup else None,
                'libraries': summary['libraries'], 'assets': len(data['_assets'])}
    finally:
        # Only remove the unique staging directory this operation created.
        if stage.exists() and stage.parent.resolve() == destination.parent.resolve() and stage.name.startswith('.reference-library-'):
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--destination', type=Path, default=ROOT / '.runtime/reference-library')
    parser.add_argument('--replace', action='store_true')
    args = parser.parse_args()
    print(json.dumps(install(args.source, args.destination, args.replace)))


if __name__ == '__main__':
    main()
