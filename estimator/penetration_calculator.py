"""Penetration workbook adapter, isolated from the existing three calculators.

The 76 CALC/BREAKDOWN formulas execute through the shared parser and a bounded
LET/XLOOKUP extension. The 32 external LISTS formulas are materialized from the
same effective inventory snapshot used by pricing. Raw formulas remain in data.
"""

from copy import deepcopy
from functools import lru_cache
import gzip
import json
import math
from pathlib import Path
import re

from .catalog import FIRESTOPPING_GROUPS, ValidationError, effective_catalog
from .excel_engine import (WorkbookEngine, CellRange, FormulaError, column_name,
                           column_number, coordinates, comparison, numeric, scalar)
from .penetration_labour import (APP_INPUT_FIELDS, LEGACY_APP_INPUT_FIELDS,
                                 PIPE_BAND_SETTINGS, REGISTER_HOURS,
                                 resolve_labour, validate_hours)


CAPACITY = 1000
GLOBAL_DEFAULTS = {'J': 'No', 'K': None, 'L': 0, 'M': 0}
WASTE_SETTINGS = {
    'waste_additional': ('AG', 'Additional Allowances'),
    'waste_pipes': ('AO', 'Unlagged Pipes, Plastic Pipes and Cables/Bundles'),
    'waste_cabletrays': ('AU', 'Cabletrays'),
    'waste_substrate': ('AZ', 'Substrate'),
    'waste_board': ('BF', 'Bulkhead board'),
    'waste_framing': ('BG', 'Bulkhead framing'),
}
SETTING_DEFAULTS = {
    'register_allowance_hours': REGISTER_HOURS,
    **{key: hours for _, key, hours in PIPE_BAND_SETTINGS},
    **{key: 0 for key in WASTE_SETTINGS},
}
DRAFT_GLOBAL_DEFAULTS = {**GLOBAL_DEFAULTS, **SETTING_DEFAULTS}
# Explicit application policy; original workbook formulas and saved inputs remain
# available for provenance. Removed allowances never affect effective estimates.
EFFECTIVE_GLOBALS = {'J': 'No', 'K': 0, 'L': 0, 'M': 0}
CALCULATION_POLICY_VERSION = 'firestopping-settings-and-frl-v5'
ROW_DEFAULTS = {}
# Descriptive choices only: these do not select products or alter workbook rules.
SERVICE_TYPES = (
    'Access Panel', 'Blank Seal', 'Cable Bundles', 'Coaxial Cables', 'Conduit',
    'Conduits', 'D1 Power Cables', 'D2 Comms Cables', 'Data Cable Bundles',
    'Downlight Box', 'Downlights', 'Fibre Optic', 'Fire Resistant Cables',
    'Junction Box', 'Lagged Pipes', 'Mixed Service Bundle', 'Mixed Services',
    'Multi-service Bundle', 'Pair Coil Bundle', 'Pair Coils', 'Plastic Pipes',
    'Power Cable Bundles', 'Power Cables', 'Single Cables',
    'TPS & Fire Alarm Cable Bundles', 'Unlagged Pipes', 'Cable Trays',
    'Busbar Trunking', 'Fire Dampers', 'Flexible Ducts', 'Linear Joints',
    'Movement Joints',
)
MANUFACTURERS = ('Promat', 'Trafalgar', 'Boss', 'Firefly', 'Hilti', 'Snap', 'Fendix')
GROUP_COLUMNS = {
    'Penetration': 'J K L M N O P Q R T U V'.split(),
    'Products and labour': 'W X Y Z AA AB AC'.split(),
    'Additional Allowances': 'AE AF AG AH AI AJ'.split(),
    'Pipes': 'AL AM AN AO'.split(),
    'Cabletrays': 'AQ AR AS AT AU'.split(),
    'Substrate': 'AW AX AY AZ'.split(),
    'Bulkhead': 'BB BC BD BE BF BG'.split(),
}
PIPE_DISPLAY_GROUPS = {
    'Unlagged Pipes': ('Unlagged Pipes', 'Lagged Pipes'),
    'Plastic Pipes': ('Plastic Pipes', 'Conduit', 'Conduits'),
    'Cables/Bundles': (
        'Cable Bundles', 'Coaxial Cables', 'D1 Power Cables', 'D2 Comms Cables',
        'Data Cable Bundles', 'Fire Resistant Cables', 'Mixed Service Bundle',
        'Mixed Services', 'Multi-service Bundle', 'Pair Coil Bundle', 'Pair Coils',
        'Power Cable Bundles', 'Power Cables', 'Single Cables',
        'TPS & Fire Alarm Cable Bundles',
    ),
}
CABLETRAY_SERVICE_TYPES = (
    *PIPE_DISPLAY_GROUPS['Cables/Bundles'],
    'Cable Trays',
    # Four installed source items use the cable-tray calculation for lagged
    # services, so retain that source-backed case as a relevant choice.
    'Lagged Pipes',
)
GROUP_VISIBILITY = {
    'Bulkhead': {'column': 'J', 'values': ('Bulkheads',)},
    'Cabletrays': {'column': 'K', 'values': CABLETRAY_SERVICE_TYPES},
    'Substrate': {'any': (
        {'column': 'L', 'values': ('Oversized',)},
        {'column': 'K', 'values': (
            'Access Panel', 'Blank Seal', 'Fire Dampers', 'Linear Joints',
            'Movement Joints',
        )},
    )},
    **{group: {'column': 'K', 'values': services}
       for group, services in PIPE_DISPLAY_GROUPS.items()},
}
FIELD_STEPS = {
    'O': 1,
    'AC': .25,
    'AF': 1,
    'AG': 1,
    'AH': .25,
    'AI': 1,
    'AJ': 1,
    'AM': 5,
    'AO': 1,
    'AQ': 5,
    'AR': 5,
    'AS': 5,
    'AT': 1,
    'AU': 1,
    'AW': 5,
    'AX': 5,
    'AY': 1,
    'AZ': 1,
    'BB': 5,
    'BC': 5,
    'BD': 5,
    'BE': 1,
    'BF': 1,
    'BG': 1,
}
ROW_COLUMNS = tuple(c for cols in GROUP_COLUMNS.values() for c in cols)
TEXT_COLUMNS = set('J K L M N P Q R T U V W X Y Z AA AB AE'.split())
PERCENT_COLUMNS = set('AG AO AU AZ BF BG'.split())
FRL_OPTIONS = ('N/A', '-/60/60', '-/90/90', '-/120/120', '-/180/180', '-/240/240')
PRICE_COLUMNS = {'W': 'AK', 'X': 'M', 'Y': 'B', 'Z': 'AN', 'AA': 'E', 'AB': 'S', 'AE': 'AR'}
OUTPUT_PERCENT_COLUMNS = {'BI', 'BJ', 'BK', 'BR', 'CA', 'CI', 'CP'}
QUANTITY_OUTPUT_CONTEXTS = {'BS': 'Pipes', 'CB': 'Cabletrays', 'CJ': 'Substrate',
                            'CQ': 'Bulkhead', 'CU': 'Bulkhead'}
