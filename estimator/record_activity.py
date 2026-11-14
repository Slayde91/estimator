"""Manual record activity, scoped by verified file/workspace and record identities."""
import hashlib
import json
from uuid import UUID

from .catalog import ValidationError
from .crm_activity import _now, activity_values, owner_for


def schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS record_activity (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, record TEXT NOT NULL, request TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, event_type TEXT NOT NULL,
        recorded_at TEXT NOT NULL, text TEXT NOT NULL, owner_name TEXT, due_date TEXT, occurred_at TEXT,
        completed_task INTEGER UNIQUE REFERENCES record_activity(id))""")
    db.execute("CREATE INDEX IF NOT EXISTS record_activity_owner ON record_activity(source,record,id)")


def append(db, source, record, data, actor, staff, conflict):
    if not actor or not actor.get('id'):
        raise ValidationError('Sign in to use CLASSIFIRE.')
    if not isinstance(data, dict) or set(data) - {'request_id','type','text','owner_id','due_date','occurred_at','task_id'}:
        raise ValidationError('Use the activity form.')
    request = data.get('request_id')
    try:
        if not isinstance(request, str) or str(UUID(request)) != request:
            raise ValueError
    except ValueError:
        raise ValidationError('Use the activity form.') from None
    typ, text, due, occurred, task = activity_values(data)
    fingerprint = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    prior = db.execute('SELECT * FROM record_activity WHERE request=?', (request,)).fetchone()
    if prior:
        if (prior['source'],prior['record'],prior['fingerprint'],prior['actor_id']) != (source,record,fingerprint,actor['id']):
            raise conflict('This activity request has changed. Reopen the record.')
        return {'activity_id':prior['id']}
    owner = owner_for(staff, data.get('owner_id','')) or actor
    if task:
        if not db.execute("""SELECT 1 FROM record_activity WHERE id=? AND source=? AND record=? AND event_type='Task'""",
                          (task, source, record)).fetchone():
            raise ValidationError('Choose a task from its original record.')
        if db.execute('SELECT 1 FROM record_activity WHERE completed_task=?', (task,)).fetchone():
            raise conflict('This task has already been completed.')
    row = db.execute("""INSERT INTO record_activity(source,record,request,fingerprint,actor_id,actor_name,event_type,
        recorded_at,text,owner_name,due_date,occurred_at,completed_task) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (source,record,request,fingerprint,actor['id'],actor['name'],typ,_now(),text,None if task else owner['name'],due,occurred,task))
    return {'activity_id':row.lastrowid}


def events(db, source, record):
    return [dict(item) for item in db.execute("""SELECT e.id, e.event_type AS label, e.recorded_at AS at,
        e.actor_name AS actor, e.text AS subject, e.owner_name, e.due_date, e.occurred_at, c.recorded_at AS completed_at
        FROM record_activity e LEFT JOIN record_activity c ON c.completed_task=e.id
        WHERE e.source=? AND e.record=? ORDER BY e.id DESC""", (source,record))]
