"""Summarize observed rating triples without deriving fire-performance rules.

The caller selects the applicable rating cells and retains their source tables.
A range describes only the lowest and highest observed triples, not approval of
intermediate ratings or transfer of a rating between wall/floor configurations.
"""

import re


_DASHES = str.maketrans({c: '-' for c in '\u2010\u2011\u2012\u2013\u2014\u2212'})
_TRIPLE = re.compile(r'(?<![\w/.\-])(-|[0-9]+)\s*/\s*(-|[0-9]+)\s*/\s*(-|[0-9]+)(?![\w/]|\.[0-9])')
_PREFIX = re.compile(r'^\s*FRL\s*:?\s*', re.IGNORECASE)
_RANGE_JOIN = re.compile(r'(?<=[0-9])-(?=(?:-|[0-9]+)\s*/)')
_EXPRESSION = re.compile(r'\s*R(?:(?:\s*(?:to|and|or|[-,;|&])\s*|\s+)R)*\s*\.?\s*', re.IGNORECASE)
_PARTIAL = re.compile(r'(?:[0-9]|-)\s*/|/\s*(?:[0-9]|-)')


def _format(rating):
    return '/'.join('-' if value is None else str(value) for value in rating)


def _append_unique(values, value):
    if value not in values:
        values.append(value)


def summarize_ratings(values: list[str]) -> dict:
    """Return a conservative summary plus source values needing preservation.

    ``summary`` is blank if any supplied cell is blank, malformed, unrecognized
    or qualified. ``ratings`` contains only complete observed triples; callers
    must not use it to bypass ``unparsed``, ``qualified`` or ``empty_count``.
    The originals in ``unparsed`` and ``qualified`` are returned unchanged.

    Bare triples, lists and explicit endpoint ranges are accepted. An optional
    ``FRL:`` prefix and a trailing full stop are formatting, not qualifications.
    Durations are compared only when every triple has the same dash positions.
    Each numeric component must be nondecreasing through the observed triples.
    Incomparable triples or different dash positions produce a distinct list
    in source order, never synthesized component minima or maxima.

    This function does not select a substrate, orientation, source, applicable
    column or governing rating. Those associations stay with the source rows.
    """
    observed = []
    unparsed = []
    qualified = []
    empty_count = 0
    for original in values:
        if not isinstance(original, str):
            raise TypeError('Rating cells must be strings')
        if not original.strip():
            empty_count += 1
            continue
        value = _PREFIX.sub('', original.translate(_DASHES), count=1)
        # Separating an explicit adjacent endpoint avoids mistaking its dash
        # for part of a negative duration. No endpoint is created here.
        value = _RANGE_JOIN.sub(' to ', value)
        matches = list(_TRIPLE.finditer(value))
        if not matches:
            _append_unique(unparsed, original)
            continue
        for match in matches:
            rating = tuple(None if part == '-' else int(part) for part in match.groups())
            if any(part is not None for part in rating):
                _append_unique(observed, rating)
            else:
                # All-dash cells contain no duration to summarize.
                _append_unique(unparsed, original)
        expression = _TRIPLE.sub('R', value)
        if _PARTIAL.search(expression):
            _append_unique(unparsed, original)
        elif not _EXPRESSION.fullmatch(expression):
            _append_unique(qualified, original)

    result = {
        'summary': '',
        'ratings': [_format(rating) for rating in observed],
        'unparsed': unparsed,
        'qualified': qualified,
        'empty_count': empty_count,
        'kind': 'empty',
    }
    if unparsed or qualified or (observed and empty_count):
        result['kind'] = 'unresolved'
        return result
    if not observed:
        return result
    if len(observed) == 1:
        result.update(summary=_format(observed[0]), kind='single')
        return result

    masks = {tuple(part is None for part in rating) for rating in observed}
    if len(masks) == 1:
        ordered = sorted(observed, key=lambda rating: tuple(-1 if part is None else part for part in rating))
        comparable = all(
            all(left is None or left <= right for left, right in zip(before, after))
            for before, after in zip(ordered, ordered[1:])
        )
        if comparable:
            result.update(
                summary=f'{_format(ordered[0])} to {_format(ordered[-1])}',
                ratings=[_format(rating) for rating in ordered],
                kind='range',
            )
            return result

    result.update(summary='; '.join(result['ratings']), kind='distinct')
    return result
