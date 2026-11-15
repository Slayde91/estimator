"""Flow hard-wrapped construction descriptions on the public detail copy."""
import re

from .technical_table_navigation import field_tables


BARRIER_LABELS = frozenset({
    'barrier construction', 'barrier', 'separating element', 'support construction',
    'substrate', 'substrate to substrate', 'substrate to substate', 'type of wall',
    'approved wall systems', 'ceiling construction', 'supporting floor construction',
    'supporting wall construction', 'reviewed wall construction', 'floor scope',
    'wall thickness', 'minimum wall thickness',
})

_RATING = r'(?:\d+|[-–−])(?:[ \t]*/[ \t]*(?:\d+|[-–−])){2}'
_FRL = re.compile(r'\b(FRL(?:\s+of)?)\s*(' + _RATING
                  + r'(?:\s+(?:or|and)\s+' + _RATING + r')*)(?![\w/])', re.I)
_MIN_THICK = r'min(?:imum)?[.\'’]?\s*\d+(?:\.\d+)?\s*mm\s+thick\b'
_DESCRIPTION = re.compile(r'\b(?:FRL(?=\b|\d)|\d+(?:\.\d+)?\s*mm\s+thick\b)'
                          r'|^notes?\s*:|\b(?:or|and|with|of|the|to)\s*\n', re.I)
_ITEM_END = re.compile(r'\(items?\s+\d+(?:\s*(?:or|and|[,–-])\s*\d+)*\)$', re.I)
_ENTRY = re.compile(
    r'^(?:[•●▪‣◦*]|[-–−](?!\s*/)|\([A-Z\d]{1,2}\)|(?:[A-Z]|\d{1,2})[.)])(?:\s|$)'
    r'|^(?:notes?\s*:|source options?\s+\d|(?:separating element|support construction)\b)', re.I)
_OR = re.compile(r'or[,.:]?', re.I)
_BARRIER_END = re.compile(r'\b(?:walls?|floors?|ceilings?|systems?|slabs?|or higher)$', re.I)
_NEW_DESCRIPTION = re.compile(
    r'^(?:' + _MIN_THICK + r'|(?:\d+\s*mm\s+thick|concrete|masonry|AAC|Hebel|CLT|plasterboard)\b.*'
    r'\b(?:wall|floor|ceiling|slab|system)s?\b)', re.I)
_MATERIAL_FIRST = re.compile(r'^(?P<material>[^\n]+(?:wall|floor|system))\n'
                             r'(?P<depth>' + _MIN_THICK + r'[^\n]*)\n(?=Capable of\b)', re.I | re.M)


def _flow_section(lines):
    text = '\n'.join(lines)
    if not _DESCRIPTION.search(text):
        return text
    text = re.sub(r'(?<=[A-Za-z])-[ \t]*\n(?=[A-Za-z])', '-', text)
    text = ' '.join(part.strip() for part in text.splitlines())
    text = re.sub(r'(?<=\d)mm(?=\s+thick\b)', ' mm', text, flags=re.I)
    text = re.sub(r'^Minimum(?=\s+\d+\s*mm\s+thick\b)', 'Min.', text)

    def rating(match):
        values = re.sub(r'\s*/\s*', '/', match[2])
        return match[1] + ' ' + re.sub(r'\b(OR|AND)\b', lambda word: word[0].lower(), values)

    text = _FRL.sub(rating, text)
    if _ITEM_END.search(text) and _FRL.search(text):
        text += '.'
    return text


def barrier_construction_text(value):
    """Preserve separate options, notes and list entries while joining PDF wraps."""
    value = value.replace('\r\n', '\n').replace('\r', '\n')
    # In this report template, the material, minimum thickness and FRL are
    # three clauses of the same construction. Keep their original scope.
    value = _MATERIAL_FIRST.sub(
        lambda m: f"{m['material']}, {m['depth'][0].lower()}{m['depth'][1:].rstrip('.')}. ", value)
    text = re.sub(r'(\bcapable of achieving)\n\s*\n(?=FRL\b)', r'\1\n', value, flags=re.I)
    sections = []
    lines = []
    for line in text.splitlines():
        line = line.strip()
        previous = lines[-1] if lines else ''
        boundary = (not line or (_ENTRY.match(line) and not re.search(r'\(items?$', previous, re.I))
                    or _OR.fullmatch(line)
                    or _OR.fullmatch(previous)
                    or (_NEW_DESCRIPTION.match(line)
                        and (_BARRIER_END.search(previous) or previous.endswith(('.', ')')))))
        if boundary and lines:
            sections.append(_flow_section(lines))
            lines = []
        if line:
            lines.append(line)
        elif sections and sections[-1]:
            sections.append('')
    if lines:
        sections.append(_flow_section(lines))
    return '\n'.join(sections).strip()


def present_barrier_text(fields):
    """Format only barrier descriptions and columns, retaining all row identities."""
    for field in fields:
        if field['label'].casefold() in BARRIER_LABELS:
            field['value'] = barrier_construction_text(field['value'])
        for table in field_tables(field):
            for index, label in enumerate(table['columns']):
                if label.casefold() in BARRIER_LABELS:
                    for row in table['rows']:
                        row[index] = barrier_construction_text(row[index])
