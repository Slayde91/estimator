"""User-defined discovery types from installed firestopping materials.

This is a search projection, not an opening-size or assessment rule. Source
records, their field labels, tables and fingerprints are never rewritten.
"""
import re


OPENING_TYPES = ('Core hole', 'Oversized core hole')
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
    r'promatect(?:[®\s]*[-–]?\s*\d+(?:/\d+)?)?|'
    r'promasil(?:[®\s]*1100\s*super)?)\b', re.I)
_BATT = re.compile(r'batt', re.I)
_NEGATIVE_AFTER = re.compile(
    r'^\s*(?:(?:or|and)\s+(?:batts?|boards?)\s+)*'
    r'(?:(?:is|are|was|were|shall\s+be|must\s+be)\s+)?'
    r'(?:not\s+(?:(?:to\s+)?be\s+)?(?:required|used|installed|included|needed|specified|applicable|permitted|allowed)|'
    r'excluded|omitted)\b', re.I)
_NEGATIVE_BEFORE = re.compile(
    r'\b(?:no|without|excluding|omit(?:ted)?|not\s+(?:use|using|requiring|include))\s+'
    r'(?:(?:any|a|an|the|additional|further|fire[- ]?rated|thick|layer(?:s)?|of|'
    r'mm|mineral|wool|stone|rock|coated|resistant|calcium|silicate|plaster|particle|chip|'
    r'batts?|boards?|or|and)\s+|[\d.]+\s*)*$', re.I)
_REQUIRED_BEFORE = re.compile(
    r'\b(?:not|never)\s+(?:(?:be\s+)?install(?:ed)?\s+without|omit|exclude|remove)\s+'
    r'(?:(?:any|a|an|the|additional|fire[- ]?rated|thick|layers?|of|mm)\s+|[\d.]+\s*)*$', re.I)
_REFERENCE_ONLY = re.compile(r'^\s*(?:see|refer(?:ence)?(?:\s+to)?|report|figure|source\s+table)\b', re.I)
_TEMPORARY = re.compile(r'\b(?:temporary|formwork|shuttering|packaging|packing\s+board)\b', re.I)
_OPTIONAL_BUILDUP = re.compile(r'\b(?:can|may)\s+be\s+(?:built[- ]?up|thickened)\b', re.I)
_BOARD_ROLE = re.compile(
    r'\b(?:patch(?:es)?|pattress|infill|bulkhead|backblock|thicken(?:ed|ing)?|'
    r'thickening|local[- ]lining|strips?|pieces?|pack(?:ing)?(?:\s+the)?\s+gap)\b', re.I)
_DIRECT_BOARD_USE = re.compile(
    r'\b(?:install|fit|fix|insert|place|cut|use)\s+'
    r'(?:(?:a|an|the|two|three|four|layers?|of|fire[- ]?rated|thick|mm)\s+|[\d.]+\s*)*$', re.I)
_DIRECT_BOARD_AFTER = re.compile(r'^\s*(?:is|are|must|shall)\s+(?:be\s+)?(?:installed|fitted|fixed|used|inserted)\b', re.I)
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


def _positive(clause, match):
    before, after = clause[:match.start()], clause[match.end():]
    if (_REFERENCE_ONLY.search(clause) or _TEMPORARY.search(clause)
            or _OPTIONAL_BUILDUP.search(clause)):
        return False
    if _REQUIRED_BEFORE.search(before):
        return True
    if _NEGATIVE_AFTER.search(after):
        return False
    return not _NEGATIVE_BEFORE.search(before)


def _installed_board(label, clause, match):
    # Names are corroborated by the installed catalog's product/installation
    # wording (FyreBOARD Maxilite, COREX Board, PROMATECT patch board, PROMASIL
    # board, Ryanfire 502 Board, INEX floor replacing the local particleboard).
    # A name on a supporting wall alone is not use
    # as the penetration seal. Batts themselves can form the direct bulkhead.
    if label in _PRODUCT_FIELDS:
        return True
    if _BATT.search(match[0]):
        return not _CAVITY_INSULATION.search(clause) or bool(_BATT_SEAL.search(clause))
    if _REQUIRED_BEFORE.search(clause[:match.start()]):
        return True
    before = clause[:match.start()]
    if re.search(r'\breplac(?:e|ed|ement)\b.*\bwith\s*$', before, re.I):
        return True
    nearby = clause[max(0, match.start() - 100):match.end() + 100]
    if _BOARD_ROLE.search(nearby):
        return True
    if (_APERTURE_LINING.search(clause)
            or _BOARD_OVER_OPENING.search(clause[match.end():match.end() + 70])):
        return True
    if label in _BARRIER_FIELDS or _SUPPORT.search(clause):
        return False
    return bool(_DIRECT_BOARD_USE.search(before) or _DIRECT_BOARD_AFTER.search(clause[match.end():]))


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
            for match in _MATERIAL.finditer(clause):
                if not _positive(clause, match) or not _installed_board(label, clause, match):
                    continue
                key = (label, match[0].casefold(), clause)
                if key not in seen:
                    evidence.append({'field': label, 'material': match[0], 'text': clause})
                    seen.add(key)
    return evidence


def opening_type(item):
    return OPENING_TYPES[bool(opening_type_evidence(item))]
