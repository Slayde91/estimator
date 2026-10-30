"""Project-owned certificates and portable immutable revision companions.

The global legacy certificate database is deliberately not reassigned by labels.
Each open project receives an isolated workspace. A saved project names an exact
content-addressed archive, using the same companion-folder lifecycle as Takeoffs.
"""
from copy import deepcopy
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
from zipfile import ZipFile, ZipInfo, ZIP_STORED, BadZipFile

from .catalog import ValidationError
from .certification import (CertificationService, CertificationConflict, CertificationNotFound, _identity,
                            _version, _json, validate_fields, validate_options,
                            MAX_REVISION_BYTES)
from .storage import Store
from .evidence_files import _directory, _open_regular, _verified

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_METADATA_BYTES = 64 * 1024 * 1024
MAX_DOCUMENTS = 100
MAX_REVISIONS = 1000
HASH = re.compile(r'[0-9a-f]{64}\Z')
DOCUMENT_COLUMNS = ('id', 'fields', 'version', 'created_at', 'updated_at',
                    'create_request_id', 'create_request_fingerprint', 'options', 'create_options')
REVISION_COLUMNS = ('document_id', 'revision', 'created_at', 'fields', 'company',
                    'sha256', 'request_id', 'request_fingerprint', 'options', 'cover_settings')


def validate_manifest(value):
    keys = {'version', 'project_id', 'archive_sha256', 'archive_size',
            'document_count', 'revision_count', 'companion_folder'}
    if not isinstance(value, dict) or set(value) != keys or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('The saved project contains an unsupported certificate manifest.')
    project = _identity(value['project_id'], 'Certificate project ID')
    if not isinstance(value['archive_sha256'], str) or not HASH.fullmatch(value['archive_sha256']):
        raise ValidationError('The saved project certificate archive hash is invalid.')
    for key, maximum in (('archive_size', MAX_ARCHIVE_BYTES), ('document_count', MAX_DOCUMENTS), ('revision_count', MAX_REVISIONS)):
        if type(value[key]) is not int or not (1 if key == 'archive_size' else 0) <= value[key] <= maximum:
            raise ValidationError('The saved project certificate archive exceeds its supported limits.')
    if value['companion_folder'] != f'.ceasefire-evidence/{project}/certifications':
        raise ValidationError('The saved project certificate companion folder is invalid.')
    return deepcopy(value)


def _draft(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'id', 'version', 'fields', 'options'}:
        raise ValidationError('Include the current certification draft, identity and version only.')
    if value['id'] is None:
        if value['version'] is not None:
            raise ValidationError('An unsaved certificate cannot have a saved version.')
    else:
        _identity(value['id']); _version(value['version'])
    return {'id': value['id'], 'version': value['version'],
            'fields': validate_fields(value['fields']), 'options': validate_options(value['options'])}


def _copy(source, target, digest, size):
    """Publish immutable verified bytes without following links or replacing files."""
    _directory(target.parent, create=True)
    try:
        target.lstat()
    except FileNotFoundError:
        pass
    else:
        _verified(target, digest, MAX_ARCHIVE_BYTES)
        if target.stat().st_size != size:
            raise ValidationError('The certificate archive size changed.')
        return
    with _open_regular(source, MAX_ARCHIVE_BYTES) as incoming:
        payload = incoming.read(MAX_ARCHIVE_BYTES + 1)
    if len(payload) != size or sha256(payload).hexdigest() != digest:
        raise ValidationError('The certificate archive failed its integrity check.')
    _write_archive(target, payload, digest)


