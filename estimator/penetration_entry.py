"""Required descriptive fields for new Firestopping entries only.

Historical drafts remain readable, calculable and saveable. Call this guard at
entry boundaries rather than changing workbook normalization or calculations.
"""

from .catalog import ValidationError


REQUIRED_ITEM_FIELDS = (('J', 'Category'), ('K', 'Service Type'),
                        ('L', 'Penetration Type'), ('M', 'Substrate Orientation'),
                        ('N', 'FRL'), ('P', 'Substrate'))


def required_item_fields():
    return [{'column': column, 'label': label} for column, label in REQUIRED_ITEM_FIELDS]


def validate_item_for_add(draft):
    from .penetration_calculator import normalize_composer
    normalized = normalize_composer(draft)
    inputs = normalized['rows'][0]['inputs']
    missing = [label for column, label in REQUIRED_ITEM_FIELDS
               if inputs.get(column) is None or not str(inputs[column]).strip()]
    if missing:
        raise ValidationError('Complete ' + ', '.join(missing)
                              + ' before adding this Firestopping item.')
    mastic_type, mastic_qty = inputs.get('AB'), inputs.get('AC')
    if mastic_type and not (isinstance(mastic_qty, (int, float)) and mastic_qty > 0):
        raise ValidationError('Enter a Mastic Qty greater than zero for the selected Mastic Type.')
    if mastic_qty not in (None, '', 0) and not mastic_type:
        raise ValidationError('Choose a Mastic Type for the entered Mastic Qty.')
    return normalized
