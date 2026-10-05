"""Explicit project-owned commercial associations; never physical approval.

No candidates are inferred. Installation membership and quantity are reviewed
separately. Existing schedule fields and manual quantity are retained verbatim.
"""
from copy import deepcopy
from decimal import Decimal, localcontext
import math
import re
from uuid import UUID

from .catalog import ValidationError

MAX_ASSIGNMENTS = 1000
MAX_MEMBERS = 100
MODES = ('repeated_installations', 'combined_installation')
STATES = ('draft', 'confirmed', 'needs_recheck')


def _id(value):
    try:
        valid = isinstance(value, str) and str(UUID(value)) == value
    except ValueError:
        valid = False
    if not valid:
        raise ValidationError('An assignment or installation ID must be a canonical UUID.')
    return value


def _hash(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        raise ValidationError('The selected library/context fingerprint is invalid.')


def _text(value, limit=2000):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 and c not in '\n\r\t' for c in value):
        raise ValidationError('Assignment text must be bounded literal text.')


def _object(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValidationError('The library assignment contains missing or unsupported fields.')


def _revision(value):
    if type(value) is not int or not 0 <= value <= 10**9:
        raise ValidationError('The assignment revision is invalid.')


def _quantity(value):
    if type(value) not in (int, float) or not 0 < value <= 10**12 or not math.isfinite(value):
        raise ValidationError('Confirm a positive finite installation quantity.')
    return value


def validate_installation(value):
    _object(value, ('id', 'mode', 'note'))
    _id(value['id']); _text(value['note'])
    if value['mode'] not in MODES:
        raise ValidationError('Choose explicit repeated installations or one combined installation.')
    if value['mode'] == 'combined_installation' and not value['note'].strip():
        raise ValidationError('Describe the explicit combined installation; a shared barrier is not an opening.')


def validate_assignments(snapshot):
    collection = snapshot.get('library_assignments')
    if collection is None:
        if 'library_assignments' in snapshot:
            raise ValidationError('The assignment collection must be structured.')
        return
    _object(collection, ('version', 'records'))
    if type(collection['version']) is not int or collection['version'] != 1 or not isinstance(collection['records'], list) or len(collection['records']) > MAX_ASSIGNMENTS:
        raise ValidationError('Only a bounded version 1 assignment collection is supported.')
    ids = set(); installations = set(); member_sets = set()
    for record in collection['records']:
        _object(record, ('id', 'version', 'scope', 'installation', 'members', 'library', 'context_sha256', 'state', 'confirmation', 'schedule_binding'))
        _id(record['id']); _revision(record['version'])
        if not record['version'] or record['id'] in ids:
            raise ValidationError('Assignment IDs must be unique with positive versions.')
        ids.add(record['id'])
        if record['scope'] not in ('defect_reports', 'service_plans') or record['state'] not in STATES:
            raise ValidationError('The assignment scope/state is invalid.')
        validate_installation(record['installation'])
        library = record['library']
        _object(library, ('id', 'library_id', 'title', 'source_sha256', 'revision', 'metadata_sha256'))
        if not isinstance(library['id'], str) or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,119}', library['id']):
            raise ValidationError('The selected library ID is invalid.')
        _text(library['library_id'], 200); _text(library['title']); _revision(library['revision'])
        _hash(library['source_sha256']); _hash(library['metadata_sha256']); _hash(record['context_sha256'])
        installation_key = (record['scope'], record['installation']['id'], library['id'])
        if installation_key in installations:
            raise ValidationError('One explicit installation/library pair cannot have repeated assignments.')
        installations.add(installation_key)
        if not isinstance(record['members'], list) or not 1 <= len(record['members']) <= MAX_MEMBERS:
            raise ValidationError('Select one to 100 explicit physical members.')
        members = set()
        for member in record['members']:
            _object(member, ('id', 'kind', 'revision')); _id(member['id']); _revision(member['revision'])
            if member['kind'] not in ('defect', 'barrier', 'service') or member['id'] in members:
                raise ValidationError('Assignment members must have unique typed identities.')
            members.add(member['id'])
        member_key = (record['scope'], library['id'], tuple(sorted(members)))
        if member_key in member_sets:
            raise ValidationError('These exact physical members already have an assignment to this library item. Reconfirm the retained association rather than count them twice.')
        member_sets.add(member_key)
        confirmation = record['confirmation']
        binding = record['schedule_binding']
        if confirmation is not None:
            _object(confirmation, ('quantity', 'context_sha256', 'library_sha256'))
            _quantity(confirmation['quantity']); _hash(confirmation['context_sha256']); _hash(confirmation['library_sha256'])
            if confirmation['context_sha256'] != record['context_sha256'] or confirmation['library_sha256'] != library['metadata_sha256']:
                raise ValidationError('The confirmed association must retain its exact physical and library context fingerprints.')
            if record['installation']['mode'] == 'combined_installation' and confirmation['quantity'] != 1:
                raise ValidationError('One explicitly combined installation contributes one quantity.')
        if binding is not None:
            _object(binding, ('row_id', 'quantity'))
            _text(binding['row_id'], 200); _quantity(binding['quantity'])
            if not binding['row_id'] or confirmation is None or binding['quantity'] != confirmation['quantity']:
                raise ValidationError('A schedule binding must retain its confirmed contribution.')
        if record['state'] == 'confirmed' and (confirmation is None or binding is None):
            raise ValidationError('Confirmed commercial links require a reviewed quantity and schedule binding.')
        if record['state'] == 'draft' and (confirmation is not None or binding is not None):
            raise ValidationError('An unconfirmed draft cannot have a schedule contribution.')


