"""Readable installation instructions for the public detail view.

The review plan and editor retain the exact source text. Only known generated
paragraphs are reworded; unfamiliar instructions and qualifications pass through.
"""
import re


_RYANFIRE = (
    'Apply Ryanfire Brush Grade Mastic to exposed board edges and mating surfaces. '
    'Install the two-layer Ryanfire502Board aperture seal using the selected floor or wall construction and its '
    'source-specific fixings,restraint and overlap. Seal board joints and the perimeter with the specified Ryanfire Mastic. '
    'Independently support penetrating services. Keep the named local service sealant and protection for this configuration.')
_SUPERSTOPPER = (
    'Install the selected SuperSTOPPER casing,intumescent lining and foam configuration as shown in its applicable report '
    'installation figure. Maintain the selected supporting-element construction,source annular gap and FyreFLEX seal. '
    'Fit and secure the source mounting flanges or cast-in restraints for that product. Fit the foam plug around the '
    'services and seal remaining gaps. Apply only the selected service wrapping and any required casing wrapping.')
_TWRAP = (
    'Seal the pipe penetration with FyreFLEX to the selected depth and fillet on each face. Apply the selected TWrap '
    'layers and lengths to each specified side. Secure the wrap with4.6mm steel cable ties at150mm centres. Include '
    'the local Maxilite pad only where the selected configuration requires it. The specified supporting-wall build-up '
    'and its independent fire rating are mandatory.')

_PROCEDURES = {
    _RYANFIRE: (
        'Apply Ryanfire Brush Grade Mastic to the exposed board edges and mating surfaces.',
        'Install the two-layer Ryanfire 502 Board aperture seal. Use the fixings, restraint and overlap specified '
        'for the selected floor or wall construction.',
        'Seal the board joints and perimeter with the specified Ryanfire Mastic.',
        'Support the penetrating services independently. Use the local service sealant and protection specified '
        'for this configuration.'),
    _SUPERSTOPPER: (
        'Install the selected SuperSTOPPER casing, intumescent lining and foam as shown in the applicable report figure.',
        'Use the specified supporting construction, annular gap and FyreFLEX seal.',
        'Fit and secure the mounting flanges or cast-in restraints specified for this product.',
        'Fit the foam plug around the services and seal the remaining gaps.',
        'Use only the selected service wrapping and any required casing wrapping.'),
    _TWRAP: (
        'On each face, seal the pipe penetration with FyreFLEX to the selected depth and fillet size.',
        'Apply the selected TWrap layers and lengths to each specified side. '
        'Secure the wrap with 4.6 mm steel cable ties at 150 mm centres.',
        'Fit the local Maxilite pad only if the selected configuration requires it.',
        'Use the specified supporting-wall construction with its required independent fire rating.'),
    ('Fix the FyreSTRAP to the underside of the concrete soffit on each side of the wall,using the source M6x50mm '
     'masonry anchors. Install each service through its separate5mm-oversize hole. Form the40mm-high strap void up '
     'to160mm wide and fill to50mm depth with FyrePEXHP on each face. Maintain the illustrated service quantities '
     'and position relative to the concrete soffit.'): (
        'Fix the FyreSTRAP to the underside of the concrete soffit on each side of the wall. '
        'Use the specified M6 × 50 mm masonry anchors.',
        'Fit each service through its own hole, 5 mm oversize. Keep the service quantities and positions '
        'relative to the soffit as illustrated.',
        'Form the strap void 40 mm high and up to 160 mm wide. Fill it with FyrePEXHP to a depth of 50 mm on each face.'),
    ('Install the minimum60mm Maxilite penetration seal in the selected independently rated supporting construction. '
     'Maintain100mm overlap where shown and use the corresponding report fixing arrangement. Seal service gaps to '
     'the full board depth with FyreFLEX. Keep services at least40mm apart. Apply the selected TWrap layers,with50mm '
     'self-overlap and minimum4.6mm stainless steel ties. Fit the100mm-wide local Maxilite pad where this configuration requires it.'): (
        'Install the minimum 60 mm Maxilite penetration seal in the selected independently rated supporting construction.',
        'Maintain a 100 mm overlap where shown. Use the corresponding fixing arrangement in the report.',
        'Seal service gaps to the full board depth with FyreFLEX. Keep services at least 40 mm apart.',
        'Apply the selected TWrap layers with a 50 mm self-overlap and minimum 4.6 mm stainless steel ties.',
        'Fit the 100 mm wide local Maxilite pad where this configuration requires it.'),
    ('Install2x60mm FyreBATT in the source pattress arrangement. Seal butt joints and the perimeter with FyreFLEX. '
     'Overlap the face-fitted layer100mm around the penetration and apply a25x25mm perimeter fillet. Fix the surface '
     'layer with the source10gx100mm screws at200mm centres. Apply the selected pipe wrap and service seal,keeping '
     'services at least40mm apart.'): (
        'Install 2 × 60 mm FyreBATT in the specified pattress arrangement. Seal the butt joints and perimeter with FyreFLEX.',
        'Overlap the face-fitted layer by 100 mm around the penetration. Apply a 25 × 25 mm perimeter fillet.',
        'Fix the surface layer with the specified 10g × 100 mm screws at 200 mm centres.',
        'Apply the selected pipe wrap and service seal. Keep services at least 40 mm apart.'),
    ('Cut and fit the Unicorn collar around the selected services. Link the cut ends using the first mounting bracket. '
     'Space the remaining mounting tabs as in the retained ancillary fixing table and secure with the source M6x50mm '
     'masonry anchors. Fill between service and collar with FyrePEXHP to the full collar depth and provide the '
     'selected slab seal and wrap.'): (
        'Cut and fit the Unicorn collar around the selected services. Link the cut ends with the first mounting bracket.',
        'Space the remaining mounting tabs as shown in the ancillary fixing table. '
        'Secure them with the specified M6 × 50 mm masonry anchors.',
        'Fill between the service and collar with FyrePEXHP to the full collar depth. Fit the selected slab seal and wrap.'),
}

