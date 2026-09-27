"""Remove only repeated selector cable quantities, preserving every qualifier."""

import re


def clean_service_size(value):
    # The selector repeats a short trailing quantity in Service type, then
    # supplies the same quantity with units in Service details. Never remove
    # different quantities or quantities separated by another requirement.
    pattern = r'\b(Up to\s+\d+)\s*\n+\s*(ø\s*\1\b)'
    value, count = re.subn(pattern, r'\2', value, flags=re.I)
    if count:
        value = re.sub(r'\s*\n+\s*', ', ', value)
        value = re.sub(r'\.\s*,\s*', '. ', value)
        value = re.sub(r'\s+', ' ', value).strip()
    return value
