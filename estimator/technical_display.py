"""Compact Technical Library display text without changing retained evidence."""
import re

_PROTECTED = re.compile(
    r'https?://[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}'
    r'|\b[\w.-]+\.(?:pdf|xlsx?|docx?|png|jpe?g|json)\b', re.I)

# Keep these ordered rules aligned with LibraryDetailText.compact. Shared
# fixtures exercise both implementations, including their second application.
# Never remove modals, negations, alternatives, measurements or source markers.
_RULES = tuple((re.compile(expression, re.I), replacement) for expression, replacement in (
    (r'\bFIREFLY(?=[A-Za-z])', ''),
    (r'\bFIREFLY[ \t]+(?=(?:Batt|Mastic|Penowrap|Intu[A-Za-z]+)\b)', ''),
    (r'\bPenowrap\b[\u00ae\u2122]?', 'wrap'),
    (r'\bBrush Grade\b', 'BG'),
    (r'\bincluding\b', 'incl.'),
    (r'\bapproximately\b', 'approx.'),
    (r'\bin order to\b', 'to'),
    (r'\bin accordance with\b', 'per'),
    (r'\bas per\b', 'per'),
    (r'\bprior to\b', 'before'),
    (r'\bsubsequent to\b', 'after'),
    (r'\bin the event that\b', 'if'),
    (r'\bprovided that\b', 'provided'),
    (r'\bfor the purpose of\b', 'for'),
    (r'\bin addition to\b', 'plus'),
    (r'\bin between\b', 'between'),
    (r'\bSource configuration ratings remain subject to the stated barrier construction and installation conditions\b',
     'Source ratings subject to stated barrier construction and installation conditions'),
    (r'\bThe entry selection remains separate\b', 'Entry selection remains separate'),
    (r'\bno missing values have been inferred\b', 'no missing values inferred'),
    (r'\bto ensure that\b', 'to ensure'),
    (r'\bat a distance of\b', 'at'),
    (r'\ba minimum of\b|\bminimum of\b', 'min.'),
    (r'\ba maximum of\b|\bmaximum of\b', 'max.'),
    (r'\bminimum\b\.?', 'min.'),
    (r'\bmaximum\b\.?', 'max.'),
    (r'\bis required to be\b', 'must be'),
    (r'\bare required to be\b', 'must be'),
    (r'\bis required for\b', 'required for'),
    (r'\bare required for\b', 'required for'),
    (r'\bmust be at least\b', 'must be min.'),
    (r'\bat least\b', 'min.'),
    (r'\bat most\b', 'max.'),
    (r'\bon both sides of the wall\b', 'on both wall faces'),
    (r'\bon each side of the wall\b', 'on each wall face'),
    (r'\bfrom the face of the wall\b', 'from wall face'),
    (r'\bthe (Batt layers) are glued together using\b', r'Glue \1 together w/'),
    (r'\bAll cut edges, incl\. layer joints and the wall perimeter interface, to be coated\b',
     'Coat all cut edges, incl. layer joints and wall perimeter interface'),
    (r'\binto\s+the\s+aperture\b', 'to aperture'),
    (r'\bof\s+the\s+damper\b', 'of damper'),
    (r'\bthe (apertures?|walls?|floors?|ceilings?|slabs?|substrates?|services?|collars?|boards?|seals?|wraps?|openings?|perimeters?)\b', r'\1'),
    (r'(?<!when )\busing\b', 'w/'),
    (r'\bwith\b', 'w/'),
    (r'\bper\b', 'p/'),
))


def compact_technical_text(value):
    """Shorten display prose; retain original evidence and technical qualifiers."""
    if not isinstance(value, str):
        return value

    def compact(text):
        for expression, replacement in _RULES:
            text = expression.sub(replacement, text)
        return text

    pieces, cursor = [], 0
    for match in _PROTECTED.finditer(value):
        pieces.extend((compact(value[cursor:match.start()]), match[0]))
        cursor = match.end()
    pieces.append(compact(value[cursor:]))
    return ''.join(pieces)
