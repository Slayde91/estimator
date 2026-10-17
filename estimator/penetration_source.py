"""Portable source metadata for editable Firestopping schedule rows."""
from copy import deepcopy
import re
from uuid import UUID

from .catalog import ValidationError


def validate_source(value):
    keys = {'version', 'scope', 'project_id', 'graph_id', 'service_id',
            'service_revision', 'barrier_id', 'barrier_revision',
            'context_sha256', 'service_size'}
    if not isinstance(value, dict) or set(value) != keys or type(value['version']) is not int or value['version'] != 1:
        raise ValidationError('The manual Takeoff source descriptor is invalid.')
    if value['scope'] not in ('defect_reports', 'service_plans'):
        raise ValidationError('The manual Takeoff scope is invalid.')
    for key in ('project_id', 'graph_id', 'service_id', 'barrier_id'):
        try:
            if not isinstance(value[key], str) or str(UUID(value[key])) != value[key]:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ValidationError('Manual Takeoff source IDs must be canonical UUIDs.') from None
    for key in ('service_revision', 'barrier_revision'):
        if type(value[key]) is not int or not 0 <= value[key] <= 1_000_000_000:
            raise ValidationError('The manual Takeoff source revision is invalid.')
    if not isinstance(value['context_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', value['context_sha256']):
        raise ValidationError('The manual Takeoff context fingerprint is invalid.')
    size = value['service_size']
    if (not isinstance(size, str) or len(size) > 2000
            or any(ord(c) < 32 and c not in '\n\r\t' for c in size)
            or any(0xD800 <= ord(c) <= 0xDFFF for c in size)):
        raise ValidationError('The literal source service size must be bounded text.')
    return deepcopy(value)
