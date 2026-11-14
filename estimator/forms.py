"""Versioned local form templates, completed forms and role-scoped workflow approvals."""
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import sqlite3
from uuid import UUID

from .catalog import ValidationError
from .form_fields import validate_template, validate_values


class FormError(ValidationError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def _missing():
    return FormError('This form is unavailable.', 404)


def _identity(value):
    try:
        if isinstance(value, str) and str(UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise ValidationError('Choose a valid form identifier.')


def _version(value):
    if type(value) is not int or not 0 <= value < 2**31:
        raise ValidationError('Include the current form version.')
    return value


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)


def _request_key(action, user, body):
    try:
        payload = _json([action,user['id'],body]).encode('utf-8')
    except (UnicodeError,RecursionError,ValueError):
        raise ValidationError('Form data contains an invalid value.') from None
    return sha256(payload).hexdigest()


class Forms:
    def __init__(self, path, staff, company, personal=None):
        self.path = path
        self.staff = staff
        self.company = company
        self.personal = personal
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS form_templates (
                    id TEXT PRIMARY KEY, version INTEGER NOT NULL, owner TEXT NOT NULL, request_key TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS form_versions (
                    template_id TEXT NOT NULL REFERENCES form_templates(id), version INTEGER NOT NULL,
                    definition TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_name TEXT NOT NULL,
                    PRIMARY KEY(template_id,version));
                CREATE TABLE IF NOT EXISTS form_entries (
                    id TEXT PRIMARY KEY, template_id TEXT NOT NULL, template_version INTEGER NOT NULL,
                    version INTEGER NOT NULL, owner TEXT NOT NULL, owner_name TEXT NOT NULL,
                    status TEXT NOT NULL, stage_id TEXT, approvals TEXT NOT NULL, answers TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, request_key TEXT NOT NULL,
                    summary_values TEXT NOT NULL, reminders TEXT NOT NULL DEFAULT '[]', reversals TEXT NOT NULL DEFAULT '[]',
                    FOREIGN KEY(template_id,template_version) REFERENCES form_versions(template_id,version));
                CREATE INDEX IF NOT EXISTS form_entry_template ON form_entries(template_id,updated_at);
            """)
            if 'reminders' not in {row['name'] for row in db.execute('PRAGMA table_info(form_entries)')}:
                db.execute("ALTER TABLE form_entries ADD COLUMN reminders TEXT NOT NULL DEFAULT '[]'")
            if 'reversals' not in {row['name'] for row in db.execute('PRAGMA table_info(form_entries)')}:
                db.execute("ALTER TABLE form_entries ADD COLUMN reversals TEXT NOT NULL DEFAULT '[]'")

    @contextmanager
    def connect(self, write=False):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _user(user, write=False):
        if not user:
            raise FormError('Sign in to use Forms.', 401)
        if user['role'] not in (('admin', 'editor') if write else ('admin', 'editor', 'viewer')):
            raise FormError('Your Settings role does not permit this action.', 403)

    @staticmethod
    def _view(row, user):
        data = json.loads(row['definition'])
        manage = user['role'] == 'admin' or user['role'] == 'editor' and row['owner'] == user['id']
        allowed = user['role'] in data['roles']
        published = data['status'] == 'published'
        stages = data['settings'].get('stages', []) if data['mode'] == 'workflow' else []
        fill = published and allowed and user['role'] in ('admin', 'editor') and (
            not stages or Forms._eligible(stages[0],user))
        return {**data, 'id': row['id'], 'version': row['version'], 'updated_at': row['updated_at'],
                'updated_by_name':row['updated_by_name'],
                'can_manage': manage, 'can_fill': fill}

    @staticmethod
    def _query():
        return ('SELECT t.id,t.owner,v.version,v.definition,v.updated_at,v.updated_by_name FROM form_templates t '
                'JOIN form_versions v ON v.template_id=t.id ')

    def _template(self, db, user, identity, version=None, internal=False):
        key = _identity(identity)
        row = db.execute(self._query() + 'WHERE t.id=? AND v.version=' + ('t.version' if version is None else '?'),
                         (key,) if version is None else (key, version)).fetchone()
        if not row:
            raise _missing()
        data = self._view(row, user)
        if not internal and not (data['can_manage'] or
                data['status'] == 'published' and user['role'] in data['roles']):
            raise _missing()
        return data

    def templates(self, user):
        self._user(user)
        with self.connect() as db:
            rows = db.execute(self._query() + 'WHERE v.version=t.version ORDER BY v.updated_at DESC,t.id')
            result = []
            for row in rows:
                data = self._view(row, user)
                if data['can_manage'] or data['status'] == 'published' and user['role'] in data['roles']:
                    result.append({k: v for k, v in data.items() if k not in ('fields', 'settings')})
            return {'templates': result}

    def template(self, user, identity, version=None):
        self._user(user)
        with self.connect() as db:
            current = self._template(db, user, identity)
            if version is None:
                return current
            if not current['can_manage']:
                raise _missing()
            return self._template(db,user,identity,_version(version))

    def history(self, user, identity):
        self._user(user)
        with self.connect() as db:
            current = self._template(db,user,identity)
            if not current['can_manage']:
                raise _missing()
            rows = db.execute(self._query() + 'WHERE t.id=? ORDER BY v.version DESC', (identity,))
            return {'versions': [{k:v for k,v in self._view(row,user).items()
                    if k in ('version','name','status','updated_at','updated_by_name')} for row in rows]}

    def save_template(self, user, body):
        self._user(user, True)
        key, expected = _identity(body.get('id')), _version(body.get('version'))
        definition = validate_template(body,{person['id'] for person in self.staff()})
        request_key = _request_key('template', user, body)
        with self.connect(True) as db:
            row = db.execute('SELECT * FROM form_templates WHERE id=?', (key,)).fetchone()
            if row:
                if row['owner'] != user['id'] and user['role'] != 'admin':
                    raise FormError('Only the template creator or an administrator can change this template.', 403)
                if request_key == row['request_key']:
                    return self._template(db, user, key)
            if expected != (row['version'] if row else 0):
                raise FormError('This template changed. Reopen it before saving.', 409)
            version = expected + 1
            if row:
                db.execute('UPDATE form_templates SET version=?,request_key=? WHERE id=?', (version, request_key, key))
            else:
                db.execute('INSERT INTO form_templates VALUES (?,?,?,?)', (key, version, user['id'], request_key))
            db.execute('INSERT INTO form_versions VALUES (?,?,?,?,?)', (key, version, _json(definition), _now(), user['name']))
            return self._template(db, user, key)

    @staticmethod
    def _eligible(stage,user):
        return (user['role'] in stage['roles'] and
                (not stage.get('member_ids') or user['id'] in stage['member_ids']))

    @staticmethod
    def _stage(template, row):
        return next((stage for stage in template['settings'].get('stages', [])
                     if stage['id'] == row['stage_id']), None)

    def _entry(self, db, user, row, *, answers, cache=None):
        if cache is None:
            cache = {}
        def snapshot(version):
            index = (row['template_id'],version)
            if index not in cache:
                cache[index] = self._template(db,user,row['template_id'],version,internal=True)
            return cache[index]
        latest, template = snapshot(None), snapshot(row['template_version'])
        role = user['role']
        allowed = role in latest['roles'] and role in template['roles']
        own = user['id'] == row['owner']
        current = self._stage(template, row)
        stage_access = bool(current and self._eligible(current,user))
        approvals = json.loads(row['approvals'])
        previously_signed = any(item['member_id'] == user['id'] for item in approvals)
        readable = own or stage_access or previously_signed or row['status']=='submitted'
        if not ((allowed and latest['status'] in ('published','archived') and readable) or role == 'admin'):
            raise _missing()
        active = allowed and latest['status'] == 'published' and row['status'] == 'draft' and role in ('editor','admin')
        edit = bool(active and (stage_access if current else own))
        reopen = bool(approvals and latest['status']=='published' and (role=='admin' or allowed and role=='editor'
                      and approvals[-1]['member_id']==user['id']))
        result = {'id': row['id'], 'version': row['version'], 'template_id': row['template_id'],
                  'name':template['name'], 'summary_values':json.loads(row['summary_values']),
                  'reminders':json.loads(row['reminders']),
                  'template_version': row['template_version'], 'created_by': row['owner'],
                  'created_by_name': row['owner_name'], 'created_at': row['created_at'],
                  'updated_at': row['updated_at'], 'status': row['status'], 'stage_id': row['stage_id'],
                  'approvals': approvals, 'reversals':json.loads(row['reversals']),
                  'can_edit': edit, 'can_approve': bool(edit and current), 'can_reopen':reopen}
        if answers:
            result.update(values=json.loads(row['answers']), template=template)
        return result

    def entries(self, user, template_id=None):
        self._user(user)
        with self.connect() as db:
            if template_id is not None:
                self._template(db, user, _identity(template_id))
            rows = db.execute('SELECT id,template_id,template_version,version,owner,owner_name,status,stage_id,'
                              'approvals,reversals,created_at,updated_at,summary_values,reminders FROM form_entries '
                              + ('WHERE template_id=? ' if template_id is not None else '')
                              + 'ORDER BY updated_at DESC,id', (template_id,) if template_id is not None else ())
            result = []
            cache = {}
            for row in rows:
                try:
                    result.append(self._entry(db, user, row, answers=False,cache=cache))
                except FormError as exc:
                    if exc.status != 404:
                        raise
            return {'entries': result}

    @staticmethod
    def _entry_row(db, identity):
        return db.execute('SELECT * FROM form_entries WHERE id=?', (_identity(identity),)).fetchone()

    def entry(self, user, identity):
        self._user(user)
        with self.connect() as db:
            row = self._entry_row(db, identity)
            if not row:
                raise _missing()
            return self._entry(db, user, row, answers=True)

    def save_entry(self, user, body):
        self._user(user, True)
        if set(body) != {'id','version','template_id','template_version','status','values'}:
            raise ValidationError('Include only the entry, template revision, status and field values.')
        key, expected = _identity(body['id']), _version(body['version'])
        template_id, revision = _identity(body['template_id']), _version(body['template_version'])
        status = body['status']
        if status not in ('draft','submitted'):
            raise ValidationError('Choose a valid form status.')
        request_key = _request_key('entry', user, body)
        with self.connect(True) as db:
            row = self._entry_row(db, key)
            latest = self._template(db, user, template_id)
            if row:
                entry = self._entry(db, user, row, answers=True)
                if request_key == row['request_key']:
                    return entry
                if row['template_id'] != template_id or row['template_version'] != revision or expected != entry['version']:
                    raise FormError('This form changed. Reopen the saved entry before continuing.', 409)
                if not entry['can_edit']:
                    raise FormError('This form or workflow step cannot be edited by this account.', 403)
                template = entry['template']
                stage_id = entry['stage_id']
                previous = entry['values']
            else:
                if not latest['can_fill']:
                    raise FormError('This template is unavailable to fill for this Settings role.', 403)
                if expected or revision != latest['version']:
                    raise FormError('This template changed. Reopen the current template to start a form.', 409)
                template = latest
                stage_id = template['settings']['stages'][0]['id'] if template['mode'] == 'workflow' else None
                previous = {}
            if template['mode'] == 'workflow' and status != 'draft':
                raise ValidationError('Approve the current workflow step before completing this form.')
            def lookup(entry_id,source_template):
                target = self._entry_row(db,entry_id)
                if not target or source_template and target['template_id'] != source_template:
                    raise _missing()
                self._entry(db,user,target,answers=False)
            # Automatic numbers include both draft and submitted forms, allocated inside this write transaction.
            counter = db.execute('SELECT count(*)+1 FROM form_entries WHERE template_id=?',(template_id,)).fetchone()[0] if not row else None
            if row and any(f['type']=='counter' and f['id'] not in previous for f in template['fields']):
                counter = db.execute('SELECT count(*) FROM form_entries WHERE template_id=? AND rowid<= '
                                     '(SELECT rowid FROM form_entries WHERE id=?)',(template_id,key)).fetchone()[0]
            profile_fields = [field for parent in template['fields'] for field in (parent, *(
                parent['children'] if parent['type']=='group' else parent['columns'] if parent['type']=='table' else []))]
            company = self.company() if any(field['type'] in ('profile','profile_company','profile_phone')
                                            for field in profile_fields) else {}
            now = _now()
            signer = {**user,'at':now,'company':company.get('name',''),'phone':company.get('phone','')}
            if self.personal and any(f['type']=='signature' for f in profile_fields):
                profile = self.personal(owner_id=user['id'])
                signer.update(signature_image=profile['signature_image'],signature_name=profile['signature_name'])
            values = validate_values(template, body['values'], complete=status == 'submitted',
                                     previous=previous, stage_id=stage_id, staff={p['id'] for p in self.staff()},
                                     signer=signer,lookup=lookup,counter=counter)
            sort = template['settings'].get('sort_field')
            columns = set(template['settings'].get('summary_fields',[]))
            if sort:
                columns.add(sort)
            candidates = {field['id']:values.get(field['id']) for field in template['fields']
                          if field['id'] in columns and field['type'] not in ('sketch','manual_signature',
                             'signature','attachment','photo','table','group','staff_wallet')}
            for cell in template['settings'].get('summary_cells',[]):
                field_id,row_index,col = cell['field_id'],cell['row'],cell['column_id']
                rows = values.get(field_id,[])
                if row_index<len(rows):
                    value = rows[row_index].get(col)
                    if isinstance(value,dict):
                        value = value.get('answer')
                    candidates[f'{field_id}:{row_index}:{col}'] = value
            summary = {}
            for selector,value in candidates.items():
                if isinstance(value,str):
                    summary[selector] = value[:500]
                elif type(value) in (int,float,bool):
                    summary[selector] = value
                elif isinstance(value,list) and all(isinstance(item,str) for item in value):
                    summary[selector] = ', '.join(value)[:500]
            reminders = []
            for field in template['fields']:
                if field['type']=='group':
                    for item in values.get(field['id'],[]):
                        reminders.extend(self._reminders(field['children'],item))
                else:
                    reminders.extend(self._reminders([field],values))
            if row:
                db.execute('UPDATE form_entries SET version=?,status=?,answers=?,updated_at=?,request_key=?,summary_values=?,reminders=? WHERE id=?',
                           (expected+1,status,_json(values),now,request_key,_json(summary),_json(reminders),key))
            else:
                db.execute('INSERT INTO form_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (key,template_id,revision,1,user['id'],user['name'],status,stage_id,'[]',_json(values),
                            now,now,request_key,_json(summary),_json(reminders),'[]'))
            return self._entry(db, user, self._entry_row(db,key), answers=True)

    @staticmethod
    def _reminders(fields, values):
        return [{'label':f['label'],'date':values[f['id']],'days_before':f['reminder_days']} for f in fields
                if f['type']=='expiry_date' and 'reminder_days' in f and values.get(f['id'])]

    def reopen(self,user,body):
        return self._transition(user,body,reopen=True)

    def approve(self,user,body):
        return self._transition(user,body,reopen=False)

    def _transition(self,user,body,*,reopen):
        self._user(user, True)
        if set(body) != {'id','version'}:
            raise ValidationError('Include the current form and version for approval.')
        key, expected = _identity(body['id']), _version(body['version'])
        request_key = _request_key('reopen' if reopen else 'approve', user, body)
        with self.connect(True) as db:
            row = self._entry_row(db, key)
            if not row:
                raise _missing()
            entry = self._entry(db, user, row, answers=True)
            if request_key == row['request_key']:
                return entry
            if expected != entry['version']:
                raise FormError('The workflow changed. Reopen the form before signing.', 409)
            if reopen:
                if not entry['can_reopen']:
                    raise FormError('Only the latest signer or an administrator can reopen a signed stage.',403)
                approval = entry['approvals'].pop()
                now = _now()
                reversal = {'stage_id':approval['stage_id'],'member_id':user['id'],'member_name':user['name'],
                            'at':now,'original_approval':approval}
                db.execute("UPDATE form_entries SET version=?,stage_id=?,status='draft',approvals=?,"
                           "reversals=?,updated_at=?,request_key=? WHERE id=?",
                           (expected+1,approval['stage_id'],_json(entry['approvals']),_json(entry['reversals']+[reversal]),
                            now,request_key,key))
                return self._entry(db,user,self._entry_row(db,key),answers=True)
            if not entry['can_approve']:
                raise FormError('Your Settings role cannot approve this workflow step.', 403)
            template = entry['template']
            validate_values(template, entry['values'], complete=True, previous=entry['values'], stage_id=entry['stage_id'])
            stages = template['settings']['stages']
            current = next(i for i, stage in enumerate(stages) if stage['id'] == entry['stage_id'])
            for rule in stages[current].get('approval_conditions',[]):
                value = entry['values'].get(rule['field_id'])
                if isinstance(value,dict):
                    value = value.get('answer',value.get('status'))
                if not (rule['value'] in value if isinstance(value,list) else value==rule['value']):
                    field = next(f for f in template['fields'] if f['id']==rule['field_id'])
                    raise ValidationError(f'Approval requires {field["label"]} to be {rule["value"]}.')
            following = stages[current+1]['id'] if current+1 < len(stages) else None
            now = _now()
            entry['approvals'].append({'stage_id':entry['stage_id'], 'member_id':user['id'],
                                       'member_name':user['name'], 'at':now})
            db.execute('UPDATE form_entries SET version=?,stage_id=?,status=?,approvals=?,updated_at=?,request_key=? WHERE id=?',
                       (expected+1,following,'draft' if following else 'submitted',_json(entry['approvals']),now,request_key,key))
            return self._entry(db, user, self._entry_row(db,key), answers=True)
