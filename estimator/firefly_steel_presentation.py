"""Readable public fields for Firefly structural steel evidence."""
import hashlib
import re

from .technical_brand_presentation import manufacturer_names
from .technical_table_navigation import field_tables


_SIZE = 'Service Size / Configuration'
_WRAP = 'Service Wrap'
_LOCAL = 'Local Protection'
_INSTALLATION = 'Installation Details'
_FIRST = 'Service (purlin size)'
_H45_SOURCE_SHA256 = '31152c311efe2347c74eb846813c40e1a5d97989276df8d679ad502dce355f49'
_LENGTH = re.compile(r'[0-9]+(?:\.[0-9]+)? mm\Z')
_PURLIN_SERVICE = re.compile(
    r'^Steel C purlin or Z purlin protected with a combination of (?:FIREFLY)?Batt and '
    r'(?:FIREFLY Penowrap|wrap)(?:\s*\(see item (\d+)\))?\.?$', re.I)
_PURLIN_POSITION = re.compile(
    r'^Note[.:] The purlins can be installed at the body of (?:FIREFLY)?Batt or close to edge of '
    r'(?:the )?(?:FIREFLY)?Batt against a concrete slab or a roof insulation\.$', re.I)
_PURLIN_SIZE = 'Up to 200 mm x 77 mm x 1.8 BMT steel “C” purlin.'
_BEAM_SIZE = 'From 150 UB up to 200 UB steel beam.'
_MEMBER_SIZE = 'From 150 UB up to 200 UB steel beam/column.'
# These are the report pages that contain the assessed configurations. The
# generated barrier variants retain them even when their displayed ID differs.
_MEMBER_WRAP_RECORDS = {
    ('fas190236', 'V31', 29): (_BEAM_SIZE, 'Steel beam', 'wall'),
    ('fas190236', 'V33', 31): (_PURLIN_SIZE, 'Purlin', 'wall'),
    ('fas190236', 'H24', 230): (_BEAM_SIZE, 'Steel beam', 'floor'),
    ('fas190236', 'H26', 232): (_PURLIN_SIZE, 'Purlin', 'floor'),
    ('fas190235', 'H43', 89): (_MEMBER_SIZE, 'Steel beam/column', ''),
}
_MEMBER_REPORT_PAGE = re.compile(r', (V31|V33|H24|H26|H43), PDF page \d+\Z')
_EDGE_SUPPORT = {
    'wall': 'a horizontal or vertical support element (including roof insulation)',
    'floor': 'a vertical support element',
}
_FLOOR_WRAP_STEP = (
    'Install 1 layer of FIREFLYPenowrap for: • 300 mm, on each side of the floor, '
    'butting up to the face of the floor, or, • 600 mm, on the topside of the floor, '
    'butting up to the face of the floor.'
)
_WALL_WRAP_STEP = (
    'Install 1 layer of FIREFLYPenowrap for 300 mm, on each side of the wall, '
    'butting up to the face of the wall.'
)
_PACKING = (
    'Wrap only\n\n'
    '1. Apply one layer of FIREFLY Penowrap on both sides of the FIREFLYBatt seal. '
    'Use stainless steel cable ties nominally 50 mm from each end and at 100 mm centres.\n'
    '2. Use FIREFLYMastic or FIREFLYMastic BG to shape and hold the wrap to the purlin profile.\n\n'
    'Four-sided wrap through the body of the FIREFLYBatt seal\n\n'
    '1. Pack the purlin web with FIREFLY Penowrap, FIREFLYBatt, or both.\n'
    '2. Apply one layer of 12 mm FIREFLY Penowrap around all four sides of the purlin for the specified length '
    'on both sides of the seal. Use stainless steel cable ties nominally 50 mm from each end and at 100 mm centres.\n'
    '3. If using FIREFLYBatt packing, coat the exposed edge with 1 mm of FIREFLYMastic BG. '
    'Seal the packing perimeter with FIREFLYMastic so no gaps remain.\n\n'
    'Three-sided wrap at the edge of the FIREFLYBatt seal\n\n'
    '1. Install against a roof with insulation or a concrete slab achieving the required FRL. Pack the web with '
    'FIREFLYBatt or a combination of FIREFLYBatt and FIREFLY Penowrap. Place FIREFLYBatt at the web edges '
    'so the wrap and steel plate can be fixed into it.\n'
    '2. Apply one layer of 12 mm FIREFLY Penowrap around three sides of the purlin for the specified length on '
    'both sides of the seal. Fix the wrap into the web with a mild steel plate at least 0.75 mm thick. '
    'Use pigtail screws 50 mm from the edges and at 100 mm centres.\n'
    '3. If using FIREFLYBatt packing, coat the web surface facing the wrap and the exposed batt face with '
    '1 mm of FIREFLYMastic BG. Seal the packing perimeter with FIREFLYMastic so no gaps remain.\n\n'
    'Support the purlins independently. An appropriately qualified consultant must design project-specific supports '
    'that protect the firestop, separating element and concrete floor slab from loads throughout their service '
    'life, including during a fire.')


def _normal(text):
    return ' '.join(text.split())


def _put(fields, by_label, label, value):
    if label in by_label:
        by_label[label]['value'] = value
    else:
        field = {'label': label, 'value': value}
        fields.append(field)
        by_label[label] = field


