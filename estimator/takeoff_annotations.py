"""Versioned, presentation-only call-outs; never calculator or physical records."""

from copy import deepcopy
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_model import identity, number, object_fields, page_metadata, points, text, validate_appearance

MAX_ANNOTATIONS = 1000
MAX_BLOCKS = 64
MAX_RUNS = 256
MAX_CONTENT_CHARACTERS = 8000
APPEARANCE_FIELDS = {'stroke_color', 'fill_enabled', 'fill_color', 'font_color', 'stroke_width', 'opacity'}
DEFAULT_APPEARANCE = {'stroke_color': '#FF3300', 'fill_enabled': True, 'fill_color': '#FFDD33',
                      'font_color': '#000000', 'stroke_width': 4, 'opacity': .75}
ANNOTATION_FIELDS = {'id', 'version', 'mode', 'document_id', 'source_sha256', 'page', 'point',
                     'label_position', 'width', 'height', 'content', 'appearance'}
EDIT_FIELDS = {'point', 'label_position', 'width', 'height', 'content', 'appearance'}


def validate_content(value):
    """Accept literal bounded text and explicit marks, never HTML or link targets."""
    object_fields(value, {'version', 'blocks'}, 'Call-out content', {'version', 'blocks'})
    if type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('This call-out content version is not supported.')
    blocks = value['blocks']
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= MAX_BLOCKS:
        raise ValidationError(f'Call-out content requires one to {MAX_BLOCKS} text blocks.')
    characters, runs = 0, 0
    for block in blocks:
        object_fields(block, {'kind', 'runs'}, 'Call-out text block', {'kind', 'runs'})
        if block['kind'] not in ('paragraph', 'bullet', 'number'):
            raise ValidationError('Call-out text supports paragraphs, bullet lists and numbered lists.')
        if not isinstance(block['runs'], list) or not 1 <= len(block['runs']) <= MAX_RUNS:
            raise ValidationError('Each call-out text block requires a bounded list of text runs.')
        for run in block['runs']:
            object_fields(run, {'text', 'bold', 'italic', 'underline'}, 'Call-out text run', {'text'})
            text(run['text'], 'Call-out text', MAX_CONTENT_CHARACTERS)
            if any(ord(character) in (0x007F, 0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A))
                   for character in run['text']):
                raise ValidationError('Call-out text cannot contain invisible direction or delete controls.')
            for mark in ('bold', 'italic', 'underline'):
                if mark in run and type(run[mark]) is not bool:
                    raise ValidationError('Call-out text formatting must be true or false.')
            characters += len(run['text']); runs += 1
            if characters > MAX_CONTENT_CHARACTERS or runs > MAX_RUNS:
                raise ValidationError(f'Call-out content is limited to {MAX_CONTENT_CHARACTERS} characters and {MAX_RUNS} text runs.')
    return value


def annotation_appearance(value):
    object_fields(value, APPEARANCE_FIELDS, 'Call-out appearance')
    return {**DEFAULT_APPEARANCE, **validate_appearance(value)}


def validate_annotation(value, snapshot):
    object_fields(value, ANNOTATION_FIELDS, 'Free call-out', ANNOTATION_FIELDS)
    identity(value['id'], 'Call-out ID')
    number(value['version'], 'Call-out version', positive=True, integer=True)
    if value['mode'] not in ('steel', 'duct', 'wall', 'slab'):
        raise ValidationError('Free call-outs belong to Steel, Duct, Walls or Slabs.')
    document, page = page_metadata(snapshot, value['document_id'], value['page'])
    if value['source_sha256'] != document['sha256']:
        raise ValidationError('Free call-outs must identify their exact retained source PDF.')
    points([value['point']], 'Call-out source anchor', page, maximum=1)
    points([value['label_position']], 'Call-out label anchor', page, maximum=1)
    for dimension in ('width', 'height'):
        number(value[dimension], 'Call-out ' + dimension, positive=True)
        if not 10 <= value[dimension] <= 10000:
            raise ValidationError('Call-out dimensions must be between 10 and 10,000 PDF points.')
    # Boxes are upright in the viewer/PDF derivative. Anchors are original PDF
    # coordinates; source rotation changes their projection, never their data.
    object_fields(value['appearance'], APPEARANCE_FIELDS, 'Stored call-out appearance', APPEARANCE_FIELDS)
    annotation_appearance(value['appearance'])
    validate_content(value['content'])
    return value


def validate_annotations(snapshot):
    if 'annotations' not in snapshot:
        return
    collection = object_fields(snapshot['annotations'], {'version', 'callouts'}, 'Annotation collection', {'version', 'callouts'})
    if type(collection['version']) is not int or collection['version'] != 1:
        raise ValidationError('This annotation collection version is not supported.')
    records = collection['callouts']
    if not isinstance(records, list) or len(records) > MAX_ANNOTATIONS:
        raise ValidationError(f'A project supports at most {MAX_ANNOTATIONS} free call-outs.')
    seen = {item['id'] for item in snapshot.get('items', [])
            if isinstance(item, dict) and isinstance(item.get('id'), str)}
    for record in records:
        validate_annotation(record, snapshot)
        if record['id'] in seen:
            raise ValidationError('Call-out IDs must be unique and separate from measurement IDs.')
        seen.add(record['id'])


def annotation_binding(value):
    return (value['mode'], value['document_id'], value['source_sha256'], value['page'])


def apply_annotation(snapshot, request):
    """Typed revisions change only this separate collection, with no approvals."""
    op = request['op']
    if op == 'create_annotation':
        proposed = object_fields(request['annotation'], ANNOTATION_FIELDS - {'id', 'version'}, 'New free call-out',
                                 ANNOTATION_FIELDS - {'id', 'version'})
        record = {'id': str(uuid4()), 'version': 1, **deepcopy(proposed)}
        record['appearance'] = annotation_appearance(record['appearance'])
        validate_annotation(record, snapshot)
        collection = snapshot.setdefault('annotations', {'version': 1, 'callouts': []})
        if len(collection['callouts']) >= MAX_ANNOTATIONS:
            raise ValidationError(f'A project supports at most {MAX_ANNOTATIONS} free call-outs.')
        collection['callouts'].append(record)
        return record['id']
    identifier = identity(request['annotation_id'], 'Call-out ID')
    records = snapshot.get('annotations', {}).get('callouts', [])
    record = next((value for value in records if value['id'] == identifier), None)
    if record is None:
        raise ValidationError('The selected free call-out no longer exists.')
    if op == 'delete_annotation':
        records.remove(record)
    else:
        changes = object_fields(request['changes'], EDIT_FIELDS, 'Call-out edit')
        if not changes:
            raise ValidationError('Choose a call-out property to edit.')
        for key, value in changes.items():
            record[key] = {**record['appearance'], **deepcopy(value)} if key == 'appearance' and isinstance(value, dict) else deepcopy(value)
        record['version'] += 1
        validate_annotation(record, snapshot)
    return None


def undo_annotations(before, restored):
    """Keep restored identity while recording a fresh revision for edited notes."""
    originals = {value['id']: value for value in before.get('annotations', {}).get('callouts', [])}
    for value in restored.get('annotations', {}).get('callouts', []):
        previous = originals.get(value['id'])
        if previous != value:
            value['version'] = max(value['version'], previous['version'] if previous else 0) + 1
