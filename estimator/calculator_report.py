"""Full calculator schedule PDFs from one immutable input snapshot.

The projection selects original output cells; it never derives thicknesses,
rerounds purchasing quantities, changes source data, or saves calculator state.
Only explicitly named display totals sum already-calculated numeric outputs.
"""

from copy import deepcopy
from decimal import Decimal, ROUND_HALF_UP, localcontext
from io import BytesIO
import re

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.platypus import KeepTogether, PageBreak, SimpleDocTemplate, Spacer

from .excel_engine import WorkbookEngine, column_name
from .report import ROOT, _Report, _register_fonts, _number, _numeric, _text, _RED, _LINE, _MUTED
from .workbook_calculators import source_model, normalize_calculator_inputs, approved_formula_overrides


_WIDTH, _HEIGHT = landscape(A4)
_MARGIN = 32
_CONTENT = _WIDTH - 2 * _MARGIN
_OUTPUT_LAST = {'ductwork': 43, 'steel_vermiculite': 25, 'steel_board': 48}
_INPUT_LAST = {'ductwork': 9, 'steel_vermiculite': 12, 'steel_board': 24}
_BOARD_DIRECTIONS = (
    ('Family (K)', 'Family (ESA input)'), ('Clear K to use', 'Clear Family (ESA input) to use'),
    ('Thickness lookup (P)', 'Thickness lookup'),
    ('An exposed depth is entered in N.', 'An exposed depth is entered in Partial depth.'),
    ('Exposure layout (M)', 'Exposure layout'), ('or clear N.', 'or clear Partial depth.'),
    ('inside-box girth in V', 'inside-box girth in Box girth override'),
    ('board product in C', 'board product in Product'), ('Steel ID (D) or ESA/M (E)', 'Steel ID or ESA/M input'),
    ('exposed sides in G', 'exposed sides in Sides'), ('period in H, in minutes', 'period in FRL required, in minutes'),
    ('Beam or Column in I', 'Beam or Column in the member-type input'), ('temperature in J', 'temperature in Critical temp'),
    ('Check E and R:V', 'Check ESA/M input and dimension, area, mass and box-girth overrides'),
    ('Layer preference (O)', 'Layer preference'), ('Exposure layout in M', 'Exposure layout'),
    ('a depth in N', 'a Partial depth'), ('ESA/M in E', 'ESA/M input'),
    ('Installation detail in Q', 'Installation detail'), ('steel depth in R', 'steel depth in Depth or OD'),
    ('Auto or Double in O', 'Auto or Double in Layer preference'), ('Added girth (W)', 'Added girth'),
    ('a total length greater than zero in F, in metres', 'Lineal metres greater than zero'),
    ('depth/width (R/S) or inside-box girth (V)', 'depth/width or Box girth override'),
    ('depth/width in R/S', 'Depth or OD and Width B'),
    ('Check L, or the default on SETTINGS when L is blank.', 'Check Waste (%), or Default wastage on SETTINGS when Waste (%) is blank.'),
    ('Check V is the INSIDE box girth', 'Check Box girth override is the INSIDE box girth'),
    ('library X:Z', 'the retained geometry source records'), ('STEEL LIBRARY X:Z', 'the retained geometry source records'),
)


