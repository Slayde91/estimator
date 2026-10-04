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
from .takeoff_model import (MAX_ITEMS, audit_affected, audit_state_digest, digest, identity, is_count_item,
                           is_area_item, is_marker_item, is_standalone_count, is_standalone_length, is_standalone_item, item_digest, item_result,
    new_snapshot, object_fields, page_metadata, text, validate_calibration, validate_item, validate_snapshot)
from .takeoff_model import (active_calibrations, item_references, markup_appearance, number, preset_distance, validate_appearance,
                           validate_calibration_revisions, validate_measurement_scope, polyline_length, points)
from .takeoff_transfer import calculator_options, profiles, transfer_preview, transfer_selection
from .takeoff_linked_delete import prepare_delete as prepare_linked_delete, prepare_undo as prepare_linked_undo
from .takeoff_copy import duplicate_length_proposals
from .takeoff_physical import entity_references, graph_collections, validate_graph
from .takeoff_physical_operations import current_graph, prepare_changes, scope_key, validate_source_links

SESSION_CACHE_BYTES = 4 * 1_048_576
PROCESS_CACHE_BYTES = 16 * 1_048_576


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def reconcile_length_anchors(item, previous_geometry, snapshot):
    """Follow identifiable control-point edits without guessing retrace identity."""
    additions = item.get('length_additions', [])
    if not isinstance(additions, list):
        raise ValidationError('Riser/drop additions must be a list.')
    anchored = [entry for entry in additions if isinstance(entry, dict) and 'anchor' in entry]
    geometry = item['geometry']
    if not anchored or geometry == previous_geometry:
        return
    if (not isinstance(previous_geometry, dict) or not isinstance(geometry, dict)
            or any(geometry.get(key) != previous_geometry.get(key) for key in ('document_id', 'page'))):
        raise ValidationError('Remove or reassign point-anchored riser/drop additions before changing the line source.')
    _, page = page_metadata(snapshot, geometry.get('document_id'), geometry.get('page'))
    old = points(previous_geometry.get('points'), 'Previous line', page, minimum=2)
    new = points(geometry.get('points'), 'Edited line', page, minimum=2)
    for entry in anchored:
        anchor = object_fields(entry['anchor'], {'point_index', 'point'}, 'Riser/drop point anchor',
                               {'point_index', 'point'})
        index = number(anchor['point_index'], 'Riser/drop point index', integer=True)
        points([anchor['point']], 'Riser/drop point anchor', page, maximum=1)
        if not 0 <= index < len(old) or anchor['point'] != old[index]:
            raise ValidationError('Edit the riser/drop point anchor separately from its line geometry.')
    mapping = None
    if len(old) == len(new):
        changed = sum(first != second for first, second in zip(old, new))
        offset = [new[0][axis] - old[0][axis] for axis in (0, 1)]
        translated = all(math.isclose(second[axis] - first[axis], offset[axis], rel_tol=0, abs_tol=1e-9)
                         for first, second in zip(old, new) for axis in (0, 1))
        if changed <= 1 or translated:
            mapping = list(range(len(old)))
    elif abs(len(old) - len(new)) == 1:
        shorter, longer = (old, new) if len(old) < len(new) else (new, old)
        prefix = 0
        while prefix < len(shorter) and shorter[prefix] == longer[prefix]:
            prefix += 1
        suffix = 0
        while suffix < len(shorter) and shorter[-suffix-1] == longer[-suffix-1]:
            suffix += 1
        # Multiple possible insert/delete indices (for repeated coordinates)
        # cannot establish which physical control point survived.
        if len(shorter) - suffix == prefix:
            if len(old) < len(new):
                mapping = [index + (index >= prefix) for index in range(len(old))]
            else:
                if any(entry['anchor']['point_index'] == prefix for entry in anchored):
                    raise ValidationError('Remove or reassign the riser/drop addition before deleting its anchored control point.')
                mapping = [index - (index > prefix) for index in range(len(old))]
    if mapping is None:
        raise ValidationError('Remove or reassign point-anchored riser/drop additions before retracing or ambiguously editing the line.')
    for entry in anchored:
        index = mapping[entry['anchor']['point_index']]
        entry['anchor'] = {'point_index': index, 'point': deepcopy(new[index])}


def image_annotation_region(quad, view):
    """Clip a convex image placement for a source marker, never image pixels."""
    polygon = deepcopy(quad)
    for axis, boundary, lower in ((0, view[0], True), (0, view[2], False),
                                  (1, view[1], True), (1, view[3], False)):
        if not polygon:
            break
        output = []
        start = polygon[-1]
        start_inside = start[axis] >= boundary if lower else start[axis] <= boundary
        for end in polygon:
            end_inside = end[axis] >= boundary if lower else end[axis] <= boundary
            if start_inside != end_inside:
                ratio = (boundary-start[axis])/(end[axis]-start[axis])
                intersection = [start[index]+ratio*(end[index]-start[index]) for index in (0, 1)]
                intersection[axis] = boundary
                output.append(intersection)
            if end_inside:
                output.append(list(end))
            start, start_inside = end, end_inside
        polygon = output
    unique = []
    for point in polygon:
        point = [min(max(point[0], view[0]), view[2]), min(max(point[1], view[1]), view[3])]
        if point not in unique:
            unique.append(point)
    if len(unique) < 3:
        return None
    origin = unique[0]
    area = math.fsum((a[0]-origin[0])*(b[1]-origin[1])-(b[0]-origin[0])*(a[1]-origin[1])
                     for a, b in zip(unique, unique[1:]+unique[:1]))
    return unique if area else None


