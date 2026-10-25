"""Private reviewed Promat spray assessments over unchanged workbook evidence."""
from bisect import bisect_left
from dataclasses import dataclass, replace
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import stat
import sys

from .catalog import ROOT
from .excel_engine import FormulaError, column_name, column_number
from .perlifoc_assessment import PerlifocEngine

DATASET_FILENAME = 'promat-steel-spray-reports-v1.json'
DATASET_ID = 'promat-steel-spray-reports-v1'
DATASET_SHA256 = 'd9309321a9ca747cf8baf6256acd5516af41f67ba998980a6cee6e2ffba7d243'
MAX_DATASET_BYTES = 256 * 1024
PRODUCTS = ('CAFCO 300', 'MANDOLITE CP2', 'FENDOLITE MII')
REPORT_SHA256S = ('5c6e6addde93d93b01b8b9a5f43823316996208a40eacb3d58d7e2381cc5b6f3',
                 '6c3a868b2706eca612b61607ca952aca505bcab143d6d1e7fab3a42d847c18ac',
                 '1b2eefa601cdf49c45a4332cf40145928529c8d7a29520a3323e473faba7e992')
REPORTS = ('FC13107-01-05', 'FC21286-01-01', 'FAR3541 Issue 7')
DATES = ('2025-07-08', '2025-12-22', '2025-10-07')
URLS = (
    'https://media.promat.com/cert_371264_au/original/1504631188/c300---steel-protection-fc13107-01-05-promat-final.pdf?brand=promatconstruction&market=au',
    'https://media.promat.com/cert_371268_au/original/-950972560/cp2-cafco-mandolite-cp2-steel-as4100-and-1530.4-2014-branz-fc21286-01-01.pdf?brand=promatconstruction&market=au',
    'https://media.promat.com/cert_371266_au/original/-954949072/fendolite-far3541-issue-7-fc21151-report-final.pdf?brand=promatconstruction&market=au')
FACTORS = ((tuple(range(70, 311, 5))), (63, *range(70, 321, 10), 323.4), tuple(range(70, 386, 5)))
TEMPERATURES = ((350, 450, 520, 550, 620, 750), tuple(range(350, 701, 50)),
                (350, 400, 450, 500, 520, 550, 600, 620, 650, 700, 750))
PERIODS = ((30, 60, 90, 120, 180, 240), tuple(range(30, 301, 30)), (60, 90, 120, 180, 240))
CASES = (('R3', 'R4', 'PFC3W', 'H4'), ('R3', 'R4', 'PFC3W', 'H3', 'H4'), ('R3', 'R4', 'PFC3W', 'H4', 'C'))
SCOPE = (
    'FC13107-01-05 governs CAFCO 300 thickness. Open re-entrant sections use the assessed three- or four-sided factor; hollow coverage is retained for four-sided columns. Verify slab contact, section identity, preparation and the engineer-specified temperature.',
    'FC21286-01-01 governs Mandolite CP2 thickness for the assessed open and hollow members, exposed faces and temperature. Three-sided hollow coverage requires RHS/SHS with the unexposed face correctly identified. Verify report conditions and preparation.',
    'FAR3541 Issue 7 governs Fendolite MII thickness. Match the open, fully exposed hollow or castellated member and exact published temperature. Castellated Hp/A is 1400 divided by lower-web thickness in mm; results above 52.8 mm are withheld. No hydrocarbon-fire approval is inferred.')


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def canonical_product(value):
    """Match native Excel case insensitivity without rewriting saved labels."""
    return next((p for p in PRODUCTS if isinstance(value, str) and p.casefold() == value.casefold()), None)


def temperature_options(product):
    product = canonical_product(product)
    return tuple(t for t in TEMPERATURES[2] if TEMPERATURES[PRODUCTS.index(product)][0] <= t <= TEMPERATURES[PRODUCTS.index(product)][-1]) if product else ()