TASK_HOUR_LABELS = {'DE': 'Board Task Hours', 'DF': 'Pipes Task Hours',
                    'DG': 'Mastic Task Hours', 'DH': 'Framing Task Hours',
                    'DI': 'Wrap Task Hours', 'DJ': 'Additional Labour Task Hours', 'DK': 'Total Task Hours'}
CHOICE_NAMES = {'J': 'servicelist', 'L': 'pentype', 'M': 'orientation', 'N': 'FRL',
                'P': 'substrates', 'Q': 'Access', 'R': 'complexity'}
SUMMARY_COLUMNS = {'C2': 'other_allowances', 'D2': 'travel_lafha', 'E2': 'access',
                   'F2': 'labour', 'G2': 'materials', 'H2': 'grand_total', 'N2': 'total_days'}


@lru_cache(maxsize=1)
def source_model():
    with gzip.open(Path(__file__).resolve().parents[1] / 'data' / 'penetration.json.gz', 'rt', encoding='utf-8') as stream:
        return json.load(stream)


def _sheet(name):
    return next(s for s in source_model()['sheets'] if s['name'] == name)


def _firestopping_rules():
    rules = {rule['column']: rule for rule in source_model()['list_filters']}
    return [{**group, 'keywords': rules[group['list_column']]['keywords']} for group in FIRESTOPPING_GROUPS]


def firestopping_group_keys(item):
    """Return explicit assignments, or source-compatible defaults for old libraries."""
    if 'firestopping_groups' in item:
        return tuple(item['firestopping_groups'])
    source = item['sales_description'].casefold()
    return tuple(group['key'] for group in _firestopping_rules()
                 if any(keyword.casefold() in source for keyword in group['keywords']))


