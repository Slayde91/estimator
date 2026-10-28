"""Install a reviewed local reference bundle without publishing supplier files.

Usage: python scripts/install_reference_library.py BUNDLE_DIRECTORY
Add --destination PATH for an isolated test installation. --replace retains a
timestamped backup of an existing library. The original XLSB/PDFs are not edited.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from estimator.reference_library import MAX_INDEX, ReferenceLibrary
from estimator.firefly_reference_review import (PLAN_NAME as REFERENCE_PLAN_NAME,
    MAX_PLAN_BYTES as MAX_REFERENCE_PLAN_BYTES, plan_stamp as reference_plan_stamp)
from estimator.firefly_technical_review import (PLAN_NAME as TECHNICAL_PLAN_NAME,
    MAX_PLAN_BYTES as MAX_TECHNICAL_PLAN_BYTES, REVIEW_KEY as TECHNICAL_REVIEW_KEY,
    plan_stamp as technical_plan_stamp)
from estimator.technical_service_review import (PLAN_NAME as SERVICES_PLAN_NAME,
    MAX_PLAN_BYTES as MAX_SERVICES_PLAN_BYTES, REVIEW_KEY as SERVICES_REVIEW_KEY,
    plan_stamp as services_plan_stamp)
from estimator.technical_variants import (PLAN_NAME as VARIANT_PLAN_NAME,
    MAX_PLAN_BYTES as MAX_VARIANT_PLAN_BYTES, REVIEW_KEY as VARIANT_REVIEW_KEY,
    plan_stamp as variant_plan_stamp)


def _index_snapshot(library, data, expected_stamp):
    path = library.directory / 'library.json'
    info = path.stat()
    if (info.st_mtime_ns, info.st_size, info.st_ctime_ns) != expected_stamp[:3]:
        raise ValueError('The source library index changed after validation.')
    with path.open('rb') as stream:
        payload = stream.read(MAX_INDEX + 1)
    if (len(payload) > MAX_INDEX
            or hashlib.sha256(payload).hexdigest() != data.get('_index_sha256')):
        raise ValueError('The source library index differs from its validated bytes.')
    after = path.stat()
    if (after.st_mtime_ns, after.st_size, after.st_ctime_ns) != expected_stamp[:3]:
        raise ValueError('The source library index changed while reading.')
    return payload


def _copy_reviews(library, data, stage, expected_stamp):
    reviews = (
        (REFERENCE_PLAN_NAME, MAX_REFERENCE_PLAN_BYTES, reference_plan_stamp, None),
        (TECHNICAL_PLAN_NAME, MAX_TECHNICAL_PLAN_BYTES, technical_plan_stamp, TECHNICAL_REVIEW_KEY),
        (SERVICES_PLAN_NAME, MAX_SERVICES_PLAN_BYTES, services_plan_stamp, SERVICES_REVIEW_KEY),
        (VARIANT_PLAN_NAME, MAX_VARIANT_PLAN_BYTES, variant_plan_stamp, VARIANT_REVIEW_KEY),
    )
    for position, (name, maximum, stamp_reader, capability_key) in enumerate(reviews, 3):
        stamp = expected_stamp[position]
        if stamp_reader(library.directory) != stamp:
            raise ValueError('A source library review changed after validation.')
        if stamp is None:
            continue
        path = library.directory / 'reviews' / name
        with path.open('rb') as stream:
            payload = stream.read(maximum + 1)
        if len(payload) > maximum or stamp_reader(library.directory) != stamp:
            raise ValueError('A source library review changed while reading.')
        if capability_key:
            capability = data.get(capability_key)
            canonical = json.dumps(json.loads(payload), sort_keys=True, separators=(',', ':'),
                                   ensure_ascii=False, allow_nan=False).encode('utf-8')
            if capability is None or hashlib.sha256(canonical).hexdigest() != capability.sha256:
                raise ValueError('A source library review differs from its validated payload.')
        (stage / 'reviews').mkdir(exist_ok=True)
        (stage / 'reviews' / name).write_bytes(payload)


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
    source_stamp = library._stamp
    index_payload = _index_snapshot(library, data, source_stamp)
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
            content, _, _ = library.asset(asset['id'], asset['pdf'])
            # Download filenames may be human-readable; storage and URLs remain
            # keyed by the registered asset ID.
            filename = asset['id'] + asset['extension']
            (stage / ('documents' if asset['pdf'] else 'images') / filename).write_bytes(content)
        # Preserve original source bytes: existing Firefly reviews bind the
        # complete index hash, while Services reviews bind individual records.
        (stage / 'library.json').write_bytes(index_payload)
        _copy_reviews(library, data, stage, source_stamp)
        staged = ReferenceLibrary(stage)
        summary = staged.overview()
        for asset in data['_assets'].values():
            staged.asset(asset['id'], asset['pdf'])
        if library._load() is not data or library._stamp != source_stamp:
            raise ValueError('The source library or reviews changed during installation.')
        _index_snapshot(library, data, source_stamp)
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
