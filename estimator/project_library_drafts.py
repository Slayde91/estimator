"""Values-only Firestopping Library drafts owned by one project.

These records are not shared library edits or technical approvals. Loading and
calculation never write the library database or accept pricing tokens, formulas,
renderer definitions, filesystem paths, or remote diagram URLs from a project.
"""

import base64
from copy import deepcopy
import json
import re

from .catalog import ValidationError, validate_configuration
from .penetration_calculator import calculate, definition, normalize_draft, source_model

MAX_RECORDS = 100
MAX_BYTES = 16 * 1_048_576


def _text(value, label, limit, *, required=True):
    if (not isinstance(value, str) or len(value) > limit
            or required and not value.strip()
            or any(ord(character) < 32 for character in value)):
        raise ValidationError(f'Invalid project library {label}.')
    return value


def normalize_library_drafts(value):
    """Validate portable values; original diagram bytes remain stable on reopen."""
    from .project_file import _check_tree
    _check_tree(value)
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_BYTES:
        raise ValidationError('Project library drafts exceed the project file size limit.')
    if not isinstance(value, dict) or set(value) != {'version', 'source_sha256', 'records'}:
        raise ValidationError('Project library drafts must contain their version, source and records only.')
    source = source_model()['source']['sha256']
    if type(value['version']) is not int or value['version'] != 1 or value['source_sha256'] != source:
        raise ValidationError('The project library drafts use an unsupported version or Firestopping calculator source.')
    records = value['records']
    if not isinstance(records, list) or len(records) > MAX_RECORDS:
        raise ValidationError(f'A project supports at most {MAX_RECORDS} library drafts.')
    output, seen, diagram_bytes = [], set(), 0
    fields = {'id', 'title', 'library_id', 'source_sha256', 'draft', 'configuration', 'diagram'}
    for record in records:
        if not isinstance(record, dict) or set(record) != fields:
            raise ValidationError('Project library records must contain identity, source, inputs, pricing and diagram only.')
        key = record['id']
        if not isinstance(key, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,119}', key) or key in seen:
            raise ValidationError('Project library record IDs must be valid and distinct.')
        seen.add(key)
        title = _text(record['title'], 'title', 1000)
        alias = _text(record['library_id'], 'label', 255)
        fingerprint = record['source_sha256']
        if not isinstance(fingerprint, str) or not re.fullmatch(r'[a-f0-9]{64}', fingerprint):
            raise ValidationError('The project library record source fingerprint is invalid.')
        draft = normalize_draft(record['draft'])
        if len(draft['rows']) != 1:
            raise ValidationError('Each project library draft must contain exactly one calculation row.')
        config = record['configuration']
        if not isinstance(config, dict) or 'catalog' not in config:
            raise ValidationError('Each project library draft needs its captured pricing catalogue.')
        config = validate_configuration(config)
        diagram = record['diagram']
        if diagram is not None:
            from .firestopping_library import diagram_upload
            if not isinstance(diagram, dict) or set(diagram) != {'filename', 'content_base64'}:
                raise ValidationError('Project library diagrams must contain an image filename and image bytes only.')
            name = _text(diagram['filename'], 'diagram filename', 255)
            if '/' in name or '\\' in name or ':' in name:
                raise ValidationError('Project library diagrams cannot contain filesystem paths.')
            # Validate decoded pixels with the existing image boundary; retain
            # submitted bytes so repeated Save/Load never recompresses a source.
            diagram_upload(diagram)
            diagram_bytes += len(diagram['content_base64'])
            if diagram_bytes > MAX_BYTES:
                raise ValidationError('Project library diagrams exceed the project file size limit.')
            diagram = deepcopy(diagram)
        output.append({'id': key, 'title': title, 'library_id': alias,
                       'source_sha256': fingerprint, 'draft': draft,
                       'configuration': config, 'diagram': diagram})
    return {'version': 1, 'source_sha256': source, 'records': output}


def prepare_library_drafts(value, *, service_types=None):
    """Rebuild editor output from validated inputs, without shared authority."""
    snapshot = normalize_library_drafts(value)
    records = []
    for record in snapshot['records']:
        result = calculate(record['draft'], record['configuration'])
        current_definition = definition(record['configuration'], service_types=service_types)
        result['definition'] = current_definition
        image = record['diagram']
        diagram = {'available': image is not None, 'custom': image is not None, 'url': None}
        if image is not None:
            # Pillow validates actual content; the existing editor supports the
            # same three raster formats. No arbitrary URL is ever accepted.
            from io import BytesIO
            from PIL import Image
            with Image.open(BytesIO(base64.b64decode(image['content_base64'], validate=True))) as decoded:
                mime = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}[decoded.format]
            diagram['url'] = f"data:{mime};base64,{image['content_base64']}"
        amount = result['rows'][0]['outputs'].get('H')
        records.append({**deepcopy(record), 'project_local': True, 'definition': current_definition,
                        'result': result, 'diagram': diagram, 'pricing_basis': 'project',
                        'pricing_label': 'Pricing captured in this project',
                        'price': {'amount': amount, 'currency': 'AUD', 'label': 'Project draft price'},
                        'source_price': None})
    return {'library_drafts': snapshot, 'records': records}