def _source_text(identity, sheet, address, value):
    """Replace only known workbook directions, never user text or identifiers."""
    if not isinstance(value, str):
        return value
    replacements = ()
    column = re.sub(r'\d+', '', address)
    if identity == 'steel_board' and sheet == 'CALCULATOR' and column in ('AI', 'AR', 'AS', 'AU', 'AV'):
        replacements = _BOARD_DIRECTIONS
    if identity == 'steel_board' and sheet == 'BOARD SUMMARY':
        replacements = (('CALCULATOR column AI', 'schedule Row status'),
                        ('CALCULATOR column AD', 'the schedule Box reference area'),
                        ('on hidden EXTRA BOARDS', 'in EXTRA BOARDS'),
                        ('unhide EXTRA BOARDS', 'review EXTRA BOARDS'))
    if identity == 'ductwork' and sheet == 'SUMMARY' and address in ('F31', 'F32'):
        replacements = (('0.600 m³', '0.60 m³'), ('0.610 m³', '0.61 m³'))
    if identity == 'ductwork' and sheet == 'CALCULATOR' and column in ('AL', 'AM', 'AP'):
        replacements = (
            ('Use the pin and mesh details in the header comment.', 'Refer to the product report for pin and mesh details.'),
            ('See the header comment for steel and stress limits.', 'Refer to the product report for steel and stress limits.'),
            ('See the header comment.', 'Refer to the product installation documentation.'),
            ('See the comments on the angle settings.', 'Refer to the product report for the different top and underside angle details.'),
        )
    for old, new in replacements:
        value = value.replace(old, new)
    return value


def _has_value(value):
    return value is not None and value != ''


def _sum_values(values):
    # Excel SUM ignores unavailable text. Labels explicitly describe these as
    # available totals; source product-order error/status text is kept intact.
    return sum(value for value in values if _numeric(value))


