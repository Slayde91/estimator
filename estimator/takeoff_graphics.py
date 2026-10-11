"""Bounded PDF-only vector and text marks, without register or review authority."""
from copy import deepcopy
import math
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_model import identity, number, object_fields, page_metadata, points, text, validate_appearance

MAX_VISUAL_RECORDS = 1000
MAX_GRAPHIC_POINTS = 1000
GRAPHIC_MODES = ('steel', 'duct', 'wall', 'slab', 'defect_reports', 'service_plans')
BOX_KINDS = ('cloud', 'textbox', 'stamp', 'rectangle', 'circle')
POINT_KINDS = ('line', 'polyline', 'arrow', 'polygon')
GRAPHIC_FIELDS = {'id', 'version', 'mode', 'document_id', 'source_sha256', 'page',
                  'kind', 'geometry', 'text', 'appearance', 'text_content', 'stamp_image'}
REQUIRED_GRAPHIC_FIELDS = GRAPHIC_FIELDS - {'text_content', 'stamp_image'}
EDIT_FIELDS = {'geometry', 'text', 'appearance', 'text_content', 'stamp_image'}
APPEARANCE_FIELDS = {'stroke_color', 'stroke_width', 'opacity', 'fill_enabled',
                     'fill_color', 'font_color', 'font_size'}
DEFAULT_APPEARANCE = {'stroke_color': '#FF0000', 'stroke_width': 2, 'opacity': 1,
                      'fill_enabled': False, 'fill_color': '#FFFFFF',
                      'font_color': '#000000', 'font_size': 12}


def graphic_appearance(value):
    object_fields(value, APPEARANCE_FIELDS, 'PDF markup appearance')
    validate_appearance({key: child for key, child in value.items() if key != 'font_size'})
    if 'font_size' in value:
        number(value['font_size'], 'PDF markup font size')
        if not 4 <= value['font_size'] <= 144:
            raise ValidationError('PDF markup font size must be between 4 and 144 PDF points.')
    return {**DEFAULT_APPEARANCE, **value}


def _validate_box(value, page):
    quad = points(value, 'PDF markup box', page, 4, 4)
    q0, q1, q2, q3 = quad
    horizontal = [q1[axis] - q0[axis] for axis in (0, 1)]
    vertical = [q3[axis] - q0[axis] for axis in (0, 1)]
    width, height = math.hypot(*horizontal), math.hypot(*vertical)
    if not 10 <= width <= 10000 or not 10 <= height <= 10000:
        raise ValidationError('PDF markup box edges must be between 10 and 10,000 original PDF points.')
    if any(not math.isclose(q2[axis], q1[axis] + q3[axis] - q0[axis], rel_tol=1e-9, abs_tol=1e-7)
           for axis in (0, 1)) or abs(math.fsum(horizontal[axis] * vertical[axis] for axis in (0, 1))) > width * height * 1e-8:
        raise ValidationError('PDF markup boxes must be affine rectangles with perpendicular edges.')


def validate_graphic(value, snapshot, *, verified_stamp_images=None):
    object_fields(value, GRAPHIC_FIELDS, 'PDF markup', REQUIRED_GRAPHIC_FIELDS)
    identity(value['id'], 'PDF markup ID')
    number(value['version'], 'PDF markup version', positive=True, integer=True)
    if value['mode'] not in GRAPHIC_MODES:
        raise ValidationError('Choose a supported drawing workspace for the PDF markup.')
    document, page = page_metadata(snapshot, value['document_id'], value['page'])
    if value['source_sha256'] != document['sha256']:
        raise ValidationError('A PDF markup must identify its exact retained source PDF.')
    kind, geometry = value['kind'], value['geometry']
    if kind in BOX_KINDS:
        object_fields(geometry, {'quad_pdf'}, 'PDF markup box geometry', {'quad_pdf'})
        _validate_box(geometry['quad_pdf'], page)
    elif kind in POINT_KINDS:
        object_fields(geometry, {'points'}, 'PDF markup path geometry', {'points'})
        path = points(geometry['points'], 'PDF markup path', page,
                      3 if kind == 'polygon' else 2, 2 if kind in ('line', 'arrow') else MAX_GRAPHIC_POINTS)
        if any(a == b for a, b in zip(path, path[1:])):
            raise ValidationError('Adjacent PDF markup points must be distinct.')
        if kind == 'polygon':
            from .takeoff_area import validate_polygon
            validate_polygon({'kind': 'polygon', 'document_id': value['document_id'], 'page': value['page'],
                              'points': path, 'exclusions': []}, page)
    else:
        raise ValidationError('Choose Cloud, Textbox, Stamp, Line, Polyline, Arrow, Rectangle, Circle or Polygon.')
    text(value['text'], 'PDF markup text', 80 if kind == 'stamp' else 4000)
    if any(ord(character) in (0x007F, 0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A))
           for character in value['text']):
        raise ValidationError('PDF markup text cannot contain invisible direction or delete controls.')
    if 'stamp_image' in value:
        if kind != 'stamp' or value['text'] != '':
            raise ValidationError('Only an image Stamp with empty text may retain a Stamp image.')
        from .takeoff_stamp_images import validate_stamp_image
        image = value['stamp_image']
        if not isinstance(image, dict):
            validate_stamp_image(image)
        # Cache only inside this validation, binding every metadata and byte field.
        # A matching SHA alone never skips dimensions, schema or payload checks.
        binding = tuple((type(image.get(key)), image.get(key))
                        for key in ('version', 'mime_type', 'width', 'height', 'sha256', 'content_base64'))
        image_sha = image.get('sha256')
        cached = verified_stamp_images.get(image_sha) if verified_stamp_images is not None and isinstance(image_sha, str) else None
        if cached != (set(image), binding):
            validate_stamp_image(image)
            if verified_stamp_images is not None:
                verified_stamp_images[image['sha256']] = (set(image), binding)
    elif kind in ('textbox', 'stamp'):
        if not value['text'].strip() or kind == 'stamp' and any(character in '\n\r\t' for character in value['text']):
            raise ValidationError('Enter nonblank PDF markup text; a Stamp requires one line.')
    elif value['text'] != '':
        raise ValidationError('Only Textbox and Stamp markups retain text.')
    if 'text_content' in value:
        if kind != 'textbox':
            raise ValidationError('Only Textbox markups support formatted text.')
        from .takeoff_annotations import validate_content
        content = validate_content(value['text_content'])
        plain = '\n'.join(''.join(run['text'] for run in block['runs']) for block in content['blocks'])
        if plain != value['text']:
            raise ValidationError('Textbox text must exactly match its formatted text blocks.')
    object_fields(value['appearance'], APPEARANCE_FIELDS, 'Stored PDF markup appearance', APPEARANCE_FIELDS)
    graphic_appearance(value['appearance'])
    return value