def member_context(snapshot, scope, identifiers, installation):
    from .takeoff_model import digest
    from .takeoff_physical import graph_collections, graph_parents
    if scope not in ('defect_reports', 'service_plans'):
        raise ValidationError('Choose a supported physical assignment scope.')
    key = {'defect_reports': 'physical', 'service_plans': 'service_plans'}[scope]
    graph = snapshot.get(key) if key else None
    if not graph or graph['version'] not in (2, 3):
        raise ValidationError('Select active current physical draft records before linking a library item.')
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= MAX_MEMBERS:
        raise ValidationError('Select one to 100 distinct physical member IDs.')
    for identifier in identifiers:
        _id(identifier)
    if len(set(identifiers)) != len(identifiers):
        raise ValidationError('Select one to 100 distinct physical member IDs.')
    index = {entity['id']: (kind, entity) for kind, collection in graph_collections(graph).items() for entity in graph[collection]}
    captured, related = [], {}
    for identifier in identifiers:
        _id(identifier)
        if identifier not in index or index[identifier][1]['deleted']:
            raise ValidationError('An assignment member was removed or is unavailable.')
        kind, entity = index[identifier]
        captured.append({'id': identifier, 'kind': kind, 'revision': entity['revision']})
        while entity:
            related[entity['id']] = {'kind': kind, 'entity': entity}
            parent = graph_parents(graph).get(kind)
            if not parent:
                break
            kind, entity = index[entity[parent[1]]]
            if entity['deleted']:
                raise ValidationError('The assignment parent is deleted.')
    context = {'scope': scope, 'graph_id': graph['id'], 'installation': installation,
               'selected_ids': sorted(identifiers), 'related': [related[k] for k in sorted(related)]}
    return sorted(captured, key=lambda x: x['id']), digest(context)


def validate_proposal(proposed):
    _object(proposed, ('id', 'scope', 'library_id', 'library_fingerprint', 'member_ids', 'installation'))
    _id(proposed['id']); validate_installation(proposed['installation'])
    if proposed['scope'] not in ('defect_reports', 'service_plans'):
        raise ValidationError('Choose a supported physical assignment scope.')
    if not isinstance(proposed['library_id'], str) or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,119}', proposed['library_id']):
        raise ValidationError('Select a valid bounded library ID.')
    _hash(proposed['library_fingerprint'])
    members = proposed['member_ids']
    if not isinstance(members, list) or not 1 <= len(members) <= MAX_MEMBERS:
        raise ValidationError('Select one to 100 distinct physical member IDs.')
    for identifier in members:
        _id(identifier)
    if len(set(members)) != len(members):
        raise ValidationError('Select one to 100 distinct physical member IDs.')


