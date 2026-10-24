"""PROMATECT board selection from the reviewed FC15555-01-03 tables.

The original workbook remains immutable evidence. These application rules replace
its older PROMATECT thickness schedules only; purchasing still uses rectangular
board encasement, not the exposed perimeter of an I/H or circular steel profile.
"""

from bisect import bisect_left, bisect_right
from copy import deepcopy
from functools import lru_cache
from hashlib import sha256
import json
import math
import re

from .board_steel_area import boxed_girth
from .catalog import ROOT
from .excel_engine import WorkbookEngine, column_name
from .schedule_quantity import total_length


REPORT = 'FC15555-01-03'
REPORT_DATE = '13 August 2025'
REPORT_SHA256 = 'e2b47d71893d5837625a4280aca6ee7939c6c23bf53018e954e54ba32894128e'
REPORT_URL = ('https://media.promat.com/cert_371265_au/original/2114005927/'
              'promatect-250--100-as4100-final-fc15555-01-02.pdf?brand=promatconstruction&market=au')
DATASET_SHA256 = '2ca9d1ed223db59bfc7c3df673bf0745b7c443df0628568b6339f6d436e8dce9'
PRODUCTS = {'PROMATECT 100': 'P100', 'PROMATECT 250': 'P250'}
PERIODS = (30, 60, 90, 120, 180)
TEMPERATURES = {
    'Column': (350, 400, 450, 500, 520, 550, 600, 650, 700),
    'Beam': (350, 400, 450, 500, 520, 550, 600, 620, 650, 700),
}
STOCK_SYSTEMS = {'P100': ((15,), (20,), (15, 15), (20, 15), (20, 20)), 'P250': ((30,),)}
_STOCK_ROWS = {'P100|15': 13, 'P100|20': 14, 'P100|15+15': 16,
               'P100|20+15': 17, 'P100|20+20': 18, 'P250|30': 22}
_DERIVED = set(('Y Z AA AB AI AJ AK AN AO AP AS AT AU AV AW AX BB BC BG BL BM BN BO BQ BR BV BW CA').split())


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def canonical_product(value):
    """Match native Excel's case-insensitive product identity; keep raw inputs."""
    if isinstance(value, str):
        return next((name for name in PRODUCTS if name.casefold() == value.casefold()), None)
    return None


def stock_choices(product):
    """Purchasable stock only; historical unsupported inputs are retained."""
    return {'PROMATECT 100': (15, 20), 'PROMATECT 250': (30,)}.get(canonical_product(product), ())


@lru_cache(maxsize=1)
def assessment_tables():
    path = ROOT / 'data' / 'promat_board_fc15555_01_03.json'
    payload = path.read_bytes()
    if len(payload) > 64 * 1024 or sha256(payload).hexdigest() != DATASET_SHA256:
        raise ValueError('PROMATECT assessment tables differ from the reviewed evidence.')
    data = json.loads(payload)
    if (data.get('schema_version') != 1 or data.get('periods_min') != list(PERIODS)
            or data.get('report') != {'number': REPORT, 'issued': '2025-08-13',
                                     'sha256': REPORT_SHA256, 'requested_url': REPORT_URL}):
        raise ValueError('PROMATECT assessment identity differs.')
    result = {}
    expected = [(member, temp) for member, values in TEMPERATURES.items() for temp in values]
    if len(data.get('tables', [])) != len(expected):
        raise ValueError('Incomplete PROMATECT assessment tables.')
    for index, (table, identity) in enumerate(zip(data['tables'], expected)):
        if ((table['member'], table['temperature_c']) != identity
                or table['number'] != index + 5 or table['pages'] != [14 + index * 3, 15 + index * 3]
                or [row[0] for row in table['rows']] != list(range(30, 301, 5))
                or any(len(row) != 5 or any(value is not None and
                       (type(value) is not int or not 10 <= value <= 45) for value in row)
                       for _, row in table['rows'])):
            raise ValueError('Invalid PROMATECT assessment axes or thickness values.')
        result[identity] = table
    return result


