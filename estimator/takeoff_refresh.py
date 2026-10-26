"""Explicit calculator-to-register field refresh without changing measurements."""

from copy import deepcopy
import math
import re

from .catalog import ValidationError
from .schedule_rows import normalize_schedule_rows
from .takeoff_model import digest, item_digest, is_count_item, validate_item
from .takeoff_transfer import DESTINATIONS, row_values
from .workbook_calculators import source_model, normalize_calculator_inputs


FIELD_COLUMNS = {
    'steel_vermiculite': {'A': 'mark', 'B': 'product', 'C': 'exposure', 'D': 'critical_temperature',
                         'F': 'section', 'H': 'fire_period_min', 'K': 'girth_override_m', 'L': 'area_override_m2'},
    'steel_intumescent': {'A': 'mark', 'B': 'product', 'C': 'exposure', 'D': 'critical_temperature',
                          'F': 'section', 'H': 'fire_period_min', 'K': 'girth_override_m', 'L': 'area_override_m2'},
    'steel_board': {'A': 'mark', 'C': 'product', 'D': 'section', 'G': 'sides', 'H': 'fire_period_min',
                    'I': 'member_type', 'J': 'critical_temperature', 'L': 'waste_fraction',
                    'M': 'exposure_layout', 'N': 'partial_depth_mm', 'O': 'layer_preference',
                    'P': 'thickness_lookup', 'Q': 'installation_detail', 'R': 'depth_mm', 'S': 'width_mm',
                    'T': 'steel_area_cm2', 'U': 'steel_mass_kg_m', 'V': 'girth_override_m',
                    'W': 'added_girth_m', 'X': 'design_reference'},
    'ductwork': {'C': 'product', 'E': 'frl', 'F': 'wall_penetrations', 'G': 'floor_penetrations',
                 'H': 'exposure', 'I': 'orientation'},
}


def refresh_preview(snapshot, request, registered):
    calculator_id = request['calculator_id']
    if not isinstance(calculator_id, str) or calculator_id not in DESTINATIONS:
        raise ValidationError('Choose an available steel or duct calculator.')
    model = source_model(calculator_id); schedule = model['schedule']; sheet = schedule['sheet']
    supplied = request['inputs']; declared = request['schedule_rows']
    if not isinstance(declared, list):
        raise ValidationError('Current schedule rows must be an explicit list.')
    inputs = normalize_calculator_inputs(calculator_id, supplied)
    normalize_schedule_rows(calculator_id, inputs, declared)
    bindings = {entry['item_id']: entry for entry in snapshot['transfers'] if entry['calculator_id'] == calculator_id}
    selected = set(request['item_ids']); changes = []; pending_source = []
    for item in snapshot['items']:
        if item['id'] not in selected:
            continue
        binding = bindings.get(item['id'])
        if binding is None:
            continue
        if ((binding['id'], digest({key: value for key, value in binding.items() if key != 'status'})) not in registered
                or binding['source_sha256'] != model['source']['sha256'] or binding['sheet'] != sheet
                or binding['status'] in ('conflict', 'deleted') or binding['row'] not in declared):
            raise ValidationError('A linked row is missing, unverified or uses a different source. Resolve its link before updating.')
        current = row_values(inputs, schedule, binding['row'])
        if binding['input_hash'] == digest(current):
            if binding['item_digest'] != item_digest(item, snapshot):
                pending_source.append(item['id'])
            continue
        if binding['item_digest'] != item_digest(item, snapshot) or binding['item_version'] != item['version']:
            raise ValidationError('Both Takeoffs and the calculator changed. Resolve which details to keep before updating linked rows.')
        if is_count_item(item):
            raise ValidationError('Refresh shared count details in the count editor; calculator edits cannot rewrite part of a retained count group.')
        fields = {}; details = []; row = str(binding['row'])
        for address in sorted(set(current) | set(binding['values'])):
            value = current.get(address); previous = binding['values'].get(address)
            if value == previous:
                continue
            column = address[:-len(row)]
            if calculator_id == 'ductwork' and column == 'B':
                match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*', str(value))
                if not match or any(not math.isfinite(float(part)) or float(part) <= 0 for part in match.groups()):
                    raise ValidationError('Use an explicit positive rectangular duct size before refreshing the register.')
                fields.update(width_mm=float(match[1]), height_mm=float(match[2]))
                field = 'duct_size'
            elif column in FIELD_COLUMNS[calculator_id]:
                field = FIELD_COLUMNS[calculator_id][column]
                if field in ('wall_penetrations', 'floor_penetrations') and (type(value) is not int or value < 0):
                    raise ValidationError('Wall and floor penetration counts must be non-negative integers before refresh.')
                fields[field] = value
            else:
                raise ValidationError(f'{address} changed in the calculator. Its measurement, quantity or unsupported input cannot be copied into the drawing; resolve that change before updating.')
            details.append({'field': field, 'before': previous, 'after': value})
        if not fields:
            raise ValidationError('The linked calculator row identity changed without supported field changes. Review its link.')
        proposed = deepcopy(item); proposed['fields'].update(fields)
        validate_item(proposed, snapshot, copy_result=False)
        changes.append({'item_id': item['id'], 'binding_id': binding['id'], 'row': binding['row'],
                        'fields': fields, 'details': details, 'values': current})
    if changes and pending_source:
        raise ValidationError('Selected rows contain edits from both directions. Refresh calculator-edited rows separately from changed Takeoffs rows.')
    return {'calculator_id': calculator_id, 'base_fingerprint': digest({'inputs': supplied, 'schedule_rows': declared}),
            'changes': changes}
