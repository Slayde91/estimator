"""Prospective directory history. All events share their owning write transaction."""

from datetime import date, datetime, timezone
import json
from uuid import UUID

from .catalog import ValidationError

KINDS = ('leads', 'contacts', 'accounts')
LINK = {'leads':'lead_id', 'contacts':'contact_id', 'accounts':'account_id'}
ACTIVITIES = ('Call', 'Email', 'Meeting', 'Note', 'Task')


def schema(db):
    # No backfill: a pre-existing record has no known creation time.
    for ddl in (
        """CREATE TABLE IF NOT EXISTS crm_record_facts (
            kind TEXT NOT NULL, record_id TEXT NOT NULL, created_at TEXT, updated_at TEXT, last_interaction_at TEXT,
            PRIMARY KEY(kind,record_id))""",
        """CREATE TABLE IF NOT EXISTS crm_assignments (
            kind TEXT NOT NULL, record_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL, region TEXT NOT NULL,
            PRIMARY KEY(kind,record_id))""",
        """CREATE TABLE IF NOT EXISTS crm_events (
            id INTEGER PRIMARY KEY, event_type TEXT NOT NULL, recorded_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT,
            kind TEXT NOT NULL, record_id TEXT NOT NULL, lead_id TEXT, contact_id TEXT, account_id TEXT,
            detail TEXT NOT NULL, occurred_at TEXT, owner_id TEXT, owner_name TEXT, due_date TEXT, completed_task INTEGER UNIQUE REFERENCES crm_events(id),
            request_id TEXT UNIQUE, request_data TEXT)""",
    ):
        db.execute(ddl)
    if 'occurred_at' not in {row[1] for row in db.execute('PRAGMA table_info(crm_events)')}:
        db.execute('ALTER TABLE crm_events ADD COLUMN occurred_at TEXT')
    for column in LINK.values():
        db.execute(f'CREATE INDEX IF NOT EXISTS crm_events_{column} ON crm_events({column},id)')


def _watch(db, table, kind, ident, columns, *, deleted=False):
    """Observe indirect changes too, e.g. a lead creating a company or moving a contact.

    TEMP triggers live only on this write connection. They never require changes to old
    databases or clients and follow savepoints and rollback along with the real write.
    """
    field_list = ' || '.join(f"CASE WHEN OLD.{c} IS NOT NEW.{c} THEN '{c} ' ELSE '' END" for c in columns)
    updates = " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in columns)
    for action, ref, condition, changed in [
        ('INSERT', 'NEW', '', "'created'"),
        ('UPDATE', 'NEW', ' WHEN ' + updates, field_list),
        ('DELETE', 'OLD', '', "'removed'"),
    ]:
        if action == 'DELETE' and not deleted:
            continue
        old_status = 'OLD.status' if table == 'leads' and action == 'UPDATE' else 'NULL'
        old_owner = 'OLD.owner_name' if table == 'crm_assignments' and action != 'INSERT' else 'NULL'
        record_kind = f"'{kind}'" if kind else f'{ref}.kind'
        db.execute(f"""CREATE TEMP TRIGGER watch_{table}_{action} AFTER {action} ON main.{table}{condition}
            BEGIN INSERT INTO crm_writes(kind,record_id,table_name,operation,changed,old_status,old_owner)
            VALUES({record_kind},{ref}.{ident},'{table}','{action}',{changed},{old_status},{old_owner}); END""")


def begin_tracking(db):
    db.execute("""CREATE TEMP TABLE crm_writes(kind,record_id,table_name,operation,changed,old_status,old_owner)""")
    _watch(db, 'accounts', 'accounts', 'id', ('company', 'billing_address', 'abn_acn'))
    _watch(db, 'contacts', 'contacts', 'id', ('name', 'phone', 'title', 'email', 'account_id'))
    _watch(db, 'leads', 'leads', 'id', ('contact_id', 'site_address', 'billing_address', 'description', 'status', 'person_snapshot'))
    _watch(db, 'lead_followups', 'leads', 'lead_id', ('next_action', 'follow_up_date'), deleted=True)
    _watch(db, 'crm_assignments', None, 'record_id', ('owner_id', 'owner_name', 'region'), deleted=True)
    _watch(db, 'account_links', 'accounts', 'account_id', ('label',), deleted=True)


def _key(kind, ident):
    if kind not in KINDS or not isinstance(ident,str):
        raise ValidationError('Choose a saved directory record.')
    try:
        if str(UUID(ident)) != ident:
            raise ValueError
    except ValueError:
        raise ValidationError('Choose a saved directory record.') from None