_COLLAR = (
    'Ryanfire HP-X to10mm depth from the underside of the Ryan502Batts over PEbackingrod,asT00169detailG/instruction3;'
    'annular gap per selectedFAS210123Table105row. Unicorncollar fixed with source tabs/bolts and penny washers.')
_COLLAR_PROSE = (
    'Apply Ryanfire HP-X over the PE backing rod to a depth of 10 mm from the underside of the Ryan 502 Batts '
    '(T00169, detail G, instruction 3). Use the annular gap in the selected row of FAS210123 Table 105. '
    'Fix the Unicorn collar with the specified tabs/bolts and penny washers.')
_FYREFLEX = ('Trafalgar FyreFLEX to the full depth of the Ryan502Batts;15x15mm fillet onto bare pipe '
             'and25x25mm fillet around the Servowrap-to-batt interface,as originalT00203/T00204instructions4and6;annular gap')
_FYREFLEX_PROSE = ('Apply Trafalgar FyreFLEX to the full depth of the Ryan 502 Batts. Form a 15 × 15 mm fillet '
                   'onto the bare pipe and a 25 × 25 mm fillet around the Servowrap-to-batt interface. '
                   'Follow instructions 4 and 6 in T00203/T00204. ')
_SEALS = {
    _COLLAR: _COLLAR_PROSE,
    _FYREFLEX + '10mm': _FYREFLEX_PROSE + 'Annular gap: 10 mm.',
    _FYREFLEX + '12mm': _FYREFLEX_PROSE + 'Annular gap: 12 mm.',
    _FYREFLEX + 'as selected source specimen': _FYREFLEX_PROSE + 'Use the annular gap specified for the selected specimen.',
    ('Ryanfire HP-X through full batt depth and50x50mm fillet sealing the FIRSTServowraplayer '
     '(T00204starredspecimen5note);separate25x25mm FyreFLEX fillet at the OUTERServowrap-to-batt interface '
     '(T00204instruction6);12mm annular gap'):
        ('Apply Ryanfire HP-X through the full batt depth. Form a 50 × 50 mm HP-X fillet to seal the first '
         'Servowrap layer (T00204, starred note for specimen 5). At the outer Servowrap-to-batt interface, '
         'form a separate 25 × 25 mm FyreFLEX fillet (T00204, instruction 6). Annular gap: 12 mm.'),
    ('Ryanfire HP-X between the Anaconda conduit bundle and Ryan502Batts,as T00196instruction4;annular gap10–15mm '
     'per FAS210123R2Table93p155. Neither source prints an additional numerical seal-depth or fillet requirement.'):
        ('Apply Ryanfire HP-X between the Anaconda conduit bundle and the Ryan 502 Batts (T00196, instruction 4). '
         'Use a 10–15 mm annular gap (FAS210123 R2, Table 93, p. 155). Neither source specifies an additional '
         'numerical seal depth or fillet size.'),
}
_SEAL_LABEL = 'Seal Depth / Fillet Size'
_REPEATED_FIELDS = {'Barrier Construction', 'Service', 'Service Size / Configuration', 'Service Wrap', 'Local Protection',
                    _SEAL_LABEL}
