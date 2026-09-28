"""Local takeoff sessions, controlled review operations and immutable audit history.

The server owns confirmation receipts. Portable files are evidence and drafts,
not authority: approval badges are recovered only from the local registry after
the exact item and retained source hashes have been checked again.
"""

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from threading import RLock
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_area import AREA_MODES
from .takeoff_model import (MAX_ITEMS, audit_affected, audit_state_digest, digest, identity, item_digest, item_result,
    new_snapshot, object_fields, page_metadata, text, validate_calibration, validate_item, validate_snapshot)
from .takeoff_transfer import calculator_options, profiles, transfer_preview

SESSION_CACHE_BYTES = 4 * 1_048_576
PROCESS_CACHE_BYTES = 16 * 1_048_576


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class TakeoffService:
    def __init__(self, store, documents):
        self.store, self.documents = store, documents
        self._lock = RLock()
        self._sessions = {}
        self._cache_sequence = 0
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS takeoff_approvals (
                receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                item_id TEXT NOT NULL, digest TEXT NOT NULL, kind TEXT NOT NULL,
                receipt TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS takeoff_transfer_receipts (
                project_id TEXT NOT NULL, binding_id TEXT NOT NULL, digest TEXT NOT NULL,
                PRIMARY KEY(project_id,binding_id,digest))''')

    def _session(self, session_id):
        identity(session_id, 'Takeoff session ID')
        if session_id not in self._sessions:
            raise ValidationError('The takeoff session is unavailable. Reopen the project to continue.')
        return self._sessions[session_id]

    def _registered(self, snapshot, item, kind):
        receipt = item[kind]
        if not receipt or receipt['digest'] != item_digest(item, snapshot):
            return False
        with self.store.connect() as db:
            row = db.execute('SELECT receipt FROM takeoff_approvals WHERE receipt_id=? AND project_id=? AND item_id=? AND digest=? AND kind=?',
                (receipt['id'], snapshot['project_id'], item['id'], receipt['digest'], kind)).fetchone()
        return bool(row and json.loads(row[0]) == receipt)

    def _receipt(self, snapshot, item, session_id):
        result = item_result(item, snapshot)
        measurements = ({key: result[key] for key in ('gross_area_m2', 'excluded_area_m2', 'net_area_m2')}
                        if item['mode'] in AREA_MODES else {key: result[key] for key in ('length_m', 'total_length_m')})
        return {'id': str(uuid4()), 'digest': item_digest(item, snapshot), 'at': timestamp(),
                'actor': {'kind': 'local-session', 'session_id': session_id},
                'checks': {'engine': 'takeoffs-area-v1' if item['mode'] in AREA_MODES else 'takeoffs-v1',
                           'quantity': item['quantity'], **measurements,
                           'evidence_verified': True, 'issues': deepcopy(result['issues'])}}

    def _remember(self, snapshot, approvals):
        with self.store.connect() as db:
            for item, kind in approvals:
                receipt = item[kind]
                db.execute('INSERT INTO takeoff_approvals VALUES(?,?,?,?,?,?)',
                    (receipt['id'], snapshot['project_id'], item['id'], receipt['digest'], kind,
                     json.dumps(receipt, sort_keys=True)))

    def _response(self, session_id, *, evidence=False):
        session = self._session(session_id)
        state = session['snapshot']
        return {'session_id': session_id, 'revision': state['revision'], 'snapshot': deepcopy(state),
                'issues': deepcopy(session.get('evidence_issues', [])) + (self.documents.validate_project_documents(state['documents'], owner=session_id) if evidence else []),
                'item_results': [item_result(item, state) for item in state['items']]}

    def open(self, snapshot=None, source_path=None, evidence_issues=None):
        with self._lock:
            if len(self._sessions) >= 64:
                raise ValidationError('Too many open takeoff sessions. Close an unused session before opening another.')
            value = new_snapshot() if snapshot is None else validate_snapshot(snapshot)
            session_id = str(uuid4())
            persistent_issues = list(evidence_issues or [])
            if source_path is not None:
                persistent_issues.extend(self.documents.restore(value, source_path, owner=session_id))
            elif snapshot is not None and (value['documents'] or value['items'] or value['audit_head']):
                persistent_issues.append({'code': 'EVIDENCE_BUNDLE_UNAVAILABLE', 'message': 'Open the original project with its evidence companion folder to verify its retained source files. An uploaded snapshot cannot recover source or approval authority from cached files.'})
            try:
                self._verify_audit_head(value, owner=session_id)
            except (ValidationError, OSError) as error:
                persistent_issues.append({'code': 'AUDIT_STATE_MISMATCH', 'message': str(error)})
            issues = persistent_issues + self.documents.validate_project_documents(value['documents'], owner=session_id)
            blocked_docs = {issue.get('document_id') for issue in issues}
            for item in value['items']:
                refs = item['evidence'] + ([item['geometry']] if item['geometry'] else [])
                if issues or any(r['document_id'] in blocked_docs for r in refs) or not self._registered(value, item, 'review'):
                    item.update(state='draft', review=None, confirmation=None)
                elif item['state'] == 'confirmed' and not self._registered(value, item, 'confirmation'):
                    item.update(state='reviewed', confirmation=None)
            for binding in value['transfers']:
                with self.store.connect() as db:
                    registered = db.execute('SELECT 1 FROM takeoff_transfer_receipts WHERE project_id=? AND binding_id=? AND digest=?',
                        (value['project_id'], binding['id'], self._binding_digest(binding))).fetchone()
                if not registered:
                    binding['status'] = 'conflict'
            self._sessions[session_id] = {'snapshot': value, 'requests': {}, 'previews': {}, 'evidence_issues': persistent_issues}
            result = self._response(session_id)
            result['issues'] = issues
            return result

    def saved_source(self, session_id, snapshot, path):
        with self._lock:
            session = self._session(session_id)
            if snapshot['project_id'] != session['snapshot']['project_id']:
                raise ValidationError('The saved evidence belongs to another takeoff project.')
            try:
                self.documents.bind_source(session_id, snapshot, path)
            except (ValidationError, OSError):
                session['evidence_issues'].append({'code': 'SAVE_SOURCE_UNAVAILABLE', 'message': 'The saved project evidence could not be revalidated. Reopen the complete saved project before downstream use.'})
                raise

    def close(self, session_id):
        with self._lock:
            self._session(session_id)
            self.documents.close_owner(session_id)
            del self._sessions[session_id]

    def get(self, session_id, verify_evidence=True):
        with self._lock:
            return self._response(session_id, evidence=verify_evidence)

    def capture(self, session_id, snapshot):
        with self._lock:
            state = self._session(session_id)['snapshot']
            incoming = validate_snapshot(snapshot)
            # A saved companion path is a portability locator, never an approval input.
            compare = lambda value: {k: v for k, v in value.items() if k != 'companion_folder'}
            if digest(compare(incoming)) != digest(compare(state)):
                raise ValidationError('The takeoff draft changed while saving. Capture the current draft and retry.')
            self._session_evidence(session_id)
            self.documents.assert_documents(state['documents'], owner=session_id)
            self._verify_audit_head(state, owner=session_id)
            return deepcopy(state)

    def _verify_audit_head(self, snapshot, owner=None):
        head = snapshot['audit_head']
        if head is None:
            if snapshot['revision'] != 0 or any(snapshot[key] for key in ('documents', 'calibrations', 'items', 'transfers', 'render_checks')):
                raise ValidationError('The takeoff state has no matching retained audit history.')
            return
        self.documents.validate_audit(snapshot, owner=owner)
        event = self.documents.get_blob(head, kind='audit')
        if (event.get('version') != 1 or event.get('project_id') != snapshot['project_id']
                or type(event.get('revision')) is not int or event['revision'] != snapshot['revision']
                or not isinstance(event.get('after'), dict)
                or audit_state_digest(event['after']) != audit_state_digest(snapshot)):
            raise ValidationError('The current takeoff state does not match its retained audit head.')

    def _session_evidence(self, session_id):
        issues = self._session(session_id).get('evidence_issues', [])
        if issues:
            raise ValidationError('Retained evidence is unavailable or changed. Restore the complete original evidence bundle before review, confirmation, export or transfer.')

    def _binding_digest(self, binding):
        return digest({key: value for key, value in binding.items() if key != 'status'})

    def _remember_request(self, session, request, **metadata):
        session['requests'][request['request_id']] = {'request_hash': digest(request), **metadata}
        if len(session['requests']) > 100:
            session['requests'].pop(next(iter(session['requests'])))

    def _cache_payload(self, session_id, bucket, key, payload):
        """Bound reusable previews/results; completed operation hashes stay small."""
        size = len(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode())
        if size > SESSION_CACHE_BYTES:
            raise ValidationError('This transfer preview exceeds the supported memory limit. Reduce the selected items and preview again.')
        def entries():
            return [(sid, name, identity, value) for sid, session in self._sessions.items()
                    for name in ('previews', 'requests') for identity, value in session[name].items()
                    if 'payload' in value]
        while True:
            retained = entries()
            local = sum(value['cache_bytes'] for sid, _, _, value in retained if sid == session_id)
            total = sum(value['cache_bytes'] for _, _, _, value in retained)
            if local + size <= SESSION_CACHE_BYTES and total + size <= PROCESS_CACHE_BYTES:
                break
            candidates = [entry for entry in retained if local + size <= SESSION_CACHE_BYTES or entry[0] == session_id]
            sid, name, identity, value = min(candidates, key=lambda entry: entry[3]['cache_sequence'])
            if name == 'previews':
                del self._sessions[sid][name][identity]
            else:
                for field in ('payload', 'cache_bytes', 'cache_sequence'):
                    value.pop(field, None)
        self._cache_sequence += 1
        target = self._sessions[session_id][bucket].setdefault(key, {})
        target.update(payload=deepcopy(payload), cache_bytes=size, cache_sequence=self._cache_sequence)

    def _request_response(self, session_id, prior):
        response = self._response(session_id)
        if prior.get('applied_transfer'):
            if 'payload' not in prior or prior['applied_revision'] != response['revision']:
                raise ValidationError('This transfer was already applied. Its response expired or the workspace changed; inspect the current calculator and review a new preview. It will not be applied twice.')
            result = prior['payload']
            self._session_evidence(session_id)
            snapshot = self._session(session_id)['snapshot']
            self._assert_eligible(snapshot, self._items(snapshot, [binding['item_id'] for binding in result['bindings']]),
                                  confirmed=True, session_id=session_id)
            response['transfer'] = deepcopy(result)
            response['calculator'] = {'id': result['calculator_id'], 'inputs': deepcopy(result['inputs']),
                                      'schedule_rows': deepcopy(result['schedule_rows'])}
        response.update(deepcopy(prior.get('metadata', {})))
        return response

    def _start(self, session_id, request):
        if not isinstance(request, dict):
            raise ValidationError('A controlled takeoff operation requires an object.')
        session = self._session(session_id)
        identity(request.get('request_id'), 'Request ID')
        request_hash = digest(request)
        prior = session['requests'].get(request['request_id'])
        if prior:
            if prior['request_hash'] != request_hash:
                raise ValidationError('This request ID was already used for a different operation.')
            if request.get('op') in ('review_items', 'confirm_items'):
                # A retry may return the current state without another receipt,
                # but it must not present cached authority over changed evidence.
                self._session_evidence(session_id)
                self.documents.assert_documents(session['snapshot']['documents'], owner=session_id)
                self._verify_audit_head(session['snapshot'], owner=session_id)
            return session, self._request_response(session_id, prior)
        if type(request.get('expected_revision')) is not int or request['expected_revision'] != session['snapshot']['revision']:
            raise ValidationError('The takeoff draft changed. Reload its current state before applying this operation.')
        return session, None

    def _commit(self, session_id, request, before, after, approvals=(), transfers=()):
        after['revision'] = before['revision'] + 1
        after['audit_head'] = before['audit_head']
        validate_snapshot(after, copy_result=False)
        # put_blob serializes synchronously while the service lock protects
        # both states. Root projections remove the head without copying each
        # immutable source/page tree merely to serialize it immediately.
        strip = lambda value: {k: v for k, v in value.items() if k != 'audit_head'}
        event = {'version': 1, 'project_id': before['project_id'], 'revision': after['revision'],
                 'previous': before['audit_head'], 'request_id': request['request_id'],
                 'op': request['op'], 'at': timestamp(), 'before': strip(before), 'after': strip(after),
                 'actor': {'kind': 'local-session', 'session_id': session_id},
                 'affected_ids': audit_affected(before, after)}
        after['audit_head'] = self.documents.put_blob(event, kind='audit')
        # Check the prospective retained graph before any session/authority
        # change. A rejected event leaves only an unreferenced immutable blob.
        self.documents.validate_audit(after, owner=session_id)
        self._remember(after, approvals)
        with self.store.connect() as db:
            for binding in transfers:
                db.execute('INSERT OR IGNORE INTO takeoff_transfer_receipts VALUES(?,?,?)',
                    (after['project_id'], binding['id'], self._binding_digest(binding)))
        session = self._session(session_id)
        session['snapshot'] = after
        session['previews'].clear()
        response = self._response(session_id)
        self._remember_request(session, request)
        return response

    def _items(self, snapshot, ids):
        if not isinstance(ids, list) or not ids or len(ids) > MAX_ITEMS or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
            raise ValidationError('Select a nonempty list of distinct item IDs.')
        mapping = {i['id']: i for i in snapshot['items']}
        if any(not isinstance(i, str) or i not in mapping for i in ids):
            raise ValidationError('A selected takeoff item no longer exists.')
        return [mapping[i] for i in ids]

    def _invalidate(self, snapshot, item):
        item['version'] += 1
        item.update(state='draft', review=None, confirmation=None)
        for binding in snapshot['transfers']:
            if binding['item_id'] == item['id']:
                binding['status'] = 'stale'

    def _create_item(self, snapshot, proposed, predecessors=None):
        object_fields(proposed, {'id', 'mode', 'geometry', 'measurement', 'quantity', 'fields', 'evidence', 'member_ids'}, 'New takeoff item', {'mode'})
        item = {'id': proposed.get('id', str(uuid4())), 'version': 1, 'mode': proposed['mode'], 'state': 'draft',
                'geometry': deepcopy(proposed.get('geometry')), 'measurement': deepcopy(proposed.get('measurement')),
                'quantity': proposed.get('quantity'), 'fields': deepcopy(proposed.get('fields', {})),
                'evidence': deepcopy(proposed.get('evidence', [])), 'review': None, 'confirmation': None,
                'predecessor_ids': deepcopy(predecessors or [])}
        item['member_ids'] = deepcopy(proposed.get('member_ids', []))
        if 'member_ids' not in proposed:
            self._resize_members(item)
        if any(i['id'] == item['id'] for i in snapshot['items']):
            raise ValidationError('This takeoff item ID already exists.')
        validate_item(item, snapshot, copy_result=False)
        snapshot['items'].append(item)
        return item

    def _resize_members(self, item):
        quantity = item['quantity']
        if quantity is None:
            item['member_ids'] = []
        elif type(quantity) is int and 0 < quantity <= MAX_ITEMS:
            retained = item.get('member_ids', [])[:quantity]
            item['member_ids'] = retained + [str(uuid4()) for _ in range(quantity-len(retained))]
        else:
            raise ValidationError(f'Physical quantity must be an explicit integer from 1 to {MAX_ITEMS}.')

    def _remove(self, snapshot, selected):
        ids = {i['id'] for i in selected}
        snapshot['items'] = [i for i in snapshot['items'] if i['id'] not in ids]
        for binding in snapshot['transfers']:
            if binding['item_id'] in ids:
                binding['status'] = 'deleted'

    def _predecessors(self, originals):
        return sorted({identifier for item in originals for identifier in (item['id'], *item.get('predecessor_ids', []))})

    def _steel_group(self, item):
        if item['mode'] != 'steel' or type(item['quantity']) is not int or item['quantity'] <= 0:
            raise ValidationError('Choose steel groups with explicit positive physical quantities.')
        if len(item['member_ids']) != item['quantity'] or len(set(item['member_ids'])) != item['quantity']:
            raise ValidationError('Steel groups must retain one distinct identity for every physical member.')

    def _group_proposal(self, original):
        return {key: deepcopy(original[key]) for key in ('mode', 'quantity', 'fields', 'geometry', 'measurement', 'evidence', 'member_ids')}

    def _assert_eligible(self, snapshot, items, *, confirmed=False, session_id=None):
        self.documents.assert_documents(snapshot['documents'], owner=session_id)
        self._verify_audit_head(snapshot, owner=session_id)
        for item in items:
            issues = item_result(item, snapshot)['issues']
            if issues:
                raise ValidationError(issues[0]['message'])
            if not self._registered(snapshot, item, 'review'):
                raise ValidationError('Review each current takeoff item before confirmation.')
            if confirmed and (item['state'] != 'confirmed' or not self._registered(snapshot, item, 'confirmation')):
                raise ValidationError('Every selected item must have a current locally verified confirmation.')

    def command(self, session_id, request):
        with self._lock:
            session, prior = self._start(session_id, request)
            if prior:
                return prior
            before = session['snapshot']; after = deepcopy(before); approvals = []
            op = request.get('op')
            specs = {'create_item': {'item'}, 'update_item': {'item_id', 'changes'},
                     'bulk_update': {'item_ids', 'changes'}, 'delete_items': {'item_ids'},
                     'review_items': {'item_ids'}, 'confirm_items': {'item_ids'},
                     'unconfirm_items': {'item_ids'}, 'add_calibration': {'calibration'},
                     'update_calibration': {'calibration_id', 'changes'},
                     'delete_document': {'document_id'}, 'record_render': {'document_id', 'page', 'success', 'warnings'},
                     'undo': set(), 'split_item': {'item_id', 'parts'}, 'merge_items': {'item_ids', 'item'},
                     'split_steel_group': {'item_id', 'quantities'}, 'merge_steel_groups': {'item_ids'},
                     'detach_transfers': {'item_ids', 'calculator_id'}}
            if not isinstance(op, str) or op not in specs:
                raise ValidationError('This takeoff operation is not supported.')
            object_fields(request, {'expected_revision', 'request_id', 'op'} | specs[op], 'Takeoff operation',
                          {'expected_revision', 'request_id', 'op'} | specs[op])
            revised_calibration_id = None
            if op == 'create_item':
                self._create_item(after, request['item'])
            elif op in ('update_item', 'bulk_update'):
                selected = self._items(after, [request['item_id']] if op == 'update_item' else request['item_ids'])
                allowed = {'fields', 'quantity'} if op == 'bulk_update' else {'fields', 'quantity', 'geometry', 'measurement', 'evidence', 'member_ids'}
                changes = object_fields(request['changes'], allowed, 'Takeoff edit')
                if not changes:
                    raise ValidationError('Choose at least one field to edit.')
                for item in selected:
                    for key, value in changes.items():
                        if key == 'fields':
                            if not isinstance(value, dict):
                                raise ValidationError('Field edits must be an object.')
                            item['fields'].update(deepcopy(value))
                        else:
                            item[key] = deepcopy(value)
                    if 'quantity' in changes and 'member_ids' not in changes:
                        self._resize_members(item)
                    self._invalidate(after, item)
                    validate_item(item, after, copy_result=False)
            elif op == 'delete_items':
                self._remove(after, self._items(after, request['item_ids']))
            elif op == 'detach_transfers':
                if request['calculator_id'] not in ('steel_vermiculite', 'steel_board', 'ductwork'):
                    raise ValidationError('Choose a supported calculator to detach.')
                requested = request['item_ids']
                if not isinstance(requested, list) or not 1 <= len(requested) <= MAX_ITEMS:
                    raise ValidationError('Select a bounded nonempty list of linked item IDs to detach.')
                ids = {identity(value, 'Linked item ID') for value in requested}
                if len(ids) != len(requested):
                    raise ValidationError('Select distinct linked item IDs to detach.')
                linked = {binding['item_id'] for binding in after['transfers'] if binding['calculator_id'] == request['calculator_id']}
                if ids - linked:
                    raise ValidationError('Every selected item must have a retained link to the chosen calculator, including historical items.')
                after['transfers'] = [b for b in after['transfers'] if not (b['item_id'] in ids and b['calculator_id'] == request['calculator_id'])]
            elif op in ('review_items', 'confirm_items', 'unconfirm_items'):
                selected = self._items(after, request['item_ids'])
                if op == 'review_items':
                    self._session_evidence(session_id)
                    self.documents.assert_documents(after['documents'], owner=session_id)
                    self._verify_audit_head(after, owner=session_id)
                    for item in selected:
                        if any(i['code'] in ('PAGE_REVIEW_BLOCKED', 'MISSING_EVIDENCE', 'MISSING_GEOMETRY') for i in item_result(item, after)['issues']):
                            raise ValidationError('Render and inspect the marked source evidence before recording human review.')
                        item['review'] = self._receipt(after, item, session_id)
                        item.update(state='reviewed', confirmation=None)
                        approvals.append((item, 'review'))
                elif op == 'confirm_items':
                    self._session_evidence(session_id)
                    self._assert_eligible(after, selected, session_id=session_id)
                    for item in selected:
                        item['confirmation'] = self._receipt(after, item, session_id)
                        item['state'] = 'confirmed'; approvals.append((item, 'confirmation'))
                else:
                    for item in selected:
                        self._invalidate(after, item)
            elif op == 'add_calibration':
                proposed = deepcopy(request['calibration'])
                if not isinstance(proposed, dict):
                    raise ValidationError('Calibration must be an object.')
                proposed.setdefault('id', str(uuid4()))
                if any(c['id'] == proposed['id'] for c in after['calibrations']):
                    raise ValidationError('Calibration revisions are immutable. Add a new calibration ID.')
                after['calibrations'].append(validate_calibration(proposed, after))
            elif op == 'update_calibration':
                calibration_id = identity(request['calibration_id'], 'Calibration ID')
                original = next((c for c in after['calibrations'] if c['id'] == calibration_id), None)
                if original is None:
                    raise ValidationError('Choose an existing calibration to revise.')
                changes = object_fields(request['changes'], {'name', 'distance_m', 'points', 'uniform_scale'}, 'Calibration revision')
                if not changes:
                    raise ValidationError('Choose a calibration property to revise.')
                revised = {**deepcopy(original), **deepcopy(changes), 'id': str(uuid4())}
                after['calibrations'].append(validate_calibration(revised, after))
                revised_calibration_id = revised['id']
                for item in after['items']:
                    if item['measurement'] and item['measurement'].get('calibration_id') == calibration_id:
                        item['measurement']['calibration_id'] = revised_calibration_id
                        self._invalidate(after, item)
            elif op == 'delete_document':
                document_id = identity(request['document_id'], 'Document ID')
                if not any(d['id'] == document_id for d in after['documents']):
                    raise ValidationError('The selected source document no longer exists.')
                for item in after['items']:
                    refs = item['evidence'] + ([item['geometry']] if item['geometry'] else [])
                    if any(r['document_id'] == document_id for r in refs):
                        raise ValidationError('Remove or reassign all linked items before deleting their source document.')
                after['documents'] = [d for d in after['documents'] if d['id'] != document_id]
                after['calibrations'] = [c for c in after['calibrations'] if c['document_id'] != document_id]
                after['render_checks'] = [r for r in after['render_checks'] if r['document_id'] != document_id]
            elif op == 'record_render':
                doc, _ = page_metadata(after, request['document_id'], request['page'])
                record = {key: deepcopy(request[key]) for key in ('document_id', 'page', 'success', 'warnings')}
                record['sha256'] = doc['sha256']
                previous = next((r for r in after['render_checks'] if (r['document_id'], r['page']) == (record['document_id'], record['page'])), None)
                if previous == record:
                    response = self._response(session_id)
                    self._remember_request(session, request)
                    return response
                after['render_checks'] = [r for r in after['render_checks'] if (r['document_id'], r['page']) != (record['document_id'], record['page'])]
                after['render_checks'].append(record)
                if record['success'] is not True or record['warnings']:
                    for item in after['items']:
                        refs = item['evidence'] + ([item['geometry']] if item['geometry'] else [])
                        if any((r['document_id'], r['page']) == (record['document_id'], record['page']) for r in refs):
                            self._invalidate(after, item)
            elif op == 'undo':
                if not before['audit_head']:
                    raise ValidationError('There is no takeoff operation to undo.')
                event = self.documents.get_blob(before['audit_head'], kind='audit')
                if event['project_id'] != before['project_id'] or event['revision'] != before['revision']:
                    raise ValidationError('Audit history does not match this takeoff revision.')
                if event['op'] in ('apply_transfer', 'undo', 'record_render', 'detach_transfers'):
                    raise ValidationError('Schedule transfers, source-render observations and undo receipts cannot be reversed by takeoff-only undo.')
                after = deepcopy(event['before']); after['audit_head'] = before['audit_head']
                originals = {i['id']: i for i in before['items']}
                for item in after['items']:
                    original = originals.get(item['id'])
                    if original is None or item_digest(item, after) != item_digest(original, before):
                        item['version'] = max(item['version'], original['version'] if original else 0)
                        self._invalidate(after, item)
            elif op == 'split_item':
                original = self._items(after, [request['item_id']])[0]
                if original['mode'] in AREA_MODES:
                    raise ValidationError('Surface split is unavailable until exact coverage and exclusion preservation can be verified. Edit its polygon or group separate surfaces explicitly.')
                parts = request['parts']
                if not isinstance(parts, list) or not 2 <= len(parts) <= 100:
                    raise ValidationError('Split requires two to 100 explicit replacement runs.')
                if original['mode'] != 'duct' or original['quantity'] != 1 or not original['measurement'] or original['measurement']['method'] != 'calibrated':
                    raise ValidationError('Split supports individual calibrated duct runs; edit distinct steel members individually.')
                created = [self._create_item(after, part, self._predecessors([original])) for part in parts]
                self._validate_topology_change(original, created, after)
                self._remove(after, [original])
            elif op == 'merge_items':
                originals = self._items(after, request['item_ids'])
                if any(item['mode'] in AREA_MODES for item in originals):
                    raise ValidationError('Surface merge is unavailable until exact coverage and exclusion preservation can be verified. Group separate surfaces without changing their identities.')
                if len(originals) < 2:
                    raise ValidationError('Merge requires at least two adjoining runs.')
                replacement = self._create_item(after, request['item'], self._predecessors(originals))
                self._validate_topology_change(replacement, originals, after)
                self._remove(after, originals)
            elif op == 'split_steel_group':
                original = self._items(after, [request['item_id']])[0]
                self._steel_group(original)
                quantities = request['quantities']
                if (not isinstance(quantities, list) or not 2 <= len(quantities) <= 100
                        or any(type(value) is not int or value <= 0 for value in quantities)
                        or sum(quantities) != original['quantity']):
                    raise ValidationError('Partition the steel group into two to 100 positive integer quantities whose sum exactly matches the original quantity.')
                offset = 0
                for quantity in quantities:
                    proposed = self._group_proposal(original)
                    proposed['quantity'] = quantity
                    proposed['member_ids'] = original['member_ids'][offset:offset+quantity]
                    self._create_item(after, proposed, self._predecessors([original]))
                    offset += quantity
                self._remove(after, [original])
            elif op == 'merge_steel_groups':
                originals = self._items(after, request['item_ids'])
                if len(originals) < 2:
                    raise ValidationError('Choose at least two compatible steel groups to merge.')
                first = originals[0]
                members = []
                for original in originals:
                    self._steel_group(original)
                    if (any(original[key] != first[key] for key in ('fields', 'geometry', 'measurement'))
                            or item_result(original, after)['issues']):
                        raise ValidationError('Steel groups must have identical complete fields, source geometry and length basis. Resolve differences explicitly before merging.')
                    members.extend(original['member_ids'])
                if len(members) != len(set(members)):
                    raise ValidationError('Merged steel groups cannot count the same physical member twice.')
                proposed = self._group_proposal(first)
                proposed.update(quantity=sum(item['quantity'] for item in originals), member_ids=members)
                references = {digest(reference): deepcopy(reference) for item in originals for reference in item['evidence']}
                proposed['evidence'] = list(references.values())
                self._create_item(after, proposed, self._predecessors(originals))
                self._remove(after, originals)
            response = self._commit(session_id, request, before, after, approvals)
            if revised_calibration_id:
                response['revised_calibration_id'] = revised_calibration_id
                session['requests'][request['request_id']]['metadata'] = {'revised_calibration_id': revised_calibration_id}
            return response

    def _validate_topology_change(self, whole, parts, snapshot):
        if whole['mode'] != 'duct' or whole['quantity'] != 1 or not whole['measurement'] or whole['measurement']['method'] != 'calibrated':
            raise ValidationError('Merge/split requires one calibrated duct run per physical item.')
        chain = []
        for part in parts:
            if (part['mode'] != 'duct' or part['quantity'] != 1 or part['fields'] != whole['fields']
                    or part['measurement'] != whole['measurement'] or not part['geometry']
                    or (part['geometry']['document_id'], part['geometry']['page']) != (whole['geometry']['document_id'], whole['geometry']['page'])):
                raise ValidationError('Merge/split must preserve size, system, orientation, treatment, scale and source page.')
            pts = part['geometry']['points']
            if chain and chain[-1] != pts[0]:
                raise ValidationError('Merged/split runs must meet at their actual endpoints in selection order.')
            chain.extend(pts if not chain else pts[1:])
        if chain != whole['geometry']['points']:
            # Collinear split points may be added, but endpoints, path and length must agree.
            from .takeoff_model import polyline_length
            baseline = whole['geometry']['points']
            if (chain[0] != baseline[0] or chain[-1] != baseline[-1]
                    or not math.isclose(polyline_length(chain), polyline_length(baseline), rel_tol=1e-10, abs_tol=1e-9)
                    or any(point not in chain for point in baseline)):
                raise ValidationError('Merge/split cannot manufacture or discard measured geometry.')
        refs = {digest(r): r for item in [whole, *parts] for r in item['evidence']}
        whole['evidence'] = list(refs.values())
        for part in parts:
            part['evidence'] = list(refs.values())

    def add_document(self, session_id, document, expected_revision):
        with self._lock:
            session = self._session(session_id)
            if type(expected_revision) is not int or expected_revision != session['snapshot']['revision']:
                raise ValidationError('The takeoff project changed while importing the PDF. Retry the import into its current state.')
            before = session['snapshot']; after = deepcopy(before)
            if any(d['id'] == document.get('id') for d in after['documents']):
                raise ValidationError('This source document is already in the project.')
            if any(d['sha256'] == document.get('sha256') for d in after['documents']):
                raise ValidationError('This exact PDF is already retained. Reuse its source pages rather than duplicating the document.')
            self.documents.assert_documents([document])
            self.documents.assert_add_capacity(before, document)
            after['documents'].append(deepcopy(document))
            request = {'request_id': str(uuid4()), 'expected_revision': expected_revision, 'op': 'add_document'}
            return self._commit(session_id, request, before, after)

    def history(self, session_id, offset=0, limit=50):
        with self._lock:
            if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
                raise ValidationError('History requires a bounded offset and page size.')
            snapshot = self._session(session_id)['snapshot']; head = snapshot['audit_head']; rows = []; visited = set(); index = 0
            while head and index < offset+limit:
                if head in visited:
                    raise ValidationError('The takeoff audit chain contains a cycle.')
                visited.add(head)
                event = self.documents.get_blob(head, kind='audit')
                if event['project_id'] != snapshot['project_id']:
                    raise ValidationError('The audit event belongs to another project.')
                if index >= offset:
                    rows.append({key: event[key] for key in ('revision', 'op', 'at', 'request_id', 'actor', 'affected_ids') if key in event})
                head = event['previous']; index += 1
            return {'items': rows, 'offset': offset, 'limit': limit, 'has_more': bool(head)}

    def profiles(self, calculator_id, query='', offset=0, limit=50):
        return profiles(calculator_id, query, offset, limit)

    def profile_options(self, calculator_id, search=''):
        matches = profiles(calculator_id, search) if calculator_id != 'ductwork' else {'items': [], 'total': 0, 'offset': 0, 'limit': 50}
        return {**matches, **calculator_options(calculator_id)}

    def options(self, calculator_id, fields=None):
        return calculator_options(calculator_id, fields)

    def preview_transfer(self, session_id, request):
        with self._lock:
            if not isinstance(request, dict):
                raise ValidationError('A transfer preview requires a structured request.')
            session = self._session(session_id); snapshot = session['snapshot']
            if type(request.get('expected_revision')) is not int or request['expected_revision'] != snapshot['revision']:
                raise ValidationError('The takeoff draft changed before transfer preview.')
            selected = self._items(snapshot, request.get('item_ids'))
            self._session_evidence(session_id)
            self._assert_eligible(snapshot, selected, confirmed=True, session_id=session_id)
            result = transfer_preview(snapshot, request)
            preview_id = str(uuid4())
            result.update(preview_id=preview_id, revision=snapshot['revision'])
            self._cache_payload(session_id, 'previews', preview_id,
                                {'item_ids': request['item_ids'], 'result': result})
            if len(session['previews']) > 20:
                session['previews'].pop(next(iter(session['previews'])))
            return {k: deepcopy(v) for k, v in result.items() if k != 'all_bindings'}

    def apply_transfer(self, session_id, request):
        with self._lock:
            object_fields(request, {'expected_revision', 'request_id', 'preview_id', 'inputs', 'schedule_rows'},
                          'Transfer confirmation', {'expected_revision', 'request_id', 'preview_id', 'inputs', 'schedule_rows'})
            actual = {**request, 'op': 'apply_transfer'}
            session, prior = self._start(session_id, actual)
            if prior:
                return prior
            identity(request['preview_id'], 'Transfer preview ID')
            cached = session['previews'].get(request['preview_id'])
            if not cached:
                raise ValidationError('This transfer preview expired. Review a new preview.')
            preview = cached['payload']
            before = session['snapshot']; result = preview['result']
            if digest({'inputs': request['inputs'], 'schedule_rows': request['schedule_rows']}) != result['base_fingerprint']:
                raise ValidationError('The calculator draft changed during transfer review. Your edits were preserved; preview again.')
            self._session_evidence(session_id)
            self._assert_eligible(before, self._items(before, preview['item_ids']), confirmed=True, session_id=session_id)
            after = deepcopy(before); after['transfers'] = deepcopy(result['all_bindings'])
            response = self._commit(session_id, actual, before, after, transfers=result['bindings'])
            response['transfer'] = {k: deepcopy(v) for k, v in result.items() if k != 'all_bindings'}
            response['calculator'] = {'id': result['calculator_id'], 'inputs': deepcopy(result['inputs']), 'schedule_rows': deepcopy(result['schedule_rows'])}
            session['requests'][request['request_id']].update(applied_transfer=True, applied_revision=response['revision'])
            self._cache_payload(session_id, 'requests', request['request_id'], response['transfer'])
            return response

    def export(self, session_id, format, selected_ids=None):
        from .takeoff_exports import export_register
        with self._lock:
            snapshot = self._session(session_id)['snapshot']
            selected = self._items(snapshot, selected_ids) if selected_ids is not None else list(snapshot['items'])
            if not selected:
                raise ValidationError('There are no confirmed takeoff items to export.')
            self._session_evidence(session_id)
            self._assert_eligible(snapshot, selected, confirmed=True, session_id=session_id)
            return export_register(snapshot, selected, format)
