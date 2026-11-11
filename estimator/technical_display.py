"""Compact Technical Library display text without changing retained evidence."""
import re

_PROTECTED = re.compile(
    r'https?://[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}'
    r'|\b[\w.-]+\.(?:pdf|xlsx?|docx?|png|jpe?g|json)\b', re.I)
_SENTENCE_START = re.compile(r'''\.(["'\u2019\u201d)\]]*\s+["'\u2018\u201c(\[]*)([a-z])''')
_ABBREVIATION = re.compile(r'\b(?:min|max|incl|approx|figs?|sec|no|vs|etc|e\.g|i\.e)\.$', re.I)
_LEADING_LETTER = re.compile(r'''^([\s"'\u2018\u201c(\[]*)([A-Za-z])''')
_SELECTOR_TITLE = re.compile(r'^\s*(Promat|Trafalgar)(?:\s*:\s*|\s+)\d+\s*[\u2014\u2013-]\s*', re.I)
_BRACKETED = re.compile(r'\(([^()]*)\)')
_REFERENCE_NUMBER = r'\d+(?:\s*[A-Za-z]\b)?(?:\s*(?:[-\u2013\u2014/,;&]|\band\b|\bor\b|\bto\b)\s*\d+(?:\s*[A-Za-z]\b)?)*'
_LOCATOR = re.compile(r'\b(?:(?:see|refer\s+to|as\s+per)\s+)?(?:tables?|items?|figures?|figs?\.?)\s+' + _REFERENCE_NUMBER, re.I)
_GENERATED_TABLE = re.compile(r'^\s*(?:Service Size\s*/\s*Configuration|Barrier Construction)\s+table\s+' + _REFERENCE_NUMBER + r'\s*[;,]?\s*', re.I)
_PAGE_PREFIX = re.compile(r'(^[ \t]*|(?<=[.!?])[ \t]+)(?:Source[ \t]+)?Pages?[ \t]+\d+(?:[ \t]*(?:,|&|and|[-–—])[ \t]*\d+)*[ \t]*:[ \t]*', re.I | re.M)
_PAGE_POINTER = re.compile(r'\(\s*(?:(?:see|refer\s+to|as\s+per|per|p/)\s+)?(?:source\s+)?pages?\s+' + _REFERENCE_NUMBER + r'\s*\)', re.I)
_PAGE_DETAILS = re.compile(r'(?<!\w)(?:See|Refer\s+to)\s+(?:source\s+)?pages?\s+' + _REFERENCE_NUMBER + r'\s+for\s+(?:further\s+)?details\.?', re.I)
_SENTENCE_STOP_PAIR = re.compile(r'(?<=[A-Za-z)\]])\.[ \t]+\.(?![ \t]*\.)(?=[ \t]*(?:$|[A-Za-z]))', re.M)
_DIAMETER_NUMBER = r'(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)'
_DIAMETER_VALUE = '(' + _DIAMETER_NUMBER + r')[ \t]*(?:mm)?'
_EQUAL_DIAMETERS = re.compile(
    r'^([ \t]*)Diameter[ \t]+range[ \t]*\([ \t]*mm[ \t]*\)[ \t]*:[ \t]*' + _DIAMETER_VALUE
    + r'(?:[ \t]*(?:[-\u2013\u2014]|to)[ \t]*' + _DIAMETER_VALUE + r')?[ \t]*\r?\n'
    + r'[ \t]*(?:min\.?|minimum)[ \t]+diameter[ \t]*\([ \t]*mm[ \t]*\)[ \t]*:[ \t]*' + _DIAMETER_VALUE + r'[ \t]*\r?\n'
    + r'[ \t]*(?:max\.?|maximum)[ \t]+diameter[ \t]*\([ \t]*mm[ \t]*\)[ \t]*:[ \t]*' + _DIAMETER_VALUE + r'[ \t]*(?=\r?$)',
    re.I | re.M)


