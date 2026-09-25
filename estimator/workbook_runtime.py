"""Application schedule capacity layered over immutable workbook evidence.

The packaged catalog, its source hash, and the extraction specifications are
unchanged. Only this derived model expands the existing per-row rules and their
schedule-wide references. Existing input addresses keep their meanings.
"""

from copy import deepcopy
from functools import lru_cache
import re

from openpyxl.formula.translate import Translator

from .workbook_catalog import load_workbook_catalog, list_workbook_catalogs, range_addresses
from .calculator_defaults import default_calculator_inputs
from .ductwork_policy import apply_ductwork_choices


SCHEDULE_CAPACITY = 1000
APPLICATION_TITLES = {
    'steel_vermiculite': 'Steel (spray)',
    'steel_board': 'Steel (board)',
    'ductwork': 'Ductwork (spray/wrap)',
}
_STRINGS = re.compile(r'("(?:[^"]|"")*")')
_RANGE = re.compile(
    r"(?<![A-Za-z0-9_.])(?:(?P<sheet>'(?:[^']|'')+'|[A-Za-z_][A-Za-z_0-9.]*)!)?"
    r'(?P<first>\$?[A-Z]{1,3}\$?(?P<start>[1-9]\d*)):'
    r'(?P<lastcol>\$?[A-Z]{1,3})(?P<absolute>\$?)(?P<end>[1-9]\d*)'
    r'(?![A-Za-z0-9_.])')


def extend_schedule_references(formula, context_sheet, schedule_sheet, first_row, old_last, new_last):
    """Extend complete schedule ranges, never row-local or lookup ranges.

Quoted Excel strings are literal data. A sheet-qualified range is changed only
when it targets the schedule; an unqualified range uses its current worksheet.
The start-row guard prevents A208:X208 from becoming A208:X1008.
"""
    def replace(match):
        target = match['sheet']
        target = target[1:-1].replace("''", "'") if target and target.startswith("'") else target
        if ((target or context_sheet or '').casefold() != schedule_sheet.casefold()
                or int(match['start']) > first_row or int(match['end']) != old_last):
            return match[0]
        return match[0][:-len(match['end'])] + str(new_last)
    return ''.join(part if index % 2 else _RANGE.sub(replace, part)
                   for index, part in enumerate(_STRINGS.split(formula)))


def _extend_metadata(node, rewrite):
    """Keep derived OOXML-shaped metadata aligned with runtime table bounds."""
    attributes = node.get('attributes', {})
    for key in ('ref', 'sqref'):
        if key in attributes:
            attributes[key] = rewrite(attributes[key])
    if node.get('tag') in ('formula', 'formula1', 'formula2', 'calculatedColumnFormula', 'totalsRowFormula') and node.get('text'):
        node['text'] = rewrite(node['text'])
    for child in node.get('children', []):
        _extend_metadata(child, rewrite)