def project_calculator_report(calculator_id, inputs=None):
    """Prepare testable raw report data without display rounding or persistence."""
    model = source_model(calculator_id)
    normalized = normalize_calculator_inputs(calculator_id, inputs)
    engine = WorkbookEngine(model, normalized, approved_formula_overrides(calculator_id))
    sheets = {sheet['name']: sheet for sheet in model['sheets']}
    schedule = model['schedule']
    sheet_name = schedule['sheet']
    sheet = sheets[sheet_name]
    input_columns = [field['column'] for field in schedule['columns'] if field['editable']]
    labels = {column_name(column): sheet['cells'].get(column_name(column) + str(schedule['header_row']), {}).get('value', '')
              for column in range(1, _OUTPUT_LAST[calculator_id] + 1)}
    rows = []
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        supplied = {column: engine.value(sheet_name, column + str(row)) for column in input_columns}
        if not any(_has_value(value) for value in supplied.values()):
            continue
        values = {column_name(column): engine.value(sheet_name, column_name(column) + str(row))
                  for column in range(1, _OUTPUT_LAST[calculator_id] + 1)}
        record = {'row': row, 'line': row - schedule['first_row'] + 1, 'values': values,
                  'input_columns': input_columns, 'labels': labels}
        if calculator_id == 'ductwork':
            record['product_code'] = engine.value(sheet_name, f'BD{row}')
            record['wrap'] = record['product_code'] == 3
            record['wrap_layer_mm'] = engine.value('PRODUCT SETTINGS', 'B96') * 1000 if record['wrap'] else None
            record['complete'] = _numeric(values['N'] if record['wrap'] else values['M'])
        elif calculator_id == 'steel_vermiculite':
            record['complete'] = isinstance(values['W'], str) and values['W'].startswith('QUANTIFIED')
        else:
            record['complete'] = values['AR'] == 'CLADDING ESTIMATE'
        rows.append(record)

    def table(title, name, header, first, last, columns, *, note=''):
        source = sheets[name]
        return {'title': title, 'sheet': name, 'columns': list(columns), 'note': note,
                'labels': {column: source['cells'].get(column + str(header), {}).get('value', column) for column in columns},
                'rows': [{'row': row, 'values': {column: engine.value(name, column + str(row)) for column in columns}}
                         for row in range(first, last + 1)]}

    data = {'id': calculator_id, 'title': model['title'], 'source': deepcopy(model['source']),
            'inputs': normalized, 'sheet': sheet_name, 'rows': rows, 'summaries': [], 'context': [],
            'extra_rows': [], 'settings': [], 'incomplete_rows': sum(not row['complete'] for row in rows)}
    if calculator_id == 'ductwork':
        data['summaries'] = [
            table('Product totals', 'SUMMARY', 8, 9, 11, 'ABCDEFGHIJ', note='Net spray bags and wrap roll equivalents remain fractional. The source has no whole-bag or whole-roll purchasing rule.'),
            table('Penetration angles by size and location', 'SUMMARY', 18, 19, 26, 'ABCDEF'),
            table('Working spray yields', 'SUMMARY', 30, 31, 32, 'ABCDEF'),
            table('Maxilite 60 mm boards and cut strips', 'SUMMARY', 39, 40, 41, 'ABCDEFGHI'),
        ]
        data['summaries'][0]['qualifications'] = [(engine.value('SUMMARY', f'A{row}'), engine.value('SUMMARY', f'K{row}'), engine.value('SUMMARY', f'L{row}')) for row in range(9, 12)]
        data['totals'] = [('Available duct surface (m²)', _sum_values(r['values']['K'] for r in rows)),
                          ('Available net spray bags', _sum_values(r['values']['M'] for r in rows) if any(r['product_code'] in (1, 2) for r in rows) else 'N/A'),
                          ('Available wrap material, all layers (m²)', _sum_values(r['values']['N'] for r in rows) if any(r['wrap'] for r in rows) else 'N/A'),
                          ('Available wrap roll equivalents', _sum_values(r['values']['O'] for r in rows) if any(r['wrap'] for r in rows) else 'N/A'),
                          ('Available Maxilite net area at 60 mm (m²)', _sum_values(r['values']['P'] for r in rows) if any(r['wrap'] for r in rows) else 'N/A')]
        data['basis'] = 'Duct surface is the measured duct area. Wrap material includes the calculated layers and overlaps. Spray bags cover the duct body only. Bags do not apply to FyreWrap or Maxilite.'
    elif calculator_id == 'steel_vermiculite':
        data['summaries'] = [table('Product order totals', 'BAGS', 19, 20, 24, 'ABCDEFGHI',
            note='Whole bags per product are pooled from net bags, then the product waste allowance and rounding are applied once. They are not the sum of the schedule line bag counts.')]
        data['totals'] = [('Available spray surface (m²)', engine.value('SCHEDULE', 'A5')),
                          ('Quantified coating volume (m³)', engine.value('SCHEDULE', 'G5')),
                          ('Available net bags', _sum_values(item['values']['E'] for item in data['summaries'][0]['rows'])),
                          ('Available pooled whole bags (incomplete products excluded)', _sum_values(item['values']['G'] for item in data['summaries'][0]['rows']))]
        data['basis'] = 'Spray surface follows the selected exposure, member quantity, length, girth and any area override. Published thickness and usable estimating thickness are reported separately. Unresolved rows remain listed.'
        single = [(field['label'], engine.value('CALCULATOR', field['cell'])) for field in model['fields']['CALCULATOR']]
        single += [(label, engine.value('CALCULATOR', cell)) for label, cell in (
            ('Published thickness (mm)', 'H6'), ('Thickness status', 'H9'), ('Lookup ESA/M (m²/t)', 'K12'),
            ('Lookup Hp/A (1/m)', 'K13'), ('Usable estimating thickness (mm)', 'K14'), ('Girth used (m)', 'K15'),
            ('Spray area (m²)', 'K16'), ('Coating volume (m³)', 'K17'), ('Net bags', 'K18'),
            ('Quantity status', 'H20'), ('Thickness source', 'H23'), ('Basis / review note', 'A35'))]
        manual = [(sheets['BAGS']['cells'][f'A{row}']['value'], engine.value('BAGS', f'D{row}')) for row in range(6, 15)]
        data['context'] = [{'title': 'Single-member calculator - separate from the schedule', 'fields': single},
                           {'title': 'Manual bag calculation - separate from the schedule', 'fields': manual}]
    else:
        summary = table('Board stock totals by product and thickness', 'BOARD SUMMARY', 11, 12, 29, 'ABCDEFGHIJK',
            note='Stock is pooled by product and actual board thickness. Waste is applied before each stock-line sheet count is rounded. Per-line sheet counts are not pooled order quantities.')
        data['summaries'] = [summary]
        data['summary_notes'] = [engine.value('BOARD SUMMARY', f'A{row}') for row in (8, 31, 35)]
        data['totals'] = [('Reference box area (m²)', engine.value('CALCULATOR', 'AA4')),
                          ('Required net board including extras (m²)', engine.value('BOARD SUMMARY', 'A6')),
                          ('Pooled whole sheets', engine.value('BOARD SUMMARY', 'E6')),
                          ('Pooled purchase area (m²)', engine.value('BOARD SUMMARY', 'I6'))]
        data['basis'] = 'Reference box area is not steel profile area or board purchasing area. Required board area includes all calculated board layers; valid EXTRA BOARDS are included in pooled stock totals. Bags are not applicable to board products.'
        extras = sheets['EXTRA BOARDS']
        extra_columns = list('ABCDEFGHI') + ['N']
        for row in range(6, 46):
            if any(_has_value(engine.value('EXTRA BOARDS', column + str(row))) for column in extra_columns):
                data['extra_rows'].append({'row': row, 'line': row - 5,
                    'values': {column_name(column): engine.value('EXTRA BOARDS', column_name(column) + str(row)) for column in range(1, 15)},
                    'labels': {column_name(column): extras['cells'][column_name(column) + '5']['value'] for column in range(1, 15)}})

    for name, fields in model.get('fields', {}).items():
        for field in fields:
            if field.get('setting'):
                cell = sheets[name]['cells'].get(field['cell'], {})
                number_format = model['styles']['cell_styles'][int(cell.get('style', 0))].get('number_format', '')
                row = int(re.sub(r'\D', '', field['cell']))
                group = ''
                if calculator_id == 'ductwork':
                    group = 'CAFCO 300' if row < 50 else 'MONOKOTE' if row < 95 else 'FyreWrap'
                elif calculator_id == 'steel_vermiculite':
                    group = next((product for first, last, product in ((36, 42, 'CAFCO 300'), (69, 75, 'MANDOLITE CP2'),
                        (101, 107, 'FENDOLITE MII'), (178, 184, 'PERLIFOC HP ECO+'), (234, 240, 'MONOKOTE MK-6 HY'),
                        (346, 372, 'Section-factor helpers')) if first <= row <= last), 'Project / calculation policy')
                data['settings'].append({'sheet': name, 'group': group, 'label': field['label'], 'units': field.get('units', ''),
                    'value': engine.value(name, field['cell']), 'percent': '%' in number_format,
                    'notes': field.get('notes', '')})
    return data


