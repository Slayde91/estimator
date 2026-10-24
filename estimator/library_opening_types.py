"""User-defined discovery types from installed firestopping materials.

This is a search projection, not an opening-size or assessment rule. Source
records, their field labels, tables and fingerprints are never rewritten.
"""
import re


OPENING_TYPES = ('Core hole', 'Oversized core hole')
_REPORT_TYPES = {'FAS190234': OPENING_TYPES[1], 'FAS190235': OPENING_TYPES[1],
                 'FAS190236': OPENING_TYPES[0]}


def report_opening_type(item):
    """Use a record's structured report basis, never incidental installation prose."""
    reports = set()
    for value in item.get('filter_values', {}).get('document', []):
        if isinstance(value, str) and value.strip().upper() in _REPORT_TYPES:
            reports.add(value.strip().upper())
    for field in item.get('fields', []):
        if field.get('label') == 'Report Number' and isinstance(field.get('value'), str):
            reports.update(re.findall(r'\bFAS19023[456]\b', field['value'].upper()))
    for source in item.get('sources', []):
        value = source.get('document_id', '')
        if isinstance(value, str) and value.upper() in _REPORT_TYPES:
            reports.add(value.upper())
    types = {_REPORT_TYPES[report] for report in reports}
    if len(types) != 1:
        return None
    return {'type': types.pop(), 'reports': sorted(reports)}
_COMPONENT_FIELDS = {
    'System Products', 'Product', 'System Recommendation',
    'Installation Details', 'Install Notes', 'Penetration seal description',
    'Local Protection', 'Protection', 'Service Wrap', 'Joint Treatment',
    'Aperture Seal Joints', 'Seal Depth / Fillet Size', 'Fill Depth / Fillet Size',
    'Collar', 'Installation Type',
}
_BARRIER_FIELDS = {'Barrier Construction', 'Separating Element', 'Support Construction'}
_PRODUCT_FIELDS = {'System Products', 'Product', 'System Recommendation'}
_MATERIAL = re.compile(
    r'\b(?:firefly\s*batts?|fyre\s*batts?|flexi\s*batts?|ryan\s*batts?|'
    r'boss\s*batts?|intu\s*batts?|bulkhead\s*batts?|fire\s*batts?|batts?|'
    r'fyre\s*boards?|fire\s*boards?|plaster\s*boards?|particle\s*boards?|'
    r'chip\s*boards?|boards?|maxilite|corex|inex\s*floor(?:\s*19)?|ryanfire\s*502(?:\s*board)?|'
    r'promatect(?:®?\s*(?:[-–]\s*)?\d+(?:/\d+)?)?|'
    r'promasil(?:[®\s]*1100\s*super)?)\b', re.I)
_BATT = re.compile(r'batt', re.I)
# A complete numeric modifier must end at whitespace. In a repeated modifier
# list, optional whitespace lets one digit run split exponentially many ways.
# Decimal and attached-unit tokens remain disjoint (19, 19.5, .5, 19mm).
_DIMENSION = r'(?:\d+(?:\.\d+)?|\.\d+)(?:mm)?\s+'
_NEGATIVE_TAIL = re.compile(
    r'\s*'
    r'(?:(?:is|are|was|were|shall\s+be|must\s+be)\s+)?'
    r'(?:not\s+(?:(?:to\s+)?be\s+)?(?:required|used|installed|included|needed|specified|applicable|permitted|allowed)|'
    r'excluded|omitted)\b', re.I)
_NEGATIVE_BEFORE = re.compile(
    r'\b(?:no|without|excluding|omit(?:ted)?|not\s+(?:use|using|requiring|include))\s+'
    r'(?:(?:any|a|an|the|additional|further|fire[- ]?rated|thick|layer(?:s)?|of|'
    r'mm|mineral|wool|stone|rock|coated|resistant|calcium|silicate|plaster|particle|chip|'
    r'batts?|boards?|or|and)\s+|' + _DIMENSION + r')*', re.I)
