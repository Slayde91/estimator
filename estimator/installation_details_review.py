"""Apply source-bound installation reviews to a Technical Library detail copy."""

from .firefly_installation_review import firefly_reviewed_installation_fields
from .trafalgar_fyre_batt_installation import trafalgar_fyre_batt_installation
from .trafalgar_fyreflex_installation import trafalgar_fyreflex_installation
from .trafalgar_maxilite_installation import trafalgar_maxilite_installation_fields
from .trafalgar_other_installation import present_trafalgar_other_installation
from .trafalgar_superstopper_installation import trafalgar_superstopper_installation_fields


def reviewed_installation_details(record, fields):
    """Preserve published procedures and apply the first matching review."""
    if any(field['label'] == 'Installation Details' and (field.get('value', '').strip()
            or field.get('table') or field.get('tables')) for field in fields):
        return fields
    for apply_review in (firefly_reviewed_installation_fields, trafalgar_fyre_batt_installation,
                         trafalgar_fyreflex_installation, trafalgar_superstopper_installation_fields,
                         trafalgar_maxilite_installation_fields,
                         present_trafalgar_other_installation):
        reviewed = apply_review(record, fields)
        if reviewed is not fields:
            return reviewed
    return fields
