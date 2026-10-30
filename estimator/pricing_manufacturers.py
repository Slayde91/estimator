"""Reviewed manufacturer metadata for the shared Pricing Library only.

Assignments bind exact existing identities and names. They never participate in
pricing, yield lookup, formula evaluation or saved-project restoration.
"""
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

from .catalog import (ROOT, ValidationError, configuration_catalog,
                      manufacturer_text, validate_configuration)

SEED_PATH = ROOT / 'data' / 'pricing_manufacturers.json'
MAX_SEED_BYTES = 1024 * 1024


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError('Manufacturer defaults contain duplicate JSON fields.')
        result[key] = value
    return result


def _text(value, label, maximum=2000):
    if (not isinstance(value, str) or not value.strip() or len(value) > maximum
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ValidationError(f'{label} must be bounded, nonempty plain text.')
    return value


def load_manufacturer_seed(path=None):
    path = SEED_PATH if path is None else Path(path)
    try:
        with path.open('rb') as stream:
            payload = stream.read(MAX_SEED_BYTES + 1)
        if not payload or len(payload) > MAX_SEED_BYTES:
            raise ValidationError('Manufacturer defaults exceed the supported data size.')
        value = json.loads(payload.decode('utf-8-sig'), object_pairs_hook=_unique)
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        raise ValidationError('The reviewed manufacturer defaults could not be read.') from error
    if not isinstance(value, dict) or set(value) != {'schema_version', 'reviewed_at', 'assignments'} or type(value['schema_version']) is not int or value['schema_version'] != 1:
        raise ValidationError('Manufacturer defaults use an unsupported schema.')
    _text(value['reviewed_at'], 'Manufacturer review date', 100)
    assignments = value['assignments']
    if not isinstance(assignments, list) or len(assignments) > 1000:
        raise ValidationError('Manufacturer defaults must contain at most 1,000 reviewed assignments.')
    seen = set()
    for assignment in assignments:
        required = {'kind', 'id', 'name', 'manufacturer', 'evidence'}
        if (not isinstance(assignment, dict) or not required <= set(assignment) <= required | {'group'}
                or not isinstance(assignment['kind'], str) or assignment['kind'] not in {'inventory', 'rates'}):
            raise ValidationError('Each manufacturer default must identify its existing product or standalone rate.')
        _text(assignment['id'], 'Manufacturer binding ID', 200)
        _text(assignment['name'], 'Manufacturer binding name', 1000)
        if not manufacturer_text(assignment['manufacturer']).strip():
            raise ValidationError('A manufacturer default must contain a reviewed value.')
        if 'group' in assignment:
            _text(assignment['group'], 'Manufacturer rate group', 200)
        identity = assignment['kind'], assignment['id']
        if identity in seen:
            raise ValidationError('Manufacturer defaults must not repeat an item identity.')
        seen.add(identity)
        evidence = assignment['evidence']
        if not isinstance(evidence, list) or not 1 <= len(evidence) <= 10:
            raise ValidationError('Every manufacturer default needs source evidence.')
        for source in evidence:
            if (not isinstance(source, dict) or set(source) - {'url', 'title', 'note', 'local_reference'}
                    or 'title' not in source or not {'url', 'local_reference'} & set(source)):
                raise ValidationError('Manufacturer source evidence must name its source and reference.')
            for key, text in source.items():
                _text(text, 'Manufacturer source ' + key)
            if 'url' in source and not source['url'].startswith('https://'):
                raise ValidationError('Manufacturer evidence links must use HTTPS.')
    return value, sha256(payload).hexdigest()


def with_manufacturer_defaults(configuration, *, seed_path=None):
    """Return shared defaults without touching explicit metadata or the input.

    Call only for current/shared pricing. Generic catalog/configuration
    validation and project loading deliberately do not invoke this function.
    """
    seed, digest = load_manufacturer_seed(seed_path)
    checked = validate_configuration(configuration)
    catalog = configuration_catalog(checked)
    products = {item['id']: item for item in catalog['inventory']}
    rates = {item['id']: (group, item) for group, rows in catalog['rate_groups'].items() for item in rows}
    changed = False
    for assignment in seed['assignments']:
        kind, identity = assignment['kind'], assignment['id']
        if kind == 'inventory':
            record = products.get(identity)
        else:
            pair = rates.get(identity)
            if pair is None or 'group' in assignment and pair[0] != assignment['group']:
                continue
            record = pair[1]
            if record.get('inventory_id') is not None:
                continue  # Linked uses belong to the owning product.
        if record is None or record['name'] != assignment['name']:
            continue
        edits = checked[kind].get(identity, {})
        if 'manufacturer' in record or 'manufacturer' in edits:
            continue  # Explicit blank is an intentional clear, too.
        if any(str(key).casefold() == 'manufacturer' for key in record.get('properties', {})):
            continue
        if any(key in edits and edits[key] != record.get(key) for key in ('name', 'sales_description', 'product_service')):
            continue  # A renamed custom item must not acquire its old brand.
        if record.get('source', {}).get('origin') == 'user' or 'manufacturer_assignment' in record.get('source', {}):
            continue
        record['manufacturer'] = assignment['manufacturer']
        record.setdefault('source', {})['manufacturer_assignment'] = {
            'seed_sha256': digest, 'reviewed_at': seed['reviewed_at'], 'value': assignment['manufacturer'],
            'binding': {'kind': kind, 'id': identity, 'name': assignment['name']},
            'evidence': deepcopy(assignment['evidence']),
        }
        changed = True
    if not changed:
        return deepcopy(configuration)
    result = deepcopy(configuration)
    result['catalog'] = catalog
    return validate_configuration(result)