class TakeoffService:
    def __init__(self, store, documents):
        self.store, self.documents = store, documents
        self._lock = RLock()
        self._sessions = {}
        self._cache_sequence = 0
        self._image_jobs = set()
        if not hasattr(documents, 'images') and hasattr(documents, 'root'):
            from .takeoff_image_evidence import TakeoffImageEvidence
            documents.images = TakeoffImageEvidence(store, documents)
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS takeoff_approvals (
                receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                item_id TEXT NOT NULL, digest TEXT NOT NULL, kind TEXT NOT NULL,
                receipt TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS takeoff_transfer_receipts (
                project_id TEXT NOT NULL, binding_id TEXT NOT NULL, digest TEXT NOT NULL,
                PRIMARY KEY(project_id,binding_id,digest))''')
            db.execute('''CREATE TABLE IF NOT EXISTS takeoff_linked_deletions (
                project_id TEXT NOT NULL, audit_head TEXT NOT NULL, receipt TEXT NOT NULL,
                PRIMARY KEY(project_id,audit_head))''')

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
                        if is_area_item(item) else {'total_count': result['total_count']} if is_standalone_count(item)
                        else {key: result[key] for key in ('length_m', 'total_length_m')})
        return {'id': str(uuid4()), 'digest': item_digest(item, snapshot), 'at': timestamp(),
                'actor': {'kind': 'local-session', 'session_id': session_id},
                'checks': {'engine': ('takeoffs-area-v1' if is_area_item(item) else 'takeoffs-count-v1' if is_standalone_count(item)
                                     else 'takeoffs-length-v1' if is_standalone_length(item) else 'takeoffs-v1'),
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
        undo, _ = self._linked_delete_context(state)
        return {'session_id': session_id, 'revision': state['revision'], 'snapshot': deepcopy(state),
                'issues': deepcopy(session.get('evidence_issues', [])) + (self.documents.validate_project_documents(state['documents'], owner=session_id) if evidence else []),
                'linked_undo': ({'calculator_ids': sorted(undo), 'revision': state['revision'],
                    'cleared_rows': [{'calculator_id': calculator_id, 'row': row['row'], 'input_hash': row['cleared_hash']}
                                     for calculator_id in sorted(undo) for row in undo[calculator_id]['rows']]}
                                if undo else None),
                'item_results': [item_result(item, state) for item in state['items']]}

    def _linked_delete_context(self, snapshot):
        # Page rendering is an observation, not an intervening item edit. Its
        # current render checks must survive a later coupled Undo.
        head, revision = snapshot['audit_head'], snapshot['revision']
        with self.store.connect() as db:
            if not db.execute('SELECT 1 FROM takeoff_linked_deletions WHERE project_id=? LIMIT 1',
                              (snapshot['project_id'],)).fetchone():
                return None, None
            while head:
                row = db.execute('SELECT receipt FROM takeoff_linked_deletions WHERE project_id=? AND audit_head=?',
                                 (snapshot['project_id'], head)).fetchone()
                if row:
                    return json.loads(row[0]), head
                try:
                    event = self.documents.get_blob(head, kind='audit')
                except (ValidationError, OSError):
                    break
                if (event.get('op') != 'record_render' or event.get('project_id') != snapshot['project_id']
                        or event.get('revision') != revision):
                    break
                head, revision = event['previous'], revision - 1
        return None, None

    def open(self, snapshot=None, source_path=None, evidence_issues=None):
        with self._lock:
            if len(self._sessions) >= 64:
                raise ValidationError('Too many open takeoff sessions. Close an unused session before opening another.')
            value = new_snapshot() if snapshot is None else validate_snapshot(snapshot)
            session_id = str(uuid4())
            persistent_issues = list(evidence_issues or [])
            if source_path is not None:
                persistent_issues.extend(self.documents.restore(value, source_path, owner=session_id))
            elif snapshot is not None and (value['documents'] or value['items'] or value['audit_head']
                                           or value.get('physical') or value.get('service_plans') or value.get('image_extractions')):
                persistent_issues.append({'code': 'EVIDENCE_BUNDLE_UNAVAILABLE', 'message': 'Open the original project with its evidence companion folder to verify its retained source files. An uploaded snapshot cannot recover source or approval authority from cached files.'})
            try:
                self._verify_audit_head(value, owner=session_id)
            except (ValidationError, OSError) as error:
                persistent_issues.append({'code': 'AUDIT_STATE_MISMATCH', 'message': str(error)})
            issues = persistent_issues + self.documents.validate_project_documents(value['documents'], owner=session_id)
            blockers = [issue for issue in issues if issue.get('code') != 'IMAGE_EXTRACTION_UNREGISTERED']
            blocked_docs = {issue.get('document_id') for issue in blockers}
            for item in value['items']:
                refs = item_references(item)
                if blockers or any(r['document_id'] in blocked_docs for r in refs) or not self._registered(value, item, 'review'):
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
            self._validate_physical_links(session_id, state)
            if hasattr(self.documents, 'assert_image_evidence'):
                self.documents.assert_image_evidence(state, owner=session_id)
            return deepcopy(state)

    def _verify_audit_head(self, snapshot, owner=None):
        head = snapshot['audit_head']
        if head is None:
            if (snapshot['revision'] != 0 or any(snapshot[key] for key in ('documents', 'calibrations', 'items', 'transfers', 'render_checks'))
                    or snapshot.get('physical') or snapshot.get('service_plans') or snapshot.get('image_extractions')):
                raise ValidationError('The takeoff state has no matching retained audit history.')
            return
        self.documents.validate_audit(snapshot, owner=owner)
        event = self.documents.get_blob(head, kind='audit')
        if (event.get('version') != snapshot['version'] or event.get('project_id') != snapshot['project_id']
                or type(event.get('revision')) is not int or event['revision'] != snapshot['revision']
                or not isinstance(event.get('after'), dict)
                or audit_state_digest(event['after']) != audit_state_digest(snapshot)):
            raise ValidationError('The current takeoff state does not match its retained audit head.')

    def _session_evidence(self, session_id):
        issues = self._session(session_id).get('evidence_issues', [])
        if any(issue.get('code') != 'IMAGE_EXTRACTION_UNREGISTERED' for issue in issues):
            raise ValidationError('Retained evidence is unavailable or changed. Restore the complete original evidence bundle before review, confirmation, export or transfer.')

    def _binding_digest(self, binding):
        return digest({key: value for key, value in binding.items() if key != 'status'})

    def _images(self):
        manager = getattr(self.documents, 'images', None)
        if manager is None:
            raise ValidationError('The image evidence manager is unavailable.')
        return manager

    def _validate_physical_links(self, session_id, snapshot):
        from .takeoff_model import validate_physical_extension
        validate_physical_extension(snapshot)
        for key in ('physical', 'service_plans'):
            self._validate_physical_graph_links(session_id, snapshot, key)

    def _validate_physical_graph_links(self, session_id, snapshot, key):
        graph = snapshot.get(key)
        if graph is None:
            return
        needed = set()
        def collect(reference):
            needed.add(tuple(reference[key] for key in ('document_id', 'document_sha256', 'page',
                                                        'image_id', 'image_sha256', 'occurrence_id')))
        validate_source_links(graph, snapshot, collect)
        source_ids = {ref['document_id'] for collection in graph_collections(graph).values()
                      for entity in graph[collection] if not entity['deleted'] for ref in entity_references(entity)}
        documents = {document['id']: document for document in snapshot['documents']}
        self.documents.assert_documents([documents[identifier] for identifier in source_ids], owner=session_id)
        if not needed:
            return
        manager = self._images()
        # Retain only the requested tuples, not every manifest or occurrence in
        # the project. Each relevant manifest is read once and then released.
        for descriptor in snapshot.get('image_extractions', []):
            if not any(value[0] == descriptor['document_id'] and value[2] in descriptor['pages'] for value in needed):
                continue
            document = documents[descriptor['document_id']]
            manager.assert_evidence([descriptor], [document], owner=session_id, require_registered=False)
            manifest = manager.read(descriptor, document, verify_assets=False)
            assets = {asset['id']: asset for asset in manifest['assets']}
            for occurrence in manifest['occurrences']:
                asset = assets[occurrence['asset_id']]; rendition = asset.get('rendition')
                if rendition:
                    needed.discard((document['id'], document['sha256'], occurrence['page'], asset['id'],
                                    rendition['sha256'], occurrence['id']))
            if not needed:
                return
        raise ValidationError('Physical image evidence must match a retained document, page, asset, rendition hash and occurrence.')

    def _physical_gate(self, session_id, snapshot, *, links=True):
        self._session_evidence(session_id)
        self._verify_audit_head(snapshot, owner=session_id)
        if links:
            self._validate_physical_links(session_id, snapshot)

    def preview_physical(self, session_id, request):
        with self._lock:
            object_fields(request, {'expected_revision', 'commands', 'scope'}, 'Physical preview', {'expected_revision', 'commands'})
            scope = request.get('scope', 'defect_reports'); key = scope_key(scope)
            session = self._session(session_id); snapshot = session['snapshot']
            if type(request['expected_revision']) is not int or request['expected_revision'] != snapshot['revision']:
                raise ValidationError('The takeoff draft changed before physical preview.')
            self._physical_editable(snapshot, scope)
            self._physical_gate(session_id, snapshot, links=False)
            prepared = prepare_changes(snapshot, request['commands'], lambda reference: None, scope=scope)
            from .takeoff_model import upgrade_snapshot
            self._validate_physical_links(session_id, {**upgrade_snapshot(snapshot), key: prepared['graph']})
            preview_id = str(uuid4())
            self._cache_payload(session_id, 'previews', preview_id,
                {'kind': 'physical', 'revision': snapshot['revision'], 'summary': prepared['summary']})
            if len(session['previews']) > 20:
                session['previews'].pop(next(iter(session['previews'])))
            return {**deepcopy(prepared['summary']), 'preview_id': preview_id, 'revision': snapshot['revision']}

    def apply_physical(self, session_id, request):
        from .takeoff_model import upgrade_snapshot
        with self._lock:
            object_fields(request, {'expected_revision', 'request_id', 'preview_id', 'scope'}, 'Physical apply',
                          {'expected_revision', 'request_id', 'preview_id'})
            scope = request.get('scope', 'defect_reports'); key = scope_key(scope)
            actual = {**request, 'op': 'apply_physical'}
            self._physical_editable(self._session(session_id)['snapshot'], scope)
            session, prior = self._start(session_id, actual)
            if prior:
                self._physical_gate(session_id, session['snapshot'])
                return prior
            identity(request['preview_id'], 'Physical preview ID')
            cached = session['previews'].get(request['preview_id'], {}).get('payload')
            if not cached or cached.get('kind') != 'physical' or cached['revision'] != session['snapshot']['revision']:
                raise ValidationError('This physical preview expired. Review a new preview.')
            if cached['summary'].get('scope', 'defect_reports') != scope:
                raise ValidationError('This physical preview belongs to another workspace scope.')
            before = session['snapshot']
            self._physical_gate(session_id, before, links=False)
            prepared = prepare_changes(before, cached['summary']['commands'], lambda reference: None, scope=scope)
            self._validate_physical_links(session_id, {**upgrade_snapshot(before), key: prepared['graph']})
            if prepared['summary']['digest'] != cached['summary']['digest']:
                raise ValidationError('The physical graph or evidence changed. Review a fresh preview.')
            after = upgrade_snapshot(before)
            after[key] = prepared['graph']
            return self._commit(session_id, actual, before, after)

    def extract_images(self, session_id, request):
        from .takeoff_model import upgrade_snapshot
        from .takeoff_image_evidence import MAX_IMAGE_DESCRIPTORS
        object_fields(request, {'expected_revision', 'request_id', 'document_id', 'first_page', 'page_count'},
                      'Image extraction', {'expected_revision', 'request_id', 'document_id', 'first_page', 'page_count'})
        actual = {**request, 'op': 'extract_images'}
        job = (session_id, request['request_id'])
        with self._lock:
            session, prior = self._start(session_id, actual)
            if prior:
                self._physical_gate(session_id, session['snapshot'])
                return prior
            identity(request['document_id'], 'Source document ID')
            before = session['snapshot']
            if len(before.get('image_extractions', [])) >= MAX_IMAGE_DESCRIPTORS:
                raise ValidationError('The project already retains the maximum number of image extraction events.')
            document = next((value for value in before['documents'] if value['id'] == request['document_id']), None)
            if document is None:
                raise ValidationError('Choose a source document in this workspace.')
            if (type(request['first_page']) is not int or type(request['page_count']) is not int
                    or request['first_page'] < 1 or not 1 <= request['page_count'] <= 25
                    or request['first_page'] + request['page_count'] - 1 > len(document['pages'])):
                raise ValidationError('Choose an exact available page range of one to 25 pages.')
            if job in self._image_jobs:
                raise ValidationError('This image extraction is already running. Retry the same request after it finishes.')
            if len(self._image_jobs) >= 2:
                raise ValidationError('Two image extractions are already running. Retry after one finishes.')
            self._physical_gate(session_id, before, links=False)
            self.documents.assert_documents([document], owner=session_id)
            source = deepcopy(document)
            base_digest = audit_state_digest(before)
            manager = self._images()
            self._image_jobs.add(job)
        try:
            # The disposable parser and image decoder must not hold the global
            # workspace lock. Closing/editing any session remains responsive.
            descriptor = manager.extract(source, request['first_page'], request['page_count'])
            if (descriptor.get('document_id') != source['id'] or descriptor.get('source_sha256') != source['sha256']
                    or descriptor.get('pages') != list(range(request['first_page'], request['first_page']+request['page_count']))):
                raise ValidationError('The extracted evidence does not match the exact requested source pages.')
            with self._lock:
                session, prior = self._start(session_id, actual)
                if prior:
                    return prior
                before = session['snapshot']
                if audit_state_digest(before) != base_digest:
                    raise ValidationError('The workspace changed during extraction; its draft was preserved. Request a new extraction.')
                self._physical_gate(session_id, before, links=False)
                self.documents.assert_documents([source], owner=session_id)
                manager.assert_evidence([descriptor], before['documents'], owner=session_id, require_registered=False)
                after = upgrade_snapshot(before)
                if any(value['id'] == descriptor['id'] for value in after['image_extractions']):
                    raise ValidationError('This extraction identity is already retained.')
                after['image_extractions'].append(deepcopy(descriptor))
                response = self._commit(session_id, actual, before, after)
                session['requests'][request['request_id']]['metadata'] = {'extraction_id': descriptor['id']}
                response['extraction_id'] = descriptor['id']
                return response
        finally:
            with self._lock:
                self._image_jobs.discard(job)

    def images(self, session_id, extraction_id=None, offset=0, limit=100):
        with self._lock:
            if type(offset) is not int or not 0 <= offset <= 512 or type(limit) is not int or not 1 <= limit <= 100:
                raise ValidationError('Image inventory requires an offset up to 512 and a page size of one to 100.')
            snapshot = self._session(session_id)['snapshot']
            descriptors = snapshot.get('image_extractions', [])
            if extraction_id is not None:
                identity(extraction_id, 'Image extraction ID')
                descriptor = next((value for value in descriptors if value['id'] == extraction_id), None)
                if descriptor is None:
                    raise ValidationError('This image extraction is not part of the workspace.')
            else:
                descriptor = descriptors[-1] if descriptors else None
            extractions, rows, total = [], [], 0
            if descriptor:
                document = next(value for value in snapshot['documents'] if value['id'] == descriptor['document_id'])
                self.documents.assert_documents([document], owner=session_id)
                manager = self._images()
                manager.assert_evidence([descriptor], [document], owner=session_id, require_registered=False)
                manifest = manager.read(descriptor, document, verify_assets=False)
                extractions.append({**deepcopy(descriptor), 'coverage': deepcopy(manifest['coverage']),
                                    'page_results': deepcopy(manifest['pages']), 'issues': deepcopy(manifest['issues'])})
                assets = {asset['id']: asset for asset in manifest['assets']}
                pages = {page['page']: page for page in manifest['pages']}
                total = len(manifest['occurrences'])
                for occurrence in manifest['occurrences'][offset:offset+limit]:
                    asset = assets[occurrence['asset_id']]; rendition = asset.get('rendition')
                    issues = [*manifest['issues'], *pages[occurrence['page']]['issues'], *occurrence['issues'], *asset['issues']]
                    page = next(page for page in document['pages'] if page['page'] == occurrence['page'])
                    region = image_annotation_region(occurrence['quad_pdf'], page['view'])
                    clipped = region != occurrence['quad_pdf']
                    if clipped:
                        issues.append({'code': 'SOURCE_MARKER_CLIPPED' if region else 'SOURCE_MARKER_OUTSIDE_VIEW',
                            'message': 'The source marker is clipped to the page view; original image placement and pixels are retained.' if region
                            else 'The image placement has no visible marker area in this page view; original placement and pixels are retained.'})
                    rows.append({'extraction_id': descriptor['id'], 'asset_id': asset['id'], 'image_id': asset['id'],
                        'image_sha256': rendition['sha256'] if rendition else None, 'occurrence_id': occurrence['id'],
                        'document_id': document['id'], 'document_sha256': document['sha256'], 'page': occurrence['page'],
                        'region': region, 'quad_pdf': deepcopy(occurrence['quad_pdf']), 'region_clipped': clipped,
                        'source_name': document['name'],
                        'appearance_status': occurrence['appearance_status'], 'has_rendition': bool(rendition),
                        'issues': list({digest(issue): deepcopy(issue) for issue in issues}.values())})
            return {'revision': snapshot['revision'], 'extraction_id': descriptor['id'] if descriptor else None,
                    'extractions': extractions, 'items': rows, 'total': total, 'offset': offset, 'limit': limit,
                    'has_more': offset+len(rows) < total}

    def image_file(self, session_id, extraction_id, asset_id):
        with self._lock:
            identity(extraction_id, 'Image extraction ID'); identity(asset_id, 'Image asset ID')
            snapshot = self._session(session_id)['snapshot']
            descriptor = next((value for value in snapshot.get('image_extractions', []) if value['id'] == extraction_id), None)
            if descriptor is None:
                raise ValidationError('This image extraction is not part of the workspace.')
            document = next((value for value in snapshot['documents'] if value['id'] == descriptor['document_id']), None)
            if document is None:
                raise ValidationError('The retained image source is unavailable.')
            self.documents.assert_documents([document], owner=session_id)
            return self._images().rendition(descriptor, document, asset_id, owner=session_id)

    def export_physical(self, session_id, format, scope='defect_reports'):
        from .takeoff_physical_exports import export_physical_graph
        with self._lock:
            snapshot = self._session(session_id)['snapshot']
            self._physical_gate(session_id, snapshot)
            if hasattr(self.documents, 'assert_image_evidence'):
                self.documents.assert_image_evidence(snapshot, owner=session_id)
            return export_physical_graph(current_graph(snapshot, scope), format,
                                         {document['id']: document['name'] for document in snapshot['documents']})

    @staticmethod
    def _physical_editable(snapshot, scope='defect_reports'):
        graph = snapshot.get(scope_key(scope))
        if graph is not None and graph['version'] == 1:
            raise ValidationError('This legacy penetration hierarchy is read-only until its new relationships are assigned.')

    def _undo_physical(self, session_id, before, after):
        from .takeoff_model import upgrade_snapshot
        after = upgrade_snapshot(after)
        after['image_extractions'] = deepcopy(before.get('image_extractions', []))
        for scope in ('defect_reports', 'service_plans'):
            key = scope_key(scope)
            current = before.get(key)
            if current is None:
                if key == 'physical' or key in before:
                    after[key] = None
                else:
                    after.pop(key, None)
                continue
            if current['version'] == 1:
                if after.get(key) != current:
                    self._physical_editable(before, scope)
                continue
            target = current_graph(after, scope)
            if target['version'] != current['version']:
                raise ValidationError('Physical undo cannot change the stored hierarchy version.')
            restored = deepcopy(current)
            changed = False
            next_revision = current['revision'] + 1
            for collection in graph_collections(current).values():
                previous = {value['id']: value for value in target[collection]}
                for index, entity in enumerate(restored[collection]):
                    desired = deepcopy(previous.get(entity['id'], entity))
                    if entity['id'] not in previous:
                        desired.update(deleted=True, deleted_at_revision=next_revision)
                    if digest({k: v for k, v in desired.items() if k != 'revision'}) != digest({k: v for k, v in entity.items() if k != 'revision'}):
                        if desired['deleted'] and not entity['deleted']:
                            desired['deleted_at_revision'] = next_revision
                        desired['revision'] = entity['revision'] + 1
                        restored[collection][index] = desired
                        changed = True
            if changed:
                restored['revision'] = next_revision
            validate_graph(restored, copy_result=False)
            after[key] = restored
        self._validate_physical_links(session_id, after)
        return after

    def _remember_request(self, session, request, **metadata):
        session['requests'][request['request_id']] = {'request_hash': digest(request), **metadata}
        if len(session['requests']) > 100:
            session['requests'].pop(next(iter(session['requests'])))

    def _cache_payload(self, session_id, bucket, key, payload):
        """Bound reusable previews/results; completed operation hashes stay small."""
        size = len(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode())
        if size > SESSION_CACHE_BYTES:
            raise ValidationError('This preview exceeds the supported memory limit. Reduce the selected records and preview again.')
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
        if prior.get('applied_linked_edit'):
            if 'payload' not in prior or prior['applied_revision'] != response['revision']:
                raise ValidationError('This linked schedule edit was already applied. Its response expired or the workspace changed; inspect the current draft before continuing. It will not be applied twice.')
            response['calculators'] = deepcopy(prior['payload'])
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

    def _commit(self, session_id, request, before, after, approvals=(), transfers=(), linked_deletion=None):
        after['revision'] = before['revision'] + 1
        after['audit_head'] = before['audit_head']
        validate_snapshot(after, copy_result=False)
        # put_blob serializes synchronously while the service lock protects
        # both states. Root projections remove the head without copying each
        # immutable source/page tree merely to serialize it immediately.
        strip = lambda value: {k: v for k, v in value.items() if k != 'audit_head'}
        event = {'version': after['version'], 'project_id': before['project_id'], 'revision': after['revision'],
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
            if linked_deletion is not None:
                db.execute('INSERT INTO takeoff_linked_deletions VALUES(?,?,?)',
                           (after['project_id'], after['audit_head'], json.dumps(linked_deletion, sort_keys=True)))
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

    def _invalidate_changed_scopes(self, before, after):
        previous = {item['id']: item for item in before['items']}
        for item in after['items']:
            try:
                validate_measurement_scope(item, after)
            except ValidationError:
                original = previous.get(item['id'])
                if original is not None:
                    try:
                        validate_measurement_scope(original, before)
                    except ValidationError:
                        continue
                    self._invalidate(after, item)

    def _create_item(self, snapshot, proposed, predecessors=None, *, allow_count=False, copied_from=None):
        object_fields(proposed, {'id', 'mode', 'geometry', 'measurement', 'quantity', 'fields', 'evidence', 'member_ids', 'length_additions', 'appearance', 'count_id', 'purpose'}, 'New takeoff item', {'mode'})
        if is_marker_item(proposed) and not allow_count:
            raise ValidationError('Create Steel count markers with the controlled count operation.')
        if is_standalone_length(proposed) and not proposed.get('measurement'):
            raise ValidationError('Choose a calibration before creating a standalone length measurement.')
        item = {'id': proposed.get('id', str(uuid4())), 'version': 1, 'mode': proposed['mode'], 'state': 'draft',
                'geometry': deepcopy(proposed.get('geometry')), 'measurement': deepcopy(proposed.get('measurement')),
                'quantity': proposed.get('quantity'), 'fields': deepcopy(proposed.get('fields', {})),
                'evidence': deepcopy(proposed.get('evidence', [])), 'review': None, 'confirmation': None,
                'predecessor_ids': deepcopy(predecessors or [])}
        if copied_from is not None:
            item['copied_from'] = deepcopy(copied_from)
        item['member_ids'] = deepcopy(proposed.get('member_ids', []))
        if 'length_additions' in proposed:
            item['length_additions'] = deepcopy(proposed['length_additions'])
        if 'appearance' in proposed:
            item['appearance'] = deepcopy(proposed['appearance'])
        if 'count_id' in proposed:
            item['count_id'] = proposed['count_id']
        if 'purpose' in proposed:
            item['purpose'] = proposed['purpose']
        if 'member_ids' not in proposed:
            self._resize_members(item)
        if any(i['id'] == item['id'] for i in snapshot['items']):
            raise ValidationError('This takeoff item ID already exists.')
        validate_item(item, snapshot, copy_result=False)
        validate_measurement_scope(item, snapshot)
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

    def _count_locations(self, snapshot, document_id, page_number, markers):
        """Validate explicit manual markers before changing any count row."""
        _, page = page_metadata(snapshot, document_id, page_number)
        if not isinstance(markers, list) or not 1 <= len(markers) <= MAX_ITEMS:
            raise ValidationError(f'Count placement requires one to {MAX_ITEMS} explicit markers.')
        if sum(len(item['member_ids']) for item in snapshot['items']) + len(markers) > MAX_ITEMS:
            raise ValidationError(f'A takeoff project may retain at most {MAX_ITEMS} physical member identities.')
        grouped = {}
        for marker in markers:
            object_fields(marker, {'point', 'length_m'}, 'Count marker', {'point', 'length_m'})
            points([marker['point']], 'Count marker', page, maximum=1)
            length = number(marker['length_m'], 'Manual length per member', positive=True)
            grouped.setdefault(length, []).append(deepcopy(marker['point']))
        return grouped

    def _regroup_counts(self, snapshot, count_ids):
        """Merge equal-length rows within their existing count, preserving members."""
        groups = {}
        for item in list(snapshot['items']):
            if not is_count_item(item) or item['count_id'] not in count_ids:
                continue
            key = (item['count_id'], item['measurement']['length_m'])
            if key not in groups:
                groups[key] = item
                continue
            survivor = groups[key]
            # Details are separately validated before regrouping; never erase
            # a conflicting detail while making equal-length rows canonical.
            if (item['fields'] != survivor['fields'] or markup_appearance(item) != markup_appearance(survivor)
                    or item.get('length_additions', []) != survivor.get('length_additions', [])
                    or any(item['geometry'][name] != survivor['geometry'][name] for name in ('document_id', 'page'))):
                raise ValidationError('Rows in one count must retain identical details before grouping equal lengths.')
            survivor['geometry']['points'].extend(deepcopy(item['geometry']['points']))
            survivor['member_ids'].extend(item['member_ids'])
            survivor['quantity'] = len(survivor['member_ids'])
            survivor['predecessor_ids'] = sorted(set(self._predecessors([survivor, item])) - {survivor['id']})
            survivor['evidence'] = list({digest(ref): deepcopy(ref)
                                        for ref in survivor['evidence'] + item['evidence']}.values())
            self._invalidate(snapshot, survivor)
            self._remove(snapshot, [item])
        return [item['id'] for item in snapshot['items'] if is_count_item(item) and item['count_id'] in count_ids]

    def _predecessors(self, originals):
        return sorted({identifier for item in originals for identifier in (item['id'], *item.get('predecessor_ids', []))})

    def _steel_group(self, item):
        if is_marker_item(item):
            raise ValidationError('Count groups retain marker identities. Edit or delete their individual markers instead of splitting or merging quantities.')
        if item['mode'] != 'steel' or type(item['quantity']) is not int or item['quantity'] <= 0:
            raise ValidationError('Choose steel groups with explicit positive physical quantities.')
        if len(item['member_ids']) != item['quantity'] or len(set(item['member_ids'])) != item['quantity']:
            raise ValidationError('Steel groups must retain one distinct identity for every physical member.')

    def _group_proposal(self, original):
        return {key: deepcopy(original[key]) for key in ('mode', 'quantity', 'fields', 'geometry', 'measurement', 'evidence', 'member_ids', 'length_additions', 'appearance', 'purpose') if key in original}

    def _assert_eligible(self, snapshot, items, *, confirmed=False, session_id=None, require_review=True):
        self.documents.assert_documents(snapshot['documents'], owner=session_id)
        self._verify_audit_head(snapshot, owner=session_id)
        for item in items:
            issues = item_result(item, snapshot)['issues']
            if issues:
                raise ValidationError(issues[0]['message'])
            if require_review and not self._registered(snapshot, item, 'review'):
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
                     'duplicate_items': {'sources', 'document_id', 'page', 'point', 'calibration_id'},
                     'add_count_items': {'document_id', 'page', 'markers', 'fields', 'appearance'},
                     'add_standalone_count': {'mode', 'document_id', 'page', 'markers', 'fields', 'appearance'},
                     'continue_standalone_count': {'item_id', 'markers'},
                     'continue_count': {'item_id', 'markers'},
                     'update_count_lengths': {'groups'},
                     'move_count_markers': {'markers', 'delta_pdf'},
                     'delete_count_marker': {'item_id', 'member_id'},
                     'bulk_update': {'item_ids', 'changes'}, 'delete_items': {'item_ids'},
                     'move_items': {'item_ids', 'delta_pdf'},
                     'review_items': {'item_ids'}, 'confirm_items': {'item_ids'},
                     'unconfirm_items': {'item_ids'}, 'add_calibration': {'calibration'},
                     'update_calibration': {'calibration_id', 'changes'},
                     'delete_viewport': {'calibration_id'},
                     'delete_document': {'document_id'}, 'record_render': {'document_id', 'page', 'success', 'warnings'},
                     'undo': set(), 'split_item': {'item_id', 'parts'}, 'merge_items': {'item_ids', 'item'},
                     'split_steel_group': {'item_id', 'quantities'}, 'merge_steel_groups': {'item_ids'},
                     'detach_transfers': {'item_ids', 'calculator_id'},
                     'toggle_thickness_colours': {'document_id', 'calculator_id', 'calculator_drafts'},
                     'set_legend': {'legend'}}
            if not isinstance(op, str) or op not in specs:
                raise ValidationError('This takeoff operation is not supported.')
            object_fields(request, {'expected_revision', 'request_id', 'op'} | specs[op], 'Takeoff operation',
                          {'expected_revision', 'request_id', 'op'} | specs[op])
            revised_calibration_id = None
            created_item_ids = None
            regrouped_item_ids = None
            if op in ('toggle_thickness_colours', 'set_legend'):
                from .takeoff_presentation import apply_presentation
                linked = None
                if op == 'toggle_thickness_colours':
                    linked = self.linked_register_results(session_id, {
                        'expected_revision': before['revision'],
                        'calculator_drafts': request['calculator_drafts']})['linked_results']
                apply_presentation(after, request, linked)
            elif op == 'create_item':
                self._create_item(after, request['item'])
            elif op == 'duplicate_items':
                proposals, source_ids = duplicate_length_proposals(after, request)
                self.documents.assert_documents([document for document in after['documents']
                                                 if document['id'] in source_ids], owner=session_id)
                created_item_ids = [self._create_item(after, proposed, copied_from=source)['id']
                                    for proposed, source in proposals]
            elif op in ('add_standalone_count', 'continue_standalone_count'):
                if op == 'continue_standalone_count':
                    item = self._items(after, [request['item_id']])[0]
                    if not is_standalone_count(item):
                        raise ValidationError('Choose an existing count-only item to continue.')
                    geometry = item['geometry']
                    document_id, page_number = geometry['document_id'], geometry['page']
                else:
                    if request['mode'] not in ('steel', 'duct'):
                        raise ValidationError('Count-only items belong to Steel or Duct.')
                    document_id, page_number = request['document_id'], request['page']
                _, page = page_metadata(after, document_id, page_number)
                markers = request['markers']
                if not isinstance(markers, list) or not 1 <= len(markers) <= MAX_ITEMS:
                    raise ValidationError('Place a bounded nonempty list of count-only markers.')
                locations = []
                for marker in markers:
                    object_fields(marker, {'point'}, 'Standalone count marker', {'point'})
                    locations.extend(points([marker['point']], 'Count-only marker', page, maximum=1))
                if sum(len(value['member_ids']) for value in after['items']) + len(locations) > MAX_ITEMS:
                    raise ValidationError(f'A takeoff project may retain at most {MAX_ITEMS} physical member identities.')
                if op == 'add_standalone_count':
                    item = self._create_item(after, {'mode': request['mode'], 'purpose': 'count-only',
                        'geometry': {'kind': 'count-only', 'document_id': document_id, 'page': page_number, 'points': locations},
                        'measurement': None, 'quantity': len(locations), 'fields': request['fields'], 'appearance': request['appearance']}, allow_count=True)
                    created_item_ids = [item['id']]
                else:
                    item['geometry']['points'].extend(locations)
                    item['member_ids'].extend(str(uuid4()) for _ in locations)
                    item['quantity'] += len(locations)
                    self._invalidate(after, item)
                    validate_item(item, after, copy_result=False)
                    created_item_ids = []
            elif op == 'add_count_items':
                # One batch has common fields, appearance and source. Partition
                # only by exact entered length, preserving first-seen order.
                # No fuzzy grouping or cross-batch identity replacement occurs.
                validate_appearance(request['appearance'])
                grouped = self._count_locations(after, request['document_id'], request['page'], request['markers'])
                created_item_ids = []
                count_id = str(uuid4())
                for length, locations in grouped.items():
                    item = self._create_item(after, {
                        'mode': 'steel', 'count_id': count_id, 'fields': request['fields'], 'appearance': request['appearance'],
                        'geometry': {'kind': 'count', 'document_id': request['document_id'],
                                     'page': request['page'], 'points': locations},
                        'measurement': {'method': 'manual', 'length_m': length},
                        'quantity': len(locations)}, allow_count=True)
                    created_item_ids.append(item['id'])
            elif op == 'continue_count':
                original = self._items(after, [request['item_id']])[0]
                if not is_count_item(original):
                    raise ValidationError('Choose an existing Steel count to continue.')
                geometry = original['geometry']
                grouped = self._count_locations(after, geometry['document_id'], geometry['page'], request['markers'])
                existing = {item['measurement']['length_m']: item for item in after['items']
                            if item.get('count_id') == original['count_id']}
                created_item_ids = []
                for length, locations in grouped.items():
                    if length in existing:
                        # Append to its stable row instead of replacing or
                        # merging rows, retaining evidence and linked identities.
                        item = existing[length]
                        item['geometry']['points'].extend(locations)
                        item['quantity'] += len(locations)
                        self._resize_members(item)
                        self._invalidate(after, item)
                        validate_item(item, after, copy_result=False)
                    else:
                        proposed = self._group_proposal(original)
                        proposed.update(count_id=original['count_id'], quantity=len(locations),
                                        measurement={'method': 'manual', 'length_m': length})
                        proposed.pop('member_ids')
                        proposed['geometry']['points'] = locations
                        item = self._create_item(after, proposed, allow_count=True)
                        created_item_ids.append(item['id'])
                regrouped_item_ids = [item['id'] for item in after['items']
                                      if item.get('count_id') == original['count_id']]
            elif op == 'update_count_lengths':
                # The editor pins physical members, not transient length-row
                # IDs. A preceding edit may have merged their original row.
                groups = request['groups']
                if not isinstance(groups, list) or not 1 <= len(groups) <= MAX_ITEMS:
                    raise ValidationError('Choose a bounded nonempty list of count lengths.')
                lengths = {}
                for group in groups:
                    object_fields(group, {'member_ids', 'length_m'}, 'Count length group', {'member_ids', 'length_m'})
                    members = group['member_ids']
                    if not isinstance(members, list) or not 1 <= len(members) <= MAX_ITEMS:
                        raise ValidationError('Choose the physical members for each count length.')
                    length = number(group['length_m'], 'Manual length per member', positive=True)
                    for member in members:
                        member = identity(member, 'Count member ID')
                        if member in lengths:
                            raise ValidationError('Change each count member length only once.')
                        lengths[member] = length
                    if len(lengths) > MAX_ITEMS:
                        raise ValidationError('Too many count members in one length edit.')
                known = {member for item in after['items'] if is_count_item(item) for member in item['member_ids']}
                if not lengths.keys() <= known:
                    raise ValidationError('A selected count member no longer exists.')
                affected_counts = set()
                for item in list(after['items']):
                    if not is_count_item(item):
                        continue
                    original_length = item['measurement']['length_m']
                    if not any(member in lengths and lengths[member] != original_length for member in item['member_ids']):
                        continue
                    original = deepcopy(item)
                    partition = {}
                    for member, point in zip(original['member_ids'], original['geometry']['points']):
                        partition.setdefault(lengths.get(member, original_length), []).append((member, point))
                    # Keep the existing row for unchanged members when possible.
                    # New rows retain predecessors and exact evidence/geometry.
                    retained = original_length if original_length in partition else next(iter(partition))
                    for length, members in partition.items():
                        proposed = self._group_proposal(original)
                        proposed.update(count_id=original['count_id'], quantity=len(members),
                                        member_ids=[member for member, _ in members],
                                        measurement={'method': 'manual', 'length_m': length})
                        proposed['geometry']['points'] = [deepcopy(point) for _, point in members]
                        if length == retained:
                            item.update(proposed)
                            self._invalidate(after, item)
                            validate_item(item, after, copy_result=False)
                        else:
                            self._create_item(after, proposed, self._predecessors([original]), allow_count=True)
                    affected_counts.add(original['count_id'])
                regrouped_item_ids = self._regroup_counts(after, affected_counts)
            elif op == 'move_count_markers':
                markers = request['markers']
                if not isinstance(markers, list) or not 1 <= len(markers) <= MAX_ITEMS:
                    raise ValidationError('Select a bounded nonempty list of count markers to move.')
                delta = request['delta_pdf']
                if not isinstance(delta, list) or len(delta) != 2:
                    raise ValidationError('A marker move requires a PDF x/y offset.')
                dx, dy = (number(value, 'Marker offset') for value in delta)
                if dx == 0 and dy == 0:
                    raise ValidationError('Drag the markers to a different position.')
                mapping = {item['id']: item for item in after['items']}
                selected = {}; member_indexes = {}; seen = set(); source = None
                for marker in markers:
                    object_fields(marker, {'item_id', 'member_id'}, 'Selected count marker', {'item_id', 'member_id'})
                    item_id = identity(marker['item_id'], 'Count item ID')
                    member_id = identity(marker['member_id'], 'Count member ID')
                    if (item_id, member_id) in seen:
                        raise ValidationError('Select each count marker only once.')
                    seen.add((item_id, member_id))
                    item = mapping.get(item_id)
                    if item is None or not is_marker_item(item):
                        raise ValidationError('A selected count marker no longer exists.')
                    if item_id not in member_indexes:
                        member_indexes[item_id] = {member: index for index, member in enumerate(item['member_ids'])}
                    if member_id not in member_indexes[item_id]:
                        raise ValidationError('A selected count marker no longer exists.')
                    geometry = item['geometry']
                    key = (geometry['document_id'], geometry['page'])
                    if source is not None and key != source:
                        raise ValidationError('Move count markers from one source page at a time.')
                    source = key
                    index = member_indexes[item_id][member_id]
                    x, y = geometry['points'][index]
                    geometry['points'][index] = [x + dx, y + dy]
                    selected[item_id] = item
                for item in selected.values():
                    self._invalidate(after, item)
                    validate_item(item, after, copy_result=False)
                    validate_measurement_scope(item, after)
            elif op == 'delete_count_marker':
                item = self._items(after, [request['item_id']])[0]
                if not is_marker_item(item):
                    raise ValidationError('Choose a Steel count marker to delete.')
                member_id = identity(request['member_id'], 'Count member ID')
                if member_id not in item['member_ids']:
                    raise ValidationError('The selected count marker no longer exists in this group.')
                index = item['member_ids'].index(member_id)
                if item['quantity'] == 1:
                    self._remove(after, [item])
                else:
                    del item['geometry']['points'][index]
                    del item['member_ids'][index]
                    item['quantity'] = len(item['geometry']['points'])
                    self._invalidate(after, item)
                    validate_item(item, after, copy_result=False)
            elif op in ('update_item', 'bulk_update'):
                selected = self._items(after, [request['item_id']] if op == 'update_item' else request['item_ids'])
                allowed = {'fields', 'quantity', 'appearance'} if op == 'bulk_update' else {'fields', 'quantity', 'geometry', 'measurement', 'evidence', 'member_ids', 'length_additions', 'appearance'}
                if op == 'bulk_update' and all(is_count_item(item) for item in selected):
                    allowed.add('measurement')
                changes = object_fields(request['changes'], allowed, 'Takeoff edit')
                if not changes:
                    raise ValidationError('Choose at least one field to edit.')
                if 'appearance' in changes:
                    validate_appearance(changes['appearance'])
                    if not changes['appearance']:
                        raise ValidationError('Choose at least one markup appearance setting to edit.')
                selected_ids = {item['id'] for item in selected}
                affected_counts = {item['count_id'] for item in selected if is_count_item(item)}
                for item in selected:
                    if not is_count_item(item):
                        continue
                    details_changed = ('length_additions' in changes
                                       and changes['length_additions'] != item.get('length_additions', []))
                    for key in ('fields', 'appearance'):
                        if key in changes:
                            if not isinstance(changes[key], dict):
                                raise ValidationError('Count detail edits must be objects.')
                            details_changed |= {**item.get(key, {}), **changes[key]} != item.get(key, {})
                    if details_changed and any(other.get('count_id') == item['count_id'] and other['id'] not in selected_ids
                                               for other in after['items']):
                        raise ValidationError('Select every row of this count to change its shared details or appearance. Start a different count for different details.')
                for item in selected:
                    count_item = is_marker_item(item)
                    if count_item:
                        for key in ('quantity', 'member_ids'):
                            if key in changes and changes[key] != item[key]:
                                raise ValidationError('Count quantity and member identities are derived from its markers. Delete the selected marker instead.')
                    if 'geometry' in changes:
                        proposed_geometry = changes['geometry']
                        proposed_count = isinstance(proposed_geometry, dict) and proposed_geometry.get('kind') in ('count', 'count-only')
                        if count_item != proposed_count:
                            raise ValidationError('Count markers cannot be converted to or from traced geometry.')
                        if count_item and (not isinstance(proposed_geometry.get('points'), list)
                                or len(proposed_geometry['points']) != item['quantity']
                                or any(proposed_geometry.get(key) != item['geometry'][key] for key in ('document_id', 'page'))):
                            raise ValidationError('Moving count markers must retain their source page, count and ordered member identities.')
                    # These commands cannot change source documents or scales.
                    # Compare the item body before following its edited source
                    # references, so malformed edits reach typed validation.
                    original_digest = digest({key: value for key, value in item.items() if key != 'appearance'})
                    original_geometry = deepcopy(item['geometry']) if 'geometry' in changes else None
                    for key, value in changes.items():
                        if key == 'fields':
                            if not isinstance(value, dict):
                                raise ValidationError('Field edits must be an object.')
                            item['fields'].update(deepcopy(value))
                        elif key == 'appearance':
                            item['appearance'] = {**item.get('appearance', {}), **deepcopy(value)}
                        else:
                            item[key] = deepcopy(value)
                    if 'quantity' in changes and 'member_ids' not in changes and not count_item:
                        self._resize_members(item)
                    if 'geometry' in changes:
                        reconcile_length_anchors(item, original_geometry, after)
                    technical_change = digest({key: value for key, value in item.items() if key != 'appearance'}) != original_digest
                    if technical_change:
                        self._invalidate(after, item)
                    validate_item(item, after, copy_result=False)
                    if ('geometry' in changes and item['geometry'] is not None
                            and item['geometry'] != original_geometry and not is_area_item(item) and not count_item):
                        # Editing control points must keep a usable line/region.
                        # Keep legacy draft loading and unrelated field/style
                        # edits compatible with their existing stored geometry.
                        vertices = item['geometry']['points']
                        if len(vertices) < 2:
                            raise ValidationError('Edited markup geometry must retain at least two control points.')
                        if item['measurement'] and item['measurement']['method'] == 'calibrated':
                            polyline_length(vertices)
                    if technical_change:
                        validate_measurement_scope(item, after)
                if affected_counts:
                    regrouped_item_ids = self._regroup_counts(after, affected_counts)
            elif op == 'move_items':
                selected = self._items(after, request['item_ids'])
                delta = request['delta_pdf']
                if not isinstance(delta, list) or len(delta) != 2:
                    raise ValidationError('A markup move requires a PDF x/y offset.')
                dx, dy = (number(value, 'Markup offset') for value in delta)
                if dx == 0 and dy == 0:
                    raise ValidationError('Drag the markup to a different position.')
                source = None
                for item in selected:
                    geometry = item['geometry']
                    if not geometry:
                        raise ValidationError('Only items with source geometry can be moved.')
                    key = (item['mode'], geometry['document_id'], geometry['page'])
                    if source is None:
                        source = key
                    if key != source:
                        raise ValidationError('Move markups from one takeoff type and source page at a time.')
                    original_geometry = deepcopy(geometry)
                    geometry['points'] = [[x + dx, y + dy] for x, y in geometry['points']]
                    for exclusion in geometry.get('exclusions', []):
                        exclusion['points'] = [[x + dx, y + dy] for x, y in exclusion['points']]
                    reconcile_length_anchors(item, original_geometry, after)
                    # Supporting citations remain pinned to their source;
                    # point anchors follow their own line without changing length.
                    self._invalidate(after, item)
                    validate_item(item, after, copy_result=False)
                    validate_measurement_scope(item, after)
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
                    self._assert_eligible(after, selected, session_id=session_id, require_review=False)
                    for item in selected:
                        # One explicit human confirmation records the review of
                        # this exact revision without a separate UI gate. Keep
                        # compatible review receipts and all historical events.
                        if not self._registered(after, item, 'review'):
                            item['review'] = self._receipt(after, item, session_id)
                            approvals.append((item, 'review'))
                        item['confirmation'] = self._receipt(after, item, session_id)
                        item['state'] = 'confirmed'; approvals.append((item, 'confirmation'))
                else:
                    for item in selected:
                        self._invalidate(after, item)
            elif op == 'add_calibration':
                proposed = deepcopy(request['calibration'])
                if isinstance(proposed, dict) and 'printed_scale_evidence' in proposed:
                    raise ValidationError('Printed scale evidence is created only by inspecting the retained PDF.')
                if not isinstance(proposed, dict):
                    raise ValidationError('Calibration must be an object.')
                proposed.setdefault('id', str(uuid4()))
                if 'supersedes_id' in proposed or 'deleted' in proposed:
                    raise ValidationError('Use calibration revision to replace an existing scale.')
                if any(c['id'] == proposed['id'] for c in after['calibrations']):
                    raise ValidationError('Calibration revisions are immutable. Add a new calibration ID.')
                if 'scale_denominator' in proposed:
                    proposed.setdefault('distance_m', preset_distance(proposed, after))
                calibrated = validate_calibration(proposed, after)
                if 'scale_denominator' in calibrated:
                    calibrated['distance_m'] = preset_distance(calibrated, after)
                after['calibrations'].append(calibrated)
                validate_calibration_revisions(after)
                self._invalidate_changed_scopes(before, after)
            elif op == 'update_calibration':
                calibration_id = identity(request['calibration_id'], 'Calibration ID')
                original = next((c for c in after['calibrations'] if c['id'] == calibration_id), None)
                if original is None:
                    raise ValidationError('Choose an existing calibration to revise.')
                if calibration_id not in {entry['id'] for entry in active_calibrations(after)}:
                    raise ValidationError('Choose the current calibration revision, not a superseded scale.')
                changes = object_fields(request['changes'], {'name', 'distance_m', 'points', 'uniform_scale', 'region', 'scale_denominator'}, 'Calibration revision')
                if not changes:
                    raise ValidationError('Choose a calibration property to revise.')
                revised = {**deepcopy(original), **deepcopy(changes), 'id': str(uuid4()), 'supersedes_id': calibration_id}
                # The original text remains on its immutable revision. A user
                # adjustment is a manual choice, no longer an extracted scale.
                revised.pop('printed_scale_evidence', None)
                for key in ('region', 'scale_denominator'):
                    if revised.get(key, False) is None:
                        revised.pop(key)
                if 'scale_denominator' in revised:
                    if 'distance_m' not in changes:
                        revised['distance_m'] = preset_distance(revised, after)
                calibrated = validate_calibration(revised, after)
                if 'scale_denominator' in calibrated:
                    calibrated['distance_m'] = preset_distance(calibrated, after)
                after['calibrations'].append(calibrated)
                validate_calibration_revisions(after)
                revised_calibration_id = revised['id']
                for item in after['items']:
                    if item['measurement'] and item['measurement'].get('calibration_id') == calibration_id:
                        item['measurement']['calibration_id'] = revised_calibration_id
                        self._invalidate(after, item)
                        validate_measurement_scope(item, after)
                self._invalidate_changed_scopes(before, after)
            elif op == 'delete_viewport':
                calibration_id = identity(request['calibration_id'], 'Viewport calibration ID')
                original = next((entry for entry in active_calibrations(after) if entry['id'] == calibration_id), None)
                if original is None or 'region' not in original:
                    raise ValidationError('Choose an active viewport to delete; page scales and retired revisions cannot be deleted here.')
                after['calibrations'].append({**deepcopy(original), 'id': str(uuid4()),
                                              'supersedes_id': calibration_id, 'deleted': True})
                validate_calibration_revisions(after)
                for item in after['items']:
                    measurement = item['measurement']
                    if not measurement or measurement.get('method') != 'calibrated':
                        continue
                    if measurement['calibration_id'] == calibration_id:
                        # Keep its exact former basis visible in saved evidence,
                        # but its retired scale can no longer authorize quantity.
                        self._invalidate(after, item)
                        continue
                    try:
                        validate_measurement_scope(item, before)
                    except ValidationError:
                        try:
                            validate_measurement_scope(item, after)
                        except ValidationError:
                            continue
                        # A page-scale record previously blocked by this inset
                        # must not silently regain a different scale. Its prior
                        # measurement remains in the immutable deletion event.
                        item['measurement'] = None
                        self._invalidate(after, item)
            elif op == 'delete_document':
                document_id = identity(request['document_id'], 'Document ID')
                if not any(d['id'] == document_id for d in after['documents']):
                    raise ValidationError('The selected source document no longer exists.')
                for item in after['items']:
                    refs = item_references(item)
                    if any(r['document_id'] == document_id for r in refs):
                        raise ValidationError('Remove or reassign all linked items before deleting their source document.')
                if any(value['document_id'] == document_id for value in after.get('image_extractions', [])):
                    raise ValidationError('A source document with retained image extraction history cannot be deleted.')
                if any(reference['document_id'] == document_id
                        for key in ('physical', 'service_plans') for graph in [after.get(key)] if graph
                        for collection in graph_collections(graph).values() for entity in graph[collection]
                        for reference in entity_references(entity)):
                    raise ValidationError('A source document referenced by physical records or tombstones cannot be deleted.')
                after['documents'] = [d for d in after['documents'] if d['id'] != document_id]
                after['calibrations'] = [c for c in after['calibrations'] if c['document_id'] != document_id]
                after['render_checks'] = [r for r in after['render_checks'] if r['document_id'] != document_id]
                if 'drawing_presentation' in after:
                    for key in ('colour_modes', 'legends'):
                        after['drawing_presentation'][key] = [value for value in after['drawing_presentation'][key] if value['document_id'] != document_id]
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
                        refs = item_references(item)
                        if any((r['document_id'], r['page']) == (record['document_id'], record['page']) for r in refs):
                            self._invalidate(after, item)
            elif op == 'undo':
                if not before['audit_head']:
                    raise ValidationError('There is no takeoff operation to undo.')
                event = self.documents.get_blob(before['audit_head'], kind='audit')
                if event['project_id'] != before['project_id'] or event['revision'] != before['revision']:
                    raise ValidationError('Audit history does not match this takeoff revision.')
                if event['op'] in ('apply_transfer', 'undo', 'record_render', 'detach_transfers', 'extract_images', 'linked_delete', 'linked_undo'):
                    raise ValidationError('Schedule transfers, source-render observations and undo receipts cannot be reversed by takeoff-only undo.')
                after = deepcopy(event['before']); after['audit_head'] = before['audit_head']
                if before['version'] == 2:
                    self._physical_gate(session_id, before)
                    after = self._undo_physical(session_id, before, after)
                originals = {i['id']: i for i in before['items']}
                for item in after['items']:
                    original = originals.get(item['id'])
                    if original is None or item_digest(item, after) != item_digest(original, before):
                        item['version'] = max(item['version'], original['version'] if original else 0)
                        self._invalidate(after, item)
            elif op == 'split_item':
                original = self._items(after, [request['item_id']])[0]
                if is_standalone_item(original):
                    raise ValidationError('Standalone measurements cannot be converted into calculator runs.')
                if original['mode'] in AREA_MODES:
                    raise ValidationError('Surface split is unavailable until exact coverage and exclusion preservation can be verified. Edit its polygon or group separate surfaces explicitly.')
                parts = request['parts']
                if not isinstance(parts, list) or not 2 <= len(parts) <= 100:
                    raise ValidationError('Split requires two to 100 explicit replacement runs.')
                if original['mode'] != 'duct' or original['quantity'] != 1 or not original['measurement'] or original['measurement']['method'] != 'calibrated':
                    raise ValidationError('Split supports individual calibrated duct runs; edit distinct steel members individually.')
                proposals = deepcopy(parts)
                if 'appearance' in original:
                    for part in proposals:
                        part.setdefault('appearance', deepcopy(original['appearance']))
                created = [self._create_item(after, part, self._predecessors([original])) for part in proposals]
                self._validate_topology_change(original, created, after)
                self._remove(after, [original])
            elif op == 'merge_items':
                originals = self._items(after, request['item_ids'])
                if any(is_marker_item(item) or is_standalone_item(item) for item in originals):
                    raise ValidationError('Count groups retain marker identities and cannot use traced-run merge.')
                if any(item['mode'] in AREA_MODES for item in originals):
                    raise ValidationError('Surface merge is unavailable until exact coverage and exclusion preservation can be verified. Group separate surfaces without changing their identities.')
                if len(originals) < 2:
                    raise ValidationError('Merge requires at least two adjoining runs.')
                proposed = deepcopy(request['item'])
                if 'appearance' in originals[0]:
                    proposed.setdefault('appearance', deepcopy(originals[0]['appearance']))
                replacement = self._create_item(after, proposed, self._predecessors(originals))
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
                            or original.get('length_additions', []) != first.get('length_additions', [])
                            or markup_appearance(original) != markup_appearance(first)
                            or item_result(original, after)['issues']):
                        raise ValidationError('Steel groups must have identical complete fields, source geometry, length basis and markup appearance. Resolve differences explicitly before merging.')
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
            if created_item_ids is not None:
                response['created_item_ids'] = created_item_ids
                session['requests'][request['request_id']].setdefault('metadata', {})['created_item_ids'] = created_item_ids
            if regrouped_item_ids is not None:
                response['regrouped_item_ids'] = regrouped_item_ids
                session['requests'][request['request_id']].setdefault('metadata', {})['regrouped_item_ids'] = regrouped_item_ids
            return response

    def _validate_topology_change(self, whole, parts, snapshot):
        if any(item.get('length_additions') for item in (whole, *parts)):
            raise ValidationError('Explicitly reassign riser/drop additions before splitting or merging duct runs; the operation cannot duplicate or discard vertical lengths.')
        if whole['mode'] != 'duct' or whole['quantity'] != 1 or not whole['measurement'] or whole['measurement']['method'] != 'calibrated':
            raise ValidationError('Merge/split requires one calibrated duct run per physical item.')
        chain = []
        for part in parts:
            if (part['mode'] != 'duct' or part['quantity'] != 1 or part['fields'] != whole['fields']
                    or part['measurement'] != whole['measurement'] or not part['geometry']
                    or markup_appearance(part) != markup_appearance(whole)
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

    def auto_calibrate(self, session_id, request):
        object_fields(request, {'expected_revision', 'request_id', 'document_id', 'page'}, 'Automatic page calibration',
                      {'expected_revision', 'request_id', 'document_id', 'page'})
        actual = {**request, 'op': 'auto_calibrate'}
        with self._lock:
            session, prior = self._start(session_id, actual)
            document, metadata = page_metadata(session['snapshot'], request['document_id'], request['page'])
            self._session_evidence(session_id)
            self.documents.assert_documents([document], owner=session_id)
            if prior:
                return prior
            before = session['snapshot']
            if any((entry['document_id'], entry['page']) == (document['id'], metadata['page']) for entry in before['calibrations']):
                result = {'status': 'existing'}
                self._remember_request(session, actual, metadata={'auto_calibration': result})
                return {**self._response(session_id), 'auto_calibration': result}
            source, page = deepcopy(document), deepcopy(metadata)
        # Parsing a hostile or slow PDF cannot hold the global workspace lock.
        # The worker is bounded by the same process, memory and CPU limits as
        # import. No browser-provided text or scale ratio is trusted here.
        scale = self.documents.printed_scale(source, page['page'], owner=session_id)
        with self._lock:
            session, prior = self._start(session_id, actual)
            if prior:
                return prior
            current, _ = page_metadata(session['snapshot'], source['id'], page['page'])
            if current != source:
                raise ValidationError('The source PDF changed during automatic scale detection.')
            self._session_evidence(session_id)
            self.documents.assert_documents([source], owner=session_id)
            if scale is None:
                result = {'status': 'not_detected'}
                self._remember_request(session, actual, metadata={'auto_calibration': result})
                return {**self._response(session_id), 'auto_calibration': result}
            before = session['snapshot']; after = deepcopy(before)
            x0, y0, x1, _ = page['view']
            calibration = {'id': str(uuid4()), 'document_id': source['id'], 'page': page['page'],
                'name': ('PDF footer: ' + scale['text'])[:200], 'points': [[x0, y0], [x0+min(72, (x1-x0)/2), y0]],
                'scale_denominator': scale['scale_denominator'], 'uniform_scale': True,
                'printed_scale_evidence': {'source_sha256': source['sha256'], 'text': scale['text'],
                                           'points': scale['points'], 'detector': 'pdf-footer-v1'}}
            calibration['distance_m'] = preset_distance(calibration, after)
            after['calibrations'].append(validate_calibration(calibration, after))
            response = self._commit(session_id, actual, before, after)
            result = {'status': 'applied', 'calibration_id': calibration['id']}
            session['requests'][actual['request_id']]['metadata'] = {'auto_calibration': result}
            return {**response, 'auto_calibration': result}

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

    def _linked_result(self, session_id, request, before, after, calculators, *, deletion=None):
        # Check the response limit before committing either side of the edit.
        size = len(json.dumps(calculators, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode())
        if size > SESSION_CACHE_BYTES:
            raise ValidationError('This linked edit exceeds the supported memory limit. Reduce the selected records and try again.')
        response = self._commit(session_id, request, before, after, linked_deletion=deletion)
        response['calculators'] = deepcopy(calculators)
        session = self._session(session_id)
        session['requests'][request['request_id']].update(applied_linked_edit=True, applied_revision=response['revision'])
        self._cache_payload(session_id, 'requests', request['request_id'], calculators)
        return response

    def delete_linked_items(self, session_id, request):
        """Remove items and every verified linked input row as one draft edit."""
        with self._lock:
            fields = {'expected_revision', 'request_id', 'item_ids', 'calculators'}
            object_fields(request, fields, 'Linked item deletion', fields)
            actual = {**request, 'op': 'linked_delete'}
            session, replay = self._start(session_id, actual)
            if replay is not None:
                return replay
            before = session['snapshot']
            selected = self._items(before, request['item_ids'])
            ids = {item['id'] for item in selected}
            bindings = [binding for binding in before['transfers'] if binding['item_id'] in ids]
            if not bindings:
                raise ValidationError('These items have no linked schedules. Use the ordinary takeoff deletion.')
            self._verify_audit_head(before, owner=session_id)
            with self.store.connect() as db:
                for binding in bindings:
                    registered = db.execute('SELECT 1 FROM takeoff_transfer_receipts WHERE project_id=? AND binding_id=? AND digest=?',
                        (before['project_id'], binding['id'], self._binding_digest(binding))).fetchone()
                    if not registered:
                        raise ValidationError('A linked schedule row has no local transfer receipt. Its inputs were preserved.')
            calculators, receipt = prepare_linked_delete(bindings, request['calculators'])
            after = deepcopy(before)
            self._remove(after, self._items(after, request['item_ids']))
            after['transfers'] = [binding for binding in after['transfers'] if binding['item_id'] not in ids]
            return self._linked_result(session_id, actual, before, after, calculators, deletion=receipt)

    def undo_linked_delete(self, session_id, request):
        """Restore exact item identities and cleared schedule literals together."""
        with self._lock:
            fields = {'expected_revision', 'request_id', 'calculators'}
            object_fields(request, fields, 'Undo linked deletion', fields)
            actual = {**request, 'op': 'linked_undo'}
            session, replay = self._start(session_id, actual)
            if replay is not None:
                return replay
            before = session['snapshot']
            receipt, deletion_head = self._linked_delete_context(before)
            if not receipt:
                raise ValidationError('There is no current linked deletion to undo. Reopen the complete original project if its local receipt is unavailable.')
            self._verify_audit_head(before, owner=session_id)
            event = self.documents.get_blob(deletion_head, kind='audit')
            if event['op'] != 'linked_delete':
                raise ValidationError('The retained linked deletion does not match the current audit event.')
            calculators = prepare_linked_undo(receipt, request['calculators'])
            after = deepcopy(before)
            current_items = {item['id']: item for item in after['items']}
            after['items'] = [current_items.get(item['id'], deepcopy(item)) for item in event['before']['items']]
            current_bindings = {binding['id']: binding for binding in after['transfers']}
            after['transfers'] = [current_bindings.get(binding['id'], deepcopy(binding)) for binding in event['before']['transfers']]
            current_ids = set(current_items)
            for item in after['items']:
                if item['id'] not in current_ids:
                    self._invalidate(after, item)
            return self._linked_result(session_id, actual, before, after, calculators)

    def preview_transfer(self, session_id, request):
        with self._lock:
            if not isinstance(request, dict):
                raise ValidationError('A transfer preview requires a structured request.')
            session = self._session(session_id); snapshot = session['snapshot']
            if type(request.get('expected_revision')) is not int or request['expected_revision'] != snapshot['revision']:
                raise ValidationError('The takeoff draft changed before transfer preview.')
            selected = self._items(snapshot, request.get('item_ids'))
            _, candidates, _ = transfer_selection(snapshot, request)
            if candidates:
                self._session_evidence(session_id)
                candidate_ids = set(candidates)
                self._assert_eligible(snapshot, [item for item in selected if item['id'] in candidate_ids],
                                      confirmed=True, session_id=session_id)
            result = transfer_preview(snapshot, request)
            preview_id = str(uuid4()) if candidates else None
            result.update(preview_id=preview_id, revision=snapshot['revision'])
            if candidates:
                self._cache_payload(session_id, 'previews', preview_id,
                                    {'item_ids': candidates, 'result': result})
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
            if preview.get('kind') == 'physical':
                raise ValidationError('Choose a calculator transfer preview, not a physical edit preview.')
            before = session['snapshot']; result = preview['result']
            if not result['bindings'] or not result['changes']:
                raise ValidationError('There are no new or explicitly updated rows to apply. Already-linked items were skipped.')
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

    def linked_register_results(self, session_id, request):
        """Read current linked thicknesses without changing drafts or receipts."""
        from .takeoff_exports import linked_register_results
        with self._lock:
            snapshot = self._session(session_id)['snapshot']
            self._session_evidence(session_id)
            self.documents.assert_documents(snapshot['documents'], owner=session_id)
            self._verify_audit_head(snapshot, owner=session_id)
            return linked_register_results(snapshot, request, store=self.store)

    def export_workspace(self, session_id, format, request):
        """Export a current drawing/register copy without creating authority."""
        from .takeoff_exports import export_workspace
        with self._lock:
            snapshot = self._session(session_id)['snapshot']
            if (not isinstance(request, dict) or type(request.get('expected_revision')) is not int
                    or request['expected_revision'] != snapshot['revision']):
                raise ValidationError('The takeoff draft changed. Download its current revision again.')
            self._session_evidence(session_id)
            self.documents.assert_documents(snapshot['documents'], owner=session_id)
            self._verify_audit_head(snapshot, owner=session_id)
            if request.get('mode') == 'penetrations':
                self._validate_physical_links(session_id, snapshot)
            return export_workspace(snapshot, request, format, documents=self.documents, store=self.store)