class _ScheduleReport(_Report):
    def __init__(self, data):
        super().__init__({})
        self.data = data

    def p(self, text, style='body'):
        text = _text(text).translate({ord(character): '-' for character in '\u2010\u2011\u2012\u2013\u2014'})
        return super().p(text, style)

    def display(self, value, *, blank='Not available', percent=False):
        if isinstance(value, bool):
            return 'Yes' if value else 'No'
        if isinstance(value, str) and value in {'#N/A', '#VALUE!', '#DIV/0!', '#REF!', '#NUM!', '#NAME?', '#NULL!'}:
            return 'Unavailable: ' + value
        if _numeric(value) and not percent and 0 < abs(value) < .01:
            # Keep small tolerances and joint gaps visible without more than
            # two decimal places in the mantissa or a misleading rounded zero.
            with localcontext() as context:
                context.rounding = ROUND_HALF_UP
                return format(Decimal(str(value)), '.2E')
        return _number(value, blank=blank, percent=percent) if _numeric(value) or value is None or value == '' else _text(value)

    def numeric(self, value, **formatting):
        return self.p(self.display(value, **formatting), 'numeric')

    def pairs(self, values):
        # Paragraphs split safely even for 2,000-character notes or identifiers.
        return self.p(' | '.join(f'{label}: {self.display(value, blank="Blank")}' for label, value in values), 'small')

    def overview(self):
        data = self.data
        self.story += [self.p('Current calculator snapshot', 'small'), self.p(data['title'], 'title'),
                       self.p('Full schedule and material quantities', 'section'), self.p(data['basis'])]
        self.story.append(self.p(f"{len(data['rows'])} used schedule items. {data['incomplete_rows']} item(s) have incomplete or unavailable primary quantities. Every used item remains in this report.", 'alert' if data['incomplete_rows'] else 'body'))
        self.story.append(self.table(['Schedule measure', 'Total'],
            [[self.p(label, 'cell'), self.numeric(value)] for label, value in data['totals']], [_CONTENT * .68, _CONTENT * .32]))
        self.story.append(self.p('Totals use available source results and can exclude unresolved quantities. Read each item status and the final product order summary before ordering. Display rounding is limited to two decimal places; stored inputs and calculations retain their full precision.', 'small'))

    def schedule(self):
        data = self.data
        self.story += [PageBreak(), self.p('Full schedule', 'section')]
        if not data['rows']:
            self.story.append(self.p('No schedule inputs are entered.'))
            return
        rows = []
        for item in data['rows']:
            v = item['values']
            identity = str(item['line']) + (('\n' + str(v['A'])) if data['id'] != 'ductwork' and _has_value(v['A']) else '')
            if data['id'] == 'ductwork':
                thickness = self.display(item['wrap_layer_mm']) + ' per layer' if item['wrap'] else self.display(v['L'])
                rows.append([self.p(identity, 'cell'), self.detail(v['C'] or 'Product missing', v['B']), self.numeric(v['D']),
                    self.p(self.display(v['E']), 'cell'), self.p(thickness, 'numeric'), self.numeric(v['K']),
                    self.numeric('N/A' if item['wrap'] else v['M']), self.numeric(v['N'] if item['wrap'] else 'N/A'),
                    self.numeric(v['O'] if item['wrap'] else 'N/A'), self.p(v['J'] or 'No calculated status returned', 'cell')])
            elif data['id'] == 'steel_vermiculite':
                rows.append([self.p(identity, 'cell'), self.detail(v['B'] or 'Product missing', v['F']),
                    self.p(self.display(v['I']) + ' x ' + self.display(v['J']) + ' m', 'numeric'),
                    self.numeric(v['O']), self.numeric(v['P']), self.numeric(v['R']), self.numeric(v['T']), self.numeric(v['U']),
                    self.p('\n'.join(str(value) for value in (v['V'], v['W']) if _has_value(value)) or 'No calculated status returned', 'cell')])
            else:
                rows.append([self.p(identity, 'cell'), self.detail(v['C'] or 'Product missing', v['D']),
                    self.p(self.display(v['AN']) + ' / ' + self.display(v['AO']), 'numeric'), self.p(self.display(v['Z']), 'cell'),
                    self.numeric(v['AB']), self.numeric(v['AD']), self.numeric(v['AE']), self.numeric(v['AF']), self.numeric(v['AG']),
                    self.p('\n'.join(str(value) for value in (v['AR'], v['AS']) if _has_value(value)) or 'No calculated status returned', 'cell')])
        if data['id'] == 'ductwork':
            heads = ['Item', 'Product / duct mm', 'Length m', 'FRL', 'Thickness mm', 'Duct m²', 'Net spray bags', 'Wrap m²', 'Roll eq.', 'Status']
            fractions = [.05, .16, .065, .085, .08, .085, .085, .085, .075, .23]
        elif data['id'] == 'steel_vermiculite':
            heads = ['Item / mark', 'Product / section', 'Quantity x length', 'Published mm', 'Estimate mm', 'Spray m²', 'Net bags', 'Whole bags / line', 'Status']
            fractions = [.07, .19, .1, .08, .08, .1, .09, .09, .2]
        else:
            heads = ['Item / mark', 'Product / section', 'Design min / °C', 'Board stack mm', 'Total thickness mm', 'Box ref. m²', 'Net board m²', 'With waste m²', 'Sheets / line', 'Status']
            fractions = [.06, .17, .08, .08, .07, .09, .09, .09, .08, .19]
        self.story.append(self.table(heads, rows, [_CONTENT * size for size in fractions], compact=True))

    def details(self):
        data = self.data
        if data['rows']:
            self.story += [PageBreak(), self.p('Schedule inputs, calculations and complete notes', 'section')]
        for item in data['rows']:
            v, labels = item['values'], item['labels']
            self.story.append(self.p(f"Schedule item {item['line']}", 'subheading'))
            inputs = [(labels[column], self.display(v[column], blank='Blank', percent=data['id'] == 'steel_board' and column == 'L')) for column in item['input_columns']]
            self.story.append(self.pairs(inputs))
            measures, notes = [], []
            for number in range(_INPUT_LAST[data['id']] + 1, _OUTPUT_LAST[data['id']] + 1):
                column = column_name(number)
                value = _source_text(data['id'], data['sheet'], column + str(item['row']), v[column])
                label = labels[column]
                if not label or not _has_value(value):
                    continue
                if isinstance(value, str) and len(value) > 85:
                    notes.append((label, value))
                else:
                    measures.append((label, value))
            if item.get('wrap'):
                measures.append(('Blanket thickness per layer (mm)', item['wrap_layer_mm']))
            self.story.append(self.pairs(measures))
            if not item['complete']:
                self.story.append(self.p('Primary quantity is incomplete or unavailable; this item remains listed.', 'small'))
            for label, value in notes:
                self.story.append(self.p(f"Item {item['line']} - {label}", 'subheading'))
                self.note_block(value)

    def extras_and_context(self):
        data = self.data
        if data['id'] == 'steel_board':
            self.story += [PageBreak(), self.p('EXTRA BOARDS', 'section')]
            self.story.append(self.p('Valid allowances are already included in the final board stock totals. Incomplete entries remain listed and are excluded by the workbook rules.', 'small'))
            if not data['extra_rows']:
                self.story.append(self.p('No extra-board inputs are entered.'))
            for item in data['extra_rows']:
                self.story.append(self.p(f"Extra-board item {item['line']}", 'subheading'))
                self.story.append(self.pairs([(item['labels'][column], self.display(value, blank='Blank', percent=column == 'H'))
                                              for column, value in item['values'].items() if column != 'L']))
        for panel in data['context']:
            self.story += [PageBreak(), self.p(panel['title'], 'section'), self.p('These independent helper inputs and results are not added to the schedule or its product order totals.', 'small')]
            self.story.append(self.table(['Input / output', 'Snapshot value'],
                [[self.p(label, 'cell'), self.p(self.display(value, blank='Blank', percent=label == 'Waste allowance'), 'cell')]
                 for label, value in panel['fields']], [_CONTENT * .42, _CONTENT * .58]))
        self.story += [PageBreak(), self.p('Settings used for this report', 'section')]
        self.story.append(self.table(['Setting', 'Value', 'Units / basis'],
            [[self.p((item['group'] + ' - ' if item['group'] else '') + item['label'], 'cell'), self.p(self.display(item['value'], blank='Blank', percent=item['percent']), 'cell'),
              self.p(' | '.join(value for value in (item['units'], item['notes']) if value), 'cell')] for item in data['settings']],
            [_CONTENT * .32, _CONTENT * .30, _CONTENT * .38]))

    def product_totals(self):
        data = self.data
        self.story += [PageBreak(), self.p('Final product and material summary', 'section')]
        for value in data.get('summary_notes', []):
            self.note_block(_source_text(data['id'], 'BOARD SUMMARY', 'A8', value))
        for summary in data['summaries']:
            self.story.append(self.p(summary['title'], 'subheading'))
            if summary['note']:
                self.story.append(self.p(summary['note'], 'small'))
            columns = summary['columns']
            fractions = ([.17, .065, .085, .085, .09, .07, .09, .065, .065, .105, .11]
                         if data['id'] == 'steel_board' else
                         [.20, .07, .10, .10, .09, .07, .10, .08, .19] if data['id'] == 'steel_vermiculite' else
                         [.16, .045, .09, .085, .08, .075, .095, .08, .14, .15] if len(columns) == 10 else
                         [.16, .12, .13, .15, .18, .26] if len(columns) == 6 else
                         [.095, .10, .10, .10, .10, .10, .11, .11, .185])
            # Normalize explicit width weights to avoid accumulated layout drift.
            widths = [_CONTENT * value / sum(fractions) for value in fractions]
            rows = []
            for item in summary['rows']:
                formatted = []
                for column in columns:
                    value = item['values'][column]
                    if data['id'] == 'ductwork' and summary['title'] == 'Product totals' and ((item['row'] < 11 and column in 'EFG') or (item['row'] == 11 and column == 'D')):
                        value = 'N/A'
                    value = _source_text(data['id'], summary['sheet'], column + str(item['row']), value)
                    formatted.append(self.numeric(value, blank='-', percent=data['id'] == 'steel_vermiculite' and column == 'F') if _numeric(value) else self.p(self.display(value, blank='-'), 'cell'))
                rows.append(formatted)
            self.story.append(self.table([summary['labels'][column] for column in columns], rows, widths, compact=True))
            for product, basis, interpretation in summary.get('qualifications', []):
                self.story.append(self.pairs([(str(product), value) for value in (basis, interpretation) if _has_value(value)]))
            self.story.append(Spacer(1, 9))
        self.story.append(KeepTogether([self.p('Overall schedule totals', 'subheading'),
            self.table(['Schedule measure', 'Total'], [[self.p(label, 'cell'), self.numeric(value)] for label, value in data['totals']],
                       [_CONTENT * .68, _CONTENT * .32])]))
        self.story.append(self.p(f"{data['incomplete_rows']} schedule item(s) have incomplete or unavailable primary quantities. Totals retain the source workbook's exclusions; consult the full item notes before ordering.", 'small'))
        self.story.append(self.p('Report generated from the complete current calculator input snapshot. Authoritative workbook: ' + data['source']['filename'] + '. Source SHA-256: ' + data['source']['sha256'] + '.', 'small'))