def create_assignment(snapshot, proposed, library):
    validate_proposal(proposed)
    if library['id'] != proposed['library_id'] or library['metadata_sha256'] != proposed['library_fingerprint']:
        raise ValidationError('The library metadata changed during selection. Search and review the item again.')
    collection = snapshot.setdefault('library_assignments', {'version': 1, 'records': []})
    if any(r['id'] == proposed['id'] for r in collection['records']):
        raise ValidationError('This assignment ID already exists; reconfirm its retained association.')
    members, context = member_context(snapshot, proposed['scope'], proposed['member_ids'], proposed['installation'])
    captured = {k: deepcopy(library[k]) for k in ('id', 'library_id', 'title', 'source_sha256', 'revision', 'metadata_sha256')}
    collection['records'].append({'id': proposed['id'], 'version': 1, 'scope': proposed['scope'], 'installation': deepcopy(proposed['installation']),
        'members': members, 'library': captured, 'context_sha256': context, 'state': 'draft', 'confirmation': None, 'schedule_binding': None})
    validate_assignments(snapshot)


def status(snapshot, record, library=None):
    try:
        _, context = member_context(snapshot, record['scope'], [m['id'] for m in record['members']], record['installation'])
    except ValidationError:
        return 'needs_recheck'
    if context != record['context_sha256'] or library is not None and library['metadata_sha256'] != record['library']['metadata_sha256']:
        return 'needs_recheck'
    return record['state']


def invalidate_assignments(snapshot):
    for record in snapshot.get('library_assignments', {}).get('records', []):
        if record['state'] != 'needs_recheck' and status(snapshot, record) == 'needs_recheck':
            record['state'] = 'needs_recheck'; record['version'] += 1


def validate_history(event):
    """Retained assignment identities and contributions require controlled receipts."""
    before, after = event['before'], event['after']
    validate_assignments(before); validate_assignments(after)
    old = {r['id']: r for r in before.get('library_assignments', {}).get('records', [])}
    new = {r['id']: r for r in after.get('library_assignments', {}).get('records', [])}
    if before['revision'] == 0 and old:
        raise ValidationError('The initial audit state cannot contain unrecorded library assignments.')
    if old.keys() - new.keys():
        raise ValidationError('Retained commercial assignment identities cannot be discarded by ordinary draft edits or Undo.')
    added = new.keys() - old.keys()
    if added and (event['op'] != 'draft_library_assignment' or len(added) != 1
            or any(new[k]['version'] != 1 or new[k]['state'] != 'draft' for k in added)):
        raise ValidationError('A library assignment must begin as one explicitly selected version-one draft.')
    for identifier in old.keys() & new.keys():
        prior, current = old[identifier], new[identifier]
        binding = lambda r: (r['scope'], r['installation'], r['library']['id'], sorted(m['id'] for m in r['members']))
        if binding(prior) != binding(current):
            raise ValidationError('Retained assignment membership, installation and library identities cannot be rewritten.')
        if prior != current and current['version'] <= prior['version']:
            raise ValidationError('Edited library assignments require an increasing retained version.')
        if event['op'] != 'apply_library_link':
            allowed = {**deepcopy(prior), 'state': current['state'], 'version': current['version']}
            if current != allowed or current['state'] not in (prior['state'], 'needs_recheck'):
                raise ValidationError('A commercial contribution can change only through its reviewed schedule transaction.')