def _write_archive(target, payload, digest):
    _directory(target.parent, create=True)
    try:
        target.lstat()
    except FileNotFoundError:
        pass
    else:
        _verified(target, digest, MAX_ARCHIVE_BYTES)
        return
    descriptor, temporary = tempfile.mkstemp(prefix='.certificate-', dir=target.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(payload); output.flush(); os.fsync(output.fileno())
        # Windows rename publishes a completed file atomically and refuses to
        # replace an existing target. Unlike hard links it also works in the
        # application's supported cloud-backed project folders.
        try:
            os.rename(temporary, target)
        except FileExistsError:
            _verified(target, digest, MAX_ARCHIVE_BYTES)
        _directory(target.parent)
        _verified(target, digest, MAX_ARCHIVE_BYTES)
    finally:
        temporary.unlink(missing_ok=True)


def _scope_links(value, token):
    if isinstance(value, list):
        return [_scope_links(item, token) for item in value]
    if isinstance(value, dict):
        return {key: (item + '?workspace=' + token if key == 'pdf_url' else _scope_links(item, token))
                for key, item in value.items()}
    return value


def _pdf_inventory(db, clause='', parameters=()):
    """Bound unique retained bytes before reading any certificate PDF blob."""
    total = db.execute('SELECT COUNT(*) FROM certification_revisions ' + clause, parameters).fetchone()[0]
    if total > MAX_REVISIONS:
        raise ValidationError('The certificate exceeds this project archive revision limit. No PDF data was loaded or imported.')
    rows = db.execute('SELECT sha256,MAX(LENGTH(pdf)),COUNT(*) FROM certification_revisions ' + clause + ' GROUP BY sha256', parameters).fetchall()
    sizes, count = {}, 0
    for digest, size, revisions in rows:
        if not isinstance(digest, str) or not HASH.fullmatch(digest) or type(size) is not int or not 1 <= size <= MAX_REVISION_BYTES:
            raise ValidationError('A retained certificate PDF has invalid size or integrity metadata.')
        sizes[digest] = size; count += revisions
    return count, sizes


def _pdf_bytes(db, row, *, document_id=None):
    payload = bytes(db.execute('SELECT pdf FROM certification_revisions WHERE document_id=? AND revision=?', row[:2]).fetchone()[0])
    if len(payload) > MAX_REVISION_BYTES or not payload.startswith(b'%PDF-') or sha256(payload).hexdigest() != row[5]:
        raise ValidationError('A retained certificate PDF failed its integrity check. No revisions were omitted.')
    # Equal hash labels alone cannot prove that every historical BLOB is still
    # intact. Compare duplicate rows inside SQLite before reusing canonical
    # bytes; return only a boolean, without materializing duplicate PDFs.
    clause, parameters = 'sha256=? AND pdf<>?', [row[5], payload]
    if document_id is not None:
        clause += ' AND document_id=?'; parameters.append(document_id)
    if db.execute('SELECT 1 FROM certification_revisions WHERE ' + clause + ' LIMIT 1', parameters).fetchone():
        raise ValidationError('A retained duplicate certificate PDF failed its integrity check. No historical bytes were replaced.')
    return payload


def _archive_length(metadata, sizes):
    # ZIP_STORED, ASCII filenames, no ZIP64/data descriptors: local headers
    # (30), directory records (46), two copies of each filename, EOCD (22).
    names = ['certificates.json', *('pdf/' + digest + '.pdf' for digest in sizes)]
    return len(metadata) + sum(sizes.values()) + 22 + sum(76 + 2 * len(name) for name in names)


class CertificationProjects:
    def __init__(self, legacy):
        self.legacy = legacy
        self.root = _directory(legacy.store.path.parent / 'certification-projects', create=True)
        self._lock = RLock()
        self._workspaces = {}

    def _workspace(self, token):
        _identity(token, 'Certificate workspace ID')
        with self._lock:
            current = self._workspaces.get(token)
        if current is None:
            raise ValidationError('This certificate workspace is unavailable. Reopen its saved project.')
        return current

    def service(self, token):
        return self._workspace(token)['service']

    def project_id(self, token):
        """Return the portable identity only for a verified project capability."""
        return self._workspace(token)['project_id']

    def response(self, token, value):
        self._workspace(token)
        return _scope_links(value, token)

    def _new(self, project_id=None):
        token = str(uuid.uuid4())
        project_id = project_id or str(uuid.uuid4())
        current = {'service': None, 'project_id': project_id, 'draft': None, 'snapshot': None, 'imports': {}}
        service = CertificationService(Store(self.root / 'workspaces' / token / 'certificates.sqlite3'),
                                       renderer=self.legacy.renderer, coverer=self.legacy.coverer, covers=self.legacy.covers,
                                       precommit=lambda db, identity: self._guard(current, db, identity))
        current['service'] = service
        with self._lock:
            self._workspaces[token] = current
        return token, current

    def view(self, token):
        current = self._workspace(token)
        return {'workspace_id': token, 'project_id': current['project_id'],
                'draft': deepcopy(current['draft']), 'snapshot': deepcopy(current['snapshot']),
                **current['service'].list_documents()}

    def new(self):
        token, _ = self._new()
        self.capture({'workspace_id': token, 'draft': None})
        return self.view(token)

    def discard(self, token):
        self._workspace(token)
        with self._lock:
            self._workspaces.pop(token, None)
        # Keep private files for recovery; dropping a prepared capability must
        # never recursively delete assets which another operation may be reading.
        return {'discarded': True}

    @staticmethod
    def _guard(current, db, selected_id, *, imports=None):
        """Reject an unexportable proposed write inside its SQLite transaction.

        CRUD calls this after their tentative SQL writes and before commit;
        rejection rolls back fields, versions, PDF revisions and request IDs.
        Historical successful replay branches return before this callback.
        """
        if db.execute('SELECT COUNT(*) FROM certification_documents').fetchone()[0] > MAX_DOCUMENTS:
            raise ValidationError('This project supports at most 100 certification documents. No new document was saved.')
        _, sizes = _pdf_inventory(db)
        row = db.execute('SELECT fields,version,options FROM certification_documents WHERE id=?', (selected_id,)).fetchone()
        options = json.loads(row[2])
        options.setdefault('signature_image', None); options.setdefault('signature_name', '')
        selected = {'id': selected_id, 'version': row[1], 'fields': json.loads(row[0]), 'options': options}
        raw_size = db.execute('SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(create_options AS BLOB)),0)),0) FROM certification_documents').fetchone()[0]
        raw_size += db.execute('SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(company AS BLOB))+LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(cover_settings AS BLOB)),0)),0) FROM certification_revisions').fetchone()[0]
        raw_size += len(_json(selected).encode('utf-8'))
        if raw_size > MAX_METADATA_BYTES or raw_size + sum(sizes.values()) > MAX_ARCHIVE_BYTES:
            raise ValidationError('This change exceeds the project certificate archive limit. No document or revision was saved.')
        documents = [dict(zip(DOCUMENT_COLUMNS, row)) for row in db.execute('SELECT ' + ','.join(DOCUMENT_COLUMNS) + ' FROM certification_documents ORDER BY id')]
        revisions = [dict(zip(REVISION_COLUMNS, row)) for row in db.execute('SELECT ' + ','.join(REVISION_COLUMNS) + ' FROM certification_revisions ORDER BY document_id,revision')]
        metadata = _json({'version': 1, 'project_id': current['project_id'], 'draft': selected,
                          'imports': current['imports'] if imports is None else imports,
                          'documents': documents, 'revisions': revisions}).encode('utf-8')
        if len(metadata) > MAX_METADATA_BYTES or _archive_length(metadata, sizes) > MAX_ARCHIVE_BYTES:
            raise ValidationError('This change exceeds the encoded project certificate archive limit. No document or revision was saved.')

    def import_legacy(self, token, document_id):
        """Explicitly copy one selected legacy document; never infer ownership."""
        _identity(document_id)
        with self._lock:
            current = self._workspace(token)
            service = current['service']
            if document_id in current['imports']:
                return {'document': self.response(token, service.get(current['imports'][document_id])),
                        'already_imported': True}
            with self.legacy.store.connect() as source:
                source.execute('BEGIN')
                document = source.execute('SELECT ' + ','.join(DOCUMENT_COLUMNS) + ' FROM certification_documents WHERE id=?', (document_id,)).fetchone()
                if document is None:
                    raise CertificationNotFound('This older certification document could not be found.')
                count, source_sizes = _pdf_inventory(source, 'WHERE document_id=?', (document_id,))
                metadata_size = source.execute(
                    'SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(company AS BLOB))+'
                    'LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(cover_settings AS BLOB)),0)),0) '
                    'FROM certification_revisions WHERE document_id=?', (document_id,)).fetchone()[0]
                metadata_size += sum(len(str(item).encode('utf-8')) for item in document)
                if (count > MAX_REVISIONS or metadata_size > MAX_METADATA_BYTES
                        or sum(source_sizes.values()) + metadata_size > MAX_ARCHIVE_BYTES):
                    raise ValidationError('The older certificate exceeds this project archive limit. No PDF data was loaded or imported.')
                revisions = source.execute('SELECT ' + ','.join(REVISION_COLUMNS) + ' FROM certification_revisions WHERE document_id=? ORDER BY revision', (document_id,)).fetchall()
                pdfs = {}
                for row in revisions:
                    if row[5] not in pdfs:
                        pdfs[row[5]] = _pdf_bytes(source, row, document_id=document_id)
            try:
                with service.store.connect() as destination:
                    destination.execute('BEGIN IMMEDIATE')
                    if destination.execute('SELECT 1 FROM certification_documents WHERE id=?', (document_id,)).fetchone():
                        raise CertificationConflict('This certificate ID already exists in this project without the same import receipt. No records were replaced.')
                    document_count = destination.execute('SELECT COUNT(*) FROM certification_documents').fetchone()[0]
                    count, sizes = _pdf_inventory(destination)
                    for digest, size in source_sizes.items():
                        sizes[digest] = max(size, sizes.get(digest, 0))
                    metadata_size = destination.execute('SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(create_options AS BLOB)),0)),0) FROM certification_documents').fetchone()[0]
                    metadata_size += destination.execute('SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(company AS BLOB))+LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(cover_settings AS BLOB)),0)),0) FROM certification_revisions').fetchone()[0]
                    metadata_size += sum(len(str(item).encode('utf-8')) for item in document)
                    metadata_size += sum(sum(len(str(item).encode('utf-8')) for item in row) for row in revisions)
                    if (document_count >= MAX_DOCUMENTS or count + len(revisions) > MAX_REVISIONS
                            or metadata_size > MAX_METADATA_BYTES or metadata_size + sum(sizes.values()) > MAX_ARCHIVE_BYTES):
                        raise ValidationError('Import would exceed this project certificate archive limit. No document or revision was imported.')
                    destination.execute('INSERT INTO certification_documents (' + ','.join(DOCUMENT_COLUMNS) + ') VALUES(' + ','.join('?' for _ in DOCUMENT_COLUMNS) + ')', document)
                    for row in revisions:
                        destination.execute('INSERT INTO certification_revisions (' + ','.join(REVISION_COLUMNS) + ',pdf) VALUES(' + ','.join('?' for _ in (*REVISION_COLUMNS, 'pdf')) + ')', (*row, pdfs[row[5]]))
                    self._guard(current, destination, document_id, imports={**current['imports'], document_id: document_id})
            except sqlite3.IntegrityError as error:
                raise CertificationConflict('This older certificate conflicts with an existing project identity or operation receipt. No records were replaced.') from error
            current['imports'][document_id] = document_id
            return {'document': self.response(token, service.get(document_id)), 'already_imported': False}

    def capture(self, value):
        with self._lock:
            return self._capture(value)

    def _capture(self, value):
        if not isinstance(value, dict) or set(value) != {'workspace_id', 'draft'}:
            raise ValidationError('Save the current certificate workspace and draft together.')
        current = self._workspace(value['workspace_id'])
        draft = _draft(value['draft'])
        service = current['service']
        with service.store.connect() as db:
            db.execute('BEGIN')
            document_count = db.execute('SELECT COUNT(*) FROM certification_documents').fetchone()[0]
            count, sizes = _pdf_inventory(db)
            if document_count > MAX_DOCUMENTS or count > MAX_REVISIONS or sum(sizes.values()) > MAX_ARCHIVE_BYTES:
                raise ValidationError('The project certificate archive exceeds its supported limits. No revisions were omitted.')
            metadata_size = db.execute('SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(create_options AS BLOB)),0)),0) FROM certification_documents').fetchone()[0]
            metadata_size += db.execute('SELECT COALESCE(SUM(LENGTH(CAST(fields AS BLOB))+LENGTH(CAST(company AS BLOB))+LENGTH(CAST(options AS BLOB))+COALESCE(LENGTH(CAST(cover_settings AS BLOB)),0)),0) FROM certification_revisions').fetchone()[0]
            metadata_size += len(_json(draft).encode('utf-8'))
            if metadata_size > MAX_METADATA_BYTES:
                raise ValidationError('The project certificate metadata exceeds its supported limit. No document or PDF data was loaded or omitted.')
            documents = [dict(zip(DOCUMENT_COLUMNS, row)) for row in db.execute(
                'SELECT ' + ','.join(DOCUMENT_COLUMNS) + ' FROM certification_documents ORDER BY id')]
            if len(documents) > MAX_DOCUMENTS:
                raise ValidationError('A project supports at most 100 certification documents.')
            if draft and draft['id'] is not None:
                saved = service._get(db, draft['id'])
                if saved['version'] != draft['version']:
                    raise CertificationConflict('This certificate changed while saving the project. Reload the certificate and try again.')
            revisions, pdfs = [], {}
            total = 0
            for row in db.execute('SELECT ' + ','.join(REVISION_COLUMNS) + ' FROM certification_revisions ORDER BY document_id,revision'):
                revision = dict(zip(REVISION_COLUMNS, row))
                payload = pdfs.get(revision['sha256'])
                if payload is None:
                    payload = _pdf_bytes(db, row)
                total += len(payload) if revision['sha256'] not in pdfs else 0
                if len(revisions) >= MAX_REVISIONS or total > MAX_ARCHIVE_BYTES:
                    raise ValidationError('The project certificate archive exceeds 1,000 revisions or 256 MB. No revisions were omitted.')
                revisions.append(revision); pdfs[revision['sha256']] = payload
        metadata = _json({'version': 1, 'project_id': current['project_id'], 'draft': draft, 'imports': current['imports'],
                          'documents': documents, 'revisions': revisions}).encode('utf-8')
        if len(metadata) > MAX_METADATA_BYTES or total + len(metadata) > MAX_ARCHIVE_BYTES:
            raise ValidationError('The project certificate archive exceeds its supported size. No revisions were omitted.')
        stream = BytesIO()
        with ZipFile(stream, 'w', compression=ZIP_STORED) as archive:
            for name, payload in [('certificates.json', metadata), *[(f'pdf/{key}.pdf', pdfs[key]) for key in sorted(pdfs)]]:
                archive.writestr(ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), payload)
        payload = stream.getvalue()
        if len(payload) > MAX_ARCHIVE_BYTES:
            raise ValidationError('The project certificate archive must be at most 256 MB. No revisions were omitted.')
        digest = sha256(payload).hexdigest()
        path = self.root / 'archives' / (digest + '.zip')
        _write_archive(path, payload, digest)
        snapshot = {'version': 1, 'project_id': current['project_id'], 'archive_sha256': digest,
                    'archive_size': len(payload), 'document_count': len(documents), 'revision_count': len(revisions),
                    'companion_folder': f".ceasefire-evidence/{current['project_id']}/certifications"}
        current.update(draft=deepcopy(draft), snapshot=snapshot)
        return deepcopy(snapshot)

    def publish(self, snapshot, project_path):
        snapshot = validate_manifest(snapshot)
        parent = _directory(Path(project_path).absolute().parent)
        name = snapshot['archive_sha256'] + '.zip'
        target = parent / '.ceasefire-evidence' / snapshot['project_id'] / 'certifications' / name
        _copy(self.root / 'archives' / name, target, snapshot['archive_sha256'], snapshot['archive_size'])
        return snapshot

    def restore(self, snapshot, project_path=None):
        if snapshot is None:
            return self.new()
        snapshot = validate_manifest(snapshot)
        if project_path is None:
            # A browser upload has no trustworthy filesystem path. It may use
            # an exact immutable archive already verified in this runtime;
            # it may never infer or search for another external companion.
            source = self.root / 'archives' / (snapshot['archive_sha256'] + '.zip')
        else:
            # Native Load always verifies the selected file's own portable
            # companion, even if the same archive also exists in our cache.
            parent = _directory(Path(project_path).absolute().parent)
            source = parent / '.ceasefire-evidence' / snapshot['project_id'] / 'certifications' / (snapshot['archive_sha256'] + '.zip')
        try:
            with _open_regular(source, MAX_ARCHIVE_BYTES) as stream:
                payload = stream.read(MAX_ARCHIVE_BYTES + 1)
        except ValidationError as error:
            if project_path is None:
                raise ValidationError('This project certificate archive is not available locally. Use Load Project to open its .cf.json file together with its .ceasefire-evidence companion folder; no certificate evidence was omitted.') from error
            raise ValidationError('The saved certificate companion archive is missing or unavailable. Keep the .ceasefire-evidence folder beside this project; no certificate revisions were discarded.') from error
        if len(payload) != snapshot['archive_size'] or sha256(payload).hexdigest() != snapshot['archive_sha256']:
            raise ValidationError('The saved certificate companion failed its exact size or SHA-256 check.')
        metadata, pdfs = self._read_archive(payload, snapshot)
        token, current = self._new(snapshot['project_id'])
        try:
            with current['service'].store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                for row in metadata['documents']:
                    db.execute('INSERT INTO certification_documents (' + ','.join(DOCUMENT_COLUMNS) + ') VALUES(' + ','.join('?' for _ in DOCUMENT_COLUMNS) + ')',
                               tuple(row[key] for key in DOCUMENT_COLUMNS))
                for row in metadata['revisions']:
                    db.execute('INSERT INTO certification_revisions (' + ','.join(REVISION_COLUMNS) + ',pdf) VALUES(' + ','.join('?' for _ in (*REVISION_COLUMNS, 'pdf')) + ')',
                               (*[row[key] for key in REVISION_COLUMNS], pdfs[row['sha256']]))
            current.update(draft=metadata['draft'], snapshot=snapshot, imports=metadata.get('imports', {}))
            _write_archive(self.root / 'archives' / (snapshot['archive_sha256'] + '.zip'), payload, snapshot['archive_sha256'])
            return self.view(token)
        except Exception:
            self.discard(token)
            raise

    @staticmethod
    def _read_archive(payload, snapshot):
        from .project_file import _unique_object, _reject_constant, _check_tree
        try:
            with ZipFile(BytesIO(payload), 'r') as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                if len(names) != len(set(names)) or 'certificates.json' not in names or len(names) > MAX_REVISIONS + 1:
                    raise ValueError('Invalid certificate archive entries')
                if any(entry.compress_type != ZIP_STORED or entry.flag_bits & 1 or entry.file_size != entry.compress_size for entry in entries):
                    raise ValueError('Certificate archives must contain bounded uncompressed data')
                info = archive.getinfo('certificates.json')
                if info.file_size > MAX_METADATA_BYTES:
                    raise ValueError('Certificate metadata exceeds its limit')
                metadata = json.loads(archive.read(info).decode('utf-8'), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
                _check_tree(metadata)
                if (not isinstance(metadata, dict) or set(metadata) not in ({'version', 'project_id', 'draft', 'documents', 'revisions'}, {'version', 'project_id', 'draft', 'imports', 'documents', 'revisions'})
                        or type(metadata['version']) is not int or metadata['version'] != 1 or metadata['project_id'] != snapshot['project_id']):
                    raise ValueError('Certificate archive identity mismatch')
                documents, revisions = metadata['documents'], metadata['revisions']
                if not isinstance(documents, list) or len(documents) != snapshot['document_count'] or not isinstance(revisions, list) or len(revisions) != snapshot['revision_count']:
                    raise ValueError('Certificate archive counts mismatch')
                ids, create_requests = {}, set()
                for row in documents:
                    if not isinstance(row, dict) or set(row) != set(DOCUMENT_COLUMNS):
                        raise ValueError('Invalid certificate document')
                    _identity(row['id']); _version(row['version'])
                    if row['id'] in ids:
                        raise ValueError('Duplicate certificate identity')
                    ids[row['id']] = row
                    validate_fields(json.loads(row['fields'])); validate_options(json.loads(row['options']))
                    if row['create_options'] is not None:
                        validate_options(json.loads(row['create_options']))
                    for name in ('created_at', 'updated_at'):
                        if not isinstance(row[name], str) or not 1 <= len(row[name]) <= 100:
                            raise ValueError('Invalid certificate timestamp')
                    if row['create_request_id'] is not None:
                        _identity(row['create_request_id'])
                        if row['create_request_id'] in create_requests:
                            raise ValueError('Duplicate certificate operation')
                        create_requests.add(row['create_request_id'])
                    if (row['create_request_fingerprint'] is None and row['create_request_id'] is not None
                            or row['create_request_fingerprint'] is not None and (not isinstance(row['create_request_fingerprint'], str) or not HASH.fullmatch(row['create_request_fingerprint']))):
                        raise ValueError('Invalid certificate creation receipt')
                expected_names, pdfs, sequence, receipts = {'certificates.json'}, {}, {}, set()
                for row in revisions:
                    if not isinstance(row, dict) or set(row) != set(REVISION_COLUMNS) or row['document_id'] not in ids:
                        raise ValueError('Invalid certificate revision')
                    _version(row['revision']); _identity(row['request_id'])
                    identifier = row['document_id']
                    if row['revision'] != sequence.get(identifier, 0) + 1 or (identifier, row['request_id']) in receipts:
                        raise ValueError('Invalid certificate revision sequence or request receipt')
                    sequence[identifier] = row['revision']; receipts.add((identifier, row['request_id']))
                    if row['revision'] >= ids[identifier]['version']:
                        raise ValueError('Certificate revision exceeds document version')
                    for name in ('sha256', 'request_fingerprint'):
                        if not isinstance(row[name], str) or not HASH.fullmatch(row[name]):
                            raise ValueError('Invalid certificate revision digest')
                    if not isinstance(row['created_at'], str) or not 1 <= len(row['created_at']) <= 100:
                        raise ValueError('Invalid certificate revision timestamp')
                    validate_fields(json.loads(row['fields'])); validate_options(json.loads(row['options']))
                    # These are frozen historical snapshots, not current global
                    # settings. Retain their exact JSON and original PDF bytes.
                    if not isinstance(json.loads(row['company']), dict) or row['cover_settings'] is not None and not isinstance(json.loads(row['cover_settings']), dict):
                        raise ValueError('Invalid frozen certificate settings')
                    name = 'pdf/' + row['sha256'] + '.pdf'; expected_names.add(name)
                    if row['sha256'] not in pdfs:
                        info = archive.getinfo(name)
                        if not 1 <= info.file_size <= MAX_REVISION_BYTES:
                            raise ValueError('Certificate PDF exceeds its limit')
                        data = archive.read(info)
                        if not data.startswith(b'%PDF-') or sha256(data).hexdigest() != row['sha256']:
                            raise ValueError('Certificate PDF hash mismatch')
                        pdfs[row['sha256']] = data
                if set(names) != expected_names:
                    raise ValueError('Unexpected certificate archive entry')
                imports = metadata.get('imports', {})
                if not isinstance(imports, dict) or len(imports) > len(documents):
                    raise ValueError('Invalid explicit certificate import receipts')
                for source_id, destination_id in imports.items():
                    _identity(source_id); _identity(destination_id)
                    if source_id != destination_id or destination_id not in ids:
                        raise ValueError('Certificate import receipt does not identify a retained document')
                metadata['draft'] = _draft(metadata['draft'])
                if metadata['draft'] and metadata['draft']['id'] is not None:
                    doc = ids.get(metadata['draft']['id'])
                    if doc is None or metadata['draft']['version'] != doc['version']:
                        raise ValueError('The archived current draft belongs to another document version')
                return metadata, pdfs
        except (BadZipFile, KeyError, ValueError, TypeError, UnicodeError, RecursionError, ValidationError) as error:
            raise ValidationError('The saved certificate archive is invalid or incomplete. No project certificate state was replaced.') from error
