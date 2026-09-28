"""Bounded, values-only takeoff records and deterministic measurement rules.

PDF points are unrotated PDF user-space coordinates. Calibration converts these
stored units directly to metres; PDF UserUnit is a rendering concern, not an
additional multiplier. Source/calculator formulas remain outside this model.
"""

from copy import deepcopy
from hashlib import sha256
import json
import math
import re
from uuid import UUID, uuid4

from .catalog import ValidationError
from .takeoff_area import AREA_MODES, measured_area, validate_polygon

MAX_ITEMS = 10000
MAX_POINTS = 10000
MODES = ('steel', 'duct', *AREA_MODES)
FIELDS = frozenset(('mark', 'level', 'zone', 'group', 'member_type', 'section',
    'product', 'critical_temperature', 'fire_period_min', 'exposure', 'sides',
    'frl', 'shape', 'width_mm', 'height_mm', 'diameter_mm', 'system', 'orientation',
    'wall_penetrations', 'floor_penetrations', 'notes', 'input_method', 'factor',
    'girth_override_m', 'area_override_m2', 'family', 'waste_fraction',
    'exposure_layout', 'partial_depth_mm', 'layer_preference', 'thickness_lookup',
    'installation_detail', 'depth_mm', 'steel_area_cm2', 'steel_mass_kg_m',
    'added_girth_m', 'design_reference', 'classification', 'riser', 'substrate',
    'treatment', 'surface_basis', 'surface_citation'))
NUMERIC_FIELDS = frozenset(('critical_temperature', 'fire_period_min', 'sides',
    'width_mm', 'height_mm', 'diameter_mm', 'wall_penetrations', 'floor_penetrations',
    'factor', 'girth_override_m', 'area_override_m2', 'waste_fraction',
    'partial_depth_mm', 'depth_mm', 'steel_area_cm2', 'steel_mass_kg_m', 'added_girth_m'))
COMMON_EVIDENCE_FIELDS = frozenset(('mark', 'level', 'zone', 'group', 'notes', 'product',
                                    'exposure', 'system', 'classification', 'quantity', 'length_m'))
EVIDENCE_FIELDS = {
    'steel': COMMON_EVIDENCE_FIELDS | frozenset(('member_type', 'section', 'critical_temperature',
        'fire_period_min', 'sides', 'input_method', 'factor', 'girth_override_m', 'area_override_m2',
        'family', 'waste_fraction', 'exposure_layout', 'partial_depth_mm', 'layer_preference',
        'thickness_lookup', 'installation_detail', 'depth_mm', 'width_mm', 'steel_area_cm2',
        'steel_mass_kg_m', 'added_girth_m', 'design_reference')),
    'duct': COMMON_EVIDENCE_FIELDS | frozenset(('shape', 'width_mm', 'height_mm', 'diameter_mm',
        'frl', 'orientation', 'wall_penetrations', 'floor_penetrations', 'riser')),
}
for _mode in AREA_MODES:
    EVIDENCE_FIELDS[_mode] = frozenset(('mark', 'level', 'zone', 'group', 'notes', 'product',
        'system', 'classification', 'quantity', 'frl', 'substrate', 'treatment',
        'surface_basis', 'surface_citation', 'gross_area_m2', 'excluded_area_m2', 'net_area_m2'))
HASH = re.compile(r'^[0-9a-f]{64}$')


