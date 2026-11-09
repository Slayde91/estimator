"""Completeness checks for explicit Project writes, separate from legacy loading."""

import unicodedata

from .catalog import ValidationError


REQUIRED_PROJECT_DETAILS = (
    ('project_no', 'Project No.'), ('client', 'Client'),
    ('site_address', 'Site Address'), ('contact_name', 'Contact name'),
    ('contact_email', 'Contact email'), ('contact_phone', 'Contact phone'),
)


def require_project_details(details, *, automatic_number=False):
    """Reject incomplete explicit saves before allocation or file side effects.

    Read/import/export validators remain permissive for historical projects.
    A new Project's number is supplied by the server only after this check.
    """
    missing = [label for key, label in REQUIRED_PROJECT_DETAILS
               if not (key == 'project_no' and automatic_number)
               and not (isinstance(details.get(key), str) and ''.join(
                   char for char in details[key] if unicodedata.category(char) != 'Cf').strip())]
    if missing:
        raise ValidationError('Complete required Project details: ' + ', '.join(missing) + '.')