_REQUIRED_BEFORE = re.compile(
    r'\b(?:not|never)\s+(?:(?:be\s+)?install(?:ed)?\s+without|omit|exclude|remove)\s+'
    r'(?:(?:any|a|an|the|additional|fire[- ]?rated|thick|layers?|of|mm)\s+|' + _DIMENSION + r')*', re.I)
_REFERENCE_ONLY = re.compile(r'^\s*(?:see|refer(?:ence)?(?:\s+to)?|report|figure|source\s+table)\b', re.I)
_TEMPORARY = re.compile(r'\b(?:temporary|formwork|shuttering|packaging|packing\s+board)\b', re.I)
_OPTIONAL_BUILDUP = re.compile(r'\b(?:can|may)\s+be\s+(?:built[- ]?up|thickened)\b', re.I)
_BOARD_ROLE = re.compile(
    r'\b(?:patch(?:es)?|pattress|infill|bulkhead|backblock|thicken(?:ed|ing)?|'
    r'thickening|local[- ]lining|strips?|pieces?|pack(?:ing)?(?:\s+the)?\s+gap)\b', re.I)
_DIRECT_BOARD_USE = re.compile(
    r'\b(?:install|fit|fix|insert|place|cut|use)\s+'
    r'(?:(?:a|an|the|two|three|four|layers?|of|fire[- ]?rated|thick|mm)\s+|' + _DIMENSION + r')*', re.I)
_DIRECT_BOARD_AFTER = re.compile(r'\s*(?:is|are|must|shall)\s+(?:be\s+)?(?:installed|fitted|fixed|used|inserted)\b', re.I)
_COORDINATED = re.compile(r'\s*(?:or|and)\s+', re.I)
_REPLACEMENT = re.compile(r'\breplac(?:e|ed|ement)\b', re.I)
_WITH = re.compile(r'\bwith\s*', re.I)
_SUPPORT = re.compile(r'\b(?:walls?|floors?|ceilings?|shaft|stud|lining|screws?)\b', re.I)
_APERTURE_LINING = re.compile(
    r'\b(?:line|lining)\b.{0,100}\b(?:opening|aperture)\b|'
    r'\b(?:opening|aperture)\b.{0,100}\bline\b|'
    r'\bextend(?:s|ing)?\b.{0,40}\bbeyond\b.{0,40}\b(?:opening|aperture)\b', re.I)
_BOARD_OVER_OPENING = re.compile(r'\b(?:over|across|into)\s+(?:the\s+)?(?:wall\s+)?(?:opening|aperture)\b', re.I)
_CAVITY_INSULATION = re.compile(r'\b(?:cavity|insulation)\b', re.I)
_BATT_SEAL = re.compile(r'\b(?:aperture|opening|annular|seal|bulkhead|infill|pattress|backing)\b', re.I)


def _clauses(value):
    # A source paragraph can describe a wall and then a distinct seal. Keep
    # negatives local; decimal points do not split a material dimension.
    return [part.strip() for part in re.split(
        r'\n+|(?<!\d)[.;](?!\d)|\b(?:but|however)\b', value, flags=re.I) if part.strip()]


def _prefix_positions(pattern, clause, matches):
    """Locate material starts within one pass over complete modifier runs.

    A run cannot contain its own command word. Its mandatory token separators
    give non-overlapping spans; each material then advances through them once.
    """
    spans = iter(pattern.finditer(clause))
    span = next(spans, None)
    positions = set()
    for match in matches:
        while span is not None and span.end() < match.start():
            span = next(spans, None)
        if span is not None and span.start() <= match.start() <= span.end():
            positions.add(match.start())
    return positions


