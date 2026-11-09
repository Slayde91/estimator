"""Explicit project parties and shared physical sites. Project files remain portable snapshots."""
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from .catalog import ValidationError


ROLES = {'client':'Client', 'builder':'Builder', 'principal_contractor':'Principal contractor',
         'consultant':'Consultant', 'owner':'Owner', 'architect':'Architect', 'project_manager':'Project manager',
         'subcontractor':'Subcontractor', 'supplier':'Supplier', 'site_contact':'Site contact', 'billing_contact':'Billing contact'}


class ParticipantConflict(ValidationError):
    pass


def identity(value):
    try:
        if not isinstance(value,str) or str(UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise ValidationError('Choose an existing record.') from None
    return value


def text_field(value, limit, required=False):
    if (not isinstance(value,str) or len(value)>limit or any(ord(c)<32 and c not in '\n\t\r' or 0xd800<=ord(c)<=0xdfff for c in value)
            or (required and not value.strip())):
        raise ValidationError('Enter a valid site name and address.')
    return value.strip()


class CRMParticipants:
    def __init__(self, path, projects, contacts):
        self.path, self.projects, self.contacts = Path(path), projects, contacts
        with self.db() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, search TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS project_roles(
              source TEXT NOT NULL, owner TEXT NOT NULL, project_no TEXT NOT NULL, client TEXT NOT NULL,
              site_address TEXT NOT NULL, site_id TEXT REFERENCES sites(id), roles TEXT NOT NULL, version INTEGER NOT NULL,
              PRIMARY KEY(source,owner));
            CREATE INDEX IF NOT EXISTS shared_site_projects ON project_roles(site_id);
            CREATE TABLE IF NOT EXISTS party_lookup(source TEXT NOT NULL, owner TEXT NOT NULL,
              role TEXT NOT NULL, kind TEXT NOT NULL, party_id TEXT NOT NULL,
              PRIMARY KEY(kind,party_id,source,owner,role));
            CREATE TABLE IF NOT EXISTS participant_history(sequence INTEGER PRIMARY KEY, source TEXT, owner TEXT, version INTEGER,
              actor TEXT NOT NULL, event TEXT NOT NULL, snapshot TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            """)
            if db.execute('PRAGMA user_version').fetchone()[0]==0:
                db.execute("""INSERT OR IGNORE INTO party_lookup
                    SELECT source,owner,json_extract(j.value,'$.role'),json_extract(j.value,'$.kind'),json_extract(j.value,'$.id')
                    FROM project_roles,json_each(roles) AS j""")
                db.execute('PRAGMA user_version=1')

    @contextmanager
    def db(self):
        with closing(sqlite3.connect(self.path,timeout=10)) as db:
            db.row_factory=sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            with db:
                yield db

    def create_site(self, data, actor):
        if not isinstance(data,dict) or set(data)!={'id','name','address'}:
            raise ValidationError('Include a site name and address.')
        site = {'id':identity(data['id']), 'name':text_field(data['name'],240,True), 'address':text_field(data['address'],1200)}
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT id,name,address FROM sites WHERE id=?',(site['id'],)).fetchone()
            if prior:
                if dict(prior)!=site:
                    raise ParticipantConflict('This site request was already used. Refresh the list.')
                return site
            db.execute('INSERT INTO sites VALUES(?,?,?,?)',(*site.values(), (site['name']+' '+site['address']).casefold()))
            db.execute("INSERT INTO participant_history(actor,event,snapshot) VALUES(?,'site created',?)",
                       (json.dumps(actor),json.dumps(site)))
        return site

    def sites(self, search='', offset='0'):
        needle=text_field(search,500).casefold()
        if not isinstance(offset,str) or not offset.isascii() or not offset.isdecimal() or len(offset)>8:
            raise ValidationError('Choose a valid site page.')
        with self.db() as db:
            rows=db.execute('SELECT id,name,address FROM sites WHERE instr(search,?)>0 ORDER BY search,id LIMIT 101 OFFSET ?',
                            (needle,int(offset))).fetchall()
        return {'sites':[dict(row) for row in rows[:100]], 'more':len(rows)>100}

    @staticmethod
    def _existing(db, project):
        row=db.execute('SELECT * FROM project_roles WHERE source=? AND owner=?',(project['source'],project['owner'])).fetchone()
        if row is None and project['owner'] and project['project_no']:
            # A previously plain project can gain its first commercial workspace.
            # Only its own authorized file and recorded project number can carry its roles forward.
            row=db.execute("SELECT * FROM project_roles WHERE source=? AND owner='' AND project_no=?",
                           (project['source'],project['project_no'])).fetchone()
        if row and not project['owner'] and row['project_no']!=project['project_no']:
            raise ParticipantConflict('A different project now occupies this file. Reopen the correct saved project.')
        return row

    def view(self, selector):
        project=self.projects.participant_project(selector)
        with self.db() as db:
            db.execute('BEGIN')
            record=self._view(db,project)
        self._availability(record['linked_bids'])
        return record

    def _availability(self, rows):
        try:
            states=self.projects.participant_availability(rows) if rows else {}
        except (OSError,ValidationError):
            states={}  # Keep recorded relationships visible when the linked folder cannot be scanned.
        for row in rows:
            row['availability']=states.get((row['source'],row['owner'],row['project_no']),'unverified')

    def site(self, site_id):
        with self.db() as db:
            db.execute('BEGIN')
            site=db.execute('SELECT id,name,address FROM sites WHERE id=?',(identity(site_id),)).fetchone()
            if not site:
                raise ValidationError('Choose an existing shared site.')
            rows=[dict(row) for row in db.execute('''SELECT source,owner,project_no,client,site_address
                FROM project_roles WHERE site_id=? ORDER BY project_no,client,source,owner''',(site_id,))]
        self._availability(rows)
        return {'site':dict(site),'linked_bids':rows}

    def _view(self,db,project):
        row=self._existing(db,project)
        site=None
        peers=[]
        if row and row['site_id']:
            site=dict(db.execute('SELECT id,name,address FROM sites WHERE id=?',(row['site_id'],)).fetchone())
            peers=[dict(item) for item in db.execute("""SELECT source,owner,project_no,client,site_address FROM project_roles
                WHERE site_id=? AND NOT(source=? AND owner=?) ORDER BY project_no,client,source,owner""",
                (row['site_id'],row['source'],row['owner']))]
        return {'project_revision':project['revision'],'version':row['version'] if row else 0,
                'participants':json.loads(row['roles']) if row else [], 'roles':ROLES,'site':site,'linked_bids':peers}

    def related(self,kind,identities):
        """Follow exact party IDs, including explicitly merged aliases from the directory snapshot."""
        ids=sorted(set(identities))
        rows=[]
        with self.db() as db:
            db.execute('BEGIN')
            for start in range(0,len(ids),400):
                batch=ids[start:start+400]
                markers=','.join('?' for _ in batch)
                rows.extend(dict(row) for row in db.execute(f'''SELECT p.project_no,p.client,p.site_address,
                    i.role,i.party_id,i.source,i.owner FROM party_lookup i JOIN project_roles p USING(source,owner)
                    WHERE i.kind=? AND i.party_id IN ({markers})''',(kind,*batch)))
        for row in rows:
            row['role_label']=ROLES[row['role']]
        self._availability(rows)
        return sorted(rows,key=lambda row:(row['project_no'],row['client'],row['source'],row['owner'],row['role'],row['party_id']))

    def _validated_rows(self, requested, previous):
        from .crm_identity import KINDS
        keys, seen = [], set()
        for item in requested:
            if (not isinstance(item,dict) or set(item)!={'role','kind','id'}
                    or not isinstance(item['role'],str) or not isinstance(item['kind'],str)):
                raise ValidationError('Choose a participant role and directory record.')
            key=(item['role'], item['kind'], identity(item['id']))
            if key[0] not in ROLES or key[1] not in KINDS or key in seen:
                raise ValidationError('Choose each participant and role only once.')
            keys.append(key)
            seen.add(key)
        # A site-only edit or retained historical alias needs no directory scan.
        # Validate only newly added selections against the indexed entity/active merge tables.
        needed = set(keys) - previous.keys()
        labels = {}
        if needed:
            with self.contacts.connection() as db:
                db.execute('BEGIN')
                for kind,field in (('accounts','company'),('contacts','name')):
                    ids = sorted({identifier for _,category,identifier in needed if category==kind})
                    if not ids:
                        continue
                    markers=','.join('?' for _ in ids)
                    sql=f"""SELECT p.id,p.{field} FROM {kind} p WHERE p.id IN ({markers})
                        AND NOT EXISTS (SELECT 1 FROM {KINDS[kind]} m WHERE m.source_id=p.id AND m.undone_at IS NULL)"""
                    labels.update({(kind,ident):label for ident,label in db.execute(sql,ids)})
        rows=[]
        for key in keys:
            role,kind,ident=key
            if key in previous:
                rows.append(previous[key])
            elif (kind,ident) in labels:
                rows.append({'role':role,'kind':kind,'id':ident,'label':labels[kind,ident]})
            else:
                raise ValidationError('The selected directory record is unavailable.')
        return rows

    def save(self,data,actor):
        if (not isinstance(data,dict) or set(data)!={'project','project_revision','version','participants','site_id'}
                or type(data['version']) is not int or not isinstance(data['participants'],list) or len(data['participants'])>200):
            raise ValidationError('Choose up to 200 participants for the selected project.')
        selector=data['project']
        project=self.projects.participant_project(selector)
        if project['revision']!=data['project_revision']:
            raise ParticipantConflict('The project changed. Reopen its details before changing participants.')
        site_id=identity(data['site_id']) if data['site_id'] is not None else None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=self._existing(db,project)
            version=row['version'] if row else 0
            if version!=data['version']:
                raise ParticipantConflict('Participants changed. Reload the project participants before saving.')
            if site_id and not db.execute('SELECT 1 FROM sites WHERE id=?',(site_id,)).fetchone():
                raise ValidationError('Choose an existing shared site.')
            prior={(r['role'],r['kind'],r['id']):r for r in json.loads(row['roles'])} if row else {}
            roles=self._validated_rows(data['participants'],prior)
            changed = (row['site_id'] if row else None)!=site_id or roles!=list(prior.values())
            if changed:
                if row:
                    db.execute('DELETE FROM party_lookup WHERE source=? AND owner=?',(row['source'],row['owner']))
                if row and row['owner']!=project['owner']:
                    db.execute('UPDATE project_roles SET owner=? WHERE source=? AND owner=?',(project['owner'],row['source'],row['owner']))
                db.execute('''INSERT INTO project_roles VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,owner) DO UPDATE SET
                    project_no=excluded.project_no,client=excluded.client,site_address=excluded.site_address,
                    site_id=excluded.site_id,roles=excluded.roles,version=excluded.version''',
                    (project['source'],project['owner'],project['project_no'],project['client'],project['site_address'],site_id,json.dumps(roles),version+1))
                db.executemany('INSERT INTO party_lookup VALUES(?,?,?,?,?)',
                               [(project['source'],project['owner'],r['role'],r['kind'],r['id']) for r in roles])
                db.execute("""INSERT INTO participant_history(source,owner,version,actor,event,snapshot)
                    VALUES(?,?,?,?,'participants updated',?)""",(project['source'],project['owner'],version+1,json.dumps(actor),
                    json.dumps({'participants':roles,'site_id':site_id})))
            record=self._view(db,project)
        self._availability(record['linked_bids'])
        return record


class ParticipantsHTTP:
    def __init__(self,service):
        self.service=service

    def dispatch(self,handler,route):
        if route not in {'/api/crm/sites','/api/crm/project-participants'}:
            return False
        try:
            query=parse_qs(urlsplit(handler.path).query,keep_blank_values=True)
            if any(len(v)!=1 for v in query.values()):
                raise ValidationError('Use one value per field.')
            args={k:v[0] for k,v in query.items()}
            if handler.command=='GET' and route.endswith('/sites') and set(args)=={'id'}:
                value=self.service.site(args['id'])
            elif handler.command=='GET' and route.endswith('/sites') and set(args)<={'search','offset'}:
                value=self.service.sites(**args)
            elif handler.command=='GET' and set(args)=={'project'} and route.endswith('/project-participants'):
                value=self.service.view(args['project'])
            elif handler.command=='POST' and not args:
                if handler.headers.get('Sec-Fetch-Site')=='cross-site':
                    handler.send_payload(403,{'error':'Open the project in CLASSIFIRE.'})
                    return True
                fn=self.service.create_site if route.endswith('/sites') else self.service.save
                value=fn(handler.read_json(),getattr(handler,'crm_actor',None))
            else:
                raise ValidationError('Choose a valid project or site request.')
        except (ValidationError,OSError) as exc:
            handler.send_payload(409 if isinstance(exc,ParticipantConflict) else 400,{'error':str(exc) if isinstance(exc,ValidationError) else 'The saved project is unavailable.'})
        else:
            handler.send_payload(200,value)
        return True
