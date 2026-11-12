"""Bounded Notes/Files owned by a saved directory record or Project companion."""
from contextlib import closing, contextmanager
import base64
import binascii
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from .catalog import ValidationError
from .commercial_files import MAX_FILE, MAX_TOTAL, WorkOrderFiles, validate_files
from .evidence_files import _directory, _open_regular

SCHEMA = 'CREATE TABLE resources (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, notes TEXT NOT NULL, files TEXT NOT NULL)'


class ResourceConflict(ValidationError):
    pass


def _uuid(value):
    try:
        if isinstance(value, str) and str(UUID(value)) == value:
            return value
    except (ValueError, AttributeError):
        pass
    raise ValidationError('Choose a saved record for Notes and Files.')


def _notes(value):
    if not isinstance(value, list) or len(value) > 200:
        raise ValidationError('A record supports up to 200 notes.')
    result, seen = [], set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {'id', 'title', 'body'}:
            raise ValidationError('Include a note title and text only.')
        identity = _uuid(item['id'])
        if identity in seen:
            raise ValidationError('Note identifiers must be unique.')
        seen.add(identity)
        for key, limit in [('title', 300), ('body', 8000)]:
            text = item[key]
            if (not isinstance(text, str) or len(text) > limit
                    or any(ord(c) < 32 and c not in '\n\r\t' or 0xd800 <= ord(c) <= 0xdfff for c in text)):
                raise ValidationError('Enter a valid note title and text.')
        if not item['title'].strip():
            raise ValidationError('Enter a title for the note.')
        result.append({'id': identity, 'title': item['title'].strip(), 'body': item['body']})
    # Bound encoded storage as well as character counts. Multi-byte text and
    # JSON escapes must not create a collection too large to reopen safely.
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 1024 * 1024:
        raise ValidationError('Enter a valid note title and text.')
    return result


class RecordResources:
    def __init__(self, root, projects, contacts):
        self.root, self.projects, self.contacts = Path(root), projects, contacts

    def _target(self, owner):
        if (not isinstance(owner, dict)
                or set(owner) != ({'kind', 'id', 'project_id'} if owner.get('kind') == 'projects' else {'kind', 'id'})):
            raise ValidationError('Choose a saved record for Notes and Files.')
        kind, identity = owner['kind'], owner['id']
        if kind == 'projects':
            # The existing resolver checks the linked listing or native save
            # capability, current file fingerprint and ignored/deleted owners.
            with self.projects._lock:
                project = self.projects.participant_project(identity)
                if not project['owner']:
                    raise ValidationError('Save this Project before adding Notes or Files.')
                project_id = _uuid(project['owner'])
                # A linked listing ID identifies a path. Bind it to the portable
                # owner the pane actually opened, even before its initial read.
                # Replacing that path must never retarget an old note or link.
                if _uuid(owner['project_id']) != project_id:
                    raise ResourceConflict('The selected project is unavailable.')
                if identity.startswith('native:'):
                    path = Path(self.projects._save_targets[identity[7:]].path)
                else:
                    _, path = self.projects._project_path(identity)
                _directory(path.parent)
                name = hashlib.sha256(path.name.encode('utf-8')).hexdigest()
                folder = path.parent / '.ceasefire-evidence' / project_id / 'record-resources' / name
            return folder, project_id
        if not isinstance(kind, str) or kind not in {'accounts', 'contacts', 'leads'}:
            raise ValidationError('Choose a saved record for Notes and Files.')
        identity = _uuid(identity)
        with self.contacts.connection() as db:
            # Conversion retains the original lead identity; aliases must not
            # expose a merged-away record's resources as another record's.
            from .crm_activity import references
            from .crm_identity import aliases
            if identity in aliases(db).get(kind, {}):
                raise ValidationError('This record was merged. Reopen its current record.')
            references(db, kind, identity)
        return self.root / kind / identity, identity

    @contextmanager
    def _connection(self, folder, *, write=False):
        path = folder / 'resources.sqlite3'
        if not write and not path.exists():
            # Reading a record with no resources must work in read-only folders.
            if folder.exists():
                _directory(folder)
            yield None
            return
        _directory(folder, create=write)
        if path.exists() or path.is_symlink():
            with _open_regular(path, 8 * 1024 * 1024, allow_empty=True) as stream:
                empty = stream.read(1) == b''
            if empty and not write:
                yield None
                return
        with closing(sqlite3.connect(path, timeout=10)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA trusted_schema=OFF')
            if write:
                db.execute('BEGIN IMMEDIATE')
            else:
                db.execute('PRAGMA query_only=ON')
            # A copied companion is untrusted input. Validate the whole schema
            # before INSERT can invoke an attacker-supplied trigger.
            definitions = db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
            if not definitions and write:
                db.execute(SCHEMA)
            elif (len(definitions) != 1 or definitions[0]['type'] != 'table'
                    or definitions[0]['name'] != 'resources' or definitions[0]['sql'] != SCHEMA):
                raise ValidationError('The record resources have an unsupported format.')
            if write:
                db.execute("INSERT OR IGNORE INTO resources VALUES(1,0,'[]','[]')")
            yield db

    @staticmethod
    def _state(db):
        if db is None:
            return {'version': 0, 'notes': [], 'files': []}
        row = db.execute('SELECT version,notes,files FROM resources WHERE id=1 AND length(notes)<=2000000 AND length(files)<=16000').fetchone()
        if not row:
            raise ValidationError('The record resources are unavailable.')
        notes = json.loads(row['notes'])
        if not isinstance(notes, list) or any(not isinstance(item,dict) or set(item) != {'id','title','body','author','updated_at'} for item in notes):
            raise ValidationError('The saved notes are unavailable.')
        _notes([{key: item[key] for key in ('id','title','body')} for item in notes])
        for item in notes:
            if any(not isinstance(item[key],str) or len(item[key])>limit or not item[key].isprintable() for key,limit in [('author',200),('updated_at',80)]):
                raise ValidationError('The saved note metadata is invalid.')
        if type(row['version']) is not int or row['version']<0:
            raise ValidationError('The record resources have an invalid version.')
        return {'version': row['version'], 'notes': notes, 'files': validate_files(json.loads(row['files']))}

    @staticmethod
    def _check(state, version):
        if type(version) is not int or version != state['version']:
            raise ResourceConflict('Notes or Files changed. Refresh this section before trying again.')

    def read(self, owner):
        folder, _ = self._target(owner)
        with self._connection(folder) as db:
            return self._state(db)

    def write(self, action, body, actor=None):
        fields = {'notes': {'notes'}, 'upload': {'filename','content_base64'}, 'remove-file': {'file_id'}}
        if action not in fields or not isinstance(body, dict) or set(body) != {'owner','version'} | fields[action]:
            raise ValidationError('Use the Notes and Files controls provided on this record.')
        folder, identity = self._target(body['owner'])
        with self._connection(folder, write=True) as db:
            state = self._state(db)
            self._check(state, body['version'])
            if action == 'notes':
                notes = _notes(body['notes'])
                old = {item['id']: item for item in state['notes']}
                now = datetime.now(timezone.utc).isoformat()
                author = ' '.join(str((actor or {}).get('name') or 'Local user').split())[:200]
                state['notes'] = [dict(item, author=(old.get(item['id']) or {}).get('author') or author,
                    updated_at=(old.get(item['id']) or {}).get('updated_at') if all((old.get(item['id']) or {}).get(key) == item[key] for key in ('title', 'body')) else now) for item in notes]
            elif action == 'upload':
                if len(state['files']) >= 16:
                    raise ValidationError('A record supports up to 16 attached files.')
                encoded = body['content_base64']
                if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_FILE + 2) // 3):
                    raise ValidationError('Each document file must be 12 MiB or smaller.')
                try:
                    raw = base64.b64decode(encoded, validate=True)
                except (binascii.Error, ValueError) as error:
                    raise ValidationError('The attachment could not be decoded.') from error
                if len(raw) > MAX_FILE or sum(item['size'] for item in state['files']) + len(raw) > MAX_TOTAL:
                    raise ValidationError('Record files exceed the 32 MiB total limit.')
                digest = hashlib.sha256(raw).hexdigest()
                del raw
                if any(saved['id'] == digest for saved in state['files']):
                    raise ValidationError('This file is already attached to the record.')
                item = WorkOrderFiles(folder / 'files').add(identity, body['filename'], body['content_base64'])
                state['files'] = validate_files([*state['files'], item])
            else:
                if not isinstance(body['file_id'], str) or not any(item['id'] == body['file_id'] for item in state['files']):
                    raise ValidationError('Choose a file attached to this record.')
                # Immutable blobs remain retained, like existing commercial
                # files; removal affects only this owner's current references.
                state['files'] = [item for item in state['files'] if item['id'] != body['file_id']]
            state['version'] += 1
            db.execute('UPDATE resources SET version=?,notes=?,files=? WHERE id=1',
                       (state['version'], json.dumps(state['notes'], ensure_ascii=False), json.dumps(state['files'])))
            return state

    def file(self, owner, identity):
        folder, record = self._target(owner)
        with self._connection(folder) as db:
            item = next((item for item in self._state(db)['files'] if item['id'] == identity), None)
            if item is None:
                raise ValidationError('Choose a file attached to this record.')
            return item, WorkOrderFiles(folder / 'files').read(record, item)


