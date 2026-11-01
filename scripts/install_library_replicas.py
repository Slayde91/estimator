"""Install reviewed, resumable AI illustration batches without changing evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.catalog import ValidationError
from estimator.library_replicas import IMAGE_LIMIT
from estimator.reference_library import ReferenceLibrary


def synchronize_images(directory, keys=None):
    """Mirror published illustrations into images, retaining exact originals."""
    from estimator.library_replicas import asset as replica_asset
    directory = Path(directory).resolve()
    library = ReferenceLibrary(directory)
    entries = library.image_replicas()
    registered = json.loads((directory / 'replicas/index.json').read_text(encoding='utf-8'))
    if registered != {'version': 1, 'images': entries}:
        raise ValidationError('The replica registry requires repair before synchronizing images.')
    selected = sorted(entries if keys is None else set(keys))
    assets = library._load()['_assets']
    plans, checked_outputs = [], set()
    for key in selected:
        if key not in entries:
            raise ValidationError('Only published reviewed images can be synchronized.')
        entry = entries[key]
        source = directory / 'images' / (key + assets[key]['extension'])
        archive = directory / 'images_old' / source.name
        output = directory / 'replicas' / entry['file']
        target = directory / 'images' / (key + output.suffix)
        for path in (source, archive, output, target):
            if not path.resolve().is_relative_to(directory):
                raise ValidationError('An image synchronization path is outside the library.')
        original = archive if archive.exists() else source
        if not original.is_file() or hashlib.sha256(original.read_bytes()).hexdigest() != entry['source_sha256']:
            raise ValidationError('An original image changed before synchronization.')
        if source != target and source.exists() and hashlib.sha256(source.read_bytes()).hexdigest() != entry['source_sha256']:
            raise ValidationError('An unexpected file occupies the original image path.')
        if entry['file'] not in checked_outputs:
            replica_asset(directory, entry)
            checked_outputs.add(entry['file'])
        previous = None
        if (archive.exists() and target.exists() and target.read_bytes() != output.read_bytes()
                and hashlib.sha256(target.read_bytes()).hexdigest() != entry['source_sha256']):
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            previous = directory / 'replicas/previous' / (digest + target.suffix)
            if not previous.resolve().is_relative_to(directory):
                raise ValidationError('The previous image path is outside the library.')
            if previous.exists() and previous.read_bytes() != target.read_bytes():
                raise ValidationError('A previous image backup has changed.')
        plans.append((source, archive, output, target, previous, entry))
    result = dict(images_updated=0, originals_archived=0, already_current=0, previous_preserved=0)
    # Complete validation before moving any source. An interrupted run is safe
    # to repeat: the evidence reader prefers images_old and replicas stay valid.
    for source, archive, output, target, previous, entry in plans:
        archive.parent.mkdir(exist_ok=True)
        if not archive.exists():
            if hashlib.sha256(source.read_bytes()).hexdigest() != entry['source_sha256']:
                raise ValidationError('An original image changed during synchronization.')
            source.rename(archive)
            result['originals_archived'] += 1
        elif source != target and source.exists():
            # Remove only a verified duplicate of the intact archived original.
            if source.read_bytes() != archive.read_bytes():
                raise ValidationError('An original image changed during synchronization.')
            source.unlink()
        if previous:
            previous.parent.mkdir(exist_ok=True)
            previous.write_bytes(target.read_bytes())
            result['previous_preserved'] += 1
        payload = output.read_bytes()
        if hashlib.sha256(payload).hexdigest() != entry['sha256']:
            raise ValidationError('A published image changed during synchronization.')
        if target.exists() and target.read_bytes() == payload:
            result['already_current'] += 1
        else:
            staged = target.with_suffix(target.suffix + '.pending')
            staged.write_bytes(payload)
            staged.replace(target)
            result['images_updated'] += 1
    return result


def install(manifest, directory):
    directory = Path(directory)
    library = ReferenceLibrary(directory)
    jobs = json.loads(Path(manifest).read_text(encoding='utf-8'))
    if jobs.get('source_index_sha256') and hashlib.sha256((directory / 'library.json').read_bytes()).hexdigest() != jobs['source_index_sha256']:
        raise ValidationError('The library index changed after inventory. Rescan before installing this batch.')
    destination = directory / 'replicas'
    if not destination.resolve().is_relative_to(directory.resolve()):
        raise ValidationError('The replica folder must stay inside this library.')
    index_path = destination / 'index.json'
    existing = json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else {'version': 1, 'images': {}}
    if existing != {'version': 1, 'images': library.image_replicas()}:
        raise ValidationError('The existing replica registry requires repair before adding a batch.')
    entries = dict(existing['images'])
    files = {}
    for job in jobs['jobs']:
        if job['status'] not in ('generated_visual_review_passed', 'reused_visual_review_passed'):
            continue
        if job.get('review', {}).get('result') != 'visual_review_passed' or job['review'].get('technical_approval') is not False:
            raise ValidationError('Only explicitly reviewed illustrations can be installed.')
        if job['review'].get('no_text') is not True or job['review'].get('no_branding') is not True:
            raise ValidationError('Replicas require explicit visual confirmation of no text and no branding.')
        output = job['output']
        path = Path(output['path'])
        if not 0 < path.stat().st_size <= IMAGE_LIMIT:
            raise ValidationError('The replica output exceeds its supported size.')
        with path.open('rb') as stream:
            payload = stream.read(IMAGE_LIMIT + 1)
        fingerprint = hashlib.sha256(payload).hexdigest()
        png = payload.startswith(b'\x89PNG\r\n\x1a\n')
        jpeg = payload.startswith(b'\xff\xd8\xff')
        if len(payload) > IMAGE_LIMIT or fingerprint != output['sha256'] or not (png or jpeg):
            raise ValidationError('The reviewed image output changed or is invalid.')
        filename = fingerprint + ('.png' if png else '.jpg')
        for key in job['aliases']:
            source, _, _ = library.asset(key, False)
            if hashlib.sha256(source).hexdigest() != job['source_sha256']:
                raise ValidationError('A replica source changed after inventory. Rescan before installing it.')
            entries[key] = {'source_sha256': job['source_sha256'], 'file': filename,
                            'sha256': fingerprint, 'review': 'visual_review_passed'}
        files[filename] = payload
    # Validate every source/output before any write. Content names make repeated
    # installs idempotent; only the separate registry is replaced atomically.
    destination.mkdir(parents=True, exist_ok=True)
    for filename, payload in files.items():
        target = destination / filename
        if not target.resolve().is_relative_to(destination.resolve()):
            raise ValidationError('A replica output is outside its registered folder.')
        if target.exists() and target.read_bytes() != payload:
            raise ValidationError('A content-addressed replica file changed unexpectedly.')
        if not target.exists():
            target.write_bytes(payload)
    staged = destination / 'index.json.pending'
    staged.write_text(json.dumps({'version': 1, 'images': entries}, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    staged.replace(index_path)
    synchronize_images(directory, [key for job in jobs['jobs']
                                   if job['status'] in ('generated_visual_review_passed', 'reused_visual_review_passed')
                                   for key in job['aliases']])
    return {'registered_source_ids': len(entries), 'unique_replica_files': len({entry['file'] for entry in entries.values()})}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--manifest')
    mode.add_argument('--sync-published', action='store_true', help='Synchronize all already approved images without generating or approving anything.')
    parser.add_argument('--library-directory', required=True)
    arguments = parser.parse_args()
    print(json.dumps(synchronize_images(arguments.library_directory) if arguments.sync_published
                     else install(arguments.manifest, arguments.library_directory)))
