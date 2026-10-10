"""Explicit distribution capabilities, independent of saved user preferences.

The standard desktop distribution intentionally has no TAKEOFFS implementation.
Edition checks must therefore run before importing that implementation or granting
access to a project that this distribution cannot preserve.
"""

import re

from .catalog import ValidationError


TAKEOFF_PROJECT_ERROR = (
    'This project contains TAKEOFFS or uses its project version. '
    'Open it in an edition with TAKEOFFS support. The project and its evidence '
    'have not been changed; this edition cannot open or overwrite them.'
)
TAKEOFF_ASSETS = frozenset({
    '/takeoffs.js', '/takeoffs.css', '/takeoff-geometry.js',
    '/takeoff-physical.js', '/takeoff-pdf-worker.mjs',
    '/takeoff-annotations.js', '/takeoff-signatures.js', '/takeoff-search.js', '/takeoff-shortcuts.js',
    '/icons/default-memory.svg', '/icons/signature.svg',
    '/icons/takeoff-colour-wheel.png', '/icons/takeoff-legend.png', '/icons/takeoff-visibility.jpg',
    '/icons/navigation-takeoffs.png',
    '/icons/takeoff-callout.png',
    '/takeoff-library-links.js', '/icons/takeoff-visibility.png',
    '/icons/takeoff-bullet-list.png', '/icons/takeoff-numbered-list.png',
    '/icons/takeoff-add-service.png', '/icons/takeoff-add-barrier.png', '/icons/takeoff-transfer.png',
})
_START = b'<!-- TAKEOFFS:START -->'
_END = b'<!-- TAKEOFFS:END -->'


def validate_edition(edition):
    if not isinstance(edition, str) or edition not in ('full', 'standard'):
        raise ValidationError('Choose the full or standard application edition.')
    return edition


def features(edition):
    return {'takeoffs': validate_edition(edition) == 'full'}


def require_project_edition(value, edition):
    """Reject incompatible input before calculation, imports, dialogs or writes."""
    if validate_edition(edition) == 'standard' and isinstance(value, dict):
        if ('takeoffs' in value or 'takeoffs_session_id' in value
                or value.get('version') == 2):
            raise ValidationError(TAKEOFF_PROJECT_ERROR)


def excluded_route(route, edition):
    if validate_edition(edition) == 'full':
        return False
    return (route in TAKEOFF_ASSETS or route.removeprefix('/static') in TAKEOFF_ASSETS
            or re.fullmatch(r'/api/libraries/penetration/[a-z0-9][a-z0-9_-]{0,119}/takeoff', route) is not None
            or route == '/api/takeoffs'
            or route.startswith('/api/takeoffs/') or route == '/vendor/pdfjs'
            or route.startswith('/vendor/pdfjs/') or route == '/static/vendor/pdfjs'
            or route.startswith('/static/vendor/pdfjs/') or route == '/vendor/ocr'
            or route.startswith('/vendor/ocr/') or route == '/static/vendor/ocr'
            or route.startswith('/static/vendor/ocr/'))


def render_index(payload, edition):
    """Remove five reviewed feature blocks, failing closed on template drift."""
    if validate_edition(edition) == 'full':
        return payload
    if payload.count(_START) != 5 or payload.count(_END) != 5:
        raise ValidationError('The installed standard-edition page is incomplete.')
    output, inside = [], False
    for part in re.split(b'(' + re.escape(_START) + b'|' + re.escape(_END) + b')', payload):
        if part == _START:
            if inside:
                raise ValidationError('The installed edition page has overlapping feature blocks.')
            inside = True
        elif part == _END:
            if not inside:
                raise ValidationError('The installed edition page has mismatched feature blocks.')
            inside = False
        elif not inside:
            output.append(part)
    result = b''.join(output)
    if inside or any(value in result for value in (
            b'/takeoff', b'/vendor/pdfjs', b'/vendor/ocr', b'data-view="takeoffs"',
            b'data-home-view="takeoffs"', b'id="view-takeoffs"')):
        raise ValidationError('The installed standard-edition page contains unsupported feature references.')
    return result
