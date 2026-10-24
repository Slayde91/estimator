"""Read-only reference candidates, separate from installations and approval.

Explicit library associations win even when they have no Technical links.
Otherwise intersect recorded facets; never combine different service contexts
or infer dimensional/table suitability. Nothing here changes retained records.
"""
from collections import OrderedDict, defaultdict
from copy import deepcopy
from hashlib import sha256
import json
import re

from .catalog import ValidationError
from .firestopping_taxonomy import category_service, canonical_opening_type
from .library_report_links import valid_report_url

_DASHES = str.maketrans({value: '-' for value in '‐‑‒–—−'})
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_CACHE_BYTES = 8 * 1024 * 1024
_PLACEHOLDERS = {'', 'n/a', 'unknown', 'not specified', 'not recorded'}


def _encoded(value):
    # Match Handler.send_payload's actual JSON whitespace and UTF-8 expansion.
    return json.dumps(value, sort_keys=True, ensure_ascii=False).encode('utf-8')


def _bounded(size, maximum=MAX_RESPONSE_BYTES):
    if size > maximum:
        raise ValidationError('Register references exceed the safe response limit. Narrow the recorded context or read fewer rows.')


def _excel_length(value):
    return len(value.encode('utf-16-le')) // 2


def _excel_bound(size):
    if size > 32767:
        raise ValidationError('Register references exceed an Excel cell limit. Narrow the recorded context before downloading.')


