"""Derived barrier callouts: one source locator, independently entered services."""
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


def export_physical_pdf(snapshot, request, documents):
    required = {'expected_revision', 'mode', 'physical_scope', 'document_id', 'item_ids'}
    object_fields(request, required, 'Penetration drawing export', required)
    graph = current_graph(snapshot, request['physical_scope'])
    if graph['version'] not in (2, 3):
        raise ValidationError('Legacy physical hierarchies cannot have barrier count markers.')
    document, _ = page_metadata(snapshot, request['document_id'], 1)
    identifiers = request['item_ids']
    barriers = {value['id']: value for value in graph['barriers'] if not value['deleted'] and value.get('marker')}
    if (not isinstance(identifiers, list) or len(identifiers) > 10000
            or any(not isinstance(value, str) for value in identifiers)
            or len(identifiers) != len(set(identifiers)) or set(identifiers) - barriers.keys()):
        raise ValidationError('Choose distinct active marked barriers in this physical workspace.')
    rows = []
    for identifier in identifiers:
        barrier = barriers[identifier]; marker = barrier['marker']
        if marker['document_id'] != document['id'] or marker['document_sha256'] != document['sha256']:
            raise ValidationError('Every exported barrier marker must belong to the exact selected source PDF.')
        _, metadata = page_metadata(snapshot, document['id'], marker['page'])
        points([marker['point']], 'Barrier marker', metadata, 1, 1)
        rows.append({'id': identifier, 'mode': 'penetrations',
            'geometry': {'kind': 'count', 'document_id': document['id'], 'page': marker['page'], 'points': [marker['point']]},
            'appearance': {'stroke_color': '#C00000', 'fill_color': '#C00000', 'fill_enabled': True,
                           'stroke_width': 2, 'opacity': 1, 'marker_shape': 'circle', 'marker_size': 12},
            'mark': barrier['display_id'], 'physical_summary': barrier_summary(graph, barrier),
            'confirmed': False})
    from .takeoff_markup_pdf import export_marked_pdf
    return export_marked_pdf(document, [], {}, {}, {}, documents, project_id=snapshot['project_id'],
        revision=snapshot['revision'], mode=request['physical_scope'].replace('_', ' '), physical_rows=rows)
