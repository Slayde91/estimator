"""Intumescent estimating model, separate from immutable spray workbooks.

DFT comes exclusively from the reviewed assessment. Product settings affect
material quantities, never fire performance or the published table values.
"""

from functools import lru_cache
import math

from .excel_engine import FormulaError, WorkbookEngine, column_name, column_number


IDENTITY = 'steel_intumescent'
PRODUCT = 'Nullifire SC902'
FX5090 = 'FIRETEX FX5090'
FX6010 = 'FIRETEX FX6010'
PRODUCTS = (PRODUCT, FX5090, FX6010)
REPORT_SHA256 = '3bf3499358d6f2e4b75a8ed1402995cba8f9f72142ee81e79ed22fc73e4a4344'
REPORT_FILENAME = 'FC18580-01-01-Nullifire-SC902-2020-REPORT-Final.pdf'
CASES = {'I/H beam - 3 sides': 'R3', 'I/H beam/column - 4 sides': 'R4',
         'RHS/SHS column - 4 sides': 'RHS', 'CHS column - 4 sides': 'CHS',
         'I/H column - 4 sides': 'R4C', 'I/H beam - 4 sides': 'R4B',
         'RHS/SHS beam - 3 sides': 'H3', 'RHS/SHS beam - 4 sides': 'H4B'}
PERIODS = (15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180)
TEMPERATURES = (350, 400, 450, 500, 520, 550, 580, 600, 620, 650, 700, 750)
SC902_SETTING_DEFAULTS = {'D6': PRODUCT, 'D8': 1.55, 'D9': 1.46, 'D10': 22.3, 'D11': 2.7, 'D12': .99,
                         'D14': .85, 'D15': 1.75, 'D16': 0, 'D17': 7850}
# Addresses are persistent project inputs. Browsing a settings panel never
# copies values between products or changes the saved default-row product D6.
SETTING_DEFAULTS = {**SC902_SETTING_DEFAULTS,
                    'F36': 1.39, 'F37': 18, 'F38': .69, 'F39': 0, 'F40': 7850,
                    'H66': None, 'H67': None, 'H68': None, 'H69': 0, 'H70': 7850,
                    'H71': 'Pack volume (L)', 'H72': None, 'H73': None, 'H74': None}
# Freeze the model fallbacks above: omitted settings in an older saved project
# must retain their previous blank assumptions. Only a new/reset estimate or
# explicit product-only apply action receives these current kit defaults.
FX6010_KIT_DEFAULTS = {'H66': None, 'H67': 18, 'H68': .92, 'H71': 'Pack volume (L)',
                      'H72': None, 'H73': None, 'H74': None}
SETTINGS_BLOCKS = (
    {'product': PRODUCT, 'id': 'A4', 'title_address': 'A4', 'ranges': ['A4:D30'], 'display_columns': [1, 2, 3, 4]},
    {'product': FX5090, 'id': 'A34', 'title_address': 'A34', 'ranges': ['A34:F57'], 'display_columns': [1, 2, 3, 4, 5, 6]},
    {'product': FX6010, 'id': 'A64', 'title_address': 'A64', 'ranges': ['A64:H93'], 'display_columns': list(range(1, 9))})
_QUANTITY_SETTINGS = {
    PRODUCT: {'density': 'D9', 'solids': 'D14', 'waste': 'D16', 'steel_density': 'D17'},
    FX5090: {'density': 'F36', 'pack_litres': 'F37', 'solids': 'F38', 'waste': 'F39', 'steel_density': 'F40'},
    FX6010: {'density': 'H66', 'pack_litres': 'H67', 'solids': 'H68', 'waste': 'H69', 'steel_density': 'H70'}}


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def quotient(numerator, denominator):
    if not number(numerator) or not number(denominator) or denominator <= 0:
        return ''
    value = numerator / denominator
    return value if number(value) and (numerator == 0 or value != 0) else ''


def product(*values):
    result = 1
    for value in values:
        if not number(value):
            return ''
        result *= value
        if not number(result):
            return ''
    return result


def _literal(value, *, style=0):
    return {'value': value, 'data_type': 'n' if number(value) else 's', 'style': style}


def _sheet(name, last_row, last_column):
    return {'name': name, 'state': 'visible', 'page_range': f'A1:{last_column}{last_row}',
            'dimension': f'A1:{last_column}{last_row}', 'cells': {}, 'rows': {},
            'columns': [{'min': 1, 'max': column_number(last_column), 'width': 22}],
            'merges': [], 'validations': [], 'metadata': []}


