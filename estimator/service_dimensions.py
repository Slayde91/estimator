"""Calculator dimensions and literal supplier size statements, without inference."""

import math
import re


FIELD_LABEL = 'Service Size or Diameter'
UNKNOWN = 'Not specified in calculator inputs'


def _positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def _number(value):
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def service_size_evidence(inputs):
    """Return calculator dimensions and their input cells; never parse descriptions."""
    inputs = inputs if isinstance(inputs, dict) else {}
    diameter, width, depth = (inputs.get(column) for column in ('AL', 'AQ', 'AR'))
    lines, basis = [], []
    if _positive(diameter):
        lines.append(f'{_number(diameter)} mm')
        basis.append({'column': 'AL', 'role': 'calculator_diameter', 'value': diameter})
    dimensions = []
    for column, value, dimension, role in (
            ('AQ', width, 'wide', 'cable_tray_width'), ('AR', depth, 'deep', 'cable_tray_depth')):
        if _positive(value):
            dimensions.append(f'{_number(value)} mm {dimension}')
            basis.append({'column': column, 'role': role, 'value': value})
    if dimensions:
        lines.append(' × '.join(dimensions))
    return {'value': '\n'.join(lines) if lines else UNKNOWN,
            'decision': 'calculator_only' if basis else 'unspecified', 'basis': basis}


def library_service_size_evidence(inputs, item, source_sha256):
    """Use a retained source statement only when its row and text match.

    The complete literal statement preserves mixed services, limits, openings,
    and installation conditions. It is display metadata, never a numeric
    diameter, width, depth, or calculation input. Saved descriptions that differ
    from the supplier statement cannot acquire the supplier's provenance.
    """
    calculated = service_size_evidence(inputs)
    if calculated['decision'] != 'unspecified':
        return calculated
    if (not isinstance(inputs, dict) or not isinstance(item, dict)
            or not isinstance(source_sha256, str)
            or not re.fullmatch('[a-f0-9]{64}', source_sha256)):
        return calculated
    description = inputs.get('T')
    if not isinstance(description, str) or not description.strip():
        return calculated
    matches = []
    for source in item.get('sources', []):
        row = source.get('row')
        if (source.get('sha256') != source_sha256 or source.get('sheet') != 'CALC'
                or type(row) is not int or row < 1
                or not isinstance(source.get('filename'), str) or not source['filename']):
            continue
        cell = f'T{row}'
        fields = [field for field in item.get('fields', [])
                  if field.get('column') == 'T' and field.get('source_cell') == cell]
        if len(fields) == 1 and fields[0].get('value') == description:
            matches.append({'filename': source['filename'], 'sha256': source_sha256,
                            'sheet': 'CALC', 'row': row, 'column': 'T',
                            'source_cell': cell, 'role': 'source_item_statement',
                            'value': description})
    if len(matches) != 1:
        return calculated
    source = matches[0]
    return {'value': f"Source item description ({source['filename']} · CALC!{source['source_cell']}):\n{description}",
            'decision': 'source_statement', 'basis': matches}


def service_size_field(inputs, *, item=None, source_sha256=None):
    evidence = (library_service_size_evidence(inputs, item, source_sha256)
                if item is not None else service_size_evidence(inputs))
    field = {'label': FIELD_LABEL, 'value': evidence['value']}
    if evidence['decision'] == 'source_statement':
        source = evidence['basis'][0]
        field.update(source_cell=source['source_cell'], source_workbook=source['filename'],
                     source_sha256=source['sha256'])
    return field
