"""Order eligible Technical Library records using only the supplied search and filters."""
from functools import lru_cache
from hashlib import sha256
import re

from .technical_prose import public_prose_fields


_DASH = r'[-‐‑‒–—−]'
_FRL = rf'(?:{_DASH}|\d+)(?:\s*/\s*(?:{_DASH}|\d+)){{2}}'
_UNITS = r'(?:mm[²³23]?|cm|m)'
_DIMENSION = rf'\d+(?:\.\d+)?\s*{_UNITS}(?!\w)'
_CODE = r'(?:cf|fco|fsv|frt|far|fsp|fas|fc|nb|dn)\s*\d+(?:[.-]\d+)*'
_PARTS = re.compile(rf'{_FRL}|{_DIMENSION}|{_CODE}(?!\w)|[^\W_]+(?:[._/‐‑‒–—−-][^\W_]+)*\+?', re.I)
_FACT_FIELDS = {'Service', 'Service Size / Configuration', 'Barrier Construction', 'System Products', 'FRL', 'Orientation'}
_FACETS = ('services', 'substrate', 'frl', 'type', 'orientation', 'category', 'manufacturer')
_SINGULAR = frozenset({'cable', 'collar', 'conduit', 'duct', 'floor', 'pipe', 'wall'})


def primary_fields(fields):
    return tuple(field['value'] for field in fields
                 if field['label'] in _FACT_FIELDS and field.get('value'))


@lru_cache(maxsize=65536)
def tie_key(record_id):
    # Unlike the public sequential number or the supplier's key prefix, this
    # does not sort tied records by supplier, alphabet or arrival time.
    return sha256(record_id.encode('utf-8')).digest()


def _term(text):
    if re.fullmatch(_FRL, text):
        return r'\s*/\s*'.join(_DASH if re.fullmatch(_DASH, part.strip()) else part.strip()
                               for part in text.split('/'))
    dimension = re.fullmatch(rf'(\d+(?:\.\d+)?)\s*({_UNITS})', text)
    if dimension:
        value, unit = dimension.groups()
        return re.escape(value) + r'[ \t]*' + re.escape(unit)
    code = re.fullmatch(r'([a-z]+)[ \t-]*(\d+(?:[.-]\d+)*)', text)
    if code:
        return re.escape(code[1]) + r'[ \t-]*' + re.escape(code[2])
    singular = text.removesuffix('s')
    if singular in _SINGULAR:
        return singular + 's?'
    return re.escape(text)


def _bounded(term, literal):
    # Numeric searches may meet a unit, but never match part of a larger
    # number or the fractional part of a different dimension.
    if literal.isdecimal():
        return rf'(?<!\d\.)(?<![^\W_]){term}(?!\.\d)(?=(?:{_UNITS})\b|[\W_]|$)'
    if re.fullmatch(_DIMENSION, literal):
        return rf'(?<!\d\.)(?<![^\W_]){term}(?![^\W_])'
    return rf'(?<![^\W_]){term}(?![^\W_])'


class TechnicalQuery:
    def __init__(self, search):
        self.search = search
        words = _PARTS.findall(search.casefold())
        parts = [_bounded(_term(word), word) for word in words]
        self.terms = []
        for word, part in dict.fromkeys(zip(words, parts)):
            # A cheap required substring avoids a boundary-regex scan of long
            # report notes when a term is absent. Unit/code separators may vary.
            fragments = re.findall(r'[^\W\d_]+|\d+', word)
            needle = max(fragments, key=len, default='')
            if needle.removesuffix('s') in _SINGULAR:
                needle = needle.removesuffix('s')
            self.terms.append((needle, re.compile(part, re.I)))
        self.phrase = re.compile(r'[^\w\n]+'.join(parts), re.I) if parts else None

    def rank(self, item, facets, public_id, evidence, *, direct_service, field_values=None):
        """Return an ascending sort key, or None when a requested term is absent."""
        if not self.search:
            return (-int(direct_service),)
        if not self.terms:
            return None

        identifiers = [public_id] if public_id else []
        reports = list(facets.get('report', []))
        facts = [value for key in _FACETS for value in facets.get(key, [])]
        for field in item.get('fields', []):
            if field['label'] == 'Report Number':
                reports.extend(field.get('value', '').splitlines())
        if field_values is None:
            field_values = primary_fields(public_prose_fields(item))
        facts.extend(field_values)
        technical = '\n'.join(facts)
        codes = '\n'.join(identifiers + reports)
        strongest = direct_hits = 0
        for needle, term in self.terms:
            if term.search(codes):
                strongest += 1
            elif term.search(technical):
                direct_hits += 1
            elif needle not in evidence or not term.search(evidence):
                return None
        direct_phrase = bool(self.phrase.search(technical))
        return (-int(bool(public_id and self.phrase.fullmatch(public_id))),
                -int(any(self.phrase.fullmatch(report) for report in reports)),
                -int(direct_service),
                -int(any(self.phrase.fullmatch(value) for value in facts)),
                -strongest, -direct_hits, -int(direct_phrase),
                -int(direct_phrase or bool(self.phrase.search(evidence))))
