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
        output = job['output']
        path = Path(output['path'])
        if not 0 < path.stat().st_size <= IMAGE_LIMIT:
            raise ValidationError('The replica output exceeds its supported size.')
        with path.open('rb') as stream:
            payload = stream.read(IMAGE_LIMIT + 1)
        fingerprint = hashlib.sha256(payload).hexdigest()
        if len(payload) > IMAGE_LIMIT or fingerprint != output['sha256'] or not payload.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValidationError('The reviewed PNG output changed or is invalid.')
        filename = fingerprint + '.png'
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
    return {'registered_source_ids': len(entries), 'unique_replica_files': len({entry['file'] for entry in entries.values()})}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--library-directory', required=True)
    arguments = parser.parse_args()
    print(json.dumps(install(arguments.manifest, arguments.library_directory)))