def confirmation_preview(snapshot, assignment_id, quantity, draft, library, configuration, operation='confirm'):
    from .penetration_calculator import normalize_draft, definition
    from .takeoff_model import digest
    _id(assignment_id)
    if operation not in ('confirm', 'unlink'):
        raise ValidationError('Choose an explicit commercial confirmation or unlink operation.')
    if operation == 'confirm':
        _quantity(quantity)
    elif type(quantity) not in (int, float) or quantity != 0:
        raise ValidationError('An explicit unlink must contribute zero new quantity.')
    record = next((r for r in snapshot.get('library_assignments', {}).get('records', []) if r['id'] == assignment_id), None)
    if record is None:
        raise ValidationError('Select a retained library assignment.')
    if operation == 'confirm' and record['installation']['mode'] == 'combined_installation' and quantity != 1:
        raise ValidationError('Review one quantity for this explicit combined installation.')
    if operation == 'confirm':
        members, context = member_context(snapshot, record['scope'], [m['id'] for m in record['members']], record['installation'])
    else:
        members, context = deepcopy(record['members']), record['context_sha256']
    # Validate without replacing original/manual literal values or globals.
    normalize_draft(draft)
    output = deepcopy(draft)
    rows = output['rows']; linked = [r for r in rows if r.get('library_item_id') == library['id']]
    if len(linked) > 1:
        raise ValidationError('The schedule has duplicate rows for this library item.')
    row = linked[0] if linked else None
    binding = record['schedule_binding']
    if operation == 'unlink' and binding is None:
        raise ValidationError('This association has no confirmed schedule contribution to remove.')
    if binding and (row is None or row['id'] != binding['row_id']):
        raise ValidationError('The previously linked schedule row was removed or replaced. Preserve its values and resolve the association before relinking.')
    old = binding['quantity'] if binding else 0
    if row:
        current = row['inputs'].get('O') or 0
        if type(current) not in (int, float) or not math.isfinite(current):
            raise ValidationError('The manually edited schedule quantity conflicts with the retained contribution. Review it before reconfirming.')
        with localcontext() as numeric_context:
            numeric_context.prec = 400
            retained = sum((Decimal(str(r['schedule_binding']['quantity'])) for r in snapshot.get('library_assignments', {}).get('records', [])
                if r['library']['id'] == library['id'] and r['schedule_binding'] is not None and r['schedule_binding']['row_id'] == row['id']), Decimal(0))
            if current < float(retained):
                raise ValidationError('The manually edited schedule quantity conflicts with the retained contribution. Review it before reconfirming.')
            delta = Decimal(str(quantity)) - Decimal(str(old))
            manual = max(Decimal(str(current)) - retained, Decimal(0))
            proposed = current if delta == 0 else float(manual + retained + delta)
        if operation == 'confirm':
            _quantity(proposed)
        elif not math.isfinite(proposed) or not 0 <= proposed <= 10**12:
            raise ValidationError('Removing this contribution would create an invalid manual schedule quantity.')
        row['inputs']['O'] = proposed
        action = 'unchanged' if proposed == current else 'update'
    else:
        if len(rows) >= definition(configuration)['capacity']:
            raise ValidationError('The Firestopping Schedule is full.')
        used = {r['id'] for r in rows}; ordinal = 1
        while f'line-{ordinal}' in used:
            ordinal += 1
        row = {'id': f'line-{ordinal}', 'library_item_id': library['id'], 'inputs': {**deepcopy(library['inputs']), 'O': quantity}}
        rows.append(row); current = 0; proposed = quantity; action = 'insert'
    normalize_draft(output)
    updated = deepcopy(record)
    updated.update(version=record['version']+1, members=members, context_sha256=context, state='confirmed',
        library={k:deepcopy(library[k]) for k in record['library']},
        confirmation={'quantity':quantity, 'context_sha256':context, 'library_sha256':library['metadata_sha256']},
        schedule_binding={'row_id':row['id'], 'quantity':quantity})
    if operation == 'unlink':
        updated.update(state='draft', confirmation=None, schedule_binding=None)
        # Unlink changes only the reviewed contribution. Retain original metadata
        # so later re-confirmation still requires a fresh explicit review.
        updated['library'] = deepcopy(record['library'])
    overlaps = [r['id'] for r in snapshot.get('library_assignments', {}).get('records', [])
        if r['id'] != record['id'] and r['scope'] == record['scope'] and set(m['id'] for m in r['members']) & set(m['id'] for m in record['members'])]
    return {'assignment':updated, 'draft':output, 'base_fingerprint':digest({'draft':draft,'configuration':configuration}),
        'change':{'action':action,'operation':operation,'row_id':row['id'],'library_id':library['id'],'previous_quantity':current,'next_quantity':proposed,'prior_contribution':old,'confirmed_contribution':quantity},
        'library':deepcopy(library), 'overlapping_assignment_ids':overlaps, 'source_sha256':definition(configuration)['source_sha256']}
