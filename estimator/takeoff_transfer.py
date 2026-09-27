"""Reviewed, lossless input-only bridges to the existing workbook calculators."""

from copy import deepcopy
from functools import lru_cache
from uuid import uuid4

from .catalog import ValidationError
from .schedule_rows import blank_schedule_defaults, normalize_schedule_rows, populated_schedule_rows
from .takeoff_model import digest, item_digest, measured_length, object_fields
from .workbook_calculators import (source_model, calculator_session,
                                  validate_calculator_edits, validation_options)
from .ductwork_policy import application_frl

DESTINATIONS = ('steel_vermiculite', 'steel_board', 'ductwork')


def calculator_options(calculator_id, fields=None):
    if calculator_id not in DESTINATIONS:
        raise ValidationError('Choose an available steel or duct calculator.')
    model = source_model(calculator_id)
    schedule = model['schedule']
    row = schedule['first_row']
    product_column = 'B' if calculator_id == 'steel_vermiculite' else 'C'
    inputs = {schedule['sheet']: {product_column+str(row): fields['product']}} if fields and fields.get('product') else {}
    if calculator_id == 'steel_board' and fields and fields.get('member_type'):
        inputs.setdefault(schedule['sheet'], {})['I'+str(row)] = fields['member_type']
    _, engine, lock = calculator_session(calculator_id, inputs)
    with lock:
        columns = [{'column': f['column'], 'label': f['label'], 'type': f['type'],
                    'options': validation_options(engine, schedule['sheet'], f['column']+str(row), f.get('validation'))}
                   for f in schedule['columns'] if f.get('editable') and not f.get('generated')]
    return {'calculator_id': calculator_id, 'source_sha256': model['source']['sha256'], 'columns': columns}


@lru_cache(maxsize=2)
def _profiles(calculator_id):
    column = 'F' if calculator_id == 'steel_vermiculite' else 'D'
    return tuple(next(f['options'] for f in calculator_options(calculator_id)['columns'] if f['column'] == column))


def profiles(calculator_id, query='', offset=0, limit=50):
    if calculator_id not in DESTINATIONS[:2]:
        raise ValidationError('Profiles are available for the steel calculators.')
    if not isinstance(query, str) or len(query) > 200 or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValidationError('Profile search requires a bounded query and page size.')
    normalize = lambda value: ''.join(str(value).casefold().replace('×', 'x').split())
    matches = [p for p in _profiles(calculator_id) if normalize(query) in normalize(p)]
    return {'items': [{'id': p, 'label': p} for p in matches[offset:offset+limit]],
            'total': len(matches), 'offset': offset, 'limit': limit,
            'source_sha256': source_model(calculator_id)['source']['sha256']}


def _required(fields, keys):
    for name in keys:
        if fields.get(name) in (None, ''):
            raise ValidationError(f'Complete {name.replace("_", " ")} before schedule transfer.')


