"""Calculator-backed inspection drafts and their portable evidence."""
from decimal import Decimal
from fractions import Fraction
import re

from .assessment_references import UNAVAILABLE_RESULT, report_reference_text
from .catalog import ValidationError
from .documentation_catalog import CALCULATOR_INSPECTIONS
from .passive_fire_register import (MAX_NUMBER, _check_photo_groups, _entry_number, _fields, _photos,
                                    normalize_signature_details)
from .register_plans import normalize_pins
from .swms import _date, _text, validate_signature
from .workbook_runtime import DUCT_LOCATION_COLUMN, SCHEDULE_CAPACITY


STEEL_CALCULATORS = frozenset(('steel_board', 'steel_intumescent', 'steel_vermiculite'))
CALCULATOR_IDS = {'duct': frozenset(('ductwork',)), 'steel': STEEL_CALCULATORS}
PHOTOS = {'before': 'Before Photos', 'during': 'During Photos', 'after': 'After Photos',
          'gauge': 'Photo of Gauge'}
ROW_FIELDS = ('location', 'duct_size', 'section_id', 'critical_temp', 'product', 'frl',
              'quantity', 'length', 'report', 'required_thickness')
NUMERIC_FIELDS = frozenset(('critical_temp', 'quantity', 'length'))
MAX_READINGS = 200
_CELL_COLUMNS = {
    'ductwork': (DUCT_LOCATION_COLUMN, 'B', None, None, 'C', 'E', 'CM', 'D'),
    'steel_board': ('B', None, 'D', 'AO', 'C', 'H', 'CJ', 'F'),
    'steel_vermiculite': ('AA', None, 'F', 'D', 'B', 'H', 'I', 'J'),
    'steel_intumescent': ('AA', None, 'F', 'D', 'B', 'H', 'I', 'J'),
}


def _numeric(value):
    return type(value) in (int, float) and -1e100 <= value <= 1e100


def _show_number(value):
    return format(value, '.12g')


def _required_thickness(calculator_id, item):
    if item['result_unavailable']:
        return UNAVAILABLE_RESULT
    cells = item['values']
    if calculator_id == 'ductwork' and item['wrap']:
        layers = cells['R']
        if _numeric(layers) and 0 < layers == int(layers) and item['wrap_layer_mm'] == 38:
            return f'{int(layers)} x 38mm'
        return UNAVAILABLE_RESULT
    column = {'ductwork': 'L', 'steel_board': 'AB',
              'steel_vermiculite': 'O', 'steel_intumescent': 'O'}[calculator_id]
    thickness = cells[column]
    if not _numeric(thickness) or thickness <= 0:
        return UNAVAILABLE_RESULT
    if calculator_id == 'steel_intumescent':
        thickness /= 1000  # Source intumescent DFT uses micrometres.
    return _show_number(thickness)


def inspection_calculator_rows(calculator_id, inputs, schedule_rows=None):
    """Read exactly the populated rows and evaluated values of the calculator register."""
    if not isinstance(calculator_id, str) or calculator_id not in _CELL_COLUMNS:
        raise ValidationError('Choose a Ductwork or Structural Steel calculator.')
    from .calculator_report import project_calculator_report
    from .schedule_rows import blank_schedule_defaults, normalize_schedule_rows
    from .workbook_calculators import normalize_calculator_inputs

    inputs = normalize_calculator_inputs(calculator_id, blank_schedule_defaults(calculator_id, inputs))
    normalize_schedule_rows(calculator_id, inputs, schedule_rows)
    calculated = project_calculator_report(calculator_id, inputs)
    rows, notes = [], {}
    for item in calculated['rows']:
        fields = {'calculator_id': calculator_id, 'line': item['line']}
        for field, column in zip(ROW_FIELDS, _CELL_COLUMNS[calculator_id]):
            value = item['values'].get(column)
            if calculator_id == 'steel_board' and field == 'critical_temp' and not _numeric(value):
                value = item['values']['J']
            if field in NUMERIC_FIELDS:
                fields[field] = value if _numeric(value) else None
            elif _numeric(value) and field == 'frl' and calculator_id in STEEL_CALCULATORS:
                fields[field] = _show_number(value) + ' min'
            elif isinstance(value, str) or _numeric(value):
                fields[field] = str(value).strip()
            else:
                fields[field] = ''
        fields['report'] = report_reference_text(item['report_references'])
        fields['required_thickness'] = _required_thickness(calculator_id, item)
        if fields['required_thickness'] == UNAVAILABLE_RESULT and item.get('calculation_notes'):
            notes[str(item['line'])] = item['calculation_notes']
        rows.append(fields)
    return {'calculator_id': calculator_id, 'rows': rows, **({'notes': notes} if notes else {})}


