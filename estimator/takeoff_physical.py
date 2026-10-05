"""Versioned deterministic draft physical hierarchies.

This module owns no persistence, evidence bytes, calculator values, approval or
Physical Model Lock. Evidence locators and uncertainty are recorded assertions.
A preview digest prevents applying a different edit or a stale graph; it is not
an authorization token. UUIDs are supplied by the caller and never recycled.
Version 3 uses Barrier -> Service for independent service plans.
Version 2 uses Defect -> Barrier -> Service and assigns immutable display IDs.
Version 1 remains a lossless legacy Barrier -> Defect -> Opening -> Service graph.
"""

from copy import deepcopy
from hashlib import sha256
import json
import math
import re
from uuid import UUID, uuid4

from .catalog import ValidationError

MAX_ENTITIES = 10000  # Includes tombstones, so deletion cannot evade the bound.
MAX_EVIDENCE = 32
MAX_REGION_VERTICES = 64
MAX_TEXT = 2000
MAX_TOTAL_EVIDENCE = 20000
MAX_TOTAL_REGION_VERTICES = 100000
MAX_TOTAL_TEXT = 4 * 1024 * 1024
KINDS = ('barrier', 'defect', 'opening', 'service')
COLLECTIONS = dict(zip(KINDS, ('barriers', 'defects', 'openings', 'services')))
PARENTS = {'defect': ('barrier', 'barrier_id'),
           'opening': ('defect', 'defect_id'),
           'service': ('opening', 'opening_id')}
_V2_COLLECTIONS = {'defect': 'defects', 'barrier': 'barriers', 'service': 'services'}
_V3_COLLECTIONS = {'barrier': 'barriers', 'service': 'services'}
_V3_PARENTS = {'service': ('barrier', 'barrier_id')}
_V2_PARENTS = {'barrier': ('defect', 'defect_id'), 'service': ('barrier', 'barrier_id')}
_DISPLAY_PREFIXES = {'defect': 'D', 'barrier': 'B', 'service': 'S'}
FIELDS = {
    'barrier': frozenset(('label', 'location', 'barrier_type', 'substrate',
                          'orientation', 'thickness_mm', 'notes')),
    'defect': frozenset(('label', 'location', 'frl', 'notes')),
    'opening': frozenset(('label', 'opening_type', 'size', 'shape', 'width_mm',
                          'height_mm', 'diameter_mm', 'depth_mm', 'notes')),
    'service': frozenset(('label', 'service', 'service_type', 'size', 'width_mm',
                          'height_mm', 'diameter_mm', 'insulation_mm', 'notes')),
}
DIMENSIONS = frozenset(('thickness_mm', 'width_mm', 'height_mm', 'diameter_mm',
                       'depth_mm', 'insulation_mm'))
UNCERTAINTY_STATES = frozenset(('not_assessed', 'unresolved', 'missing',
    'conflicting', 'insufficient_evidence', 'human_review_required', 'none_reported'))
_HASH = re.compile(r'^[0-9a-f]{64}$')
_ENTITY_KEYS = frozenset(('id', 'revision', 'deleted', 'deleted_at_revision',
                          'fields', 'evidence', 'uncertainty'))
_GRAPH_BASE_KEYS = frozenset(('version', 'project_id', 'id', 'revision', 'state'))


def graph_collections(graph):
    """Return typed collections without converting either stored hierarchy."""
    version = graph.get('version') if isinstance(graph, dict) else None
    if type(version) is not int or version not in (1, 2, 3):
        raise ValidationError('Only version 1, 2 and 3 draft physical graphs are supported.')
    return dict({1: COLLECTIONS, 2: _V2_COLLECTIONS, 3: _V3_COLLECTIONS}[version])


def graph_parents(graph):
    """Return the explicit typed parent rules for this stored graph version."""
    graph_collections(graph)
    return dict({1: PARENTS, 2: _V2_PARENTS, 3: _V3_PARENTS}[graph['version']])