def mapped_values(item, snapshot, calculator_id, row):
    fields = item['fields']
    if (calculator_id == 'ductwork') != (item['mode'] == 'duct'):
        raise ValidationError('The selected item does not belong in this calculator.')
    _required(fields, ('product',))
    length = measured_length(item, snapshot)
    quantity = item['quantity']
    if type(quantity) is not int or quantity <= 0:
        raise ValidationError('Transfer requires an explicit positive physical quantity.')
    normalizations = []
    location = ' / '.join(str(fields[k]) for k in ('level', 'zone') if fields.get(k))
    if calculator_id == 'steel_vermiculite':
        _required(fields, ('section', 'exposure', 'critical_temperature', 'fire_period_min'))
        values = {'A': fields.get('mark'), 'AA': location or None, 'B': fields['product'],
                  'C': fields['exposure'], 'D': fields['critical_temperature'],
                  'E': 'Section', 'F': fields['section'], 'H': fields['fire_period_min'],
                  'I': quantity, 'J': length}
        # Manual overrides are transferred only when the operator explicitly supplied them.
        values.update({c: fields[k] for c, k in (('K', 'girth_override_m'), ('L', 'area_override_m2')) if fields.get(k) is not None})
    elif calculator_id == 'steel_board':
        _required(fields, ('section', 'sides', 'member_type', 'critical_temperature', 'fire_period_min'))
        values = {'A': fields.get('mark'), 'B': location or None, 'C': fields['product'], 'D': fields['section'],
                  'F': length * quantity, 'G': fields['sides'], 'H': fields['fire_period_min'],
                  'I': fields['member_type'], 'J': fields['critical_temperature']}
        optional = {'L': 'waste_fraction', 'M': 'exposure_layout', 'N': 'partial_depth_mm', 'O': 'layer_preference',
                    'P': 'thickness_lookup', 'Q': 'installation_detail', 'R': 'depth_mm', 'S': 'width_mm',
                    'T': 'steel_area_cm2', 'U': 'steel_mass_kg_m', 'V': 'girth_override_m',
                    'W': 'added_girth_m', 'X': 'design_reference'}
        values.update({column: fields[key] for column, key in optional.items() if fields.get(key) is not None})
    else:
        if fields.get('shape') != 'rectangular':
            raise ValidationError('Circular ducts are retained in Takeoffs; the existing duct calculator supports rectangular ducts only.')
        if quantity != 1:
            raise ValidationError('Transfer each physical duct run separately with quantity 1. Combining runs changes the existing wrap overlap and strip quantities.')
        _required(fields, ('width_mm', 'height_mm', 'frl', 'exposure', 'orientation', 'wall_penetrations', 'floor_penetrations'))
        for key in ('wall_penetrations', 'floor_penetrations'):
            if type(fields[key]) is not int or fields[key] < 0:
                raise ValidationError('Enter explicit whole-number wall and floor penetration counts, including zero.')
        frl = application_frl(fields['product'], fields['exposure'], fields['frl'])
        if frl != fields['frl']:
            normalizations.append({'item_id': item['id'], 'field': 'frl', 'before': fields['frl'], 'after': frl,
                                   'reason': 'Existing approved duct application rating policy.'})
        # repr-style formatting retains the entered dimensions; general-format
        # defaults round to six significant digits and would change geometry.
        dimension = lambda value: str(int(value)) if value == int(value) else repr(value)
        values = {'B': f"{dimension(fields['width_mm'])}x{dimension(fields['height_mm'])}", 'C': fields['product'],
                  'D': length * quantity, 'E': frl, 'F': fields['wall_penetrations'],
                  'G': fields['floor_penetrations'], 'H': fields['exposure'], 'I': fields['orientation']}
    options = calculator_options(calculator_id, fields)
    for field in options['columns']:
        value = values.get(field['column'])
        if calculator_id == 'steel_board' and field['column'] == 'J':
            # Temperature and member/product scope must be diagnosed together
            # by the complete native board row, including its exact explanation.
            continue
        if value not in (None, '') and field['options'] and value not in field['options']:
            raise ValidationError(f"{field['label']}: select an exact supported calculator value; '{value}' cannot be transferred.")
    return {column+str(row): value for column, value in values.items()}, normalizations


def row_values(inputs, schedule, row):
    """Hash every editable cell, including advanced fields and explicit blanks."""
    cells = inputs.get(schedule['sheet'], {})
    return {f['column']+str(row): cells.get(f['column']+str(row)) for f in schedule['columns'] if f.get('editable')}


def _board_review(inputs, bindings, items):
    """Use existing workbook scope/quantity decisions without changing inputs."""
    _, engine, lock = calculator_session('steel_board', inputs)
    invalid, warnings = [], []
    with lock:
        for binding in bindings:
            row = binding['row']; item = items[binding['item_id']]
            status = engine.value('CALCULATOR', f'AR{row}')
            message = engine.value('CALCULATOR', f'AI{row}')
            label = item['fields'].get('mark') or item['id']
            if status != 'CLADDING ESTIMATE':
                invalid.append(f"{label} ({item['id']}), row {row}: {status}. {message}")
            elif message:
                warnings.append({'item_id': item['id'], 'row': row, 'code': 'EXISTING_CALCULATOR_NOTE',
                                 'status': status, 'message': message})
    if invalid:
        raise ValidationError('Board transfer contains invalid items. No items were transferred. '
                              'Resolve the existing calculator diagnosis without changing the project requirements:\n'
                              + '\n'.join(invalid))
    return warnings


