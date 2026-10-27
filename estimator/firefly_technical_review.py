"""Private, source-bound Firefly site-substrate and navigation decisions.

The sidecar never changes imported records, assessed conditions or durable links.
Only validated public copies receive additive discovery facets and navigation.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re

from .firefly_reference_review import REPORTS, fingerprint
from .library_report_links import FIREFLY_REPORTS_URL, validate_report_links
from .library_substrates import _LABELS, _MATERIALS

PLAN_NAME = 'firefly-technical-plan-v1.json'
MAX_PLAN_BYTES = 8 * 1024 * 1024
REVIEW_KEY = '_firefly_technical_review'
SITE_SUBSTRATES = frozenset(_LABELS) | {'INEX floor'} | {
    f'{material} {kind}' for material, _ in _MATERIALS
    for kind in ('wall', 'floor', 'ceiling')}
_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,119}\Z')
_SHA = re.compile(r'[a-f0-9]{64}\Z')


@dataclass(frozen=True)
class ValidatedReview:
    """A Python-only capability; imported JSON cannot forge this runtime type."""
    payload: str
    sha256: str


def projection_fingerprint(record):
    return fingerprint({'fields': record.get('fields', []),
                        'substrates': record.get('filter_values', {}).get('substrate', [])})


def _path(directory):
    directory = Path(directory)
    path = directory / 'reviews' / PLAN_NAME
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError('Firefly technical review must remain inside the local library')
    return path


def plan_stamp(directory):
    path = _path(directory)
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file() or info.st_size > MAX_PLAN_BYTES:
        raise ValueError('Firefly technical review size or file type')
    return info.st_mtime_ns, info.st_size, info.st_ctime_ns


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate Firefly technical review key')
        result[key] = value
    return result


def _text(value, maximum=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('Invalid Firefly technical review text')
    return value


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError('Invalid Firefly technical review identity')
    return value


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError('Invalid Firefly technical review fingerprint')
    return value


def _reports(data):
    documents = {row['id']: row for row in data['documents']}
    for report, (_, digest) in REPORTS.items():
        if documents.get(report, {}).get('sha256') != digest:
            raise ValueError('Firefly technical review report evidence differs')
    return documents


def _identity(item, report, documents):
    systems = [field.get('value') for field in item.get('fields', [])
               if field.get('label') == 'ID']
    if len(systems) != 1:
        raise ValueError('Firefly technical review needs one original system ID')
    system = _text(systems[0], 1000)
    sources = [source for source in item.get('sources', [])
               if source.get('document_id') == report]
    if not sources or any(source.get('sha256') != REPORTS[report][1] for source in sources):
        raise ValueError('Firefly technical review source report differs')
    pages = [source.get('page') for source in sources]
    if any(type(page) is not int or not 1 <= page <= documents[report]['pages'] for page in pages):
        raise ValueError('Firefly technical review source page differs')
    return system, sorted(set(pages))


def _evidence(values, allowed, documents):
    if not isinstance(values, list) or not 1 <= len(values) <= 100:
        raise ValueError('Firefly technical review evidence limit')
    seen = set()
    for value in values:
        if not isinstance(value, dict) or set(value) != {'report_id', 'page', 'reference'}:
            raise ValueError('Invalid Firefly technical review evidence')
        report, page = value['report_id'], value['page']
        if report not in allowed or type(page) is not int or not 1 <= page <= documents[report]['pages']:
            raise ValueError('Firefly technical review citation differs')
        key = report, page, _text(value['reference'])
        if key in seen:
            raise ValueError('Duplicate Firefly technical review evidence')
        seen.add(key)


def validate_plan(data, index_sha256, plan):
    """Validate all source decisions before creating a projection capability."""
    if not isinstance(plan, dict) or set(plan) != {'schema_version', 'review_id', 'index_sha256', 'reports', 'scope', 'targets', 'items'}:
        raise ValueError('Invalid Firefly technical review schema')
    if type(plan['schema_version']) is not int or plan['schema_version'] != 1:
        raise ValueError('Unsupported Firefly technical review schema')
    _text(plan['review_id'], 120)
    if _sha(plan['index_sha256']) != index_sha256:
        raise ValueError('Firefly technical review uses another library index')
    expected = [{'id': key, 'revision': revision, 'sha256': digest}
                for key, (revision, digest) in sorted(REPORTS.items())]
    if plan['reports'] != expected:
        raise ValueError('Firefly technical review report revisions differ')
    documents = _reports(data)
    technical = {item['id']: item for item in data['libraries']['technical']['items']}
    scope = plan['scope']
    if not isinstance(scope, dict) or set(scope) != {'fas190235_count', 'fas190236_ids'} or type(scope['fas190235_count']) is not int or scope['fas190235_count'] != 321:
        raise ValueError('Firefly technical review scope differs')
    selected = scope['fas190236_ids']
    if not isinstance(selected, list) or len(selected) != 15 or len({_id(key) for key in selected}) != 15:
        raise ValueError('Firefly technical review needs exactly fifteen selected FAS190236 records')
    all235 = {key for key, item in technical.items() if any(
        source.get('document_id') == 'fas190235' for source in item.get('sources', []))}
    if len(all235) != 321 or all235.intersection(selected):
        raise ValueError('Firefly technical review must cover all 321 FAS190235 records')
    bindings = plan['targets']
    if not isinstance(bindings, list) or not 1 <= len(bindings) <= 5000:
        raise ValueError('Firefly Technical target binding limit')
    targets_by_id = {}
    for target in bindings:
        if not isinstance(target, dict) or set(target) != {'id', 'item_sha256', 'system_id', 'pages'}:
            raise ValueError('Invalid related Technical review')
        key = _id(target['id'])
        if key in targets_by_id or key not in technical:
            raise ValueError('Missing or duplicate related Technical record')
        other = technical[key]
        if _sha(target['item_sha256']) != fingerprint(other):
            raise ValueError('Related Technical source changed')
        identity, target_pages = _identity(other, 'fas190234', documents)
        if (not isinstance(target['pages'], list) or any(type(page) is not int for page in target['pages'])
                or target['system_id'] != identity or target['pages'] != target_pages):
            raise ValueError('Related Technical system/page identity differs')
        targets_by_id[key] = target
    entries = plan['items']
    if not isinstance(entries, list) or len(entries) != 336 or any(not isinstance(row, dict) for row in entries):
        raise ValueError('Firefly technical review inventory differs')
    if len({_id(row.get('id')) for row in entries}) != 336 or {row['id'] for row in entries} != all235 | set(selected):
        raise ValueError('Firefly technical review coverage differs')
    used_targets = set()
    for row in entries:
        if set(row) != {'id', 'item_sha256', 'projection_sha256', 'report_id', 'system_id', 'pages', 'substrates', 'related_technical', 'evidence'}:
            raise ValueError('Invalid Firefly technical item review')
        item = technical.get(row['id'])
        report = 'fas190235' if row['id'] in all235 else 'fas190236'
        if item is None or row['report_id'] != report or _sha(row['item_sha256']) != fingerprint(item):
            raise ValueError('Firefly technical item evidence differs')
        _sha(row['projection_sha256'])
        system, pages = _identity(item, report, documents)
        if (not isinstance(row['pages'], list) or any(type(page) is not int for page in row['pages'])
                or row['system_id'] != system or row['pages'] != pages):
            raise ValueError('Firefly technical item system/page identity differs')
        allowed = {'fas190234', 'fas190235'} if report == 'fas190235' else {'fas190236'}
        _evidence(row['evidence'], allowed, documents)
        if not any(value['report_id'] == report and value['page'] in pages for value in row['evidence']):
            raise ValueError('Firefly technical review needs its own source-page citation')
        substrates = row['substrates']
        if not isinstance(substrates, list) or not 1 <= len(substrates) <= 50:
            raise ValueError('Firefly technical review substrate limit')
        seen = set()
        for substrate in substrates:
            if (not isinstance(substrate, dict) or set(substrate) != {'value', 'evidence'}
                    or not isinstance(substrate['value'], str) or substrate['value'] not in SITE_SUBSTRATES
                    or substrate['value'] in seen):
                raise ValueError('Invalid or duplicate reviewed site substrate')
            seen.add(substrate['value'])
            _evidence(substrate['evidence'], allowed, documents)
        targets = row['related_technical']
        if (not isinstance(targets, list) or len(targets) > 5000
                or report == 'fas190236' and targets or report == 'fas190235' and not targets):
            raise ValueError('Firefly technical relationship limit')
        seen = set()
        for target in targets:
            key = _id(target)
            if key in seen or key not in targets_by_id:
                raise ValueError('Missing or duplicate related Technical record')
            seen.add(key)
            used_targets.add(key)
    if used_targets != set(targets_by_id):
        raise ValueError('Unused Firefly Technical target binding')
    payload = json.dumps(plan, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    encoded = payload.encode('utf-8')
    if len(encoded) > MAX_PLAN_BYTES:
        raise ValueError('Firefly technical review size limit')
    return ValidatedReview(payload, hashlib.sha256(encoded).hexdigest())


def load_review(directory, data, index_sha256, expected_stamp):
    if expected_stamp is None:
        return None
    with _path(directory).open('rb') as stream:
        payload = stream.read(MAX_PLAN_BYTES + 1)
    if len(payload) > MAX_PLAN_BYTES or plan_stamp(directory) != expected_stamp:
        raise ValueError('Firefly technical review changed while reading')
    plan = json.loads(payload, object_pairs_hook=_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    return validate_plan(data, index_sha256, plan)


def project(records, base_records, aliases, review, report_keys):
    """Return public copies plus one-way navigation and reviewed search labels."""
    if review is None:
        return records, {}, {}
    if not isinstance(review, ValidatedReview):
        raise ValueError('Imported Firefly technical review capability')
    entries = json.loads(review.payload)['items']
    # Complete preflight prevents a late changed projection from publishing a
    # partially augmented catalog. Original duplicate/source identities survive.
    for row in entries:
        if row['id'] not in records or projection_fingerprint(base_records[row['id']]) != row['projection_sha256']:
            raise ValueError('Firefly technical projection changed; review must be updated')
    result, related, additions = dict(records), {}, {}
    for row in entries:
        key = row['id']
        item = deepcopy(records[key])
        labels = [value['value'] for value in row['substrates']]
        current = item.setdefault('filter_values', {}).setdefault('substrate', [])
        current.extend(value for value in labels if value not in current)
        additions[key] = labels
        if row['report_id'] == 'fas190235':
            targets = list(dict.fromkeys(aliases.get(value, value) for value in row['related_technical']))
            if any(target not in records for target in targets):
                raise ValueError('Reviewed related Technical record is unavailable')
            related[key] = targets
            # Public facets/captions use the existing report IDs. Revisions are
            # retained in the private source proof, not introduced as new options.
            captions = [report.upper() for report in ('fas190234', 'fas190235')]
            fields = item.setdefault('fields', [])
            field = next((value for value in fields if value.get('label') == 'Report Number'), None)
            if field is None:
                field = {'label': 'Report Number', 'value': ''}
                fields.append(field)
            existing = [value.strip() for value in field.get('value', '').splitlines() if value.strip()]
            retained = [value for value in existing if not re.match(r'^FAS19023[45](?:\b|\s)', value, re.I)]
            field['value'] = '\n'.join(dict.fromkeys([*captions, *retained]))
            links = {value['label']: value for value in field.get('report_links', []) if value['label'] in retained}
            links.update({caption: {'label': caption, 'url': FIREFLY_REPORTS_URL} for caption in captions})
            field['report_links'] = [deepcopy(links[value]) for value in field['value'].splitlines() if value in links]
            field['report_separator'] = ' | '
            validate_report_links(field)
            for name in report_keys:
                values = item['filter_values'].setdefault(name, [])
                values.extend(value for value in captions if value not in values)
        result[key] = item
    for key, canonical in aliases.items():
        if key in additions and canonical in additions and (
                set(additions[key]) != set(additions[canonical])
                or set(related.get(key, [])) != set(related.get(canonical, []))):
            raise ValueError('Reviewed duplicate Technical records have different site applicability')
    return result, related, additions
