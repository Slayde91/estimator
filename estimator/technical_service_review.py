"""Private, source-bound Services selections outside immutable library records.

The sidecar contains review evidence and selects existing dropdown values only.
Raw items and public projections must still match before any selection applies.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re

from .firefly_reference_review import fingerprint
from .library_facets import MOVED_SERVICE_CATEGORIES
from .technical_service_options import TECHNICAL_SERVICES

PLAN_NAME = 'technical-services-plan-v1.json'
REVIEW_KEY = '_technical_services_review'
MAX_PLAN_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 50000
_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,119}\Z')
_SHA = re.compile(r'[a-f0-9]{64}\Z')
_PLAN_KEYS = {'schema_version', 'review_id', 'reviewed_index_sha256', 'items'}
_ITEM_KEYS = {'id', 'item_sha256', 'projection_sha256', 'services', 'evidence'}
_FIELD_EVIDENCE_KEYS = {'field', 'quote', 'source_reference'}
_DOCUMENT_EVIDENCE_KEYS = {'document_id', 'document_sha256', 'page', 'quote', 'source_reference'}
_ALLOWED_SERVICES = frozenset(TECHNICAL_SERVICES) - {'N/A'}


@dataclass(frozen=True)
class ValidatedReview:
    """Python-only validation capability; imported JSON cannot supply one."""
    payload: str
    sha256: str


def projection_fingerprint(record):
    """Bind every public field, reference, source and pre-review service value.

    Discovery facets are supplied separately and are never written into this
    public record. Adding unrelated records does not change this fingerprint.
    """
    return fingerprint(record)


def _path(directory):
    directory = Path(directory)
    path = directory / 'reviews' / PLAN_NAME
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError('Services review must remain inside the local library')
    return path


def plan_stamp(directory):
    path = _path(directory)
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file() or not 0 < info.st_size <= MAX_PLAN_BYTES:
        raise ValueError('Services review size or file type')
    return info.st_mtime_ns, info.st_size, info.st_ctime_ns


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate Services review JSON key')
        result[key] = value
    return result


def _constant(_):
    raise ValueError('Non-finite Services review number')


def _decode(payload):
    return json.loads(payload, object_pairs_hook=_object, parse_constant=_constant)


def _text(value, maximum=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('Invalid Services review text')
    return value


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError('Invalid Services review identity')
    return value


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError('Invalid Services review fingerprint')
    return value


def _validate_evidence_shape(evidence):
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 100:
        raise ValueError('Services review evidence limit')
    seen = set()
    for row in evidence:
        if not isinstance(row, dict) or set(row) not in (_FIELD_EVIDENCE_KEYS, _DOCUMENT_EVIDENCE_KEYS):
            raise ValueError('Invalid Services review evidence')
        _text(row['quote'], 100000)
        _text(row['source_reference'], 2000)
        if 'field' in row:
            _text(row['field'], 200)
        else:
            _id(row['document_id'])
            _sha(row['document_sha256'])
            if type(row['page']) is not int or not 1 <= row['page'] <= 10000:
                raise ValueError('Invalid Services review document page')
        signature = fingerprint(row)
        if signature in seen:
            raise ValueError('Duplicate Services review evidence')
        seen.add(signature)


def _validate_shape(plan):
    if not isinstance(plan, dict) or set(plan) != _PLAN_KEYS or type(plan['schema_version']) is not int or plan['schema_version'] != 1:
        raise ValueError('Invalid Services review schema')
    _id(plan['review_id'])
    _sha(plan['reviewed_index_sha256'])
    items = plan['items']
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise ValueError('Services review item limit')
    seen = set()
    for row in items:
        if not isinstance(row, dict) or set(row) != _ITEM_KEYS:
            raise ValueError('Invalid Services review item')
        key = _id(row['id'])
        if key in seen:
            raise ValueError('Duplicate Services review item')
        seen.add(key)
        _sha(row['item_sha256'])
        _sha(row['projection_sha256'])
        services = row['services']
        if (not isinstance(services, list) or not 1 <= len(services) <= len(_ALLOWED_SERVICES)
                or any(not isinstance(value, str) or value not in _ALLOWED_SERVICES for value in services)
                or len(set(services)) != len(services)):
            raise ValueError('Services review may select existing Services options only')
        _validate_evidence_shape(row['evidence'])


def _document_membership(item, evidence):
    sources = [source for source in item.get('sources', [])
               if source.get('document_id') == evidence['document_id']]
    if not sources:
        raise ValueError('Services review document is not linked to this item')
    pages = set()
    for source in sources:
        page = source.get('page', 1)
        if type(page) is not int or page < 1:
            raise ValueError('Invalid Services review source page')
        if source.get('sha256') is not None and source['sha256'] != evidence['document_sha256']:
            raise ValueError('Services review linked document fingerprint differs')
        pages.add(page)
    # A continuation can use its own source page or the immediately preceding
    # page's merged service/material cell; unrelated report pages are excluded.
    if evidence['page'] not in pages and evidence['page'] + 1 not in pages:
        raise ValueError('Services review page is outside this item or its preceding continuation page')


def _validate_document(data, item, evidence):
    matches = [document for document in data.get('documents', [])
               if document.get('id') == evidence['document_id']]
    if len(matches) != 1:
        raise ValueError('Services review needs one registered PDF document')
    document = matches[0]
    if document.get('sha256') != evidence['document_sha256']:
        raise ValueError('Services review registered document fingerprint differs')
    pages = document.get('pages')
    if type(pages) is not int or not 1 <= evidence['page'] <= pages:
        raise ValueError('Services review page exceeds its registered document')
    _document_membership(item, evidence)


def validate_plan(data, index_sha256, plan):
    """Validate exact raw items; the old index hash is retained as lineage only."""
    _sha(index_sha256)
    _validate_shape(plan)
    originals = data['libraries']['technical']['items']
    if not isinstance(originals, list) or len(originals) > MAX_ITEMS:
        raise ValueError('Invalid Services review source inventory')
    by_id = {}
    for item in originals:
        key = _id(item['id'])
        if key in by_id:
            raise ValueError('Duplicate Services review source item')
        by_id[key] = item
    for row in plan['items']:
        original = by_id.get(row['id'])
        if original is None or fingerprint(original) != row['item_sha256']:
            raise ValueError('Services review source item changed; review must be updated')
        for evidence in row['evidence']:
            if 'document_id' in evidence:
                _validate_document(data, original, evidence)
    payload = json.dumps(plan, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    encoded = payload.encode('utf-8')
    if len(encoded) > MAX_PLAN_BYTES:
        raise ValueError('Services review size limit')
    return ValidatedReview(payload, hashlib.sha256(encoded).hexdigest())


def load_review(directory, data, index_sha256, expected_stamp):
    if expected_stamp is None:
        return None
    if plan_stamp(directory) != expected_stamp:
        raise ValueError('Services review changed before reading')
    with _path(directory).open('rb') as stream:
        payload = stream.read(MAX_PLAN_BYTES + 1)
    if len(payload) > MAX_PLAN_BYTES or plan_stamp(directory) != expected_stamp:
        raise ValueError('Services review changed while reading')
    return validate_plan(data, index_sha256, _decode(payload))


def _field_quote(item, evidence):
    matching = [field for field in item.get('fields', []) if field.get('label') == evidence['field']]
    for field in matching:
        texts = [field.get('value', '')]
        texts.extend(json.dumps(field[key], sort_keys=True, ensure_ascii=False, allow_nan=False)
                     for key in ('table', 'tables') if key in field)
        if any(isinstance(text, str) and evidence['quote'] in text for text in texts):
            return
    raise ValueError('Services review quote is absent from its named public field')


def project(public_records, discovery, review):
    """Preflight every reviewed item, then change only copied Services facets."""
    if review is None:
        return discovery
    if not isinstance(review, ValidatedReview):
        raise ValueError('Imported Services review capability')
    if not isinstance(review.payload, str) or hashlib.sha256(review.payload.encode('utf-8')).hexdigest() != review.sha256:
        raise ValueError('Services review capability fingerprint differs')
    plan = _decode(review.payload)
    _validate_shape(plan)
    for row in plan['items']:
        key = row['id']
        if (key not in public_records or key not in discovery
                or projection_fingerprint(public_records[key]) != row['projection_sha256']):
            raise ValueError('Services review public projection changed; review must be updated')
        for evidence in row['evidence']:
            if 'field' in evidence:
                _field_quote(public_records[key], evidence)
            else:
                _document_membership(public_records[key], evidence)
    if not plan['items']:
        return discovery
    result = deepcopy(discovery)
    for row in plan['items']:
        facets = result[row['id']]
        facets['services'] = (['N/A'] if set(facets.get('category', [])) & MOVED_SERVICE_CATEGORIES
                              else list(row['services']))
    return result
