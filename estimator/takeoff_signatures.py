"""Bounded private vector signatures, without measurement or review authority."""
from copy import deepcopy
import math
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_model import identity, number, object_fields, page_metadata, points, validate_appearance

MAX_SIGNATURES_AND_CALLOUTS = 1000
MAX_STROKES = 100
MAX_STROKE_POINTS = 4000
SIGNATURE_MODES = ('steel', 'duct', 'wall', 'slab', 'defect_reports', 'service_plans')
APPEARANCE_FIELDS = {'stroke_color', 'stroke_width', 'opacity'}
DEFAULT_APPEARANCE = {'stroke_color': '#000000', 'stroke_width': 2, 'opacity': 1}
SIGNATURE_FIELDS = {'id', 'version', 'mode', 'document_id', 'source_sha256', 'page',
                    'quad_pdf', 'strokes', 'appearance'}
EDIT_FIELDS = {'quad_pdf', 'strokes', 'appearance'}


def signature_appearance(value):
    object_fields(value, APPEARANCE_FIELDS, 'Signature appearance')
    return {**DEFAULT_APPEARANCE, **validate_appearance(value)}


def validate_strokes(value):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_STROKES:
        raise ValidationError(f'A signature requires one to {MAX_STROKES} vector strokes.')
    total = 0
    for stroke in value:
        if not isinstance(stroke, list) or not stroke:
            raise ValidationError('Each signature stroke requires at least one normalized point.')
        total += len(stroke)
        if total > MAX_STROKE_POINTS:
            raise ValidationError(f'A signature supports at most {MAX_STROKE_POINTS} vector points.')
        for point in stroke:
            if not isinstance(point, list) or len(point) != 2:
                raise ValidationError('Each signature point requires normalized x and y.')
            for coordinate in point:
                number(coordinate, 'Signature normalized coordinate')
                if not 0 <= coordinate <= 1:
                    raise ValidationError('Signature normalized coordinates must be between zero and one.')
    return value


def validate_quad(value, page):
    quad = points(value, 'Signature placement', page, minimum=4, maximum=4)
    q0, q1, q2, q3 = quad
    horizontal = [q1[axis] - q0[axis] for axis in (0, 1)]
    vertical = [q3[axis] - q0[axis] for axis in (0, 1)]
    width, height = math.hypot(*horizontal), math.hypot(*vertical)
    if not 10 <= width <= 10000 or not 10 <= height <= 10000:
        raise ValidationError('Signature edges must be between 10 and 10,000 original PDF points.')
    if any(not math.isclose(q2[axis], q1[axis] + q3[axis] - q0[axis],
                            rel_tol=1e-9, abs_tol=1e-7) for axis in (0, 1)):
        raise ValidationError('Signature placement must be an affine rectangle in original PDF coordinates.')
    if abs(math.fsum(horizontal[axis] * vertical[axis] for axis in (0, 1))) > width * height * 1e-8:
        raise ValidationError('Signature placement edges must be perpendicular.')
    return value


def validate_signature(value, snapshot):
    object_fields(value, SIGNATURE_FIELDS, 'Signature', SIGNATURE_FIELDS)
    identity(value['id'], 'Signature ID')
    number(value['version'], 'Signature version', positive=True, integer=True)
    if value['mode'] not in SIGNATURE_MODES:
        raise ValidationError('Choose a supported drawing workspace for the signature.')
    document, page = page_metadata(snapshot, value['document_id'], value['page'])
    if value['source_sha256'] != document['sha256']:
        raise ValidationError('A signature must identify its exact retained source PDF.')
    validate_quad(value['quad_pdf'], page)
    validate_strokes(value['strokes'])
    object_fields(value['appearance'], APPEARANCE_FIELDS, 'Stored signature appearance', APPEARANCE_FIELDS)
    signature_appearance(value['appearance'])
    return value


def validate_signatures(snapshot):
    if 'signatures' not in snapshot:
        return
    collection = object_fields(snapshot['signatures'], {'version', 'records'},
                               'Signature collection', {'version', 'records'})
    if type(collection['version']) is not int or collection['version'] != 1:
        raise ValidationError('This signature collection version is not supported.')
    records = collection['records']
    callouts = snapshot.get('annotations', {}).get('callouts', [])
    if not isinstance(records, list) or len(records) + len(callouts) > MAX_SIGNATURES_AND_CALLOUTS:
        raise ValidationError(f'A project supports at most {MAX_SIGNATURES_AND_CALLOUTS} signatures and free call-outs combined.')
    seen = {value['id'] for key in ('items', 'documents', 'calibrations', 'transfers')
            for value in snapshot.get(key, [])}
    seen.update(value['id'] for value in callouts)
    for key in ('physical', 'service_plans'):
        graph = snapshot.get(key)
        if graph:
            from .takeoff_physical import graph_collections
            seen.add(graph['id'])
            seen.update(entity['id'] for name in graph_collections(graph).values() for entity in graph[name])
    for record in records:
        validate_signature(record, snapshot)
        if record['id'] in seen:
            raise ValidationError('Signature IDs must be unique and separate from drawing or register records.')
        seen.add(record['id'])


