"""SC902 estimating model, separate from the immutable spray workbooks.

DFT comes exclusively from the reviewed assessment. Product settings affect
material quantities, never fire performance or the published table values.
"""

from functools import lru_cache
import math

from .excel_engine import WorkbookEngine, column_name, column_number


IDENTITY = 'steel_intumescent'
PRODUCT = 'Nullifire SC902'
REPORT_SHA256 = '3bf3499358d6f2e4b75a8ed1402995cba8f9f72142ee81e79ed22fc73e4a4344'
REPORT_FILENAME = 'FC18580-01-01-Nullifire-SC902-2020-REPORT-Final.pdf'
CASES = {'I/H beam - 3 sides': 'R3', 'I/H column - 4 sides': 'R4',
         'RHS/SHS column - 4 sides': 'RHS', 'CHS column - 4 sides': 'CHS'}
PERIODS = (15, 30, 45, 60, 75, 90, 105, 120)
TEMPERATURES = (350, 400, 450, 500, 520, 550, 580, 600, 620, 650, 700, 750)
SETTING_DEFAULTS = {'D6': PRODUCT, 'D8': 1.55, 'D9': 1.46, 'D10': 22.3, 'D11': 2.7, 'D12': .99,
                    'D14': .85, 'D15': 1.75, 'D16': 0, 'D17': 7850}


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def quotient(numerator, denominator):
    if not number(numerator) or not number(denominator) or denominator <= 0:
        return ''
    value = numerator / denominator
    return value if number(value) else ''


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
               ('SUMMARY', 17, 'I'), ('SETTINGS', 30, 'H')]}
    for sheet in sheets.values():
        sheet['cells']['A1'] = _literal('STEEL (INTUMESCENT) - ' + sheet['name'])
        sheet['merges'].append('A1:H1')
    intro = {
        4: 'NULLIFIRE SC902',
        5: 'Add one steel member or group of identical members per schedule row. Enter quantity and length per member, or a total coating-area override.',
        7: 'THICKNESS / DFT',
        8: 'DFT is dry film thickness in microns (µm), converted exactly from the millimetre tables in FC18580-01-01, 20 March 2024. Select the member case, engineer-specified critical temperature and fire period.',
        10: 'SECTION FACTOR',
        11: 'A/V and Hp/A have the same numerical units (m⁻¹) for the same heated perimeter. ESA/M (m²/t) is converted using steel density: A/V = ESA/M × density / 1000. Named sections use retained geometry as an estimate.',
        13: 'TABLE SELECTION',
        14: 'Use the next higher published A/V row and the next lower published temperature. Below the minimum A/V, the minimum row applies (report p8). Values above the maximum A/V or outside 350–750 °C are withheld. Fire periods must be listed.',
        16: 'RHS/SHS columns require reinforcing mesh. Hollow-section beams and cellular beams are outside these assessment tables. Red table cells remain applicable as stated on report p8.',
        17: 'SETTINGS controls quantity assumptions. SUMMARY pools kit quantities and applies waste once. Unresolved items withhold the complete order quantity.'}
    for row, text in intro.items():
        sheets['START']['cells'][f'A{row}'] = _literal(text)
        sheets['START']['merges'].append(f'A{row}:H{row}')
    headings = ['Item / mark', 'Product', 'Exposure / member case', 'Critical temp (°C)',
                'Input method', 'Section ID', 'A/V | Hp/A | ESA/M input', 'Fire period (min)',
                'Quantity', 'Length / member (m)', 'Girth override (m)', 'Area override (m²)',
                'Input A/V (m⁻¹)', 'Table A/V (m⁻¹)', 'DFT (µm)', 'Wet film (µm)',
                'Girth used (m)', 'Coating area (m²)', 'Mixed coating (L)', 'Net kits',
                'Whole kits incl. waste', 'Thickness status', 'Quantity status',
                'Thickness source', 'Basis / review note', 'Line', 'Location']
    choices = {'B': [PRODUCT], 'C': list(CASES), 'D': list(TEMPERATURES),
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
    setting_labels = {'D6': 'Product', 'D8': 'Part A specific gravity', 'D9': 'Mixed specific gravity', 'D10': 'Part A (kg / kit)',
                      'D11': 'Part B (kg / kit)', 'D12': 'Part B specific gravity', 'D14': 'Volume solids (%)',
                      'D15': 'Theoretical consumption (kg/m² at 1 mm DFT)',
                      'D16': 'Waste allowance (%)', 'D17': 'Steel density (kg/m³)'}
    fields['SETTINGS'] = []
    for address, value in SETTING_DEFAULTS.items():
        row = int(address[1:])
        sheets['SETTINGS']['cells'][address] = _literal(value, style=1 if address in ('D14', 'D16') else 0)
        sheets['SETTINGS']['cells'][f'A{row}'] = _literal(setting_labels[address])
        sheets['SETTINGS']['merges'].append(f'A{row}:C{row}')
        field = {'cell': address, 'label': setting_labels[address],
                 'type': 'select' if address == 'D6' else 'number', 'setting': True}
        if address == 'D6':
            validation = {'type': 'list', 'sqref': address, 'formula1': '"Nullifire SC902"',
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
    def __init__(self, source, inputs=None, formula_overrides=None, *, assessment):
        super().__init__(source, inputs, formula_overrides)
        self.assessment = assessment
        self._results = {}
        self._totals = None

    def _setting(self, address):
        return super().cell('SETTINGS', int(address[1:]), column_number(address[0]))

    def _geometry(self, member, case):
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
        if ((case == 'RHS' and family not in ('RHS', 'SHS')) or (case == 'CHS' and family != 'CHS')
                or (case in ('R3', 'R4') and family in ('RHS', 'SHS', 'CHS'))):
            return None, None, 'Steel family does not match the selected member case.'
        if family not in ('UB', 'UC', 'WB', 'WC', 'PFC', 'EA', 'UA', 'RHS', 'SHS', 'CHS', 'T', 'BT', 'CT'):
            return None, None, 'This steel family needs an assessed section factor.'
        side3 = case == 'R3'
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
        from .sc902_assessment import lookup
        values = {column_name(c): super(IntumescentEngine, self).cell('SCHEDULE', row, c)
                  for c in [*range(1, 13), 27]}
        out = dict.fromkeys('MNOPQRSTUVWXY', '')
        if not any(value not in (None, '') for value in values.values()):
            self._results[row] = out
            return out
        product = values['B'] or self._setting('D6')
        case = CASES.get(values['C'])
        method = values['E']
        factor, girth, basis = values['G'], None, ''
        error = ''
        if product != PRODUCT:
            error = 'Select Nullifire SC902.'
        elif not case:
            error = 'Select an assessed member case.'
        elif method == 'Section':
            factor, girth, basis = self._geometry(values['F'], case)
            if not number(factor) or factor <= 0:
                error = basis
        elif method == 'ESA/M':
            density = self._setting('D17')
            factor = factor * density / 1000 if number(factor) and number(density) and density > 0 else None
            basis = 'A/V = ESA/M × steel density / 1000.'
        elif method not in ('A/V', 'Hp/A'):
            error = 'Choose Section, A/V, Hp/A or ESA/M.'
        result = lookup(self.assessment, factor, values['D'], values['H'], case=case)
        if error:
            result = {**result, 'dft': None, 'status': 'CHECK INPUT', 'note': error}
        out.update(M=factor if number(factor) else '', N=result.get('factor', ''),
                   O=result.get('dft') if result.get('dft') is not None else '',
                   V=result['status'], X=result.get('source', ''),
                   Y=' '.join(v for v in (result.get('note', ''), basis) if v))
        solids = self._setting('D14')
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
        sg, consumption = self._setting('D9'), self._setting('D15')
        a, b, waste = self._setting('D10'), self._setting('D11'), self._setting('D16')
        valid_settings = (all(number(v) and v > 0 for v in (sg, consumption, a, b, solids))
                          and solids <= 1 and number(waste) and 0 <= waste <= 1)
        if not number(out['O']):
            out['W'] = 'DFT unavailable'
        elif invalid_override:
            out['W'] = 'Enter a positive girth / area override or clear it'
        elif not number(out['R']):
            out['W'] = 'Enter coating area or quantity, length and girth'
        elif not valid_settings:
            out['W'] = 'Check product quantity settings'
        else:
            mass = area * out['O'] / 1000 * consumption
            litres, kits = quotient(mass, sg), quotient(mass, a + b)
            if number(litres) and number(kits) and number(kits * (1 + waste)):
                out.update(S=litres, T=kits, U=math.ceil(kits * (1 + waste)), W='QUANTIFIED - estimate')
            else:
                out['W'] = 'Quantity exceeds the supported numeric range'
        self._results[row] = out
        return out

    def totals(self):
        if self._totals is None:
            from .schedule_rows import populated_schedule_rows
            rows = [self.row_result(row) for row in sorted(populated_schedule_rows(IDENTITY, self.inputs))]
            used = [row for row in rows if row['V']]
            complete = [row for row in used if str(row['W']).startswith('QUANTIFIED')]
            pending = len(used) - len(complete)
            def sum_column(key):
                value = sum(row[key] for row in complete if number(row[key]))
                return value if number(value) else ''
            net = sum_column('T')
            waste = self._setting('D16')
            order_kits = product(net, 1 + waste) if number(waste) and 0 <= waste <= 1 else ''
            whole = math.ceil(order_kits) if not pending and number(order_kits) else ''
            sg, a, b = self._setting('D9'), self._setting('D10'), self._setting('D11')
            pack = a + b if number(a) and a > 0 and number(b) and b > 0 else None
            litres = quotient(pack, sg)
            if not number(litres):
                whole = ''
            dry_litres = sum(row['R'] * row['O'] / 1000 for row in complete)
            order_litres = product(whole, litres)
            if not number(order_litres):
                whole = ''
            self._totals = {'area': sum_column('R'), 'litres': sum_column('S'), 'net': net,
                            'kg': product(sum_column('S'), sg),
                            'dry_litres': dry_litres if number(dry_litres) else '',
                            'whole': whole, 'pending': pending, 'kit_litres': litres,
                            'pack_kg': pack, 'order_litres': order_litres,
                            'part_a': product(whole, a), 'part_b': product(whole, b),
                            'status': 'INCOMPLETE - review schedule' if pending else 'No schedule items' if not used else
                                      'READY - estimating quantities' if number(whole) else 'QUANTITY RANGE - review settings'}
        return self._totals

    def cell(self, sheet, row, column):
        name = self.sheet_names.get(sheet.casefold(), sheet)
        col = column_name(column)
        if name == 'SCHEDULE':
            if 10 <= row <= 1009 and 13 <= column <= 25:
                return self.row_result(row)[col]
            if 10 <= row <= 1009 and col == 'Z':
                return row - 9
            if row == 5 and col in ('A', 'G', 'S'):
                return self.totals()[{'A': 'area', 'G': 'litres', 'S': 'pending'}[col]]
        if name == 'SETTINGS' and col == 'D' and 18 <= row <= 23:
            a, b, sg, consumption = (self._setting(c) for c in ('D10', 'D11', 'D9', 'D15'))
            pack = a + b if number(a) and a > 0 and number(b) and b > 0 else None
            part_a_sg, part_b_sg = self._setting('D8'), self._setting('D12')
            return {18: quotient(a, part_a_sg) if number(a) and a > 0 else '',
                    19: quotient(b, part_b_sg) if number(b) and b > 0 else '',
                    20: sg if number(sg) and sg > 0 else '', 21: pack or '',
                    22: quotient(pack, sg),
                    23: quotient(pack, consumption)}[row]
        if name == 'SUMMARY':
            total = self.totals()
            if row == 7 and 1 <= column <= 9:
                return [PRODUCT, total['area'], total['kg'], total['litres'], total['net'],
                        self._setting('D16'), total['whole'], total['order_litres'], total['status']][column - 1]
            if col == 'D' and 10 <= row <= 15:
                value = total[{10: 'part_a', 11: 'part_b', 12: 'pack_kg', 13: 'kit_litres',
                               14: 'dry_litres', 15: 'pending'}[row]]
                return '' if value is None else value
        return super().cell(sheet, row, column)
