"""Display service dimensions without changing or interpreting calculator inputs.

AL is the diameter used by the workbook, which can be a collar/bundle basis.
Only an explicitly matching, single service diameter is presented as a plain
diameter. Descriptive ranges and component quantities remain verbatim.
"""

import math
import re


FIELD_LABEL = 'Service Size or Diameter'
UNKNOWN = 'Not specified in calculator inputs'
NUMBER = r'\d+(?:\.\d+)?'
QUALIFIER = r"(?:(?:up\s+to|max(?:imum)?['’]?|nom(?:inal)?[.'’]?)\s+)?"
SERVICE = r'\b(?:pipes?|conduits?|hoses?|cables?|microducts?|pair\s*coils?|bundles?|cable\s*trays?|access\s+panels?)\b'
NON_SERVICE = r'\b(?:core\s*holes?|holes?|apertures?|openings?|insulation|lagging|seal(?:ant)?|bulkheads?|boards?|walls?|slabs?|fillets?|wraps?|collars?)\b'
MATERIAL = r'(?:uPVC|PVC|HDPE|PEX|CPVC|PE|copper|steel|plastic|rigid|flexi|clear|round|military|condensate|drain|orange|electrical|optic|fibre|fiber|Vesda|LSZH|FR|HFT|floor|waste|stack|DWV|bare|or)'
RANGE = rf'{NUMBER}(?:\s*[-–]\s*{NUMBER})?'
PATTERNS = (
    ('diameter', rf'{QUALIFIER}{NUMBER}\s*\.?mm\s*(?:Ø\s*)?(?:OD|outside\s+diameter|diameter)\b(?:\s*(?:to|up\s+to|[-–])\s*{NUMBER}\s*\.?mm\s*(?:OD|outside\s+diameter|diameter)\b)?'),
    ('diameter', rf'{QUALIFIER}Ø\s*{RANGE}\s*mm(?:\s*OD\b)?'),
    ('diameter', rf'{QUALIFIER}OD\s*{RANGE}\s*mm\b'),
    ('diameter_literal', rf'{QUALIFIER}Ø\s*{RANGE}(?:\s*OD\s*mm\b|(?=\s*[×x])|(?=\s+(?:copper|steel|pipes?)\b))'),
    ('nominal', rf'{QUALIFIER}DN\s*{RANGE}\b'),
    ('nominal', rf'{QUALIFIER}(?:NB\s*{RANGE}|{RANGE}\s*NB)\b'),
    ('service', rf'{QUALIFIER}{RANGE}\s*mm\s+(?:{MATERIAL}\s+){{0,6}}(?:pipes?|conduits?|hoses?|cables?|microducts?)\b'),
    ('service', rf'(?:pipes?|conduits?)\s*(?:\([^\n)]{{1,30}}\)\s*)?(?:up\s+to|max(?:imum)?)\s*{RANGE}\s*mm\b'),
    ('cable_cross_section', rf'{QUALIFIER}{RANGE}\s*\.?mm(?:²|\^?2)\b'),
    ('pair_coil', r'\d+/\d+["”]?\s*(?:\+|&|and)\s*\d+/\d+["”]?'),
    ('pair_coil', rf'{NUMBER}\s*(?:mm\s*)?(?:\+|&)\s*{NUMBER}\s*mm\s+pair\s*coil'),
    ('rectangular', rf'{QUALIFIER}{NUMBER}\s*(?:mm\s*(?:wide|width)?)?\s*[×x]\s*{NUMBER}\s*(?:mm\s*(?:thick|deep|depth|high)?)?'),
)


def _positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def _number(value):
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def _service_text(value):
    if not isinstance(value, str):
        return ''
    # Workbook descriptions use both real newlines and literal backslash-n.
    text = value.replace('\\n', '\n')
    # These are source substrate notes, not dimensions of the service. A user
    # entered multi-line list of service components is retained.
    text = re.split(r'\n\s*-\s*(?=[^\n]*\b(?:concrete|masonry|plasterboard|walls?(?!\s+thickness)|floor|slab|ceiling|Speedpanel|Dincel|Hebel|Corex)\b)', text, maxsplit=1, flags=re.I)[0]
    return text.strip()


