"""Stable Technical Library IDs for assessed SNAP variants of a published selector."""
import re
from uuid import NAMESPACE_URL, uuid5


def variant_record_id(parent_sid, variant_key):
    if (type(parent_sid) is not int or parent_sid <= 0 or not isinstance(variant_key, str)
            or len(variant_key) > 120 or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', variant_key)):
        raise ValueError('Invalid SNAP parent number or assessed variant key.')
    name = f'Snap Fire Systems AU/system/{parent_sid}/variant/{variant_key}'
    return 'user-technical-' + uuid5(NAMESPACE_URL, name).hex
