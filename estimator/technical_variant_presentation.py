"""Human-readable headings for source-bound, generated Technical Library variants."""
from collections import defaultdict
from functools import lru_cache
import re

from .technical_discovery import canonical_frl, present_frl_text
from .technical_display import readable_technical_text
from .technical_table_navigation import field_tables


_PROMAT_ID = re.compile(r'sys_var_\d+_au', re.I)
_BARRIER_RATING = re.compile(
    r'\s+capable of (?:a )?(?:min(?:imum|\.)? )?FRL (?:of )?'
    r'((?:-|\d+)\s*/\s*(?:-|\d+)\s*/\s*(?:-|\d+))\s*(?:\(item \d+\))?\.?\s*$', re.I)


@lru_cache(maxsize=512)
def _short(value, limit=120):
    text = ' '.join(readable_technical_text(value).split())
    if len(text) <= limit:
        return text
    return text[:limit - 1].rsplit(' ', 1)[0] + '…'


def _fields(record):
    return {field['label']: field.get('value', '').strip() for field in record.get('fields', [])}


def _selected_cells(record, scopes):
    """Use only the scoped rows, after validated review and table remapping."""
    cells = {}
    for field in record.get('fields', []):
        label = field['label']
        tables = field_tables(field)
        for index in scopes.get(label, ()):
            if index >= len(tables):  # A manual edit can remove a table.
                continue
            table = tables[index]
            for column, name in enumerate(table['columns']):
                values = dict.fromkeys(row[column].strip() for row in table['rows'] if row[column].strip())
                if values:
                    cells[label, index, name] = ' / '.join(values)
    return cells


def _source_code(cells, parent):
    # Promat groups many supplier IDs under one parent. The ID column in the
    # selected source row identifies the actual system, including its prefix.
    fields = _fields(parent)
    code = fields.get('ID') or fields.get('System') or ''
    if 'Promat' in parent.get('filter_values', {}).get('manufacturer', ()):
        selected = {value for (_, _, name), value in cells.items()
                    if name.casefold() == 'id' and _PROMAT_ID.fullmatch(value)}
        if len(selected) == 1:
            return selected.pop()
        if 'variants listed below' in code.casefold():
            return ''
    return code


def _configuration(record, fields):
    facets = record.get('filter_values', {})
    size = _short(fields.get('Service Size / Configuration', ''))
    service = _short(fields.get('Service') or ', '.join(facets.get('services', [])))
    barrier = fields.get('Barrier Construction') or ', '.join(facets.get('substrate', []))
    # Keep separate barrier ratings. A trailing restatement of the selected
    # FRL can be left to the rating at the end of the heading.
    rating = _BARRIER_RATING.search(barrier)
    if rating and canonical_frl(rating[1]) in facets.get('frl', []):
        barrier = barrier[:rating.start()]
    barrier = _short(barrier)
    parts = [size, barrier, _short(fields.get('Installation Configuration', ''))]
    if service and service != 'N/A' and service.casefold() not in size.casefold():
        parts.insert(0, service)
    # The fixing substrate belongs to the adjacent wall, not the ceiling.
    adjacent = re.search(r'(?:^|\n)Adjacent firewall:\s*([^\n.]+)', fields.get('Source Options', ''))
    if adjacent:
        parts.append('Adjacent firewall: ' + adjacent[1].strip())
    return list(dict.fromkeys(value for value in parts if value))


def _heading(record, code, parts):
    facets = record.get('filter_values', {})
    manufacturer = ', '.join(facets.get('manufacturer', []))
    ratings = facets.get('frl', [])
    orientation = ', '.join(facets.get('orientation', []))
    configuration = ' · '.join(dict.fromkeys(value for value in [*parts, *ratings, orientation] if value))
    configuration = present_frl_text(configuration, known_ratings=ratings)
    return {'source_code': code, 'configuration': configuration,
            'title': ' — '.join(filter(None, [': '.join(filter(None, [manufacturer, code])), configuration]))}


def _qualifiers(record, scopes):
    """Retain source column labels so wrapped/unwrapped ratings stay distinct."""
    return {address: address[-1] + ': ' + _short(value, 150)
            for address, value in _selected_cells(record, scopes).items()
            if address[-1].casefold() not in {'id', 'configuration', 'source configuration', '*'}}


def build_variant_displays(data):
    records = data['_technical_public_records']
    sources = data['_technical_variant_sources']
    scopes = data['_technical_variant_table_scopes']
    pending, result = defaultdict(list), {}
    for key, lineage in data['_technical_variant_lineage'].items():
        if key not in records:
            continue
        item = records[key]
        parent = lineage['parent_id']
        code = _source_code(_selected_cells(item, scopes.get(key, {})), data['_records']['technical'][parent])
        parts = _configuration(item, _fields(item))
        display = _heading(item, code, parts)
        # Include the original family member when finding ambiguous siblings.
        pending[parent, display['title']].append(key)
        if key in sources:
            result[key] = (item['title'], (), display)

    for group in pending.values():
        if len(group) < 2:
            continue
        facts = {key: _qualifiers(records[key], scopes.get(key, {})) for key in group}
        remaining = [group]
        while remaining:
            siblings = remaining.pop()
            # Choose the shortest source-labelled fact that separates the most
            # siblings. Repeat only for any group which remains ambiguous.
            candidates = {}
            for address in dict.fromkeys(address for key in siblings for address in facts[key]):
                values = {facts[key].get(address, '') for key in siblings}
                if len(values) > 1:
                    candidates[address] = (-len(values), '' in values, max(map(len, values)), address)
            if not candidates:
                continue
            chosen = min(candidates, key=candidates.get)
            partitions = defaultdict(list)
            for key in siblings:
                value = facts[key].get(chosen, '')
                partitions[value].append(key)
                if value and key in result:
                    raw, previous, display = result[key]
                    parts = _configuration(records[key], _fields(records[key]))
                    addresses = (*previous, chosen)
                    parts.extend(facts[key][address] for address in addresses)
                    result[key] = (raw, addresses, _heading(records[key], display['source_code'], parts))
            remaining.extend(keys for keys in partitions.values() if len(keys) > 1)
    return result


def variant_display(data, key):
    """Return presentation only for a generated record with a verified source."""
    entry = data.get('_technical_variant_display', {}).get(key)
    if entry is None or key not in data['_technical_public_records']:
        return {}
    raw_title, addresses, display = entry
    if key not in data.get('_manual_technical_sources', {}):
        return dict(display)
    item = data['_technical_public_records'][key]
    fields = _fields(item)
    code = fields.get('ID')
    if not code or code == key:
        code = display['source_code']
    parts = _configuration(item, fields)
    if addresses:
        facts = _qualifiers(item, data['_technical_variant_table_scopes'].get(key, {}))
        parts.extend(facts[address] for address in addresses if address in facts)
    current = _heading(item, code, parts)
    if item['title'] != raw_title:
        current['title'] = item['title'].replace(key, code)
        current['subtitle'] = ' — '.join(filter(None, [code, current['configuration']]))
    return current
