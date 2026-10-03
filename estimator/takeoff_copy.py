"""Copy traced lengths as new physical objects without copying their authority."""

from copy import deepcopy
from uuid import uuid4

from .catalog import ValidationError
from .takeoff_model import (MAX_ITEMS, active_calibrations, identity, item_references,
                           number, object_fields, page_metadata, points, polyline_length)


def duplicate_length_proposals(snapshot, request):
    """Anchor the first line's first point at the destination in PDF coordinates."""
    sources = request['sources']
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_ITEMS:
        raise ValidationError('Copy a nonempty bounded selection of traced lengths.')
    by_id = {item['id']: item for item in snapshot['items']}
    selected = []
    seen = set()
    source_page = None
    for source in sources:
        object_fields(source, {'item_id', 'version'}, 'Copied source', {'item_id', 'version'})
        identifier = identity(source['item_id'], 'Copied item ID')
        version = number(source['version'], 'Copied item version', positive=True, integer=True)
        if identifier in seen:
            raise ValidationError('Copy each selected markup only once.')
        seen.add(identifier)
        item = by_id.get(identifier)
        if item is None or item['version'] != version:
            raise ValidationError('A copied markup changed or was deleted. Select and copy it again.')
        geometry, measurement = item['geometry'], item['measurement']
        if (item['mode'] not in ('steel', 'duct') or not geometry or geometry.get('kind') is not None
                or not measurement or measurement.get('method') != 'calibrated'):
            raise ValidationError('Copy and paste supports calibrated Steel or Duct Length markups.')
        polyline_length(geometry['points'])
        key = (item['mode'], geometry['document_id'], geometry['page'])
        if source_page is not None and key != source_page:
            raise ValidationError('Copy traced lengths from one takeoff type and source page at a time.')
        source_page = key
        selected.append(item)
    if len(snapshot['items']) + len(selected) > MAX_ITEMS:
        raise ValidationError(f'A takeoff project may retain at most {MAX_ITEMS} items.')
    if sum(len(item['member_ids']) for item in snapshot['items'] + selected) > MAX_ITEMS:
        raise ValidationError(f'A takeoff project may retain at most {MAX_ITEMS} physical member identities.')
    destination_id, destination_page = request['document_id'], request['page']
    _, page = page_metadata(snapshot, destination_id, destination_page)
    destination = points([request['point']], 'Paste position', page, maximum=1)[0]
    calibration_id = identity(request['calibration_id'], 'Destination calibration ID')
    calibration = next((entry for entry in active_calibrations(snapshot) if entry['id'] == calibration_id), None)
    if calibration is None or (calibration['document_id'], calibration['page']) != (destination_id, destination_page):
        raise ValidationError('Choose an active calibration on the destination page before pasting.')
    anchor = selected[0]['geometry']['points'][0]
    dx, dy = destination[0] - anchor[0], destination[1] - anchor[1]
    proposals = []
    retained_sources = {destination_id}
    for item in selected:
        geometry = {'document_id': destination_id, 'page': destination_page,
                    'points': [[x + dx, y + dy] for x, y in item['geometry']['points']]}
        points(geometry['points'], 'Pasted markup', page, minimum=2)
        proposed = {key: deepcopy(item[key]) for key in ('mode', 'quantity', 'fields', 'evidence')}
        proposed.update(geometry=geometry, measurement={'method': 'calibrated', 'calibration_id': calibration_id})
        if 'appearance' in item:
            proposed['appearance'] = deepcopy(item['appearance'])
        if 'length_additions' in item:
            proposed['length_additions'] = deepcopy(item['length_additions'])
            for addition in proposed['length_additions']:
                addition['id'] = str(uuid4())
                if 'anchor' in addition:
                    addition.update(document_id=destination_id, page=destination_page)
                    addition['anchor']['point'] = deepcopy(geometry['points'][addition['anchor']['point_index']])
        # Citations remain pinned to the original evidence. Only the copied
        # line and its explicit point anchors move to the new source position.
        retained_sources.update(reference['document_id'] for reference in item_references(item))
        proposals.append((proposed, {'item_id': item['id'], 'version': item['version']}))
    return proposals, retained_sources
