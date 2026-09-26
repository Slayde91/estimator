"""Remove redundant bare FRLs without combining source conditions.

This is a presentation step after source-bound review validation. It does not
change imported evidence, table cells, proof hashes, links or source qualifiers.
The caller limits its use to the intended manufacturer's entries.
"""

from copy import deepcopy
import re

from .technical_rating_summary import summarize_ratings


_DASHES = str.maketrans({char: '-' for char in '\u2010\u2011\u2012\u2013\u2014\u2212'})
_BARE_RATING = re.compile(
    r'\s*(?:FRL\s*:?\s*)?(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)\s*\.?\s*',
    re.IGNORECASE,
)
_GENERATED_SUMMARY = re.compile(
    r'^(?P<ratings>.+?) — '
    r'(?:observed source service ratings|matched source barrier row|source substrate alternatives) '
    r'\((?:Service Size / Configuration|Barrier Construction) table [1-9][0-9]*[ ();].*$',
    re.IGNORECASE,
)
_PARAGRAPHS = re.compile(r'\r?\n[ \t]*\r?\n')


def _bare_rating(value):
    if not _BARE_RATING.fullmatch(value.translate(_DASHES)):
        return None
    parsed = summarize_ratings([value])
    return parsed['ratings'][0] if parsed['kind'] == 'single' else None


def _explicit_summary_ratings(paragraph):
    match = _GENERATED_SUMMARY.fullmatch(paragraph.strip())
    if not match:
        return ()
    # Related source evidence cannot replace an entry's unqualified rating.
    lowered = paragraph.casefold()
    if 'applicability' in lowered and 'not established' in lowered:
        return ()
    parsed = summarize_ratings([match['ratings']])
    if parsed['kind'] not in {'single', 'range', 'distinct'}:
        return ()
    # Only actual printed triples count. Do not infer intermediate ratings
    # between endpoints, combine components, or reinterpret qualified cells.
    return parsed['ratings']


def normalize_frl_presentation(fields: list[dict]) -> list[dict]:
    """Return a copy with bare ratings already printed in summaries removed.

    A wholly bare FRL paragraph adds no display information when the same
    complete triple is explicitly repeated in a generated source summary.
    Attributed ratings, conditional prose, RISF and each source/table scope
    remain intact, even when they contain the same numbers. The summary is
    never recalculated or broadened here. A rating merely lying between two
    endpoints remains visible because it is additional observed information.
    """
    result = deepcopy(fields)
    for field in result:
        value = field.get('value', '')
        if field.get('label') != 'FRL' or not isinstance(value, str):
            continue
        paragraphs = _PARAGRAPHS.split(value)
        if len(paragraphs) < 2:
            continue
        repeated = {rating for paragraph in paragraphs
                    for rating in _explicit_summary_ratings(paragraph)}
        if not repeated:
            continue
        keep = [paragraph for paragraph in paragraphs if _bare_rating(paragraph) not in repeated]
        if len(keep) != len(paragraphs):
            field['value'] = '\n\n'.join(keep)
    return result
