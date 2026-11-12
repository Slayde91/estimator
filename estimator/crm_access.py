"""Named local access, reusing Scheduler identities without exposing payroll or credentials.

This is a workstation permission boundary. It does not make loopback HTTP a
remote/team hosting service. Existing records are never rewritten when enabling it.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from http.cookies import SimpleCookie, CookieError
from pathlib import Path
import json
import re
import sqlite3
import uuid
from .scheduler import SchedulerError
from .catalog import ValidationError

ROLES = ('none', 'viewer', 'editor')
ADMIN_WRITES = frozenset((
    '/api/contacts/identity/merge', '/api/contacts/identity/undo',
    '/api/company-settings', '/api/document-numbering', '/api/numbering-settings',
    '/api/document-numbering/migrate-orders', '/api/project-details',
    '/api/pricing/import', '/api/pricing/reset',
    '/api/configuration', '/api/projects/delete',
))
READ_POSTS = frozenset(('/api/calculate', '/api/calculators/calculate',
    '/api/penetration/calculate', '/api/penetration/definition', '/api/configuration/preview',
    '/api/projects/load', '/api/projects/details', '/api/projects/files',
    '/api/project/open', '/api/project/library-drafts/prepare', '/api/certifications/workspaces'))
EDIT_GETS = frozenset(('/api/libraries/technical/new',))
ADMIN_READS = frozenset(('/api/certifications/defaults/legacy',))
IDENTITY_READS = frozenset(('/api/record-resources','/api/record-resources/file','/api/certifications/defaults','/api/certifications/defaults/legacy','/api/scheduler/bootstrap'))
AUDIT_SEGMENTS = frozenset(('record-resources','upload','remove-file','file','api','contacts','accounts','leads','activity','identity','merge','undo','preview','suggestions','sync-project-details',
    'crm','project-participants','sites','commercial','saved-save','saved-status','saved-issue','saved-delete',
    'save','save-as','status','issue','delete','derive','notes','attachment','ignore-source','restore-source',
    'project','projects','details','export','import','load','open','files','open-file','link-folder','estimate','prepare',
    'configuration','pricing','company-settings','project-details','document-numbering','numbering-settings','migrate-orders',
    'certifications','defaults','workspaces','discard','revisions','legacy','swms','rate-defaults','purchase-order-defaults',
    'takeoffs','calculators','penetration','libraries','definition','validate-item','calculate','state','new','cover','pdf-covers',
    'documentation','download-files','template','reset','workflows','calculation'))

def audit_route(route):
    # Path parameters may be bearer download tokens or private user text.
    # Store only fixed endpoint vocabulary, never a raw capability or filename.
    return '/'+'/'.join(part if part in AUDIT_SEGMENTS else '{parameter}' for part in route.split('/')[1:9])

def download_route(route):
    """Only generation/export routes may consume a progress capability."""
    frozen_id=r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if route in {'/api/quote-report','/api/pricing/export','/api/project/export',
            '/api/project/full-schedule.pdf','/api/project/full-product-summary.pdf','/api/project/passive-fire-register.pdf',
            '/api/technical/item.pdf','/api/technical/item.xlsx','/api/penetration/item.pdf','/api/penetration/item.xlsx',
            '/api/penetration/report.pdf','/api/penetration/register.xlsx','/api/commercial/issue','/api/commercial/saved-issue','/api/swms/issue'}:
        return True
    return bool(re.fullmatch(r'/api/calculators/[a-z_]+/(?:report\.pdf|summary\.pdf|register\.xlsx|template)',route)
        or re.fullmatch(r'/api/quotes/[^/]+/report\.pdf',route)
        or re.fullmatch(r'/api/certifications/[a-z0-9-]{1,64}/revisions',route)
        # Native copies of existing immutable revisions are exports too. They
        # keep the same scoped read, saved destination and single-use receipt.
        or re.fullmatch(rf'/api/certifications/{frozen_id}/revisions/[1-9][0-9]{{0,9}}\.pdf',route)
        or re.fullmatch(rf'/api/documentation/{frozen_id}',route)
        or re.fullmatch(r'/api/takeoffs/sessions/[a-z0-9-]+/(?:(?:physical/)?export/(?:csv|xlsx|register-xlsx|schedule-xlsx|pdf|marked-pdf|markup-pdf)|pdf-tools)',route))

def _now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))

def cookie_token(headers):
    values = SimpleCookie()
    try:
        values.load(headers.get('Cookie', ''))
    except CookieError:
        return None
    item = values.get('classifire_access')
    return item.value if item else None

class AccessError(ValidationError):
    def __init__(self, message, status=403):
        super().__init__(message)
        self.status = status

class CRMAccess:
    def __init__(self, path, scheduler):
        self.path = Path(path)
        self.scheduler = scheduler
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS crm_access_settings (
                    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 1);
                INSERT OR IGNORE INTO crm_access_settings(id) VALUES(1);
                CREATE TABLE IF NOT EXISTS crm_access_roles (
                    member_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('none','viewer','editor')),
                    version INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS crm_access_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT,
                    actor_name TEXT, action TEXT NOT NULL, target TEXT NOT NULL,
                    before_data TEXT, after_data TEXT);
                CREATE TABLE IF NOT EXISTS crm_request_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
                    event TEXT NOT NULL CHECK(event IN ('attempt','response')),
                    at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
                    method TEXT NOT NULL, route TEXT NOT NULL, status INTEGER, target_id TEXT,
                    UNIQUE(request_id,event));
            """)

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def settings(self):
        with self.connect() as db:
            return dict(db.execute('SELECT enabled,version FROM crm_access_settings WHERE id=1').fetchone())

    def _member(self, token):
        with self.scheduler.connect() as db:
            row = self.scheduler._user(db, token, required=False)
            return dict(row) if row else None

    def user(self, token):
        member = self._member(token)
        if not member:
            return None
        if member['role'] == 'admin':
            role = 'admin'
        else:
            with self.connect() as db:
                assignment = db.execute('SELECT role FROM crm_access_roles WHERE member_id=?',(member['id'],)).fetchone()
            role = assignment['role'] if assignment else 'none'
        return {'id':member['id'], 'name':member['name'], 'email':member['email'], 'role':role}

    def staff(self):
        """Minimal active assignment roster, deliberately excluding pay/password data."""
        with self.scheduler.connect() as db:
            return [dict(row) for row in db.execute(
                'SELECT id,name FROM scheduler_members WHERE active=1 ORDER BY name COLLATE NOCASE,id')]

    def session(self, token):
        config=self.settings()
        return {'enabled':bool(config['enabled']), 'version':config['version'], 'user':self.user(token)}

    def _admin(self, token):
        user=self.user(token)
        if not user:
            raise AccessError('Sign in to manage staff access.',401)
        if user['role']!='admin':
            raise AccessError('An administrator account is required.')
        return user

    def _audit(self, db, user, action, target, before, after):
        db.execute('INSERT INTO crm_access_audit(at,actor_id,actor_name,action,target,before_data,after_data) VALUES(?,?,?,?,?,?,?)',
                   (_now(),user.get('id'),user.get('name'),action,target,_json(before),_json(after)))

    def members(self, token):
        self._admin(token)
        with self.scheduler.connect() as db:
            rows=[dict(row) for row in db.execute('SELECT id,name,email,active,role FROM scheduler_members ORDER BY name COLLATE NOCASE,id')]
        with self.connect() as db:
            assignments={row['member_id']:dict(row) for row in db.execute('SELECT * FROM crm_access_roles')}
        for row in rows:
            assignment=assignments.get(row['id'],{})
            row['scheduler_role']=row.pop('role')
            row['role']='admin' if row['scheduler_role']=='admin' else assignment.get('role','none')
            row['version']=assignment.get('version',0)
            row['active']=bool(row['active'])
        return {'members':rows}

    def assign(self, payload, token):
        user=self._admin(token)
        if not isinstance(payload,dict) or set(payload)!={'member_id','role','version'}:
            raise AccessError('Include the staff member, access role and current version.',400)
        if payload['role'] not in ROLES or type(payload['version']) is not int or payload['version']<0:
            raise AccessError('Choose a valid staff access role and version.',400)
        try:
            if not isinstance(payload['member_id'],str) or str(uuid.UUID(payload['member_id'])) != payload['member_id']:
                raise ValueError()
        except (ValueError,AttributeError):
            raise AccessError('Choose an existing staff member.',400) from None
        with self.scheduler.connect() as db:
            member=db.execute('SELECT role FROM scheduler_members WHERE id=?',(payload['member_id'],)).fetchone()
        if not member:
            raise AccessError('Choose an existing staff member.',400)
        if member['role']=='admin':
            raise AccessError('Team administrators retain administrator access. Manage their team role in Scheduler.',400)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous=db.execute('SELECT role,version FROM crm_access_roles WHERE member_id=?',(payload['member_id'],)).fetchone()
            version=previous['version'] if previous else 0
            if version != payload['version']:
                raise AccessError('Staff access changed in another window. Reload before saving.',409)
            if previous and previous['role']==payload['role']:
                return {'member_id':payload['member_id'],**dict(previous)}
            result={'member_id':payload['member_id'],'role':payload['role'],'version':version+1}
            db.execute('INSERT INTO crm_access_roles VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET role=excluded.role,version=excluded.version',
                       (result['member_id'],result['role'],result['version']))
            self._audit(db,user,'access.role',payload['member_id'],dict(previous) if previous else None,result)
            return result

    def configure(self,payload,token):
        user=self._admin(token)
        if not isinstance(payload,dict) or set(payload)!={'enabled','version'} or type(payload['enabled']) is not bool or type(payload['version']) is not int:
            raise AccessError('Include the sign-in preference and current version.',400)
        return self._configure(payload,user)

    def _configure(self,payload,user):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old=dict(db.execute('SELECT enabled,version FROM crm_access_settings WHERE id=1').fetchone())
            if old['version'] != payload['version']:
                raise AccessError('Staff access changed in another window. Reload before saving.',409)
            if bool(old['enabled'])==payload['enabled']:
                return {'enabled':bool(old['enabled']),'version':old['version']}
            new={'enabled':payload['enabled'],'version':old['version']+1}
            db.execute('UPDATE crm_access_settings SET enabled=?,version=? WHERE id=1',(int(new['enabled']),new['version']))
            self._audit(db,user,'access.require_signin','application',old,new)
            return new

    def activate_named_access(self):
        """Release cutover only: do not invent an administrator or reset credentials."""
        with self.scheduler.connect() as db:
            if not db.execute("SELECT 1 FROM scheduler_members WHERE role='admin' AND active=1").fetchone():
                raise AccessError('Set up an active team administrator before requiring sign-in.',400)
        current=self.settings()
        return self._configure({'enabled':True,'version':current['version']},
                               {'id':'system:release','name':'Release activation'})

    def begin_request(self,user,method,route):
        # Commit the attribution before attempting a mutation in another store.
        # A missing response event means outcome unknown, never assumed failure.
        request_id=str(uuid.uuid4())
        with self.connect() as db:
            db.execute('INSERT INTO crm_request_events(request_id,event,at,actor_id,actor_name,method,route) VALUES(?,?,?,?,?,?,?)',
                       (request_id,'attempt',_now(),user['id'],user['name'],method,audit_route(route)))
        return request_id

    def finish_request(self,handler,status,payload):
        request_id=getattr(handler,'crm_request_id',None)
        if not request_id or getattr(handler,'crm_request_recorded',False):
            return
        target=None
        if 200 <= status < 300 and isinstance(payload,dict):
            candidate=payload.get('id')
            if not candidate and isinstance(payload.get('document'),dict):
                candidate=payload['document'].get('id')
            if isinstance(candidate,str):
                try:
                    if str(uuid.UUID(candidate))==candidate:
                        target=candidate
                except ValueError:
                    pass
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO crm_request_events(request_id,event,at,actor_id,actor_name,method,route,status,target_id) '
                       "SELECT request_id,'response',?,actor_id,actor_name,method,route,?,? FROM crm_request_events WHERE request_id=? AND event='attempt'",
                       (_now(),status,target,request_id))
        handler.crm_request_recorded=True

    def audit(self,token):
        self._admin(token)
        with self.connect() as db:
            attempts=[dict(row) for row in db.execute("SELECT a.request_id,a.at,a.actor_name,a.method,a.route,r.status,r.target_id "
                "FROM crm_request_events a LEFT JOIN crm_request_events r ON r.request_id=a.request_id AND r.event='response' "
                "WHERE a.event='attempt' ORDER BY a.id DESC LIMIT 100")]
            changes=[dict(row) for row in db.execute('SELECT at,actor_name,action,target FROM crm_access_audit ORDER BY id DESC LIMIT 100')]
        return {'requests':attempts,'access_changes':changes}

    def authorize(self,handler,route):
        """Authorize before any API adapter or local download is invoked."""
        token=cookie_token(handler.headers)
        handler.crm_request_id=None
        handler.crm_request_recorded=False
        handler.crm_request_target=None
        user=self.user(token)
        handler.crm_actor={'id':user['id'],'name':user['name']} if user else None
        handler.crm_user=user
        expected=handler.headers.get('X-CRM-Member')
        identity=user['id'] if user else 'anonymous'
        enabled=bool(self.settings()['enabled'])
        read_operation=handler.command == 'POST' and route in READ_POSTS
        if handler.command in ('GET','HEAD') and route in IDENTITY_READS and expected is not None and expected != identity:
            raise AccessError('The signed-in staff account changed. Reload this tab before continuing.',409)
        bound_mutation=route.startswith('/api/') and not route.startswith('/api/scheduler/') and (
            handler.command not in ('GET','HEAD') and not read_operation or route in EDIT_GETS)
        if bound_mutation and (user or expected is not None) and expected != identity:
            raise AccessError('The signed-in staff account changed. Reload this tab before saving.',409)
        if route in ADMIN_READS:
            if not user:
                raise AccessError('Sign in to review previous personal details.',401)
            if user['role'] != 'admin':
                raise AccessError('An administrator account is required.')
        if not enabled or route.startswith('/api/scheduler/'):
            return
        protected=route.startswith(('/api/','/download-files/'))
        if not protected:
            return
        if not user:
            raise AccessError('Sign in to use CLASSIFIRE.',401)
        role=user['role']
        if role=='none':
            raise AccessError('Your staff account has Scheduler access only. Ask an administrator for CRM access.')
        if handler.command in ('GET','HEAD') and route not in EDIT_GETS:
            return
        if bound_mutation and expected != user['id']:
            raise AccessError('The signed-in staff account changed. Reload this tab before saving.',409)
        if route in ADMIN_WRITES:
            if role!='admin':
                raise AccessError('An administrator account is required.')
        elif role not in ('editor','admin') and not read_operation:
            raise AccessError('This account has view-only access. An editor is required to make changes.')
        if not read_operation:
            handler.crm_request_id=self.begin_request(user,handler.command,route)

