"""Literal, unpriced physical-service drafts; never infer a system or approval."""
from uuid import uuid5, NAMESPACE_URL

from .penetration_source import validate_source
from .takeoff_model import digest
from .takeoff_physical import effective_confirmation


def compile_rows(snapshot, scope, draft, associated, physical):
    """One confirmed explicit Service becomes one editable, unpriced row.

    Stable source IDs prevent repeat Transfer from duplicating or overwriting a
    manual row. Parent rows add context, never extra quantities. Literal size is
    retained separately: a generic size is not assumed to be a pipe diameter.
    """
    graph, index = physical['graph'], physical['index']
    existing = {row['id'] for row in draft['rows']}
    rows, changes = [], []
    skipped = {'already_linked': 0, 'unconfirmed': 0, 'quantity_missing': 0}
    for service in graph.get('services', []):
        if service['deleted'] or service['id'] in associated:
            continue
        if effective_confirmation(graph, service['id'], _index=index) != 'confirmed':
            skipped['unconfirmed'] += 1
            continue
        row_id = 'physical-' + str(uuid5(NAMESPACE_URL,
            f"ceasefire/{snapshot['project_id']}/{scope}/{service['id']}"))
        if row_id in existing:
            skipped['already_linked'] += 1
            continue
        quantity = service.get('quantity')
        if type(quantity) is not int or quantity < 1:
            skipped['quantity_missing'] += 1
            continue
        barrier = index[service['barrier_id']][1]
        defect = index[barrier['defect_id']][1] if scope == 'defect_reports' else None
        sf, bf = service['fields'], barrier['fields']
        owner_fields = defect['fields'] if defect else bf
        inputs = {key: value for key, value in {
            'J': sf.get('service'), 'K': sf.get('service_type'),
            'L': bf.get('barrier_type'), 'M': bf.get('orientation'),
            'N': owner_fields.get('frl'), 'P': bf.get('substrate'), 'O': quantity,
            'AL': sf.get('diameter_mm'), 'AQ': sf.get('width_mm'),
            'AR': sf.get('height_mm'),
        }.items() if value not in (None, '')}
        size = str(sf.get('size') or '')
        location = bf.get('location') or owner_fields.get('location') or ''
        inputs['T'] = (f"Manual Takeoff {service.get('display_id', service['id'])}. "
                       'Unpriced draft: choose system/materials before pricing.'
                       + (f' Location: {location}.' if location else '')
                       + (f' Service size (mm): {size}.' if size else ''))
        notes = [entity['fields'].get('notes', '') for entity in (defect, barrier, service) if entity]
        if any(notes):
            inputs['U'] = '\n'.join(note for note in notes if note)
        source = validate_source({'version': 1, 'scope': scope,
            'project_id': snapshot['project_id'], 'graph_id': graph['id'],
            'service_id': service['id'], 'service_revision': service['revision'],
            'barrier_id': barrier['id'], 'barrier_revision': barrier['revision'],
            'context_sha256': digest({'service': service, 'barrier': barrier, 'defect': defect}),
            'service_size': size})
        rows.append({'id': row_id, 'inputs': inputs, 'takeoff_source': source})
        changes.append({'action': 'add_manual_draft', 'row_id': row_id,
                        'service_id': service['id'], 'quantity': quantity,
                        'context_sha256': source['context_sha256']})
    return {'rows': rows, 'changes': changes, 'skipped': skipped}