def transfer_preview(snapshot, request):
    object_fields(request, {'expected_revision', 'calculator_id', 'inputs', 'schedule_rows', 'item_ids', 'update_linked'},
                  'Transfer preview', {'expected_revision', 'calculator_id', 'inputs', 'schedule_rows', 'item_ids'})
    calculator_id = request['calculator_id']
    if calculator_id not in DESTINATIONS:
        raise ValidationError('Choose an available calculator.')
    if type(request.get('update_linked', False)) is not bool:
        raise ValidationError('Update linked rows must be explicitly true or false.')
    model = source_model(calculator_id); schedule = model['schedule']; sheet = schedule['sheet']
    original = deepcopy(request['inputs'])
    inputs = blank_schedule_defaults(calculator_id, original)
    validate_calculator_edits(calculator_id, inputs, inputs)
    rows = normalize_schedule_rows(calculator_id, inputs, request['schedule_rows'])
    item_ids = request['item_ids']
    if not isinstance(item_ids, list) or not item_ids or any(not isinstance(i, str) for i in item_ids) or len(set(item_ids)) != len(item_ids):
        raise ValidationError('Select distinct confirmed takeoff items.')
    items = {i['id']: i for i in snapshot['items']}
    if set(item_ids) - items.keys():
        raise ValidationError('A selected takeoff item no longer exists.')
    bindings = deepcopy(snapshot['transfers'])
    # Replacements retain predecessor closure. An old linked schedule row is
    # deliberately preserved when its source record is split/merged; copying
    # successors while that row remains populated would count the same work
    # twice. Only a fully cleared row or an explicit detached link resolves it.
    conflicts = []
    for item_id in item_ids:
        item = items[item_id]
        ancestors = set(item.get('predecessor_ids', []))
        for binding in bindings:
            if binding['calculator_id'] != calculator_id or binding['item_id'] not in ancestors:
                continue
            if any(value not in (None, '') for value in row_values(inputs, schedule, binding['row']).values()):
                conflicts.append(f"{item['fields'].get('mark') or item_id} ({item_id}): predecessor {binding['item_id']} "
                                 f"still has a linked {sheet} row {binding['row']}.")
    if conflicts:
        raise ValidationError('Transfer blocked by unresolved predecessor rows. No items were transferred. '
                              'Review and clear every editable value in each old row, including advanced values, '
                              'or explicitly detach its source link after resolving the duplicate quantity:\n' + '\n'.join(conflicts))
    by_item = {b['item_id']: b for b in bindings if b['calculator_id'] == calculator_id}
    occupied = populated_schedule_rows(calculator_id, inputs) | {b['row'] for b in bindings if b['calculator_id'] == calculator_id}
    available = iter(row for row in range(schedule['first_row'], schedule['last_row']+1) if row not in occupied)
    changes, normalizations, selected = [], [], []
    inputs.setdefault(sheet, {})
    for item_id in item_ids:
        item = items[item_id]
        if item['state'] != 'confirmed' or not item.get('confirmation') or item['confirmation']['digest'] != item_digest(item, snapshot):
            raise ValidationError('Every selected takeoff must have an unchanged confirmation.')
        binding = by_item.get(item_id)
        if binding:
            if binding['status'] in ('conflict', 'deleted') or binding['source_sha256'] != model['source']['sha256'] or binding['input_hash'] != digest(row_values(inputs, schedule, binding['row'])):
                raise ValidationError('A linked calculator row was edited, reset, imported or changed source version. Resolve the conflict before transfer.')
            row = binding['row']
            if binding['item_digest'] == item_digest(item, snapshot):
                changes.append({'item_id': item_id, 'row': row, 'action': 'unchanged'})
                selected.append(binding)
                continue
            if not request.get('update_linked'):
                raise ValidationError('This item already has a linked row. Review an explicit update to replace its previous values.')
            action = 'update'
        else:
            row = next(available, None)
            if row is None:
                raise ValidationError('The calculator does not have enough empty rows. No transfer has been applied.')
            action = 'append'
        patch, normalized = mapped_values(item, snapshot, calculator_id, row)
        normalizations.extend(normalized)
        for field in schedule['columns']:
            if field.get('editable'):
                inputs[sheet][field['column']+str(row)] = None
        inputs[sheet].update(patch)
        row_state = row_values(inputs, schedule, row)
        new_binding = {'id': binding['id'] if binding else str(uuid4()), 'item_id': item_id,
                       'item_version': item['version'], 'item_digest': item_digest(item, snapshot),
                       'calculator_id': calculator_id, 'sheet': sheet, 'row': row,
                       'source_sha256': model['source']['sha256'], 'input_hash': digest(row_state),
                       'values': row_state, 'status': 'current'}
        if binding:
            bindings[bindings.index(binding)] = new_binding
        else:
            bindings.append(new_binding)
        selected.append(new_binding)
        rows = sorted(set(rows) | {row})
        changes.append({'item_id': item_id, 'row': row, 'action': action})
    validate_calculator_edits(calculator_id, inputs, original)
    warnings = _board_review(inputs, selected, items) if calculator_id == 'steel_board' else []
    return {'calculator_id': calculator_id, 'base_fingerprint': digest({'inputs': original, 'schedule_rows': request['schedule_rows']}),
            'inputs': inputs, 'schedule_rows': rows, 'bindings': selected, 'all_bindings': bindings,
            'changes': changes, 'normalizations': normalizations, 'warnings': warnings}