def _clause_context(clause, matches):
    # Clause-wide decisions are independent of each material occurrence.
    if (_REFERENCE_ONLY.search(clause) or _TEMPORARY.search(clause)
            or _OPTIONAL_BUILDUP.search(clause)):
        return None
    negative_after = set()
    for index in range(len(matches) - 1, -1, -1):
        match = matches[index]
        negative = bool(_NEGATIVE_TAIL.match(clause, match.end()))
        if not negative and index + 1 < len(matches):
            following = matches[index + 1]
            negative = (following.end() in negative_after
                        and following[0].casefold() in {'batt', 'batts', 'board', 'boards'}
                        and bool(_COORDINATED.fullmatch(clause, match.end(), following.start())))
        if negative:
            negative_after.add(match.end())
    replacement = _REPLACEMENT.search(clause)
    replacement_before = (_prefix_positions(_WITH, clause, matches) if replacement else set())
    if replacement:
        replacement_before = {position for position in replacement_before if position > replacement.end()}
    return {
        'required': _prefix_positions(_REQUIRED_BEFORE, clause, matches),
        'negative_before': _prefix_positions(_NEGATIVE_BEFORE, clause, matches),
        'negative_after': negative_after,
        'direct': _prefix_positions(_DIRECT_BOARD_USE, clause, matches),
        'replacement': replacement_before,
        'cavity': bool(_CAVITY_INSULATION.search(clause)),
        'batt_seal': bool(_BATT_SEAL.search(clause)),
        'aperture_lining': bool(_APERTURE_LINING.search(clause)),
        'support': bool(_SUPPORT.search(clause)),
    }


def _positive(match, context):
    return (match.start() in context['required']
            or (match.end() not in context['negative_after']
                and match.start() not in context['negative_before']))


def _installed_board(label, clause, match, context):
    # Names are corroborated by the installed catalog's product/installation
    # wording (FyreBOARD Maxilite, COREX Board, PROMATECT patch board, PROMASIL
    # board, Ryanfire 502 Board, INEX floor replacing the local particleboard).
    # A name on a supporting wall alone is not use
    # as the penetration seal. Batts themselves can form the direct bulkhead.
    if label in _PRODUCT_FIELDS:
        return True
    if _BATT.search(match[0]):
        return not context['cavity'] or context['batt_seal']
    if match.start() in context['required'] or match.start() in context['replacement']:
        return True
    nearby = clause[max(0, match.start() - 100):match.end() + 100]
    if _BOARD_ROLE.search(nearby):
        return True
    if (context['aperture_lining']
            or _BOARD_OVER_OPENING.search(clause, match.end(), match.end() + 70)):
        return True
    if label in _BARRIER_FIELDS or context['support']:
        return False
    return bool(match.start() in context['direct'] or _DIRECT_BOARD_AFTER.match(clause, match.end()))


def opening_type_evidence(item):
    """Return record-local positive component clauses, never arbitrary tables.

    Tables retained on a field can include other systems, filler and references.
    Their headings/cells are not evidence of this record's material selection.
    The normalizer already projects reviewed applicable text into these fields.
    A generic plasterboard wall/floor/ceiling is a substrate, not a seal product.
    """
    evidence = []
    seen = set()
    for field in item.get('fields', []):
        label = field.get('label')
        if label not in _COMPONENT_FIELDS | _BARRIER_FIELDS:
            continue
        value = field.get('value', '')
        if not isinstance(value, str):
            continue
        for clause in _clauses(value):
            matches = list(_MATERIAL.finditer(clause))
            if not matches:
                continue
            context = _clause_context(clause, matches)
            if context is None:
                continue
            for match in matches:
                key = (label, match[0].casefold(), clause)
                if key in seen or not _positive(match, context) or not _installed_board(label, clause, match, context):
                    continue
                evidence.append({'field': label, 'material': match[0], 'text': clause})
                seen.add(key)
    return evidence


def opening_type(item):
    report = report_opening_type(item)
    if report is not None:
        return report['type']
    return OPENING_TYPES[bool(opening_type_evidence(item))]
