"""Derived draft callouts with independent source annotations and quantities."""
import re

from .catalog import ValidationError
from .takeoff_model import object_fields, points, page_metadata
from .takeoff_physical_operations import current_graph


def _line(values):
    return ' · '.join(re.sub(r'[\r\n\t]+', ' ', str(value)) for value in values
                      if value is not None and value != '')


def _number(value):
    """Browser Number text without rounding the recorded measurement."""
    from decimal import Decimal
    if value is None:
        return ''
    if isinstance(value, (int, float)):
        if value == int(value):
            return str(int(value))
        if abs(value) >= 1e-6:
            return format(Decimal(str(value)), 'f')
        return re.sub(r'e([+-])0+', r'e\1', str(value))
    return str(value)


def _defect_line(defect):
    fields = defect['fields']
    return _line([defect['display_id'], fields.get('label'), fields.get('location'),
                  'FRL ' + fields['frl'] if fields.get('frl') else None])


def service_summary(service):
    """Keep explicit quantity, category, type and dimensions under their barrier."""
    values = service['fields']
    detail = [service['display_id'], f"{service['quantity']} ×" if service['quantity'] is not None else 'Quantity unknown', values.get('label'),
              values.get('service'), values.get('service_type') or 'Service type not recorded', values.get('size'), values.get('width_height_mm')]
    width, height = values.get('width_mm'), values.get('height_mm')
    if width is not None or height is not None:
        detail.append(f"{_number(width)} x {_number(height)} mm")
    if values.get('diameter_mm') is not None:
        detail.append(f"Ø {_number(values['diameter_mm'])} mm")
    if values.get('insulation_mm') is not None:
        detail.append(f"Insulation {_number(values['insulation_mm'])} mm")
    return _line(detail)


def _barrier_lines(graph, barrier):
    fields = barrier['fields']
    parts = [barrier['display_id']]
    keys = ('label', 'barrier_type', 'substrate', 'orientation') if graph['version'] == 2 else (
        'label', 'location', 'barrier_type', 'substrate', 'orientation')
    for key in keys:
        value = fields.get(key) or ('Substrate not recorded' if key == 'substrate' else None)
        if value:
            parts.append(str(value))
    if fields.get('thickness_mm') is not None:
        parts.append(f"{_number(fields['thickness_mm'])} mm thick")
    frl = fields.get('frl')
    if graph['version'] == 2:
        defect = next(value for value in graph['defects'] if value['id'] == barrier['defect_id'])
        frl = defect['fields'].get('frl')
    if frl:
        parts.append('FRL ' + frl)
    service_lines = []
    for service in graph['services']:
        if service['deleted'] or service['barrier_id'] != barrier['id']:
            continue
        service_lines.append(service_summary(service))
    return [_line(parts), *(service_lines or ['0 services'])]


def barrier_summary(graph, barrier):
    """A defect header precedes the selected barrier and its services."""
    header = []
    if graph['version'] == 2:
        header = [_defect_line(next(value for value in graph['defects'] if value['id'] == barrier['defect_id']))]
    return [*header, *_barrier_lines(graph, barrier)]


def defect_annotation(defect, document_id):
    """Read old source regions without rewriting their evidence or graph."""
    if 'annotation' in defect:
        return defect['annotation']
    reference = next((value for value in defect['evidence']
                      if value['document_id'] == document_id and value.get('region')), None)
    if not reference:
        return None
    return {key: reference[key] for key in ('document_id', 'document_sha256', 'page')} | {
        'point': [sum(vertex[axis] for vertex in reference['region']) / len(reference['region'])
                  for axis in (0, 1)]}


def defect_summary(graph, defect):
    """Describe every current explicit substrate/type link without inference."""
    barriers = [value for value in graph['barriers']
                if not value['deleted'] and value['defect_id'] == defect['id']]
    details = [line for barrier in barriers for line in _barrier_lines(graph, barrier)]
    if not barriers:
        details.append('0 substrates · 0 services')
    return [_defect_line(defect), *details]