def _source_row(row, kind):
    keys = {'calculator_id', 'line', *ROW_FIELDS}
    if not isinstance(row, dict) or set(row) != keys:
        raise ValidationError('Select a row from the calculator register.')
    calculator = row['calculator_id']
    if not isinstance(calculator, str) or calculator not in CALCULATOR_IDS[kind]:
        raise ValidationError('The selected schedule row belongs to a different type of inspection.')
    line = row['line']
    if type(line) is not int or not 1 <= line <= SCHEDULE_CAPACITY:
        raise ValidationError('The calculator schedule line is invalid.')
    result = {'calculator_id': calculator, 'line': line}
    for field in ROW_FIELDS:
        value = row[field]
        if field in NUMERIC_FIELDS:
            if value is not None and not _numeric(value):
                raise ValidationError('Calculator measurements must be finite numbers.')
            result[field] = value
        else:
            result[field] = _text(value, field.replace('_', ' ').capitalize(), 2000).strip()
    thickness = result['required_thickness']
    decimal = re.fullmatch(r'(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,3})?', thickness)
    wrap = kind == 'duct' and result['product'].casefold() == 'fyrewrap'
    allowed = (re.fullmatch(r'[1-9]\d* x 38mm', thickness) if wrap
               else decimal and 0 < Decimal(thickness) <= Decimal('1e100'))
    if thickness != UNAVAILABLE_RESULT and not allowed:
        raise ValidationError('The selected row does not contain a valid calculator thickness.')
    return result


def _readings(value):
    if (not isinstance(value, list) or len(value) > MAX_READINGS
            or any(not _numeric(reading) or not 0 <= reading <= 100_000 for reading in value)):
        raise ValidationError(f'Enter up to {MAX_READINGS} valid non-negative thickness readings in millimetres.')
    return list(value)


def _entry(value, kind):
    source = _fields(value, {'entry_id', 'number', 'row', 'source_estimate_id', 'readings', 'plan_pins',
                             'inspection_date', 'signature', 'signature_details', *PHOTOS}, 'Inspection entry')
    identity, number = _entry_number(source, 0, True)
    row = source.get('row')
    entry = {'entry_id': identity, 'number': number,
             'row': _source_row(row, kind) if row is not None else None,
             'readings': _readings(source.get('readings', [])),
             **{key: _photos(source.get(key, [])) for key in PHOTOS},
             'plan_pins': normalize_pins(source.get('plan_pins', []))}
    if 'inspection_date' in source:
        entry['inspection_date'] = _date(source['inspection_date'], 'Inspection date')
    signature = validate_signature(source.get('signature'))
    if signature or 'signature_details' in source:
        entry['signature_details'] = normalize_signature_details(source.get('signature_details'), signature)
        entry['signature'] = signature
    if 'source_estimate_id' in source:
        estimate_id = source['source_estimate_id']
        if row is None or not isinstance(estimate_id, str) or not re.fullmatch(r'estimate-(?:1|[0-9a-f]{32})', estimate_id):
            raise ValidationError('The selected calculator row must identify a valid source estimate.')
        entry['source_estimate_id'] = estimate_id
    return entry


def normalize_inspection_register(value, kind, *, validate_photos=True):
    title, _ = CALCULATOR_INSPECTIONS[kind]
    _fields(value, {'calculator_id', 'entries', 'next_number'}, title)
    source, calculator, next_number = value.get('entries'), value.get('calculator_id'), value.get('next_number')
    if not isinstance(calculator, str) or (calculator not in CALCULATOR_IDS[kind] and (kind != 'steel' or calculator)):
        raise ValidationError(f'{title}: choose one supported calculator.')
    if not isinstance(source, list) or len(source) > 200:
        raise ValidationError(f'{title} accepts up to 200 entries.')
    if type(next_number) is not int or not 1 <= next_number <= MAX_NUMBER + 1:
        raise ValidationError('The next inspection number is invalid.')
    entries = [_entry(entry, kind) for entry in source]
    if (any(entry['number'] >= next_number for entry in entries)
            or len({entry['number'] for entry in entries}) != len(entries)
            or len({entry['entry_id'] for entry in entries}) != len(entries)):
        raise ValidationError('Inspections must have distinct identities and numbers below the next available number.')
    if validate_photos:
        _check_photo_groups(entry[key] for entry in entries for key in PHOTOS)
    return {'calculator_id': calculator, 'entries': entries, 'next_number': next_number}


def normalize_calculator_inspections(value, *, validate_photos=True):
    _fields(value, set(CALCULATOR_IDS), 'Calculator inspections')
    registers = {kind: normalize_inspection_register(value[kind], kind, validate_photos=False)
                 for kind in CALCULATOR_IDS if kind in value}
    if validate_photos:
        _check_photo_groups(entry[key] for register in registers.values()
                            for entry in register['entries'] for key in PHOTOS)
    return registers


def preserve_inspection_numbers(previous, incoming):
    old = normalize_calculator_inspections(previous, validate_photos=False)
    new = normalize_calculator_inspections(incoming, validate_photos=False)
    if old.keys() - new.keys():
        raise ValidationError('Reload this project before saving so all calculator inspections are retained.')
    for kind, saved in old.items():
        current = new[kind]
        next_number = saved['next_number']
        if not next_number <= current['next_number'] <= next_number + 1_000_000:
            raise ValidationError('The inspection number sequence cannot be reset or advanced too far.')
        identities = {entry['entry_id']: entry['number'] for entry in saved['entries']}
        for entry in current['entries']:
            number = entry['number']
            prior = identities.get(entry['entry_id'])
            if (prior is None and number < next_number) or (prior is not None and number != prior):
                raise ValidationError('Existing inspection numbers cannot be reassigned or edited.')


def inspection_number(entry):
    return f"{entry['number']:03d}"


def recorded_thickness(readings):
    total = sum(Fraction(str(value)) for value in readings)
    average = total / len(readings)
    hundredths = (average * 100 + Fraction(1, 2)) // 1
    return format(Decimal(hundredths).scaleb(-2), 'f').rstrip('0').rstrip('.')
