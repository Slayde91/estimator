"""User-requested discovery/display aliases outside source and review identities.

Reference records stay unchanged. These values are computed after duplicate
reviews, and presentation is applied only to response copies. They are search
labels, not replacement assessment evidence or a fire-resistance calculation.
"""
from copy import deepcopy
import re

from .library_facets import (MOVED_SERVICE_CATEGORIES, SERVICE_DISCOVERY_GENERALIZATIONS,
                             canonical_services, category_values, frl_values, service_values)
from .library_substrates import canonical_substrate


FRL_ALIASES = {
    '-/45/45': '-/30/30', '-/45/30': '-/30/30',
    '-/120/15': '-/120/-', '-/120/45': '-/120/30',
    '-/240/45': '-/240/30', '-/240/150': '-/240/120',
    '-/240/210': '-/240/180', '-/30/15': '-/30/-',
    '-/60/15': '-/60/-', '-/60/45': '-/60/30',
}
HIDDEN_FRL_CHOICES = frozenset({'-/15/-', '-/15/15'})
_DASHES = str.maketrans({char: '-' for char in '‐‑‒–—−'})
_CRITERION = r'(?:[-‐‑‒–—−]|\d+)'
_TRIPLE = re.compile(r'(?<![\w/])' + _CRITERION + r'\s*/\s*' + _CRITERION
                     + r'\s*/\s*' + _CRITERION + r'(?![\w/])')
_NOTE = re.compile(r'\bnotes?\s*:', re.I)
_NOTE_PARAGRAPH = re.compile(r'^\s*(?:[•*]\s*)?any\s+ratio\s+of\b', re.I)
_D_SERVICE = {'D1 Power Cables', 'D2 Comms Cables'}


def canonical_frl(value):
    if not isinstance(value, str):
        return value
    token = re.sub(r'\s+', '', value.translate(_DASHES))
    if not _TRIPLE.fullmatch(token):
        return value
    token = '/'.join('-' if part == '0' else part for part in token.split('/'))
    return FRL_ALIASES.get(token, token)


def present_frl_text(value, *, rating=False, known_ratings=()):
    if not isinstance(value, str):
        return value
    if rating and value.strip() == '0':
        return '-'
    known = {re.sub(r'\s+', '', token.translate(_DASHES)) for token in known_ratings}
    def replace(match):
        token = match[0].translate(_DASHES)
        context = value[max(0, match.start() - 16):match.start()]
        # A numeric triple elsewhere can be dimensions or service data. Only a
        # rating field, a dash-leading FRL, or explicit FRL context establishes it.
        if (rating or token.startswith('-') or re.sub(r'\s+', '', token) in known
                or re.search(r'\bfrl\s*:?\s*$', context, re.I)):
            return canonical_frl(match[0])
        return match[0]
    return _TRIPLE.sub(replace, value)


def _primary_text(value):
    """Exclude note sections, including the normalizer's unlabelled note paragraph."""
    value = _NOTE.split(value, maxsplit=1)[0]
    return '\n\n'.join(paragraph for paragraph in re.split(r'\n\s*\n', value)
                         if not (_NOTE_PARAGRAPH.match(paragraph) and
                                 re.search(r'\b(?:may|can)\s+be\s+included\b', paragraph, re.I)))


def discovery_facets(item, *, imported_services=None):
    # Scope only the classifier inputs; every source note remains in the record.
    fields = []
    mentioned_d = False
    for field in item.get('fields', []):
        if field.get('label') in {'Service', 'Service Size / Configuration'}:
            value = field.get('value', '')
            mentioned_d |= bool(re.search(r'\bD[12]\b', value, re.I))
            fields.append({**field, 'value': _primary_text(value)})
        else:
            fields.append(field)
    scoped = {**item, 'fields': fields}
    services = service_values(scoped)
    imported = list(item.get('filter_values', {}).get('services', [])
                    if imported_services is None else imported_services)
    if mentioned_d:
        imported = [value for value in imported if value not in _D_SERVICE or value in services]
    services = canonical_services(services + imported)
    services = sorted(set(services) | {SERVICE_DISCOVERY_GENERALIZATIONS[value.casefold()]
                      for value in imported if value.casefold() in SERVICE_DISCOVERY_GENERALIZATIONS})
    categories = set(category_values(scoped, services))
    moved = set(services) & MOVED_SERVICE_CATEGORIES
    if moved & {'Linear Joints', 'Movement Joints'} and 'Blank Seal' not in moved:
        categories.discard('Blank Seal')
    categories.update(moved)
    services = sorted({'Conduits' if value == 'Junction Box' else value for value in services
                       if value not in MOVED_SERVICE_CATEGORIES})
    # These are barrier/opening categories, even when a retained configuration
    # mentions a penetrant. Category is derived first and remains unchanged.
    if categories & MOVED_SERVICE_CATEGORIES:
        services = ['N/A']
    return {'category': sorted(categories), 'services': services,
            'substrate': list(dict.fromkeys(canonical_substrate(value) for value in item.get('filter_values', {}).get('substrate', []))),
            'frl': sorted({canonical_frl(value) for value in frl_values(item)})}


def present_technical(item, *, source_ratings=None):
    """Return a display copy; retained technical_basis and sources stay verbatim."""
    result = deepcopy(item)
    if 'substrate' in result.get('filter_values', {}):
        result['filter_values']['substrate'] = list(dict.fromkeys(canonical_substrate(value)
            for value in result['filter_values']['substrate']))
    source_ratings = frl_values(item) if source_ratings is None else source_ratings
    for key in ('title', 'subtitle', 'summary'):
        if key in result:
            result[key] = present_frl_text(result[key], known_ratings=source_ratings)
    for field in result.get('fields', []):
        field['value'] = present_frl_text(field.get('value', ''),
                                        rating=bool(re.search(r'\bfrl\b', field['label'], re.I)))
        for table in ([field['table']] if 'table' in field else []) + field.get('tables', []):
            columns = {index for index, label in enumerate(table['columns'])
                       if re.search(r'\bfrl\b', label.replace('_', ' '), re.I)}
            table['rows'] = [[present_frl_text(value, rating=True) if index in columns else value
                              for index, value in enumerate(row)] for row in table['rows']]
    return result