def _display_number(value, kind):
    prefix = _DISPLAY_PREFIXES[kind]
    if not isinstance(value, str) or not re.fullmatch(rf'{prefix}-[0-9]{{4,5}}', value):
        raise ValidationError('Physical display IDs must use their typed sequential format.')
    ordinal = int(value[2:])
    if not 1 <= ordinal <= MAX_ENTITIES or value != f'{prefix}-{ordinal:04d}':
        raise ValidationError('Physical display IDs must use their typed sequential format.')
    return ordinal


def _object(value, allowed, required, label):
    if (not isinstance(value, dict) or set(value) - set(allowed)
            or not set(required) <= set(value)):
        raise ValidationError(f'{label} contains missing or unsupported fields.')
    return value


def _id(value, label='Physical ID'):
    if not isinstance(value, str):
        raise ValidationError(f'{label} must be a canonical UUID.')
    try:
        valid = str(UUID(value)) == value
    except ValueError:
        valid = False
    if not valid:
        raise ValidationError(f'{label} must be a canonical UUID.')
    return value


def _number(value, label, *, minimum=None, integer=False):
    if (type(value) not in (int, float) or abs(value) > 1e12
            or not math.isfinite(value) or integer and type(value) is not int
            or minimum is not None and value < minimum):
        raise ValidationError(f'{label} must be a bounded finite {"integer" if integer else "number"}.')
    return value