def _expand_schedule(model, new_last):
    schedule = model['schedule']
    name, first, old_last = schedule['sheet'], schedule['first_row'], schedule['last_row']
    source_sheet = next(sheet for sheet in model['sheets'] if sheet['name'] == name)
    for sheet in model['sheets']:
        def rewrite(value):
            return extend_schedule_references(value, sheet['name'], name, first, old_last, new_last)
        for cell in sheet['cells'].values():
            if 'formula' in cell:
                cell['formula'] = rewrite(cell['formula'])
        for validation in sheet['validations']:
            for key in ('sqref', 'formula1', 'formula2'):
                if isinstance(validation.get(key), str):
                    validation[key] = rewrite(validation[key])
        for node in sheet.get('metadata', []):
            _extend_metadata(node, rewrite)
        if sheet['name'] == name:
            for key in ('page_range', 'dimension'):
                sheet[key] = rewrite(sheet[key])
    for table in model['tables'].values():
        def rewrite(value):
            return extend_schedule_references(value, table['sheet'], name, first, old_last, new_last)
        table['ref'] = rewrite(table['ref'])
        _extend_metadata(table['metadata'], rewrite)
    for key, value in model['defined_names'].items():
        model['defined_names'][key] = extend_schedule_references(value, None, name, first, old_last, new_last)
    for record in model.get('defined_name_records', []):
        scope = record.get('attributes', {}).get('localSheetId')
        context = model['sheets'][int(scope)]['name'] if scope is not None else None
        record['formula'] = extend_schedule_references(record['formula'], context, name, first, old_last, new_last)
    model['input_ranges'][name] = [extend_schedule_references(value, name, name, first, old_last, new_last)
                                   for value in model['input_ranges'][name]]
    for field in schedule['columns']:
        for key in ('sqref', 'formula1', 'formula2'):
            validation = field.get('validation', {})
            if isinstance(validation.get(key), str):
                validation[key] = extend_schedule_references(validation[key], name, name, first, old_last, new_last)

    template = [(address.rstrip('0123456789'), cell) for address, cell in source_sheet['cells'].items()
                if int(re.search(r'\d+$', address)[0]) == old_last]
    translators = {column: Translator('=' + cell['formula'], origin=f'{column}{old_last}')
                   for column, cell in template if 'formula' in cell}
    editable_columns = {field['column'] for field in schedule['columns'] if field['editable']}
    for row in range(old_last + 1, new_last + 1):
        source_sheet['rows'][str(row)] = {**source_sheet['rows'].get(str(old_last), {}), 'r': str(row)}
        for column, original in template:
            cell = deepcopy(original)
            cell.pop('cached_value', None)
            cell.pop('source_value', None)
            if column in translators:
                cell['formula'] = translators[column].translate_formula(f'{column}{row}').lstrip('=')
            elif column in editable_columns:
                cell.pop('value', None)
            elif column == schedule.get('line_id_column'):
                cell['value'] = row - first + 1
            source_sheet['cells'][f'{column}{row}'] = cell
    schedule['last_row'] = new_last


def _add_spray_location(model):
    schedule = model['schedule']
    sheet = next(sheet for sheet in model['sheets'] if sheet['name'] == schedule['sheet'])
    # Z is the authoritative engine row link. AA is unused in the source and
    # adds descriptive text without shifting any existing input or formula.
    assert not any(address.startswith('AA') for address in sheet['cells'])
    sheet['cells']['AA9'] = {**deepcopy(sheet['cells']['A9']), 'value': 'Location'}
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        sheet['cells'][f'AA{row}'] = {'data_type': 'n', 'style': sheet['cells'][f'A{row}'].get('style', 0)}
    sheet['dimension'] = f"A1:AA{schedule['last_row']}"
    sheet['page_range'] = sheet['dimension']
    # Later column entries override the source-hidden Z helper in presentation.
    sheet['columns'] += [{'min': '26', 'max': '26', 'width': '8', 'hidden': '0'},
                         {'min': '27', 'max': '27', 'width': '24', 'hidden': '0'}]
    schedule['last_column'] = 'AA'
    schedule['location_column'] = 'AA'
    schedule['columns'] += [{'column': 'Z', 'label': 'Line', 'type': 'number', 'editable': False},
                            {'column': 'AA', 'label': 'Location', 'type': 'text', 'editable': True}]
    model['input_ranges']['SCHEDULE'].append(f"AA{schedule['first_row']}:AA{schedule['last_row']}")
    table = model['tables']['Tbl_10']
    table['ref'] = f"A9:AA{schedule['last_row']}"
    table['columns'].append({'id': 27, 'name': 'Location'})
    table['metadata']['attributes']['ref'] = table['ref']
    for node in table['metadata']['children']:
        if node['tag'] == 'autoFilter':
            node['attributes']['ref'] = table['ref']
        elif node['tag'] == 'tableColumns':
            node['attributes']['count'] = '27'
            node['children'].append({'tag': 'tableColumn', 'attributes': {'id': '27', 'name': 'Location'},
                                     'text': None, 'children': []})