def inventory_lists(configuration=None):
    """Materialize source FILTER/XLOOKUP semantics, preserving order/first match.

    All 1,000 lookup spill rows are overlaid, including empty strings. Otherwise
    a deleted product could resurrect a cached source price or dimension.
    """
    inventory = effective_catalog(configuration)['inventory']
    if len(inventory) > 2098:
        raise ValidationError('The penetration workbook supports at most 2,098 inventory entries.')
    first = {}
    for item in inventory:
        first.setdefault(item['sales_description'].casefold(), item)
    values, selections = {}, {}
    editable_groups = {group['list_column']: group['key'] for group in FIRESTOPPING_GROUPS}
    for rule in source_model()['list_filters']:
        if rule['column'] in editable_groups:
            key = editable_groups[rule['column']]
            names = [item['sales_description'] for item in inventory if key in firestopping_group_keys(item)]
        else:
            names = [item['sales_description'] for item in inventory
                     if any(keyword.casefold() in item['sales_description'].casefold() for keyword in rule['keywords'])]
        if len(names) > 1000:
            raise ValidationError('A penetration product list exceeds its 1,000-entry workbook capacity.')
        selections[rule['column']] = names
        for row in range(1, 1001):
            values[rule['column'] + str(row)] = names[row - 1] if row <= len(names) else ('No matches' if row == 1 and not names else None)
    properties = {'R': 'width_mm', 'S': 'length_mm', 'U': 'sqm'}
    for rule in source_model()['list_lookups']:
        for row in range(1, 1001):
            name = values[rule['lookup_column'] + str(row)]
            item = first.get(name.casefold()) if isinstance(name, str) else None
            value = (item['sales_price'] if rule['return_column'] == 'H' else item['properties'].get(properties[rule['return_column']])) if item else ''
            values[rule['column'] + str(row)] = '' if value in (None, 0, '0') else value
    return values, selections


def pricing_usage_metadata():
    """Describe editable Firestopping dropdown groups and legacy defaults."""
    keywords, seen = [], set()
    for rule in source_model()['list_filters']:
        for keyword in rule['keywords']:
            folded = keyword.casefold()
            if folded not in seen:
                keywords.append(keyword)
                seen.add(folded)
    return {
        'firestopping': {
            'label': 'Firestopping Estimator',
            'source_field': 'sales_description',
            'keywords': keywords,
            'groups': _firestopping_rules(),
        }
    }


def _named_options(name):
    reference = source_model()['defined_names'][name]
    match = re.fullmatch(r'LISTS!\$([A-Z]+)\$(\d+):\$[A-Z]+\$(\d+)', reference)
    cells = _sheet('LISTS')['cells']
    return [cells.get(match[1] + str(r), {}).get('value') for r in range(int(match[2]), int(match[3]) + 1)
            if cells.get(match[1] + str(r), {}).get('value') is not None]


def canonical_frl(value):
    """Map legacy minute labels to the Firestopping Library FRL vocabulary."""
    if value in (None, ''):
        return None
    text = str(value).strip()
    if text.casefold() == 'n/a':
        return 'N/A'
    match = re.fullmatch(r'(?:-/)?(60|90|120|180|240)(?:\s*min|/\1)?', text,
                         flags=re.IGNORECASE)
    return f'-/{match[1]}/{match[1]}' if match else text


