"""Verify immutable installer contents and initialize missing per-user state."""

from contextlib import suppress
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile

from .storage import Store

MAX_MANIFEST = 8 * 1024 * 1024
MAX_SEED_BYTES = 8 * 1024 ** 3
ASSET = re.compile(r'reference-library/(?:documents/[a-z0-9][a-z0-9_-]{0,119}\.pdf|images/[a-z0-9][a-z0-9_.-]{0,150}\.(?:png|jpg|jpeg|webp))\Z')


def safe_directory(path):
    value = Path(os.path.abspath(path))
    for parent in reversed([value, *value.parents]):
        if parent.exists() or parent.is_symlink():
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Desktop data and seed paths cannot pass through linked directories.')
            if not parent.is_dir():
                raise ValueError('Desktop data requires ordinary directories.')
    return value


def _file(path):
    safe_directory(path.parent)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('The installer seed contains a linked or nonregular file.')
    return info


def safe_file_if_present(path):
    if path.exists() or path.is_symlink():
        _file(path)


def verified_manifest(root):
    root = safe_directory(root)
    manifest_path = root / 'manifest.json'
    if _file(manifest_path).st_size > MAX_MANIFEST:
        raise ValueError('The installer seed manifest exceeds its size limit.')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or set(manifest) != {'schema_version', 'id', 'files', 'pricing', 'library', 'library_edits'} or manifest['schema_version'] != 1:
        raise ValueError('The installer seed manifest format is invalid.')
    identity = {key: value for key, value in manifest.items() if key != 'id'}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    if manifest['id'] != digest:
        raise ValueError('The installer seed manifest hash is invalid.')
    required = {'pricing': 'pricing.json', 'library': 'reference-library/library.json', 'library_edits': 'library-edits.json'}
    if any(manifest[key] != {'path': value} for key, value in required.items()):
        raise ValueError('The installer seed content locations are invalid.')
    records = manifest['files']
    if not isinstance(records, list) or not 3 <= len(records) <= 20000:
        raise ValueError('The installer seed file count is invalid.')
    names, total = set(), 0
    for record in records:
        if not isinstance(record, dict) or set(record) != {'path', 'size', 'sha256'}:
            raise ValueError('The installer seed file record is invalid.')
        name = record['path']
        if not isinstance(name, str) or '\\' in name or PurePosixPath(name).as_posix() != name or name not in required.values() and not ASSET.fullmatch(name):
            raise ValueError('The installer seed contains an unexpected file path.')
        if name.casefold() in names or type(record['size']) is not int or not 0 <= record['size'] <= 128 * 1024 * 1024 or not isinstance(record['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', record['sha256']):
            raise ValueError('The installer seed contains an invalid or repeated file record.')
        names.add(name.casefold()); total += record['size']
        if total > MAX_SEED_BYTES:
            raise ValueError('The installer seed exceeds its total size limit.')
    if not set(required.values()) <= names or [item['path'] for item in records] != sorted(item['path'] for item in records):
        raise ValueError('The installer seed file list is incomplete or unsorted.')
    return manifest


def initialize_data(seed_root, destination):
    """Never replace an existing database or reference library during upgrades."""
    seed_root, destination = safe_directory(seed_root), safe_directory(destination)
    database, library = destination / 'estimator.sqlite3', destination / 'reference-library'
    for suffix in ('', '-wal', '-shm', '-journal'):
        safe_file_if_present(database.with_name(database.name + suffix))
    if library.exists() or library.is_symlink():
        safe_directory(library)
    missing_database, missing_library = not database.exists(), not library.exists()
    if not missing_database and not missing_library:
        return {'initialized': False}
    manifest = verified_manifest(seed_root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    required_space = sum(record['size'] for record in manifest['files']) + 32 * 1024 * 1024
    if shutil.disk_usage(destination.parent).free < required_space:
        raise OSError('There is not enough free space to initialize ESTIMATOR data.')
    temporary = Path(tempfile.mkdtemp(prefix='.estimator-first-run-', dir=destination.parent))
    try:
        for record in manifest['files']:
            source, output = seed_root / record['path'], temporary / record['path']
            if _file(source).st_size != record['size']:
                raise ValueError('An installer seed file has changed size.')
            output.parent.mkdir(parents=True, exist_ok=True)
            digest, size = hashlib.sha256(), 0
            with source.open('rb') as incoming, output.open('xb') as outgoing:
                while chunk := incoming.read(8 * 1024 * 1024):
                    size += len(chunk)
                    if size > record['size']:
                        raise ValueError('An installer seed file changed during initialization.')
                    digest.update(chunk); outgoing.write(chunk)
                outgoing.flush(); os.fsync(outgoing.fileno())
            if size != record['size'] or digest.hexdigest() != record['sha256']:
                raise ValueError('An installer seed file failed its integrity check.')
        from .reference_library import ReferenceLibrary
        source_library = ReferenceLibrary(temporary / 'reference-library')._load()
        expected_assets = {}
        for entry in source_library['documents']:
            expected_assets['reference-library/documents/' + entry['id'] + '.pdf'] = entry['sha256']
        for entry in source_library.get('images', []):
            expected_assets['reference-library/images/' + entry['id'] + entry['extension']] = entry['sha256']
        supplied_assets = {entry['path']: entry['sha256'] for entry in manifest['files'] if ASSET.fullmatch(entry['path'])}
        if supplied_assets != expected_assets:
            raise ValueError('The installer seed asset manifest does not match its reference library.')
        if missing_database:
            from .desktop_seed_content import validate_library_edits, insert_library_edits
            pricing = json.loads((temporary / 'pricing.json').read_text(encoding='utf-8'))
            edits = json.loads((temporary / 'library-edits.json').read_text(encoding='utf-8'))
            validate_library_edits(edits, temporary / 'reference-library' if missing_library else library)
            store = Store(temporary / 'estimator.sqlite3')
            store.save_configuration(pricing)
            insert_library_edits(store, edits)
        destination.mkdir(exist_ok=True)
        safe_directory(destination)
        # Publish the verified library before exposing a database that refers to
        # it. A retry can finish a missing DB without replacing the first asset.
        if missing_library:
            if library.exists():
                raise FileExistsError('A reference library appeared during initialization; it was preserved.')
            (temporary / 'reference-library').rename(library)
        if missing_database:
            if database.exists():
                raise FileExistsError('A database appeared during initialization; it was preserved.')
            (temporary / 'estimator.sqlite3').rename(database)
        return {'initialized': True, 'seed_id': manifest['id']}
    finally:
        # The temporary path is the exact directory made above, beneath the
        # verified AppData parent. No user data directory is recursively removed.
        with suppress(OSError):
            if temporary.resolve().parent == destination.parent.resolve() and safe_directory(temporary) == temporary:
                shutil.rmtree(temporary)