def _add_ductwork_estimating_yields(model):
    """Keep report constants while adding editable bag-quantity assumptions.

    Calibrated yields and the injection multiplier retain their source formulas.
    Only the two uncalibrated yield branches use bag mass / estimating density.
    """
    sheet = next(item for item in model['sheets'] if item['name'] == 'PRODUCT SETTINGS')
    cells = sheet['cells']
    spray = default_calculator_inputs('steel_vermiculite')['SETTINGS']
    values = (
        (161, 'CAFCO estimating bag mass', spray['D36'], 'kg/bag',
         'Adjust to the delivered CAFCO bag; this does not change the report density.'),
        (162, 'CAFCO estimating density', spray['D38'], 'kg/m³',
         'Dry-material consumption assumption for uncalibrated bag quantities, not installed density.'),
        (163, 'MONOKOTE estimating bag mass', spray['D234'], 'kg/bag',
         'Adjust to the delivered MK-6 bag; published pack references remain above.'),
        (164, 'MONOKOTE estimating density', spray['D236'], 'kg/m³',
         'Dry-material consumption assumption for uncalibrated bag quantities, not installed density.'),
    )
    for row, label, value, unit, note in values:
        sheet['rows'][str(row)] = {**sheet['rows']['22'], 'r': str(row)}
        sheet['merges'].append(f'E{row}:H{row}')
        for column, source in (('A', 'A22'), ('B', 'B44'), ('C', 'C22'), ('D', 'D22'), ('E', 'E22')):
            cells[f'{column}{row}'] = deepcopy(cells[source])
            cells[f'{column}{row}'].pop('cached_value', None)
        for column, text in (('A', label), ('B', value), ('C', unit), ('D', 'Editable estimate'), ('E', note)):
            cells[f'{column}{row}']['value'] = text
        address = f'B{row}'
        field = next(item for item in model['fields']['PRODUCT SETTINGS'] if item['cell'] == 'B44')
        model['fields']['PRODUCT SETTINGS'].append({**deepcopy(field), 'cell': address, 'label': label,
                                                     'units': unit, 'notes': note,
                                                     'validation': {'type': 'decimal', 'operator': 'greaterThan',
                                                                    'sqref': address, 'formula1': '0'}})
    sheet['dimension'] = 'A1:Q164'
    sheet['page_range'] = sheet['dimension']
    model['setting_ranges']['PRODUCT SETTINGS'].append('B161:B164')
    replacements = {
        'B25': ('B23*(B24/1000)*(B22/1000)*(B21/B20)',
                'IF(AND(ISNUMBER(B161),B161>0,ISNUMBER(B162),B162>0),B161/B162,0)'),
        'B69': ('B66*B68',
                'IF(AND(ISNUMBER(B163),B163>0,ISNUMBER(B164),B164>0),B163/B164,0)'),
    }
    for address, (original, replacement) in replacements.items():
        formula = cells[address]['formula']
        if formula.count(original) != 1:
            raise ValueError(f'Unexpected ductwork yield formula at {address}.')
        cells[address]['formula'] = formula.replace(original, replacement)
        cells[address].pop('cached_value', None)


def _add_ductwork_fyrewrap_inputs(model):
    """Expose the selected wrap assumptions without changing the source package."""
    sheet = next(item for item in model['sheets'] if item['name'] == 'PRODUCT SETTINGS')
    settings = (
        ('B96', 'Blanket layer thickness', 'm', 'greaterThan',
         'Manual p.5 default is 38 mm per layer. Confirm the selected blanket detail before changing.'),
        ('B98', 'Roll length', 'm', 'greaterThan',
         'Manual p.21 default is 7.62 m. Enter the actual supplied roll length.'),
        ('B99', 'Required wrap overlap', 'm', 'greaterThanOrEqual',
         'Manual pp.10–13 default is 100 mm. Confirm the selected detail before changing.'),
        ('B111', 'Added waste / error allowance', 'fraction', 'greaterThanOrEqual',
         'Enter 0 for no added waste; 0.10 adds 10% to wrap area and derived rolls.'),
    )
    for address, label, unit, operator, note in settings:
        row = int(address[1:])
        sheet['cells'][f'D{row}']['value'] = 'Editable estimate'
        sheet['cells'][f'E{row}']['value'] = note
        validation = {'type': 'decimal', 'operator': operator, 'sqref': address, 'formula1': '0'}
        model['fields']['PRODUCT SETTINGS'].append({
            'cell': address, 'label': label, 'type': 'number', 'setting': True,
            'validation': validation, 'units': unit, 'notes': note,
        })
        sheet['validations'].append(validation)
        model['setting_ranges']['PRODUCT SETTINGS'].append(address)