def _single_diameter(text):
    """Collapse only a complete, consecutive, exactly equal millimetre trio."""
    def decimal(value):
        integer, _, fraction = value.partition('.')
        integer, fraction = integer.lstrip('0') or '0', fraction.rstrip('0')
        return integer + ('.' + fraction if fraction else '')

    def collapse(match):
        _, first, end, minimum, maximum = match.groups()
        values = (first, end or first, minimum, maximum)
        if len({decimal(value) for value in values}) != 1:
            return match[0]
        return match[1] + 'Diameter (mm): ' + first

    return _EQUAL_DIAMETERS.sub(collapse, text)


def _without_cross_references(text):
    """Omit parenthetical source locators, retaining their actual conditions."""
    def clean(match):
        if re.fullmatch(r'\s*(?:see|refer\s+to)\s+(?:tables?|items?|figures?|figs?\.?)\s*', match[1], re.I):
            return ''
        value = _GENERATED_TABLE.sub('', match[1])
        locator_only = not _LOCATOR.sub('', value).strip(' \t\r\n,;:/')
        explicit_list = re.match(r'^\s*(?:see|refer\s+to|as\s+per)\s+', value, re.I)
        def locator(found):
            # "2 items 4 mm thick" describes a quantity and dimension. Only
            # explicit source pointers or leading locator lists are removable.
            before = _LOCATOR.sub('', value[:found.start()]).strip(' \t\r\n,;:/')
            explicit = re.match(r'^(?:see|refer\s+to|as\s+per)\s+', found[0], re.I)
            product = re.fullmatch(r'FRF\s+\d+(?:\.\d+)?', before, re.I)
            units = re.match(r'^\s*(?:mm|cm|m|µm|um|kg|g|l|litres?|layers?)(?:[²³23])?(?=$|[\s,;:/).])', value[found.end():], re.I)
            units = units or re.search(r'\d\s*[mgl]\b', found[0], re.I)
            return '' if not units and (not before and (locator_only or explicit_list) or explicit or product) else found[0]
        value = _LOCATOR.sub(locator, value)
        if value == match[1]:
            return match[0]
        value = re.sub(r'^\s*(?:see|refer\s+to|as\s+per)\s*', '', value, flags=re.I)
        value = value.strip(' \t\r\n,;:/')
        if not value or value.casefold() == 'frl':
            return ''
        return '(' + value + ')'
    cleaned = _BRACKETED.sub(clean, text)
    if cleaned == text:
        return text
    return re.sub(r'[ \t]+([,.;:])', r'\1', re.sub(r'[ \t]{2,}', ' ', cleaned))


def display_technical_title(record):
    """Hide numeric selector keys in headings, retaining the canonical record."""
    title = record.get('title') or ''
    if str(record.get('id', '')).lower().startswith(('promat-', 'trafalgar-selector-')):
        title = _SELECTOR_TITLE.sub(r'\1 — ', title, count=1)
    return title


def _capitalise_sentences(text, source):
    """Restore sentence capitals after shortening, without changing references."""
    protected = [(match.start(), match.end()) for match in _PROTECTED.finditer(text)]
    original, shortened = _LEADING_LETTER.match(source), _LEADING_LETTER.match(text)
    if (original and shortened and original[2].isupper()
            and not any(start <= shortened.start(2) < end for start, end in protected)):
        position = shortened.start(2)
        text = text[:position] + text[position].upper() + text[position + 1:]

    def capitalise(match):
        position = match.start(2)
        if (any(start <= position < end for start, end in protected)
                or _ABBREVIATION.search(text[max(0, match.start() - 12):match.start() + 1])):
            return match[0]
        return '.' + match[1] + match[2].upper()

    return _SENTENCE_START.sub(capitalise, text)