def definition(configuration=None, service_types=None):
    _, selections = inventory_lists(configuration)
    calc = _sheet('CALC')['cells']
    fields = []
    descriptions = {
        'K': sorted(set(SERVICE_TYPES) | set(service_types or ()), key=str.casefold),
        'V': list(MANUFACTURERS),
    }
    for group, columns in GROUP_COLUMNS.items():
        display_groups = list(PIPE_DISPLAY_GROUPS) if group == 'Pipes' else None
        for col in columns:
            if col in ('Q', 'R') or col in PERCENT_COLUMNS:
                continue
            options = (selections[PRICE_COLUMNS[col]] if col in PRICE_COLUMNS else
                       list(FRL_OPTIONS) if col == 'N' else
                       _named_options(CHOICE_NAMES[col]) if col in CHOICE_NAMES else descriptions.get(col, []))
            label = {'T': 'Items/Services', 'U': 'System/Install Details',
                     'W': 'Teams/Crews', 'X': 'Board or Batt Type',
                     'AH': 'Additional Labour',
                     'AM': 'Wrap Length required', 'AS': 'Wrap Length required',
                     'AQ': 'Cabletray W x D', 'AW': 'Board/Batt W x L',
                     }.get(col, calc[col + '3']['value'])
            field = {'column': col, 'address': col + '4', 'label': label,
                'type': 'select' if col in PRICE_COLUMNS or col in CHOICE_NAMES or col in descriptions else 'text' if col in TEXT_COLUMNS else 'number',
                'options': options, 'group': group, 'default': ROW_DEFAULTS.get(col),
                'format': 'percent' if col in PERCENT_COLUMNS else 'currency' if col in ('AI', 'AJ') else 'text' if col in TEXT_COLUMNS else 'number',
                'units': '%' if col in PERCENT_COLUMNS else 'mm' if col in 'AL AM AQ AR AS AW AX BB BC BD'.split() else 'hrs' if col == 'AH' else ''}
            if col in FIELD_STEPS:
                field['step'] = FIELD_STEPS[col]
            if display_groups:
                field['display_groups'] = display_groups
            if col == 'AQ':
                field['paired_column'] = 'AR'
                field['placeholder'] = 'e.g. 300 x 50'
            elif col == 'AR':
                field['hidden'] = True
                field['paired_into'] = 'AQ'
            elif col == 'AW':
                field['paired_column'] = 'AX'
                field['placeholder'] = 'e.g. 250 x 250'
            elif col == 'AX':
                field['hidden'] = True
                field['paired_into'] = 'AW'
            fields.append(field)
            for key, app_field in APP_INPUT_FIELDS.items():
                if app_field['after'] == col and app_field['group'] == group:
                    field = {'column': key, 'address': None, 'label': app_field['label'],
                        'type': 'number', 'options': [], 'group': group, 'default': None,
                        'format': 'number', 'units': 'hrs', 'min': 0,
                        'automatic_default': True, 'source': 'application'}
                    if key in FIELD_STEPS:
                        field['step'] = FIELD_STEPS[key]
                    if display_groups:
                        field['display_groups'] = display_groups
                    if key == 'pipe_labour_hours':
                        field['enabled_when'] = {'column': 'Y', 'nonblank': True}
                        field['hidden'] = True
                    fields.append(field)
    output_fields = []
    for address, cell in sorted(calc.items(), key=lambda item: coordinates(item[0])[1]):
        if not address.endswith('4') or 'formula' not in cell:
            continue
        col = address[:-1]
        group = 'Summary' if column_number(col) <= 8 else 'Multipliers' if col in ('BI', 'BJ', 'BK') else 'Material quantities' if column_number(col) < column_number('CW') else 'Unit prices' if column_number(col) < column_number('DE') else 'Task Hours' if column_number(col) <= column_number('DK') else 'Material costs'
        output_fields.append({'column': col, 'address': address, 'label': TASK_HOUR_LABELS.get(col, calc.get(col + '3', {}).get('value', col)),
            'group': group, 'format': 'percent' if col in OUTPUT_PERCENT_COLUMNS else 'currency' if group in ('Summary', 'Unit prices', 'Material costs') else 'number',
            'units': '%' if col in OUTPUT_PERCENT_COLUMNS else 'hours' if group == 'Task Hours' else '',
            **({'quantity_context': QUANTITY_OUTPUT_CONTEXTS[col]} if col in QUANTITY_OUTPUT_CONTEXTS else {})})
    global_fields = [{
        'column': 'register_allowance_hours', 'address': None,
        'label': 'Register Allowance', 'type': 'number', 'options': [],
        'group': 'SETTINGS', 'default': REGISTER_HOURS, 'format': 'number',
        'units': 'hrs', 'min': 0, 'step': .05, 'source': 'application',
        'help': 'Register Allowance hours applied to every Firestopping item.',
    }]
    global_fields.extend({
        'column': key, 'address': None, 'label': f'Pipe Labour up to {maximum} mm',
        'type': 'number', 'options': [], 'group': 'SETTINGS', 'default': hours,
        'format': 'number', 'units': 'hrs', 'min': 0, 'step': .05,
        'source': 'application',
        'help': f'Pipe Labour hours per collar for pipe diameters up to {maximum} mm.',
    } for maximum, key, hours in PIPE_BAND_SETTINGS)
    global_fields.extend({
        'column': key, 'address': None, 'label': 'Waste', 'type': 'number',
        'options': [], 'group': 'SETTINGS', 'default': 0, 'format': 'percent',
        'units': '%', 'min': 0, 'step': 1, 'source': 'application',
        'help': f'Applies to {context}.', 'legacy_column': column,
    } for key, (column, context) in WASTE_SETTINGS.items())
    return {'id': 'penetration', 'title': 'Firestopping Estimator', 'source_sha256': source_model()['source']['sha256'],
        'capacity': CAPACITY, 'defaults': {'globals': deepcopy(DRAFT_GLOBAL_DEFAULTS), 'rows': [{'id': 'line-1', 'inputs': deepcopy(ROW_DEFAULTS)}]},
        'schedule_defaults': {'globals': deepcopy(DRAFT_GLOBAL_DEFAULTS), 'rows': []},
        'global_fields': global_fields, 'row_fields': fields, 'output_fields': output_fields,
        'groups': [group for source in GROUP_COLUMNS
                   for group in (PIPE_DISPLAY_GROUPS if source == 'Pipes' else (source,))] + ['SETTINGS'],
        'group_labels': {'Penetration': 'DETAILS', 'Cabletrays': 'CABLE TRAYS', 'Additional Allowances': 'OTHER'},
        'group_visibility': {
            group: ({'any': [{'column': condition['column'], 'values': list(condition['values'])}
                              for condition in rule['any']]}
                    if 'any' in rule else
                    {'column': rule['column'], 'values': list(rule['values'])})
            for group, rule in GROUP_VISIBILITY.items()},
        'allowed_input_columns': [*ROW_COLUMNS, *APP_INPUT_FIELDS, *LEGACY_APP_INPUT_FIELDS],
        'calculation_policy': CALCULATION_POLICY_VERSION,
        'quantity_output_columns': list(QUANTITY_OUTPUT_CONTEXTS)}


