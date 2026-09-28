"""Allowlisted factory library content, never a copy of the user's database."""

import base64
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re

from .catalog import ValidationError, validate_configuration
from .reference_library import ReferenceLibrary, identifier

TABLE_COLUMNS = {
    'firestopping_prices': ('token', 'data'),
    'firestopping_created': ('id', 'library_number', 'request_key', 'request_hash', 'created_at', 'data'),
    'firestopping_items': ('id', 'revision', 'source_sha256', 'updated_at', 'data'),
    'firestopping_links': ('penetration_id', 'technical_id', 'penetration_source', 'technical_source', 'created_at'),
    'firestopping_unlinks': ('penetration_id', 'technical_id', 'penetration_source', 'technical_source', 'unlinked_at'),
    'firestopping_images': ('item_id', 'sha256', 'mime_type', 'width', 'height', 'image_data', 'thumbnail_data', 'updated_at'),
    'firestopping_deleted': ('id', 'source_sha256', 'deleted_at'),
}
MAX_CONTENT_BYTES = 64 * 1024 * 1024
HEX = re.compile(r'[a-f0-9]{64}\Z')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def empty_library_edits():
    return {'schema_version': 1, 'tables': {table: [] for table in TABLE_COLUMNS}}


def _json(value):
    if not isinstance(value, str) or len(value.encode('utf-8')) > 16 * 1024 * 1024:
        raise ValidationError('Invalid factory library content.')
    return json.loads(value, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def validate_library_edits(value, library_directory, reference_library=None):
    """Validate schema, identities, source references and frozen pricing content."""
    try:
        if (not isinstance(value, dict) or set(value) != {'schema_version', 'tables'}
                or type(value['schema_version']) is not int or value['schema_version'] != 1
                or not isinstance(value['tables'], dict) or set(value['tables']) != set(TABLE_COLUMNS)
                or len(encoded(value).encode('utf-8')) > MAX_CONTENT_BYTES):
            raise ValueError('Factory library content schema')
        from .firestopping_library import empty_library, FILTER_COLUMNS
        from .penetration_calculator import normalize_draft
        reference = reference_library if reference_library is not None else ReferenceLibrary(library_directory)
        if type(reference) is not ReferenceLibrary or reference.directory.resolve() != Path(library_directory).resolve():
            raise ValueError('Factory content validation requires the matching source library.')
        with reference._lock:
            base = reference._load() or empty_library()
        # _load has already validated the unchanged source. Created records need
        # a separate combined validation without modifying that cached source.
        if value['tables']['firestopping_created']:
            base = deepcopy(base)
            collection = base['libraries']['penetration']
            existing_filters = {entry['key'] for entry in collection.get('filters', [])}
            collection.setdefault('filters', []).extend({'key': key, 'label': label}
                for key, (label, _) in FILTER_COLUMNS.items() if key not in existing_filters)
        penetration = {item['id'] for item in base['libraries']['penetration']['items']}
        technical = {item['id'] for item in base['libraries']['technical']['items']}
        tables = value['tables']
        for table, columns in TABLE_COLUMNS.items():
            rows = tables[table]
            if not isinstance(rows, list) or len(rows) > (500000 if table.endswith(('links', 'unlinks')) else 50000):
                raise ValueError('Factory library content capacity')
            unique = set()
            for row in rows:
                if not isinstance(row, dict) or set(row) != set(columns):
                    raise ValueError('Factory library row columns')
                identity = tuple(row[column] for column in columns[:2]) if table.endswith(('links', 'unlinks')) else row[columns[0]]
                if identity in unique:
                    raise ValueError('Duplicate factory library row')
                unique.add(identity)
                for key, field in row.items():
                    if key in ('revision', 'library_number', 'width', 'height'):
                        if type(field) is not int or not 0 < field <= 1_000_000_000:
                            raise ValueError('Invalid factory library number')
                    elif not isinstance(field, str) or len(field) > 24 * 1024 * 1024:
                        raise ValueError('Invalid factory library text')
                    if key.endswith(('_sha256', '_source')) or key in ('sha256', 'token', 'request_hash'):
                        if not HEX.fullmatch(field):
                            raise ValueError('Invalid factory library fingerprint')
                    if key in ('id', 'item_id', 'penetration_id', 'technical_id'):
                        identifier(field)
                    if key.endswith('_at') and len(field) > 100:
                        raise ValueError('Invalid factory library timestamp')
        price_tokens = {}
        for row in tables['firestopping_prices']:
            snapshot = _json(row['data'])
            if (not isinstance(snapshot, dict) or set(snapshot) != {'basis', 'configuration', 'label', 'source_sha256'}
                    or snapshot['basis'] not in ('shared', 'workbook', 'captured')
                    or not isinstance(snapshot['label'], str) or len(snapshot['label']) > 200
                    or not HEX.fullmatch(snapshot['source_sha256'])
                    or hashlib.sha256(encoded(snapshot).encode()).hexdigest() != row['token']):
                raise ValueError('Invalid frozen factory price snapshot')
            validate_configuration(snapshot['configuration'])
            price_tokens[row['token']] = snapshot
        for row in tables['firestopping_created']:
            created = _json(row['data'])
            if (not isinstance(created, dict) or set(created) != {'item', 'source_sha256', 'calculator_source_sha256', 'pricing_token'}
                    or created['item']['id'] != row['id'] or row['id'] in penetration
                    or row['library_number'] < 100001
                    or not HEX.fullmatch(created['source_sha256'])
                    or not HEX.fullmatch(created['calculator_source_sha256'])):
                raise ValueError('Invalid created factory library item')
            # The ordinary library validator checks all documentary fields below.
            base['libraries']['penetration']['items'].append(created['item'])
            penetration.add(row['id'])
        used_tokens = set()
        for row in tables['firestopping_items']:
            item = _json(row['data'])
            if (row['id'] not in penetration or not isinstance(item, dict)
                    or set(item) != {'amount', 'draft', 'pricing_token'}
                    or item['pricing_token'] not in price_tokens
                    or price_tokens[item['pricing_token']]['source_sha256'] != row['source_sha256']
                    or isinstance(item['amount'], bool) or not isinstance(item['amount'], (int, float))
                    or not math.isfinite(item['amount']) or abs(item['amount']) > 1e12):
                raise ValueError('Invalid saved factory library item')
            draft = normalize_draft(item['draft'])
            if len(draft['rows']) != 1:
                raise ValueError('Factory library item needs one calculation row')
            used_tokens.add(item['pricing_token'])
        for row in tables['firestopping_created']:
            created = _json(row['data'])
            token = created.get('pricing_token')
            if token:
                if token not in price_tokens or price_tokens[token]['source_sha256'] != created['source_sha256']:
                    raise ValueError('Missing created-item price snapshot')
                used_tokens.add(token)
        if set(price_tokens) != used_tokens:
            raise ValueError('Factory seed contains unrelated historical price snapshots')
        for table in ('firestopping_links', 'firestopping_unlinks'):
            for row in tables[table]:
                if row['penetration_id'] not in penetration or row['technical_id'] not in technical:
                    raise ValueError('Dangling factory library reference')
        for row in tables['firestopping_deleted']:
            if row['id'] not in penetration:
                raise ValueError('Dangling factory library deletion')
        for row in tables['firestopping_images']:
            if row['item_id'] not in penetration or row['mime_type'] != 'image/jpeg' or row['width'] * row['height'] > 40_000_000:
                raise ValueError('Invalid factory library image')
            from io import BytesIO
            from PIL import Image
            for column in ('image_data', 'thumbnail_data'):
                raw = base64.b64decode(row[column], validate=True)
                if not 0 < len(raw) <= 15 * 1024 * 1024:
                    raise ValueError('Factory diagram byte limit')
                with Image.open(BytesIO(raw)) as image:
                    if image.format != 'JPEG' or image.width * image.height > 40_000_000:
                        raise ValueError('Invalid factory diagram')
                    if column == 'image_data' and (image.size != (row['width'], row['height']) or hashlib.sha256(raw).hexdigest() != row['sha256']):
                        raise ValueError('Factory diagram does not match its provenance')
                    image.verify()
        if tables['firestopping_created']:
            reference._validate(base)
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        if isinstance(error, ValidationError):
            raise
        raise ValidationError('The factory library edits are invalid or refer to missing evidence.') from error
    return value


def insert_library_edits(store, value):
    """Populate only a new staging database; refuse existing library content."""
    from .firestopping_library import LibraryEdits
    LibraryEdits(store)
    if not isinstance(value, dict) or set(value.get('tables', {})) != set(TABLE_COLUMNS):
        raise ValidationError('Invalid factory library table set.')
    with store.connect() as database:
        database.execute('BEGIN IMMEDIATE')
        for table in TABLE_COLUMNS:
            if database.execute('SELECT count(*) FROM ' + table).fetchone()[0]:
                raise ValidationError('Existing user library content must not be replaced.')
        for table, columns in TABLE_COLUMNS.items():
            for row in value['tables'][table]:
                fields = [base64.b64decode(row[column], validate=True) if column in ('image_data', 'thumbnail_data') else row[column] for column in columns]
                database.execute('INSERT INTO ' + table + ' (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', fields)


def export_library_edits(database):
    """Read an existing read-only connection, including only referenced price records."""
    value = empty_library_edits()
    existing = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table, columns in TABLE_COLUMNS.items():
        if table not in existing:
            continue
        for fields in database.execute('SELECT ' + ','.join(columns) + ' FROM ' + table + ' ORDER BY ' + columns[0]):
            value['tables'][table].append({column: base64.b64encode(field).decode('ascii') if isinstance(field, bytes) else field for column, field in zip(columns, fields)})
    used = {_json(row['data'])['pricing_token'] for row in value['tables']['firestopping_items']}
    used.update(_json(row['data']).get('pricing_token') for row in value['tables']['firestopping_created'])
    value['tables']['firestopping_prices'] = [row for row in value['tables']['firestopping_prices'] if row['token'] in used]
    return value
