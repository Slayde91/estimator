"""Source-bound Firefly reference reviews; licensed review data stays local.

The review changes reference navigation only. Original workbook inputs, prices,
diagrams and assessed Technical records are never replaced by this projection.
Saved user edits and manual relationships are applied by FirestoppingLibrary
after this supplier projection.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re


PLAN_NAME = 'firefly-reference-plan-v1.json'
MAX_PLAN_BYTES = 8 * 1024 * 1024
REPORTS = {
    'fas190234': ('FAS190234 RIR1.14', '36c8e16b04e1d6394f15db1d4e4a7944f5f42c692f396e0d629c279b11443fe4'),
    'fas190235': ('FAS190235 RIR1.29G', 'a61e53af7ad9d54fbec0302ddc90ee261248ac8e73d54504cef5319295722819'),
    'fas190236': ('FAS190236 RIR1.25A', '8591513cd147a765901a9676e2b115e8ab9f52508c94096f886c4f0d4fcc4f08'),
}
REQUIRED_REPORTS = {
    'batt-only': {'fas190234'},
    'batt-and-service': {'fas190234', 'fas190235'},
    'service-only': {'fas190236'},
}
REVIEW_LABELS = {'Reference review', 'Reference qualification', 'References not established'}
_SHA = re.compile(r'[0-9a-f]{64}\Z')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def firefly_item(item):
    """Use an explicit manufacturer, never incidental product instructions."""
    names = item.get('filter_values', {}).get('manufacturer', [])
    if not names:
        names = [f.get('value', '') for f in item.get('fields', [])
                 if f.get('label', '').casefold() == 'manufacturer']
    return any(isinstance(name, str) and name.strip().casefold() == 'firefly' for name in names)


def diagram_identity(item, images):
    return [{'id': image['id'], 'sha256': images[image['id']]['sha256']}
            for image in item.get('images', [])]


def _plan_path(directory):
    directory = Path(directory)
    path = directory / 'reviews' / PLAN_NAME
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError('Firefly review must remain inside the local library')
    return path


def plan_stamp(directory):
    path = _plan_path(directory)
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file() or info.st_size > MAX_PLAN_BYTES:
        raise ValueError('Firefly review size or file type')
    return info.st_mtime_ns, info.st_size, info.st_ctime_ns


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate Firefly review key')
        value[key] = item
    return value


def _text(value, maximum=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('Invalid Firefly review text')
    return value


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError('Invalid Firefly review fingerprint')
    return value


def apply_review(data, index_sha256, plan):
    """Validate the entire review before changing any parsed supplier record."""
    if not isinstance(plan, dict) or set(plan) != {
            'schema_version', 'review_id', 'index_sha256', 'reports', 'items'}:
        raise ValueError('Invalid Firefly review schema')
    if type(plan['schema_version']) is not int or plan['schema_version'] != 1:
        raise ValueError('Unsupported Firefly review schema')
    _text(plan['review_id'], 120)
    if _sha(plan['index_sha256']) != index_sha256:
        raise ValueError('Firefly review uses another library index')
    expected_reports = [{'id': key, 'revision': revision, 'sha256': sha}
                        for key, (revision, sha) in sorted(REPORTS.items())]
    if plan['reports'] != expected_reports:
        raise ValueError('Firefly review report revisions differ')
    documents = {item['id']: item for item in data['documents']}
    if any(documents.get(key, {}).get('sha256') != sha for key, (_, sha) in REPORTS.items()):
        raise ValueError('Firefly review report evidence differs')
    items = {item['id']: item for item in data['libraries']['penetration']['items']
             if firefly_item(item)}
    technical = {item['id']: item for item in data['libraries']['technical']['items']}
    images = {item['id']: item for item in data.get('images', [])}
    entries = plan['items']
    if not isinstance(entries, list) or len(entries) > 100000:
        raise ValueError('Firefly review item limit')
    if len(entries) != len(items) or {entry.get('id') for entry in entries} != set(items):
        raise ValueError('Firefly review must cover every current Firefly supplier item once')
    prepared = []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {
                'id', 'item_sha256', 'diagrams', 'classification', 'status',
                'basis', 'targets', 'unresolved'}:
            raise ValueError('Invalid Firefly item review')
        original = items[entry['id']]
        if _sha(entry['item_sha256']) != fingerprint(original):
            raise ValueError('Firefly item review evidence differs')
        if entry['diagrams'] != diagram_identity(original, images):
            raise ValueError('Firefly diagram review evidence differs')
        classification = entry['classification']
        if classification not in REQUIRED_REPORTS:
            raise ValueError('Unknown Firefly physical batt/service classification')
        status = entry['status']
        if status not in {'exact', 'retained', 'candidate', 'unresolved'}:
            raise ValueError('Unknown Firefly review status')
        basis, unresolved = entry['basis'], entry['unresolved']
        if not isinstance(basis, list) or not 1 <= len(basis) <= 20:
            raise ValueError('Firefly review basis limit')
        if not isinstance(unresolved, list) or len(unresolved) > 20:
            raise ValueError('Firefly unresolved review limit')
        for text in basis + unresolved:
            _text(text)
        targets = entry['targets']
        if not isinstance(targets, list) or len(targets) > 3:
            raise ValueError('Firefly target review limit')
        seen, matched_reports, matches, links = set(), set(), set(), []
        for target in targets:
            if not isinstance(target, dict) or set(target) != {
                    'id', 'item_sha256', 'report_id', 'system_id', 'page', 'match', 'reason'}:
                raise ValueError('Invalid Firefly target review')
            key, report = target['id'], target['report_id']
            if (key in seen or key not in technical or report in matched_reports
                    or report not in REQUIRED_REPORTS[classification]):
                raise ValueError('Invalid or duplicate Firefly target')
            seen.add(key)
            item = technical[key]
            if _sha(target['item_sha256']) != fingerprint(item):
                raise ValueError('Firefly target evidence differs')
            system = next((f['value'] for f in item.get('fields', []) if f.get('label') == 'ID'), None)
            if target['system_id'] != system or not isinstance(system, str):
                raise ValueError('Firefly target system identity differs')
            page = target['page']
            if type(page) is not int or not any(
                    source.get('document_id') == report and source.get('page') == page
                    and source.get('sha256') == REPORTS[report][1]
                    for source in item.get('sources', [])):
                raise ValueError('Firefly target report/page identity differs')
            match = target['match']
            if match not in {'exact', 'retained', 'candidate'}:
                raise ValueError('Unknown Firefly target confidence')
            reason = _text(target['reason'])
            matched_reports.add(report)
            matches.add(match)
            prefix = {'exact': 'Source reference match', 'retained': 'Retained source reference',
                      'candidate': 'Candidate reference — review required'}[match]
            relationship = (f'{prefix}: {REPORTS[report][0]}, {system}, PDF page {page}. '
                            f'{reason} Verify the assessed configuration and conditions.')
            links.append({'penetration_id': entry['id'], 'technical_id': key,
                          'relationship': relationship})
        complete = matched_reports == REQUIRED_REPORTS[classification]
        if status == 'exact' and (not complete or matches != {'exact'} or unresolved):
            raise ValueError('Exact Firefly review is incomplete')
        if status == 'retained' and (not complete or 'candidate' in matches or unresolved):
            raise ValueError('Retained Firefly review is incomplete')
        if status == 'candidate' and (not complete or 'candidate' not in matches or unresolved):
            raise ValueError('Candidate Firefly review is incomplete')
        if status == 'unresolved' and not unresolved:
            raise ValueError('Unresolved Firefly review needs an explicit limitation')
        notice = ('Reference matches are navigation aids, not an assessment of compliance. '
                  + ' '.join(basis))
        if status == 'candidate':
            notice = 'Candidate matches require configuration review. ' + notice
        fields = [deepcopy(field) for field in original.get('fields', [])
                  if field.get('label') not in REVIEW_LABELS]
        fields.append({'label': 'Reference review', 'value': notice})
        if 'candidate' in matches:
            fields.append({'label': 'Reference qualification',
                           'value': ('Best matching active reference selected; configuration equivalence is not established. '
                                     + ' '.join(basis) + '\n'
                                     + '\n'.join(target['reason'] for target in targets
                                                 if target['match'] == 'candidate'))})
        if unresolved:
            fields.append({'label': 'References not established',
                           'value': '\n'.join(unresolved)})
        prepared.append((original, fields, links))
    # An index can contain explicit user-origin edges; supplier reviews cannot
    # remove them. Database manual links/unlinks are applied afterward as usual.
    links = [link for link in data['links']
             if link['penetration_id'] not in items or link.get('origin') == 'user']
    pairs = {(link['penetration_id'], link['technical_id']) for link in links}
    for item, fields, additions in prepared:
        item['fields'] = fields
        for link in additions:
            pair = link['penetration_id'], link['technical_id']
            if pair not in pairs:
                links.append(link)
                pairs.add(pair)
    data['links'] = links


def load_review(directory, data, index_sha256, expected_stamp):
    if expected_stamp is None:
        return
    path = _plan_path(directory)
    with path.open('rb') as stream:
        payload = stream.read(MAX_PLAN_BYTES + 1)
    if len(payload) > MAX_PLAN_BYTES or plan_stamp(directory) != expected_stamp:
        raise ValueError('Firefly review changed while reading')
    plan = json.loads(payload, object_pairs_hook=_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    apply_review(data, index_sha256, plan)