def _measurements(text):
    matches = []
    for kind, pattern in PATTERNS:
        for match in re.finditer(pattern, text, re.I):
            start, end = match.span()
            left = text[max(0, start-100):start]
            right = text[end:end+65]
            before = list(re.finditer(SERVICE + '|' + NON_SERVICE, left, re.I))
            after = re.search(SERVICE + '|' + NON_SERVICE, right, re.I)
            previous = before[-1].group() if before else ''
            following = after.group() if after else ''
            # An explicit following hole/aperture/insulation label wins; such
            # dimensions never become service sizes merely because cables are
            # mentioned elsewhere in the description.
            direct_following = after and re.fullmatch(r'[\s,().Ø]*', right[:after.start()])
            if direct_following and re.fullmatch(NON_SERVICE, following, re.I):
                continue
            if re.fullmatch(NON_SERVICE, previous, re.I):
                continue
            if kind == 'cable_cross_section' and not re.search(r'cable', left + right, re.I):
                continue
            if kind == 'pair_coil' and not re.search(r'pair\s*coil', left + right, re.I):
                continue
            if kind == 'rectangular':
                role = following if after and after.start() < 35 else previous
                if not re.fullmatch(r'(?:cables?|bundles?|cable\s*trays?|access\s+panels?)', role, re.I):
                    continue
                if not re.search(r'mm', match.group(), re.I) and not re.fullmatch(r'access\s+panels?', role, re.I):
                    continue
            matches.append({'kind': kind, 'literal': match.group(), 'start': start, 'end': end})
    # A complete OD range takes precedence over overlapping individual values.
    result = []
    for match in sorted(matches, key=lambda m: (m['start'], -(m['end']-m['start']))):
        if not any(match['start'] < old['end'] and old['start'] < match['end'] for old in result):
            result.append(match)
    return result


def service_size_evidence(inputs):
    """Return deterministic display plus auditable input basis; never mutate it."""
    inputs = inputs if isinstance(inputs, dict) else {}
    text = _service_text(inputs.get('T'))
    measurements = _measurements(text)
    diameter, width, depth = (inputs.get(column) for column in ('AL', 'AQ', 'AR'))
    lines, basis = [], []
    simple = False
    if _positive(diameter):
        if len(measurements) == 1 and measurements[0]['kind'] in {'diameter', 'service'}:
            literal = measurements[0]['literal']
            numbers = re.findall(NUMBER, literal)
            multiple = re.search(r'\b(?:bundles?|pair\s*coils?|mixed|multi[- ]?services?)\b|\+|(?:\d+\s*[×x])',
                                 str(inputs.get('K') or '') + ' ' + text, re.I)
            restricted = re.search(r'\b(?:up\s+to|max(?:imum)?|nom(?:inal)?|to)\b|[-–]', literal, re.I)
            simple = len(numbers) == 1 and float(numbers[0]) == diameter and not multiple and not restricted
        lines.append(f'{_number(diameter)} mm diameter' if simple else f'Diameter used in calculation: {_number(diameter)} mm')
        basis.append({'column': 'AL', 'role': 'calculator_diameter', 'value': diameter})
    if _positive(width) or _positive(depth):
        dimensions = []
        if _positive(width):
            dimensions.append(f'{_number(width)} mm wide')
            basis.append({'column': 'AQ', 'role': 'cable_tray_width', 'value': width})
        if _positive(depth):
            dimensions.append(f'{_number(depth)} mm deep')
            basis.append({'column': 'AR', 'role': 'cable_tray_depth', 'value': depth})
        lines.append('Cable tray: ' + ' × '.join(dimensions))
    if measurements and not simple:
        # Retaining the complete service clause avoids turning a range into a
        # single size, dropping a component quantity, or treating wall/lagging
        # thickness in a qualified description as another service diameter.
        lines.append('Described service: ' + text)
        basis.append({'column': 'T', 'role': 'literal_service_description', 'value': inputs.get('T'), 'measurements': measurements})
    value = '\n'.join(lines) if lines else UNKNOWN
    decision = 'matching_single_diameter' if simple else 'calculator_and_description' if basis and any(b['column']=='T' for b in basis) and len(basis)>1 else 'description_only' if basis and basis[0]['column']=='T' else 'calculator_only' if basis else 'unspecified'
    return {'value': value, 'decision': decision, 'basis': basis}


def service_size_field(inputs):
    return {'label': FIELD_LABEL, 'value': service_size_evidence(inputs)['value']}