def _service(fields, by_label):
    service = by_label.get('Service', {})
    value = _normal(service.get('value', ''))
    identity, _, note = value.partition(' Note. ')
    if not note:
        identity, _, note = value.partition(' Note: ')
    matched = _PURLIN_SERVICE.fullmatch(identity)
    if not matched or note and not _PURLIN_POSITION.fullmatch(f'Note. {note}'):
        return
    local = by_label.get(_LOCAL, {}).get('value', '')
    position = ('The purlin may pass through the body of the FIREFLYBatt seal or near its edge '
                'against a concrete slab or roof insulation.') if note else ''
    if matched[1]:
        position = ' '.join(filter(None, (position, f'See Item {matched[1]} for the assessed detail.')))
    _put(fields, by_label, _LOCAL, '\n\n'.join(filter(None, (local, position))))
    service['value'] = 'Steel C or Z purlin'


def _member_wrap(record, by_label):
    reviewed = set()
    for source in record.get('sources', []):
        matched = _MEMBER_REPORT_PAGE.search(source.get('label', ''))
        if matched:
            proof = (source.get('document_id'), matched[1], source.get('page'))
            if proof in _MEMBER_WRAP_RECORDS:
                reviewed.add(_MEMBER_WRAP_RECORDS[proof])
    if len(reviewed) != 1:
        return
    dimensions, member, barrier = reviewed.pop()
    size, wrap = by_label.get(_SIZE, {}), by_label.get(_WRAP, {})
    if _normal(size.get('value', '')) != f'{dimensions} {member} can be installed:':
        return

    if not barrier:
        # H43 already gives the assessed lengths and both application methods.
        # Only its incomplete lead-in needs removal.
        size['value'] = dimensions
        return

    placement = f'In the body of the {barrier}, using a 4-sided wrap configuration.'
    edge = (f'At the edge of the {barrier}, against {_EDGE_SUPPORT[barrier]}, '
            'requiring the use of a 3-sided wrap configuration.')
    installation = by_label.get(_INSTALLATION, {})
    instructions = installation.get('value', '')
    proof_text = _normal(instructions).replace(f'butting against the {barrier}', f'butting up to the face of the {barrier}')
    first, heading, second = proof_text.partition(f'• At the edge of the {barrier} (3-sided wrap):')
    step = _WALL_WRAP_STEP if barrier == 'wall' else _FLOOR_WRAP_STEP
    if (_normal(wrap.get('value', '')) != f'{placement} {edge}'
            or not first.startswith(f'• In the body of the {barrier} (4-sided wrap):')
            or not heading or step not in first or step not in second):
        return

    length = f'300 mm on each side of the {barrier}'
    if barrier == 'floor':
        length += ' or 600 mm on the topside'
    size['value'] = dimensions
    wrap['value'] = f'One layer of FIREFLYPenowrap for {length}, butting against the {barrier} face.'
    # The edge support scope is more specific than the headings of the steps.
    installation['value'] = f'{edge}\n\n{instructions}'


def _remove_repeated_purlin_table(record, fields, by_label):
    size = by_label.get(_SIZE, {})
    tables = field_tables(size)
    if len(tables) != 1 or size.get('table_captions') not in (None, [], ['Reviewed source configuration']):
        return
    table = tables[0]
    columns, rows = table['columns'], table['rows']
    if (len(columns) != 4 or columns[0] != _FIRST or columns[2:] != ['FRL', 'PDF page']
            or columns[1] not in {'Service Wrap (length)', 'Protection (length)'}
            or len(rows) != 1 or len(rows[0]) != 4):
        return
    section, length, rating, page = map(_normal, rows[0])
    if (section != _normal(size.get('value', '')) or rating != _normal(by_label.get('FRL', {}).get('value', ''))
            or not _LENGTH.fullmatch(length) or not page.isdecimal()):
        return
    proof = {source.get('document_id') for source in record.get('sources', []) if source.get('page') == int(page)}
    if len(proof) != 1 or not re.fullmatch(r'fas\d+', next(iter(proof)) or ''):
        return
    if columns[1] == 'Protection (length)':
        local = by_label.get(_LOCAL, {})
        wrap = by_label.get(_WRAP, {})
        wrap_sha256 = hashlib.sha256(_normal(wrap.get('value', '')).encode()).hexdigest()
        if (length != _normal(local.get('value', '')) or field_tables(local)
                or wrap_sha256 != _H45_SOURCE_SHA256):
            return
        _put(fields, by_label, _WRAP, f'{length} on each side of the FIREFLYBatt seal.\n\n{_PACKING}')
        local['value'] = ('Apply FIREFLYMastic or FIREFLYMastic BG to the full depth of the FIREFLYBatt '
                          'to seal the purlin into the aperture.')
    elif length != _normal(by_label.get(_WRAP, {}).get('value', '')):
        return
    for name in ('table', 'tables', 'table_captions', 'table_row_ids'):
        size.pop(name, None)
    target = {'field': _SIZE, 'table_index': 0}
    for field in fields:
        links = field.get('table_links')
        if links and target in links:
            field['table_links'] = [link for link in links if link != target]
            if not field['table_links']:
                del field['table_links']


def firefly_structural_fields(record, fields):
    """Transform the presentation copy after source and variant validation."""
    if ('Structural Steel' not in record.get('filter_values', {}).get('category', [])
            or 'firefly' not in manufacturer_names(record)):
        return fields
    by_label = {field['label']: dict(field) for field in fields}
    if len(by_label) != len(fields):
        return fields
    result = list(by_label.values())
    _service(result, by_label)
    _member_wrap(record, by_label)
    _remove_repeated_purlin_table(record, result, by_label)
    return result