def _add_monokote_z106(model):
    """Add a product-specific bag profile while reusing MK-6 technical rules.

    This changes only the application model. The packaged workbook and its
    source evidence remain byte-for-byte unchanged. ENGINE A is a technical
    lookup key; the visible CALCULATOR/SCHEDULE product inputs stay Z106.
    """
    product = 'MONOKOTE Z106'
    mk6 = 'MONOKOTE MK-6 HY'
    sheets = {sheet['name']: sheet for sheet in model['sheets']}
    settings, engine, bags = (sheets[name] for name in ('SETTINGS', 'ENGINE', 'BAGS'))

    # Product and quantity settings occupy the first free helper-table row.
    for column, formula in {
        'Q': 'IF(ISNUMBER(D561),D561,"")',
        'R': 'IF(ISNUMBER(D562),D562,"")',
        'S': 'IF(ISNUMBER(D563),D563,"")',
        'T': 'IF(ISNUMBER(D565),D565,"")',
        'U': 'IF(ISNUMBER(D564),D564,"")',
    }.items():
        settings['cells'][f'{column}11'] = {**deepcopy(settings['cells'][f'{column}10']), 'formula': formula}
        settings['cells'][f'{column}11'].pop('cached_value', None)
    settings['cells']['P11'] = {**deepcopy(settings['cells']['P10']), 'value': product}

    # A compact sixth settings section extends the application-only worksheet.
    rows = {559: 229, 560: 233, 561: 234, 562: 235, 563: 236,
            564: 237, 565: 238, 566: 239, 567: 240, 568: 243}
    source_merges = list(settings['merges'])
    for target, source in rows.items():
        settings['rows'][str(target)] = {**settings['rows'][str(source)], 'r': str(target)}
        for column in ('A', 'D', 'G'):
            old = settings['cells'].get(f'{column}{source}')
            if old:
                settings['cells'][f'{column}{target}'] = deepcopy(old)
                settings['cells'][f'{column}{target}'].pop('cached_value', None)
        # Row cells alone leave twelve narrow browser columns. Preserve the
        # source section's title, header and three-column value layout too.
        for merged in source_merges:
            match = re.fullmatch(r'([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)', merged)
            if match and int(match[2]) == source and int(match[4]) == source:
                settings['merges'].append(f'{match[1]}{target}:{match[3]}{target}')
    cells = settings['cells']
    cells['A559']['value'] = product
    for address in ('D561', 'D562', 'D563'):
        cells[address].pop('formula', None)
        cells[address].pop('value', None)
    # Older saved projects have no Z106 addresses. Runtime fallback supplies
    # the new product's defaults without modifying their saved input records.
    cells['D561']['value'] = 22.2
    cells['D563']['value'] = 325
    cells['D564']['value'] = 0
    cells['D565']['formula'] = ('IF(ISNUMBER(D562),IF(D562>0,D562,""),'
                                'IF(LEN(D562)>0,"",IF(AND(ISNUMBER(D561),D561>0,'
                                'ISNUMBER(D563),D563>0),D561/D563,"")))')
    cells['D566']['formula'] = 'IF(ISNUMBER(D565),"ESTIMATING YIELD SET","ENTER VERIFIED YIELD")'
    cells['D567']['value'] = ('Z106 uses the MK-6 HY technical tables. Bag mass and estimating '
                             'density are Z106-specific estimating inputs; verify site yield. '
                             'Estimating density is not installed dry density.')
    cells['D568']['value'] = ('MK-6 HY thickness and fire-resistance lookups are shared; '
                             'Z106 bag quantities use its own settings.')
    settings['dimension'] = 'A1:BM568'
    settings['page_range'] = settings['dimension']
    model['setting_ranges']['SETTINGS'].append('D561:D564')
    for source, target in ((234, 561), (235, 562), (236, 563), (237, 564)):
        field = next(field for field in model['fields']['SETTINGS'] if field['cell'] == f'D{source}')
        model['fields']['SETTINGS'].append({**deepcopy(field), 'cell': f'D{target}', 'validation': None})

    # Extend only the five-product bag lookups. All thickness tables continue
    # to see MK-6 through the technical key in ENGINE A.
    model['defined_names']['ProductList'] = 'SETTINGS!$P$6:$P$11'
    for record in model.get('defined_name_records', []):
        if record.get('attributes', {}).get('name') == 'ProductList':
            record['formula'] = model['defined_names']['ProductList']
    for sheet in model['sheets']:
        for cell in sheet['cells'].values():
            if 'formula' in cell:
                for column in 'PRSTU':
                    cell['formula'] = cell['formula'].replace(f'${column}$6:${column}$10',
                                                              f'${column}$6:${column}$11')
    for row in range(2, model['schedule']['last_row'] - model['schedule']['first_row'] + 4):
        address = f'A{row}'
        cell = engine['cells'].get(address)
        if cell and 'formula' in cell:
            original = cell['formula']
            cell['formula'] = f'IF({original}="{product}","{mk6}",{original})'
            cell.pop('cached_value', None)
        # Technical A is intentionally aliased, but bag product lookup must
        # read the actual user choice from the quick form or schedule row.
        actual_product = ('CALCULATOR!D6' if row == 2 else
                          f'INDEX(SCHEDULE!$B$10:$B$1009,MATCH({row - 2},SCHEDULE!$Z$10:$Z$1009,0))')
        engine['cells'][f'AG{row}']['formula'] = (
            f'IF(A{row}="","",IFERROR(IFERROR(MATCH({actual_product},'
            'SETTINGS!$P$6:$P$11,0),0),""))')
        engine['cells'][f'AG{row}'].pop('cached_value', None)

    # The pooled product order summary gets a separate Z106 line.
    for column in 'ABCDEFGHI':
        original = bags['cells'][f'{column}24']
        cell = deepcopy(original)
        if 'formula' in cell:
            cell['formula'] = Translator('=' + cell['formula'], origin=f'{column}24').translate_formula(
                f'{column}25').lstrip('=')
            cell.pop('cached_value', None)
        elif column == 'A':
            cell['value'] = product
        bags['cells'][f'{column}25'] = cell
    bags['rows']['25'] = {**bags['rows']['24'], 'r': '25'}


