"""Approved ductwork input choices, separate from immutable workbook evidence.

Known aliases are canonicalized; unrecognized historical values remain intact
so the application can display them for correction instead of losing data.
"""

from copy import deepcopy
from decimal import Decimal, InvalidOperation


DUCTWORK_CHOICES = {
    'C': ('CAFCO 300', 'MONOKOTE', 'FyreWrap'),
    'E': ('60/60/60', '90/90/90', '120/120/120', '180/180/180', '240/240/180'),
    'H': ('Internal', 'External', 'Both', 'Stair pressurisation', 'Other pressurisation'),
    'I': ('Horizontal', 'Vertical', 'Both'),
}

_EXPOSURE_ALIASES = {
    'Mixed': 'Both',
    'Kitchen exhaust - inside': 'Internal',
    'Kitchen exhaust - outside': 'Internal',
    'Diesel pump ventilation': 'Internal',
    'Other exhaust': 'Internal',
    'Kitchen + smoke exhaust': 'Both',
    'Smoke exhaust': 'Both',
    'Stair pressure relief': 'Both',
}
_LEGACY_EXHAUST = frozenset(name.casefold() for name in _EXPOSURE_ALIASES if name != 'Mixed')


def _known_text(value, choices, aliases=None):
    if not isinstance(value, str):
        return value
    mapping = {choice.casefold(): choice for choice in choices}
    mapping.update({alias.casefold(): canonical for alias, canonical in (aliases or {}).items()})
    return mapping.get(value.strip().casefold(), value)


def canonical_frl(value):
    """Expand the approved numeric/partial ratings without rounding others."""
    if type(value) in (int, float) and value in (60, 90, 120, 180):
        return '/'.join([str(int(value))] * 3)
    if isinstance(value, str):
        compact = ''.join(value.split())
        if compact in DUCTWORK_CHOICES['E']:
            return compact
        if compact in ('120/120/-', '120/120/60'):
            return '120/120/120'
        try:
            minutes = Decimal(value.strip())
        except InvalidOperation:
            return value
        if minutes.is_finite() and minutes in (60, 90, 120, 180):
            return '/'.join([str(int(minutes))] * 3)
    return value


def canonical_exposure(value):
    """Map the approved legacy application names to their fire directions."""
    return _known_text(value, DUCTWORK_CHOICES['H'], _EXPOSURE_ALIASES)


def legacy_exhaust_frl(product, exposure, value):
    """Apply the approved minimum to known legacy exhaust applications only.

    Unsupported ratings and ratings above 120 minutes are never downgraded.
    """
    rating = canonical_frl(value)
    named_exhaust = isinstance(exposure, str) and exposure.strip().casefold() in _LEGACY_EXHAUST
    if named_exhaust:
        return application_frl(product, canonical_exposure(exposure), rating)
    return rating


def application_frl(product, exposure, value):
    """Use the highest supported application rating, retaining direction.

    Internal, External and Both are exhaust applications; the displayed maximum
    does not turn External into a full-insulation pressurisation requirement.
    Unknown and blank ratings remain visible for correction. Higher ratings
    remain unsupported instead of being silently reduced to 120 minutes.
    """
    rating = canonical_frl(value)
    exposure = canonical_exposure(exposure)
    if canonical_ductwork_value('C', product) != 'FyreWrap':
        return rating
    if exposure in ('Internal', 'External', 'Both', 'Stair pressurisation', 'Other pressurisation'):
        if rating in ('60/60/60', '90/90/90'):
            return '120/120/120'
        if exposure in ('Internal', 'Both') and isinstance(rating, str) and ''.join(rating.split()) == '-/30/30':
            return '120/120/120'
    return rating


def canonical_ductwork_value(column, value):
    """Canonicalize recognized choices without discarding unknown values."""
    if column == 'C':
        return _known_text(value, DUCTWORK_CHOICES['C'], {'CAFCO': 'CAFCO 300'})
    if column == 'E':
        return canonical_frl(value)
    if column == 'H':
        return canonical_exposure(value)
    if column == 'I':
        return _known_text(value, DUCTWORK_CHOICES['I'], {'Mixed': 'Both'})
    return value


def normalize_schedule_choices(inputs, model):
    """Return a canonical overlay, including only changed source fallbacks.

    Explicit blanks always take precedence over example/source values. Reading
    missing values from the source lets a product-only or FRL-only edit apply
    the same policy as a complete imported row, without populating blank rows.
    """
    schedule = model['schedule']
    name = schedule['sheet']
    source = next(sheet for sheet in model['sheets'] if sheet['name'] == name)['cells']
    result = {sheet: dict(cells) for sheet, cells in inputs.items()}
    overrides = result.get(name, {})
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        original = {column: overrides.get(f'{column}{row}', source.get(f'{column}{row}', {}).get('value'))
                    for column in DUCTWORK_CHOICES}
        canonical = {column: canonical_ductwork_value(column, value) for column, value in original.items()}
        canonical['E'] = application_frl(canonical['C'], canonical['H'], canonical['E'])
        for column, value in canonical.items():
            if type(value) is not type(original[column]) or value != original[column]:
                overrides[f'{column}{row}'] = value
    if overrides or name in result:
        result[name] = overrides
    return result


def apply_ductwork_choices(model):
    """Update only caller-owned runtime validation metadata, not source data."""
    schedule = model['schedule']
    sheet = next(item for item in model['sheets'] if item['name'] == schedule['sheet'])
    validations = {}
    for column, choices in DUCTWORK_CHOICES.items():
        reference = f"{column}{schedule['first_row']}:{column}{schedule['last_row']}"
        validation = {'type': 'list', 'sqref': reference,
                      'formula1': '"' + ','.join(choices) + '"',
                      'allowBlank': '1', 'errorStyle': 'stop', 'showErrorMessage': '1'}
        validations[reference] = validation
        field = next(item for item in schedule['columns'] if item['column'] == column)
        field['validation'] = deepcopy(validation)
    sheet['validations'] = [deepcopy(validations.get(item.get('sqref'), item)) for item in sheet['validations']]
    for node in sheet.get('metadata', []):
        if node.get('tag') != 'dataValidations':
            continue
        for rule in node.get('children', []):
            validation = validations.get(rule.get('attributes', {}).get('sqref'))
            if validation is None:
                continue
            rule['attributes'] = {key: value for key, value in validation.items() if key != 'formula1'}
            rule['children'] = [{'tag': 'formula1', 'attributes': {}, 'text': validation['formula1'], 'children': []}]
