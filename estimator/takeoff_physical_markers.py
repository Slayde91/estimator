"""Derived draft callouts with independent source annotations and quantities."""
from .catalog import ValidationError
from .takeoff_model import object_fields, points, page_metadata
from .takeoff_physical_operations import current_graph


def barrier_summary(graph, barrier):
    """Describe current facts only; no authority, service inference or cached text."""
    fields = barrier['fields']
    parts = [barrier['display_id']]
    for key in ('label', 'location', 'barrier_type', 'substrate', 'orientation'):
        if fields.get(key):
            parts.append(str(fields[key]))
    if fields.get('thickness_mm') is not None:
        parts.append(f"{fields['thickness_mm']:g} mm thick")
    frl = fields.get('frl')
    if graph['version'] == 2:
        defect = next(value for value in graph['defects'] if value['id'] == barrier['defect_id'])
        frl = defect['fields'].get('frl')
        parts.insert(1, defect['display_id'])
    if frl:
        parts.append('FRL ' + frl)
    service_lines = []
    for service in graph['services']:
        if service['deleted'] or service['barrier_id'] != barrier['id']:
            continue
        values = service['fields']; detail = [service['display_id']]
        for key in ('label', 'service', 'service_type', 'size'):
            if values.get(key):
                detail.append(str(values[key]))
        width, height = values.get('width_mm'), values.get('height_mm')
        if width is not None or height is not None:
            detail.append(f"{width if width is not None else '?'}x{height if height is not None else '?'} mm")
        if values.get('diameter_mm') is not None:
            detail.append(f"Diameter {values['diameter_mm']:g} mm")
        if values.get('insulation_mm') is not None:
            detail.append(f"Insulation {values['insulation_mm']:g} mm")
        detail.append(f"Qty {service['quantity']}")
        service_lines.append(' | '.join(detail))
    return [' | '.join(parts), *(service_lines or ['No services recorded'])]


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
    """Only explicit defect facts and counts of current related records."""
    fields = defect['fields']; parts = [defect['display_id']]
    parts.extend(str(fields[key]) for key in ('label', 'location') if fields.get(key))
    if fields.get('frl'):
        parts.append('FRL ' + fields['frl'])
    barriers = {value['id'] for value in graph['barriers']
                if not value['deleted'] and value['defect_id'] == defect['id']}
    services = [value for value in graph['services']
                if not value['deleted'] and value['barrier_id'] in barriers]
    return [' | '.join(parts), f'{len(barriers)} substrates | {len(services)} services']


def export_physical_pdf(snapshot, request, documents):
    required = {'expected_revision', 'mode', 'physical_scope', 'document_id', 'item_ids'}
    object_fields(request, required, 'Penetration drawing export', required)
    graph = current_graph(snapshot, request['physical_scope'])
    if graph['version'] not in (2, 3):
        raise ValidationError('Legacy physical hierarchies cannot have barrier count markers.')
    document, _ = page_metadata(snapshot, request['document_id'], 1)
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
    rows = []
    for identifier in identifiers:
        entity, marker, summary = callouts[identifier]
        if marker['document_id'] != document['id'] or marker['document_sha256'] != document['sha256']:
            raise ValidationError('Every exported annotation or marker must belong to the exact selected source PDF.')
        _, metadata = page_metadata(snapshot, document['id'], marker['page'])
        points([marker['point']], 'Physical source annotation or marker', metadata, 1, 1)
        rows.append({'id': identifier, 'mode': 'penetrations',
            'geometry': {'kind': 'count', 'document_id': document['id'], 'page': marker['page'], 'points': [marker['point']]},
            'appearance': {'stroke_color': '#C00000', 'fill_color': '#C00000', 'fill_enabled': True,
                           'stroke_width': 2, 'opacity': 1, 'marker_shape': 'circle', 'marker_size': 12},
            'mark': entity['display_id'], 'physical_summary': summary(graph, entity),
            'callout': marker.get('callout'),
            'confirmed': False})
    from .takeoff_markup_pdf import export_marked_pdf
    return export_marked_pdf(document, [], {}, {}, {}, documents, project_id=snapshot['project_id'],
        revision=snapshot['revision'], mode=request['physical_scope'].replace('_', ' '), physical_rows=rows)