class AccessHTTP:
    def __init__(self,access):
        self.access=access

    def dispatch(self,handler,route):
        if not route.startswith('/api/access/'):
            return False
        action=route.removeprefix('/api/access/')
        token=cookie_token(handler.headers)
        headers={}
        try:
            if handler.command=='GET' and action=='session':
                result=self.access.session(token)
            elif handler.command=='GET' and action=='members':
                result=self.access.members(token)
            elif handler.command=='GET' and action=='audit':
                result=self.access.audit(token)
            elif handler.command=='POST':
                if handler.headers.get('Sec-Fetch-Site')=='cross-site':
                    raise AccessError('Open staff access in the local CLASSIFIRE application.')
                body=handler.read_json()
                if action in {'roles','settings'}:
                    user=self.access._admin(token)
                    if handler.headers.get('X-CRM-Member') != user['id']:
                        raise AccessError('The signed-in staff account changed. Reload this tab before saving.',409)
                if action=='login':
                    if not isinstance(body,dict) or set(body)!={'email','password'}:
                        raise AccessError('Enter your staff email and password.',400)
                    value=self.access.scheduler.write('login',body)
                    session=value['token']
                    headers['Set-Cookie']=f'classifire_access={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'
                    result=self.access.session(session)
                elif action=='logout':
                    if token:
                        try:self.access.scheduler.write('logout',{},token)
                        except SchedulerError:pass
                    headers['Set-Cookie']=['classifire_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
                        'classifire_scheduler=; HttpOnly; SameSite=Strict; Path=/api/scheduler; Max-Age=0']
                    result={'signed_out':True}
                elif action=='roles':
                    result=self.access.assign(body,token)
                elif action=='settings':
                    result=self.access.configure(body,token)
                else:
                    raise AccessError('Staff access action not found.',404)
            else:
                raise AccessError('Staff access action not found.',404)
            handler.send_payload(200,result,headers=headers)
        except AccessError as error:
            handler.send_payload(error.status,{'error':str(error)})
        except SchedulerError as error:
            handler.send_payload(error.status_code,{'error':str(error)})
        return True

