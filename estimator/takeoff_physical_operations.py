"""Atomic draft graph batches and source-reference checks, without authority.

The workspace service owns capabilities, idempotency, evidence verification and
audit publication. These functions only prepare detached candidate state.
"""

from copy import deepcopy
from uuid import UUID, uuid5

from .catalog import ValidationError
from .takeoff_model import digest, page_metadata, points
from .takeoff_physical import (apply_change, entity_references, graph_collections, graph_parents,
                               graph_digest, new_graph, preview_change, validate_graph)

MAX_PHYSICAL_COMMANDS = 100


def scope_key(scope='defect_reports'):
    if not isinstance(scope, str) or scope not in ('defect_reports', 'service_plans'):
        raise ValidationError('Choose Defect Reports or Service Plans.')
    return 'physical' if scope == 'defect_reports' else 'service_plans'


def current_graph(snapshot, scope='defect_reports'):
    key = scope_key(scope)
    graph = snapshot.get(key)
    if graph is None:
        return new_graph(snapshot['project_id'],
                         str(uuid5(UUID(snapshot['project_id']), 'physical-graph-v2' if key == 'physical' else 'service-plans-graph-v3')),
                         version=2 if key == 'physical' else 3)
    validate_graph(graph, copy_result=False)
    if graph['version'] not in ((1, 2) if key == 'physical' else (3,)):
        raise ValidationError('The physical hierarchy does not match its workspace scope.')
    if graph['project_id'] != snapshot['project_id']:
        raise ValidationError('The physical graph belongs to another project.')
    return deepcopy(graph)


def validate_source_links(graph, snapshot, image_check=None):
    """Check asserted locations against retained metadata, never grant approval.

    image_check is a trusted service callback that resolves the actual retained
    image occurrence and exact hashes. A missing resolver rejects image links.
    """
    for collection in graph_collections(graph).values():
        for entity in graph[collection]:
            if entity['deleted']:
                continue
            for ref in entity_references(entity):
                doc, page = page_metadata(snapshot, ref['document_id'], ref['page'])
                if ref['document_sha256'] != doc['sha256']:
                    raise ValidationError('Physical evidence refers to changed source document bytes.')
                if 'point' in ref:
                    points([ref['point']], 'Barrier marker', page, 1, 1)
                if 'region' in ref:
                    points(ref['region'], 'Physical evidence region', page, 3, 64)
                if 'image_id' in ref:
                    if image_check is None:
                        raise ValidationError('Retained image evidence must be verified before association.')
                    image_check(ref)


def _entities(graph):
    return {entity['id']: (kind, entity) for kind, collection in graph_collections(graph).items()
            for entity in graph[collection]}


def prepare_changes(snapshot, commands, image_check=None, *, scope='defect_reports'):
    """Preview all commands against one frozen graph; errors leave it unchanged."""
    if not isinstance(commands, list) or not 1 <= len(commands) <= MAX_PHYSICAL_COMMANDS:
        raise ValidationError(f'Choose one to {MAX_PHYSICAL_COMMANDS} explicit physical edits per batch.')
    before = current_graph(snapshot, scope)
    after = before
    affected, changed, descendants = set(), set(), set()
    for command in commands:
        preview = preview_change(after, command)
        after = apply_change(after, command, expected_revision=after['revision'],
                             preview_digest=preview['preview_digest'])['graph']
        affected.update(preview['affected_ids'])
        changed.update(preview['changed_ids'])
        descendants.update(preview['descendant_ids'])
    validate_source_links(after, snapshot, image_check)
    old, new = _entities(before), _entities(after)
    parents = graph_parents(after)
    relationships = []
    for identifier in sorted(affected | descendants):
        kind, entity = new[identifier]
        parent = parents.get(kind, (None, None))[1]
        prior = old.get(identifier)
        relationships.append({'id': identifier, 'kind': kind,
            'parent_before': prior[1].get(parent) if prior else None,
            'parent_after': entity.get(parent),
            'deleted_before': prior[1]['deleted'] if prior else None,
            'deleted_after': entity['deleted']})
        if after['version'] in (2, 3):
            relationships[-1]['display_id'] = entity['display_id']
    summary = {'version': 1, 'scope': scope, 'graph_id': before['id'], 'project_id': before['project_id'],
        'base_revision': before['revision'], 'base_digest': graph_digest(before),
        'commands': deepcopy(commands), 'command_count': len(commands),
        'affected_ids': sorted(affected), 'changed_ids': sorted(changed),
        'descendant_ids': sorted(descendants), 'relationships': relationships,
        'result_revision': after['revision'], 'result_digest': graph_digest(after),
        'state': 'draft', 'authority': 'none'}
    summary['digest'] = digest(summary)
    return {'graph': after, 'summary': summary}