def apply_signature(snapshot, request):
    """Edit this optional collection through the ordinary audited revision path."""
    op = request['op']
    if op == 'create_signature':
        proposal = object_fields(request['signature'], SIGNATURE_FIELDS - {'id', 'version'},
                                 'New signature', SIGNATURE_FIELDS - {'id', 'version'})
        record = {'id': str(uuid4()), 'version': 1, **deepcopy(proposal)}
        record['appearance'] = signature_appearance(record['appearance'])
        validate_signature(record, snapshot)
        if (len(snapshot.get('signatures', {}).get('records', []))
                + len(snapshot.get('annotations', {}).get('callouts', [])) >= MAX_SIGNATURES_AND_CALLOUTS):
            raise ValidationError(f'A project supports at most {MAX_SIGNATURES_AND_CALLOUTS} signatures and free call-outs combined.')
        snapshot.setdefault('signatures', {'version': 1, 'records': []})['records'].append(record)
        return record['id']
    identifier = identity(request['signature_id'], 'Signature ID')
    records = snapshot.get('signatures', {}).get('records', [])
    record = next((value for value in records if value['id'] == identifier), None)
    if record is None:
        raise ValidationError('The selected signature no longer exists.')
    if op == 'delete_signature':
        records.remove(record)
    else:
        changes = object_fields(request['changes'], EDIT_FIELDS, 'Signature edit')
        if not changes:
            raise ValidationError('Choose a signature property to edit.')
        for key, value in changes.items():
            record[key] = ({**record['appearance'], **deepcopy(value)}
                           if key == 'appearance' and isinstance(value, dict) else deepcopy(value))
        record['version'] += 1
        validate_signature(record, snapshot)
    return None


def undo_signatures(before, restored):
    originals = {record['id']: record for record in before.get('signatures', {}).get('records', [])}
    for record in restored.get('signatures', {}).get('records', []):
        previous = originals.get(record['id'])
        if previous != record:
            record['version'] = max(record['version'], previous['version'] if previous else 0) + 1


def signature_binding(record):
    return (record['mode'], record['document_id'], record['source_sha256'], record['page'])


def validate_history(event):
    old = {record['id']: record for record in event['before'].get('signatures', {}).get('records', [])}
    new = {record['id']: record for record in event['after'].get('signatures', {}).get('records', [])}
    if event['before']['revision'] == 0 and old:
        raise ValidationError('The initial audit state cannot contain unrecorded signatures.')
    controlled = ('create_signature', 'update_signature', 'delete_signature')
    if event['op'] in controlled:
        projection = lambda state: {key: value for key, value in state.items() if key not in ('signatures', 'revision')}
        if projection(event['before']) != projection(event['after']):
            raise ValidationError('A signature operation cannot change measurements, physical records, source state or transfers.')
    if old != new and event['op'] not in (*controlled, 'undo'):
        raise ValidationError('Signatures changed outside a controlled signature operation.')
    added, removed = new.keys() - old.keys(), old.keys() - new.keys()
    changed = {identifier for identifier in old.keys() & new.keys() if old[identifier] != new[identifier]}
    if added and event['op'] not in ('create_signature', 'undo'):
        raise ValidationError('Signature identities may only be created or restored by Undo.')
    if event['op'] == 'create_signature' and (len(added) != 1 or removed or changed
            or any(new[identifier]['version'] != 1 for identifier in added)):
        raise ValidationError('A signature must begin with one new identity and version one.')
    if event['op'] == 'update_signature' and (added or removed or len(changed) != 1):
        raise ValidationError('A signature edit must update exactly one retained identity.')
    if event['op'] == 'delete_signature' and (added or changed or len(removed) != 1):
        raise ValidationError('A signature deletion must remove exactly one retained identity.')
    for identifier in old.keys() & new.keys():
        if signature_binding(old[identifier]) != signature_binding(new[identifier]):
            raise ValidationError('A signature source identity cannot be rewritten in audit history.')
        if old[identifier] != new[identifier] and new[identifier]['version'] <= old[identifier]['version']:
            raise ValidationError('Edited signatures require a fresh increasing version.')
    return {identifier: signature_binding(record) for identifier, record in {**old, **new}.items()}


def export_signatures(snapshot, request, document_id, modes):
    """Select visual records only, without adding register rows or approvals."""
    active = {record['id']: record for record in snapshot.get('signatures', {}).get('records', [])
              if record['mode'] in modes and record['document_id'] == document_id}
    identifiers = request.get('signature_ids', list(active))
    if (not isinstance(identifiers, list) or len(identifiers) > MAX_SIGNATURES_AND_CALLOUTS
            or any(not isinstance(identifier, str) for identifier in identifiers)
            or len(identifiers) != len(set(identifiers)) or set(identifiers) - active.keys()):
        raise ValidationError('Export signature IDs must identify distinct signatures in the current workspace and exact source PDF.')
    return [active[identifier] for identifier in identifiers]