@lru_cache(maxsize=3)
def _application_catalog(calculator_id):
    """Private, shared model; consumers must treat it as immutable."""
    model = load_workbook_catalog(calculator_id)
    schedule = model['schedule']
    original_last = schedule['last_row']
    target_last = schedule['first_row'] + SCHEDULE_CAPACITY - 1
    if target_last != original_last:
        _expand_schedule(model, target_last)
    model['title'] = APPLICATION_TITLES[calculator_id]
    model['application'] = {'schedule_capacity': SCHEDULE_CAPACITY,
                            'source_schedule_last_row': original_last,
                            'source_schedule_capacity': original_last - schedule['first_row'] + 1}
    if calculator_id == 'steel_vermiculite':
        _add_spray_location(model)
        _add_monokote_z106(model)
    elif calculator_id == 'steel_board':
        schedule['line_numbers'] = True
        schedule['location_column'] = 'B'
    elif calculator_id == 'ductwork':
        apply_ductwork_choices(model)
        _add_ductwork_estimating_yields(model)
        _add_ductwork_fyrewrap_inputs(model)
    return model


def load_application_catalog(calculator_id):
    """Return caller-owned runtime data; raw workbook loaders remain unchanged."""
    return deepcopy(_application_catalog(calculator_id))


def list_application_catalogs():
    raw = {entry['id']: entry for entry in list_workbook_catalogs()}
    return [{**raw[identity], 'title': title, 'schedule_capacity': SCHEDULE_CAPACITY}
            for identity, title in APPLICATION_TITLES.items()]


@lru_cache(maxsize=32)
def application_editable_cells(calculator_id, sheet):
    model = _application_catalog(calculator_id)
    references = model['input_ranges'].get(sheet, []) + model['setting_ranges'].get(sheet, [])
    return frozenset(address for reference in references for address in range_addresses(reference))