def period_options(product, temperature=None):
    product = canonical_product(product)
    if not product:
        return ()
    index = PRODUCTS.index(product)
    if index == 0 and _number(temperature) and 350 <= temperature < 450:
        return PERIODS[index][:-1]
    return PERIODS[index]


def source_locator(product, case, temperature, period):
    """Exact public table/page identities; numerical matrices stay private."""
    index = PRODUCTS.index(product)
    if index == 0:
        ti = TEMPERATURES[index].index(temperature)
        if temperature == 350 and period == 240:
            return None
        first = (12 + 3 * ti) if case == 'R' else (30 + 2 * ti)
        return {'table': 3 + ti + (6 if case == 'H' else 0), 'pages': [first, first + 1], 'factor_split': 210}
    if index == 1:
        pi = PERIODS[index].index(period)
        table = 3 + pi + (10 if case == 'H' else 0)
        page = (9 + pi if pi < 8 else 17) if case == 'R' else (18 + pi if pi < 7 else 25)
        return {'table': table, 'pages': [page], 'factor_split': None}
    ti = TEMPERATURES[index].index(temperature)
    group = {'R': 0, 'H': 1, 'C': 2}[case]
    first = 15 + group * 34 + 3 * ti
    return {'table': 2 + group * 11 + ti, 'pages': [first, first + 1], 'factor_split': 275}


def product_metadata(product):
    i = PRODUCTS.index(product)
    return {'product': product, 'report': REPORTS[i], 'date': DATES[i], 'report_sha256': REPORT_SHA256S[i],
            'requested_url': URLS[i], 'page_count': (41, 25, 115)[i], 'factors': list(FACTORS[i]),
            'temperatures': list(TEMPERATURES[i]), 'periods': list(PERIODS[i]), 'source_table_count': (12, 20, 33)[i]}


@dataclass(frozen=True)
class Locator:
    table: int
    pages: tuple
    factor_split: object


@dataclass(frozen=True)
class AssessmentTable:
    product: str
    case: str
    temperature: int
    values: tuple
    period_sources: tuple


@dataclass(frozen=True)
class Assessment:
    digest: str
    report_sha256s: tuple = ()
    tables: tuple = ()
    error: str = ''


