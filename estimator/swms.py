"""Bounded, project-owned SWMS drafts and immutable export receipts."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime, timezone
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import sqlite3
import uuid
from zoneinfo import ZoneInfo

from .catalog import ValidationError
from .company_settings import DEFAULTS
from .evidence_files import _directory

DETAIL_FIELDS = ('job_reference', 'contact_person', 'position', 'phone', 'principal_contractor',
                 'project_name', 'date', 'project_address', 'project_manager', 'manager_contact')
TEXT_FIELDS = ('title', 'template_id', 'template_version', 'communication', 'toolbox', 'compliance',
               'qualifications', 'duties', 'training', 'requirements', 'activity', 'legislation', 'codes',
               'resources', 'equipment', 'maintenance', 'high_risk_work', 'acknowledgement',
               'emergency_requirements', 'emergency_access', 'emergency_notify', 'emergency_contacts',
               'emergency_supervisor', 'emergency_call', 'emergency_stop', 'emergency_follow')
FIELD_KEYS = set(TEXT_FIELDS) | {'details', 'manager_signature', 'reviewers', 'consultation', 'steps', 'work_types',
                               'additional_steps', 'additional_rows', 'signoffs', 'manual_signature', 'site_signoffs', 'reviews', 'attachments'}
STEP_FIELDS = ('job_step', 'hazards', 'initial_risk', 'controls', 'residual_risk', 'responsible')
STATUSES = ('Draft', 'Review', 'Approved', 'Archived')
WORK_TYPES = ('Protective Coatings', 'Passive Firestopping', 'Installation of Passive Fire Protection Works')
MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024
MAX_PDF_BYTES = 64 * 1024 * 1024
PEOPLE_DEFAULT_KEYS = ('reviewers', 'consultation')
MAX_PEOPLE_DEFAULT_BYTES = 1024 * 1024


class SwmsConflict(ValidationError):
    pass


def _identity(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise ValidationError('Choose a valid SWMS identity.') from error
    return value


def _text(value, label, maximum=30000):
    if (not isinstance(value, str) or len(value) > maximum
            or any(ord(char) < 32 and char not in '\n\r\t' or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ValidationError(f'{label} must be text of at most {maximum} characters.')
    return value


def _date(value, label):
    value = _text(value, label, 10)
    if value:
        try:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError
        except ValueError as error:
            raise ValidationError(f'{label} must be a valid date.') from error
    return value


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def validate_signature(value):
    """The same bounded normalised stroke format as the existing signature pad."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'version', 'strokes', 'ratio'} or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('Draw the signature again.')
    ratio = value['ratio']
    if type(ratio) not in (int, float) or not math.isfinite(ratio) or not .1 <= ratio <= 20:
        raise ValidationError('The signature aspect ratio is invalid.')
    strokes = value['strokes']
    if not isinstance(strokes, list) or not 1 <= len(strokes) <= 100:
        raise ValidationError('Draw between 1 and 100 signature strokes.')
    count = 0
    for stroke in strokes:
        if not isinstance(stroke, list) or not stroke:
            raise ValidationError('A signature stroke needs points.')
        count += len(stroke)
        if count > 4000:
            raise ValidationError('A signature supports at most 4,000 points.')
        for point in stroke:
            if (not isinstance(point, list) or len(point) != 2
                    or any(type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 1 for number in point)):
                raise ValidationError('Signature points must stay inside the drawing pad.')
    return deepcopy(value)