def build_calculator_report(calculator_id, inputs=None):
    """Return a branded landscape PDF; reading a draft never saves it."""
    data = project_calculator_report(calculator_id, inputs)
    _register_fonts()
    logo = ImageReader(str(ROOT / 'static' / 'ceasefire-logo.png'))
    logo_width, logo_height = logo.getSize()
    report = _ScheduleReport(data)
    report.overview()
    report.schedule()
    report.details()
    report.extras_and_context()
    report.product_totals()
    output = BytesIO()
    document = SimpleDocTemplate(output, pagesize=landscape(A4), leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=73, bottomMargin=43, pageCompression=1, title='Ceasefire - ' + data['title'],
        author='Ceasefire', subject='Full estimating schedule and product quantities')

    def decorate(canvas, doc):
        canvas.saveState()
        scale = min(146 / logo_width, 35 / logo_height)
        canvas.drawImage(logo, _MARGIN, _HEIGHT - 20 - logo_height * scale,
                         width=logo_width * scale, height=logo_height * scale, mask='auto')
        canvas.setFillColor(_MUTED)
        canvas.setFont('CeasefireVera', 8)
        canvas.drawRightString(_WIDTH - _MARGIN, _HEIGHT - 34, 'CALCULATORS | FULL SCHEDULE')
        canvas.setStrokeColor(_RED)
        canvas.line(_MARGIN, _HEIGHT - 61, _WIDTH - _MARGIN, _HEIGHT - 61)
        canvas.setStrokeColor(_LINE)
        canvas.line(_MARGIN, 32, _WIDTH - _MARGIN, 32)
        canvas.setFont('CeasefireVera', 7)
        canvas.drawString(_MARGIN, 20, 'Ceasefire ESTIMATOR | ' + data['title'])
        canvas.drawRightString(_WIDTH - _MARGIN, 20, f'Page {doc.page}')
        canvas.restoreState()

    document.build(report.story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()
