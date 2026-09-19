"""Display only dimensions entered into the calculation, without text inference."""

import math


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


def service_size_field(inputs):
    return {'label': FIELD_LABEL, 'value': service_size_evidence(inputs)['value']}
