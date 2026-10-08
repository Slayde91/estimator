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
    return normalized