def default_fields(details=None, company=None, people_defaults=None):
    fields = json.loads((Path(__file__).resolve().parent.parent / 'data' / 'swms-template.json').read_text(encoding='utf-8'))
    details, company = details or {}, company or DEFAULTS
    options = template_options()
    fields.pop('works_type')
    fields.update(title='Safe Work Method Statement', details=dict.fromkeys(DETAIL_FIELDS, ''), manager_signature=None, contact_signature=None,
                  reviewers=[], consultation=[],
                  additional_steps=False, additional_rows=[], signoffs=[], manual_signature=None, site_signoffs=[], reviews=[''] * 10,
                  emergency_contacts='', work_types=[], steps=options['works'],
                  high_risk_steps=options['high_risk_tables'], attachments=[])
    fields['resources'] = fields['resources'].replace('{company}', company.get('name', ''))
    fields['details'].update(job_reference=details.get('project_no', ''), principal_contractor=details.get('client', ''),
                             project_name=details.get('client', ''), project_address=details.get('site_address', ''),
                             date=datetime.now(ZoneInfo('Australia/Sydney')).date().isoformat())
    # Saved people defaults are retained for old-client compatibility, but each
    # new statement starts with no people or selected work types. Profile details enter a
    # document only after an explicit signature action.
    return validate_fields(fields)


def validate_default_people(rows):
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValidationError('A SWMS supports at most 100 people per section.')
    result = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'name', 'position', 'signature'}:
            raise ValidationError('SWMS person details contain unsupported fields.')
        result.append({'name': _text(row['name'], 'name', 1000), 'position': _text(row['position'], 'position', 1000),
                       'signature': validate_signature(row['signature'])})
    if len(_json(result).encode('utf-8')) > MAX_PEOPLE_DEFAULT_BYTES:
        raise ValidationError('Saved SWMS people and signatures must be smaller than 1 MiB per section.')
    return result


def template_options():
    directory = Path(__file__).resolve().parent.parent / 'data'
    options = json.loads((directory / 'swms-work-types.json').read_text(encoding='utf-8'))
    high_risk = json.loads((directory / 'swms-high-risk.json').read_text(encoding='utf-8'))
    options['high_risk_tables'] = high_risk['tables']
    return options


def _steps(rows, minimum=0):
    if not isinstance(rows, list) or not minimum <= len(rows) <= 200:
        raise ValidationError('A SWMS work type supports up to 200 job steps.')
    result = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != set(STEP_FIELDS):
            raise ValidationError('SWMS job steps contain unsupported fields.')
        clean = {key: _text(row[key], key, 12000) for key in STEP_FIELDS}
        if any(clean[key] not in ('', '1', '2', '3') for key in ('initial_risk', 'residual_risk')):
            raise ValidationError('Choose risk rating 1, 2 or 3 from the template matrix.')
        result.append(clean)
    return result


