"""Portable register pin locations and resolution against the current project's drawings."""
from collections import defaultdict
from math import isfinite
import re
from uuid import UUID

from .catalog import ValidationError


def _uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except ValueError:
        return False


def normalize_pins(value):
    if not isinstance(value, list) or len(value) > 200:
        raise ValidationError('Each register entry supports up to 200 plan pins.')
    keys = {'project_id', 'document_id', 'sha256', 'page', 'x', 'y'}
    pins = []
    for pin in value:
        if (not isinstance(pin, dict) or set(pin) != keys
                or not all(_uuid(pin[key]) for key in ('project_id', 'document_id'))
                or not isinstance(pin['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', pin['sha256'])
                or type(pin['page']) is not int or not 1 <= pin['page'] <= 2000
                or any(type(pin[key]) not in (int, float) or not 0 <= pin[key] <= 1
                       or not isfinite(pin[key]) for key in ('x', 'y'))):
            raise ValidationError('A plan pin must identify an original PDF, page and point inside the drawing.')
        pins.append(dict(pin))
    return pins


def penetration_ids(entry):
    sides = ('side1', 'side2') if entry['access'] == 'Yes' else ('side1',)
    return ' / '.join(entry[side]['id_number'] for side in sides)


def append_plan_pages(pdf, entries, sessions, service, *, allow_unused_sessions=False, entry_label=penetration_ids):
    # The register stores stable workspace IDs. Temporary session capabilities
    # come from the currently loaded estimate collection, never from saved pins.
    if service is None or not isinstance(sessions, dict) or len(sessions) > 50:
        raise ValidationError('Open the project with its Takeoffs drawings to download the pinned plans.')
    groups = defaultdict(lambda: defaultdict(list))
    for entry in entries:
        label = entry_label(entry)
        for pin in entry.get('plan_pins', []):
            groups[pin['project_id']][pin['document_id']].append((pin, label))
    # A completed-only register can receive sessions for drawings pinned solely
    # by unfinished entries. Only the sessions used by the export are opened.
    if (groups.keys() - sessions.keys() or (not allow_unused_sessions and sessions.keys() - groups.keys())
            or not all(_uuid(project) and _uuid(session) for project, session in sessions.items())):
        raise ValidationError('A pinned plan is unavailable. Reopen the original project with its evidence folder.')
    # The same PDF may be present in more than one estimate. Emit each original
    # sheet once, while preserving pins from every contributing estimate.
    documents = {}
    marks = defaultdict(list)
    for project_id, by_id in groups.items():
        for doc in service.register_plan_documents(sessions[project_id], project_id, set(by_id)):
            digest = doc['sha256']
            documents.setdefault(digest, doc)
            for pin, label in by_id[doc['id']]:
                if digest != pin['sha256'] or pin['page'] > len(doc['pages']):
                    raise ValidationError('A pinned plan no longer matches the original PDF or page.')
                marks[digest, pin['page']].append({'x': pin['x'], 'y': pin['y'], 'label': label})
    from .takeoff_pdf_tools import compose_retained_pages
    order, pins = [], []
    for source, digest in enumerate(documents):
        for page in sorted(number for key, number in marks if key == digest):
            order.append({'source': source, 'page': page})
            pins.append(marks[digest, page])
    return compose_retained_pages(list(documents.values()), order, service.documents, register_pdf=pdf, pins=pins)