# Keep these ordered rules aligned with LibraryDetailText.compact. Shared
# fixtures exercise both implementations, including their second application.
# Never remove modals, negations, alternatives or installation measurements.
_RULES = tuple((re.compile(expression, re.I), replacement) for expression, replacement in (
    (r'\bFIREFLY(?:TM\b|\u2122)[ \t]*', ''),
    (r'\b(Roc)TM\b', r'\1'),
    (r'(?<![\w-])(?:TBA|TM)(?![\w-])[ \t]*|\u2122', ''),
    (r'\bFIREFLY(?=[A-Za-z])', ''),
    (r'\bFIREFLY\s+(?=(?:Batts?|Mastic|Penowrap|wrap|Intu[A-Za-z]+)\b)', ''),
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
    (r'\bwall\s+thickness\s+of\b', 'wall thickness'),
    (r'\b(for|to|over)\s+a\s+distance\s+of\b', r'\1'),
    (r'\b(?:a\s+)?(min\.|max\.)\s+(depth|width|height|length|thickness)\s+of\b', r'\1 \2'),
    (r'\bto\s+a\s+depth\s+of(?=\s+\d)', 'to depth'),
    (r'\bthe\s+full\s+depth\b', 'full depth'),
    (r'\b(requiring|requires)\s+the\s+use\s+of\b', r'\1'),
    (r'\bbefore\s+the\s+installation\s+of\b', 'before installing'),
    (r'\bfollowing\s+the\s+installation\s+of\b', 'after installing'),
    (r'\bduring\s+the\s+installation\s+of\b', 'while installing'),
    (r'\ba\s+combination\s+of\s+both\b', 'both'),
    (r'\band\s+also\b', 'and'),
    (r'\band\s+then\b', 'then'),
    (r'\b(?:the\s+)+(apertures?|walls?|floors?|ceilings?|slabs?|substrates?|services?|collars?|boards?|seals?|wraps?|openings?|perimeters?|Batts?|annular\s+gaps?|pipes?|layers?|ends?|edges?|faces?|base|top|underside|framing|steel\s+(?:angles?|beams?|plates?|frames?)|joints?|gaps?|separating\s+element|interfacing\s+element|supporting\s+element|configuration\s+table|complete\s+row|selected\s+configuration|use)\b', r'\1'),
    (r'(?<!when )\busing\b', 'w/'),
    (r'\bwith\b', 'w/'),
    (r'\bper\b', 'p/'),
    (r'\bw/\s+a\s+w/\s+a\b', 'w/ a'),
    (r'\bAll\s+joints\s+between\s+Batt\s+sections\s+are\s+glued\s+and\s+sealed\s+w/',
     'Glue and seal all joints between Batt sections w/'),
    (r'\bBatt\s+layers\s+are\s+glued\s+together\s+at\s+perimeter\s+bond\s+employing\b',
     'Glue Batt layers together at perimeter bond w/'),
))


def compact_technical_text(value):
    """Shorten display prose; retain original evidence and technical qualifiers."""
    if not isinstance(value, str):
        return value
    # Remove only editorial page labels and content-free pointers. Requirements
    # and conditional alternatives remain intact; original evidence is retained.
    value = _PAGE_PREFIX.sub(r'\1', value)

    def compact(text):
        text = _PAGE_POINTER.sub('', text)
        text = _PAGE_DETAILS.sub('', text)
        # A removed parenthetical may leave two sentence stops. Restrict the
        # repair to a word/closing bracket and sentence boundary: numeric ranges,
        # decimals and both adjacent and spaced ellipses keep their punctuation.
        text = _SENTENCE_STOP_PAIR.sub('.', text)
        text = re.sub(r'[ \t]+([,;:])', r'\1', text)
        text = re.sub(r'(?<=[A-Za-z)\]])[ \t]+\.(?![\d.]|[ \t]*\.)', '.', text)
        text = _single_diameter(text)
        text = _without_cross_references(text)
        for expression, replacement in _RULES:
            text = expression.sub(replacement, text)
        return text

    pieces, cursor = [], 0
    for match in _PROTECTED.finditer(value):
        pieces.extend((compact(value[cursor:match.start()]), match[0]))
        cursor = match.end()
    pieces.append(compact(value[cursor:]))
    return _capitalise_sentences(re.sub(r'[ \t]+$', '', ''.join(pieces), flags=re.M), value)


