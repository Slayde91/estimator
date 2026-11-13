"""Positive ownership of documents explicitly saved before their project has a file."""
from contextlib import contextmanager
from contextvars import ContextVar
from hashlib import sha256
import base64
import json
from pathlib import Path
import secrets
import zlib

from .catalog import ValidationError
from .commercial_documents import apply_project_document_details, CommercialConflict, commercial_cards, _stored_document

STALE = 'This document changed or its project was filed. Reopen its board and select the document again.'


def _revision(row):
    return sha256(f"{row['token']}:{row['generation']}".encode()).hexdigest()


def quote_context(body):
    """Keep the estimating inputs used by derive_estimates; exclude live session capabilities."""
    estimates = []
    for item in body.get('estimates', []):
        workspace = item['workspace']
        if not isinstance(workspace, dict):
            raise ValidationError('Include the complete workspace of each estimate.')
        captured = {k: workspace[k] for k in ('estimate', 'calculators', 'penetration', 'library_drafts') if k in workspace}
        estimates.append({'id': item['id'], 'name': item['name'], 'workspace': captured})
    return {'estimates': estimates, 'active_estimate_id': body.get('active_estimate_id')}


class UnfiledCommercial:
    def __init__(self, service, db):
        self.service = service
        self._access = ContextVar('unfiled_commercial_access', default=None)
        db.executescript("""
            CREATE TABLE IF NOT EXISTS local_commercial_owners (
                workspace TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1,
                filed INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS local_commercial_documents (
                workspace TEXT NOT NULL, id TEXT NOT NULL, estimates BLOB,
                PRIMARY KEY(workspace,id));
            CREATE TABLE IF NOT EXISTS local_commercial_publications (
                workspace TEXT PRIMARY KEY, path TEXT NOT NULL, digest TEXT NOT NULL, prior_digest TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS local_commercial_edit AFTER UPDATE ON commercial_drafts
                WHEN EXISTS (SELECT 1 FROM local_commercial_documents WHERE workspace=NEW.workspace AND id=NEW.id)
                BEGIN UPDATE local_commercial_owners SET generation=generation+1 WHERE workspace=NEW.workspace; END;
            CREATE TRIGGER IF NOT EXISTS local_commercial_delete AFTER DELETE ON commercial_drafts
                BEGIN
                    UPDATE local_commercial_owners SET generation=generation+1 WHERE workspace=OLD.workspace
                        AND EXISTS (SELECT 1 FROM local_commercial_documents WHERE workspace=OLD.workspace AND id=OLD.id);
                    DELETE FROM local_commercial_documents WHERE workspace=OLD.workspace AND id=OLD.id;
                END;
        """)
        if 'prior_digest' not in {column['name'] for column in db.execute('PRAGMA table_info(local_commercial_publications)')}:
            db.execute("ALTER TABLE local_commercial_publications ADD COLUMN prior_digest TEXT NOT NULL DEFAULT 'unknown'")

    def enroll(self, db, workspace, identity, captured):
        db.execute('INSERT OR IGNORE INTO local_commercial_owners(workspace,token) VALUES (?,?)',
                   (workspace, 'local-' + secrets.token_hex(32)))
        row = db.execute('SELECT filed FROM local_commercial_owners WHERE workspace=?', (workspace,)).fetchone()
        if row['filed']:
            raise CommercialConflict('This workspace already has a project file. Reload the project before saving.')
        previous = db.execute('SELECT estimates FROM local_commercial_documents WHERE workspace=? AND id=?',
                              (workspace, identity)).fetchone()
        packed = zlib.compress(json.dumps(captured, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()) if captured else None
        if previous is None or previous['estimates'] != packed:
            db.execute('INSERT OR REPLACE INTO local_commercial_documents VALUES(?,?,?)', (workspace, identity, packed))
            db.execute('UPDATE local_commercial_owners SET generation=generation+1 WHERE workspace=?', (workspace,))

    @staticmethod
    def bind_file(db, workspace):
        # A filed workspace can never regain local ownership, even through a stale window.
        db.execute('INSERT INTO local_commercial_owners(workspace,token,filed) VALUES(?,?,1) '
                   'ON CONFLICT(workspace) DO UPDATE SET filed=1,generation=generation+1',
                   (workspace, 'local-' + secrets.token_hex(32)))
        db.execute('DELETE FROM local_commercial_documents WHERE workspace=?', (workspace,))
        db.execute('DELETE FROM local_commercial_publications WHERE workspace=?', (workspace,))

    def prepare_publication(self, workspace, path, digest, prior_digest):
        with self.service._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._check_pending(db, workspace)
            db.execute("""INSERT INTO local_commercial_publications(workspace,path,digest,prior_digest)
                SELECT workspace,?,?,? FROM local_commercial_owners WHERE workspace=? AND filed=0
                ON CONFLICT(workspace) DO UPDATE SET path=excluded.path,digest=excluded.digest,prior_digest=excluded.prior_digest""",
                (str(path), digest, prior_digest, workspace))

    def recover_publications(self, verify_and_register):
        with self.service._connect() as db:
            if not db.execute('SELECT 1 FROM local_commercial_publications LIMIT 1').fetchone():
                return
            db.execute('BEGIN IMMEDIATE')
            for row in db.execute("""SELECT p.*,w.project_id FROM local_commercial_publications p
                    JOIN commercial_workspaces w USING(workspace)""").fetchall():
                if verify_and_register(row):
                    self.bind_file(db, row['workspace'])
                    db.execute('DELETE FROM pending_quote_project_stages WHERE workspace=?', (row['workspace'],))

    def cancel_publication(self, workspace, path, digest):
        with self.service._connect() as db:
            db.execute('DELETE FROM local_commercial_publications WHERE workspace=? AND path=? AND digest=?',
                       (workspace,str(path),digest))

    def cards(self, active_workspace):
        with self.service._connect() as db:
            rows = db.execute("""SELECT o.token,o.generation,o.workspace,w.project_id,d.data
                FROM local_commercial_owners o JOIN commercial_workspaces w USING(workspace)
                JOIN local_commercial_documents m USING(workspace)
                JOIN commercial_drafts d ON d.workspace=m.workspace AND d.id=m.id WHERE o.filed=0""")
            cards = []
            for row in rows:
                card, = commercial_cards({'project_id':row['project_id'], 'documents':[json.loads(row['data'])]})
                cards.append({**card, 'source_file':row['token'], 'source_revision':_revision(row),
                              'source_path':None, 'unfiled':True, 'current_workspace':active_workspace == row['workspace']})
            return cards

    def _owner(self, db, source):
        row = db.execute('SELECT o.*,w.project_id FROM local_commercial_owners o JOIN commercial_workspaces w '
                         'USING(workspace) WHERE o.token=? AND o.filed=0', (source['file_id'],)).fetchone()
        if row is None or _revision(row) != source['revision']:
            raise CommercialConflict(STALE)
        return row

    def activity(self, source, identity):
        with self.service._connect() as db:
            db.execute('BEGIN')
            owner = self._owner(db, source)
            self._check_pending(db, owner['workspace'])
            row = db.execute('''SELECT d.data FROM local_commercial_documents m
                JOIN commercial_drafts d USING(workspace,id) WHERE m.workspace=? AND m.id=?''',
                (owner['workspace'], identity)).fetchone()
            if not row:
                raise CommercialConflict(STALE)
            return self.service._document_activity(db, owner['project_id'], json.loads(row['data']))

    def scheduler_order(self, source, revision, project, identity):
        """Verify exactly one explicitly saved board record, including an interrupted file handover."""
        with self.service._connect() as db:
            db.execute('BEGIN')
            owner = self._owner(db, {'file_id':source, 'revision':revision})
            if owner['project_id'] != project:
                raise CommercialConflict(STALE)
            self._check_pending(db, owner['workspace'])
            row = db.execute('''SELECT d.data FROM local_commercial_documents m
                JOIN commercial_drafts d USING(workspace,id) WHERE m.workspace=? AND m.id=?''',
                (owner['workspace'], identity)).fetchone()
            if row:
                card, = commercial_cards({'project_id':project, 'documents':[json.loads(row['data'])]})
                if card['kind'] == 'work_order':
                    return {**card, 'source_file':source, 'source_revision':revision}
            return None

    def permits_document(self, db, workspace, identity):
        if self._access.get() is None:
            return True
        return db.execute('SELECT 1 FROM local_commercial_documents WHERE workspace=? AND id=?',
                          (workspace, identity)).fetchone() is not None

    def verified_project(self, db, workspace):
        # Only this request's internal adapter may reopen a durable commercial
        # owner after the interactive certificate session expires or restarts.
        self._check_pending(db, workspace)
        source = self._access.get()
        if source is not None:
            owner = self._owner(db, source)
            if owner['workspace'] != workspace:
                raise CommercialConflict(STALE)
            return owner['project_id']
        return None

    @staticmethod
    def _check_pending(db, workspace):
        # A request may be in flight when the publishing process dies. Check
        # the native selection again inside each document write transaction.
        pending = db.execute('SELECT path,digest,prior_digest FROM local_commercial_publications WHERE workspace=?',
                             (workspace,)).fetchone()
        if not pending:
            return
        from .project_library import _directory, _read_file
        path = Path(pending['path'])
        unavailable = 'The project save destination cannot be verified. Restore access to its folder and reopen the board.'
        try:
            _directory(path.parent)
            try:
                path.lstat()
            except FileNotFoundError:
                actual = ''
            else:
                contents, _ = _read_file(path)
                actual = sha256(contents).hexdigest()
        except (ValidationError, OSError) as error:
            raise CommercialConflict(unavailable) from error
        if actual == pending['digest']:
            raise CommercialConflict(STALE)
        if actual != pending['prior_digest']:
            raise CommercialConflict(unavailable)

    @contextmanager
    def _authorized(self, source):
        token = self._access.set(source)
        try:
            yield
        finally:
            self._access.reset(token)

    def perform(self, action, source, body, execute):
        if action == 'issue':
            raise ValidationError('Save this project before downloading its commercial documents.')
        with self.service._connect() as db:
            owner = self._owner(db, source)
            workspace, project = owner['workspace'], owner['project_id']
            records = {row['id']:row for row in db.execute(
                'SELECT m.id,d.data FROM local_commercial_documents m JOIN commercial_drafts d USING(workspace,id) WHERE m.workspace=?',
                (workspace,))}
            anchor = body.pop('context_id', None) or body.get('id')
            document = _stored_document(records[anchor]['data']) if isinstance(anchor,str) and anchor in records else None
            if action == 'attachment' and set(body) == {'name','content'} and document and (
                    document['kind'] == 'work_order' or document['kind'] == 'quote' and document['last_number']):
                return self.service.files.add(project, body['name'], body['content'])
            if not document:
                raise CommercialConflict(STALE)
            related = commercial_cards({'project_id':project, 'documents':[json.loads(row['data']) for row in records.values()]}, include_quote_files=action == 'open')
            entry = db.execute('SELECT estimates FROM local_commercial_documents WHERE workspace=? AND id=?',(workspace,anchor)).fetchone()
            captured = json.loads(zlib.decompress(entry[0])) if entry[0] else {}
        details = {key:document['fields']['details'][key] for key in ('project_no','client','site_address')}
        from .work_order_billing import unfiled_context
        billing_project = unfiled_context(captured)
        captured.pop('billing_project',None)
        project_details = {**details, **billing_project,
            **{project_key:document['fields']['details'].get(doc_key,'') for project_key,doc_key in
               (('contact_name','contact'),('contact_phone','phone'),('contact_email','email'))}}
        order = body['fields'].get('order') if isinstance(body.get('fields'), dict) else None
        linked_work_order = (action == 'save' and body.get('kind') == 'work_order' and body.get('version') == 0
                             and document['kind'] == 'quote' and document['last_number']
                             and isinstance(order,dict) and order.get('quote_id') == anchor)
        if (action == 'save' or 'id' in body) and body.get('id') != anchor and not linked_work_order:
            raise CommercialConflict(STALE)
        with self._authorized(source):
            if action == 'open' and set(body) == {'id'}:
                model = self.service.view(workspace, include_quote_totals=True)
                totals = model['quote_totals']
                quote_rows = {}
                if document['kind'] == 'work_order' and not document['fields'].get('work_tracking'):
                    link = document['fields']['order']
                    identity, reference = link['quote_id'], link['quote_reference']
                    if identity in records:
                        rows = model['quote_rows'].get(identity, {}).get(reference)
                        if rows is not None:
                            quote_rows = {identity:{reference:rows}}
                return {'document':document, 'details':details, 'related':related, **({'project_details':project_details} if billing_project else {}),
                        'quote_rows':quote_rows,
                        'quote_totals':{k:v for k,v in totals.items() if k in records},
                        'quote_total':totals.get(anchor,{}).get(document['last_number'],''),
                        'estimates':[{'id':item['id'],'name':item['name']} for item in captured.get('estimates',[])]}
            if action == 'read-attachment' and set(body) == {'id','file_id'}:
                item, raw = self.service.read_attachment(workspace, anchor, body['file_id'])
                return {**item, 'content':base64.b64encode(raw).decode('ascii')}
            if action == 'save':
                if not isinstance(body.get('fields'),dict) or not isinstance(body['fields'].get('details'),dict):
                    raise ValidationError('Include the document and its project details.')
                if (body.get('kind') == 'work_order' and isinstance(order, dict) and order.get('quote_id')
                        and order['quote_id'] != document['fields']['order'].get('quote_id')
                        and (not isinstance(order['quote_id'], str) or order['quote_id'] not in records)):
                    raise ValidationError('Choose a saved Quote from this project.')
                apply_project_document_details(body['fields'], details)
                if billing_project:
                    body['project_details'] = project_details
                if (body.get('kind') == 'purchase_order' and isinstance(order,dict) and order.get('work_order_id')
                        and order['work_order_id'] != document['fields']['order'].get('work_order_id')
                        and order['work_order_id'] not in records):
                    raise ValidationError('Choose a saved Work Order from this project.')
            if action == 'defaults':
                body['details'] = {**body.get('details',{}), **details}
            result = execute(action, {**body, **captured, 'workspace_id':workspace,
                                      **({'retain_unfiled':True} if linked_work_order else {})})
        with self.service._connect() as db:
            row = db.execute('SELECT * FROM local_commercial_owners WHERE token=? AND filed=0',(source['file_id'],)).fetchone()
            if not row:
                raise CommercialConflict(STALE)
            return {'result':result, 'revision':_revision(row)}