def validate_fields(fields):
    # Keep old saved drafts compatible with capture and immutable receipts.
    # Optional tables and contact ink stay absent unless present in the input.
    if not isinstance(fields, dict) or set(fields) - {'high_risk_steps', 'contact_signature'} != FIELD_KEYS:
        raise ValidationError('SWMS fields use an unsupported format.')
    result = {key: _text(fields[key], key, 300 if key in {'title', 'template_id', 'template_version'} else 30000) for key in TEXT_FIELDS}
    if not isinstance(fields['details'], dict) or set(fields['details']) != set(DETAIL_FIELDS):
        raise ValidationError('SWMS project details are incomplete.')
    result['details'] = {key: _text(fields['details'][key], key, 1000) for key in DETAIL_FIELDS}
    result['details']['date'] = _date(result['details']['date'], 'Project date')
    for key in ('manager_signature', 'manual_signature'):
        result[key] = validate_signature(fields[key])
    if 'contact_signature' in fields:
        result['contact_signature'] = validate_signature(fields['contact_signature'])
    for key in ('reviewers', 'consultation', 'site_signoffs', 'signoffs'):
        rows = fields[key]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValidationError('A SWMS supports at most 100 people per section.')
        keys = {'name', 'signature'}
        if key in {'reviewers', 'consultation'}:
            keys.add('position')
        if key == 'signoffs':
            keys |= {'company', 'date', 'time', 'latitude', 'longitude'}
        result[key] = []
        for row in rows:
            if not isinstance(row, dict) or set(row) != keys:
                raise ValidationError('SWMS person details contain unsupported fields.')
            clean = {name: validate_signature(value) if name == 'signature' else _text(value, name, 1000) for name, value in row.items()}
            if key == 'signoffs':
                clean['date'] = _date(clean['date'], 'Sign-off date')
                if clean['time'] and not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', clean['time']):
                    raise ValidationError('Sign-off time must be a valid 24-hour time.')
                for name, limit in (('latitude', 90), ('longitude', 180)):
                    if clean[name]:
                        try:
                            coordinate = float(clean[name])
                            if not math.isfinite(coordinate) or not -limit <= coordinate <= limit:
                                raise ValueError
                        except ValueError as error:
                            raise ValidationError('Sign-off coordinates are invalid.') from error
            result[key].append(clean)
    if (not isinstance(fields['work_types'], list)
            or any(value not in WORK_TYPES for value in fields['work_types']) or len(set(fields['work_types'])) != len(fields['work_types'])):
        raise ValidationError('Choose valid work types without duplicates.')
    result['work_types'] = list(fields['work_types'])
    if not isinstance(fields['steps'], dict) or set(fields['steps']) != set(WORK_TYPES):
        raise ValidationError('SWMS work type tables are incomplete.')
    result['steps'] = {key: _steps(rows, minimum=1) for key, rows in fields['steps'].items()}
    if 'high_risk_steps' in fields:
        templates = template_options()['high_risk_tables']
        tables = fields['high_risk_steps']
        if not isinstance(tables, dict) or set(tables) != set(templates):
            raise ValidationError('SWMS high-risk work tables are incomplete.')
        result['high_risk_steps'] = {}
        for key, rows in tables.items():
            if not templates[key] and rows != []:
                raise ValidationError('This high-risk choice has no table in the source template.')
            result['high_risk_steps'][key] = _steps(rows, minimum=1 if templates[key] else 0)
    result['additional_rows'] = _steps(fields['additional_rows'])
    if type(fields['additional_steps']) is not bool:
        raise ValidationError('Choose whether additional job steps are required.')
    result['additional_steps'] = fields['additional_steps']
    if not isinstance(fields['reviews'], list) or len(fields['reviews']) != 10:
        raise ValidationError('The review register needs ten review columns.')
    result['reviews'] = [_text(value, 'Review initials', 100) for value in fields['reviews']]
    if not isinstance(fields['attachments'], list) or len(fields['attachments']) > 10:
        raise ValidationError('A SWMS supports at most ten PDF or image attachments.')
    result['attachments'] = []
    from .company_settings import validate_company_settings
    from .pdf_cover import validate_cover_pdf
    for attachment in fields['attachments']:
        if not isinstance(attachment, dict) or set(attachment) != {'name', 'media_type', 'data'}:
            raise ValidationError('SWMS attachment fields are invalid.')
        name = _text(attachment['name'], 'Attachment name', 160)
        if any(char in name for char in '\\/:') or not name.strip():
            raise ValidationError('Use an attachment filename without path characters.')
        if attachment['media_type'] == 'application/pdf':
            data, name = validate_cover_pdf(attachment['data'], name)
            if data is None:
                raise ValidationError('Choose a PDF attachment.')
        elif attachment['media_type'] in {'image/png', 'image/jpeg'}:
            try:
                data = validate_company_settings({**DEFAULTS, 'logo': attachment['data']})['logo']
            except (OSError, SyntaxError, ValueError) as error:
                raise ValidationError('The SWMS image attachment is damaged or invalid.') from error
            if data is None or not data.startswith('data:' + attachment['media_type'] + ';base64,'):
                raise ValidationError('Choose a valid PNG or JPEG attachment.')
        else:
            raise ValidationError('SWMS attachments support PDF, PNG and JPEG files.')
        result['attachments'].append({'name': name, 'media_type': attachment['media_type'], 'data': data})
    return result


from .document_numbers import DocumentNumbers, valid_reference, validated_counters