_CLT_CONDITION = 'FAS200363Table30;CLT independently rated60min;full timber/friction-fit installation.'
_COMPONENT = re.compile(r'^[1-9]\d*[ \t]*[×xX][ \t]+(?![\d. ×xX]+(?:mm|cm|m)?\s*$)\S', re.I)
_DRAIN = re.compile(
    r'Single layer of waterproofing panel is installed around the puddle flange using board screws at '
    r'(\d+(?:\.\d+)?) mm cent(?:er|re)s\.? Vitreous tile is then adhered to waterproofing panel using adhesive\.? '
    r'A square drain protruded through the waterproofing panel and finish flush with the tile\. '
    r'A small insert vitreous tile is then fit into the square drain\.?', re.I)


def _service_configuration(value):
    """Keep quantity lists separate from the source's installation paragraph."""
    if '\n' not in value and 'waterproofing panel' not in value.casefold():
        return value
    lines = value.splitlines()
    description = ''
    for index, line in enumerate(lines):
        if line.lstrip().lower().startswith('single layer of waterproofing panel'):
            # Match the complete tested method. A changed condition must never
            # silently inherit wording from another drain arrangement.
            drain = _DRAIN.fullmatch(' '.join(' '.join(lines[index:]).split()))
            if drain:
                description = (
                    'Fix a single layer of waterproofing panel around the puddle flange with board screws at '
                    f'{drain[1]} mm centres. Bond the vitreous tile to the panel with adhesive. '
                    'Fit the square drain through the panel so it sits flush with the tile. '
                    'Fit a small vitreous tile insert into the square drain.')
                lines = lines[:index]
            break
    start = next((i for i, line in enumerate(lines) if _COMPONENT.match(line.strip())), len(lines))
    components = [line.strip() for line in lines[start:]]
    # Only bullet unambiguous one-component-per-line lists. Wrapped alternatives,
    # qualifications and dimension tables retain their original layout.
    if len(components) >= 2 and all(_COMPONENT.match(line) for line in components):
        parts = ['\n'.join(lines[:start]).strip(), '\n'.join('• ' + line for line in components)]
    elif description:
        parts = ['\n'.join(lines).strip()]
    else:
        return value
    if description:
        parts.append(description)
    return '\n\n'.join(part for part in parts if part)


def _installation(value, siblings):
    paragraphs = []
    source = re.split(r'\r?\n[ \t]*\r?\n', value)
    generated = source[0] in _PROCEDURES
    for index, paragraph in enumerate(source):
        if paragraph in _PROCEDURES:
            paragraphs.append('\n'.join(f'{n}. {step}' for n, step in enumerate(_PROCEDURES[paragraph], 1)))
            continue
        lines = paragraph.splitlines()
        # Only discard verified repeats from the generated configuration block.
        # Never infer equivalence from similar sizes, ratings or other variants.
        if generated and index == 1 and len(lines) > 1 and all(
                line.partition(': ')[0] in _REPEATED_FIELDS and ': ' in line for line in lines):
            remaining = [line for line in lines if siblings.get(line.partition(': ')[0]) != line.partition(': ')[2]]
            if remaining:
                paragraphs.append('\n'.join(remaining))
            continue
        if generated and paragraph.startswith(_CLT_CONDITION):
            paragraph = ('Follow the full timber friction-fit installation in FAS200363 Table 30. '
                         'The CLT must have an independent 60 min rating.' + paragraph[len(_CLT_CONDITION):])
        # The source marks this as a maximum. Drop it only when the same limit
        # is already visible in the dedicated Maximum Opening Size field.
        lead, delimiter, limit = paragraph.partition(' All tested local service details retained;maximum aperture:')
        if generated and delimiter:
            paragraph = lead + ' Retain all tested local service details.'
            if limit != siblings.get('Maximum Opening Size'):
                paragraph += ' Maximum aperture: ' + limit
        paragraphs.append(paragraph)
    return '\n\n'.join(paragraphs)


def present_installation_fields(fields):
    """Format the already-copied public fields, after source and variant validation."""
    siblings = {field['label']: field.get('value') for field in fields}
    for field in fields:
        value = field.get('value')
        if field['label'] == 'Installation Details' and isinstance(value, str):
            field['value'] = _installation(value, siblings)
        elif field['label'] == 'Service Size / Configuration' and isinstance(value, str):
            field['value'] = _service_configuration(value)
        elif field['label'] == _SEAL_LABEL and isinstance(value, str) and value in _SEALS:
            field['value'] = _SEALS[value]
