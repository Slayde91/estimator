"""Editable certification documents and immutable, idempotent PDF revisions.

Certification text is user-entered evidence. This service does not infer a
standard, a fire resistance level, approval, qualification or accreditation.
"""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import uuid

from pypdf import PdfReader

from .catalog import ValidationError


FIELDS = (
    'client', 'project', 'address', 'location_area', 'statement_of_compliance',
    'australian_standards', 'ncc_clauses', 'approved_design', 'additional_standards',
    'other_references', 'exclusions', 'materials_manufacturers',
    'fire_resistance_level', 'name', 'position', 'qualification', 'accreditation',
)
MAX_FIELD_CHARS = 8_000
MAX_TOTAL_CHARS = 40_000
MAX_REVISION_BYTES = 40 * 1024 * 1024
SIGNER_FIELDS = ('name', 'position', 'qualification', 'accreditation')
REQUIRED_GENERATION_FIELDS = FIELDS[:13]
SCOPE_IDS = frozenset(('structural_steel', 'structural_steel_columns', 'ductwork', 'service_penetrations'))
DEFAULT_OPTIONS = {'cover_pdf': None, 'cover_pdf_name': '', 'scopes': []}
_MISSING = object()


class CertificationConflict(ValidationError):
    """The document changed or an operation ID was reused for different text."""


class CertificationNotFound(ValidationError):
    """The requested document or saved revision does not exist."""


def validate_fields(value, *, partial=False):
    if not isinstance(value, dict) or set(value) - set(FIELDS) or (not partial and set(value) != set(FIELDS)):
        raise ValidationError('Include the editable certification fields only.')
    result = {}
    for key in FIELDS:
        text = value.get(key, '')
        if (not isinstance(text, str) or len(text) > MAX_FIELD_CHARS
                or any((ord(char) < 32 and char not in '\r\n\t') or 0xD800 <= ord(char) <= 0xDFFF for char in text)):
            raise ValidationError('Certification fields must be text of at most 8,000 characters each.')
        result[key] = text.replace('\r\n', '\n').replace('\r', '\n')
    if sum(map(len, result.values())) > MAX_TOTAL_CHARS:
        raise ValidationError('Certification details must contain at most 40,000 characters in total.')
    return result


def validate_options(value):
    """Keep legacy option shapes; new clients snapshot signer artwork explicitly."""
    signature_keys = {'signature_image', 'signature_name'}
    if not isinstance(value, dict) or set(value) not in (set(DEFAULT_OPTIONS), set(DEFAULT_OPTIONS) | signature_keys):
        raise ValidationError('Include the certificate cover, cover filename and selected scopes only.')
    name = value['cover_pdf_name']
    if (not isinstance(name, str) or len(name) > 200
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in name)
            or any(char in name for char in '/\\')):
        raise ValidationError('The certificate cover filename is invalid.')
    scopes = value['scopes']
    if (not isinstance(scopes, list) or len(scopes) > len(SCOPE_IDS)
            or any(not isinstance(scope, str) or scope not in SCOPE_IDS for scope in scopes)
            or len(set(scopes)) != len(scopes)):
        raise ValidationError('Choose each supported certification scope at most once.')
    from .pdf_cover import validate_cover_pdf
    cover, name = validate_cover_pdf(value['cover_pdf'], name)
    result = {'cover_pdf': cover, 'cover_pdf_name': name, 'scopes': scopes[:]}
    if signature_keys <= set(value):
        from .certification_signature import validate_signature
        result['signature_image'], result['signature_name'] = validate_signature(value['signature_image'], value['signature_name'])
    return result


def validate_signer_fields(value):
    if not isinstance(value, dict) or set(value) != set(SIGNER_FIELDS):
        raise ValidationError('Include name, position, qualification and accreditation only.')
    normalized = validate_fields(value, partial=True)
    return {key: normalized[key] for key in SIGNER_FIELDS}


def _identity(value, label='Certification ID'):
    try:
        valid = isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError, TypeError):
        valid = False
    if not valid:
        raise ValidationError(f'{label} must be a valid UUID.')
    return value


def _version(value):
    if type(value) is not int or not 1 <= value <= 2_147_483_647:
        raise ValidationError('Include the current certification version.')
    return value


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _fingerprint(value):
    return sha256(_json(value).encode('utf-8')).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _revision_metadata(document_id, row):
    number, created_at, digest = row
    return {'revision': number, 'created_at': created_at, 'sha256': digest,
            'pdf_url': f'/api/certifications/{document_id}/revisions/{number}.pdf'}