class RecordResourcesHTTP:
    def __init__(self, store):
        self.store = store

    def dispatch(self, handler, route):
        prefix = '/api/record-resources'
        if route != prefix and not route.startswith(prefix + '/'):
            return False
        try:
            if handler.command == 'GET' and route in {prefix, prefix + '/file'}:
                query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
                keys = {'kind', 'id'} | ({'project_id'} if query.get('kind') == ['projects'] else set()) | ({'file'} if route.endswith('/file') else set())
                if set(query) != keys or any(len(v) != 1 for v in query.values()):
                    raise ValidationError('Choose one saved record for Notes and Files.')
                owner = {key: query[key][0] for key in ('kind', 'id', 'project_id') if key in query}
                if route.endswith('/file'):
                    item, payload = self.store.file(owner, query['file'][0])
                    from .project_file import project_download_header
                    handler.send_payload(200, payload, item['mime'], {'Content-Disposition': project_download_header(item['name'])})
                else:
                    handler.send_payload(200, self.store.read(owner))
            elif handler.command == 'POST' and route[len(prefix) + 1:] in {'notes', 'upload', 'remove-file'}:
                if handler.headers.get('Sec-Fetch-Site') == 'cross-site':
                    handler.send_payload(403, {'error': 'Open Notes and Files in the CLASSIFIRE web app.'})
                else:
                    handler.send_payload(200, self.store.write(route[len(prefix) + 1:], handler.read_json(), getattr(handler, 'crm_actor', None)))
            else:
                handler.send_payload(405, {'error': 'Method not allowed.'})
        except ResourceConflict as error:
            handler.send_payload(409, {'error': str(error)})
        except (ValidationError, OSError, sqlite3.Error, ValueError) as error:
            handler.send_payload(400, {'error': str(error) if isinstance(error, ValidationError) else 'The record resources could not be read or saved.'})
        return True