def select_stock(product, required_mm, preference='Auto'):
    """Only supplied stock within the report's single/double-layer description."""
    code = PRODUCTS.get(canonical_product(product), product)
    if code not in STOCK_SYSTEMS or not positive(required_mm) or preference not in ('Auto', 'Single', 'Double'):
        return ()
    candidates = [layers for layers in STOCK_SYSTEMS[code] if sum(layers) >= required_mm
                  and (preference == 'Auto' or len(layers) == (1 if preference == 'Single' else 2))]
    return min(candidates, key=lambda layers: (sum(layers), len(layers))) if candidates else ()


def lookup_thickness(product, member, sides, temperature_c, factor, period_min, preference='Auto'):
    """Conservative published-cell selection. No regression/extrapolation."""
    result = {'required_mm': None, 'layers_mm': (), 'error': '', 'source': '',
              'factor': factor, 'factor_used': None, 'period_used': None, 'temperature_used': None}
    def hold(message):
        result['error'] = message
        return result
    product = canonical_product(product)
    if product is None:
        return hold('Choose a supported PROMATECT product.')
    if member not in TEMPERATURES or sides not in (3, 4) or member == 'Column' and sides != 4:
        return hold('Needs review: the assessment lookup covers three-sided beams and four-sided beams/columns.')
    if not positive(temperature_c) or not 350 <= temperature_c <= 700:
        return hold('Needs review: critical temperature is outside the assessed 350–700°C range.')
    if not positive(factor) or factor > 300:
        return hold('Needs review: section factor is outside the published range (maximum 300 m⁻¹).')
    if not positive(period_min) or period_min > PERIODS[-1]:
        return hold('Needs review: fire period is outside the published range (maximum 180 minutes).')
    if preference not in ('Auto', 'Single', 'Double'):
        return hold('Choose Auto, Single or Double layers.')
    table_member = 'Column' if sides == 4 else 'Beam'
    temperatures = TEMPERATURES[table_member]
    temperature_used = temperatures[bisect_right(temperatures, temperature_c) - 1]
    period_index = bisect_left(PERIODS, period_min)
    factor_index = max(0, math.ceil((factor - 30) / 5))
    table = assessment_tables()[table_member, temperature_used]
    used_factor, values = table['rows'][factor_index]
    required = values[period_index]
    result.update(factor_used=used_factor, period_used=PERIODS[period_index],
                  temperature_used=temperature_used, table=table['number'], pages=tuple(table['pages']))
    result['source'] = (f'{REPORT}, {REPORT_DATE}, Table {table["number"]}, pp.{table["pages"][0]}–{table["pages"][1]}; '
                        f'{table_member.lower()} table, {temperature_used}°C, A/V {used_factor} m⁻¹, '
                        f'{PERIODS[period_index]} min')
    if required is None:
        return hold('Needs review: the selected assessment table cell is unavailable; do not extrapolate.')
    result['required_mm'] = required
    result['layers_mm'] = select_stock(product, required, preference)
    if not result['layers_mm']:
        return hold(f'Needs review: the report requires {required} mm; no assessed single/double-layer combination '
                    'using the selected stock/layer preference is available. Three layers and totals above 45 mm are not authorised.')
    return result


def steel_id_choices(model):
    """Hide archived product-tagged choices, retaining their exact saved identity."""
    cells = next(sheet['cells'] for sheet in model['sheets'] if sheet['name'] == 'STEEL LIBRARY')
    choices = [cells[f'A{row}']['value'] for row in range(6, 1348)
            if isinstance(cells.get(f'A{row}', {}).get('value'), str)
            and '[P100]' not in cells[f'A{row}']['value']]
    return choices + list(chs_section_aliases(model))


def chs_section_aliases(model):
    """Exact archived CHS geometry aliases; never a rounded nominal substitution.

    An existing untagged ID always wins. Other product-tagged section families
    retain their historical saved lookup but are not offered as new choices.
    """
    cells = next(sheet['cells'] for sheet in model['sheets'] if sheet['name'] == 'STEEL LIBRARY')
    names = {cells[f'A{row}']['value'] for row in range(6, 1348) if f'A{row}' in cells}
    aliases = {}
    for row in range(6, 1348):
        name = cells.get(f'A{row}', {}).get('value')
        if (cells.get(f'B{row}', {}).get('value') == 'CHS' and isinstance(name, str)
                and name.endswith(' [P100]')):
            alias = name[:-7]
            if alias not in names:
                if alias in aliases:
                    raise ValueError('Ambiguous archived CHS section identity.')
                aliases[alias] = name
    return aliases