def _unique_object(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError('Duplicate assessment key.')
        data[key] = value
    return data


def validate_assessment_payload(payload):
    if not isinstance(payload, bytes) or len(payload) > MAX_DATASET_BYTES:
        raise ValueError('Assessment evidence exceeds its bounded size.')
    digest = sha256(payload).hexdigest()
    if digest != DATASET_SHA256:
        raise ValueError('Promat assessment evidence differs from the reviewed digest.')
    try:
        data = json.loads(payload, object_pairs_hook=_unique_object)
        if (set(data) != {'schema_version', 'id', 'products', 'tables'} or data['schema_version'] != 1
                or data['id'] != DATASET_ID or data['products'] != [product_metadata(p) for p in PRODUCTS]):
            raise ValueError('Assessment identity, axes or sources differ.')
        keys = [(p, case, t) for p in PRODUCTS for case in (('C', 'H', 'R') if p == PRODUCTS[2] else ('H', 'R'))
                for t in TEMPERATURES[PRODUCTS.index(p)]]
        if len(data['tables']) != len(keys):
            raise ValueError('Assessment tables are incomplete.')
        tables = []
        for item, key in zip(data['tables'], keys):
            p, case, temperature = key
            i = PRODUCTS.index(p)
            if set(item) != {'product', 'case', 'temperature', 'values', 'period_sources'} or (item['product'], item['case'], item['temperature']) != key:
                raise ValueError('Assessment table ordering differs.')
            rows = item['values']
            if len(rows) != len(FACTORS[i]) or any(len(row) != len(PERIODS[i]) for row in rows):
                raise ValueError('Assessment factor/period cells are incomplete.')
            if any(v is not None and (not _number(v) or not 0 < v <= 100) for row in rows for v in row):
                raise ValueError('Assessment thickness cells are invalid.')
            locators = [source_locator(p, case, temperature, period) for period in PERIODS[i]]
            if item['period_sources'] != locators or any(locator is None and any(row[pi] is not None for row in rows)
                                                       for pi, locator in enumerate(locators)):
                raise ValueError('Assessment cell source identities differ.')
            tables.append(AssessmentTable(p, case, temperature, tuple(tuple(row) for row in rows),
                tuple(None if locator is None else Locator(locator['table'], tuple(locator['pages']), locator['factor_split']) for locator in locators)))
        return Assessment(digest, REPORT_SHA256S, tuple(tables))
    except (ValueError, TypeError, KeyError, AttributeError, IndexError) as error:
        raise ValueError('Invalid reviewed Promat assessment schema.') from error


def load_assessment():
    """Fresh bounded snapshot before selecting a cached calculation session."""
    override = os.environ.get('CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY')
    folder = Path(override) if override and not getattr(sys, 'frozen', False) else ROOT / 'calculator-evidence'
    candidate = folder / DATASET_FILENAME
    try:
        if not folder.is_absolute() or (override and not getattr(sys, 'frozen', False) and folder.resolve().is_relative_to(ROOT.resolve())):
            raise ValueError('Private assessment evidence must be absolute and outside the checkout.')
        for path in (candidate, *candidate.parents):
            info = path.lstat()
            if path == candidate and not stat.S_ISREG(info.st_mode):
                raise ValueError('Assessment evidence must be a regular file.')
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('Assessment evidence cannot use redirected paths.')
        with candidate.open('rb') as stream:
            return validate_assessment_payload(stream.read(MAX_DATASET_BYTES + 1))
    except FileNotFoundError:
        return Assessment('missing', error='Reviewed Promat spray assessment data is not installed. CAFCO 300, Mandolite CP2 and Fendolite MII thicknesses and quantities are withheld.')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return Assessment('invalid', error='Reviewed Promat spray assessment data failed integrity validation. Thicknesses and quantities are withheld.')


@dataclass(frozen=True)
class SprayResult:
    status: str
    note: str
    thickness: object = ''
    actual_factor: object = ''
    table_factor: object = ''
    source: str = ''
    exact: bool = False
    page: object = ''
    table: object = ''
    input_temperature: object = ''
    table_temperature: object = ''


def lookup(assessment, product, factor, temperature, period, *, exposure, policy='Next higher (estimate)'):
    product = canonical_product(product)
    if not product:
        return SprayResult('UNSUPPORTED PRODUCT', 'Select a supported Promat steel spray product.')
    i = PRODUCTS.index(product)
    scope = SCOPE[i]
    if assessment.error:
        return SprayResult('ASSESSMENT DATA UNAVAILABLE', assessment.error + ' ' + scope)
    case = str(exposure).upper()
    if case not in CASES[i]:
        return SprayResult('UNSUPPORTED CASE / TEMP', 'This member/exposure is not covered by this application assessment route. ' + scope)
    if not _number(temperature) or not TEMPERATURES[i][0] <= temperature <= TEMPERATURES[i][-1]:
        return SprayResult('UNSUPPORTED CASE / TEMP', 'The critical temperature is outside the assessed range. ' + scope)
    if i == 2 and temperature not in TEMPERATURES[i]:
        return SprayResult('UNSUPPORTED CASE / TEMP', 'Fendolite requires an exact published critical temperature. ' + scope)
    if not _number(period) or period not in PERIODS[i]:
        return SprayResult('FRL NOT TABULATED', 'This exact fire-resistance period is not published. ' + scope)
    if not _number(factor) or factor <= 0:
        return SprayResult('ENTER POSITIVE FACTOR', 'Enter a finite positive section factor. ' + scope)
    if factor > FACTORS[i][-1] or (i == 2 and factor < FACTORS[i][0]):
        return SprayResult('FACTOR OUT OF RANGE', 'No above-maximum or unauthorised below-minimum factor is used. ' + scope, actual_factor=factor)
    if str(policy).casefold() not in ('exact only', 'next higher (estimate)'):
        return SprayResult('CHECK LOOKUP POLICY', 'Select Exact only or Next higher (estimate). ' + scope, actual_factor=factor)
    minimum = factor < FACTORS[i][0]
    position = bisect_left(FACTORS[i], factor)
    selected_factor = FACTORS[i][position]
    exact_factor = factor == selected_factor
    selected_temperature = max(t for t in TEMPERATURES[i] if t <= temperature)
    family = 'R' if case in ('R3', 'R4', 'PFC3W') else 'H' if case in ('H3', 'H4') else 'C'
    table = next((t for t in assessment.tables if (t.product, t.case, t.temperature) == (product, family, selected_temperature)), None)
    if table is None:
        return SprayResult('ASSESSMENT DATA UNAVAILABLE', 'The validated assessment table is unavailable; no workbook fallback is used. ' + scope)
    pi = PERIODS[i].index(period)
    locator = table.period_sources[pi]
    if locator is None:
        return SprayResult('FRL NOT TABULATED', 'This table does not publish this fire-resistance period. ' + scope,
                           actual_factor=factor, table_factor=selected_factor,
                           input_temperature=temperature, table_temperature=selected_temperature)
    page = locator.pages[0 if locator.factor_split is None or selected_factor <= locator.factor_split else 1]
    source = f'{REPORTS[i]} p{page} Table {locator.table}; {selected_temperature:g}C; Hp/A {selected_factor:g}; {period:g} min'
    details = dict(actual_factor=factor, table_factor=selected_factor, source=source, exact=exact_factor and selected_temperature == temperature,
                   page=page, table=locator.table, input_temperature=temperature, table_temperature=selected_temperature)
    if not minimum and not exact_factor and str(policy).casefold() == 'exact only':
        return SprayResult('NO EXACT FACTOR ROW', 'No exact section-factor row exists under the selected factor policy. ' + scope, **details)
    thickness = table.values[position][pi]
    if thickness is None:
        return SprayResult('NP - NOT PUBLISHED', 'The matching report cell is blank; no thickness is substituted. ' + scope, **details)
    if case == 'C' and thickness > 52.8:
        return SprayResult('EXCLUDED - ABOVE 52.8 MM', 'The published castellated value exceeds the report maximum of 52.8 mm. It is withheld, never capped. ' + scope, **details)
    if minimum:
        status = 'ESTIMATE - MINIMUM ASSESSMENT ROW'
    elif selected_temperature != temperature:
        status = 'ESTIMATE - LOWER ASSESSMENT TEMPERATURE'
    elif not exact_factor:
        status = 'ESTIMATE - UPPER ASSESSMENT ROW'
    else:
        status = 'PUBLISHED - ASSESSMENT TABLE'
    basis = f'{thickness:g} mm from {source}. Requested critical temperature {temperature:g}C; table temperature {selected_temperature:g}C. Actual Hp/A {factor:g}; table Hp/A {selected_factor:g}. '
    if minimum:
        basis += 'The report expressly allows its first factor row for a smaller positive factor; the same temperature/period cell is used, not a product-wide minimum thickness. '
    elif not exact_factor:
        basis += 'Next higher factor row, without interpolation or rounding the actual factor down. '
    if selected_temperature != temperature:
        basis += 'The report expressly permits a lower published temperature for a higher requested temperature within the assessment bounds. This is separate from the factor lookup policy. '
    return SprayResult(status, basis + scope + ' Quantities remain estimates; verify site yield.', thickness=thickness, **details)


_OUTPUT_COLUMNS = frozenset(('R', 'X', 'Y', 'AA', 'AB', 'AC', 'AD', 'AL', 'AM', 'AQ', 'AR', 'AS'))
_COMPARISON_PERIODS = (15, 30, 45, 60, 90, 120, 180, 240)
_PERIOD_COLUMNS = dict(zip(('AV', 'AW', 'AX', 'AY', 'AZ', 'BA', 'BB', 'BC'), _COMPARISON_PERIODS))
_FLAG_COLUMNS = dict(zip(('BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BK'), _COMPARISON_PERIODS))
_INTERCEPT_COLUMNS = frozenset(column_number(c) for c in (*_OUTPUT_COLUMNS, *_PERIOD_COLUMNS, *_FLAG_COLUMNS))


class PromatSprayEngine(PerlifocEngine):
    """Only the three Promat assessment result routes; quantities stay native."""
    def __init__(self, model, inputs=None, formula_overrides=None, *, assessment, perlifoc_assessment, promat_assessment):
        super().__init__(model, inputs, formula_overrides, assessment=assessment, perlifoc_assessment=perlifoc_assessment)
        self.promat_assessment = promat_assessment
        self._promat_products, self._promat_bases, self._promat_results = {}, {}, {}

    def _promat_original(self, row, column):
        return super().cell('ENGINE', row, column_number(column))

    def promat_scope_active(self, row):
        if row not in self._promat_products:
            self._promat_products[row] = canonical_product(self._promat_original(row, 'A'))
        return self._promat_products[row] is not None

    def _retained_factor(self, sheet, row, factor_column, esa_column):
        def uses_density(column, number, seen):
            key = column, number
            if key in seen or len(seen) >= 16:
                raise ValueError('Cyclic retained factor provenance.')
            formula = self.sheets[sheet]['cells'].get(f'{column}{number}', {}).get('formula', '')
            formula = re.sub(r'\s+', '', formula.replace('$', '')).upper()
            if 'SETTINGS!D13' in formula or "'SETTINGS'!D13" in formula:
                return True
            alias = re.fullmatch(r'IF\(([A-Z]+)([0-9]+)="","",\1\2\)', formula)
            if alias:
                return uses_density(alias[1], int(alias[2]), seen | {key})
            alias = re.fullmatch(r'([A-Z]+)([0-9]+)', formula)
            return bool(alias and uses_density(alias[1], int(alias[2]), seen | {key}))

        if uses_density(factor_column, row, set()):
            esa = super().cell(sheet, row, column_number(esa_column))
            return esa * 7.85 if _number(esa) and esa > 0 else '', 'Retained printed ESA/M converted with fixed report factor 7.85 (steel 7850 kg/m3); the editable global estimating density does not alter this report lookup. '
        factor = super().cell(sheet, row, column_number(factor_column))
        return factor, 'Retained Hp/A section factor; verify the actual member, geometry and exposed faces. '

    def _promat_basis(self, row):
        if row in self._promat_bases:
            return self._promat_bases[row]
        product = self._promat_products[row]
        method, case = str(self._promat_original(row, 'D')).casefold(), str(self._promat_original(row, 'B')).upper()
        factor, note, issue, named = '', '', None, method == 'section'
        if method == 'section':
            section, index = self._promat_original(row, 'AN'), self._promat_original(row, 'BY')
            if not section or not _number(index) or index <= 0:
                issue = ('SELECT STEEL SECTION', 'Select a recognised steel section.')
            elif str(self._promat_original(row, 'BZ')).startswith('EXCLUDED'):
                issue = ('EXCLUDED - SECTION IDENTITY', 'The retained section identity remains excluded.')
            elif self._promat_original(row, 'N') > 1:
                issue = ('HOLD - AMBIGUOUS MEMBER', 'More than one retained named factor matches this exact member.')
            else:
                family = super().cell('SECTIONS', int(index) + 5, column_number('B'))
                hollow = family in ('SHS', 'RHS', 'CHS')
                if ((case == 'H3' and family not in ('SHS', 'RHS')) or (case == 'H4' and not hollow)
                        or (case in ('R3', 'R4', 'PFC3W') and hollow) or (case == 'PFC3W' and family != 'PFC')):
                    issue = ('UNSUPPORTED STEEL SECTION', 'The selected steel family does not match the assessed exposure.')
                elif case == 'C':
                    issue = ('ENTER LOWER WEB / SPECIAL FACTOR', 'A normal named profile factor cannot replace 1400 divided by the actual lower-web thickness for castellated steel.')
                else:
                    original = self._promat_original(row, 'O')
                    shared = self._promat_original(row, 'P')
                    if _number(original) and original > 0:
                        factor, note = self._retained_factor('THICKNESS DATA', int(original) + 5, 'H', 'G')
                        note += 'Factor provenance: ' + str(super().cell('THICKNESS DATA', int(original) + 5, column_number('Z'))) + '. '
                    elif _number(shared) and shared > 0:
                        factor, note = self._retained_factor('SECTIONS', int(shared) + 985, 'R', 'Q')
                    else:
                        matches = self._factor_records()[0].get(f'{case}|{section}'.casefold(), [])
                        if len(matches) > 1:
                            issue = ('HOLD - AMBIGUOUS MEMBER', 'More than one retained geometry factor matches this member.')
                        elif matches:
                            record = matches[0]
                            factor, note = self._retained_factor('SECTIONS', record, 'E', 'D')
                            note += 'Retained shared geometry factor; verify actual member and exposed faces. '
                        else:
                            issue = ('NO SHARED SECTION FACTOR', 'No retained section factor is available for this exact identity and exposure.')
        elif method in ('hp/a', 'esa/m'):
            if case == 'C' and method == 'esa/m':
                answer = ('', '', ('ENTER LOWER WEB / SPECIAL FACTOR',
                          'A generic ESA/M input cannot replace the castellated lower-web factor. Use Lower web or the declared special Hp/A.'), False)
                self._promat_bases[row] = answer
                return answer
            factor = self._promat_original(row, 'F')
            if method == 'esa/m' and _number(factor):
                factor *= 7.85
                note = 'User ESA/M converted with fixed report factor 7.85 (steel 7850 kg/m3); editable global estimating density does not change the assessment factor. '
            else:
                note = 'User-entered Hp/A; verify the report-specific factor and exposed geometry. '
            if case == 'C':
                note += 'Castellated Hp/A must be 1400 divided by the actual lower-web thickness in mm, not an ordinary profile perimeter/area. '
        elif method == 'lower web (mm)' and product == 'FENDOLITE MII' and case == 'C':
            web = self._promat_original(row, 'F')
            factor = 1400 / web if _number(web) and web > 0 else ''
            note = 'Castellated factor uses the report constant 1400 divided by the entered lower-web thickness in mm. '
        else:
            issue = ('CHECK METHOD', 'Use Section, Hp/A or ESA/M; Lower web is only for Fendolite castellated steel.')
        answer = factor, note, issue, named
        self._promat_bases[row] = answer
        return answer

    def _promat_result(self, row, period=None):
        period = self._promat_original(row, 'G') if period is None else period
        key = row, period
        if key not in self._promat_results:
            product = self._promat_products[row]
            try:
                factor, note, issue, named = self._promat_basis(row)
                if issue and not self.promat_assessment.error:
                    result = SprayResult(issue[0], issue[1] + ' ' + SCOPE[PRODUCTS.index(product)])
                else:
                    result = lookup(self.promat_assessment, product, factor, self._promat_original(row, 'C'), period,
                                    exposure=self._promat_original(row, 'B'), policy=self._promat_original(row, 'AU'))
                    if note:
                        result = replace(result, note=result.note + ' ' + note)
                    if named and _number(result.thickness):
                        result = replace(result, status='ESTIMATE - RETAINED SECTION FACTOR')
            except (FormulaError, TypeError, ValueError, ZeroDivisionError):
                result = SprayResult('BLOCKED - INPUT CALCULATION', 'The retained section inputs could not be evaluated. No Promat thickness or quantity is authorised.')
            if not result.source:
                # The current assessment policy is still identifiable when it
                # withholds a result; no table or page is invented for a hold.
                result = replace(result, source=REPORTS[PRODUCTS.index(product)])
            self._promat_results[key] = result
        return self._promat_results[key]

    def cell(self, sheet, row, column):
        canonical = self.sheet_names.get(sheet.casefold(), sheet)
        if canonical == 'ENGINE' and 2 <= row <= 1002 and column in _INTERCEPT_COLUMNS and self.promat_scope_active(row):
            name = column_name(column)
            if name in _PERIOD_COLUMNS or name in _FLAG_COLUMNS:
                result = self._promat_result(row, (_PERIOD_COLUMNS | _FLAG_COLUMNS)[name])
                return result.thickness if name in _PERIOD_COLUMNS else ('' if _number(result.thickness) else result.status)
            result = self._promat_result(row)
            if name in ('AA', 'AD'):
                return result.thickness
            if name == 'R':
                return result.actual_factor
            if name == 'Y':
                return result.table_factor
            if name in ('X', 'AR'):
                return ''
            if name == 'AB':
                return '' if _number(result.thickness) else result.status
            if name == 'AC':
                return result.status
            if name == 'AL':
                return result.source
            if name in ('AM', 'AQ'):
                return result.note if _number(result.thickness) else result.status + '. ' + result.note
            if name == 'AS':
                return result.page
        if canonical == 'CALCULATOR' and ((row in (29, 30) and 2 <= column <= 9) or (row == 23 and column == 8)) and self.promat_scope_active(2):
            result = self._promat_result(2, _COMPARISON_PERIODS[column - 2]) if row in (29, 30) else self._promat_result(2)
            if row == 29:
                return result.thickness
            if row == 30:
                return result.status if not _number(result.thickness) else ('ASSESSMENT' if result.exact else 'ESTIMATE')
            return result.note if _number(result.thickness) else result.status + '. ' + result.note
        return super().cell(sheet, row, column)


def apply_model_metadata(model):
    """Refresh derived display/provenance labels; immutable source stays intact."""
    settings = next(s for s in model['sheets'] if s['name'] == 'SETTINGS')['cells']
    updates = {'A32': 'FC13107-01-05 | 8 July 2025', 'D33': REPORTS[0], 'A34': 'CAFCO 300 structural steel assessment FC13107-01-05',
               'A65': 'FC21286-01-01 | 22 December 2025', 'D66': REPORTS[1], 'A67': 'Mandolite CP2 structural steel assessment FC21286-01-01',
               'A97': 'FAR3541 Issue 7 | 7 October 2025', 'D98': REPORTS[2], 'A99': 'Fendolite MII steel assessment FAR3541 Issue 7',
               'D45': SCOPE[0], 'D78': SCOPE[1], 'D110': SCOPE[2],
               'D50': 'The current assessment table governs thickness. Retained named section values supply factor provenance only; old manual thicknesses do not override it.',
               'D83': 'The current CP2 assessment table governs thickness. Retained section identities and factors remain evidence; old manual thicknesses are not reused.',
               'D51': 'Assessment lookup uses Hp/A. ESA/M inputs use the fixed report conversion times 7.85; estimating settings cannot change this conversion.',
               'D84': 'CP2 assessment uses Hp/A, with fixed ESA/M conversion times 7.85 and no intermediate rounding.',
               'D52': 'Historical named-thickness header reconciliations remain retained source evidence; FC13107-01-05 alone governs current CAFCO thickness.',
               'D118': 'FAR3541 Issue 7 includes the 750C appendix tables; all separate factor, member and thickness limits apply.',
               'D119': 'Use exact published Fendolite critical temperatures, including 750C; no temperature interpolation is inferred.',
               'D120': 'Castellated results above 52.8 mm remain excluded, never reduced to fit the limit.',
               'D121': 'FAR3541 Issue 7 corrects Table 4 at 450C; use its actual values without the superseded 400C substitution.'}
    for address, value in updates.items():
        settings[address] = {**settings.get(address, {}), 'value': value}
        settings[address].pop('formula', None)
        settings[address].pop('cached_value', None)
