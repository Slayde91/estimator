"""Classify substrate orientation without reading service or table alternatives.

Selector records may occur in several searches. Their shared display fields can
omit the barrier type, so retain each matched query's type as private evidence.
"""

import re


_BARRIER_ORIENTATIONS = {
    'wall': 'Vertical', 'walls': 'Vertical',
    'shaft wall': 'Vertical', 'shaft walls': 'Vertical',
    'floor': 'Horizontal', 'floors': 'Horizontal',
    'ceiling': 'Horizontal', 'ceilings': 'Horizontal',
}
_ORDER = ('Horizontal', 'Vertical')
_BARRIER_LABELS = {'Fire Barrier Type (Selector Search)', 'Barrier Type'}
_SUBSTRATE_LABELS = {'Substrate (Selector Search)', 'Separating Element',
                     'Support Construction', 'Barrier Construction'}


class SelectorOrientationContext:
    """Index the complete captured query membership once per library load."""

    def __init__(self, capture):
        if not isinstance(capture, dict) or not isinstance(capture.get('queries'), dict):
            raise ValueError('Invalid substrate orientation query index.')
        self.capture = capture
        self.record_queries = {}
        for category, queries in capture['queries'].items():
            if not isinstance(category, str) or not isinstance(queries, dict):
                raise ValueError('Invalid substrate orientation query category.')
            membership = self.record_queries.setdefault(category, {})
            for key, query in queries.items():
                if (not isinstance(key, str) or not 1 <= len(key) <= 120
                        or not isinstance(query, dict) or query.get('query_id') != key
                        or not isinstance(query.get('record_ids'), list)
                        or not isinstance(query.get('selected_options', {}), dict)):
                    raise ValueError('Invalid substrate orientation query.')
                record_ids = query['record_ids']
                if (any(not isinstance(record_id, str) or not 1 <= len(record_id) <= 120 for record_id in record_ids)
                        or len(set(record_ids)) != len(record_ids)):
                    raise ValueError('Invalid substrate orientation record membership.')
                for record_id in record_ids:
                    membership.setdefault(record_id, set()).add(key)


def prepare_selector_orientation_context(capture):
    if capture is None or isinstance(capture, SelectorOrientationContext):
        return capture
    return SelectorOrientationContext(capture)


def _orientations(values):
    result = set()
    for value in values:
        # Only selected substrate fields are supplied here, never service names,
        # installation instructions, table cells or diagram alternatives.
        if re.search(r'\b(?:floors?|ceilings?)\b', value, re.I):
            result.add('Horizontal')
        if re.search(r'\bwalls?\b', value, re.I):
            result.add('Vertical')
    return [value for value in _ORDER if value in result]


def selector_orientation_basis(matched_queries, capture_sha256):
    """Retain exact barrier type labels for all classified selector queries.

    Older or incomplete captures can lack a selected barrier type. Do not create
    partial query evidence, which could silently lose a supported orientation.
    """
    rows = []
    for query in matched_queries:
        choices = [choice for name, choice in query.get('selected_options', {}).items()
                   if name.endswith('fire-barrier-type')]
        if len(choices) != 1:
            return None
        choice = choices[0]
        if (not isinstance(choice, dict) or choice.get('is_all')
                or choice.get('is_placeholder') or choice.get('disabled')):
            return None
        label = choice.get('label', '')
        if not isinstance(label, str) or label.strip().casefold() not in _BARRIER_ORIENTATIONS:
            return None
        rows.append({'query_id': query['query_id'], 'barrier_type': label})
    return {'capture_sha256': capture_sha256, 'queries': rows} if rows else None


def _query_basis(item, capture):
    provenance = item.get('selector_provenance')
    if capture is None or provenance is None:
        return None
    if not isinstance(provenance, dict):
        raise ValueError('Invalid substrate orientation capture.')
    context = prepare_selector_orientation_context(capture)
    capture = context.capture
    capture_hash = capture.get('capture_sha256')
    if (not isinstance(capture_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', capture_hash)
            or capture_hash != provenance.get('capture_sha256')):
        raise ValueError('Substrate orientation evidence belongs to another capture.')
    record = provenance.get('record', {})
    expected = record.get('query_ids') if isinstance(record, dict) else None
    if (not isinstance(expected, list) or not 1 <= len(expected) <= 2000
            or any(not isinstance(key, str) or not 1 <= len(key) <= 120 for key in expected)
            or len(set(expected)) != len(expected)):
        raise ValueError('Substrate orientation evidence must cover every matched query.')
    record_id = record.get('record_id')
    category = provenance.get('category')
    if not isinstance(record_id, str) or not isinstance(category, str):
        raise ValueError('Invalid substrate orientation source record.')
    complete = context.record_queries.get(category, {}).get(record_id, set())
    if set(expected) != complete:
        raise ValueError('Substrate orientation evidence must cover every matched query.')
    all_queries = capture.get('queries', {})
    if not isinstance(all_queries, dict):
        raise ValueError('Invalid substrate orientation query index.')
    queries = all_queries.get(provenance.get('category'), {})
    if not isinstance(queries, dict):
        raise ValueError('Invalid substrate orientation query category.')
    matched = []
    for key in expected:
        query = queries.get(key)
        if (not isinstance(query, dict) or query.get('query_id') != key
                or not isinstance(query.get('record_ids'), list)
                or not isinstance(record.get('record_id'), str)
                or record['record_id'] not in query['record_ids']
                or not isinstance(query.get('selected_options', {}), dict)):
            raise ValueError('Substrate orientation evidence does not match the source queries.')
        matched.append(query)
    basis = selector_orientation_basis(matched, capture_hash)
    if basis is None:
        return None
    explicit = [field.get('value', '') for field in item.get('fields', [])
                if field.get('label') in _BARRIER_LABELS]
    result = _orientations([query['barrier_type'] for query in basis['queries']])
    if explicit and _orientations(explicit) != result:
        raise ValueError('Substrate orientation evidence conflicts with the selected barrier type.')
    return basis


def trafalgar_orientations(item, selector_capture=None):
    """Return the entry's substrate orientations; do not expand source options."""
    if not item.get('id', '').startswith('trafalgar-'):
        return []
    basis = _query_basis(item, selector_capture)
    if basis:
        return _orientations([query['barrier_type'] for query in basis['queries']])
    fields = item.get('fields', [])
    explicit = [field.get('value', '') for field in fields
                if field.get('label') in _BARRIER_LABELS]
    if explicit:
        return _orientations(explicit)
    return _orientations([field.get('value', '') for field in fields
                          if field.get('label') in _SUBSTRATE_LABELS])


def project_trafalgar_orientation(projected, source, selector_capture=None):
    """Apply one consistent display field and filter to an existing deep copy."""
    selector_capture = prepare_selector_orientation_context(selector_capture)
    orientations = trafalgar_orientations(source, selector_capture)
    if not orientations:
        return projected
    projected['fields'] = [field for field in projected['fields'] if field['label'] != 'Orientation']
    position = next((index + 1 for index, field in enumerate(projected['fields'])
                     if field['label'] == 'Barrier Type'),
                    next((index for index, field in enumerate(projected['fields'])
                          if field['label'] == 'Barrier Construction'), len(projected['fields'])))
    projected['fields'].insert(position, {'label': 'Orientation', 'value': ' / '.join(orientations)})
    projected.setdefault('filter_values', {})['orientation'] = orientations
    basis = _query_basis(source, selector_capture)
    if basis:
        projected['technical_basis']['orientation'] = basis
    return projected
