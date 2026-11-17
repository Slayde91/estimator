"""Present a selected Trafalgar service and its installation without changing the reviewed source."""
import re


SIZE = 'Service Size / Configuration'
INSTALL = 'Installation Details'
WRAP = 'Service Wrap'
_WRAP_NOTES = {
    'Full insulation ratings require TWrap.',
    "The table's insulation ratings require the specified TWrap.",
    'TWrap is required for the full insulation rating shown in the source table.',
}
_AAC_NOTES = {
    'This entry specifies WALSC, while the linked source describes Hebel with a patch. The source table does not establish WALSC applicability.',
    'This entry specifies WALSC, while the linked source describes Hebel with a plasterboard patch. The source table does not establish WALSC applicability.',
    'The source identifies 75mm Hebel Powerpanel; it does not establish the WALSC construction assigned by the selector.',
    'Barrier scope not verified by this diagram: selector states WALSC 75mm; diagram states Hebel wall. No WALSC applicability table is printed on this image. Retain selector attribution; do not infer equivalence.',
    'The entry names WALSC, but that product is not explicitly identified in the source drawing.',
}
_SEAL_NOTES = {
    'The annular gap and FyreFLEX depth are indicated without numerical values.': '',
    'Annular gap, sealant depth and service fillet dimensions are indicated without numerical values.': '',
    'An alternative patch below the slab is illustrated; annular gap and sealant depth are indicated without numerical values.':
        'An alternative patch below the slab is illustrated.',
}
_PATCH_NOTE = ('The source Hebel arrangement includes a 13 mm FR plasterboard patch overlapping the penetration '
               'by at least 100 mm. Its table does not describe an unpatched wall.')
_PATCH_STEP = 'Fit a 13 mm fire-rated plasterboard patch with at least 100 mm overlap around the penetration.'
_WRAP_STEP = re.compile(
    r'(?m)^((?:Page \d+:[ \t]*)?\d+\. )Where required, wrap the SuperSTOPPER and services to the correct length'
    r'(?: \((?:as per [^)]+|SEE PAGE 2)\)| shown in the source FRL table)\.?[ \t]*$', re.I)
_WIDTH = re.compile(r'^(\d+(?:\.\d+)?)\s*mm$', re.I)
_TABLE_KEYS = ('table', 'tables', 'table_row_ids', 'table_captions')
_SERVICE_GROUPS = {'bare metal pipes', 'insulated metal pipes', 'aluminium cables'}


def _text(fields, label):
    return fields.get(label, {}).get('value', '').strip()


def _selected_rows(field):
    """The first applicable table describes the service. Subsequent tables may be related evidence only."""
    table = field.get('table') or next(iter(field.get('tables', [])), {})
    headers = [c.strip().casefold() for c in table.get('columns', [])]
    if 'service detail' not in headers:
        return []
    return [dict(zip(headers, row, strict=True)) for row in table['rows']]


def _wrap_requirement(row, selected):
    length = row.get('twrap length', '').strip() or selected
    no_wrap_rating = row.get('frl - wrap free', '')
    if selected.casefold() == 'no wrap' or (no_wrap_rating and 'frl' not in row):
        return 'No service TWrap is required for the selected wrap-free rating.'
    if not length or length.casefold().startswith('source table does not specify a wrap length'):
        return ''
    if _WIDTH.fullmatch(length):
        text = f'Apply {length} of TWrap to the service for the full insulation rating.'
    else:
        text = f'For the full insulation rating, apply the specified service TWrap ({length.rstrip(".")}).'
    if no_wrap_rating:
        text += f' The wrap-free rating is {no_wrap_rating}.'
    return text


def _wrap_step(rows, scalar):
    if len(rows) <= 1:
        return _wrap_requirement(rows[0] if rows else {}, scalar)
    requirements = {}
    for row in rows:
        requirement = _wrap_requirement(row, '')
        if not requirement or not row['service detail']:
            return ''
        requirements.setdefault(requirement, []).append(row['service detail'])
    if len(requirements) == 1:
        return next(iter(requirements))
    return 'Use the following service TWrap requirements. ' + ' '.join(
        f'For {", ".join(dict.fromkeys(services))}, {requirement[0].lower() + requirement[1:]}' for requirement, services in requirements.items())