def visual_record_count(snapshot):
    return (len(snapshot.get('graphics', {}).get('records', []))
            + len(snapshot.get('signatures', {}).get('records', []))
            + len(snapshot.get('annotations', {}).get('callouts', [])))


def validate_graphics(snapshot):
    if 'graphics' not in snapshot:
        return
    collection = object_fields(snapshot['graphics'], {'version', 'records'}, 'PDF markup collection', {'version', 'records'})
    if type(collection['version']) is not int or collection['version'] != 1:
        raise ValidationError('This PDF markup collection version is not supported.')
    if not isinstance(collection['records'], list) or visual_record_count(snapshot) > MAX_VISUAL_RECORDS:
        raise ValidationError(f'A project supports at most {MAX_VISUAL_RECORDS} PDF markups, signatures and free call-outs combined.')
    from .takeoff_stamp_images import validate_stamp_image_budget
    # Admit the aggregate pixel work before opening/decompressing any image.
    validate_stamp_image_budget(collection['records'])
    verified_stamp_images = {}
    seen = {value['id'] for key in ('items', 'documents', 'calibrations', 'transfers', 'image_extractions')
            for value in snapshot.get(key, [])}
    seen.update(value['id'] for value in snapshot.get('annotations', {}).get('callouts', []))
    seen.update(value['id'] for value in snapshot.get('signatures', {}).get('records', []))
    seen.update(value['id'] for value in snapshot.get('library_assignments', {}).get('records', []))
    for item in snapshot.get('items', []):
        seen.update(item['member_ids'])
        seen.update(value['id'] for value in item.get('length_additions', []))
        seen.update(value['id'] for value in (item.get('geometry') or {}).get('exclusions', []))
    for key in ('physical', 'service_plans'):
        graph = snapshot.get(key)
        if graph:
            from .takeoff_physical import graph_collections
            seen.add(graph['id'])
            seen.update(entity['id'] for name in graph_collections(graph).values() for entity in graph[name])
    for record in collection['records']:
        validate_graphic(record, snapshot, verified_stamp_images=verified_stamp_images)
        if record['id'] in seen:
            raise ValidationError('PDF markup IDs must be unique and separate from all drawing, member or register identities.')
        seen.add(record['id'])