def references(db, kind, ident):
    _key(kind, ident)
    if kind == 'leads':
        row = db.execute("""SELECT l.contact_id,c.account_id,l.person_snapshot FROM leads l
            JOIN contacts c ON c.id=l.contact_id WHERE l.id=?""", (ident,)).fetchone()
        if row:
            client = json.loads(row['person_snapshot'])['account_id'] if row['person_snapshot'] else row['account_id']
            return ident,row['contact_id'],client
        row = db.execute('SELECT contact_id,account_id FROM converted_leads WHERE lead_id=?',(ident,)).fetchone()
        if row:
            return ident,row['contact_id'],row['account_id']
    elif kind == 'contacts':
        row = db.execute('SELECT account_id FROM contacts WHERE id=?',(ident,)).fetchone()
        if row:
            return None,ident,row['account_id']
    elif db.execute('SELECT 1 FROM accounts WHERE id=?',(ident,)).fetchone():
        return None,None,ident
    raise ValidationError('This record could not be found. Reload the directory.')


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def event(db, kind, ident, typ, detail, actor, *, owner=None, due=None, task=None, request_id=None, request_data=None, stamp=None, links=None, occurred=None):
    stamp = stamp or _now()
    if links is None:
        links = references(db,kind,ident)
    if kind=='leads':
        record=db.execute('SELECT site_address FROM leads WHERE id=?',(ident,)).fetchone()
        if record and record[0]: detail={**detail,'subject':record[0]}
    elif kind=='contacts':
        record=db.execute('SELECT name FROM contacts WHERE id=?',(ident,)).fetchone()
        if record: detail={**detail,'subject':record[0]}
    else:
        record=db.execute('SELECT company FROM accounts WHERE id=?',(ident,)).fetchone()
        if record: detail={**detail,'subject':record[0]}
    cursor = db.execute("""INSERT INTO crm_events(event_type,recorded_at,actor_id,actor_name,kind,record_id,
        lead_id,contact_id,account_id,detail,occurred_at,owner_id,owner_name,due_date,completed_task,request_id,request_data)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (typ,stamp,(actor or {}).get('id'),(actor or {}).get('name'),kind,ident,
        *links,json.dumps(detail,ensure_ascii=False),occurred,(owner or {}).get('id'),(owner or {}).get('name'),due,task,request_id,request_data))
    if typ in ('Call','Email','Meeting'):
        for linked_kind, linked_id in zip(KINDS,links):
            if linked_id:
                db.execute("""INSERT INTO crm_record_facts(kind,record_id,last_interaction_at) VALUES(?,?,?)
                    ON CONFLICT(kind,record_id) DO UPDATE SET last_interaction_at=MAX(COALESCE(last_interaction_at,''),
                    excluded.last_interaction_at)""",(linked_kind,linked_id,occurred or stamp))
    return cursor.lastrowid


def finish_tracking(db, actor):
    if actor:
        # Include records created indirectly by a lead, workbook import or billing form.
        db.execute("""INSERT INTO crm_assignments(kind,record_id,owner_id,owner_name,region)
            SELECT kind,record_id,?,?,''
            FROM crm_writes WHERE table_name=kind AND operation='INSERT'
            ON CONFLICT(kind,record_id) DO UPDATE SET owner_id=excluded.owner_id,owner_name=excluded.owner_name
            WHERE crm_assignments.owner_id=''""", (actor['id'], actor['name']))
    changes = {}
    for row in db.execute('SELECT * FROM crm_writes ORDER BY rowid'):
        changes.setdefault((row['kind'],row['record_id']),[]).append(row)
    stamp = _now()
    for (kind, ident), records in changes.items():
        created = any(r['table_name']==kind and r['operation']=='INSERT' for r in records)
        fields = set()
        for r in records:
            if r['table_name'] in KINDS:
                fields.update(r['changed'].split())
            elif r['table_name']=='account_links':
                fields.add('links')
            elif r['table_name']=='lead_followups':
                fields.add('follow_up')
            else:
                fields.update(('owner','region') if r['operation']!='UPDATE' else r['changed'].split())
        detail = {'fields':sorted(fields-{'created'})}
        previous = next((r['old_status'] for r in records if r['old_status'] is not None and 'status' in r['changed'].split()),None)
        if previous is not None:
            detail.update(previous_status=previous,status=db.execute('SELECT status FROM leads WHERE id=?',(ident,)).fetchone()[0])
        if any(r['table_name']=='crm_assignments' for r in records):
            assignment = db.execute('SELECT owner_name,region FROM crm_assignments WHERE kind=? AND record_id=?',(kind,ident)).fetchone()
            detail.update(owner=assignment['owner_name'] if assignment else '',region=assignment['region'] if assignment else '')
            for change in records:
                if change['table_name']=='crm_assignments' and change['old_owner'] and change['old_owner']!=detail['owner']:
                    detail['previous_owner']=change['old_owner'];break
        db.execute("""INSERT INTO crm_record_facts(kind,record_id,created_at,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(kind,record_id) DO UPDATE SET updated_at=excluded.updated_at""",(kind,ident,stamp if created else None,stamp))
        event(db,kind,ident,'Created' if created else 'Stage changed' if previous is not None else 'Updated',detail,actor,stamp=stamp)


def add_metadata(db, directory):
    from . import crm_identity
    aliases=crm_identity.aliases(db)
    for kind in KINDS:
        by_id={row['id']:row for row in directory[kind]}
        interactions={}
        for table, fields in [('crm_record_facts','created_at,updated_at,last_interaction_at'),('crm_assignments','owner_id,owner_name,region')]:
            for row in db.execute(f'SELECT record_id,{fields} FROM {table} WHERE kind=?',(kind,)):
                target = by_id.get(row['record_id'])
                if target is not None:
                    target.update({key:row[key] for key in fields.split(',') if row[key]})
                if table=='crm_record_facts' and row['last_interaction_at']:
                    survivor=aliases.get(kind,{}).get(row['record_id'],row['record_id'])
                    interactions[survivor]=max(interactions.get(survivor,''),row['last_interaction_at'])
        for survivor,latest in interactions.items():
            if survivor in by_id:
                by_id[survivor]['last_interaction_at']=latest


def record_metadata(db, kind, ident):
    row={'id':ident}
    # Conversion reads only the one record's metadata under its existing transaction.
    for table, fields in [('crm_record_facts','created_at,updated_at,last_interaction_at'),('crm_assignments','owner_id,owner_name,region')]:
        meta=db.execute(f'SELECT {fields} FROM {table} WHERE kind=? AND record_id=?',(kind,ident)).fetchone()
        if meta:
            row.update({k:meta[k] for k in meta.keys() if meta[k]})
    if kind in ('accounts','contacts'):
        from . import crm_identity
        group=crm_identity.group_ids(crm_identity.aliases(db)[kind],ident)
        if len(group)>1:
            latest=db.execute("""SELECT MAX(last_interaction_at) FROM crm_record_facts WHERE kind=?
                AND record_id IN (SELECT value FROM json_each(?))""",(kind,json.dumps(sorted(group)))).fetchone()[0]
            if latest:row['last_interaction_at']=latest
    return row


def owner_for(provider, owner_id):
    if not isinstance(owner_id,str) or len(owner_id)>80:
        raise ValidationError('Choose an active staff member.')
    if not owner_id:
        return {}
    for member in provider():
        if member['id']==owner_id:
            return {'id':member['id'],'name':member['name']}
    raise ValidationError('Choose an active staff member.')


def assign(db, kind, ident, body, provider):
    if 'owner_id' not in body and 'region' not in body:
        return
    old=db.execute('SELECT owner_id,owner_name,region FROM crm_assignments WHERE kind=? AND record_id=?',(kind,ident)).fetchone()
    old= dict(old) if old else {'owner_id':'','owner_name':'','region':''}
    owner_id=body.get('owner_id',old['owner_id'])
    region=body.get('region',old['region'])
    if 'region' in body and (kind!='leads' or not isinstance(region,str) or len(region)>160 or not region.isprintable() and region):
        raise ValidationError('Enter a valid region.')
    region=region.strip()
    owner_name=old['owner_name'] if owner_id==old['owner_id'] else owner_for(provider,owner_id).get('name','')
    if not region and not owner_id:
        db.execute('DELETE FROM crm_assignments WHERE kind=? AND record_id=?',(kind,ident))
    else:
        db.execute("""INSERT INTO crm_assignments VALUES(?,?,?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET
            owner_id=excluded.owner_id,owner_name=excluded.owner_name,region=excluded.region""",(kind,ident,owner_id,owner_name,region))


def timeline(db, kind, ident, before=None):
    references(db,kind,ident)
    if before is not None and (not isinstance(before,str) or not before.isascii() or not before.isdecimal() or len(before)>18):
        raise ValidationError('Choose a valid activity page.')
    ids=[ident]
    if kind in ('contacts','accounts'):
        from . import crm_identity
        ids=sorted(crm_identity.group_ids(crm_identity.aliases(db)[kind],ident))
    rows=list(db.execute(f"""SELECT e.id,e.event_type,e.recorded_at,e.occurred_at,e.actor_id,e.actor_name,e.kind,e.record_id,e.detail,
        e.owner_id,e.owner_name,e.due_date,c.recorded_at AS completed_at FROM crm_events e
        LEFT JOIN crm_events c ON c.completed_task=e.id WHERE e.{LINK[kind]} IN (SELECT value FROM json_each(?))
        AND e.id<? ORDER BY e.id DESC LIMIT 51""",(json.dumps(ids),int(before) if before is not None else 2**63-1)))
    return {'events':[{**dict(row),'detail':json.loads(row['detail'])} for row in rows[:50]],
            'next_before':str(rows[49]['id']) if len(rows)>50 else None}


def log_activity(store, body, actor, conflict):
    if not isinstance(body,dict) or set(body)-{'id','kind','request_id','version','type','text','owner_id','due_date','task_id','occurred_at'}:
        raise ValidationError('Use the activity form.')
    kind,ident,req,typ=map(body.get,('kind','id','request_id','type'))
    _key(kind,ident)
    _key(kind,req)
    text=body.get('text','')
    due=body.get('due_date','')
    occurred=None
    if 'occurred_at' in body:
        try:
            if typ not in ('Call','Email','Meeting') or not isinstance(body['occurred_at'],str) or len(body['occurred_at'])>40:
                raise ValueError
            moment=datetime.fromisoformat(body['occurred_at'])
            if moment.utcoffset() is None or moment>datetime.now(timezone.utc):
                raise ValueError
            occurred=moment.astimezone(timezone.utc).isoformat(timespec='microseconds')
        except (ValueError,OverflowError):
            raise ValidationError('Enter a valid interaction time in the past or present.') from None
    if typ not in (*ACTIVITIES,'Task completed') or not isinstance(text,str) or len(text)>4000 or (not text.strip() and typ!='Task completed') or any(ord(c)<32 and c not in '\t\r\n' or 0xd800<=ord(c)<=0xdfff for c in text):
        raise ValidationError('Choose an activity and enter its details.')
    if not isinstance(due,str):
        raise ValidationError('Choose a valid task due date.')
    if due:
        try:
            if typ!='Task' or date.fromisoformat(due).isoformat()!=due: raise ValueError
        except (ValueError,TypeError):
            raise ValidationError('Choose a valid task due date.') from None
    task=body.get('task_id')
    if typ=='Task completed':
        if type(task) is not int or not 0<task<2**63 or text or body.get('owner_id') or due:
            raise ValidationError('Choose the task to complete.')
    elif task is not None:
        raise ValidationError('Choose the task to complete.')
    fingerprint=json.dumps({k:v for k,v in body.items() if k not in ('version','request_id')},sort_keys=True)
    with store.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        existing=db.execute('SELECT id,actor_id,request_data FROM crm_events WHERE request_id=?',(req,)).fetchone()
        if existing:
            if existing['request_data']!=fingerprint or existing['actor_id']!=(actor or {}).get('id'):
                raise conflict('This activity request has changed. Reopen the record.')
            return {'activity_id':existing['id'],'version':store._version(db)}
        if type(body.get('version')) is not int or body['version']!=store._version(db):
            raise conflict('Contacts have changed. Reopen the form to review the latest values.')
        links=references(db,kind,ident)
        if task:
            original=db.execute('SELECT kind,record_id,lead_id,contact_id,account_id FROM crm_events WHERE id=? AND event_type=?',(task,'Task')).fetchone()
            if not original or (original['kind'],original['record_id'])!=(kind,ident):
                raise ValidationError('Choose a task from its original record.')
            if db.execute('SELECT 1 FROM crm_events WHERE completed_task=?',(task,)).fetchone():
                raise conflict('This task has already been completed.')
            links=tuple(original[column] for column in LINK.values())
        owner=owner_for(store.staff_provider,body.get('owner_id',''))
        if not owner and not task:
            owner=actor
        eid=event(db,kind,ident,typ,{'text':text.strip()},actor,owner=owner,due=due or None,task=task,
                  request_id=req,request_data=fingerprint,links=links,occurred=occurred)
        db.execute('UPDATE revision SET version=version+1 WHERE id=1')
        return {'activity_id':eid,'version':store._version(db)}