def validate_swms_snapshot(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value)-{'reference_counters'} != {'version', 'project_id', 'documents'} or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('SWMS data uses an unsupported project format.')
    _identity(value['project_id'])
    if not isinstance(value['documents'], list) or len(value['documents']) > 50:
        raise ValidationError('A project supports at most 50 SWMS documents.')
    rows, identities = [], set()
    for row in value['documents']:
        if not isinstance(row, dict) or set(row) - {'reference'} != {'id', 'version', 'status', 'fields', 'created_at', 'updated_at'}:
            raise ValidationError('A saved SWMS has unsupported fields.')
        if 'reference' in row and not valid_reference(row['reference']):
            raise ValidationError('The saved SWMS reference is invalid.')
        identity = _identity(row['id'])
        if identity in identities or type(row['version']) is not int or not 1 <= row['version'] <= 1000000000 or row['status'] not in STATUSES:
            raise ValidationError('SWMS identity, version or status is invalid.')
        identities.add(identity)
        clean = {**row, 'fields': validate_fields(row['fields'])}
        for key in ('created_at', 'updated_at'):
            clean[key] = _text(row[key], key, 100)
            try:
                if datetime.fromisoformat(clean[key]).tzinfo is None:
                    raise ValueError
            except ValueError as error:
                raise ValidationError('SWMS timestamps must include their timezone.') from error
        rows.append(clean)
    result = {'version': 1, 'project_id': value['project_id'], 'documents': rows}
    if value.get('reference_counters') is not None:
        result['reference_counters'] = validated_counters(value['reference_counters'], ('swms',))
    if len(_json(result).encode('utf-8')) > MAX_SNAPSHOT_BYTES:
        raise ValidationError('SWMS drafts exceed the 12 MiB project limit.')
    return result


