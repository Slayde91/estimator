"""Portable Firestopping report selections, independent of calculation inputs."""
from copy import deepcopy
import json
import re

from .catalog import ValidationError
from .library_report_links import report_href
from .register_references import ReferenceIndex, criteria_for, physical_contexts, token

MAX_SELECTIONS = 128
REFERENCE_FIELDS = ('technical_reference_ids', 'takeoff_reference_ids')


def validate_report_reference(value):
    """A retained report caption is portable metadata, never a system selection."""
    if (not isinstance(value, str) or not value.strip() or value != value.strip()
            or len(value) > 1000 or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise ValidationError('Choose a valid Technical Library report.')
    return value


def validate_reference_ids(value):
    if (not isinstance(value, list) or len(value) > MAX_SELECTIONS
            or any(not isinstance(item, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,119}', item) for item in value)
            or len(set(value)) != len(value)):
        raise ValidationError('Choose up to 128 unique Technical Library references.')
    return list(value)


def _criteria(row):
    fields = row['inputs']
    return criteria_for({'service': fields.get('J'), 'service_type': fields.get('K')},
                        {'barrier_type': fields.get('L'), 'orientation': fields.get('M'), 'substrate': fields.get('P')},
                        {'frl': fields.get('N')})


def _takeoff_context(row, snapshot):
    source = row.get('takeoff_source')
    if not source or not snapshot or source['project_id'] != snapshot['project_id']:
        return None
    graph = snapshot.get('physical' if source['scope'] == 'defect_reports' else 'service_plans')
    if not graph or graph['id'] != source['graph_id']:
        return None
    if not any(item['id'] == source['service_id'] and not item['deleted'] for item in graph.get('services', [])):
        return None
    return physical_contexts(snapshot, source['scope'], [source['service_id']])[source['service_id']]


def _reports(ids, index, data):
    reports, _ = index._reports(ids)
    for report in reports:
        # The index already distinguishes reviewed catalog links from explicit
        # user-authored ones. Recheck the outbound boundary, never local assets.
        report['url'] = report_href(report['label'], report['url'], user_authored=True)
    return reports


def _report_choice(value, index, data, cache):
    if value not in cache:
        facet = next((entry for entry in (data or {}).get('_filters', {}).get('technical', [])
                      if entry['key'] in ('report', 'document')
                      and any(option['value'] == value for option in entry.get('options', []))), None)
        if facet is None:
            # Retain metadata after removal, but never publish an invented report.
            cache[value] = ([], None)
        else:
            ids = sorted(key for key in index.visible if value in
                         index.records[key].get('filter_values', {}).get(facet['key'], []))
            matches = [report for report in _reports(ids, index, data) if token(report['label']) == token(value)]
            cache[value] = (matches or [{'label': value, 'url': None}], facet['key'])
    return cache[value]


def _project(row, index, data, snapshot, report_cache):
    if 'technical_reference_ids' in row:
        selected, basis = row['technical_reference_ids'], 'selected'
    elif 'takeoff_reference_ids' in row:
        selected, basis = row['takeoff_reference_ids'], 'takeoff'
    else:
        context = _takeoff_context(row, snapshot)
        if context is not None:
            selected, _ = index.select(context)
            basis = 'takeoff'
        elif row.get('library_item_id'):
            selected, _ = index.select([{'library_ids': [row['library_item_id']]}])
            basis = 'library'
        else:
            # Matching facts prefilter the picker; they do not select reports.
            selected, basis = [], 'none'
    ids, missing = [], []
    for value in selected:
        key = index.aliases.get(value, value)
        if key not in index.visible:
            missing.append(value)
        elif key not in ids:
            ids.append(key)
    if len(ids) > MAX_SELECTIONS:
        raise ValidationError('This item has more than 128 report systems. Narrow its Technical Library selection.')
    reports = _reports(ids, index, data)
    available = {entry['key']: {token(option['value']): option['value'] for option in entry.get('options', [])}
                 for entry in (data or {}).get('_filters', {}).get('technical', [])}
    initial = {key: available[key][token(value)] for key, value in _criteria(row).items()
               if key in available and token(value) in available[key]}
    missing_report = None
    if row.get('report_reference'):
        chosen, facet = _report_choice(row['report_reference'], index, data, report_cache)
        known = {token(report['label']) for report in reports}
        reports.extend(dict(report) for report in chosen if token(report['label']) not in known)
        if facet:
            initial[facet] = row['report_reference']
        else:
            missing_report = row['report_reference']
    return {'reports': reports, 'systems': [{'id': key, 'title': index.records[key]['title'], 'number': number}
                                           for number, key in enumerate(ids, 1)],
            'basis': basis, 'initial_filters': initial, 'missing_ids': missing,
            'missing_report': missing_report}


def resolve_schedule_references(draft, library=None, *, snapshot=None):
    from .penetration_calculator import normalize_draft
    draft = normalize_draft(draft)
    report_cache = {}
    if library is None:
        data = None
        index = ReferenceIndex(None, '')
        rows = {row['id']: _project(row, index, data, snapshot, report_cache) for row in draft['rows']}
    else:
        with library._lock:
            data = library._load()
            # Reuse the validated library's revision-bound index and caches.
            library.register_references({})
            index = library._register_reference_index[1]
            rows = {row['id']: _project(row, index, data, snapshot, report_cache) for row in draft['rows']}
    result = {'row_references': rows}
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 8 * 1024 * 1024:
        raise ValidationError('Read fewer Firestopping reference rows at a time.')
    return result


def capture_transfer_references(draft, previous, snapshot, library):
    """Retain the existing Takeoffs references only for newly transferred rows."""
    existing = {row['id'] for row in previous['rows']}
    new = [row for row in draft['rows'] if row['id'] not in existing and row.get('takeoff_source')]
    if not new or library is None:
        return draft
    references = resolve_schedule_references({'globals': draft['globals'], 'rows': new}, library, snapshot=snapshot)['row_references']
    result = deepcopy(draft)
    for row in result['rows']:
        if row['id'] in references:
            row['takeoff_reference_ids'] = [item['id'] for item in references[row['id']]['systems']]
    return result