def _single_service(fields, rows):
    size = fields.get(SIZE, {})
    if len(rows) != 1 or size.get('tables') or not size.get('table'):
        return
    row = rows[0]
    if not row['service detail'] or any(not (name in ('service detail', 'service type', 'twrap length', 'twrap/servowrap length')
                                             or 'frl' in name) for name in row):
        return
    source = size.get('value', '').strip()
    if source and source != row['service detail'] and not source.startswith(('Service Type:', 'Service Detail:')):
        return
    value = row['service detail']
    service_type = row.get('service type', '').strip()
    # A table can carry an installation condition in its service group, outside
    # the selected detail (heat trace under insulation, bare pipes or a diameter).
    if (service_type.casefold() not in _SERVICE_GROUPS
            and re.search(r'\b(?:with|without|bare|insulated|lagged|aluminium)\b|\d', service_type, re.I)
            and service_type.casefold() not in (_text(fields, 'Service') + '\n' + value).casefold()):
        value += f'\n{service_type}'
    wrap = row.get('twrap length', '')
    selected = _text(fields, WRAP)
    free = row.get('frl - wrap free', '')
    if wrap and value.casefold() == 'nbn fibre optic cable' and selected.casefold() != 'no wrap' and (not free or 'frl' in row):
        value += f' - {wrap} TWrap required.'
    # Printed alternatives, qualified column headings and source conditions survive tabular presentation.
    for heading, rating in zip(size['table']['columns'], size['table']['rows'][0], strict=True):
        if 'frl' in heading.casefold() and rating and (heading.casefold() != 'frl' or rating not in _text(fields, 'FRL')):
            value += f'\n{heading} {rating}'
    if 'twrap/servowrap length' in row and row['twrap/servowrap length'] not in selected:
        value += f'\nTWrap/ServoWrap length {row["twrap/servowrap length"]}'
    if wrap and not selected and WRAP in fields:
        fields[WRAP]['value'] = wrap
    elif wrap and not selected and 'TWrap required.' not in value:
        value += f'\nTWrap length {wrap}'
    size['value'] = value
    for name in _TABLE_KEYS:
        size.pop(name, None)
    for field in fields.values():
        if 'table_links' in field:
            links = [link for link in field['table_links'] if link['field'] != SIZE]
            if links:
                field['table_links'] = links
            else:
                field.pop('table_links')
        field['value'] = field.get('value', '').replace(SIZE + ' table 1', SIZE)


def present_service_instructions(original):
    fields = {f['label']: dict(f) for f in original}
    options = _text(fields, 'Source Options').split('\n\n')
    issues = _text(fields, 'Source Issues').split('\n\n')
    rows = _selected_rows(fields.get(SIZE, {}))
    installation = fields.get(INSTALL, {}).get('value', '')
    seal = _text(fields, 'Seal Depth / Fillet Size')
    if 'Source Issues' in fields:
        issues = [issue for issue in issues if issue not in _AAC_NOTES]
        if seal and seal.upper() != 'N/A':
            issues = [_SEAL_NOTES.get(issue, issue) for issue in issues]
        fields['Source Issues']['value'] = '\n\n'.join(filter(None, issues))
    if _PATCH_NOTE in options and installation:
        if _PATCH_STEP not in installation:
            first, separator, rest = installation.partition('\n')
            installation = first + ' ' + _PATCH_STEP + separator + rest
        options = [o for o in options if o != _PATCH_NOTE]
    if 'FC10266-01-5' in _text(fields, 'Report Number').splitlines() and _WRAP_STEP.search(installation):
        selected = _text(fields, WRAP)
        if (rows and all('+30mm maxilite frl' in row and not row.get('twrap length') for row in rows)
                and selected.casefold().startswith('source table does not specify a wrap length')):
            # FC10266-01-5 Table 8 separates the Maxilite and service TWrap configurations.
            step = 'Follow the selected 30 mm Maxilite patch arrangement.'
        else:
            step = _wrap_step(rows, selected)
            if step and 'around the SuperSTOPPER' not in step:
                step += ' Follow the specified SuperSTOPPER casing wrap arrangement.'
        if step:
            installation = _WRAP_STEP.sub(lambda match: match[1] + step, installation)
            options = [o for o in options if o not in _WRAP_NOTES]
    if INSTALL in fields:
        fields[INSTALL]['value'] = installation
    if 'Source Options' in fields:
        fields['Source Options']['value'] = '\n\n'.join(filter(None, options))
    _single_service(fields, rows)
    return [fields[f['label']] for f in original if f['label'] not in ('Source Issues', 'Source Options')
            or fields[f['label']]['value'] or any(f.get(name) for name in ('table', 'tables', 'images', 'table_links'))]