class PromatBoardEngine(WorkbookEngine):
    """One assessment selection shared by worksheet, summary, PDF and XLSX."""

    def __init__(self, model, inputs=None, formula_overrides=None):
        super().__init__(model, inputs, formula_overrides)
        aliases = chs_section_aliases(model)
        geometry_inputs = deepcopy(inputs or {})
        self._alias_rows = set()
        for address, value in geometry_inputs.get('CALCULATOR', {}).items():
            if re.fullmatch(r'D[1-9]\d*', address) and isinstance(value, str) and value in aliases:
                geometry_inputs['CALCULATOR'][address] = aliases[value]
                self._alias_rows.add(int(address[1:]))
        self._geometry_engine = WorkbookEngine(model, geometry_inputs, formula_overrides)
        self._promat_rows = {}
        self.required_missing_by_row = {}

    def cell(self, sheet, row, column):
        if sheet.casefold() == 'board summary' and column == 11 and 16 <= row <= 26:
            product = super().cell('BOARD SUMMARY', row, 1)
            if canonical_product(product) is not None:
                choices = stock_choices(product)
                if super().cell('BOARD SUMMARY', row, 2) in choices:
                    return 'Confirmed stock; check sheet size.'
                return 'Unavailable; use ' + '/'.join(str(value) for value in choices) + ' mm stock.'
        if sheet.casefold() == 'extra boards' and column == 13 and 6 <= row <= 45:
            product = super().cell('EXTRA BOARDS', row, 2)
            thickness, choices = super().cell('EXTRA BOARDS', row, 3), stock_choices(product)
            # Native stock keys concatenate exact text as well as numeric cells.
            supported = thickness in choices or isinstance(thickness, str) and thickness in tuple(str(value) for value in choices)
            if canonical_product(product) is not None and not supported:
                return ('REVIEW STOCK – use ' + ' or '.join(f'{value:g}' for value in stock_choices(product))
                        + ' mm stock for ' + product + '; saved input retained.')
        if (sheet.casefold() == 'calculator' and row in self._alias_rows and 24 < column < 88
                and canonical_product(super().cell('CALCULATOR', row, 3)) is None):
            return self._geometry_engine.cell(sheet, row, column)
        if (sheet.casefold() == 'calculator' and column_name(column) in _DERIVED
                and self.model['schedule']['first_row'] <= row <= self.model['schedule']['last_row']
                and canonical_product(super().cell('CALCULATOR', row, 3)) is not None):
            values = self.promat_result(row)['cells']
            name = column_name(column)
            if name in values:
                return values[name]
        return super().cell(sheet, row, column)

    def promat_result(self, row):
        if row in self._promat_rows:
            return self._promat_rows[row]
        def raw(column):
            return self._geometry_engine.value('CALCULATOR', f'{column}{row}')
        product, member, sides = canonical_product(raw('C')), raw('I'), raw('G')
        geometry = {name: raw(name) for name in ('BG', 'BB', 'BL', 'BM', 'BN')}
        depth, width, area = (geometry[name] for name in ('BL', 'BM', 'BN'))
        layout, detail = raw('M') or 'Standard', raw('Q') or 'Standard box'
        preference = raw('O') or 'Auto'
        temperature = raw('J')
        if temperature in (None, ''):
            temperature = self._geometry_engine.value('SETTINGS', 'B13' if member == 'Column' else 'B14')
        inside = boxed_girth(depth, width, sides, rotated=layout == 'Rotate')
        # Circular steel's heated perimeter differs from the flat-board cutting
        # perimeter. Neither value is substituted for the physical-profile total.
        heated = math.pi * depth / 1000 if geometry['BG'] == 'CHS' and sides == 4 and positive(depth) else inside
        factor = heated * 10000 / area if heated and positive(area) else None
        manual = raw('E')
        issue = ''
        if manual not in (None, ''):
            if raw('D') not in (None, '') or any(raw(name) not in (None, '') for name in ('R', 'S', 'T', 'U')):
                issue = 'Choose either Steel ID/custom geometry or manual ESA/m, not both.'
            density = self._geometry_engine.value('SETTINGS', 'B6')
            factor = manual * density / 1000 if positive(manual) and positive(density) else None
        if geometry['BB']:
            issue = 'Needs review: the retained steel geometry is flagged; verify its dimensions and section area.'
        if layout not in ('Standard', 'Rotate') or detail != 'Standard box' or raw('V') not in (None, ''):
            issue = 'Needs review: this assessment selection covers standard rectangular box details only.'
        if geometry['BG'] == 'CHS' and sides != 4:
            issue = 'Needs review: circular-section geometry is verified for four-sided exposure only.'
        if not inside or not positive(area):
            issue = issue or 'Needs review: enter verified depth, width and section area/mass for boxed board quantities.'
        if raw('K') not in (None, '', geometry['BG']):
            issue = 'Family does not match the retained Steel ID geometry.'
        if not positive(factor):
            factor = None
        missing = self.required_missing_by_row.get(row, ())
        if missing:
            selection = {'required_mm': None, 'layers_mm': (), 'source': '',
                         'error': 'Review required: complete ' + ', '.join(missing) + '.',
                         'factor': factor, 'factor_used': None, 'period_used': None,
                         'temperature_used': None}
        else:
            selection = lookup_thickness(product, member, sides, temperature, factor, raw('H'), preference)
        if issue and not missing:
            selection.update(error=issue, layers_mm=())
            if not (positive(manual) and issue.startswith('Needs review: enter verified depth')):
                # A numeric table cell is not an applicable requirement when
                # the input geometry, exposure or fixing detail is unverified.
                selection.update(required_mm=None, source='', factor_used=None,
                                 period_used=None, temperature_used=None)
        layers = selection['layers_mm']
        code = PRODUCTS[product]
        stack = '+'.join(f'{value:g}' for value in layers)
        key = f'{code}|{stack}' if stack else ''
        cells = dict(geometry, BO=heated or 0, BQ=factor or 0, AP=factor or 0,
                     AN=selection.get('period_used') or 0,
                     AO=0 if missing else selection.get('temperature_used') or temperature,
                     AJ=layers[0] if layers else 0, AK=layers[1] if len(layers) == 2 else 0,
                     AA=len(layers) if layers else '', AB=sum(layers) if layers else '',
                     Z=stack or 'NEEDS REVIEW', BV=key, CA=key, BW=_STOCK_ROWS.get(key, 0),
                     BR=selection['error'], AS='NEEDS REVIEW' if selection['error'] else 'ASSESSMENT TABLE RESULT – verify project design',
                     AT=selection['source'], AU='Retained section geometry; verify dimensions and section area.',
                     AW=stack, AX=selection.get('factor_used') or 0, BC=1,
                     AV='Add required soldiers, stiffeners, supports and joint cover strips separately. '
                        'Confirm the project fixing detail and critical temperature. '
                        'Stock selection is limited to the report’s single/double-layer construction; thicker board is the inner layer.')
        # Length/quantity is a purchasing requirement, independent from table DFT.
        if total_length(self, row) is None and not cells['BR']:
            cells['BR'] = 'Enter positive length and a positive whole quantity.'
        cells['AI'] = (f'No quantity: {cells["BR"]}' if cells['BR'] else
                       f'Calculated boxed cladding: {stack} mm; assessment requires {selection["required_mm"]} mm. '
                       'Add supports and closure boards separately; verify the project fixing detail.')
        if raw('J') in (None, ''):
            cells['AV'] = ((f'{temperature:g}°C is assumed; confirm it with the structural designer. '
                            if positive(temperature) else 'Critical temperature is missing or invalid; enter a verified value. ')
                           + cells['AV'])
        selection['cells'] = cells
        self._promat_rows[row] = selection
        return selection