@lru_cache(maxsize=1)
def model():
    """Return the private application model; callers must not mutate it."""
    sheets = {name: _sheet(name, last, column) for name, last, column in
              [('START', 17, 'H'), ('SCHEDULE', 1009, 'AA'),
               ('SUMMARY', 53, 'I'), ('SETTINGS', 93, 'H')]}
    for sheet in sheets.values():
        sheet['cells']['A1'] = _literal('STEEL (INTUMESCENT) - ' + sheet['name'])
        sheet['merges'].append('A1:H1')
    intro = {
        4: 'INTUMESCENT PRODUCTS',
        5: 'Add one steel member or group of identical members per schedule row. Enter quantity and length per member, or a total coating-area override.',
        7: 'THICKNESS / DFT',
        8: 'DFT is dry film thickness in microns (µm). Select the product, member case, engineer-specified critical temperature and fire period. Each product uses its own assessment tables, scope and limits.',
        10: 'SECTION FACTOR',
        11: 'A/V and Hp/A have the same numerical units (m⁻¹) for the same heated perimeter. ESA/M (m²/t) is converted using steel density: A/V = ESA/M × density / 1000. Named sections use retained geometry as an estimate.',
        13: 'TABLE SELECTION',
        14: 'SC902 retains FC18580-01-01 and its page 8 selection rules. FIRETEX requires an exact published temperature for the selected table. Any next-higher factor selection is an estimating policy; there is no interpolation or extrapolation. Missing cells, scope limits and beam caps withhold DFT.',
        16: 'For FIRETEX, choose an explicit four-sided beam or column case. The older combined I/H beam/column case is for SC902. SC902 RHS/SHS columns require mesh; its hollow beams remain outside scope. Verify every product report and installation condition.',
        17: 'SETTINGS retains separate product assumptions. SUMMARY pools orders by product and applies each product waste allowance once. FX6010 uses a two-component Australian 18 L kit with 92% volume solids. Existing saved assumptions remain unchanged until edited or deliberately replaced.'}
    for row, text in intro.items():
        sheets['START']['cells'][f'A{row}'] = _literal(text)
        sheets['START']['merges'].append(f'A{row}:H{row}')
    headings = ['Item / mark', 'Product', 'Exposure / member case', 'Critical temp (°C)',
                'Input method', 'Section ID', 'A/V | Hp/A | ESA/M input', 'Fire period (min)',
                'Quantity', 'Length / member (m)', 'Girth override (m)', 'Area override (m²)',
                'Input A/V (m⁻¹)', 'Table A/V (m⁻¹)', 'DFT (µm)', 'Wet film (µm)',
                'Girth used (m)', 'Coating area (m²)', 'Coating volume (L)', 'Net packs',
                'Whole packs incl. waste', 'Thickness status', 'Quantity status',
                'Thickness source', 'Basis / review note', 'Line', 'Location']
    choices = {'B': list(PRODUCTS), 'C': list(CASES), 'D': list(TEMPERATURES),
               'E': ['Section', 'A/V', 'Hp/A', 'ESA/M'], 'H': list(PERIODS)}
    # Reuse only the existing canonical member list, never its product tables.
    from .workbook_runtime import _application_catalog
    spray = _application_catalog('steel_vermiculite')
    reference = next(s for s in spray['sheets'] if s['name'] == 'SETTINGS')['cells']
    choices['F'] = [reference[f'BM{r}']['value'] for r in range(6, 559)
                    if reference.get(f'BM{r}', {}).get('value')]
    fields, defined_names = {}, {}
    for index, (column, options) in enumerate(choices.items(), 10):
        list_column = column_name(index)
        for row, value in enumerate(options, 1):
            sheets['START']['cells'][f'{list_column}{row}'] = _literal(value)
        defined_names[f'{column}Choices'] = f'START!${list_column}$1:${list_column}${len(options)}'
    schedule_fields = []
    for index, label in enumerate(headings, 1):
        col = column_name(index)
        sheets['SCHEDULE']['cells'][f'{col}9'] = _literal(label)
        editable = index <= 12 or col == 'AA'
        kind = 'select' if col in choices else 'number' if col in 'GIJKL' else 'text'
        field = {'column': col, 'label': label, 'type': kind, 'editable': editable}
        if col in choices:
            validation = {'type': 'list', 'sqref': f'{col}10:{col}1009',
                          'formula1': f'{col}Choices', 'allowBlank': '1',
                          'showErrorMessage': '1', 'errorStyle': 'warning' if col == 'D' else 'stop'}
            field['validation'] = validation
            sheets['SCHEDULE']['validations'].append(validation)
        schedule_fields.append(field)
        if not editable:
            for row in range(10, 1010):
                sheets['SCHEDULE']['cells'][f'{col}{row}'] = {'formula': '""', 'style': 0}
    for address, text in {'A4': 'COATING AREA (m²)', 'G4': 'MIXED COATING (L)', 'S4': 'UNRESOLVED ITEMS'}.items():
        sheets['SCHEDULE']['cells'][address] = _literal(text)
    for address in ('A5', 'G5', 'S5'):
        sheets['SCHEDULE']['cells'][address] = {'formula': '""', 'style': 0}
    setting_labels = {'D6': 'Default product for blank schedule rows', 'D8': 'Part A specific gravity', 'D9': 'Mixed specific gravity', 'D10': 'Part A (kg / kit)',
                      'D11': 'Part B (kg / kit)', 'D12': 'Part B specific gravity', 'D14': 'Volume solids (%)',
                      'D15': 'Theoretical consumption (kg/m² at 1 mm DFT)',
                      'D16': 'Waste allowance (%)', 'D17': 'Steel density (kg/m³)'}
    fields['SETTINGS'] = []
    sheets['SETTINGS']['cells']['A4'] = _literal(PRODUCT)
    sheets['SETTINGS']['merges'].append('A4:D4')
    for address, value in SC902_SETTING_DEFAULTS.items():
        row = int(address[1:])
        sheets['SETTINGS']['cells'][address] = _literal(value, style=1 if address in ('D14', 'D16') else 0)
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(setting_labels[address])
        sheets['SETTINGS']['merges'].append(f'A{row}:C{row}')
        field = {'cell': address, 'label': setting_labels[address],
                 'type': 'select' if address == 'D6' else 'number', 'setting': True}
        if address == 'D6':
            validation = {'type': 'list', 'sqref': address, 'formula1': 'BChoices',
                          'showErrorMessage': '1', 'errorStyle': 'stop'}
            field['validation'] = validation
            sheets['SETTINGS']['validations'].append(validation)
        fields['SETTINGS'].append(field)
    for row, label in [(18, 'Part A volume (L)'), (19, 'Part B volume (L)'),
                       (20, 'Mixed density (kg/L)'), (21, 'Total mixed kit (kg)'),
                       (22, 'Mixed kit volume (L)'), (23, 'Theoretical kit coverage (m² at 1 mm DFT)')]:
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(label)
        sheets['SETTINGS']['merges'].append(f'A{row}:C{row}')
        sheets['SETTINGS']['cells'][f'D{row}'] = {'formula': '""', 'style': 0}
    for row, text in [(26, 'Published starting values: Tremco SC902 Product Data Sheet V002-070826. Mixed specific gravity 1.46 ±0.02; volume solids 85% ±3%; 22.3 kg Part A + 2.7 kg Part B; consumption 1.750 kg/m² at 1 mm DFT.'),
                       (28, 'Editable values are estimating assumptions. Pack quantities, specific gravity and consumption determine litres and kits; they do not alter assessed DFT. Waste starts at 0% and is applied once to the pooled product order.'),
                       (30, 'Wet film = DFT / volume-solids fraction. Required kg = area × DFT(mm) × consumption. Required mixed litres = kg / mixed density. Confirm delivered pack and application losses.')]:
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(text)
        sheets['SETTINGS']['merges'].append(f'A{row}:H{row}')
    # Keep the legacy SC902 settings rectangle intact and append independent
    # persisted FIRETEX values. Source references are display-only literals.
    new_labels = {'F36': 'Transport-weight density estimate (kg/L)', 'F37': 'Pail volume (L)',
                  'F38': 'Volume solids (%)', 'F39': 'Waste allowance (%)', 'F40': 'Steel density (kg/m³)',
                  'H66': 'Verified mixed density (kg/L)', 'H67': 'Verified mixed pack volume (L)',
                  'H68': 'Verified volume solids (%)', 'H69': 'Waste allowance (%)', 'H70': 'Steel density (kg/m³)',
                  'H71': 'Verified pack quantity basis', 'H72': 'Verified Part A (kg / pack)',
                  'H73': 'Verified Part B (kg / pack)', 'H74': 'Legacy Part C (kg) - clear for current kit'}
    for address, label in new_labels.items():
        row, col = int(address[1:]), address[0]
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(label)
        sheets['SETTINGS']['merges'].append(f'A{row}:{column_name(column_number(col)-1)}{row}')
        sheets['SETTINGS']['cells'][address] = _literal(SETTING_DEFAULTS[address], style=1 if address in ('F38','F39','H68','H69') else 0)
        field = {'cell': address, 'label': label, 'type': 'select' if address == 'H71' else 'number', 'setting': True}
        if address == 'H71':
            validation = {'type': 'list', 'sqref': address, 'formula1': '"Pack volume (L),Component mass (kg)"',
                          'showErrorMessage': '1', 'errorStyle': 'stop'}
            field['validation'] = validation
            sheets['SETTINGS']['validations'].append(validation)
        fields['SETTINGS'].append(field)
    for row, text, last in [(34, FX5090, 'F'),
        (48, 'Starting estimates: Dulux FIRETEX FX5090 PC112, January 2026: one component, 69% volume solids, 18 L pail. The 1.39 kg/L transport weight is an estimating density, not an assessed DFT input.', 'F'),
        (52, 'Coating litres = area × DFT(mm) / volume-solids fraction. Pails are pooled before waste and rounded once. Confirm delivered pack, density and site losses.', 'F'),
        (64, FX6010, 'H'),
        (86, 'Dulux FIRETEX FX6010 PC115, March 2026: two components, 92% volume solids, 18 L mixed kit (17.75 L Part A + 0.25 L Part B). The supplied certificate\'s three-component wording is a typographical error. DFT remains separate from quantity assumptions.', 'H'),
        (90, 'Coating litres = area × DFT(mm) / volume-solids fraction. Pack-volume basis uses mixed kit litres. Component-mass basis requires verified Part A and B masses and mixed density. Exact component masses and mixed density remain blank until verified.', 'H'),
        (93, 'A retained nonzero Part C value holds material quantities for review. Use Australian kit defaults to clear it deliberately. Component orders are estimates; follow manufacturer instructions for complete-kit mixing and application losses.', 'H')]:
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(text)
        sheets['SETTINGS']['merges'].append(f'A{row}:{last}{row}')
    for address, label in {'F42':'Derived consumption (kg/m² at 1 mm DFT)', 'F43':'Pail mass estimate (kg)',
                            'F44':'Theoretical pail coverage (m² at 1 mm DFT)', 'H80':'Total verified Part A + B mass (kg)',
                            'H81':'Mixed pack volume used (L)', 'H82':'Theoretical pack coverage (m² at 1 mm DFT)'}.items():
        row, col = int(address[1:]), address[0]
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(label)
        sheets['SETTINGS']['merges'].append(f'A{row}:{column_name(column_number(col)-1)}{row}')
        sheets['SETTINGS']['cells'][address] = {'formula':'""','style':0}
    summary = sheets['SUMMARY']['cells']
    for index, label in enumerate(['Product', 'Coating area (m²)', 'Required mixed (kg)',
                                   'Required mixed (L)', 'Net kits', 'Waste (%)',
                                   'Whole kits', 'Order volume (L)', 'Status'], 1):
        summary[f'{column_name(index)}6'] = _literal(label)
        summary[f'{column_name(index)}7'] = {'formula': '""', 'style': 0}
    summary['F7']['style'] = 1
    for row, label in [(10, 'Part A to order (kg)'), (11, 'Part B to order (kg)'),
                       (12, 'Total kit mass (kg)'), (13, 'Mixed kit volume (L)'),
                       (14, 'Dry coating volume (L)'), (15, 'Unresolved schedule items')]:
        summary[f'A{row}'] = _literal(label)
        summary[f'D{row}'] = {'formula': '""', 'style': 0}
        sheets['SUMMARY']['merges'].append(f'A{row}:C{row}')
    summary['A17'] = _literal('Order kits are rounded up once per product after waste. Incomplete or unsupported items withhold the complete order; available quantities remain visible. Mesh, primers and topcoats are separate allowances.')
    sheets['SUMMARY']['merges'].append('A17:I17')
    # The original SC902 summary coordinates remain unchanged. New product
    # summaries are separate tables, so unlike pack types are never combined.
    for product_name, title_row, header_row, value_row, details_first, note_row in (
            (FX5090,20,21,22,25,32), (FX6010,35,36,37,40,49)):
        summary[f'A{title_row}'] = _literal(product_name)
        sheets['SUMMARY']['merges'].append(f'A{title_row}:I{title_row}')
        for index, label in enumerate(['Product','Coating area (m²)','Required coating (kg)',
                'Required coating (L)','Net packs','Waste (%)','Whole packs','Order volume (L)','Status'],1):
            summary[f'{column_name(index)}{header_row}'] = _literal(label)
            summary[f'{column_name(index)}{value_row}'] = {'formula':'""','style':1 if index==6 else 0}
        labels = ['Part A to order (kg)','Part B to order (kg)','Pack mass (kg)',
                  'Pack volume (L)','Dry coating volume (L)','Unresolved schedule items']
        for offset,label in enumerate(labels):
            row=details_first+offset
            summary[f'A{row}'] = _literal(label)
            summary[f'D{row}'] = {'formula':'""','style':0}
            sheets['SUMMARY']['merges'].append(f'A{row}:C{row}')
        summary[f'A{note_row}'] = _literal('Packs are pooled for this product only; waste and rounding apply once. Unresolved items withhold its complete order.')
        sheets['SUMMARY']['merges'].append(f'A{note_row}:I{note_row}')
    summary['A47'] = _literal('Legacy Part C - review in SETTINGS')
    summary['D47'] = {'formula':'""','style':0}
    sheets['SUMMARY']['merges'].append('A47:C47')
    return {'id': IDENTITY, 'title': 'Steel (intumescent)', 'schema_version': 1,
            'source': {'filename': REPORT_FILENAME, 'sha256': REPORT_SHA256, 'policy_version': 1},
            'pages': list(sheets), 'sheets': list(sheets.values()), 'fields': fields,
            'schedule': {'sheet': 'SCHEDULE', 'first_row': 10, 'last_row': 1009, 'header_row': 9,
                         'first_column': 'A', 'last_column': 'AA', 'input_last_column': 'L',
                         'line_id_column': 'Z', 'location_column': 'AA', 'columns': schedule_fields},
            'input_ranges': {'SCHEDULE': ['A10:L1009', 'AA10:AA1009']},
            'setting_ranges': {'SETTINGS': list(SETTING_DEFAULTS)}, 'defined_names': defined_names,
            'tables': {}, 'styles': {'cell_styles': [
                {'number_format': 'General', 'font': {'children': []}},
                {'number_format': '0.00%', 'font': {'children': []}}]},
            'application': {'schedule_capacity': 1000, 'source_schedule_capacity': 1000}}