def apply_graphic(snapshot, request):
    if request['op'] == 'create_graphic':
        proposal = object_fields(request['graphic'], GRAPHIC_FIELDS - {'id', 'version'}, 'New PDF markup', REQUIRED_GRAPHIC_FIELDS - {'id', 'version'})
        record = {'id': str(uuid4()), 'version': 1, **deepcopy(proposal)}
        record['appearance'] = graphic_appearance(record['appearance'])
        if 'stamp_image' in record:
            from .takeoff_stamp_images import normalize_stamp_image
            record['stamp_image'] = normalize_stamp_image(record['stamp_image'])
        validate_graphic(record, snapshot)
        if visual_record_count(snapshot) >= MAX_VISUAL_RECORDS:
            raise ValidationError(f'A project supports at most {MAX_VISUAL_RECORDS} PDF markups, signatures and free call-outs combined.')
        snapshot.setdefault('graphics', {'version': 1, 'records': []})['records'].append(record)
        return record['id']
    identifier = identity(request['graphic_id'], 'PDF markup ID')
    records = snapshot.get('graphics', {}).get('records', [])
    record = next((value for value in records if value['id'] == identifier), None)
    if record is None:
        raise ValidationError('The selected PDF markup no longer exists.')
    if request['op'] == 'delete_graphic':
        records.remove(record)
    else:
        changes = object_fields(request['changes'], EDIT_FIELDS, 'PDF markup edit')
        if not changes:
            raise ValidationError('Choose a PDF markup property to edit.')
        for key, value in changes.items():
            if key == 'stamp_image':
                if value is None:
                    record.pop(key, None)
                else:
                    from .takeoff_stamp_images import normalize_stamp_image
                    record[key] = normalize_stamp_image(value)
                continue
            record[key] = ({**record['appearance'], **deepcopy(value)}
                           if key == 'appearance' and isinstance(value, dict) else deepcopy(value))
        record['version'] += 1
        validate_graphic(record, snapshot)
    return None


def undo_graphics(before, restored):
    originals = {record['id']: record for record in before.get('graphics', {}).get('records', [])}
    for record in restored.get('graphics', {}).get('records', []):
        previous = originals.get(record['id'])
        if previous != record:
            record['version'] = max(record['version'], previous['version'] if previous else 0) + 1


def graphic_binding(record):
    return (record['mode'], record['document_id'], record['source_sha256'], record['page'], record['kind'])


def validate_history(event):
    old = {record['id']: record for record in event['before'].get('graphics', {}).get('records', [])}
    new = {record['id']: record for record in event['after'].get('graphics', {}).get('records', [])}
    if event['before']['revision'] == 0 and old:
        raise ValidationError('The initial audit state cannot contain unrecorded PDF markups.')
    controlled = ('create_graphic', 'update_graphic', 'delete_graphic', 'initial_pages')
    if event['op'] in controlled:
        ignored = ('graphics', 'signatures', 'revision') if event['op'] == 'initial_pages' else ('graphics', 'revision')
        projection = lambda state: {key: value for key, value in state.items() if key not in ignored}
        if projection(event['before']) != projection(event['after']):
            raise ValidationError('A PDF markup operation cannot change measurements, physical records, source state or transfers.')
    if old != new and event['op'] not in (*controlled, 'undo'):
        raise ValidationError('PDF markups changed outside a controlled markup operation.')
    added, removed = new.keys() - old.keys(), old.keys() - new.keys()
    changed = {identifier for identifier in old.keys() & new.keys() if old[identifier] != new[identifier]}
    if added and event['op'] not in ('create_graphic', 'initial_pages', 'undo'):
        raise ValidationError('PDF markup identities may only be created or restored by Undo.')
    if event['op'] == 'create_graphic' and (len(added) != 1 or removed or changed or any(new[i]['version'] != 1 for i in added)):
        raise ValidationError('A PDF markup must begin with one new identity and version one.')
    if event['op'] == 'update_graphic' and (added or removed or len(changed) != 1):
        raise ValidationError('A PDF markup edit must update exactly one retained identity.')
    if event['op'] == 'delete_graphic' and (added or changed or len(removed) != 1):
        raise ValidationError('A PDF markup deletion must remove exactly one retained identity.')
    for identifier in old.keys() & new.keys():
        if graphic_binding(old[identifier]) != graphic_binding(new[identifier]):
            raise ValidationError('A PDF markup source or tool identity cannot be rewritten in audit history.')
        if old[identifier] != new[identifier] and new[identifier]['version'] <= old[identifier]['version']:
            raise ValidationError('Edited PDF markups require a fresh increasing version.')
    return {identifier: graphic_binding(record) for identifier, record in {**old, **new}.items()}


def export_graphics(snapshot, request, document_id, modes):
    active = {record['id']: record for record in snapshot.get('graphics', {}).get('records', [])
              if record['mode'] in modes and record['document_id'] == document_id}
    identifiers = request.get('graphic_ids', list(active))
    if (not isinstance(identifiers, list) or len(identifiers) > MAX_VISUAL_RECORDS
            or any(not isinstance(identifier, str) for identifier in identifiers)
            or len(identifiers) != len(set(identifiers)) or set(identifiers) - active.keys()):
        raise ValidationError('Export PDF markup IDs must identify distinct markups in the current workspace and exact source PDF.')
    return [active[identifier] for identifier in identifiers]


def graphic_geometry_cost(record):
    # Count derived cloud/ellipse/arrow control points conservatively before
    # admitting the bounded worker; a box cloud can have at most 256 lobes.
    return {'cloud': 772, 'circle': 16, 'arrow': 5}.get(record['kind'],
        len(record['geometry'].get('points', record['geometry'].get('quad_pdf', []))))