def _context_digest(contexts):
    """Bound canonical encoding before retaining a fixed-size cache key."""
    encoder = json.JSONEncoder(sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    fingerprint, size = sha256(), 0
    for chunk in encoder.iterencode(contexts):
        payload = chunk.encode('utf-8'); size += len(payload)
        _bounded(size, MAX_CACHE_BYTES); fingerprint.update(payload)
    return fingerprint.digest()


def literal(value):
    return '' if value is None else str(value).strip()


def token(value):
    return ' '.join(literal(value).split()).casefold()


def frl(value):
    """Formatting equivalence only; do not discard any known FRL criterion."""
    text = re.sub(r'\s+', '', literal(value).translate(_DASHES))
    if re.fullmatch(r'(?:\d+|[-])/(?:\d+|[-])/(?:\d+|[-])', text):
        return '/'.join('-' if part == '0' else part for part in text.split('/'))
    return text


def criteria_for(service, barrier, owner, opening=None):
    from .penetration_calculator import canonical_service_type, canonical_substrate
    from .library_facets import canonical_services
    category, selected = category_service(service.get('service'), service.get('service_type'))
    result = {key: value for key, value in (
        ('category', category), ('services', canonical_services([canonical_service_type(selected)])[0]),
        ('substrate', canonical_substrate(barrier.get('substrate'))),
        ('orientation', literal(barrier.get('orientation'))),
        ('type', canonical_opening_type(barrier.get('barrier_type') or (opening or {}).get('opening_type'))),
        ('frl', frl(owner.get('frl')))) if token(value) not in _PLACEHOLDERS}
    return result


def physical_contexts(snapshot, scope, identifiers):
    """Each parent is the union of actual descendant contexts, never a join."""
    from .takeoff_physical import graph_collections, graph_parents
    key = {'defect_reports': 'physical', 'service_plans': 'service_plans'}.get(scope) if isinstance(scope, str) else None
    if key is None:
        raise ValidationError('Choose Defect Reports or Service Plans references.')
    graph = snapshot.get(key)
    if graph is None:
        if identifiers:
            raise ValidationError('The selected physical register is unavailable.')
        return {}
    parents = graph_parents(graph)
    index = {entity['id']: (kind, entity) for kind, collection in graph_collections(graph).items()
             for entity in graph[collection] if not entity['deleted']}
    children = defaultdict(list)
    for identifier, (kind, entity) in index.items():
        if kind in parents:
            children[entity[parents[kind][1]]].append(identifier)
    associations = defaultdict(set)
    for assignment in snapshot.get('library_assignments', {}).get('records', []):
        if assignment.get('scope') == scope:
            for member in assignment['members']:
                associations[member['id']].add(assignment['library']['id'])

    def context(identifier):
        lineage = {}
        current = identifier
        while current in index:
            kind, entity = index[current]
            lineage[kind] = entity['fields']
            if kind not in parents:
                break
            current = entity[parents[kind][1]]
        owner = lineage.get('barrier' if graph['version'] == 3 else 'defect', {})
        return {'library_ids': sorted(associations[identifier]),
                'criteria': criteria_for(lineage.get('service', {}), lineage.get('barrier', {}),
                                         owner, lineage.get('opening'))}

    result = {}
    for identifier in identifiers:
        if identifier not in index:
            raise ValidationError('A requested physical record changed or is unavailable.')
        contexts = []
        pending = [identifier]
        while pending:
            current = pending.pop()
            kind, _ = index[current]
            descendants = children.get(current, [])
            if associations[current] or kind == 'service' or not descendants:
                contexts.append(context(current))
            # A direct assignment owns this row's reference context, including
            # the deliberate absence of Technical links. Do not dilute it with
            # inferred descendant matches.
            if not associations[current]:
                pending.extend(descendants)
        result[identifier] = contexts
    return result


class ReferenceIndex:
    """One inverted index per effective library stamp; cached context matches."""
    def __init__(self, data, revision):
        from .penetration_calculator import canonical_service_type, canonical_substrate
        self.revision, self.data = revision, data
        self.records = data['_records']['technical'] if data else {}
        self.visible = set(data['_visible']['technical']) if data else set()
        self.facets, self.matches, self.reports = defaultdict(set), OrderedDict(), OrderedDict()
        self.match_bytes, self.report_bytes = 0, 0
        self.aliases = data.get('_aliases', {}) if data else {}
        for identifier in self.visible:
            item = self.records[identifier]
            values = deepcopy(item.get('filter_values', {}))
            discovery = data.get('_technical_discovery', {}).get(identifier, {})
            for name in ('category', 'services'):
                if name in discovery:
                    values[name] = discovery[name]
            for name in ('category', 'services', 'substrate', 'orientation', 'type', 'frl'):
                for value in values.get(name, []):
                    if name == 'services':
                        value = canonical_service_type(value)
                    elif name == 'substrate':
                        value = canonical_substrate(value)
                    elif name == 'type':
                        value = canonical_opening_type(value)
                    elif name == 'frl':
                        value = frl(value)
                        parts = value.split('/')
                        if len(parts) == 3 and parts[1].isdigit():
                            self.facets['frl_minutes', parts[1]].add(identifier)
                    self.facets[name, token(value)].add(identifier)

    def select(self, contexts):
        cache_key = _context_digest(contexts)
        if cache_key in self.matches:
            self.matches.move_to_end(cache_key)
            return self.matches[cache_key]
        found, modes = set(), set()
        for context in contexts:
            library_ids, criteria = context.get('library_ids', []), context.get('criteria', {})
            if library_ids:
                modes.add('linked')
                for library_id in library_ids:
                    for link in self.data['_links']['penetration'].get(library_id, []) if self.data else ():
                        identifier = self.aliases.get(link['id'], link['id'])
                        if link['kind'] == 'technical' and identifier in self.visible:
                            found.add(identifier)
            elif (token(criteria.get('services')) not in _PLACEHOLDERS
                  or token(criteria.get('substrate')) not in _PLACEHOLDERS):
                modes.add('filtered')
                selected = None
                for name, value in criteria.items():
                    name, value = ('frl_minutes', literal(value)) if name == 'frl' and literal(value).isdigit() else (name, token(value))
                    candidates = self.facets.get((name, value), set())
                    selected = set(candidates) if selected is None else selected.intersection(candidates)
                found.update(selected or ())
        ordered = sorted(found, key=lambda key: (self.manufacturer(key).casefold(), key))
        result = (tuple(ordered), 'mixed' if len(modes) > 1 else next(iter(modes), 'none'))
        size = len(cache_key) + sum(len(key.encode('utf-8')) + 8 for key in ordered)
        _bounded(size, MAX_CACHE_BYTES)
        self.matches[cache_key] = result
        self.match_bytes += size
        while len(self.matches) > 512 or self.match_bytes > MAX_CACHE_BYTES:
            key, value = self.matches.popitem(last=False)
            self.match_bytes -= len(key) + sum(len(identifier.encode('utf-8')) + 8 for identifier in value[0])
        return result

    def manufacturer(self, identifier):
        values = self.records[identifier].get('filter_values', {}).get('manufacturer', [])
        return ' / '.join(sorted(set(values), key=str.casefold)) or 'Manufacturer not recorded'

    def project(self, contexts, offset=0, limit=100, *, report_offset=0, report_limit=None, excel=False):
        identifiers, basis = self.select(contexts)
        report_limit = limit if report_limit is None else report_limit
        counts, ranks = defaultdict(int), {}
        for identifier in identifiers:
            manufacturer = self.manufacturer(identifier)
            counts[manufacturer] += 1; ranks[identifier] = counts[manufacturer]
        report_key = _context_digest(identifiers)
        if report_key not in self.reports:
            values, size = self._reports(identifiers)
            size += len(report_key)
            _bounded(size, MAX_CACHE_BYTES)
            self.reports[report_key] = (values, size)
            self.report_bytes += size
            while len(self.reports) > 512 or self.report_bytes > MAX_CACHE_BYTES:
                _, (_, old_size) = self.reports.popitem(last=False)
                self.report_bytes -= old_size
        self.reports.move_to_end(report_key)
        reports = self.reports[report_key][0]
        result = {'basis': basis, 'criteria_count': len(contexts), 'criteria_sha256': _context_digest(contexts).hex(),
                'reports': [], 'systems': [], 'report_total': len(reports), 'report_offset': report_offset,
                'report_limit': report_limit, 'report_has_more': report_offset + report_limit < len(reports),
                'total': len(identifiers), 'offset': offset, 'limit': limit,
                'has_more': offset + limit < len(identifiers)}
        size, report_characters, system_characters, previous_manufacturer = len(_encoded(result)), 0, 0, None
        for value in reports[report_offset:report_offset + report_limit]:
            size += len(_encoded(value)) + (2 if result['reports'] else 0); _bounded(size, MAX_RESPONSE_BYTES)
            if excel:
                report_characters += _excel_length(report_text([value])) + (3 if result['reports'] else 0)
                _excel_bound(report_characters)
            result['reports'].append(deepcopy(value))
        for key in identifiers[offset:offset + limit]:
            manufacturer = self.manufacturer(key)
            value = {'id': key, 'title': self.records[key]['title'], 'manufacturer': manufacturer, 'number': ranks[key]}
            size += len(_encoded(value)) + (2 if result['systems'] else 0); _bounded(size, MAX_RESPONSE_BYTES)
            if excel:
                caption = f"{ranks[key]} ({key})"
                addition = (', ' + caption) if previous_manufacturer == manufacturer else ((' | ' if result['systems'] else '') + manufacturer + '-' + caption)
                system_characters += _excel_length(addition); _excel_bound(system_characters)
            previous_manufacturer = manufacturer
            result['systems'].append(value)
        return result

    def _reports(self, identifiers):
        reports, size = {}, 2
        for identifier in identifiers:
            for field in self.records[identifier].get('fields', []):
                if field.get('label') != 'Report Number':
                    continue
                links = defaultdict(list)
                for link in field.get('report_links', []):
                    if valid_report_url(link.get('url')):
                        links[token(link['label'])].append(link['url'])
                for label in literal(field.get('value')).splitlines():
                    label = label.strip()
                    if label:
                        for url in links.get(token(label), [None]):
                            key = token(label)
                            existing = reports.get(key)
                            old_size = len(_encoded({'label': existing['label'], 'url': next(iter(existing['urls'])) if len(existing['urls']) == 1 else None})) if existing else 0
                            value = reports.setdefault(key, {'label': label, 'urls': set()})
                            if url and len(value['urls']) < 2:
                                value['urls'].add(url)
                            new_size = len(_encoded({'label': value['label'], 'url': next(iter(value['urls'])) if len(value['urls']) == 1 else None}))
                            size += new_size - old_size + (2 if existing is None and len(reports) > 1 else 0)
                            _bounded(size, MAX_CACHE_BYTES)
        # Caption identity includes its revision. Conflicting URLs for that
        # exact caption remain one plain caption, never a guessed hyperlink.
        report_values = [{'label': value['label'], 'url': next(iter(value['urls'])) if len(value['urls']) == 1 else None}
                         for value in reports.values()]
        report_values.sort(key=lambda row: (token(row['label']), row['url'] or ''))
        return report_values, size


def report_text(references):
    """Literal captions/URLs for exports; never Excel formulas or link markup."""
    return ' | '.join(value['label'] + (f" — {value['url']}" if value.get('url') else '')
                     for value in references)


def system_text(reference):
    groups = OrderedDict()
    for item in reference.get('systems', []):
        groups.setdefault(item['manufacturer'], []).append(f"{item['number']} ({item['id']})")
    return ' | '.join(f"{manufacturer}-{', '.join(items)}" for manufacturer, items in groups.items())


def library_batch(library, contexts, *, offset=0, limit=100, report_offset=0, expected_revision=None, excel=False):
    """Called with the library lock held; overlays change the cache epoch."""
    data = library._load()
    stamp = (id(data), library._stamp, getattr(library, '_effective_stamp', None))
    cached = getattr(library, '_register_reference_index', None)
    if cached is None or cached[0] != stamp:
        revision = sha256(repr(stamp).encode('utf-8')).hexdigest()
        cached = (stamp, ReferenceIndex(data, revision))
        library._register_reference_index = cached
    index = cached[1]
    if expected_revision is not None and expected_revision != index.revision:
        raise ValidationError('The reference library changed. Refresh the current register references.')
    result = {'library_revision': index.revision, 'row_references': {}}
    size = len(_encoded(result))
    for identifier, values in contexts.items():
        row = index.project(values, offset, limit, report_offset=report_offset, excel=excel)
        size += len(_encoded(identifier)) + 2 + len(_encoded(row)) + (2 if result['row_references'] else 0)
        _bounded(size, MAX_RESPONSE_BYTES - 512)
        result['row_references'][identifier] = row
    return result