def digest(value):
    def canonical(entry):
        # JavaScript has one numeric type and emits 10.0 as 10. Equal finite
        # numbers must retain identity across JSON/browser/Python round trips.
        if type(entry) is float and math.isfinite(entry) and entry.is_integer():
            return int(entry)
        if isinstance(entry, dict):
            return {key: canonical(child) for key, child in entry.items()}
        if isinstance(entry, list):
            return [canonical(child) for child in entry]
        return entry
    try:
        return sha256(json.dumps(canonical(value), sort_keys=True, ensure_ascii=False,
                                 separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    except (ValueError, TypeError, RecursionError) as error:
        raise ValidationError('Takeoff data must contain finite JSON values.') from error


def audit_state_digest(snapshot):
    """Bind physical/history state independently of machine-local authority.

Reopening on another computer can remove local approval badges or mark a
transfer conflicted, without changing the retained physical/evidence state.
Those derived authority annotations and the portability path are excluded.
"""
    # Only these shallow containers change. digest() reads nested source/page
    # data without mutating it, so copying every retained PDF tree here would
    # repeat that work twice for every historical state during audit checks.
    body = {key: value for key, value in snapshot.items() if key not in ('audit_head', 'companion_folder')}
    body['items'] = [{key: value for key, value in item.items() if key not in ('state', 'review', 'confirmation')}
                     for item in body.get('items', [])]
    body['transfers'] = [{key: value for key, value in binding.items() if key != 'status'} for binding in body.get('transfers', [])]
    return digest(body)


def audit_affected(before, after):
    """Deterministic changed identities, including source-render observations."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValidationError('Audit state must contain structured before and after snapshots.')
    def entries(state, name, limit, *, render=False):
        values = state.get(name, [])
        if not isinstance(values, list) or len(values) > limit:
            raise ValidationError('Audit affected identities require bounded state collections.')
        result = {}
        for value in values:
            if not isinstance(value, dict):
                raise ValidationError('Audit affected identities require structured collection entries.')
            identifier = identity(value.get('document_id' if render else 'id'), 'Affected source ID' if render else 'Affected ID')
            if render:
                number(value.get('page'), 'Affected source page', positive=True, integer=True)
            key = (identifier, value['page']) if render else identifier
            if key in result:
                raise ValidationError('Audit affected identities cannot contain duplicate state entries.')
            result[key] = digest(value)
        return result
    def changed(left, right):
        return {key for key in left.keys() | right.keys() if left.get(key) != right.get(key)}
    affected = {}
    for key, limit in (('items', MAX_ITEMS), ('documents', 100), ('calibrations', 2000), ('transfers', MAX_ITEMS * 3)):
        affected[key] = sorted(changed(entries(before, key, limit), entries(after, key, limit)))
    renders = changed(entries(before, 'render_checks', 2000, render=True), entries(after, 'render_checks', 2000, render=True))
    affected['documents'] = sorted(set(affected['documents']) | {document for document, _ in renders})
    return affected


def identity(value, label='ID'):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValidationError(f'{label} must be a canonical UUID.') from None
    return value


def number(value, label, *, positive=False, integer=False):
    if (type(value) not in (int, float) or abs(value) > 1e12 or not math.isfinite(value)
            or (positive and value <= 0)
            or (integer and (type(value) is not int))):
        raise ValidationError(f'{label} must be a finite {"positive " if positive else ""}{"integer" if integer else "number"}.')
    return value


def text(value, label, limit=2000):
    if (not isinstance(value, str) or len(value) > limit
            or any(ord(c) < 32 and c not in '\n\r\t' for c in value)
            or any(0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise ValidationError(f'{label} must be text of at most {limit} characters.')
    return value


def object_fields(value, allowed, label, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        raise ValidationError(f'{label} contains missing or unsupported fields.')
    return value


def new_snapshot():
    return {'version': 1, 'project_id': str(uuid4()), 'revision': 0, 'documents': [],
            'calibrations': [], 'items': [], 'transfers': [], 'render_checks': [], 'audit_head': None}


def page_metadata(snapshot, document_id, page):
    identity(document_id, 'Document ID')
    number(page, 'Page', positive=True, integer=True)
    document = next((d for d in snapshot['documents'] if d['id'] == document_id), None)
    metadata = next((p for p in document['pages'] if p['page'] == page), None) if document else None
    if metadata is None:
        raise ValidationError('The referenced source document/page does not exist.')
    return document, metadata


def points(value, label, page, minimum=1, maximum=MAX_POINTS):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValidationError(f'{label} requires {minimum} to {maximum} coordinate pairs.')
    x0, y0, x1, y1 = page['view']
    result = []
    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            raise ValidationError('Each PDF point must contain x and y.')
        x, y = number(point[0], 'PDF x'), number(point[1], 'PDF y')
        if not x0 <= x <= x1 or not y0 <= y <= y1:
            raise ValidationError('A markup point lies outside the source page bounds.')
        result.append([x, y])
    return result


def polyline_length(value):
    segments = [math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(value, value[1:])]
    if not segments or any(v <= 0 for v in segments):
        raise ValidationError('A measured line needs distinct points and nonzero segments.')
    return math.fsum(segments)


def validate_calibration(value, snapshot, *, copy_result=True):
    object_fields(value, {'id', 'document_id', 'page', 'name', 'points', 'distance_m', 'uniform_scale'}, 'Calibration',
                  {'id', 'document_id', 'page', 'points', 'distance_m', 'uniform_scale'})
    identity(value['id'], 'Calibration ID')
    _, page = page_metadata(snapshot, value['document_id'], value['page'])
    points(value['points'], 'Calibration', page, 2, 2)
    polyline_length(value['points'])
    number(value['distance_m'], 'Known distance in metres', positive=True)
    if value['uniform_scale'] is not True:
        raise ValidationError('Confirm that this region has a uniform, undistorted scale before calibration.')
    text(value.get('name', ''), 'Calibration name', 200)
    return deepcopy(value) if copy_result else value


def validate_item(value, snapshot, *, copy_result=True):
    object_fields(value, {'id', 'version', 'mode', 'state', 'geometry', 'measurement', 'quantity', 'fields',
                        'evidence', 'review', 'confirmation', 'predecessor_ids', 'member_ids'}, 'Takeoff item',
                  {'id', 'version', 'mode', 'state', 'geometry', 'measurement', 'quantity', 'fields', 'evidence', 'review', 'confirmation', 'member_ids'})
    identity(value['id'], 'Item ID')
    number(value['version'], 'Item version', positive=True, integer=True)
    if value['mode'] not in MODES or value['state'] not in ('draft', 'reviewed', 'confirmed'):
        raise ValidationError('Choose a supported takeoff mode and review state.')
    if value['quantity'] is not None:
        number(value['quantity'], 'Physical quantity', positive=True, integer=True)
    if value['mode'] in AREA_MODES and value['quantity'] != 1:
        raise ValidationError('Each wall or slab item represents exactly one traced treatment surface, with quantity 1.')
    members = value['member_ids']
    if (not isinstance(members, list) or len(members) != (value['quantity'] or 0)
            or len(members) > MAX_ITEMS or any(not isinstance(i, str) for i in members)
            or len(set(members)) != len(members)):
        raise ValidationError('Each explicit physical member must retain a distinct persistent member ID.')
    for member in members:
        identity(member, 'Physical member ID')
    object_fields(value['fields'], FIELDS, 'Takeoff fields')
    for key, field in value['fields'].items():
        if field is None:
            continue
        if key in NUMERIC_FIELDS:
            number(field, key)
        elif key == 'riser':
            if type(field) is not bool:
                raise ValidationError('Riser must be true or false.')
        else:
            text(field, key)
    geometry = value['geometry']
    if geometry is not None:
        if not isinstance(geometry, dict) or not {'document_id', 'page'} <= geometry.keys():
            raise ValidationError('Markup geometry requires its source document and page.')
        _, page = page_metadata(snapshot, geometry['document_id'], geometry['page'])
        if value['mode'] in AREA_MODES:
            validate_polygon(geometry, page)
        else:
            object_fields(geometry, {'document_id', 'page', 'points'}, 'Markup geometry', {'document_id', 'page', 'points'})
            points(geometry['points'], 'Markup', page)
    measurement = value['measurement']
    if measurement is not None:
        if not isinstance(measurement, dict):
            raise ValidationError('Measurement must be a structured object.')
        if measurement.get('method') == 'calibrated':
            object_fields(measurement, {'method', 'calibration_id'}, 'Calibrated measurement', {'method', 'calibration_id'})
            identity(measurement['calibration_id'], 'Calibration ID')
            calibration = next((c for c in snapshot['calibrations'] if c['id'] == measurement['calibration_id']), None)
            if calibration is None or geometry is None or (calibration['document_id'], calibration['page']) != (geometry['document_id'], geometry['page']):
                raise ValidationError('A calibrated measurement must use a calibration on its own source page.')
        elif measurement.get('method') == 'cited':
            if value['mode'] in AREA_MODES:
                raise ValidationError('Surface polygons require calibrated area; a cited length cannot determine surface area.')
            object_fields(measurement, {'method', 'length_m', 'citation'}, 'Cited measurement', {'method', 'length_m', 'citation'})
            number(measurement['length_m'], 'Cited length', positive=True)
            text(measurement['citation'], 'Dimension citation')
        else:
            raise ValidationError('Choose calibrated or source-cited measurement.')
    if not isinstance(value['evidence'], list) or len(value['evidence']) > 100:
        raise ValidationError('An item may retain up to 100 evidence references.')
    for reference in value['evidence']:
        object_fields(reference, {'document_id', 'page', 'region', 'note', 'fields'}, 'Evidence reference', {'document_id', 'page'})
        _, page = page_metadata(snapshot, reference['document_id'], reference['page'])
        text(reference.get('note', ''), 'Evidence note')
        supported_fields = reference.get('fields', [])
        if (not isinstance(supported_fields, list) or len(supported_fields) > 32
                or any(not isinstance(field, str) or field not in EVIDENCE_FIELDS[value['mode']] for field in supported_fields)
                or len(set(supported_fields)) != len(supported_fields)):
            raise ValidationError('Evidence fields must name up to 32 distinct supported fields for this takeoff mode.')
        if 'region' in reference:
            region = reference['region']
            if not isinstance(region, list) or len(region) != 4:
                raise ValidationError('An evidence region requires x, y, width and height.')
            x, y, w, h = [number(v, 'Evidence region') for v in region]
            if w <= 0 or h <= 0:
                raise ValidationError('An evidence region must have positive dimensions.')
            points([[x, y], [x+w, y+h]], 'Evidence region', page, 2, 2)
    predecessors = value.get('predecessor_ids', [])
    if not isinstance(predecessors, list) or len(predecessors) > MAX_ITEMS or any(not isinstance(i, str) for i in predecessors) or len(set(predecessors)) != len(predecessors):
        raise ValidationError('Predecessor IDs must be unique.')
    for predecessor in predecessors:
        identity(predecessor, 'Predecessor ID')
        if predecessor == value['id']:
            raise ValidationError('An item cannot be its own predecessor.')
    for key in ('review', 'confirmation'):
        receipt = value[key]
        if receipt is not None:
            object_fields(receipt, {'digest', 'at', 'id', 'actor', 'checks'}, key, {'digest', 'at', 'id'})
            if not isinstance(receipt['digest'], str) or not HASH.fullmatch(receipt['digest']):
                raise ValidationError('A review receipt requires a SHA-256 digest.')
            identity(receipt['id'], 'Receipt ID')
            text(receipt['at'], 'Receipt timestamp', 100)
            if 'actor' in receipt or 'checks' in receipt:
                actor = object_fields(receipt.get('actor'), {'kind', 'session_id'}, 'Receipt actor', {'kind', 'session_id'})
                if actor['kind'] != 'local-session':
                    raise ValidationError('Receipt actor must identify its local review session.')
                identity(actor['session_id'], 'Receipt actor session ID')
                area = value['mode'] in AREA_MODES
                measurement_fields = ('gross_area_m2', 'excluded_area_m2', 'net_area_m2') if area else ('length_m', 'total_length_m')
                fields = {'engine', 'quantity', *measurement_fields, 'evidence_verified', 'issues'}
                checks = object_fields(receipt.get('checks'), fields, 'Receipt checks', fields)
                if checks['engine'] != ('takeoffs-area-v1' if area else 'takeoffs-v1') or checks['evidence_verified'] is not True:
                    raise ValidationError('Receipt checks must identify verified takeoff evidence and the check engine.')
                for field in ('quantity',) if area else ('quantity', 'length_m'):
                    if checks[field] is not None:
                        number(checks[field], 'Receipt '+field, positive=True, integer=field == 'quantity')
                if area and checks['quantity'] != 1:
                    raise ValidationError('Area receipt quantity must identify one treatment surface.')
                for field in measurement_fields if area else ('total_length_m',):
                    total = checks[field]
                    if total is not None and (type(total) not in (int, float) or not 0 <= total <= 1e16 or not math.isfinite(total)
                                              or total == 0 and field != 'excluded_area_m2'):
                        raise ValidationError('Receipt measurements must be bounded positive values; excluded area may be zero.')
                if area and all(checks[field] is not None for field in measurement_fields):
                    if checks['net_area_m2'] != checks['gross_area_m2'] - checks['excluded_area_m2']:
                        raise ValidationError('Area receipt net area must exactly equal gross area less exclusions.')
                if not isinstance(checks['issues'], list) or len(checks['issues']) > 256:
                    raise ValidationError('Receipt checks require a bounded issue list.')
                for issue in checks['issues']:
                    object_fields(issue, {'item_id', 'code', 'message'}, 'Receipt issue', {'item_id', 'code', 'message'})
                    if issue['item_id'] != value['id']:
                        raise ValidationError('Receipt issues must identify their own item.')
                    text(issue['code'], 'Receipt issue code', 100)
                    text(issue['message'], 'Receipt issue message')
                if key == 'confirmation' and (checks['issues'] or any(checks[field] is None for field in ('quantity', *measurement_fields))):
                    raise ValidationError('Confirmation requires complete deterministic checks with no unresolved issues.')
    if value['state'] in ('reviewed', 'confirmed') and value['review'] is None:
        raise ValidationError('Reviewed items must retain a review receipt.')
    if value['state'] == 'confirmed' and value['confirmation'] is None:
        raise ValidationError('Confirmed items must retain a confirmation receipt.')
    return deepcopy(value) if copy_result else value


def item_digest(item, snapshot):
    body = {k: v for k, v in item.items() if k not in ('state', 'review', 'confirmation')}
    references = item['evidence'] + ([item['geometry']] if item['geometry'] else [])
    documents = {r['document_id'] for r in references}
    body['source_documents'] = [{k: d[k] for k in ('id', 'sha256', 'size', 'pages')}
                                for d in snapshot['documents'] if d['id'] in documents]
    measurement = item['measurement']
    body['calibration'] = next((c for c in snapshot['calibrations'] if measurement and
        measurement.get('calibration_id') == c['id']), None)
    return digest(body)


def measured_length(item, snapshot):
    if item['mode'] in AREA_MODES:
        raise ValidationError('Wall and slab surfaces have area measurements, not transferable linear lengths.')
    measurement = item['measurement']
    if not measurement:
        raise ValidationError('Choose a calibrated or source-cited length.')
    if measurement['method'] == 'cited':
        if not measurement['citation'].strip():
            raise ValidationError('Cited length requires a source dimension reference.')
        return measurement['length_m']
    calibration = next(c for c in snapshot['calibrations'] if c['id'] == measurement['calibration_id'])
    return polyline_length(item['geometry']['points']) * calibration['distance_m'] / polyline_length(calibration['points'])


def item_result(item, snapshot):
    issues = []
    def add(code, message):
        issues.append({'item_id': item['id'], 'code': code, 'message': message})
    length = None
    area = {key: None for key in ('gross_area_m2', 'excluded_area_m2', 'net_area_m2')}
    try:
        if item['mode'] in AREA_MODES:
            area = measured_area(item, snapshot)
        else:
            length = measured_length(item, snapshot)
            number(length, 'Measured length', positive=True)
    except (ValidationError, StopIteration, TypeError) as error:
        add('MISSING_MEASUREMENT', str(error) or 'The measurement is incomplete.')
    if item['quantity'] is None:
        add('MISSING_QUANTITY', 'Enter an explicit positive physical quantity.')
    if not item['geometry']:
        add('MISSING_GEOMETRY', 'Mark the item on its source page.')
    refs = item['evidence'] + ([item['geometry']] if item['geometry'] else [])
    if not refs:
        add('MISSING_EVIDENCE', 'Link retained source evidence.')
    for ref in refs:
        doc, _ = page_metadata(snapshot, ref['document_id'], ref['page'])
        render = next((r for r in snapshot['render_checks'] if r['document_id'] == doc['id'] and r['page'] == ref['page']), None)
        if not render or render['sha256'] != doc['sha256'] or not render['success'] or render['warnings']:
            add('PAGE_REVIEW_BLOCKED', 'Render and visually inspect every supporting page without unresolved rendering warnings.')
    fields = item['fields']
    required = (('mark', 'treatment', 'substrate', 'frl', 'surface_basis', 'surface_citation') if item['mode'] in AREA_MODES
                else ('section', 'member_type', 'exposure', 'fire_period_min') if item['mode'] == 'steel'
                else ('shape', 'frl', 'orientation'))
    for name in required:
        if fields.get(name) in (None, '') or item['mode'] in AREA_MODES and isinstance(fields.get(name), str) and not fields[name].strip():
            add('MISSING_FIELD', f'Enter {name.replace("_", " ")}.')
    if item['mode'] in AREA_MODES:
        bases = ('wall-face',) if item['mode'] == 'wall' else ('slab-soffit', 'slab-top')
        if fields.get('surface_basis') not in bases:
            add('INVALID_SURFACE_BASIS', 'Identify the actual treated surface. A wall footprint is not a wall-face area.')
    if item['mode'] == 'steel' and fields.get('fire_period_min') is not None and fields['fire_period_min'] <= 0:
        add('INVALID_FRL', 'Fire period must be positive.')
    if item['mode'] == 'duct':
        shape = fields.get('shape')
        if shape not in ('rectangular', 'circular'):
            add('INVALID_SHAPE', 'Choose rectangular or circular duct.')
        dimensions = ('diameter_mm',) if shape == 'circular' else ('width_mm', 'height_mm')
        for name in dimensions:
            if fields.get(name) is None or fields[name] <= 0:
                add('MISSING_DIMENSION', f'Enter a positive {name.replace("_", " ")}.')
    if item['mode'] == 'duct' or item['mode'] in AREA_MODES:
        rating = fields.get('frl')
        if rating and (not re.fullmatch(r'(?:-|\d{1,4})/(?:-|\d{1,4})/(?:-|\d{1,4})', rating)
                       or not any(component != '-' and int(component) > 0 for component in rating.split('/'))):
            add('INVALID_FRL', 'FRL must retain its three explicit fire-rating components.')
    if item['mode'] in AREA_MODES:
        return {'id': item['id'], **area, 'issues': issues}
    return {'id': item['id'], 'length_m': length,
            'total_length_m': length * item['quantity'] if length is not None and item['quantity'] is not None else None,
            'issues': issues}


def validate_snapshot(value, *, copy_result=True):
    """Pure validation for portable files; never trusts imported approvals."""
    keys = new_snapshot().keys()
    object_fields(value, {*keys, 'companion_folder'}, 'Takeoff snapshot', keys)
    if 'companion_folder' in value:
        text(value['companion_folder'], 'Evidence companion folder', 255)
    if type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('This takeoff schema version is not supported.')
    identity(value['project_id'], 'Takeoff project ID')
    number(value['revision'], 'Revision', integer=True)
    if value['revision'] < 0:
        raise ValidationError('Revision cannot be negative.')
    for key, limit in (('documents', 100), ('calibrations', 2000), ('items', MAX_ITEMS), ('transfers', MAX_ITEMS * 3), ('render_checks', 2000)):
        if not isinstance(value[key], list) or len(value[key]) > limit:
            raise ValidationError(f'Takeoff {key} exceed the supported limit of {limit}.')
    seen = set()
    total_pages = 0
    for doc in value['documents']:
        object_fields(doc, {'id', 'name', 'sha256', 'size', 'pages'}, 'Document', {'id', 'name', 'sha256', 'size', 'pages'})
        identity(doc['id'], 'Document ID')
        if doc['id'] in seen:
            raise ValidationError('Document IDs must be unique.')
        seen.add(doc['id'])
        text(doc['name'], 'Document name', 255)
        if not isinstance(doc['sha256'], str) or not HASH.fullmatch(doc['sha256']):
            raise ValidationError('Every document must have its SHA-256 digest.')
        number(doc['size'], 'Document size', positive=True, integer=True)
        if not isinstance(doc['pages'], list) or not doc['pages']:
            raise ValidationError('A source document must contain parsed pages.')
        total_pages += len(doc['pages'])
        for index, page in enumerate(doc['pages'], 1):
            object_fields(page, {'page', 'width', 'height', 'view', 'media_box', 'crop_box', 'rotation', 'user_unit'}, 'Page', {'page', 'width', 'height', 'view', 'rotation', 'user_unit'})
            if type(page['page']) is not int or page['page'] != index:
                raise ValidationError('Source pages must be numbered consecutively from one.')
            for name in ('width', 'height', 'user_unit'):
                number(page[name], 'Page '+name, positive=True)
            if type(page['rotation']) is not int or page['rotation'] not in (0, 90, 180, 270):
                raise ValidationError('Page rotation must be a right angle.')
            view = page['view']
            if not isinstance(view, list) or len(view) != 4:
                raise ValidationError('Source page bounds are missing.')
            for coordinate in view:
                number(coordinate, 'Page bound')
            if view[2] <= view[0] or view[3] <= view[1]:
                raise ValidationError('Source page bounds must have positive dimensions.')
            for name in ('media_box', 'crop_box'):
                if name in page:
                    box = page[name]
                    if not isinstance(box, list) or len(box) != 4:
                        raise ValidationError('PDF page boxes require four coordinates.')
                    for coordinate in box:
                        number(coordinate, 'PDF box coordinate')
                    if box[2] <= box[0] or box[3] <= box[1]:
                        raise ValidationError('PDF page boxes must have positive dimensions.')
    if total_pages > 2000:
        raise ValidationError('A takeoff project may contain at most 2,000 pages.')
    physical_ids = set()
    for key, validator in (('calibrations', validate_calibration), ('items', validate_item)):
        ids = set()
        for entry in value[key]:
            validator(entry, value, copy_result=False)
            if entry['id'] in ids:
                raise ValidationError(f'{key} IDs must be unique.')
            ids.add(entry['id'])
            if key == 'items':
                if physical_ids.intersection(entry['member_ids']):
                    raise ValidationError('One physical member ID cannot be counted in multiple takeoff items.')
                physical_ids.update(entry['member_ids'])
                if len(physical_ids) > MAX_ITEMS:
                    raise ValidationError(f'A takeoff project may retain at most {MAX_ITEMS} physical member identities.')
    render_ids = set()
    for render in value['render_checks']:
        object_fields(render, {'document_id', 'page', 'sha256', 'success', 'warnings'}, 'Render observation', {'document_id', 'page', 'sha256', 'success', 'warnings'})
        doc, _ = page_metadata(value, render['document_id'], render['page'])
        key = (render['document_id'], render['page'])
        if key in render_ids or render['sha256'] != doc['sha256'] or type(render['success']) is not bool:
            raise ValidationError('Render observations must identify unique, unchanged source pages.')
        render_ids.add(key)
        if not isinstance(render['warnings'], list) or len(render['warnings']) > 50:
            raise ValidationError('Render warnings must be a bounded list.')
        for warning in render['warnings']:
            text(warning, 'Render warning')
    transfer_ids, targets, linked_items = set(), set(), set()
    for transfer in value['transfers']:
        allowed = {'id', 'item_id', 'item_version', 'item_digest', 'calculator_id', 'sheet', 'row', 'source_sha256', 'input_hash', 'values', 'status'}
        object_fields(transfer, allowed, 'Transfer binding', allowed)
        for name in ('id', 'item_id'):
            identity(transfer[name], 'Transfer '+name)
        number(transfer['item_version'], 'Transfer item version', positive=True, integer=True)
        number(transfer['row'], 'Transfer row', positive=True, integer=True)
        if transfer['calculator_id'] not in ('steel_vermiculite', 'steel_board', 'ductwork') or transfer['status'] not in ('current', 'stale', 'conflict', 'deleted'):
            raise ValidationError('Transfer target or status is unsupported.')
        first = {'steel_vermiculite': 10, 'steel_board': 9, 'ductwork': 11}[transfer['calculator_id']]
        expected_sheet = 'SCHEDULE' if transfer['calculator_id'] == 'steel_vermiculite' else 'CALCULATOR'
        if transfer['sheet'] != expected_sheet or not first <= transfer['row'] < first+1000:
            raise ValidationError('The transfer does not identify a valid calculator schedule row.')
        for name in ('item_digest', 'source_sha256', 'input_hash'):
            if not isinstance(transfer[name], str) or not HASH.fullmatch(transfer[name]):
                raise ValidationError('Transfer hashes must be SHA-256 digests.')
        if not isinstance(transfer['values'], dict) or len(transfer['values']) > 24:
            raise ValidationError('Transfer values must contain a bounded input patch.')
        for address, field in transfer['values'].items():
            if not re.fullmatch(r'[A-Z]{1,2}[1-9]\d*', address):
                raise ValidationError('Transfer address is invalid.')
            if field is not None and type(field) not in (str, int, float):
                raise ValidationError('Transfer values must be literal input values.')
            if int(re.search(r'\d+$', address)[0]) != transfer['row']:
                raise ValidationError('A transfer patch cannot write another row.')
            if isinstance(field, str):
                text(field, 'Transfer value')
            elif field is not None:
                number(field, 'Transfer value')
        target = (transfer['calculator_id'], transfer['sheet'], transfer['row'])
        linked = (transfer['calculator_id'], transfer['item_id'])
        if transfer['id'] in transfer_ids or target in targets or linked in linked_items:
            raise ValidationError('Transfer IDs and destination rows must be unique.')
        if digest(transfer['values']) != transfer['input_hash']:
            raise ValidationError('Transfer input hashes must match their retained literal values.')
        transfer_ids.add(transfer['id']); targets.add(target); linked_items.add(linked)
    if value['audit_head'] is not None and (not isinstance(value['audit_head'], str) or not HASH.fullmatch(value['audit_head'])):
        raise ValidationError('Audit head must be a SHA-256 digest.')
    digest(value)
    return deepcopy(value) if copy_result else value
