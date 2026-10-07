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
BARRIER_FIELDS = ('barrier_type', 'substrate', 'orientation')


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
    if (not isinstance(value, str) or len(value) > limit
            or any(ord(c) < 32 and c not in '\n\r\t' or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
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


def _physical_quantity(value):
    if type(value) is not int or not 1 <= value <= 10**12:
        raise ValidationError('Enter an explicit positive whole Item QTY of at most 1000000000000.')
    return value


def validate_quantity_source(value):
    """An optional source distinguishes new physical-count links from old manual links."""
    if not isinstance(value, dict):
        raise ValidationError('The assignment quantity source must be structured.')
    kind = value.get('kind')
    _object(value, ('version', 'kind', 'quantity') if kind == 'blank_seals' else ('version', 'kind'))
    if type(value['version']) is not int or value['version'] != 1 or kind not in ('services', 'blank_seals'):
        raise ValidationError('Choose explicit service quantities or an explicit blank seal quantity.')
    if kind == 'blank_seals':
        _physical_quantity(value['quantity'])


def assignment_quantity(snapshot, record):
    """Resolve only recorded members; parents, images and markers never add counts."""
    source = record.get('quantity_source')
    if source is None:
        return None  # Retain the reviewed commercial semantics of saved/manual links.
    validate_quantity_source(source)
    if source['kind'] == 'blank_seals':
        return 1 if record['installation']['mode'] == 'combined_installation' else source['quantity']
    graph = snapshot.get('physical' if record['scope'] == 'defect_reports' else 'service_plans') or {}
    services = {entity['id']: entity for entity in graph.get('services', [])}
    identifiers = [member['id'] for member in record['members'] if member['kind'] == 'service']
    if not identifiers:
        raise ValidationError('Select explicit service members; parent records do not infer descendant quantities.')
    quantities = []
    for identifier in identifiers:
        entity = services.get(identifier)
        if not entity or entity['deleted']:
            raise ValidationError('An associated service is unavailable. Review the current physical members.')
        if entity['quantity'] is None:
            raise ValidationError('An associated service quantity is unknown. Enter its Explicit service quantity in View/Edit before Transfer or Update linked rows.')
        quantities.append(_physical_quantity(entity['quantity']))
    total = 1 if record['installation']['mode'] == 'combined_installation' else sum(quantities)
    return _physical_quantity(total)


def prepare_assigned_quantities(snapshot, proposed):
    """Apply explicitly reviewed service counts and capture their association atomically."""
    from .takeoff_physical_operations import prepare_changes
    updates = proposed.get('service_quantities')
    if updates is None:
        return None
    if proposed.get('quantity_source', {}).get('kind') != 'services':
        raise ValidationError('Explicit service edits require a service quantity source.')
    graph = snapshot.get('physical' if proposed['scope'] == 'defect_reports' else 'service_plans') or {}
    entries = {entity['id']: entity for entity in graph.get('services', [])}
    members = set(proposed['member_ids'])
    commands = []
    for update in updates:
        entity = entries.get(update['id'])
        if not entity or entity['deleted'] or entity['id'] not in members or entity['revision'] != update['revision']:
            raise ValidationError('An explicitly selected service changed or is unavailable. Review its current quantity and revision.')
        if entity['quantity'] != update['quantity']:
            commands.append({'op': 'update', 'entity_id': entity['id'], 'changes': {'quantity': update['quantity']}})
    return prepare_changes(snapshot, commands, lambda reference: None, scope=proposed['scope'])['graph'] if commands else None


def validate_installation(value):
    _object(value, ('id', 'mode', 'note'))
    _id(value['id']); _text(value['note'])
    if value['mode'] not in MODES:
        raise ValidationError('Choose explicit repeated installations or one combined installation.')
    if value['mode'] == 'combined_installation' and not value['note'].strip():
        raise ValidationError('Describe the explicit combined installation; a shared barrier is not an opening.')


def barrier_differences(fields, selected):
    """Compare only supplied literal barrier properties, without inference."""
    return [{'field': key, 'selected': selected[key], 'retained': fields.get(key, '')}
            for key in BARRIER_FIELDS if selected.get(key) and selected[key] != fields.get(key, '')]


def validate_barrier_selection(value):
    _object(value, ('version', 'choice', 'defect_id', 'defect_revision', 'barrier_id',
                    'barrier_revision', 'source_fields', 'retained_fields', 'differences', 'mismatch_accepted'))
    if type(value['version']) is not int or value['version'] != 1 or value['choice'] not in ('new', 'existing'):
        raise ValidationError('Only a version-one explicit Defect barrier selection is supported.')
    _id(value['defect_id']); _id(value['barrier_id'])
    _revision(value['defect_revision']); _revision(value['barrier_revision'])
    if not value['defect_revision'] or not value['barrier_revision'] or type(value['mismatch_accepted']) is not bool:
        raise ValidationError('Capture the exact physical revisions and explicit unapproved mismatch decision.')
    for fields in (value['source_fields'], value['retained_fields']):
        if not isinstance(fields, dict) or set(fields) - set(BARRIER_FIELDS):
            raise ValidationError('Barrier selection properties must be bounded literal barrier fields.')
        for text in fields.values():
            _text(text)
    if value['differences'] != barrier_differences(value['retained_fields'], value['source_fields']):
        raise ValidationError('The recorded barrier differences must exactly match the captured literal fields.')
    if value['choice'] == 'new' and (value['source_fields'] != value['retained_fields'] or value['mismatch_accepted']):
        raise ValidationError('A new barrier retains the explicitly selected library fields without a mismatch decision.')
    if value['choice'] == 'existing' and bool(value['differences']) != value['mismatch_accepted']:
        raise ValidationError('Retaining different barrier fields requires an explicit unapproved Continue decision.')


def prepare_library_import(snapshot, proposed, library):
    """Append one selected item under one Defect in a detached atomic graph."""
    from .takeoff_physical_operations import prepare_changes
    _object(proposed, ('version', 'scope', 'defect_id', 'defect_revision', 'selected_ids',
                      'barrier_id', 'barrier_revision', 'library_id', 'library_fingerprint',
                      'accept_mismatch', 'ids') + tuple(key for key in ('draft_quantity', 'draft_location', 'item_quantity') if isinstance(proposed, dict) and key in proposed))
    if 'item_quantity' in proposed:
        _physical_quantity(proposed['item_quantity'])
    if 'draft_quantity' in proposed:
        _quantity(proposed['draft_quantity'])
    if 'draft_location' in proposed:
        _text(proposed['draft_location'])
    if type(proposed['version']) is not int or proposed['version'] != 1 or proposed['scope'] != 'defect_reports':
        raise ValidationError('Append an explicitly selected library item within Defect Reports.')
    _id(proposed['defect_id']); _revision(proposed['defect_revision'])
    if type(proposed['accept_mismatch']) is not bool:
        raise ValidationError('The barrier mismatch decision must be explicit.')
    ids = proposed['ids']; _object(ids, ('barrier', 'service', 'assignment', 'installation'))
    _id(ids['assignment']); _id(ids['installation'])
    identifiers = proposed['selected_ids']
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= MAX_MEMBERS:
        raise ValidationError('Select bounded physical records under one Defect.')
    for identifier in identifiers:
        _id(identifier)
    if len(set(identifiers)) != len(identifiers):
        raise ValidationError('Selected physical identities must be distinct.')
    graph = snapshot.get('physical')
    if not graph or graph.get('version') != 2:
        raise ValidationError('Only active numbered Defect Reports can receive additional library items.')
    entries = {entry['id']: (kind, entry) for kind, collection in
               (('defect', 'defects'), ('barrier', 'barriers'), ('service', 'services')) for entry in graph[collection]}
    parent = entries.get(proposed['defect_id'])
    if not parent or parent[0] != 'defect' or parent[1]['deleted'] or parent[1]['revision'] != proposed['defect_revision']:
        raise ValidationError('The selected Defect changed or is unavailable. Select its current records again.')
    defect = parent[1]
    for identifier in identifiers:
        entry = entries.get(identifier)
        if not entry or entry[1]['deleted']:
            raise ValidationError('A selected physical record is unavailable.')
        kind, entity = entry
        if kind == 'service':
            kind, entity = entries[entity['barrier_id']]
            if entity['deleted']:
                raise ValidationError('A selected service belongs to a removed barrier.')
        owner = entity['id'] if kind == 'defect' else entity['defect_id']
        if owner != defect['id']:
            raise ValidationError('Choose records under one Defect; cross-Defect library imports are ambiguous.')
    validate_proposal({'id': ids['assignment'], 'scope': proposed['scope'], 'library_id': proposed['library_id'],
                      'library_fingerprint': proposed['library_fingerprint'], 'member_ids': identifiers,
                      'installation': {'id': ids['installation'], 'mode': 'repeated_installations', 'note': ''}})
    if library['id'] != proposed['library_id'] or library['metadata_sha256'] != proposed['library_fingerprint']:
        raise ValidationError('The library metadata changed during selection. Search and select the item again.')
    selected_fields = {key: deepcopy(library['import_fields']['barrier'][key])
                       for key in BARRIER_FIELDS if key in library['import_fields']['barrier']}
    commands = []
    assertion = lambda fields: {'fields': deepcopy(fields), 'evidence': [],
        'uncertainty': {'state': 'human_review_required', 'note':
            'Manually selected library fields; verify the actual installation and technical applicability.'}}
    if proposed['barrier_id'] is None:
        if proposed['barrier_revision'] is not None or proposed['accept_mismatch']:
            raise ValidationError('A new barrier has no retained-barrier revision or mismatch decision.')
        _id(ids['barrier'])
        barrier_id = ids['barrier']
        entity = {'id': barrier_id, 'defect_id': defect['id'], **assertion(library['import_fields']['barrier'])}
        if proposed.get('draft_location') and not entity['fields'].get('location') and not defect['fields'].get('location'):
            entity['fields']['location'] = proposed['draft_location']
        if 'annotation' in defect:
            entity['marker'] = deepcopy(defect['annotation'])
        commands.append({'op': 'create', 'kind': 'barrier', 'entity': entity})
        choice = 'new'; retained = selected_fields
    else:
        _id(proposed['barrier_id']); _revision(proposed['barrier_revision'])
        if ids['barrier'] is not None:
            raise ValidationError('Existing Barrier retains its identity rather than creating another barrier.')
        barrier_id = proposed['barrier_id']; entry = entries.get(barrier_id)
        if (not entry or entry[0] != 'barrier' or entry[1]['deleted']
                or entry[1]['defect_id'] != defect['id'] or entry[1]['revision'] != proposed['barrier_revision']):
            raise ValidationError('The explicitly selected Barrier changed or belongs to another Defect.')
        retained = {key: deepcopy(entry[1]['fields'][key]) for key in BARRIER_FIELDS if key in entry[1]['fields']}
        differences = barrier_differences(retained, selected_fields)
        if bool(differences) != proposed['accept_mismatch']:
            raise ValidationError('Review the literal barrier mismatch and explicitly Continue or choose another library item.')
        choice = 'existing'
    service = library['import_fields']['service']
    if service is not None:
        _id(ids['service'])
        entity = {'id': ids['service'], 'barrier_id': barrier_id, **assertion(service),
                  'quantity': proposed.get('item_quantity')}
        if 'item_quantity' not in proposed:
            entity['library_quantity'] = {'version': 1, 'state': 'unknown', 'library_id': library['id'],
                                         'metadata_sha256': library['metadata_sha256']}
        commands.append({'op': 'create', 'kind': 'service', 'entity': entity})
    elif ids['service'] is not None:
        raise ValidationError('A selected Blank Seal does not create an active service or inferred opening.')
    if commands:
        prepared = prepare_changes(snapshot, commands, lambda reference: None, scope=proposed['scope'])
        resulting_graph = prepared['graph']
    else:
        resulting_graph = deepcopy(graph)
    barrier = next(value for value in resulting_graph['barriers'] if value['id'] == barrier_id)
    selection = {'version': 1, 'choice': choice, 'defect_id': defect['id'], 'defect_revision': defect['revision'],
        'barrier_id': barrier_id, 'barrier_revision': barrier['revision'], 'source_fields': selected_fields,
        'retained_fields': retained, 'differences': barrier_differences(retained, selected_fields),
        'mismatch_accepted': proposed['accept_mismatch']}
    validate_barrier_selection(selection)
    members = [defect['id'], barrier_id] + ([ids['service']] if service is not None else [])
    assignment = {'id': ids['assignment'], 'scope': proposed['scope'], 'library_id': library['id'],
        'library_fingerprint': library['metadata_sha256'], 'member_ids': members,
        'installation': {'id': ids['installation'], 'mode': 'repeated_installations', 'note': ''}}
    for key in ('draft_quantity', 'draft_location'):
        if key in proposed:
            assignment[key] = deepcopy(proposed[key])
    if 'item_quantity' in proposed:
        assignment['quantity_source'] = ({'version': 1, 'kind': 'services'} if service is not None else
                                         {'version': 1, 'kind': 'blank_seals', 'quantity': proposed['item_quantity']})
    return {'graph': resulting_graph, 'commands': commands, 'assignment': assignment, 'barrier_selection': selection}


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
        _object(record, ('id', 'version', 'scope', 'installation', 'members', 'library', 'context_sha256', 'state', 'confirmation', 'schedule_binding')
                + tuple(key for key in ('barrier_selection', 'draft_quantity', 'draft_location', 'quantity_source') if isinstance(record, dict) and key in record))
        if 'quantity_source' in record:
            validate_quantity_source(record['quantity_source'])
        if 'draft_quantity' in record:
            _quantity(record['draft_quantity'])
        if 'draft_location' in record:
            _text(record['draft_location'])
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
        _text(library['library_id'], 200); _text(library['title'], 10000); _revision(library['revision'])
        _hash(library['source_sha256']); _hash(library['metadata_sha256']); _hash(record['context_sha256'])
        if 'barrier_selection' in record:
            validate_barrier_selection(record['barrier_selection'])
            if record['scope'] != 'defect_reports':
                raise ValidationError('A Defect barrier selection belongs to Defect Reports.')
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
        if record.get('quantity_source', {}).get('kind') == 'services' and not any(member['kind'] == 'service' for member in record['members']):
            raise ValidationError('A service quantity source requires explicit service members, not inferred descendants.')
        if record.get('quantity_source', {}).get('kind') == 'blank_seals' and any(member['kind'] == 'service' for member in record['members']):
            raise ValidationError('An explicit blank seal quantity cannot count associated services.')
        if 'barrier_selection' in record:
            selection = record['barrier_selection']
            captured = {member['id']: member for member in record['members']}
            for identifier, kind, revision in ((selection['defect_id'], 'defect', selection['defect_revision']),
                                                (selection['barrier_id'], 'barrier', selection['barrier_revision'])):
                if identifier not in captured or captured[identifier]['kind'] != kind or captured[identifier]['revision'] < revision:
                    raise ValidationError('Barrier selection provenance must retain its typed Defect and Barrier membership.')
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
            if (record.get('quantity_source', {}).get('kind') == 'blank_seals'
                    and record['installation']['mode'] == 'repeated_installations'
                    and confirmation['quantity'] != record['quantity_source']['quantity']):
                raise ValidationError('The retained blank seal confirmation must match its explicit seal quantity.')
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
    _object(proposed, ('id', 'scope', 'library_id', 'library_fingerprint', 'member_ids', 'installation')
            + tuple(key for key in ('draft_quantity', 'draft_location', 'quantity_source', 'service_quantities') if isinstance(proposed, dict) and key in proposed))
    if 'quantity_source' in proposed:
        validate_quantity_source(proposed['quantity_source'])
    if 'service_quantities' in proposed:
        updates = proposed['service_quantities']
        if not isinstance(updates, list) or not 1 <= len(updates) <= MAX_MEMBERS:
            raise ValidationError('Review one to 100 explicit service quantity edits.')
        identifiers = set()
        for update in updates:
            _object(update, ('id', 'revision', 'quantity'))
            _id(update['id']); _revision(update['revision']); _physical_quantity(update['quantity'])
            if update['id'] in identifiers:
                raise ValidationError('Explicit service quantity edits must have distinct identities.')
            identifiers.add(update['id'])
    if 'draft_quantity' in proposed:
        _quantity(proposed['draft_quantity'])
    if 'draft_location' in proposed:
        _text(proposed['draft_location'])
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


def create_assignment(snapshot, proposed, library, *, barrier_selection=None):
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
    for key in ('draft_quantity', 'draft_location', 'quantity_source'):
        if key in proposed:
            collection['records'][-1][key] = deepcopy(proposed[key])
    source = proposed.get('quantity_source')
    if source is not None and (source['kind'] == 'blank_seals') != (library['import_fields']['service'] is None):
        raise ValidationError('A selected service item requires service quantities; only a selected Blank Seal can retain a blank seal count.')
    if barrier_selection is not None:
        collection['records'][-1]['barrier_selection'] = deepcopy(barrier_selection)
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
    if added and (event['op'] not in ('draft_library_assignment', 'import_library_item') or len(added) != 1
            or any(new[k]['version'] != 1 or new[k]['state'] != 'draft' for k in added)):
        raise ValidationError('A library assignment must begin as one explicitly selected version-one draft.')
    if event['op'] == 'import_library_item':
        if len(added) != 1:
            raise ValidationError('A selected-item import must create one retained draft association.')
        record = new[next(iter(added))]
        if 'barrier_selection' not in record:
            raise ValidationError('A selected-item import must retain its explicit barrier choice.')
        selection = record['barrier_selection']
        prior_graph, current_graph = before.get('physical'), after.get('physical')
        if not prior_graph or prior_graph['version'] != 2 or not current_graph or current_graph['version'] != 2:
            raise ValidationError('An additional library item must retain its existing Defect hierarchy.')
        entities = lambda graph: {entity['id']: entity for collection in ('defects', 'barriers', 'services') for entity in graph[collection]}
        old_entities, new_entities = entities(prior_graph), entities(current_graph)
        if any(new_entities.get(identifier) != entity for identifier, entity in old_entities.items()):
            raise ValidationError('Adding a library item cannot change retained physical fields, quantities, sources or identities.')
        if selection['defect_id'] not in old_entities:
            raise ValidationError('An additional library item must belong to its retained Defect.')
        barrier = new_entities.get(selection['barrier_id'])
        if not barrier or barrier.get('defect_id') != selection['defect_id']:
            raise ValidationError('The selected Barrier must belong to the retained Defect.')
        retained = {key: barrier['fields'][key] for key in BARRIER_FIELDS if key in barrier['fields']}
        if retained != selection['retained_fields'] or barrier['revision'] != selection['barrier_revision']:
            raise ValidationError('The barrier review must capture the exact imported or retained barrier fields and revision.')
        if (selection['choice'] == 'new') != (barrier['id'] not in old_entities):
            raise ValidationError('The explicit New/Existing Barrier choice must match its retained identity.')
        expected = {member['id'] for member in record['members']} - old_entities.keys()
        if new_entities.keys() - old_entities.keys() != expected:
            raise ValidationError('The import may add only its explicitly associated new physical records.')
        if selection['choice'] == 'new' and 'annotation' in old_entities[selection['defect_id']]:
            if barrier.get('marker') != old_entities[selection['defect_id']]['annotation']:
                raise ValidationError('A new library barrier must preserve its Defect source annotation exactly.')
    for identifier in old.keys() & new.keys():
        prior, current = old[identifier], new[identifier]
        binding = lambda r: (r['scope'], r['installation'], r['library']['id'], sorted(m['id'] for m in r['members']))
        if binding(prior) != binding(current):
            raise ValidationError('Retained assignment membership, installation and library identities cannot be rewritten.')
        if prior.get('barrier_selection') != current.get('barrier_selection'):
            raise ValidationError('The original explicit barrier selection and mismatch review must remain unchanged.')
        if any(prior.get(key) != current.get(key) for key in ('draft_quantity', 'draft_location')):
            raise ValidationError('The originally entered draft item details must remain unchanged.')
        prior_source, current_source = prior.get('quantity_source'), current.get('quantity_source')
        if prior_source != current_source:
            if (event['op'] != 'apply_library_link' or current_source is None
                    or current['state'] != 'confirmed' or current['confirmation'] is None
                    or (prior_source is not None and (prior_source['kind'] != 'blank_seals'
                        or current_source['kind'] != prior_source['kind']))):
                raise ValidationError('A quantity source can be adopted or its blank seal count changed only by an explicit reviewed schedule transaction.')
            if assignment_quantity(after, current) != current['confirmation']['quantity']:
                raise ValidationError('The reviewed quantity source must match its exact current physical contribution.')
        if prior != current and current['version'] <= prior['version']:
            raise ValidationError('Edited library assignments require an increasing retained version.')
        if event['op'] != 'apply_library_link':
            allowed = {**deepcopy(prior), 'state': current['state'], 'version': current['version']}
            if current != allowed or current['state'] not in (prior['state'], 'needs_recheck'):
                raise ValidationError('A commercial contribution can change only through its reviewed schedule transaction.')


def confirmation_preview(snapshot, assignment_id, quantity, draft, library, configuration, operation='confirm', quantity_source=None):
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
    source = deepcopy(record.get('quantity_source'))
    if quantity_source is not None:
        if operation != 'confirm':
            raise ValidationError('Unlink preserves the retained physical quantity source.')
        validate_quantity_source(quantity_source)
        if source is not None and source['kind'] != quantity_source['kind']:
            raise ValidationError('The retained assignment quantity source cannot change kinds.')
        source = deepcopy(quantity_source)
    if source is not None and operation == 'confirm':
        if (source['kind'] == 'blank_seals') != (library['import_fields']['service'] is None):
            raise ValidationError('Review a service item with explicit service members, or a Blank Seal with its explicit seal count.')
        if source['kind'] == 'blank_seals' and record['installation']['mode'] == 'repeated_installations' and quantity_source is None:
            # The review explicitly edits this seal count; it never creates a service.
            source['quantity'] = _physical_quantity(quantity)
        derived = assignment_quantity(snapshot, {**record, 'quantity_source': source})
        if quantity != derived or type(quantity) is not int:
            raise ValidationError(f'Transfer or Update must use the current explicit physical quantity ({derived}). Review the current service or blank seal counts.')
    else:
        derived = None
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
    if source is not None:
        updated['quantity_source'] = source
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
        'library':deepcopy(library), 'overlapping_assignment_ids':overlaps, 'source_sha256':definition(configuration)['source_sha256'],
        **({'derived_quantity': derived, 'quantity_source': deepcopy(source)} if source is not None and operation == 'confirm' else {})}
