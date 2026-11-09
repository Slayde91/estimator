"""Read-only directory cards from the exact saved Project and its companions."""

from copy import deepcopy
from hashlib import sha256
from pathlib import Path

from .catalog import ValidationError


def snapshot_cards(snapshot, owner):
    """Keep SWMS metadata bounded and tied to the Project's canonical owner."""
    from .swms import _identity, _text, STATUSES
    from .document_numbers import valid_reference
    swms = snapshot.get('swms')
    if not swms:
        return []
    if not isinstance(swms, dict) or not isinstance(swms.get('documents'), list) or len(swms['documents']) > 50:
        raise ValidationError('SWMS data uses an unsupported project format.')
    if swms.get('project_id') != owner:
        return []
    _identity(owner)
    cards, seen = [], set()
    for row in swms['documents']:
        if not isinstance(row, dict) or not isinstance(row.get('fields'), dict):
            raise ValidationError('A saved SWMS has unsupported fields.')
        identity = _identity(row.get('id'))
        if identity in seen or type(row.get('version')) is not int or not 1 <= row['version'] <= 1000000000 or row.get('status') not in STATUSES:
            raise ValidationError('SWMS identity, version or status is invalid.')
        reference = row.get('reference', '')
        if reference and not valid_reference(reference):
            raise ValidationError('The saved SWMS reference is invalid.')
        seen.add(identity)
        cards.append({'id':identity, 'project_id':owner, 'kind':'swms',
                      'reference':reference, 'title':_text(row['fields'].get('title',''), 'Document title', 300)})
    return cards


def certificate_cards(manifest, project_path, owner, cache):
    """Verify an authorized file's own archive without restoring any workspace.

    This is called only by related-record views, never ordinary Project listing.
    The bounded cache uses the exact manifest and regular-file identity. Native
    Project Load still independently verifies every byte before opening a file.
    """
    if manifest is None:
        return []
    from .certification_projects import CertificationProjects, MAX_ARCHIVE_BYTES, validate_manifest
    from .evidence_files import _directory, _identity, _open_regular
    manifest = validate_manifest(manifest)
    if manifest['project_id'] != owner or not manifest['document_count']:
        return []
    parent = _directory(Path(project_path).absolute().parent)
    archive = parent / manifest['companion_folder'] / (manifest['archive_sha256'] + '.zip')
    with _open_regular(archive, MAX_ARCHIVE_BYTES) as stream:
        import os
        identity = _identity(os.fstat(stream.fileno()))
        key = (str(archive), manifest['archive_sha256'], manifest['archive_size'], identity)
        if key in cache:
            return deepcopy(cache[key])
        payload = stream.read(MAX_ARCHIVE_BYTES + 1)
    if len(payload) != manifest['archive_size'] or sha256(payload).hexdigest() != manifest['archive_sha256']:
        raise ValidationError('The saved certificate companion failed its exact size or SHA-256 check.')
    metadata, _pdfs = CertificationProjects._read_archive(payload, manifest)
    cards = [{'id': row['id'], 'project_id': owner, 'kind': 'certification',
              'reference': row['reference'], 'title': 'Certification'} for row in metadata['documents']]
    if len(cache) >= 1000:
        cache.pop(next(iter(cache)))
    cache[key] = cards
    return deepcopy(cards)
