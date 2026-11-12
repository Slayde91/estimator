"""Explicit project parties and shared physical sites. Project files remain portable snapshots."""
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from .catalog import ValidationError
from .project_relationships import address_key, address_site


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


def project_sites(address, named, manual):
    """Resolve the saved address and preserve a distinct explicitly linked facility."""
    key=address_key(address)
    if not key:
        return ([manual],{manual['id']}) if manual else ([],set())
    primary=named.get(key) or address_site(address)
    if not manual or manual['id']==primary['id']:
        return [primary],{primary['id']}
    if address_key(manual['address'])!=key:
        return [primary,manual],{primary['id'],manual['id']}
    if manual['id']==address_site(address)['id']:
        # A previously saved address-only ID can also acquire a unique facility name.
        return [primary],{primary['id'],manual['id']}
    # Several facilities share this address. The recorded choice identifies this Project.
    return [manual],{manual['id']}


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
            CREATE TABLE IF NOT EXISTS excluded_project_parties(
              source TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, party_id TEXT NOT NULL,
              PRIMARY KEY(source,owner,kind,party_id));
            CREATE TABLE IF NOT EXISTS party_lookup(source TEXT NOT NULL, owner TEXT NOT NULL,
              role TEXT NOT NULL, kind TEXT NOT NULL, party_id TEXT NOT NULL,
              PRIMARY KEY(kind,party_id,source,owner,role));
            CREATE TABLE IF NOT EXISTS participant_history(sequence INTEGER PRIMARY KEY, source TEXT, owner TEXT, version INTEGER,
              actor TEXT NOT NULL, event TEXT NOT NULL, snapshot TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE INDEX IF NOT EXISTS participant_history_source ON participant_history(source,owner,sequence);
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
        needle=address_key(text_field(search,1200))
        if not isinstance(offset,str) or not offset.isascii() or not offset.isdecimal() or len(offset)>8:
            raise ValidationError('Choose a valid site page.')
        catalog=self._catalog()
        choices=dict(catalog['sites'])
        known={address_key(row['address']) for row in choices.values()}
        for project in catalog['projects']:
            key=address_key(project['site_address'])
            if key and key not in known:
                site=address_site(project['site_address'])
                choices[site['id']]=site
                known.add(key)
        rows=sorted((row for row in choices.values() if needle in address_key(row['name']+' '+row['address'])),
                    key=lambda row:(address_key(row['address']),address_key(row['name']),row['id']))
        start=int(offset)
        return {'sites':rows[start:start+100], 'more':len(rows)>start+100,
                'scan_pending':catalog['scan_pending'], 'error_count':catalog.get('error_count',0)}

    def _catalog(self):
        try:
            catalog=self.projects.participant_sites()
        except (OSError,ValidationError):
            catalog={'projects':[], 'scan_pending':True, 'error_count':1}
        with self.db() as db:
            db.execute('BEGIN')
            sites={row['id']:dict(row) for row in db.execute('SELECT id,name,address FROM sites')}
            manual={(row['source'],row['owner']):row for row in db.execute(
                'SELECT source,owner,project_no,site_id FROM project_roles WHERE site_id IS NOT NULL')}
        named={}
        for site in sites.values():
            key=address_key(site['address'])
            if key and site['id']!=address_site(site['address'])['id']:
                # Never select arbitrarily between named facilities at the same address.
                named[key]=None if key in named else site
        rows=[]
        for row in catalog['projects']:
            selected=manual.get((row['source'],row['owner']))
            if selected and not row['owner'] and selected['project_no']!=row['project_no']:
                selected=None
            legacy=manual.get((row['source'],''))
            if selected is None and row['owner'] and legacy and legacy['project_no']==row['project_no']:
                selected=legacy
            _,ids=project_sites(row['site_address'],named,sites[selected['site_id']] if selected else None)
            rows.append({**row,'_site_ids':ids})
        rows.sort(key=lambda row:(address_key(row['site_address']),row['site_address'],row['source'],row['owner']))
        return {**catalog,'projects':rows,'sites':sites,'named':named}

    def _decorate(self,record,project,catalog):
        """Derive same-address bids without modifying either file or sidecar."""
        ids=record.pop('_site_ids')
        peers={(row['source'],row['owner']):row for row in record.pop('linked_bids')}
        current_address=address_key(project['site_address'])
        same_address=set()
        current=(project['source'],project['owner'])
        for row in catalog['projects']:
            identity=(row['source'],row['owner'])
            if identity!=current and not ids.isdisjoint(row['_site_ids']):
                # An older relationship can predate the file's commercial owner.
                # Prefer the current metadata when it still identifies the same bid.
                legacy=(row['source'],'')
                recorded=identity in peers
                if row['owner'] and legacy in peers and peers[legacy]['project_no']==row['project_no']:
                    del peers[legacy]
                    recorded=True
                peers[identity]={**{name:value for name,value in row.items() if name!='_site_ids'},'automatic':not recorded}
                if current_address and address_key(row['site_address'])==current_address:
                    same_address.add(identity)
        ordered=sorted(peers.values(),key=lambda row:(row['project_no'],row['client'],row['source'],row['owner']))
        self._availability(ordered)
        record['linked_bids']=[]
        record['other_site_bids']=[]
        for bid in ordered:
            if bid['availability']!='available' and bid.get('automatic'):
                # A file lost between scans has no durable bid link of its own.
                continue
            if (bid['source'],bid['owner']) in same_address and bid['availability']=='available':
                record['linked_bids'].append(bid)
            else:
                record['other_site_bids'].append(bid)
        record['scan_pending']=catalog['scan_pending']
        record['error_count']=catalog.get('error_count',0)
        record['site_address']=project['site_address']
        excluded = set(record.pop('_excluded', ()))
        record['linked_parties'] = [item for item in self._derived_parties(project) if (item['kind'],item['id']) not in excluded]
        return record

    def _derived_parties(self,project):
        parties = list(project.get('linked_parties',[]))
        # Company-side manual Project links use the exact file-derived token.
        # Portable owner IDs alone are ambiguous when Save As copies exist.
        if project.get('account_link_id'):
            with self.contacts.connection() as db:
                parties.extend({'kind':'accounts','id':row[0],'label':row[1],'role':'Linked company'}
                    for row in db.execute('''SELECT a.id,a.company FROM account_links l JOIN accounts a ON a.id=l.account_id
                        WHERE l.kind='projects' AND l.target_id=? ORDER BY a.company,a.id''',(project['account_link_id'],)))
        return parties

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
        catalog=self._catalog()
        with self.db() as db:
            db.execute('BEGIN')
            record=self._view(db,project,catalog)
        return self._decorate(record,project,catalog)

    def activity(self, selector, revision):
        project = self.projects.participant_project(selector, activity_only=True)
        if project['revision'] != revision:
            raise ParticipantConflict('The project changed. Reopen its details before changing participants.')
        events = [{'label':'Project file modified', 'at':project['modified_at']}]
        with self.db() as db:
            db.execute('BEGIN')
            row = self._existing(db, project)
            if row:
                for item in db.execute("""SELECT actor,recorded_at FROM participant_history
                        WHERE source=? AND owner=? AND event='participants updated' ORDER BY sequence DESC""",
                        (row['source'], row['owner'])):
                    actor = json.loads(item['actor']) or {}
                    events.append({'label':'Participants updated', 'at':item['recorded_at'].replace(' ', 'T') + 'Z',
                                   'actor':actor.get('name', '')})
        for card in project['commercial_cards']:
            subject = ' · '.join(filter(None, [card['reference'] or card['last_number'], card['fields']['title']]))
            for field, label in [('created_at', 'Created'), ('updated_at', 'Updated')]:
                if card[field] and (field == 'created_at' or card[field] != card['created_at']):
                    events.append({'label':label, 'at':card[field], 'kind':card['kind'], 'subject':subject})
        return {'events':events}

    def _availability(self, rows):
        try:
            states=self.projects.participant_availability(rows) if rows else {}
        except (OSError,ValidationError):
            states={}  # Keep recorded relationships visible when the linked folder cannot be scanned.
        for row in rows:
            row['availability']=states.get((row['source'],row['owner'],row['project_no']),'unverified')

    def site(self, site_id):
        site_id=identity(site_id)
        catalog=self._catalog()
        with self.db() as db:
            db.execute('BEGIN')
            site=db.execute('SELECT id,name,address FROM sites WHERE id=?',(site_id,)).fetchone()
            if not site:
                site=next((candidate for row in catalog['projects'] if (candidate:=address_site(row['site_address'])) and candidate['id']==site_id),None)
                if not site:
                    raise ValidationError('Choose an existing shared site.')
            rows=[dict(row) for row in db.execute('''SELECT source,owner,project_no,client,site_address
                FROM project_roles WHERE site_id=? ORDER BY project_no,client,source,owner''',(site_id,))]
        peers={(row['source'],row['owner']):row for row in rows}
        ids={site_id}
        derived=address_site(site['address'])
        if derived and site_id==derived['id'] and (named:=catalog['named'].get(address_key(site['address']))):
            ids.add(named['id'])
        for row in catalog['projects']:
            if not ids.isdisjoint(row['_site_ids']):
                pair=(row['source'],row['owner'])
                peers[pair]={**{name:value for name,value in row.items() if name!='_site_ids'},'automatic':pair not in peers}
        rows=sorted(peers.values(),key=lambda row:(row['project_no'],row['client'],row['source'],row['owner']));self._availability(rows)
        return {'site':dict(site),'linked_bids':rows,'scan_pending':catalog['scan_pending']}

    def _view(self,db,project,catalog):
        row=self._existing(db,project)
        site_id=row['site_id'] if row else None
        manual=dict(db.execute('SELECT id,name,address FROM sites WHERE id=?',(site_id,)).fetchone()) if site_id else None
        sites,ids=project_sites(project['site_address'],catalog['named'],manual)
        peers=[]
        if ids:
            placeholders=','.join('?' for _ in ids)
            owner=row['owner'] if row else project['owner']
            peers=[dict(item) for item in db.execute(f"""SELECT source,owner,project_no,client,site_address FROM project_roles
                WHERE site_id IN ({placeholders}) AND NOT(source=? AND owner=?) ORDER BY project_no,client,source,owner""",
                (*sorted(ids),project['source'],owner))]
        excluded = [(item[0],item[1]) for item in db.execute(
            'SELECT kind,party_id FROM excluded_project_parties WHERE source=? AND owner=?',
            (row['source'],row['owner']))] if row else []
        return {'project_revision':project['revision'],'version':row['version'] if row else 0,'_excluded':excluded,
                'participants':json.loads(row['roles']) if row else [], 'roles':ROLES,'linked_bids':peers,
                'site':sites[0] if sites else None,'linked_sites':sites,'_site_ids':ids,
                'site_mode':'automatic' if address_key(project['site_address']) else 'manual' if site_id else 'none','site_id':site_id}

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
        if (not isinstance(data,dict) or set(data)-{'remove_party'}!={'project','project_revision','version','participants','site_id'}
                or type(data['version']) is not int or not isinstance(data['participants'],list) or len(data['participants'])>200):
            raise ValidationError('Choose up to 200 participants for the selected project.')
        selector=data['project']
        project=self.projects.participant_project(selector)
        if project['revision']!=data['project_revision']:
            raise ParticipantConflict('The project changed. Reopen its details before changing participants.')
        site_id=identity(data['site_id']) if data['site_id'] is not None else None
        catalog=self._catalog()
        removed = data.get('remove_party')
        if removed is not None:
            if not isinstance(removed,dict) or set(removed) != {'kind','id'} or removed['kind'] not in ('accounts','contacts'):
                raise ValidationError('Choose a participant role and directory record.')
            removed = (removed['kind'], identity(removed['id']))
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=self._existing(db,project)
            version=row['version'] if row else 0
            if version!=data['version']:
                raise ParticipantConflict('Participants changed. Reload the project participants before saving.')
            if site_id and not db.execute('SELECT 1 FROM sites WHERE id=?',(site_id,)).fetchone():
                # Direct Link may select an address from an authorized saved
                # Project. Materialize its deterministic ID only on this POST.
                site=next((candidate for item in catalog['projects'] if (candidate:=address_site(item['site_address'])) and candidate['id']==site_id),None)
                if not site:
                    raise ValidationError('Choose an existing shared site.')
                db.execute('INSERT INTO sites VALUES(?,?,?,?)',(site['id'],site['name'],site['address'],(site['name']+' '+site['address']).casefold()))
            prior={(r['role'],r['kind'],r['id']):r for r in json.loads(row['roles'])} if row else {}
            roles=self._validated_rows(data['participants'],prior)
            previous_ids = {(kind,ident) for _,kind,ident in prior}
            retained = {(r['kind'],r['id']) for r in roles}
            if removed:
                known = previous_ids | {(r['kind'],r['id']) for r in self._derived_parties(project)}
                if removed not in known or removed in retained:
                    raise ValidationError('Choose a participant role and directory record.')
            changed = removed is not None or (row['site_id'] if row else None)!=site_id or roles!=list(prior.values())
            if changed:
                if row:
                    db.execute('DELETE FROM party_lookup WHERE source=? AND owner=?',(row['source'],row['owner']))
                if row and row['owner']!=project['owner']:
                    db.execute('UPDATE project_roles SET owner=? WHERE source=? AND owner=?',(project['owner'],row['source'],row['owner']))
                    db.execute('UPDATE excluded_project_parties SET owner=? WHERE source=? AND owner=?',(project['owner'],row['source'],row['owner']))
                scope = (project['source'],project['owner'])
                if removed:
                    db.execute('INSERT OR IGNORE INTO excluded_project_parties VALUES(?,?,?,?)',(*scope,*removed))
                db.executemany('DELETE FROM excluded_project_parties WHERE source=? AND owner=? AND kind=? AND party_id=?',
                               [(*scope,*party) for party in retained - previous_ids])
                db.execute('''INSERT INTO project_roles VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,owner) DO UPDATE SET
                    project_no=excluded.project_no,client=excluded.client,site_address=excluded.site_address,
                    site_id=excluded.site_id,roles=excluded.roles,version=excluded.version''',
                    (project['source'],project['owner'],project['project_no'],project['client'],project['site_address'],site_id,json.dumps(roles),version+1))
                db.executemany('INSERT INTO party_lookup VALUES(?,?,?,?,?)',
                               [(project['source'],project['owner'],r['role'],r['kind'],r['id']) for r in roles])
                db.execute("""INSERT INTO participant_history(source,owner,version,actor,event,snapshot)
                    VALUES(?,?,?,?,'participants updated',?)""",(project['source'],project['owner'],version+1,json.dumps(actor),
                    json.dumps({'participants':roles,'site_id':site_id,**({'remove_party':data['remove_party']} if removed else {})})))
            record=self._view(db,project,catalog)
        return self._decorate(record,project,catalog)


class ParticipantsHTTP:
    def __init__(self,service):
        self.service=service

    def dispatch(self,handler,route):
        if route not in {'/api/crm/sites','/api/crm/project-participants','/api/crm/project-activity'}:
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
            elif handler.command=='GET' and set(args)=={'project','revision'} and route.endswith('/project-activity'):
                value=self.service.activity(args['project'], args['revision'])
            elif handler.command=='POST' and not args and not route.endswith('/project-activity'):
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