class SwmsDocuments:
    def __init__(self, certifications, root=None, renderer=None):
        self.certifications = certifications
        self.covers = getattr(getattr(certifications, 'legacy', None), 'covers', None)
        self.root = _directory(Path(root) if root else certifications.root.parent / 'swms-documents', create=True)
        self.numbering = getattr(certifications, 'numbering', None) or DocumentNumbers(self.root.parent / 'document-numbers.sqlite3')
        self.path = self.root / 'documents.sqlite3'
        self.renderer = renderer
        with self._connect() as db:
            self.numbering.initialize_history(db)
            db.executescript('''
                CREATE TABLE IF NOT EXISTS swms_workspaces (workspace TEXT PRIMARY KEY, project_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS swms_drafts (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id));
                CREATE TABLE IF NOT EXISTS swms_audit (sequence INTEGER PRIMARY KEY, workspace TEXT NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL, before_data TEXT, after_data TEXT, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS swms_issued (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, filename TEXT NOT NULL, pdf BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS swms_people_defaults (section TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
            ''')
            seed = [{'name': '', 'position': '', 'signature': None},
                    {'name': '', 'position': '', 'signature': None}]
            for section in PEOPLE_DEFAULT_KEYS:
                db.execute('INSERT OR IGNORE INTO swms_people_defaults VALUES(?,1,?)', (section, _json(seed)))

    def people_defaults(self):
        with self._connect() as db:
            return {row['section']: {'version': row['version'], 'rows': json.loads(row['data'])}
                    for row in db.execute('SELECT section,version,data FROM swms_people_defaults')}

    def save_people_defaults(self, workspace, section, rows, expected_version):
        if section not in PEOPLE_DEFAULT_KEYS or type(expected_version) is not int or expected_version < 1:
            raise ValidationError('Choose a valid SWMS people section and saved version.')
        rows = validate_default_people(rows)
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._workspace(db, workspace)
            current = db.execute('SELECT version,data FROM swms_people_defaults WHERE section=?', (section,)).fetchone()
            if current['version'] > 1 and json.loads(current['data']) == rows:
                return {'version': current['version'], 'rows': rows}
            if current['version'] != expected_version:
                raise SwmsConflict('The saved SWMS people changed in another window. Reopen the statement before editing these people again.')
            db.execute('UPDATE swms_people_defaults SET version=version+1,data=? WHERE section=?', (_json(rows), section))
            return {'version': current['version'] + 1, 'rows': rows}

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _workspace(self, db, workspace):
        project = self.certifications.project_id(workspace)
        db.execute('INSERT OR IGNORE INTO swms_workspaces VALUES (?,?)', (workspace, project))
        if db.execute('SELECT project_id FROM swms_workspaces WHERE workspace=?', (workspace,)).fetchone()[0] != project:
            raise SwmsConflict('The SWMS workspace changed projects.')
        return project

    @staticmethod
    def _snapshot(db, workspace, project):
        series = DocumentNumbers.history(db, project)
        return {'version': 1, 'project_id': project, **({'reference_counters':series} if series else {}), 'documents': [json.loads(row[0]) for row in db.execute('SELECT data FROM swms_drafts WHERE workspace=? ORDER BY id', (workspace,))]}

    def capture(self, workspace, expected_snapshot=None):
        with self._connect() as db:
            project = self._workspace(db, workspace)
            snapshot = self._snapshot(db, workspace, project)
        if expected_snapshot is not None and validate_swms_snapshot(expected_snapshot) != snapshot:
            raise SwmsConflict('SWMS documents changed while saving the project. Refresh and save again.')
        return snapshot

    def view(self, workspace):
        snapshot = self.capture(workspace)
        return {'workspace_id': workspace, 'project_id': snapshot['project_id'], 'documents': snapshot['documents'], 'snapshot': snapshot, 'statuses': STATUSES}

    def restore(self, workspace, snapshot):
        snapshot = validate_swms_snapshot(snapshot)
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            if snapshot is not None and snapshot['project_id'] != project:
                raise SwmsConflict('SWMS documents belong to a different project.')
            if snapshot:
                self.numbering.restore_history(db, project, snapshot.get('reference_counters', {}))
            current = self._snapshot(db, workspace, project)
            if current['documents'] and snapshot != current:
                raise SwmsConflict('This SWMS workspace already has drafts. Reopen the project before restoring another snapshot.')
            if not current['documents'] and snapshot:
                for document in snapshot['documents']:
                    if document.get('reference'):
                        self.numbering.assign(db, 'swms', project + ':' + document['id'], document['reference'])
                    db.execute('INSERT INTO swms_drafts VALUES(?,?,?)', (workspace, document['id'], _json(document)))
        return self.view(workspace)

    @staticmethod
    def _record(db, workspace, identity):
        _identity(identity)
        row = db.execute('SELECT data FROM swms_drafts WHERE workspace=? AND id=?', (workspace, identity)).fetchone()
        if row is None:
            raise ValidationError('This SWMS is unavailable in the current project.')
        return json.loads(row[0])

    @staticmethod
    def _version(document, version):
        if type(version) is not int or document['version'] != version:
            raise SwmsConflict('This SWMS changed. Reopen it before saving.')

    @staticmethod
    def _audit(db, workspace, identity, action, before=None, after=None):
        db.execute('INSERT INTO swms_audit(workspace,id,action,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)',
                   (workspace, identity, action, _json(before) if before else None, _json(after) if after else None, datetime.now(timezone.utc).isoformat()))

    def save(self, workspace, payload):
        if not isinstance(payload, dict) or set(payload) != {'id', 'version', 'status', 'fields'} or payload['status'] not in STATUSES:
            raise ValidationError('SWMS save contains unsupported fields or status.')
        identity, fields = _identity(payload['id']), validate_fields(payload['fields'])
        with self._connect() as db:
            self.numbering.attach(db)
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            row = db.execute('SELECT data FROM swms_drafts WHERE workspace=? AND id=?', (workspace, identity)).fetchone()
            previous = json.loads(row[0]) if row else None
            if previous and payload['version'] == 0 and type(payload['version']) is int:
                if previous['fields'] == fields and previous['status'] == payload['status']:
                    return previous
                raise SwmsConflict('This new SWMS was already saved with different content.')
            if previous:
                self._version(previous, payload['version'])
            elif type(payload['version']) is not int or payload['version'] != 0 or db.execute('SELECT 1 FROM swms_audit WHERE workspace=? AND id=?', (workspace, identity)).fetchone():
                raise SwmsConflict('This SWMS is unavailable. Create a new SWMS instead of retrying its original save.')
            if previous is None:
                self.certifications.require_created_project(workspace)
            now = datetime.now(timezone.utc).isoformat()
            document = {'id': identity, 'version': previous['version'] + 1 if previous else 1,
                        'reference': self.numbering.assign(db, 'swms', project + ':' + identity, (previous or {}).get('reference', '')),
                        'status': payload['status'], 'fields': fields, 'created_at': previous['created_at'] if previous else now, 'updated_at': now}
            snapshot = self._snapshot(db, workspace, project)
            snapshot['documents'] = [row for row in snapshot['documents'] if row['id'] != identity] + [document]
            validate_swms_snapshot(snapshot)
            db.execute('INSERT INTO swms_drafts VALUES(?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET data=excluded.data', (workspace, identity, _json(document)))
            self._audit(db, workspace, identity, 'save', previous, document)
        return document

    def delete(self, workspace, identity, version):
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._workspace(db, workspace)
            document = self._record(db, workspace, identity)
            self._version(document, version)
            db.execute('DELETE FROM swms_drafts WHERE workspace=? AND id=?', (workspace, identity))
            self._audit(db, workspace, identity, 'delete', document)
        return {'deleted': True}

    def issue(self, workspace, identity, version, request_id, company=None):
        _identity(request_id)
        company = deepcopy(company or DEFAULTS)
        fingerprint = sha256(_json({'workspace': workspace, 'id': identity, 'version': version, 'company': company}).encode('utf-8')).hexdigest()
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            project = self._workspace(db, workspace)
            previous = db.execute('SELECT * FROM swms_issued WHERE request_id=?', (request_id,)).fetchone()
            if previous:
                if previous['project_id'] != project or previous['fingerprint'] != fingerprint:
                    raise SwmsConflict('This PDF request was already used for different SWMS content.')
                return {**dict(previous), 'pdf': bytes(previous['pdf'])}
            document = self._record(db, workspace, identity)
            self._version(document, version)
            renderer = self.renderer
            if renderer is None:
                from .swms_pdf import render_swms_pdf
                renderer = render_swms_pdf
            cover = self.covers.get('swms') if self.covers else None
            pdf = renderer(document, company=company)
            from .pdf_cover import prepend_cover_pdf
            pdf = prepend_cover_pdf(pdf, company, cover)
            if not isinstance(pdf, bytes) or not pdf.startswith(b'%PDF-') or len(pdf) > MAX_PDF_BYTES:
                raise ValidationError('The generated SWMS PDF is invalid or exceeds 64 MiB.')
            issued_id = str(uuid.uuid4())
            filename = f"SAFE-WORK-METHOD-STATEMENT-{document.get('reference') or identity[:8]}-R{version}.pdf"
            db.execute('INSERT INTO swms_issued VALUES(?,?,?,?,?,?)', (issued_id, project, request_id, fingerprint, filename, pdf))
            self._audit(db, workspace, identity, 'issue', document, document)
        return {'id': issued_id, 'filename': filename, 'pdf': pdf}

    def read_pdf(self, workspace, issued_id):
        _identity(issued_id)
        with self._connect() as db:
            project = self._workspace(db, workspace)
            row = db.execute('SELECT filename,pdf FROM swms_issued WHERE id=? AND project_id=?', (issued_id, project)).fetchone()
            if row is None:
                raise ValidationError('This SWMS PDF is unavailable in the current project.')
            return row['filename'], bytes(row['pdf'])
