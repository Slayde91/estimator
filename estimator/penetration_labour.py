"""Explicit firestopping labour policy, separate from immutable workbook inputs.

Missing/null application inputs remain automatic. Resolved defaults are view
metadata, never materialized into a saved draft or written into the source model.
"""

import math

from .catalog import ValidationError


APP_INPUT_FIELDS = {
    'register_allowance_hours': {'label': 'Register Allowance',
                                 'group': 'Products and labour', 'after': 'W'},
    'pipe_labour_hours': {'label': 'Pipe Labour', 'group': 'Pipes', 'after': 'AN'},
}
PIPE_BANDS = ((50, .25), (100, .30), (150, .35), (200, .40), (250, .45), (300, .50))
PIPE_BAND_SETTINGS = tuple((maximum, f'pipe_labour_{maximum}_hours', hours)
                           for maximum, hours in PIPE_BANDS)
REGISTER_HOURS = .25
PIPE_HOURS_REQUIRED = 'Enter Pipe Labour hours for the selected collar; a positive diameter up to 300 mm is required for automatic hours.'


def validate_hours(value, key):
    """Accept an automatic choice or a finite nonnegative manual allowance."""
    if value in (None, ''):
        return None
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not 0 <= value <= 1e12 or not math.isfinite(value)):
        raise ValidationError(f"{APP_INPUT_FIELDS[key]['label']} must be a finite number between 0 and 1e12, or blank for automatic hours.")
    return value


def resolve_labour(inputs, settings=None):
    """Resolve defaults and per-item labour without mutating the entered inputs.

The pipe allowance is per pipe. AN scales it here; Item QTY O scales all task
hours later in DK. No selected collar means no pipe labour, even if a manual
allowance is retained for a future selection.
"""
    settings = settings or {}
    collar_selected = inputs.get('Y') not in (None, '')
    diameter = inputs.get('AL')
    automatic_pipe = None
    if (collar_selected and isinstance(diameter, (int, float)) and not isinstance(diameter, bool)
            and 0 < diameter <= 300 and math.isfinite(diameter)):
        automatic_pipe = next((settings.get(key, hours) for maximum, key, hours in PIPE_BAND_SETTINGS
                               if diameter <= maximum), None)
    defaults = {'register_allowance_hours': REGISTER_HOURS, 'pipe_labour_hours': automatic_pipe}
    register = validate_hours(inputs.get('register_allowance_hours'), 'register_allowance_hours')
    pipe = (validate_hours(inputs.get('pipe_labour_hours'), 'pipe_labour_hours')
            if collar_selected else None)
    register = defaults['register_allowance_hours'] if register is None else register
    pipe = defaults['pipe_labour_hours'] if pipe is None else pipe
    errors = []
    pipe_task = ''
    if collar_selected:
        if pipe is None:
            pipe_task = '#VALUE!'
            errors.append({'cell': 'pipe_labour_hours', 'message': PIPE_HOURS_REQUIRED})
        else:
            multiplier = inputs.get('AN')
            # Same N semantics used by the source's count-dependent quantities.
            pipe_task = pipe * (multiplier if isinstance(multiplier, (int, float)) else 0)
    return {'input_defaults': defaults, 'register_hours': register,
            'pipe_hours': pipe, 'pipe_task_hours': pipe_task, 'errors': errors}