class CertificationService:
    def __init__(self, store, *, renderer=None, coverer=None, covers=None, precommit=None):
        self.store = store
        self.renderer = renderer
        self.coverer = coverer
        self.precommit = precommit
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS certification_documents (
                    id TEXT PRIMARY KEY, fields TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK(version >= 1),
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    create_request_id TEXT UNIQUE, create_request_fingerprint TEXT
                );
                CREATE TABLE IF NOT EXISTS certification_revisions (
                    document_id TEXT NOT NULL REFERENCES certification_documents(id),
                    revision INTEGER NOT NULL CHECK(revision >= 1),
                    created_at TEXT NOT NULL, fields TEXT NOT NULL,
                    company TEXT NOT NULL, pdf BLOB NOT NULL, sha256 TEXT NOT NULL,
                    request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
                    PRIMARY KEY(document_id, revision), UNIQUE(document_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS certification_signer_defaults (
                    id INTEGER PRIMARY KEY CHECK(id=1), fields TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK(version >= 1), updated_at TEXT NOT NULL
                );
            ''')
            # Existing fields-only documents/revisions keep their identities,
            # fingerprints and frozen PDFs. New metadata is purely additive.
            db.execute('BEGIN IMMEDIATE')
            for table in ('certification_documents', 'certification_revisions'):
                columns = {row[1] for row in db.execute('PRAGMA table_info('+table+')')}
                if 'options' not in columns:
                    db.execute('ALTER TABLE '+table+" ADD COLUMN options TEXT NOT NULL DEFAULT '"+_json(DEFAULT_OPTIONS)+"'")
            columns = {row[1] for row in db.execute('PRAGMA table_info(certification_documents)')}
            if 'create_options' not in columns:
                db.execute('ALTER TABLE certification_documents ADD COLUMN create_options TEXT')
            columns = {row[1] for row in db.execute('PRAGMA table_info(certification_signer_defaults)')}
            if 'signature_image' not in columns:
                db.execute('ALTER TABLE certification_signer_defaults ADD COLUMN signature_image TEXT')
                db.execute("ALTER TABLE certification_signer_defaults ADD COLUMN signature_name TEXT NOT NULL DEFAULT ''")
            columns = {row[1] for row in db.execute('PRAGMA table_info(certification_revisions)')}
            if 'cover_settings' not in columns:
                db.execute('ALTER TABLE certification_revisions ADD COLUMN cover_settings TEXT')
            if db.execute('SELECT 1 FROM certification_signer_defaults WHERE id=1').fetchone() is None:
                latest = db.execute('SELECT fields FROM certification_documents '
                                    'ORDER BY updated_at DESC,id LIMIT 1').fetchone()
                source = json.loads(latest[0]) if latest else {}
                signer = validate_signer_fields({key: source.get(key, '') for key in SIGNER_FIELDS})
                db.execute('INSERT INTO certification_signer_defaults(id,fields,version,updated_at) VALUES(1,?,?,?)',
                           (_json(signer), 1, _now()))
        from .pdf_download_covers import PdfDownloadCovers
        self.covers = covers or PdfDownloadCovers(store)

    @staticmethod
    def _get(db, document_id):
        row = db.execute('SELECT fields,version,created_at,updated_at,options FROM certification_documents WHERE id=?',
                         (document_id,)).fetchone()
        if row is None:
            raise CertificationNotFound('This certification document could not be found.')
        revisions = db.execute('SELECT revision,created_at,sha256 FROM certification_revisions '
                               'WHERE document_id=? ORDER BY revision DESC', (document_id,)).fetchall()
        return {'id': document_id, 'fields': json.loads(row[0]), 'version': row[1], 'options': json.loads(row[4]),
                'created_at': row[2], 'updated_at': row[3],
                'revisions': [_revision_metadata(document_id, item) for item in revisions]}

    def list_documents(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT d.id,d.fields,d.version,d.created_at,d.updated_at,COUNT(r.revision) '
                              'FROM certification_documents d LEFT JOIN certification_revisions r '
                              'ON r.document_id=d.id GROUP BY d.id ORDER BY d.updated_at DESC,d.id').fetchall()
        items = []
        for identity, raw, version, created_at, updated_at, count in rows:
            fields = json.loads(raw)
            items.append({'id': identity, 'client': fields['client'], 'project': fields['project'],
                          'address': fields['address'], 'version': version, 'created_at': created_at,
                          'updated_at': updated_at, 'revision_count': count,
                          'label': fields['project'].strip() or fields['client'].strip() or 'Untitled certification'})
        return {'items': items}

    def create(self, fields, request_id=None, *, options=_MISSING):
        """Return a stable creation receipt; get() reads current draft state."""
        fields = validate_fields(fields, partial=True)
        if request_id is not None:
            _identity(request_id, 'Create operation ID')
        supplied_options = options is not _MISSING
        options = validate_options(options) if supplied_options else deepcopy(DEFAULT_OPTIONS)
        # Preserve the exact old fingerprint format for old clients/retries.
        fingerprint = _fingerprint({'fields': fields, 'options': options}) if supplied_options else _fingerprint(fields)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if request_id is not None:
                old = db.execute('SELECT id,create_request_fingerprint,created_at,create_options FROM certification_documents '
                                 'WHERE create_request_id=?', (request_id,)).fetchone()
                if old:
                    if old[1] != fingerprint:
                        raise CertificationConflict('This create operation was already used with different certification details.')
                    # Replay the original creation receipt, not a newer draft.
                    # A lost-response caller retains its original fields and
                    # version; its automatic Generate must still conflict if
                    # another window has since changed this document. GET is
                    # the separate source of fresh current document state.
                    return {'id': old[0], 'fields': json.loads(_json(fields)), 'version': 1,
                            'options': json.loads(old[3]) if old[3] is not None else deepcopy(DEFAULT_OPTIONS),
                            'created_at': old[2], 'updated_at': old[2], 'revisions': []}
            identity, timestamp = str(uuid.uuid4()), _now()
            db.execute('INSERT INTO certification_documents '
                       '(id,fields,version,created_at,updated_at,create_request_id,create_request_fingerprint,options,create_options) '
                       'VALUES(?,?,?,?,?,?,?,?,?)',
                       (identity, _json(fields), 1, timestamp, timestamp, request_id, fingerprint,
                        _json(options), _json(options)))
            if self.precommit is not None:
                self.precommit(db, identity)
            return self._get(db, identity)

    def get(self, document_id):
        _identity(document_id)
        with self.store.connect() as db:
            db.execute('BEGIN')
            return self._get(db, document_id)

    def save(self, document_id, fields, expected_version, *, options=_MISSING):
        _identity(document_id); _version(expected_version)
        fields = validate_fields(fields)
        if options is not _MISSING:
            options = validate_options(options)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._get(db, document_id)
            selected_options = current['options'] if options is _MISSING else options
            # An acknowledged or lost-response retry that already matches the
            # latest draft has nothing to overwrite, even if its version aged.
            if current['fields'] == fields and current['options'] == selected_options:
                return current
            if current['version'] != expected_version:
                raise CertificationConflict('This certification changed in another window. Reload it before saving again.')
            db.execute('UPDATE certification_documents SET fields=?,options=?,version=version+1,updated_at=? WHERE id=?',
                       (_json(fields), _json(selected_options), _now(), document_id))
            if self.precommit is not None:
                self.precommit(db, document_id)
            return self._get(db, document_id)

    @staticmethod
    def _defaults(db):
        fields, version, image, name = db.execute('SELECT fields,version,signature_image,signature_name FROM certification_signer_defaults WHERE id=1').fetchone()
        return {'fields': json.loads(fields), 'version': version, 'signature_image': image, 'signature_name': name}

    def get_defaults(self):
        with self.store.connect() as db:
            return self._defaults(db)

    def save_defaults(self, fields, expected_version, *, signature_image=_MISSING, signature_name=_MISSING):
        fields = validate_signer_fields(fields); _version(expected_version)
        if (signature_image is _MISSING) != (signature_name is _MISSING):
            raise ValidationError('Include both the signature image and filename.')
        if signature_image is not _MISSING:
            from .certification_signature import validate_signature
            signature_image, signature_name = validate_signature(signature_image, signature_name)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._defaults(db)
            image = current['signature_image'] if signature_image is _MISSING else signature_image
            name = current['signature_name'] if signature_name is _MISSING else signature_name
            if current['fields'] == fields and current['signature_image'] == image and current['signature_name'] == name:
                return current
            if current['version'] != expected_version:
                raise CertificationConflict('The saved signer details changed in another window. Reload them before saving again.')
            db.execute('UPDATE certification_signer_defaults SET fields=?,signature_image=?,signature_name=?,version=version+1,updated_at=? WHERE id=1',
                       (_json(fields), image, name, _now()))
            return self._defaults(db)

    @staticmethod
    def _replay(db, document_id, request_id, fingerprint):
        row = db.execute('SELECT revision,created_at,sha256,request_fingerprint FROM certification_revisions '
                         'WHERE document_id=? AND request_id=?', (document_id, request_id)).fetchone()
        if row is None:
            return None
        if row[3] != fingerprint:
            raise CertificationConflict('This generation operation was already used with different certification details.')
        return _revision_metadata(document_id, row[:3])

    def generate(self, document_id, fields, expected_version, request_id, company, *, options=_MISSING):
        _identity(document_id); _identity(request_id, 'Generation operation ID'); _version(expected_version)
        fields = validate_fields(fields)
        supplied_options = options is not _MISSING
        if supplied_options:
            options = validate_options(options)
        request = {'fields': fields, 'expected_version': expected_version}
        if supplied_options:
            request['options'] = options
        fingerprint = _fingerprint(request)
        # Capture and render outside the write transaction: a large cover or
        # long user entry must not hold up unrelated project saves.
        with self.store.connect() as db:
            db.execute('BEGIN')
            current = self._get(db, document_id)
            replay = self._replay(db, document_id, request_id, fingerprint)
            if replay:
                return {'document': current, 'revision': replay}
            # Historical committed requests remain recoverable even if their
            # older drafts were incomplete. Only a new revision must satisfy
            # today's required certificate details.
            missing = [key.replace('_', ' ') for key in REQUIRED_GENERATION_FIELDS if not fields[key].strip()]
            if missing:
                raise ValidationError('Complete all required certification fields before generating: ' + ', '.join(missing) + '.')
            if current['version'] != expected_version:
                raise CertificationConflict('This certification changed in another window. Reload it before generating again.')
            revision = max((item['revision'] for item in current['revisions']), default=0) + 1
            selected_options = deepcopy(current['options'] if options is _MISSING else options)
        from .company_settings import validate_company_settings
        company = deepcopy(company)
        company = validate_company_settings(company)
        cover_snapshot = self.covers.get('certification')
        from .certification_report import render_certificate_pdf
        from .pdf_cover import prepend_cover_pdf
        timestamp = _now()
        signature = {'signature': selected_options['signature_image']} if selected_options.get('signature_image') else {}
        payload = (self.renderer or render_certificate_pdf)(deepcopy(fields), company=deepcopy(company),
                    certificate_id=document_id, revision=revision, created_at=timestamp, **signature)
        # Retain the historical two-argument injectable hook for failure tests;
        # production composes main + explicit global download cover once.
        payload = (self.coverer(payload, deepcopy(company)) if self.coverer else
                   prepend_cover_pdf(payload, deepcopy(company), cover_snapshot))
        if not isinstance(payload, bytes) or not payload.startswith(b'%PDF-') or len(payload) > MAX_REVISION_BYTES:
            raise ValidationError('The certificate PDF could not be created within the supported size.')
        try:
            reader = PdfReader(BytesIO(payload), strict=True)
            if reader.is_encrypted or not 1 <= len(reader.pages) <= 200:
                raise ValueError('Unsupported certificate PDF')
        except Exception as error:
            raise ValidationError('The generated certificate PDF could not be verified.') from error
        digest = sha256(payload).hexdigest()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._get(db, document_id)
            replay = self._replay(db, document_id, request_id, fingerprint)
            if replay:
                return {'document': current, 'revision': replay}
            if current['version'] != expected_version:
                raise CertificationConflict('This certification changed while the PDF was being created. No revision was saved.')
            db.execute('INSERT INTO certification_revisions '
                       '(document_id,revision,created_at,fields,company,pdf,sha256,request_id,request_fingerprint,options,cover_settings) '
                       'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (document_id, revision, timestamp, _json(fields), _json(company), payload,
                        digest, request_id, fingerprint, _json(selected_options), _json(cover_snapshot)))
            db.execute('UPDATE certification_documents SET fields=?,options=?,version=version+1,updated_at=? WHERE id=?',
                       (_json(fields), _json(selected_options), timestamp, document_id))
            if self.precommit is not None:
                self.precommit(db, document_id)
            return {'document': self._get(db, document_id),
                    'revision': _revision_metadata(document_id, (revision, timestamp, digest))}

    def revision_pdf(self, document_id, revision):
        _identity(document_id)
        if type(revision) is not int or not 1 <= revision <= 2_147_483_647:
            raise ValidationError('Choose a saved certificate revision.')
        with self.store.connect() as db:
            row = db.execute('SELECT pdf,sha256 FROM certification_revisions WHERE document_id=? AND revision=?',
                             (document_id, revision)).fetchone()
        if row is None:
            raise CertificationNotFound('This certificate revision could not be found.')
        payload = bytes(row[0])
        if sha256(payload).hexdigest() != row[1]:
            raise ValidationError('The saved certificate PDF failed its integrity check. The stored revision was retained.')
        return payload