# Match only documented joins found in library prose. Blanket CamelCase and
# letter/digit splitting would damage product names, drawing numbers and FRLs.
_READING_PHRASES = (
    'PE backing rod', 'Unicorn collar', 'Ryanfire 502 Board', 'Ryan 502 Batts',
    'Ryanfire HP-X', 'Ryanfire Mastic', 'Brush Grade Mastic', 'Ryanfire Servowrap',
    'Trafalgar FyreFLEX', 'FIRST Servowrap layer', 'OUTER Servowrap', 'EACH side',
    'ONE face', 'Walsc AAC', 'Double DWV PVC stack', 'with Servowrap', 'of TWrap',
    'on TCard', 'supporting floor', 'gap as', 'starred specimen', 'starred note',
    'conclusion p', 'detail G', 'appendix Table', 'assessment Table', 'Drawing No',
    'Report No', 'neighbouring PF', 'corroborates NB', 'Group A', 'Group B',
    'specimens C', 'mm Overlap', 'Ryan Mastic', 'and service',
)
_JOINED_PHRASES = {phrase.replace(' ', '').casefold(): phrase for phrase in _READING_PHRASES}
_JOINED = re.compile(r'(?<![A-Za-z])(?:' + '|'.join(
    re.escape(phrase) for phrase in sorted(_JOINED_PHRASES, key=len, reverse=True)
) + r')(?![A-Za-z])', re.I | re.ASCII)
_READING_PROTECTED = re.compile(_PROTECTED.pattern + r'|\b[0-9a-f]{32,}\b|\bINEX>FLOOR19\b', re.I)
_DIMENSION_CHAIN = re.compile(r'(?<![\w.])(?:\d+(?:\.\d+)?[ \t]*(?:mm|cm)?[ \t]*[xX][ \t]*)+\d+(?:\.\d+)?[ \t]*(?:mm|cm)(?:[23²³])?\b')
_READING_SPACING = (
    (re.compile(r'\b(as|in|original|per|selected)(?=(?:FAS|FCO|FC|T|Table)\d)', re.I), r'\g<1> '),
    (re.compile(r'(?<=\d)(?=(?:tables?|figures?|details?|instructions?|specimens?|starred|notes?|row|application|contain|layers?|segments|mixed|pipe|and|or|add|corroborates)(?:[A-Z]|\d|\b))', re.I), ' '),
    (re.compile(r'(?<=\d)(pp?)(?=\d)'), r' \1. '),
    (re.compile(r'\b(PDF|(?:FAS|FCO?|FAR)\d+(?:-\d+)*(?:[ \t]+(?:R(?:ev)?[ \t]*[A-Z\d.]+|Issue[ \t]*\d+|Table[ \t]*\d+[a-z]?))?)[ \t]+pp(?=\d)'), r'\1 pp. '),
    (re.compile(r'\b([OI]D)(?=\d+(?:\.\d+)?mm\b)'), r'\1 '),
    (re.compile(r'(?<=\d)x(?=CAT\d|TPS\d|fibre\b|PVC\b)'), ' × '),
    (re.compile(r'\b(with|of|per|as|the|over)(?=[A-Z]{2,}\b)'), r'\g<1> '),
    (re.compile(r'\b(a)(?=\d+(?:x\d+)?mm\b)', re.I), r'\g<1> '),
    (re.compile(r'\b(Appendix)(?=[A-Z](?:\.\d+|\d+)\b)', re.I), r'\1 '),
    (re.compile(r'\b(tables?|figures?|sections?|instructions?|pages?|sheet|item)(?=\d)', re.I), r'\g<1> '),
    (re.compile(r'\b(add|and|apply|arrangement|assessed|at|callout|cites|claim|complete|contain|elements|established|explicit|extending|five|floor|for|FRL|gap|governs|holes|in|install|into|issue|item|layer|least|literal|local|maintain|maximum|min|minimum|most|nominal|note|notes|of|one|or|original|overall|overlap|perimeter|plus|printed|rated|report|required|rows|secure|selected|selector|separate|source|specimen|standard|the|this|to|use|using|wall|where|wide|with|Servowrap|Shaftliner|FyreSTRAP|FyrePEXHP|TPS)(?=\d)', re.I), r'\g<1> '),
    (re.compile(r'(?<=\d)(January|February|March|April|May|June|July|August|September|October|November|December)(?=\d{4}\b)', re.I), r' \g<1> '),
    (re.compile(r'(?<=\bIssue \d),(?=\d{1,2} [A-Z][a-z]+ \d{4})'), ', '),
    (re.compile(r'([,;])(?=[A-Za-z(])'), r'\g<1> '),
    (re.compile(r'(?<=[A-Za-z]),(?=\d)|,(?=\d{2}SFR\d)'), ', '),
    (re.compile(r'(;)(?=[\d<>≥≤])'), r'\g<1> '),
    (re.compile(r'(?<=[A-Za-z)]):(?=[A-Za-z\d<>≥≤])'), ': '),
    (re.compile(r'(?<=[a-z)])\.(?=(?:Apply|Install|Cut|Fix|Seal|Use|Based|The|Maintain|Fit|Ensure|Form|Allow)\b)'), '. '),
    (re.compile(r'(?<=[A-Za-z0-9_Øø²³])(?=[≤≥§])'), ' '),
    (re.compile(r'([≤≥§])(?=\d)'), r'\g<1> '),
    (re.compile(r'(?<=[A-Za-z\d²³])×(?=[A-Za-z\d])'), ' × '),
    (re.compile(r'(?<= )×(?=\d)'), '× '),
    (re.compile(r'(?<=[A-Za-z0-9_Øø²³])×(?= )'), ' ×'),
)
_READING_UNITS = (
    (re.compile(r'\bw/(?=\s)', re.I), 'with'),
    (re.compile(r'\bp/(?=\s)', re.I), 'per'),
    (re.compile(r'\b(M\d+|\d+g)[xX](?=\d+(?:\.\d+)?[ \t]*mm\b)', re.I), r'\1 × '),
    (re.compile(r'\b(\d+(?:\.\d+)?)(mm|cm|µm|min|m(?=[²³]))(?=\b|[²³]|[23]\b)', re.I), r'\g<1> \g<2>'),
)