def _text(value, label, limit=MAX_TEXT):
    if (not isinstance(value, str) or len(value) > limit
            or any(ord(char) < 32 and char not in '\n\r\t' for char in value)
            or any(0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ValidationError(f'{label} must be text of at most {limit} characters.')
    return value


def _hash(value, label):
    if not isinstance(value, str) or not _HASH.fullmatch(value):
        raise ValidationError(f'{label} must be a SHA-256 digest.')
    return value


def _digest(value):
    def canonical(entry):
        if type(entry) is float and entry.is_integer():
            return int(entry)
        if isinstance(entry, dict):
            return {key: canonical(child) for key, child in entry.items()}
        if isinstance(entry, list):
            return [canonical(child) for child in entry]
        return entry
    return sha256(json.dumps(canonical(value), sort_keys=True, ensure_ascii=False,
                            separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _kind(value, collections):
    if not isinstance(value, str) or value not in collections:
        raise ValidationError('Physical entity kind is not supported by this graph version.')
    return value


def _parent(kind, entity, parents):
    return entity[parents[kind][1]] if kind in parents else None


def _field_names(kind, parents):
    return FIELDS[kind] | ({'frl'} if kind == 'barrier' and parents == _V3_PARENTS else set())


def entity_references(entity):
    """Retained evidence plus separate visual marker/annotation source locators."""
    return [*entity['evidence'], *([entity['marker']] if entity.get('marker') else []),
            *([entity['annotation']] if entity.get('annotation') else [])]


def _marker(value, label='Barrier marker'):
    if value is None:
        return
    keys = {'document_id', 'document_sha256', 'page', 'point'}
    _object(value, keys | {'callout', 'appearance'}, keys, label)
    if 'appearance' in value:
        from .takeoff_model import validate_appearance
        validate_appearance(value['appearance'])
    _id(value['document_id'], 'Marker document ID')
    _hash(value['document_sha256'], 'Marker document hash')
    _number(value['page'], 'Marker page', minimum=1, integer=True)
    if not isinstance(value['point'], list) or len(value['point']) != 2:
        raise ValidationError(f'{label} requires one PDF coordinate pair.')
    for coordinate in value['point']:
        _number(coordinate, 'Marker coordinate')
    if 'callout' in value:
        layout = value['callout']
        _object(layout, {'offset', 'width', 'height', 'appearance'}, set(), label + ' callout layout')
        geometry = {'offset', 'width', 'height'} & layout.keys()
        _object(layout, {'offset', 'width', 'height', 'appearance'},
                {'offset', 'width', 'height'} if geometry else {'appearance'}, label + ' callout layout')
        if 'appearance' in layout:
            from .takeoff_model import validate_appearance
            validate_appearance(layout['appearance'])
        if not geometry:
            return
        if not isinstance(layout['offset'], list) or len(layout['offset']) != 2:
            raise ValidationError('Callout offset requires a PDF x/y coordinate pair.')
        for coordinate in layout['offset']:
            _number(coordinate, 'Callout offset', minimum=-10000)
            if coordinate > 10000:
                raise ValidationError('Callout offset exceeds the supported PDF bounds.')
        for key in ('width', 'height'):
            _number(layout[key], 'Callout '+key, minimum=1)
            if layout[key] > 10000:
                raise ValidationError('Callout dimensions exceed the supported PDF bounds.')


def _evidence(value, kind, parents):
    if not isinstance(value, list) or len(value) > MAX_EVIDENCE:
        raise ValidationError(f'Physical evidence is limited to {MAX_EVIDENCE} associations per entity.')
    field_names = _field_names(kind, parents) | {'uncertainty'}
    if kind in parents:
        field_names |= {parents[kind][1]}
    if kind == 'service':
        field_names |= {'quantity'}
    for entry in value:
        required = {'document_id', 'document_sha256', 'page'}
        allowed = required | {'region', 'image_id', 'image_sha256', 'occurrence_id', 'fields', 'note'}
        _object(entry, allowed, required, 'Physical evidence association')
        _id(entry['document_id'], 'Evidence document ID')
        _hash(entry['document_sha256'], 'Evidence document hash')
        _number(entry['page'], 'Evidence page', minimum=1, integer=True)
        image_keys = {'image_id', 'image_sha256', 'occurrence_id'} & entry.keys()
        if image_keys and image_keys != {'image_id', 'image_sha256', 'occurrence_id'}:
            raise ValidationError('Image evidence requires image ID, hash and retained occurrence ID together.')
        if image_keys:
            _id(entry['image_id'], 'Evidence image ID')
            _id(entry['occurrence_id'], 'Evidence occurrence ID')
            _hash(entry['image_sha256'], 'Evidence image hash')
        if 'fields' in entry:
            fields = entry['fields']
            if (not isinstance(fields, list) or len(fields) > 32
                    or any(not isinstance(field, str) or field not in field_names for field in fields)
                    or len(set(fields)) != len(fields)):
                raise ValidationError('Evidence fields must be distinct typed fields of this entity.')
        if 'note' in entry:
            _text(entry['note'], 'Evidence note')
        if 'region' in entry:
            region = entry['region']
            if not isinstance(region, list) or not 3 <= len(region) <= MAX_REGION_VERTICES:
                raise ValidationError(f'Evidence region requires 3 to {MAX_REGION_VERTICES} vertices.')
            for point in region:
                if not isinstance(point, list) or len(point) != 2:
                    raise ValidationError('Evidence region vertices require x and y coordinates.')
                _number(point[0], 'Evidence x')
                _number(point[1], 'Evidence y')
            if len(set(map(tuple, region))) != len(region):
                raise ValidationError('Evidence region vertices must be distinct.')


def _properties(entity, kind, parents):
    if 'copied_from' in entity:
        source = _object(entity['copied_from'], {'entity_id', 'revision'}, {'entity_id', 'revision'}, 'Copied physical source')
        if _id(source['entity_id']) == entity['id']:
            raise ValidationError('A physical record cannot be copied from itself.')
        _number(source['revision'], 'Copied source revision', minimum=1, integer=True)
    fields = _object(entity['fields'], _field_names(kind, parents), (), 'Physical fields')
    if 'marker' in entity:
        _marker(entity['marker'])
    if 'annotation' in entity:
        _marker(entity['annotation'], 'Defect source annotation')
    for key, value in fields.items():
        if key in DIMENSIONS:
            _number(value, key, minimum=0)
            if value == 0 and key != 'insulation_mm':
                raise ValidationError('Known physical dimensions must be positive; omit an unknown dimension.')
        else:
            _text(value, key)
    _evidence(entity['evidence'], kind, parents)
    uncertainty = _object(entity['uncertainty'], {'state', 'note'}, {'state', 'note'}, 'Physical uncertainty')
    if not isinstance(uncertainty['state'], str) or uncertainty['state'] not in UNCERTAINTY_STATES:
        raise ValidationError('Physical uncertainty must use an explicit supported state.')
    _text(uncertainty['note'], 'Uncertainty note')
    if kind == 'service':
        _number(entity['quantity'], 'Explicit service quantity', minimum=1, integer=True)


def validate_graph(graph, *, copy_result=True):
    """Validate draft topology and locator structure, never evidence or authority.

    Tombstoned nodes retain their original typed parent. Every parent exists,
    and every active child has an active parent. Strict level-specific links
    make cycles and implicit parent inference impossible.
    """
    collections, parents = graph_collections(graph), graph_parents(graph)
    graph_keys = _GRAPH_BASE_KEYS | set(collections.values())
    _object(graph, graph_keys, graph_keys, 'Physical graph')
    if graph['state'] != 'draft':
        raise ValidationError('Only draft physical graphs are supported.')
    _id(graph['project_id'], 'Project ID')
    _id(graph['id'], 'Physical graph ID')
    _number(graph['revision'], 'Physical graph revision', minimum=0, integer=True)
    index = {}
    evidence_count = vertex_count = text_count = 0
    documents, images, occurrences = {}, {}, {}
    for kind, collection in collections.items():
        display_ids = set()
        entries = graph[collection]
        if not isinstance(entries, list) or len(entries) > MAX_ENTITIES:
            raise ValidationError('Physical entity collections must be bounded lists.')
        for entity in entries:
            keys = _ENTITY_KEYS | ({parents[kind][1]} if kind in parents else set())
            if graph['version'] in (2, 3):
                keys |= {'display_id'}
            if kind == 'service':
                keys |= {'quantity'}
            optional = {'copied_from'} | ({'marker'} if kind == 'barrier' and graph['version'] in (2, 3) else {'annotation'} if kind == 'defect' and graph['version'] == 2 else set())
            _object(entity, keys | optional, keys, 'Physical entity')
            if graph['version'] in (2, 3):
                ordinal = _display_number(entity['display_id'], kind)
                if ordinal in display_ids:
                    raise ValidationError('Physical display IDs must be unique, including tombstones.')
                display_ids.add(ordinal)
            identifier = _id(entity['id'])
            if identifier in index:
                raise ValidationError('Physical entity IDs must be globally unique, including tombstones.')
            index[identifier] = (kind, entity)
            if len(index) > MAX_ENTITIES:
                raise ValidationError(f'The physical graph retains at most {MAX_ENTITIES} entities, including tombstones.')
            _number(entity['revision'], 'Entity revision', minimum=1, integer=True)
            if entity['revision'] > graph['revision']:
                raise ValidationError('Entity revision cannot exceed the graph revision.')
            if type(entity['deleted']) is not bool:
                raise ValidationError('Physical tombstone flag must be boolean.')
            deleted_revision = entity['deleted_at_revision']
            if entity['deleted']:
                _number(deleted_revision, 'Deletion revision', minimum=1, integer=True)
                if deleted_revision > graph['revision']:
                    raise ValidationError('Deletion revision cannot exceed the graph revision.')
            elif deleted_revision is not None:
                raise ValidationError('An active entity cannot have a deletion revision.')
            if kind in parents:
                _id(entity[parents[kind][1]], 'Physical parent ID')
            _properties(entity, kind, parents)
            evidence_count += len(entity['evidence'])
            text_count += sum(len(value) for value in entity['fields'].values() if isinstance(value, str))
            text_count += len(entity['uncertainty']['note'])
            if evidence_count > MAX_TOTAL_EVIDENCE:
                raise ValidationError('The physical graph exceeds its total evidence association limit.')
            for evidence in entity_references(entity):
                vertex_count += len(evidence.get('region', []))
                text_count += len(evidence.get('note', ''))
                if vertex_count > MAX_TOTAL_REGION_VERTICES:
                    raise ValidationError('The physical graph exceeds its total evidence region vertex limit.')
                document_id = evidence['document_id']
                if documents.setdefault(document_id, evidence['document_sha256']) != evidence['document_sha256']:
                    raise ValidationError('One evidence document ID cannot identify changed source bytes.')
                if 'image_id' in evidence:
                    if images.setdefault(evidence['image_id'], evidence['image_sha256']) != evidence['image_sha256']:
                        raise ValidationError('One evidence image ID cannot identify changed source bytes.')
                    # region annotates the entity's supporting part of a view.
                    # Several entities can cite different regions of the same
                    # retained image occurrence; it is not image placement.
                    locator = {key: evidence[key] for key in ('document_id', 'document_sha256', 'page',
                               'image_id', 'image_sha256')}
                    fingerprint = _digest(locator)
                    if occurrences.setdefault(evidence['occurrence_id'], fingerprint) != fingerprint:
                        raise ValidationError('An image occurrence ID must retain its exact source association.')
            if text_count > MAX_TOTAL_TEXT:
                raise ValidationError('The physical graph exceeds its total descriptive text limit.')
    for kind, entity in index.values():
        if kind in parents:
            expected_kind, parent_key = parents[kind]
            parent = index.get(entity[parent_key])
            if parent is None or parent[0] != expected_kind:
                raise ValidationError(f'Every {kind} must reference an existing {expected_kind}.')
            if not entity['deleted'] and parent[1]['deleted']:
                raise ValidationError('An active physical entity cannot reference a deleted parent.')
    return deepcopy(graph) if copy_result else graph


def new_graph(project_id, graph_id=None, *, version=1):
    """Create an explicit draft; default v1 preserves legacy low-level callers.

    The workspace chooses version 2 for new projects. Generated UUIDs must be
    retained by the caller, and saved graphs are never converted here.
    """
    graph = {'version': version, 'project_id': project_id, 'id': str(uuid4()) if graph_id is None else graph_id,
             'revision': 0, 'state': 'draft'}
    graph.update({name: [] for name in graph_collections(graph).values()})
    return validate_graph(graph)


def graph_digest(graph):
    """Bind all draft facts, evidence associations, uncertainty and tombstones."""
    validate_graph(graph, copy_result=False)
    return _digest(graph)


def _index(graph):
    return {entry['id']: (kind, entry) for kind, name in graph_collections(graph).items() for entry in graph[name]}


def _descendants(index, identifier, parents):
    children = {}
    for child_id, (kind, entity) in index.items():
        children.setdefault(_parent(kind, entity, parents), []).append(child_id)
    result, pending = set(), [identifier]
    while pending:
        for child in children.get(pending.pop(), []):
            result.add(child)
            pending.append(child)
    return result


def _command(graph, command):
    """Return a detached candidate and impact sets. Called only on valid graphs."""
    _object(command, {'op', 'kind', 'entity', 'entity_id', 'changes', 'parent_id',
                      'cascade', 'mode', 'entity_ids'}, {'op'}, 'Physical edit')
    op = command['op']
    schemas = {
        'create': {'op', 'kind', 'entity'}, 'update': {'op', 'entity_id', 'changes'},
        'reparent': {'op', 'entity_id', 'parent_id'}, 'delete': {'op', 'entity_id', 'cascade'},
        'restore': {'op', 'entity_id', 'mode', 'entity_ids'},
    }
    if not isinstance(op, str) or op not in schemas:
        raise ValidationError('Unsupported physical graph operation.')
    required = schemas[op] - ({'entity_ids'} if op == 'restore' else set())
    _object(command, schemas[op], required, 'Physical edit')
    collections, parents = graph_collections(graph), graph_parents(graph)
    before = _index(graph)
    candidate = deepcopy(graph)
    candidate['revision'] += 1
    after = _index(candidate)
    if op == 'create':
        kind = _kind(command['kind'], collections)
        keys = {'id', 'fields', 'evidence', 'uncertainty'}
        if kind in parents:
            keys.add(parents[kind][1])
        if kind == 'service':
            keys.add('quantity')
        optional = {'copied_from'} | ({'marker'} if kind == 'barrier' and graph['version'] in (2, 3) else {'annotation'} if kind == 'defect' and graph['version'] == 2 else set())
        source = _object(command['entity'], keys | optional, keys, 'New physical entity')
        identifier = _id(source['id'])
        if kind in parents:
            _id(source[parents[kind][1]], 'Physical parent ID')
        _properties(source, kind, parents)
        if 'copied_from' in source:
            original = before.get(source['copied_from']['entity_id'])
            if not original or original[0] != kind or original[1]['revision'] != source['copied_from']['revision'] or original[1]['deleted']:
                raise ValidationError('A copied record requires its current active source of the same kind.')
        entity = deepcopy(source)
        if identifier in before:
            raise ValidationError('A physical ID cannot be reused, including a deleted ID.')
        entity.update(revision=1, deleted=False, deleted_at_revision=None)
        if graph['version'] in (2, 3):
            ordinal = max((_display_number(entry['display_id'], kind)
                           for entry in candidate[collections[kind]]), default=0) + 1
            entity['display_id'] = f'{_DISPLAY_PREFIXES[kind]}-{ordinal:04d}'
        candidate[collections[kind]].append(entity)
        affected, descendants = {identifier}, set()
    else:
        identifier = _id(command['entity_id'])
        if identifier not in after:
            raise ValidationError('The physical entity does not exist.')
        kind, entity = after[identifier]
        descendants = _descendants(before, identifier, parents)
        affected = {identifier}
        if op != 'restore' and entity['deleted']:
            raise ValidationError('Restore a deleted physical entity before editing it.')
        if op == 'update':
            allowed = {'fields', 'evidence', 'uncertainty'} | ({'quantity'} if kind == 'service' else set())
            if kind == 'barrier' and graph['version'] in (2, 3):
                allowed.add('marker')
            if kind == 'defect' and graph['version'] == 2:
                allowed.add('annotation')
            changes = _object(command['changes'], allowed, (), 'Physical property changes')
            if not changes:
                raise ValidationError('A physical update requires explicit changes.')
            _properties({**entity, **changes}, kind, parents)
            for key, value in changes.items():
                # A supplied fields object replaces the typed field set. This
                # makes clearing an unknown field explicit and lossless.
                entity[key] = deepcopy(value)
        elif op == 'reparent':
            if kind not in parents:
                raise ValidationError(f'A {kind} has no physical parent to change.')
            entity[parents[kind][1]] = _id(command['parent_id'], 'New physical parent ID')
            affected |= descendants
        elif op == 'delete':
            if type(command['cascade']) is not bool:
                raise ValidationError('Descendant deletion must be an explicit boolean choice.')
            active = {child for child in descendants if not after[child][1]['deleted']}
            if active and not command['cascade']:
                raise ValidationError('Deletion has active descendants; explicitly preview a cascade or reparent them first.')
            affected |= active
            for child in affected:
                after[child][1].update(deleted=True, deleted_at_revision=candidate['revision'])
        else:
            if not entity['deleted']:
                raise ValidationError('Only a deleted physical entity can be restored.')
            mode = command['mode']
            if not isinstance(mode, str) or mode not in ('leaf', 'same_deletion', 'selected'):
                raise ValidationError('Restore mode must be leaf, same_deletion or selected.')
            if mode != 'selected' and 'entity_ids' in command:
                raise ValidationError('Explicit restore IDs require selected mode.')
            if mode == 'same_deletion':
                affected |= {child for child in descendants if after[child][1]['deleted']
                             and after[child][1]['deleted_at_revision'] == entity['deleted_at_revision']}
            elif mode == 'selected':
                selected = command.get('entity_ids')
                if not isinstance(selected, list) or not 1 <= len(selected) <= MAX_ENTITIES:
                    raise ValidationError('Selected restoration requires a bounded explicit ID list.')
                for child in selected:
                    _id(child, 'Restore ID')
                affected = set(selected)
                if len(affected) != len(selected) or identifier not in affected or affected - (descendants | {identifier}):
                    raise ValidationError('Restore IDs must be distinct and contain the target and only its descendants.')
            if any(not after[child][1]['deleted'] for child in affected):
                raise ValidationError('Every explicitly restored entity must currently be deleted.')
            for child in affected:
                after[child][1].update(deleted=False, deleted_at_revision=None)
    # Validate proposed values before serialization or revision comparisons.
    # Existing entity revisions can only rise by one with this graph revision.
    validate_graph(candidate, copy_result=False)
    after = _index(candidate)
    changed = {identifier for identifier, (_, entity) in after.items()
               if identifier not in before or _digest(entity) != _digest(before[identifier][1])}
    if not changed:
        raise ValidationError('This physical edit does not change the graph.')
    for identifier in changed & before.keys():
        after[identifier][1]['revision'] += 1
    return candidate, affected, descendants, changed


def _preview(graph, command):
    candidate, affected, descendants, changed = _command(graph, command)
    before, after = _index(graph), _index(candidate)
    parents = graph_parents(graph)
    relationships = []
    for identifier in sorted(affected | descendants):
        kind, entity = after[identifier]
        old = before.get(identifier)
        relationships.append({'id': identifier, 'kind': kind,
            'parent_before': _parent(*old, parents) if old else None,
            'parent_after': _parent(kind, entity, parents),
            'deleted_before': old[1]['deleted'] if old else None,
            'deleted_after': entity['deleted']})
        if graph['version'] in (2, 3):
            relationships[-1]['display_id'] = entity['display_id']
    preview = {'version': 1, 'graph_id': graph['id'], 'project_id': graph['project_id'],
        'base_revision': graph['revision'], 'base_digest': _digest(graph),
        'command': deepcopy(command), 'affected_ids': sorted(affected),
        'changed_ids': sorted(changed), 'descendant_ids': sorted(descendants),
        'preserved_ids': sorted(affected & before.keys()), 'relationships': relationships,
        'result_revision': candidate['revision'], 'result_digest': _digest(candidate),
        'state': 'draft', 'authority': 'none'}
    preview['preview_digest'] = _digest(preview)
    return preview, candidate


def preview_change(graph, command):
    """Show exact affected IDs and parent/tombstone transitions without editing."""
    validate_graph(graph, copy_result=False)
    return _preview(graph, command)[0]


def apply_change(graph, command, *, expected_revision, preview_digest):
    """Apply exactly the previewed mutation to a detached draft graph.

    Every operation requires a current revision and preview, including creation.
    Descendant deletion is explicit. A same_deletion restore only restores the
    original deletion batch, never an older tombstone beneath that subtree.
    """
    validate_graph(graph, copy_result=False)
    _number(expected_revision, 'Expected physical revision', minimum=0, integer=True)
    if expected_revision != graph['revision']:
        raise ValidationError('The physical graph changed; review a fresh preview.')
    _hash(preview_digest, 'Physical preview digest')
    preview, candidate = _preview(graph, command)
    if preview_digest != preview['preview_digest']:
        raise ValidationError('The physical edit or its evidence changed; review a fresh preview.')
    return {'graph': candidate, 'change': preview}
