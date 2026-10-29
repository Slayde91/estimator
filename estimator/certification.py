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
    def __init__(self, store, *, renderer=None, coverer=None):
        self.store = store
        self.renderer = renderer
        self.coverer = coverer
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
            ''')

    @staticmethod
    def _get(db, document_id):
        row = db.execute('SELECT fields,version,created_at,updated_at FROM certification_documents WHERE id=?',
                         (document_id,)).fetchone()
        if row is None:
            raise CertificationNotFound('This certification document could not be found.')
        revisions = db.execute('SELECT revision,created_at,sha256 FROM certification_revisions '
                               'WHERE document_id=? ORDER BY revision DESC', (document_id,)).fetchall()
        return {'id': document_id, 'fields': json.loads(row[0]), 'version': row[1],
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

    def create(self, fields, request_id=None):
        """Return a stable creation receipt; get() reads current draft state."""
        fields = validate_fields(fields, partial=True)
        if request_id is not None:
            _identity(request_id, 'Create operation ID')
        fingerprint = _fingerprint(fields)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if request_id is not None:
                old = db.execute('SELECT id,create_request_fingerprint,created_at FROM certification_documents '
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
                            'created_at': old[2], 'updated_at': old[2], 'revisions': []}
            identity, timestamp = str(uuid.uuid4()), _now()
            db.execute('INSERT INTO certification_documents VALUES(?,?,?,?,?,?,?)',
                       (identity, _json(fields), 1, timestamp, timestamp, request_id, fingerprint))
            return self._get(db, identity)

    def get(self, document_id):
        _identity(document_id)
        with self.store.connect() as db:
            db.execute('BEGIN')
            return self._get(db, document_id)

    def save(self, document_id, fields, expected_version):
        _identity(document_id); _version(expected_version)
        fields = validate_fields(fields)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = self._get(db, document_id)
            # An acknowledged or lost-response retry that already matches the
            # latest draft has nothing to overwrite, even if its version aged.
            if current['fields'] == fields:
                return current
            if current['version'] != expected_version:
                raise CertificationConflict('This certification changed in another window. Reload it before saving again.')
            db.execute('UPDATE certification_documents SET fields=?,version=version+1,updated_at=? WHERE id=?',
                       (_json(fields), _now(), document_id))
            return self._get(db, document_id)

    @staticmethod
    def _replay(db, document_id, request_id, fingerprint):
        row = db.execute('SELECT revision,created_at,sha256,request_fingerprint FROM certification_revisions '
                         'WHERE document_id=? AND request_id=?', (document_id, request_id)).fetchone()
        if row is None:
            return None
        if row[3] != fingerprint:
            raise CertificationConflict('This generation operation was already used with different certification details.')
        return _revision_metadata(document_id, row[:3])

    def generate(self, document_id, fields, expected_version, request_id, company):
        _identity(document_id); _identity(request_id, 'Generation operation ID'); _version(expected_version)
        fields = validate_fields(fields)
        fingerprint = _fingerprint({'fields': fields, 'expected_version': expected_version})
        # Capture and render outside the write transaction: a large cover or
        # long user entry must not hold up unrelated project saves.
        with self.store.connect() as db:
            db.execute('BEGIN')
            current = self._get(db, document_id)
            replay = self._replay(db, document_id, request_id, fingerprint)
            if replay:
                return {'document': current, 'revision': replay}
            if current['version'] != expected_version:
                raise CertificationConflict('This certification changed in another window. Reload it before generating again.')
            revision = max((item['revision'] for item in current['revisions']), default=0) + 1
        from .company_settings import validate_company_settings
        company = validate_company_settings(deepcopy(company))
        from .certification_report import render_certificate_pdf
        from .pdf_cover import prepend_cover_pdf
        timestamp = _now()
        payload = (self.renderer or render_certificate_pdf)(deepcopy(fields), company=deepcopy(company),
                    certificate_id=document_id, revision=revision, created_at=timestamp)
        payload = (self.coverer or prepend_cover_pdf)(payload, deepcopy(company))
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
            db.execute('INSERT INTO certification_revisions VALUES(?,?,?,?,?,?,?,?,?)',
                       (document_id, revision, timestamp, _json(fields), _json(company), payload,
                        digest, request_id, fingerprint))
            db.execute('UPDATE certification_documents SET fields=?,version=version+1,updated_at=? WHERE id=?',
                       (_json(fields), timestamp, document_id))
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