def _joined_phrase(match):
    # Preserve spelling and original capitalisation while restoring spaces.
    text = match[0]
    cursor = 0
    words = []
    for word in _JOINED_PHRASES[text.casefold()].split():
        words.append(text[cursor:cursor + len(word)])
        cursor += len(word)
    return ' '.join(words)


def _reading_text(value, *, always):
    if not isinstance(value, str):
        return value
    # Keep source identifiers, URLs, filenames and email addresses as-is.
    parts = []
    cursor = 0
    changed = False
    for match in _READING_PROTECTED.finditer(value):
        parts.extend(((True, value[cursor:match.start()]), (False, match[0])))
        cursor = match.end()
    parts.append((True, value[cursor:]))
    spaced = []
    for prose, text in parts:
        if prose:
            source = text
            text = _JOINED.sub(_joined_phrase, text)
            for expression, replacement in _READING_SPACING:
                text = expression.sub(replacement, text)
            changed |= text != source
        spaced.append((prose, text))
    if not always and not changed:
        return compact_technical_text(value)
    result = []
    for prose, text in spaced:
        if prose:
            text = _DIMENSION_CHAIN.sub(lambda match: re.sub(r'[ \t]*[xX][ \t]*', ' × ', match[0]), text)
            for expression, replacement in _READING_UNITS:
                text = expression.sub(replacement, text)
        result.append(text)
    return ''.join(result)


def readable_technical_text(value):
    """Retain complete technical prose and evidence locators in reading order."""
    return _reading_text(value, always=True)


def technical_field_text(label, value):
    """Prefer full instructions for seal/installation fields and damaged prose."""
    return _reading_text(value, always=label in {'Installation Details', 'Seal Depth / Fillet Size'})
