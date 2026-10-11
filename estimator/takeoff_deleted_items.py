"""Read-only projection of explicit nonphysical deletion audit evidence."""
from copy import deepcopy
import json

from .catalog import ValidationError
from .takeoff_documents import MAX_AUDIT_BLOB, MAX_AUDIT_BYTES, MAX_AUDIT_EVENTS
from .takeoff_model import MAX_ITEMS, validate_item


def deleted_items(snapshot, load_event, *, mode, query='', offset=0, limit=100):
    modes = ('wall', 'slab') if mode == 'walls_floors' else (mode,)
    if not isinstance(mode, str) or mode not in ('steel', 'duct', 'wall', 'slab', 'walls_floors'):
        raise ValidationError('Choose a nonphysical register for deleted-item history.')
    if not isinstance(query, str) or len(query) > 1000:
        raise ValidationError('Deleted-item search requires at most 1,000 characters.')
    if type(offset) is not int or not 0 <= offset <= MAX_ITEMS or type(limit) is not int or not 1 <= limit <= 100:
        raise ValidationError('Deleted-item history requires a bounded offset and page size.')
    active = {item['id'] for item in snapshot['items']}
    rows, seen_ids, visited = [], set(), set()
    head, revision, consumed = snapshot['audit_head'], snapshot['revision'], 0
    needle = query.casefold().strip()
    while head:
        if head in visited or len(visited) >= MAX_AUDIT_EVENTS:
            raise ValidationError('Deleted-item history is cyclic or exceeds its retained event limit.')
        visited.add(head)
        event = load_event(head, kind='audit')
        size = len(json.dumps(event, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode())
        consumed += size
        if size > MAX_AUDIT_BLOB or consumed > MAX_AUDIT_BYTES:
            raise ValidationError('Deleted-item history exceeds its retained byte budget.')
        if event['project_id'] != snapshot['project_id'] or event['revision'] != revision:
            raise ValidationError('Deleted-item history belongs to another project or has a broken revision sequence.')
        if event['op'] in ('delete_items', 'linked_delete', 'delete_count_marker'):
            before = {item['id']: item for item in event['before']['items']}
            after = {item['id']: item for item in event['after']['items']}
            after_ids = after.keys()
            removed = before.keys() - after_ids
            if event['op'] == 'delete_count_marker' and (len(removed) != 1 or any(before[key]['quantity'] != 1 for key in removed)):
                removed = set()
            if removed and (after_ids-before.keys() or any(before[key] != after[key] for key in before.keys() & after_ids)):
                raise ValidationError('Deleted-item evidence must identify an explicit removal without rewriting surviving items.')
            for identifier in sorted(removed):
                if identifier in active or identifier in seen_ids:
                    continue
                seen_ids.add(identifier)
                if len(seen_ids) > MAX_ITEMS:
                    raise ValidationError('Deleted-item history exceeds the supported 10,000 retained records.')
                item = before[identifier]
                validate_item(item, event['before'], copy_result=False)
                if item['mode'] not in modes:
                    continue
                searchable = json.dumps({'id': identifier, 'fields': item['fields'], 'mode': item['mode'],
                    'deletion_revision': event['revision'], 'deletion_op': event['op']}, ensure_ascii=False).casefold()
                if needle and needle not in searchable:
                    continue
                rows.append({'item': deepcopy(item), 'deletion_revision': event['revision'],
                    'deletion_at': event['at'], 'deletion_op': event['op'], 'deletion_audit_sha256': head,
                    'read_only': True, 'status': 'deleted'})
        head, revision = event['previous'], revision-1
    if revision != 0:
        raise ValidationError('Deleted-item history does not reach the initial revision.')
    return {'revision': snapshot['revision'], 'mode': mode, 'query': query, 'offset': offset,
        'limit': limit, 'total': len(rows), 'records': rows[offset:offset+limit],
        'has_more': offset+limit < len(rows), 'read_only': True}
