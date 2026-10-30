"""Project-owned export revisions and portable immutable PDF/XLSX companions.

The caller supplies an authoritative export-kind registry and verified project
capability. Filenames are display metadata, never membership or storage paths.
Certificate PDFs remain owned by their existing immutable revision service.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from threading import RLock
import uuid

from .catalog import ValidationError
from .evidence_files import _directory, _open_regular, _hash_stream

MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
MAX_REVISIONS = 1000
MAX_PROJECT_BYTES = 1024 * 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
PDF = 'application/pdf'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
EXTENSIONS = {PDF: '.pdf', XLSX: '.xlsx'}
HASH = re.compile(r'[0-9a-f]{64}\Z')
KIND = re.compile(r'(?=.{1,80}\Z)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\Z')
FIELDS = ('id', 'document_id', 'kind', 'logical_key', 'label', 'revision', 'sequence',
          'created_at', 'filename', 'media_type', 'size', 'sha256', 'request_id', 'input_fingerprint')
TEXT_FIELDS = tuple(field for field in FIELDS if field not in {'revision', 'sequence', 'size'})


class DocumentationConflict(ValidationError):
    """An operation or captured project history changed before acceptance."""


class DocumentationNotFound(ValidationError):
    """This revision does not belong to the supplied project workspace."""


def _identity(value, label='Project identity'):
    try:
        valid = isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise ValidationError(label + ' must be a canonical UUID.')
    return value


def _digest(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ValidationError('Document fingerprints must be SHA-256 values.')
    return value


def _text(value, label, maximum, *, allow_empty=False):
    if (not isinstance(value, str) or (not value.strip() and not (allow_empty and value == '')) or len(value) > maximum
            or any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ValidationError(label + ' must be bounded, nonempty plain text.')
    return value


def _integer(value, label, maximum, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValidationError(label + ' is outside its supported limits.')
    return value


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError('The document manifest contains duplicate JSON fields.')
        result[key] = value
    return result


def _reject_constant(value):
    raise ValidationError('The document manifest contains an invalid JSON number.')


def _document_id(project, kind, logical_key, media_type):
    return str(uuid.uuid5(uuid.UUID(project), _json([kind, logical_key, media_type]).decode('utf-8')))


def _filename(value, media_type):
    _text(value, 'Document filename', 200)
    if (value in {'.', '..'} or any(char in value for char in '/\\:"')
            or not value.lower().endswith(EXTENSIONS[media_type])):
        raise ValidationError('Document filenames must be simple PDF or XLSX names of the matching type.')
    return value


def validate_manifest(value):
    keys = {'version', 'project_id', 'manifest_sha256', 'manifest_size', 'revision_count', 'unique_bytes', 'companion_folder'}
    if not isinstance(value, dict) or set(value) != keys or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('The project document manifest uses an unsupported schema.')
    project = _identity(value['project_id'])
    _digest(value['manifest_sha256'])
    _integer(value['manifest_size'], 'Document manifest size', MAX_METADATA_BYTES, 1)
    _integer(value['revision_count'], 'Document revision count', MAX_REVISIONS)
    _integer(value['unique_bytes'], 'Project document bytes', MAX_PROJECT_BYTES)
    if value['companion_folder'] != f'.ceasefire-evidence/{project}/documentation':
        raise ValidationError('The project document companion folder is invalid.')
    return deepcopy(value)


def _signature(prefix, media_type):
    if media_type == PDF and not prefix.startswith(b'%PDF-') or media_type == XLSX and not prefix.startswith(b'PK\x03\x04'):
        raise ValidationError('The generated document does not match its declared PDF/XLSX type.')


def _verified(path, digest, size, maximum):
    with _open_regular(path, maximum) as stream:
        if os.fstat(stream.fileno()).st_size != size or _hash_stream(stream) != digest:
            raise ValidationError('A retained document failed its exact size or SHA-256 check.')


def _publish_file(source, destination, digest, size, maximum):
    """Publish completed immutable bytes; all paths are derived internally."""
    _directory(destination.parent, create=True)
    try:
        destination.lstat()
    except FileNotFoundError:
        pass
    else:
        _verified(destination, digest, size, maximum)
        return
    descriptor, temporary_name = tempfile.mkstemp(prefix='.document-', dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as outgoing, _open_regular(source, maximum) as incoming:
            if os.fstat(incoming.fileno()).st_size != size:
                raise ValidationError('The source document size changed before publication.')
            checksum = sha256()
            while chunk := incoming.read(CHUNK_BYTES):
                checksum.update(chunk); outgoing.write(chunk)
            outgoing.flush(); os.fsync(outgoing.fileno())
            if checksum.hexdigest() != digest:
                raise ValidationError('The source document changed during publication.')
        try:
            os.rename(temporary, destination)
        except FileExistsError:
            _verified(destination, digest, size, maximum)
        _directory(destination.parent)
        _verified(destination, digest, size, maximum)
    finally:
        temporary.unlink(missing_ok=True)


class ProjectDocumentation:
    def __init__(self, certifications, *, kinds=None, root=None):
        self.certifications = certifications
        self.kinds = {}
        for kind, label in (kinds or {}).items():
            if not isinstance(kind, str) or not KIND.fullmatch(kind):
                raise ValidationError('Document kind registry keys must be stable server-defined names.')
            self.kinds[kind] = _text(label, 'Document type label', 200)
        self.root = _directory(Path(root) if root is not None else certifications.root.parent / 'project-documentation', create=True)
        self._lock = RLock()
        self._workspaces = {}

    def _workspace(self, workspace):
        _identity(workspace, 'Document workspace ID')
        project = self.certifications.project_id(workspace)
        with self._lock:
            current = self._workspaces.get(workspace)
            if current is not None:
                if current['project_id'] != project:
                    raise DocumentationConflict('The document workspace project identity changed.')
                return current
            folder = _directory(self.root / 'workspaces' / workspace, create=True)
            current = {'project_id': project, 'path': folder / 'revisions.sqlite3'}
            with self._connect(current) as db:
                db.execute('''CREATE TABLE IF NOT EXISTS documentation_revisions (
                    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, kind TEXT NOT NULL,
                    logical_key TEXT NOT NULL, label TEXT NOT NULL, revision INTEGER NOT NULL,
                    sequence INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL,
                    filename TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, input_fingerprint TEXT NOT NULL,
                    UNIQUE(document_id, revision))''')
            self._workspaces[workspace] = current
            return current

    @staticmethod
    @contextmanager
    def _connect(current):
        connection = sqlite3.connect(current['path'], timeout=20)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _rows(db):
        count, raw_size = db.execute('SELECT COUNT(*),COALESCE(SUM(' + '+'.join('LENGTH(CAST(' + field + ' AS BLOB))' for field in TEXT_FIELDS) + '),0) FROM documentation_revisions').fetchone()
        _integer(count, 'Document revision count', MAX_REVISIONS)
        _integer(raw_size, 'Document metadata bytes', MAX_METADATA_BYTES)
        return [dict(zip(FIELDS, row)) for row in db.execute('SELECT ' + ','.join(FIELDS) + ' FROM documentation_revisions ORDER BY sequence')]

    @staticmethod
    def _metadata(project, rows):
        return {'version': 1, 'project_id': project, 'workspace_revision': len(rows), 'revisions': rows}

    def _validate_row(self, project, row):
        """Validate one retained revision without applying new-write quotas."""
        if not isinstance(row, dict) or set(row) != set(FIELDS):
            raise ValidationError('A document revision contains missing or unsupported fields.')
        for name in ('id', 'document_id', 'request_id'):
            _identity(row[name], 'Document ' + name)
        if not isinstance(row['kind'], str) or row['kind'] not in self.kinds or row['kind'] == 'certification':
            raise ValidationError('The document manifest contains an unsupported export type.')
        # The empty key denotes this project's main document for its kind.
        _text(row['logical_key'], 'Document logical source key', 2000, allow_empty=True)
        _text(row['label'], 'Document type label', 200)
        if not isinstance(row['media_type'], str) or row['media_type'] not in EXTENSIONS:
            raise ValidationError('Only PDF/XLSX project document revisions are supported.')
        _filename(row['filename'], row['media_type'])
        if row['document_id'] != _document_id(project, row['kind'], row['logical_key'], row['media_type']):
            raise ValidationError('A document revision belongs to another logical project document.')
        _integer(row['revision'], 'Document revision', 2147483647, 1)
        _integer(row['sequence'], 'Document sequence', 2147483647, 1)
        _text(row['created_at'], 'Document generation time', 100)
        try:
            timestamp = datetime.fromisoformat(row['created_at'])
            if timestamp.tzinfo is None or timestamp.utcoffset().total_seconds() != 0:
                raise ValueError()
        except (ValueError, TypeError, OverflowError) as error:
            raise ValidationError('Document generation times must be UTC timestamps.') from error
        _integer(row['size'], 'Document size', MAX_ARTIFACT_BYTES, 1)
        _digest(row['sha256']); _digest(row['input_fingerprint'])

    def _validate_rows(self, project, rows):
        if not isinstance(rows, list) or len(rows) > MAX_REVISIONS:
            raise ValidationError('Project document revisions exceed their supported limit.')
        identifiers, requests, groups, blobs = set(), set(), {}, {}
        for sequence, row in enumerate(rows, 1):
            self._validate_row(project, row)
            if row['id'] in identifiers or row['request_id'] in requests:
                raise ValidationError('The document manifest repeats a revision or request identity.')
            identifiers.add(row['id']); requests.add(row['request_id'])
            expected = groups.get(row['document_id'], 0) + 1
            if type(row['sequence']) is not int or row['sequence'] != sequence or type(row['revision']) is not int or row['revision'] != expected:
                raise ValidationError('The document revision sequence is broken.')
            groups[row['document_id']] = expected
            descriptor = row['size'], row['media_type']
            if row['sha256'] in blobs and blobs[row['sha256']] != descriptor:
                raise ValidationError('An immutable document fingerprint has conflicting size/type metadata.')
            blobs[row['sha256']] = descriptor
        _integer(sum(size for size, _ in blobs.values()), 'Project document bytes', MAX_PROJECT_BYTES)
        metadata = _json(self._metadata(project, rows))
        _integer(len(metadata), 'Document manifest size', MAX_METADATA_BYTES, 1)
        return metadata, blobs

    @staticmethod
    def _public(workspace, row, source='export'):
        return {key: row[key] for key in FIELDS if key not in {'request_id', 'input_fingerprint'}} | {
            'source': source, 'url': '/api/documentation/' + row['id'] + '?workspace=' + workspace}

    def _certificate_items(self, workspace, project):
        service = self.certifications.service(workspace)
        with service.store.connect() as db:
            rows = db.execute('SELECT document_id,revision,created_at,sha256,LENGTH(pdf) FROM certification_revisions ORDER BY document_id,revision').fetchall()
        items = []
        for document, revision, created_at, digest, size in rows:
            _identity(document); _digest(digest)
            _integer(revision, 'Certificate revision', 2147483647, 1)
            identity = str(uuid.uuid5(uuid.UUID(project), 'certification/' + document + '/' + str(revision)))
            row = {'id': identity, 'document_id': _document_id(project, 'certification', document, PDF),
                   'kind': 'certification', 'logical_key': document, 'label': self.kinds.get('certification', 'Certification'),
                   'revision': revision, 'sequence': 0, 'created_at': created_at,
                   'filename': 'Installation-Certificate-' + document[:8] + '-Revision-' + str(revision) + '.pdf',
                   'media_type': PDF, 'size': size, 'sha256': digest}
            items.append(self._public(workspace, row, 'certification'))
        return items

    def view(self, workspace):
        current = self._workspace(workspace)
        with self._connect(current) as db:
            db.execute('BEGIN')
            rows = self._rows(db)
            self._validate_rows(current['project_id'], rows)
        items = [self._public(workspace, row) for row in rows]
        items.extend(self._certificate_items(workspace, current['project_id']))
        items.sort(key=lambda item: (item['created_at'], item['id']), reverse=True)
        return {'workspace_id': workspace, 'project_id': current['project_id'], 'workspace_revision': len(rows), 'items': items}

    @staticmethod
    def _old(db, request_id, fingerprint):
        raw = db.execute('SELECT ' + ','.join(FIELDS) + ' FROM documentation_revisions WHERE request_id=?', (request_id,)).fetchone()
        if raw is None:
            return None
        row = dict(zip(FIELDS, raw))
        if row['input_fingerprint'] != fingerprint:
            raise DocumentationConflict('This document operation was already used with different export inputs.')
        return row

    def _receipt(self, workspace, current, row, replayed, db):
        return {'workspace_id': workspace, 'project_id': current['project_id'],
                'workspace_revision': db.execute('SELECT COUNT(*) FROM documentation_revisions').fetchone()[0],
                'item': self._public(workspace, row), 'replayed': replayed}

    def replay(self, workspace, request_id, input_fingerprint):
        _identity(request_id, 'Document operation ID'); _digest(input_fingerprint)
        current = self._workspace(workspace)
        with self._connect(current) as db:
            db.execute('BEGIN')
            row = self._old(db, request_id, input_fingerprint)
            if row is not None:
                self._validate_row(current['project_id'], row)
                _verified(self.root / 'blobs' / (row['sha256'] + EXTENSIONS[row['media_type']]), row['sha256'], row['size'], MAX_ARTIFACT_BYTES)
            return self._receipt(workspace, current, row, True, db) if row else None

    def _stage(self, payload, media_type):
        folder = _directory(self.root / 'staging', create=True)
        descriptor, name = tempfile.mkstemp(prefix='.document-', dir=folder)
        path = Path(name)
        try:
            if isinstance(payload, (bytes, bytearray, memoryview)):
                if not 1 <= len(payload) <= MAX_ARTIFACT_BYTES:
                    raise ValidationError('Generated documents must be at most 256 MiB.')
                incoming = BytesIO(payload)
            elif callable(getattr(payload, 'read', None)):
                incoming = payload
            else:
                raise ValidationError('Record a generated binary document, never an external file path.')
            digest, size, prefix = sha256(), 0, b''
            stream = os.fdopen(descriptor, 'wb')
            # Ownership transfers once: after the context closes, this number
            # may already belong to another concurrent file operation.
            descriptor = None
            with stream as output:
                while chunk := incoming.read(CHUNK_BYTES):
                    if not isinstance(chunk, bytes):
                        raise ValidationError('Generated document streams must contain bytes only.')
                    size += len(chunk)
                    if size > MAX_ARTIFACT_BYTES:
                        raise ValidationError('Generated documents must be at most 256 MiB.')
                    if len(prefix) < 8:
                        prefix = (prefix + chunk)[:8]
                    digest.update(chunk); output.write(chunk)
                if not size:
                    raise ValidationError('Generated documents cannot be empty.')
                _signature(prefix, media_type)
                output.flush(); os.fsync(output.fileno())
            return path, size, digest.hexdigest()
        except Exception:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            path.unlink(missing_ok=True)
            raise

    def record(self, workspace, kind, logical_key, filename, media_type, payload, request_id, input_fingerprint):
        if not isinstance(kind, str) or kind not in self.kinds or kind == 'certification':
            raise ValidationError('Choose a server-defined project export type; certificates keep their original revision owner.')
        _text(logical_key, 'Document logical source key', 2000, allow_empty=True)
        if not isinstance(media_type, str) or media_type not in EXTENSIONS:
            raise ValidationError('Only PDF/XLSX project document revisions are supported.')
        _filename(filename, media_type)
        _identity(request_id, 'Document operation ID'); _digest(input_fingerprint)
        current = self._workspace(workspace)
        old = self.replay(workspace, request_id, input_fingerprint)
        if old is not None:
            item = old['item']
            if (item['kind'], item['logical_key'], item['media_type']) != (kind, logical_key, media_type):
                raise DocumentationConflict('This document operation belongs to another export type or source.')
            return old
        staged, size, digest = self._stage(payload, media_type)
        try:
            with self._connect(current) as db:
                db.execute('BEGIN IMMEDIATE')
                old_row = self._old(db, request_id, input_fingerprint)
                if old_row is not None:
                    if (old_row['kind'], old_row['logical_key'], old_row['media_type']) != (kind, logical_key, media_type):
                        raise DocumentationConflict('This document operation belongs to another export type or source.')
                    _verified(self.root / 'blobs' / (old_row['sha256'] + EXTENSIONS[old_row['media_type']]), old_row['sha256'], old_row['size'], MAX_ARTIFACT_BYTES)
                    return self._receipt(workspace, current, old_row, True, db)
                rows = self._rows(db)
                if len(rows) >= MAX_REVISIONS:
                    raise ValidationError('This project already contains 1,000 document revisions. No export revision was recorded.')
                document = _document_id(current['project_id'], kind, logical_key, media_type)
                row = {'id': str(uuid.uuid4()), 'document_id': document, 'kind': kind, 'logical_key': logical_key,
                       'label': self.kinds[kind], 'revision': max((item['revision'] for item in rows if item['document_id'] == document), default=0) + 1,
                       'sequence': len(rows) + 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                       'filename': filename, 'media_type': media_type, 'size': size, 'sha256': digest,
                       'request_id': request_id, 'input_fingerprint': input_fingerprint}
                self._validate_rows(current['project_id'], rows + [row])
                destination = self.root / 'blobs' / (digest + EXTENSIONS[media_type])
                _publish_file(staged, destination, digest, size, MAX_ARTIFACT_BYTES)
                db.execute('INSERT INTO documentation_revisions (' + ','.join(FIELDS) + ') VALUES(' + ','.join('?' for _ in FIELDS) + ')', tuple(row[field] for field in FIELDS))
                return self._receipt(workspace, current, row, False, db)
        finally:
            staged.unlink(missing_ok=True)

    def read(self, workspace, revision_id):
        _identity(revision_id, 'Document revision ID')
        current = self._workspace(workspace)
        with self._connect(current) as db:
            raw = db.execute('SELECT ' + ','.join(FIELDS) + ' FROM documentation_revisions WHERE id=?', (revision_id,)).fetchone()
        if raw is None:
            item = next((item for item in self._certificate_items(workspace, current['project_id']) if item['id'] == revision_id), None)
            if item is None:
                raise DocumentationNotFound('This document revision does not belong to the current project.')
            payload = self.certifications.service(workspace).revision_pdf(item['logical_key'], item['revision'])
        else:
            row = dict(zip(FIELDS, raw))
            # Validate its binding and fixed metadata before deriving any path.
            self._validate_row(current['project_id'], row)
            item = self._public(workspace, row)
            path = self.root / 'blobs' / (row['sha256'] + EXTENSIONS[row['media_type']])
            with _open_regular(path, MAX_ARTIFACT_BYTES) as stream:
                payload = stream.read(MAX_ARTIFACT_BYTES + 1)
        if len(payload) != item['size'] or sha256(payload).hexdigest() != item['sha256']:
            raise ValidationError('The immutable project document failed its size or SHA-256 check.')
        _signature(payload[:8], item['media_type'])
        return {'item': item, 'payload': payload}

    def _history(self, current):
        with self._connect(current) as db:
            db.execute('BEGIN')
            return self._rows(db)

    def capture(self, value):
        if not isinstance(value, dict) or set(value) != {'workspace_id', 'expected_revision'}:
            raise ValidationError('Capture the current document workspace and its exact revision together.')
        expected = _integer(value['expected_revision'], 'Captured document revision', MAX_REVISIONS)
        current = self._workspace(value['workspace_id'])
        with self._connect(current) as db:
            db.execute('BEGIN')
            rows = self._rows(db)
            if len(rows) != expected:
                raise DocumentationConflict('Project document history changed while saving. Refresh Documentation and save again.')
            metadata, blobs = self._validate_rows(current['project_id'], rows)
        for digest, (size, media_type) in blobs.items():
            _verified(self.root / 'blobs' / (digest + EXTENSIONS[media_type]), digest, size, MAX_ARTIFACT_BYTES)
        digest = sha256(metadata).hexdigest()
        folder = _directory(self.root / 'staging', create=True)
        descriptor, name = tempfile.mkstemp(prefix='.manifest-', dir=folder)
        path = Path(name)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(metadata); stream.flush(); os.fsync(stream.fileno())
            _publish_file(path, self.root / 'manifests' / (digest + '.json'), digest, len(metadata), MAX_METADATA_BYTES)
        finally:
            path.unlink(missing_ok=True)
        return {'version': 1, 'project_id': current['project_id'], 'manifest_sha256': digest,
                'manifest_size': len(metadata), 'revision_count': len(rows), 'unique_bytes': sum(size for size, _ in blobs.values()),
                'companion_folder': f".ceasefire-evidence/{current['project_id']}/documentation"}

    def _manifest(self, snapshot, source):
        snapshot = validate_manifest(snapshot)
        with _open_regular(source, MAX_METADATA_BYTES) as stream:
            payload = stream.read(MAX_METADATA_BYTES + 1)
        if len(payload) != snapshot['manifest_size'] or sha256(payload).hexdigest() != snapshot['manifest_sha256']:
            raise ValidationError('The document manifest failed its exact size or SHA-256 check.')
        try:
            metadata = json.loads(payload.decode('utf-8'), object_pairs_hook=_unique, parse_constant=_reject_constant)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ValidationError('The saved document manifest is not valid bounded JSON.') from error
        if (not isinstance(metadata, dict) or set(metadata) != {'version', 'project_id', 'workspace_revision', 'revisions'}
                or type(metadata['version']) is not int or metadata['version'] != 1 or metadata['project_id'] != snapshot['project_id']):
            raise ValidationError('The document manifest does not match this project identity.')
        encoded, blobs = self._validate_rows(snapshot['project_id'], metadata['revisions'])
        if (type(metadata['workspace_revision']) is not int or metadata['workspace_revision'] != len(metadata['revisions'])
                or snapshot['revision_count'] != len(metadata['revisions'])
                or snapshot['unique_bytes'] != sum(size for size, _ in blobs.values()) or encoded != payload):
            raise ValidationError('The saved document manifest has inconsistent counts or noncanonical contents.')
        return metadata, blobs

    def publish(self, snapshot, project_path):
        snapshot = validate_manifest(snapshot)
        name = snapshot['manifest_sha256'] + '.json'
        metadata, blobs = self._manifest(snapshot, self.root / 'manifests' / name)
        folder = _directory(Path(project_path).absolute().parent) / '.ceasefire-evidence' / snapshot['project_id'] / 'documentation'
        for digest, (size, media_type) in blobs.items():
            filename = digest + EXTENSIONS[media_type]
            _publish_file(self.root / 'blobs' / filename, folder / 'blobs' / filename, digest, size, MAX_ARTIFACT_BYTES)
        _publish_file(self.root / 'manifests' / name, folder / name, snapshot['manifest_sha256'], snapshot['manifest_size'], MAX_METADATA_BYTES)
        return snapshot

    def restore(self, snapshot, workspace, project_path=None):
        current = self._workspace(workspace)
        existing = self._history(current)
        if snapshot is None:
            if existing:
                raise DocumentationConflict('A fresh project workspace is required to load a project without document history.')
            return self.view(workspace)
        snapshot = validate_manifest(snapshot)
        if snapshot['project_id'] != current['project_id']:
            raise DocumentationConflict('This document history belongs to another project identity.')
        name = snapshot['manifest_sha256'] + '.json'
        folder = (self.root if project_path is None else
                  _directory(Path(project_path).absolute().parent) / '.ceasefire-evidence' / snapshot['project_id'] / 'documentation')
        manifest_path = folder / 'manifests' / name if project_path is None else folder / name
        try:
            metadata, blobs = self._manifest(snapshot, manifest_path)
            for digest, (size, media_type) in blobs.items():
                filename = digest + EXTENSIONS[media_type]
                source = folder / 'blobs' / filename
                _verified(source, digest, size, MAX_ARTIFACT_BYTES)
                with _open_regular(source, MAX_ARTIFACT_BYTES) as stream:
                    _signature(stream.read(8), media_type)
                _publish_file(source, self.root / 'blobs' / filename, digest, size, MAX_ARTIFACT_BYTES)
        except ValidationError as error:
            hint = ('Use Load Project with its .ceasefire-evidence folder; the exact document archive is not cached locally.' if project_path is None else
                    'Keep the complete .ceasefire-evidence folder beside the saved project.')
            raise ValidationError('The saved document companion is missing, changed or invalid. ' + hint) from error
        with self._connect(current) as db:
            db.execute('BEGIN IMMEDIATE')
            previous = self._rows(db)
            if previous:
                if previous != metadata['revisions']:
                    raise DocumentationConflict('Loading cannot replace an existing project document workspace.')
            else:
                for row in metadata['revisions']:
                    db.execute('INSERT INTO documentation_revisions (' + ','.join(FIELDS) + ') VALUES(' + ','.join('?' for _ in FIELDS) + ')', tuple(row[field] for field in FIELDS))
        _publish_file(manifest_path, self.root / 'manifests' / name, snapshot['manifest_sha256'], snapshot['manifest_size'], MAX_METADATA_BYTES)
        return self.view(workspace)
