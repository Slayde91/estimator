"""Present reviewed Promat alternatives in order, retaining source evidence."""

import hashlib
import re


# Exact paragraph fingerprints bind the editorial removal to reviewed local
# evidence. Supplier prose stays in the installed private library.
_REPEATED_SHA256 = '96c9effa6706afda78f0e226e8023787e37f1e8884a8b83d3800457bffd2a388'
_REQUIRED_SHA256 = frozenset((
    'c73afb655ef1d67d6691b98f6112bac61a95fadf75a7c28a259d04bb08eb900e',
    'da257e88ce52e93dd28b68175a56ba38972bde7eca17909ba4d96cc2bac49a13',
    _REPEATED_SHA256,
))
_ALTERNATIVE = re.compile(r'^Alternative (\d+)\b')


def clean_installation_details(value):
    """Sort complete contiguous alternatives; remove only a verified repetition.

    The two FCW/Speedpanel alternatives repeat the exact selector summary below.
    Keep its unique location condition. Any changed/extra requirement prevents
    removal. Never rewrite numbers, labels, cross-references or source fields.
    """
    paragraphs = value.split('\n\n')
    fingerprints = [hashlib.sha256(p.encode('utf-8')).hexdigest() for p in paragraphs]
    if _REQUIRED_SHA256.issubset(fingerprints):
        paragraphs[fingerprints.index(_REPEATED_SHA256)] = 'Location: Wall - center.'
    start = 0
    while start < len(paragraphs):
        if not _ALTERNATIVE.match(paragraphs[start]):
            start += 1
            continue
        end = start + 1
        while end < len(paragraphs) and _ALTERNATIVE.match(paragraphs[end]):
            end += 1
        numbers = [int(_ALTERNATIVE.match(p)[1]) for p in paragraphs[start:end]]
        # Do not guess missing alternatives or resolve duplicate numbering.
        if sorted(numbers) == list(range(1, len(numbers) + 1)):
            paragraphs[start:end] = sorted(paragraphs[start:end],
                key=lambda p: int(_ALTERNATIVE.match(p)[1]))
        start = end
    return '\n\n'.join(paragraphs)