def inherited_library_barrier_parent(snapshot, graph, barrier):
    """Only an explicitly imported, still-identical source shares its parent label."""
    if graph['version'] != 2 or barrier['deleted'] or not barrier.get('marker'):
        return None
    defect = next((value for value in graph['defects'] if value['id'] == barrier['defect_id']), None)
    if not defect or defect['deleted'] or not defect.get('annotation') or barrier['marker'] != defect['annotation']:
        return None
    for record in snapshot.get('library_assignments', {}).get('records', []):
        selection = record.get('barrier_selection')
        if (record['scope'] == 'defect_reports' and isinstance(selection, dict)
                and type(selection.get('version')) is int and selection['version'] == 1
                and selection.get('choice') == 'new' and selection.get('defect_id') == defect['id']
                and selection.get('barrier_id') == barrier['id']):
            return defect['id']
    return None


def export_physical_pdf(snapshot, request, documents):
    required = {'expected_revision', 'mode', 'physical_scope', 'document_id', 'item_ids'}
    object_fields(request, required | {'rendering', 'signature_ids'}, 'Penetration drawing export', required)
    graph = current_graph(snapshot, request['physical_scope'])
    if graph['version'] not in (2, 3):
        raise ValidationError('Legacy physical hierarchies cannot have barrier count markers.')
    document, _ = page_metadata(snapshot, request['document_id'], 1)
    rendering = request.get('rendering', {'zoom': 1, 'rotations': {}})
    object_fields(rendering, {'zoom', 'rotations'}, 'Physical drawing rendering', {'zoom', 'rotations'})
    import math
    zoom = rendering['zoom']
    if type(zoom) not in (int, float) or not math.isfinite(zoom) or not .05 <= zoom <= 20:
        raise ValidationError('Physical drawing zoom must be finite and between 0.05 and 20.')
    rotations = rendering['rotations']
    valid_pages = {str(index) for index in range(1, len(document['pages']) + 1)}
    if (not isinstance(rotations, dict) or len(rotations) > len(document['pages'])
            or any(page not in valid_pages
                   or type(rotation) is not int or rotation not in (0,90,180,270)
                   for page, rotation in rotations.items())):
        raise ValidationError('Physical drawing rotations must identify existing pages and quarter turns.')
    identifiers = request['item_ids']
    callouts = {value['id']: (value, value['marker'], barrier_summary) for value in graph['barriers'] if not value['deleted'] and value.get('marker')}
    if graph['version'] == 2:
        for value in graph['defects']:
            annotation = defect_annotation(value, document['id'])
            if not value['deleted'] and annotation:
                callouts[value['id']] = (value, annotation, defect_summary)
    if (not isinstance(identifiers, list) or len(identifiers) > 10000
            or any(not isinstance(value, str) for value in identifiers)
            or len(identifiers) != len(set(identifiers)) or set(identifiers) - callouts.keys()):
        raise ValidationError('Choose distinct active source annotations or marked barriers in this physical workspace.')
    rows = []; requested = set(identifiers)
    for identifier in identifiers:
        entity, marker, summary = callouts[identifier]
        if marker['document_id'] != document['id'] or marker['document_sha256'] != document['sha256']:
            raise ValidationError('Every exported annotation or marker must belong to the exact selected source PDF.')
        _, metadata = page_metadata(snapshot, document['id'], marker['page'])
        points([marker['point']], 'Physical source annotation or marker', metadata, 1, 1)
        if summary is barrier_summary and inherited_library_barrier_parent(snapshot, graph, entity) in requested:
            continue  # Its exact source and all child facts are in the requested Defect label.
        rows.append({'id': identifier, 'mode': 'penetrations',
            'geometry': {'kind': 'count', 'document_id': document['id'], 'page': marker['page'], 'points': [marker['point']]},
            'appearance': {'stroke_color': '#C00000', 'fill_color': '#C00000', 'fill_enabled': True,
                           'stroke_width': 5, 'opacity': 1, 'marker_shape': 'circle', 'marker_size': 25,
                           **marker.get('appearance', {})},
            'mark': entity['display_id'], 'physical_summary': summary(graph, entity),
            'physical_summary_kind': 'defect' if summary is defect_summary else 'barrier',
            'callout': marker.get('callout'),
            'confirmed': False})
    from .takeoff_markup_pdf import export_marked_pdf
    from .takeoff_signatures import export_signatures
    signatures = export_signatures(snapshot, request, document['id'], (request['physical_scope'],))
    return export_marked_pdf(document, [], {}, {}, {}, documents, project_id=snapshot['project_id'],
        revision=snapshot['revision'], mode=request['physical_scope'].replace('_', ' '), physical_rows=rows,
        physical_rendering=rendering, snapshot=snapshot, signatures=signatures)
