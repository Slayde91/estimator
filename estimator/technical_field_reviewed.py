"""Apply private, source-bound editorial reviews without shipping source text.

Reviews belong to the installed local library bundle. Both original evidence and
the generic projection must match the review's fingerprints before it is used.
"""

from copy import deepcopy
import hashlib
import json
import re


def review_fingerprint(value):
    """Stable fingerprint shared by the local review tool and read projection."""
    payload = json.dumps(value, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=False, allow_nan=False).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


def normalize_reviewed_content(fields, review=None, source_fields=None):
    """Apply a matching review, or fail closed if its evidence has changed.

    ReferenceLibrary validates reviewed field text, images and table shape using
    the same rules as ordinary imported fields before calling this projection.
    """
    if review is None:
        return deepcopy(fields)
    if not isinstance(review, dict) or not isinstance(review.get('fields'), list):
        raise ValueError('Invalid Technical Library field review.')
    for key in ('source_fields_sha256', 'pre_review_fields_sha256'):
        if not isinstance(review.get(key), str) or not re.fullmatch(r'[a-f0-9]{64}', review[key]):
            raise ValueError('Invalid Technical Library field review fingerprint.')
    if source_fields is None or review['source_fields_sha256'] != review_fingerprint(source_fields):
        raise ValueError('Technical Library source fields changed; review must be updated.')
    if review['pre_review_fields_sha256'] != review_fingerprint(fields):
        raise ValueError('Technical Library field projection changed; review must be updated.')
    if any(not isinstance(field, dict) or not isinstance(field.get('label'), str)
           or not isinstance(field.get('value'), str) for field in review['fields']):
        raise ValueError('Invalid Technical Library reviewed fields.')
    return deepcopy(review['fields'])