class IntumescentEngine(WorkbookEngine):
    def __init__(self, source, inputs=None, formula_overrides=None, *, assessment, firetex_assessments=None):
        super().__init__(source, inputs, formula_overrides)
        self.assessment = assessment
        self.firetex_assessments = tuple(firetex_assessments or ())
        self._results = {}
        self._product_totals = None
        self._pending_total = None

    def _setting(self, address):
        return super().cell('SETTINGS', int(address[1:]), column_number(address[0]))

    def row_product(self, row):
        return super().cell('SCHEDULE', row, 2) or self._setting('D6')

    def product_assessment(self, product_name):
        if product_name == PRODUCT:
            return self.assessment
        if product_name in (FX5090, FX6010):
            index = (FX5090, FX6010).index(product_name)
            return self.firetex_assessments[index] if index < len(self.firetex_assessments) else None
        return None

    def _quantity_profile(self, product_name):
        profile = {key: self._setting(address) for key,address in _QUANTITY_SETTINGS[product_name].items()}
        if product_name == PRODUCT:
            a,b = self._setting('D10'),self._setting('D11')
            mass = a+b if all(number(v) and v>0 for v in (a,b)) else ''
            mass = mass if number(mass) else ''
            profile.update(pack_kg=mass,pack_litres=quotient(mass,profile['density']),
                           part_a=a,part_b=b,part_c='',consumption=self._setting('D15'))
        elif product_name == FX5090:
            profile.update(pack_kg=product(profile['pack_litres'],profile['density']),
                           part_a='',part_b='',part_c='')
        else:
            a,b = (self._setting(address) for address in ('H72','H73'))
            try:
                legacy_c = self._setting('H74')
            except FormulaError:
                # The public normalizer rejects nonfinite values. A retained
                # invalid C must still withhold quantities rather than DFT.
                legacy_c = 'invalid legacy value'
            mass = a+b if all(number(v) and v>0 for v in (a,b)) else ''
            mass = mass if number(mass) else ''
            basis = self._setting('H71')
            if basis == 'Component mass (kg)':
                profile['pack_litres'] = quotient(mass,profile['density'])
            elif basis != 'Pack volume (L)':
                profile['pack_litres'] = ''
            profile.update(pack_kg=mass,part_a=a,part_b=b,part_c='',basis=basis,
                           legacy_c=legacy_c,
                           legacy_c_clear=(legacy_c is None or type(legacy_c) is str and legacy_c == ''
                                           or number(legacy_c) and legacy_c == 0))
        return profile

    def _geometry(self, member, case, product_name=PRODUCT):
        from .workbook_runtime import _application_catalog
        raw = _application_catalog('steel_vermiculite')
        geometry = WorkbookEngine(raw)
        cells = next(s for s in raw['sheets'] if s['name'] == 'SECTIONS')['cells']
        found = [row for row in range(6, 561)
                 if str(cells.get(f'A{row}', {}).get('value', '')).casefold() == str(member).casefold()]
        if len(found) != 1:
            return None, None, 'Select a recognised canonical steel section.'
        row = found[0]
        identity = geometry.value('SECTIONS', f'AM{row}')
        if isinstance(identity, str) and 'EXCLUDED' in identity.upper():
            return None, None, 'The retained section identity is excluded; enter a verified A/V and area.'
        family = geometry.value('SECTIONS', f'B{row}')
        if ((case in ('RHS','H3','H4B') and family not in ('RHS','SHS')) or (case == 'CHS' and family != 'CHS')
                or (case in ('R3','R4','R4C','R4B') and family in ('RHS','SHS','CHS'))):
            return None, None, 'Steel family does not match the selected member case.'
        if family not in ('UB', 'UC', 'WB', 'WC', 'PFC', 'EA', 'UA', 'RHS', 'SHS', 'CHS', 'T', 'BT', 'CT'):
            return None, None, 'This steel family needs an assessed section factor.'
        if product_name != PRODUCT and case in ('R3', 'R4C', 'R4B') and family not in ('UB', 'UC', 'WB', 'WC'):
            return None, None, 'For FIRETEX this family needs a verified A/V and assessed member case.'
        side3 = case in ('R3','H3')
        hold = geometry.value('SECTIONS', f'{"BA" if side3 else "BB"}{row}')
        if ((number(hold) and hold > 0)
                or isinstance(hold, str) and hold and ('HOLD' in hold.upper() or 'REVIEW' in hold.upper())):
            return None, None, 'Retained section geometry needs review; enter a verified A/V and area.'
        factor = geometry.value('SECTIONS', f'{"X" if side3 else "Y"}{row}')
        girth = geometry.value('SECTIONS', f'{"E" if side3 else "F"}{row}')
        source = geometry.value('SECTIONS', f'G{row}')
        return factor, girth, f'Named-section geometry estimate: {source}. Verify actual member and exposed perimeter.'

    def row_result(self, row):
        if row in self._results:
            return self._results[row]
        values = {column_name(c): super(IntumescentEngine, self).cell('SCHEDULE', row, c)
                  for c in [*range(1, 13), 27]}
        out = dict.fromkeys('MNOPQRSTUVWXY', '')
        if not any(value not in (None, '') for value in values.values()):
            self._results[row] = out
            return out
        product_name = values['B'] or self._setting('D6')
        case = CASES.get(values['C'])
        method = values['E']
        factor, girth, basis = values['G'], None, ''
        error = ''
        if product_name not in PRODUCTS:
            error = 'Select a supported intumescent product.'
        elif not case:
            error = 'Select an assessed member case.'
        elif product_name != PRODUCT and case == 'R4':
            error = 'For FIRETEX, choose the separate four-sided beam or column case.'
        elif method == 'Section':
            factor, girth, basis = self._geometry(values['F'], case, product_name)
            if not number(factor) or factor <= 0:
                error = basis
        elif method == 'ESA/M':
            density = self._setting(_QUANTITY_SETTINGS[product_name]['steel_density'])
            factor = factor * density / 1000 if number(factor) and number(density) and density > 0 else None
            basis = 'A/V = ESA/M × steel density / 1000.'
        elif method not in ('A/V', 'Hp/A'):
            error = 'Choose Section, A/V, Hp/A or ESA/M.'
        if product_name == PRODUCT:
            from .sc902_assessment import lookup
            selected_case = 'R4' if case in ('R4C','R4B') else case
            result = lookup(self.assessment, factor, values['D'], values['H'], case=selected_case)
        elif product_name in (FX5090,FX6010):
            from .firetex_assessment import lookup
            selected_case = 'R4' if case == 'R4C' else 'H4' if case == 'RHS' else case
            assessment = self.product_assessment(product_name)
            result = (lookup(assessment,factor,values['D'],values['H'],case=selected_case) if assessment is not None else
                      {'dft':None,'status':'ASSESSMENT DATA UNAVAILABLE','note':'Reviewed FIRETEX data is not installed; DFT and quantities are withheld.'})
        else:
            result = {'dft':None,'status':'CHECK INPUT','note':error}
        if error:
            result = {'dft': None, 'status': 'CHECK INPUT', 'note': error}
        out.update(M=factor if number(factor) else '', N=result.get('factor', ''),
                   O=result.get('dft') if result.get('dft') is not None else '',
                   V=result['status'], X=result.get('source', ''),
                   Y=' '.join(v for v in (result.get('note', ''), basis) if v))
        profile = self._quantity_profile(product_name) if product_name in PRODUCTS else {}
        solids = profile.get('solids')
        if number(out['O']) and number(solids) and 0 < solids <= 1:
            out['P'] = quotient(out['O'], solids)
        invalid_override = any(values[col] not in (None, '') and
                               (not number(values[col]) or values[col] <= 0) for col in ('K', 'L'))
        if number(values['K']) and values['K'] > 0:
            girth = values['K']
        area = values['L']
        if not (number(area) and area > 0):
            qty, length = values['I'], values['J']
            area = (qty * length * girth if number(qty) and qty > 0 and qty == int(qty)
                    and number(length) and length > 0 and number(girth) and girth > 0 else None)
        out['Q'] = girth if number(girth) and girth > 0 else ''
        out['R'] = area if number(area) and area > 0 else ''
        sg,consumption,waste = profile.get('density'),profile.get('consumption'),profile.get('waste')
        valid_settings = (number(solids) and 0<solids<=1 and number(waste) and 0<=waste<=1)
        if product_name == PRODUCT:
            valid_settings = valid_settings and all(number(v) and v>0 for v in
                (sg,consumption,profile['part_a'],profile['part_b']))
        elif product_name in (FX5090,FX6010):
            valid_settings = valid_settings and number(profile['pack_litres']) and profile['pack_litres']>0
            optional = [sg] + ([profile[key] for key in ('part_a','part_b')] if product_name==FX6010 else [])
            valid_settings = valid_settings and all(v in (None,'') or number(v) and v>0 for v in optional)
        if not number(out['O']):
            out['W'] = 'DFT unavailable'
        elif product_name == FX6010 and not profile['legacy_c_clear']:
            out['W'] = ('Review legacy Part C: the current FX6010 kit has two components. '
                        'Clear Part C or use Australian kit defaults.')
        elif invalid_override:
            out['W'] = 'Enter a positive girth / area override or clear it'
        elif not number(out['R']):
            out['W'] = 'Enter coating area or quantity, length and girth'
        elif not valid_settings:
            out['W'] = ('Enter FX6010 kit volume and volume solids, or verified Part A/B masses and mixed density'
                        if product_name==FX6010 else 'Check product quantity settings')
        else:
            if product_name == PRODUCT:
                mass = area*out['O']/1000*consumption
                litres,kits = quotient(mass,sg),quotient(mass,profile['pack_kg'])
            else:
                litres = quotient(area*out['O']/1000,solids)
                kits = quotient(litres,profile['pack_litres'])
                mass = product(litres,sg) if number(sg) and sg>0 else None
            if ((mass is None or number(mass) and mass>0) and number(litres) and litres > 0
                    and number(kits) and kits > 0 and number(kits * (1 + waste))):
                out.update(S=litres, T=kits, U=math.ceil(kits * (1 + waste)), W='QUANTIFIED - estimate')
            else:
                out['W'] = 'Quantity exceeds the supported numeric range'
        self._results[row] = out
        return out

    def product_totals(self, product_name=None):
        if self._product_totals is None:
            from .schedule_rows import populated_schedule_rows
            rows = [(self.row_product(row),self.row_result(row))
                    for row in sorted(populated_schedule_rows(IDENTITY,self.inputs))]
            unassigned = sum(bool(row['V']) for name,row in rows if name not in PRODUCTS)
            self._pending_total = sum(bool(row['V']) and not str(row['W']).startswith('QUANTIFIED')
                                      for _,row in rows)
            self._product_totals = {name:self._pool(name,[row for row_product,row in rows if row_product==name],unassigned)
                                    for name in PRODUCTS}
        return self._product_totals if product_name is None else self._product_totals[product_name]

    def _pool(self, product_name, rows, unassigned):
        used = [row for row in rows if row['V']]
        complete = [row for row in used if str(row['W']).startswith('QUANTIFIED')]
        pending = len(used)-len(complete)+unassigned
        def sum_column(key):
            value = sum(row[key] for row in complete if number(row[key]))
            return value if number(value) else ''
        profile = self._quantity_profile(product_name)
        net,waste = sum_column('T'),profile['waste']
        order_kits = product(net,1+waste) if number(waste) and 0<=waste<=1 else ''
        whole = math.ceil(order_kits) if not pending and number(order_kits) else ''
        sg,a,b,c = (profile[key] for key in ('density','part_a','part_b','part_c'))
        pack,litres = profile['pack_kg'],profile['pack_litres']
        if not number(litres) or litres<=0:
            whole = ''
        dry_litres = sum(row['R']*row['O']/1000 for row in complete)
        order_litres = product(whole,litres)
        if not number(order_litres):
            whole = ''
        return {'product':product_name,'used':len(used),'area':sum_column('R'),'litres':sum_column('S'),
                'net':net,'kg':product(sum_column('S'),sg),'dry_litres':dry_litres if number(dry_litres) else '',
                'waste':waste,'whole':whole,'pending':pending,'kit_litres':litres,'pack_kg':pack,
                'order_litres':order_litres,'part_a':product(whole,a),'part_b':product(whole,b),'part_c':product(whole,c),
                'status':'INCOMPLETE - review schedule' if pending else 'No schedule items' if not used else
                         'READY - estimating quantities' if number(whole) else 'QUANTITY RANGE - review settings'}

    def totals(self):
        """Retain the original SC902-only API and summary coordinates."""
        return self.product_totals(PRODUCT)

    def cell(self, sheet, row, column):
        name = self.sheet_names.get(sheet.casefold(), sheet)
        col = column_name(column)
        if name == 'SCHEDULE':
            if 10 <= row <= 1009 and 13 <= column <= 25:
                return self.row_result(row)[col]
            if 10 <= row <= 1009 and col == 'Z':
                return row - 9
            if row == 5 and col in ('A', 'G', 'S'):
                pools = self.product_totals().values()
                if col == 'S':
                    return self._pending_total
                key = {'A': 'area', 'G': 'litres'}[col]
                value = sum(pool[key] for pool in pools if number(pool[key]))
                return value if number(value) else ''
        if name == 'SETTINGS' and col == 'D' and 18 <= row <= 23:
            a, b, sg, consumption = (self._setting(c) for c in ('D10', 'D11', 'D9', 'D15'))
            pack = a + b if number(a) and a > 0 and number(b) and b > 0 else None
            pack = pack if number(pack) else None
            part_a_sg, part_b_sg = self._setting('D8'), self._setting('D12')
            return {18: quotient(a, part_a_sg) if number(a) and a > 0 else '',
                    19: quotient(b, part_b_sg) if number(b) and b > 0 else '',
                    20: sg if number(sg) and sg > 0 else '', 21: pack or '',
                    22: quotient(pack, sg),
                    23: quotient(pack, consumption)}[row]
        if name == 'SETTINGS' and col == 'F' and row in (42,43,44):
            profile = self._quantity_profile(FX5090)
            return {42:quotient(profile['density'],profile['solids']),43:profile['pack_kg'],
                    44:product(profile['pack_litres'],profile['solids'])}[row]
        if name == 'SETTINGS' and col == 'H' and row in (80,81,82):
            profile = self._quantity_profile(FX6010)
            return {80:profile['pack_kg'],81:profile['pack_litres'],
                    82:product(profile['pack_litres'],profile['solids'])}[row]
        if name == 'SUMMARY':
            for product_name,value_row,first_detail in ((PRODUCT,7,10),(FX5090,22,25),(FX6010,37,40)):
                if row==value_row and 1<=column<=9:
                    total=self.product_totals(product_name)
                    return [product_name,total['area'],total['kg'],total['litres'],total['net'],
                            total['waste'],total['whole'],total['order_litres'],total['status']][column-1]
                if col=='D' and first_detail<=row<=first_detail+5:
                    key=('part_a','part_b','pack_kg','kit_litres','dry_litres','pending')[row-first_detail]
                    value=self.product_totals(product_name)[key]
                    return '' if value is None else value
            if col=='D' and row==47:
                return self.product_totals(FX6010)['part_c']
        return super().cell(sheet, row, column)