def normalize_draft(draft):
    if draft is None:
        draft = {'globals': {}, 'rows': [{'id': 'line-1', 'inputs': {}}]}
    if not isinstance(draft, dict) or set(draft) - {'globals', 'rows'}:
        raise ValidationError('Penetration draft must contain globals and rows only.')
    globals_in = draft.get('globals', {})
    rows = draft.get('rows', [{'id': 'line-1', 'inputs': {}}])
    if not isinstance(globals_in, dict) or set(globals_in) - set(DRAFT_GLOBAL_DEFAULTS):
        raise ValidationError('Unknown penetration global input.')
    if not isinstance(rows, list) or not 0 <= len(rows) <= CAPACITY:
        raise ValidationError(f'Penetration schedule must contain 0 to {CAPACITY} rows.')

    def checked(value, text, label):
        if value is None or value == '':
            return None
        if text:
            if not isinstance(value, str) or len(value) > 10000:
                raise ValidationError(f'{label} must be text of at most 10,000 characters.')
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)) or abs(value) > 1e12 or not math.isfinite(value):
            raise ValidationError(f'{label} must be a finite number between -1e12 and 1e12.')
        return value

    globals_out = dict(DRAFT_GLOBAL_DEFAULTS)
    for col, value in globals_in.items():
        normalized_value = checked(value, col == 'J', col + '2')
        globals_out[col] = SETTING_DEFAULTS[col] if col in SETTING_DEFAULTS and normalized_value is None else normalized_value
    if globals_out['J'] not in ('Yes', 'No', None):
        raise ValidationError('LAFHA must be Yes or No.')
    for key in SETTING_DEFAULTS:
        if globals_out[key] is None or globals_out[key] < 0:
            raise ValidationError('Firestopping SETTINGS values must be finite nonnegative numbers.')
    # One-row library drafts and older projects stored waste on each item. Move
    # the first entered value for each context into the new shared setting.
    for key, (column, _) in WASTE_SETTINGS.items():
        legacy = [row.get('inputs', {}).get(column) for row in rows
                  if isinstance(row, dict) and isinstance(row.get('inputs'), dict)
                  and row['inputs'].get(column) not in (None, '')]
        checked_legacy = [checked(value, False, column) for value in legacy]
        if any(value < 0 for value in checked_legacy):
            raise ValidationError('Waste (%) must be a finite nonnegative number.')
        if key not in globals_in and checked_legacy:
            globals_out[key] = checked_legacy[0]
    # Older projects stored Register Allowance on each row. Adopt the first
    # entered value once, then remove all per-item copies so SETTINGS becomes
    # the single effective control without rejecting historical project files.
    legacy_register = [row.get('inputs', {}).get('register_allowance_hours') for row in rows
                       if isinstance(row, dict) and isinstance(row.get('inputs'), dict)
                       and row['inputs'].get('register_allowance_hours') not in (None, '')]
    checked_register = [validate_hours(value, 'register_allowance_hours')
                        for value in legacy_register]
    if 'register_allowance_hours' not in globals_in and checked_register:
        globals_out['register_allowance_hours'] = checked_register[0]
    result, seen, library_ids = [], set(), set()
    for row in rows:
        if not isinstance(row, dict) or set(row) - {'id', 'inputs', 'library_item_id'}:
            raise ValidationError('Each penetration row must contain id, inputs and an optional library item ID only.')
        identifier, inputs = row.get('id'), row.get('inputs', {})
        if not isinstance(identifier, str) or not identifier or len(identifier) > 128 or identifier in seen:
            raise ValidationError('Penetration row IDs must be unique nonempty text, at most 128 characters.')
        if not isinstance(inputs, dict) or set(inputs) - set(ROW_COLUMNS) - set(APP_INPUT_FIELDS) - set(LEGACY_APP_INPUT_FIELDS):
            raise ValidationError('Unknown penetration row input; calculated cells cannot be edited.')
        seen.add(identifier)
        normalized = {'id': identifier, 'inputs': {
            col: validate_hours(value, col) if col in APP_INPUT_FIELDS or col in LEGACY_APP_INPUT_FIELDS else
                 canonical_frl(value) if col == 'N' else checked(value, col in TEXT_COLUMNS, col)
            for col, value in inputs.items() if col not in LEGACY_APP_INPUT_FIELDS}}
        effective_inputs = normalized['inputs']
        if effective_inputs.get('Y') in (None, ''):
            effective_inputs.pop('pipe_labour_hours', None)
        labour = resolve_labour(effective_inputs, globals_out)
        if (effective_inputs.get('K') == 'Plastic Pipes'
                and effective_inputs.get('Y') not in (None, '')
                and isinstance(effective_inputs.get('AH'), (int, float))
                and effective_inputs['AH'] > 0
                and not labour['errors']
                and isinstance(labour['pipe_hours'], (int, float))
                and labour['pipe_hours'] > 0):
            # Pipe Labour prices the collar installation. Older Plastic Pipes
            # library rows repeated that time in Additional Labour; normalize
            # every draft path so library, composer and schedule agree.
            effective_inputs['AH'] = None
        if 'library_item_id' in row:
            library_id = row['library_item_id']
            if not isinstance(library_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', library_id):
                raise ValidationError('The library item ID must contain 1 to 200 letters, digits, dots, colons, underscores or hyphens.')
            if library_id in library_ids:
                raise ValidationError('Each library item may appear only once in a firestopping schedule; update its quantity instead.')
            library_ids.add(library_id)
            normalized['library_item_id'] = library_id
        result.append(normalized)
    return {'globals': globals_out, 'rows': result}


def normalize_composer(draft):
    """The independent item editor always owns exactly one input row."""
    if not isinstance(draft, dict):
        raise ValidationError('The Firestopping composer must contain exactly one row.')
    result = normalize_draft(draft)
    if len(result['rows']) != 1:
        raise ValidationError('The Firestopping composer must contain exactly one row.')
    return result


class PenetrationEngine(WorkbookEngine):
    """Only this workbook receives LET, XLOOKUP and bounded whole-column refs."""

    def __init__(self, model, inputs=None, formula_overrides=None):
        super().__init__(model, inputs, formula_overrides)
        self.environments = []

    def cell(self, sheet, row, column):
        environment, self.environments = self.environments, []
        try:
            return super().cell(sheet, row, column)
        finally:
            self.environments = environment

    def expand_tables(self, formula):
        formula = super().expand_tables(formula)
        # Full columns occur only in LISTS lookups. The entire source populated
        # domain plus one genuinely blank row retains blank-match semantics.
        def part(text):
            text = text.replace('_xlfn.', '')
            return re.sub(r'(?<![A-Za-z0-9_])LISTS!\$?([A-Z]+):\$?([A-Z]+)(?![A-Za-z0-9_])',
                          lambda m: f'LISTS!${m[1]}$1:${m[2]}$1001', text)
        return ''.join(s if i % 2 else part(s) for i, s in enumerate(re.split(r'("(?:[^"]|"")*")', formula)))

    def evaluate(self, node, sheet, row, column):
        if node[0] == 'name':
            for env in reversed(self.environments):
                if node[1].casefold() in env:
                    return env[node[1].casefold()]
        return super().evaluate(node, sheet, row, column)

    def function(self, name, nodes, sheet, row, column):
        def arg(index):
            return self.evaluate(nodes[index], sheet, row, column)
        if name == 'LET':
            if len(nodes) < 3 or len(nodes) % 2 != 1:
                raise FormulaError('#VALUE!')
            env = {}
            self.environments.append(env)
            try:
                for i in range(0, len(nodes) - 1, 2):
                    if nodes[i][0] != 'name':
                        raise FormulaError('#NAME?')
                    env[nodes[i][1].casefold()] = arg(i + 1)
                return arg(len(nodes) - 1)
            finally:
                self.environments.pop()
        if name == 'ROWS':
            value = arg(0)
            return value.shape[0] if isinstance(value, CellRange) else 1
        if name == 'XLOOKUP':
            lookup, keys, returns = scalar(arg(0)), arg(1), arg(2)
            # Native Excel distinguishes a blank diameter from numeric zero in
            # the collar's next-larger lookup; blank must not select band 50.
            if lookup is None:
                lookup = ''
            if not isinstance(keys, CellRange) or not isinstance(returns, CellRange) or keys.shape != returns.shape or min(keys.shape) != 1:
                raise FormulaError('#VALUE!')
            mode = int(numeric(arg(4))) if len(nodes) > 4 else 0
            if mode not in (0, 1):
                raise ValueError('Unsupported penetration XLOOKUP mode')
            horizontal = keys.shape[0] == 1
            count = keys.shape[1] if horizontal else keys.shape[0]
            found, candidate = None, None
            for i in range(count):
                value = keys.at(0, i) if horizontal else keys.at(i, 0)
                diff = comparison(value, lookup)
                if diff == 0:
                    found = i
                    break
                if mode == 1 and diff > 0 and (candidate is None or comparison(value, candidate[0]) < 0):
                    candidate = value, i
            if found is None and candidate is not None:
                found = candidate[1]
            if found is None:
                if len(nodes) > 3 and nodes[3] != ('value', None):
                    return arg(3)
                raise FormulaError('#N/A')
            result = returns.at(0, found) if horizontal else returns.at(found, 0)
            return 0 if result is None else result
        return super().function(name, nodes, sheet, row, column)


def _copy_row_formula(formula, destination):
    # All source schedule expressions are ordinary A1 refs; quoted literals and
    # absolute rows remain intact. Independent openpyxl/native tests guard this.
    return ''.join(part if i % 2 else re.sub(r'(?<![A-Za-z0-9_])([$]?[A-Z]{1,3})([$]?)([1-9]\d*)(?![A-Za-z0-9_])',
        lambda m: m[1] + m[2] + (m[3] if m[2] else str(int(m[3]) + destination - 4)), part)
        for i, part in enumerate(re.split(r'("(?:[^"]|"")*")', formula)))


def engine_for_draft(draft, configuration=None, *, effective=True):
    draft = normalize_draft(draft)
    model = dict(source_model())
    model['sheets'] = [dict(s, cells=dict(s['cells'])) if s['name'] == 'CALC' else s for s in model['sheets']]
    calc = next(s for s in model['sheets'] if s['name'] == 'CALC')['cells']
    formulas = {a: c for a, c in calc.items() if a.endswith('4') and 'formula' in c}
    overlays, _ = inventory_lists(configuration)
    globals_ = EFFECTIVE_GLOBALS if effective else {
        key: draft['globals'][key] for key in GLOBAL_DEFAULTS}
    inputs = {'LISTS': overlays, 'CALC': {col + '2': value for col, value in globals_.items()}}
    overrides = {'CALC': {}}
    if not draft['rows']:
        # The workbook has one physical template row. An empty application
        # schedule has no template item or travel/setup charge to calculate.
        # Inputs overlay that boundary; the immutable source formulas stay intact.
        inputs['CALC'].update({col + '4': None for col in ROW_COLUMNS})
        inputs['CALC'].update({address: 0 for address in SUMMARY_COLUMNS})
        inputs['BREAKDOWN'] = {address: 0 for address, cell in _sheet('BREAKDOWN')['cells'].items()
                               if 'formula' in cell}
        return PenetrationEngine(model, inputs), draft
    for index, row in enumerate(draft['rows'], 4):
        for col in ROW_COLUMNS:
            inputs['CALC'][col + str(index)] = row['inputs'].get(col)
        if effective:
            inputs['CALC'].update({column + str(index): draft['globals'][key]
                                   for key, (column, _) in WASTE_SETTINGS.items()})
            # These are additive source surcharges, so zero removes the effect
            # regardless of historical P/Q/R values or changed lookup prices.
            inputs['CALC'].update({col + str(index): 0 for col in ('BI', 'BJ', 'BK')})
        for address, cell in formulas.items():
            if index != 4:
                calc[address[:-1] + str(index)] = dict(cell, formula=_copy_row_formula(cell['formula'], index))
        if effective:
            labour = resolve_labour(row['inputs'], draft['globals'])
            if labour['errors']:
                # A formula error propagates through DK/F/H and each summary;
                # a literal error-looking string would be silently zeroed by N.
                overrides['CALC'][f'DF{index}'] = '=0+"Pipe Labour hours required"'
            else:
                inputs['CALC'][f'DF{index}'] = labour['pipe_task_hours']
            tasks = ','.join(f'{column}{index}' for column in ('DE', 'DF', 'DG', 'DH', 'DI', 'DJ'))
            overrides['CALC'][f'DK{index}'] = (
                f'=_xlfn.LET(_xlpm.base,SUM({tasks})+{labour["register_hours"]!r},'
                f'_xlpm.total,_xlpm.base*N(O{index}),'
                'IF(_xlpm.base<=0,"",_xlpm.total))')
    last = len(draft['rows']) + 3
    for address in SUMMARY_COLUMNS:
        calc[address] = dict(calc[address], formula=re.sub(r'(:[A-Z]+)4\b', lambda m: m[1] + str(last), calc[address]['formula']))
    return PenetrationEngine(model, inputs, overrides), draft


def calculate(draft, configuration=None):
    engine, draft = engine_for_draft(draft, configuration)
    spec = definition(configuration)
    rows, errors = [], []
    for index, row in enumerate(draft['rows'], 4):
        output, row_errors = {}, []
        labour = resolve_labour(row['inputs'], draft['globals'])
        row_errors.extend(deepcopy(labour['errors']))
        for field in spec['output_fields']:
            address = field['column'] + str(index)
            try:
                output[field['column']] = engine.cell('CALC', *coordinates(address))
            except FormulaError as error:
                output[field['column']] = error.code
                row_errors.append({'cell': address, 'message': error.code})
        for col in (*PRICE_COLUMNS, *(col for col in CHOICE_NAMES if col not in ('Q', 'R'))):
            value = row['inputs'].get(col)
            options = next(f['options'] for f in spec['row_fields'] if f['column'] == col)
            if value and value.casefold() not in {v.casefold() for v in options}:
                message = 'Selected product or labour option is absent from this pricing snapshot.' if col in PRICE_COLUMNS else 'Selected option is absent from the workbook choices.'
                row_errors.append({'cell': col + str(index), 'message': message})
        errors.extend(dict(error, row_id=row['id']) for error in row_errors)
        rows.append({'id': row['id'], 'inputs': deepcopy(row['inputs']), 'outputs': output, 'errors': row_errors,
                     'input_defaults': labour['input_defaults'],
                     'labour_policy': {key: value for key, value in labour.items() if key != 'input_defaults'}})
    summary_cells = {}
    for address in SUMMARY_COLUMNS:
        try:
            summary_cells[address] = engine.cell('CALC', *coordinates(address))
        except FormulaError as error:
            summary_cells[address] = error.code
            errors.append({'row_id': None, 'cell': address, 'message': error.code})
    summary = {name: summary_cells[address] for address, name in SUMMARY_COLUMNS.items()}
    try:
        hours = [engine.cell('CALC', index, column_number('DK')) for index in range(4, len(rows) + 4)]
        summary['labour_hours'] = sum(value for value in hours if isinstance(value, (int, float)) and not isinstance(value, bool))
    except FormulaError as error:
        summary['labour_hours'] = error.code
        errors.append({'row_id': None, 'cell': 'DK4:DK' + str(len(rows) + 3), 'message': error.code})
    breakdown = {address: engine.value('BREAKDOWN', address) for address, cell in _sheet('BREAKDOWN')['cells'].items() if 'formula' in cell}
    from .penetration_breakdown import add_breakdowns, material_breakdown, schedule_breakdown
    result = add_breakdowns({'source_sha256': source_model()['source']['sha256'], 'calculation_policy': CALCULATION_POLICY_VERSION,
        'draft': draft, 'summary': summary,
        'summary_cells': summary_cells, 'rows': rows, 'errors': errors, 'breakdown_cells': breakdown, 'definition': spec}, source_model())
    result['schedule_breakdown'] = schedule_breakdown(result)
    result['material_breakdown'] = material_breakdown(result)
    return result
