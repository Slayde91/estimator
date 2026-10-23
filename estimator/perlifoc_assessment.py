"""Reviewed FC21278 Perlifoc policy over the unchanged workbook evidence.

The signed report and extracted tables remain private. Every request verifies
the installed evidence before a cached calculation can be reused. No missing
or invalid assessment falls back to the superseded workbook thicknesses.
"""

from bisect import bisect_left
from dataclasses import dataclass, replace
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import stat
import sys

from .catalog import ROOT
from .excel_engine import FormulaError, column_name, column_number
from .monokote_hollow import MonokoteHollowEngine


DATASET_FILENAME = 'perlifoc-fc21278-01-1.json'
DATASET_ID = 'perlifoc-fc21278-01-1'
DATASET_SHA256 = '3a7998db10f1176e30d9f88df926a6653b40c60b4ee41156779102938d3f41ff'
REPORT_SHA256 = 'e2bec404557eee77dcdbbc68935701c2d960c5f3aac16299bca9dedc38c86c21'
MAX_DATASET_BYTES = 256 * 1024
TEMPERATURES = tuple(range(350, 751, 50))
FACTORS = (68, *range(70, 471, 10), 476)
PERIODS = (15, 30, 45, 60, 90, 120, 180, 240, 360)
CASES = ('R3', 'R4', 'H3', 'H4')
SCOPE = (
    'FC21278-01-1: match the assessed steel family, exposed sides and slab contact. '
    'Three-sided hollow beams cover RHS/SHS; CHS coverage is for fully exposed columns. '
    'Confirm the engineer-specified critical temperature, member dimensions and report conditions. '
    'The application retains Hp/A 68 to 476 m-1; it does not extend the final published row.'
)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


@dataclass(frozen=True)
class AssessmentTable:
    case: str
    temperature: int
    page: int
    table: int
    values: tuple


@dataclass(frozen=True)
class Assessment:
    digest: str
    report_sha256: str = ''
    tables: tuple = ()
    error: str = ''


def _parse_dataset(payload, digest):
    data = json.loads(payload)
    if (data.get('schema_version') != 1 or data.get('id') != DATASET_ID
            or data.get('temperatures') != list(TEMPERATURES)
            or data.get('factors') != list(FACTORS)
            or data.get('periods') != list(PERIODS)):
        raise ValueError('Assessment schema or axes differ from the reviewed policy.')
    source = data['source']
    if (source.get('report') != 'FC21278-01-1' or source.get('date') != '2025-11-04'
            or source.get('sha256') != REPORT_SHA256):
        raise ValueError('Assessment source identity differs from the reviewed report.')
    tables = []
    if len(data['tables']) != len(CASES) * len(TEMPERATURES):
        raise ValueError('Assessment tables are incomplete.')
    for index, item in enumerate(data['tables']):
        case = CASES[index // len(TEMPERATURES)]
        temperature = TEMPERATURES[index % len(TEMPERATURES)]
        if (item['case'] != case or item['temperature'] != temperature
                or type(item['page']) is not int or item['page'] != index + 11
                or type(item['table']) is not int or item['table'] != index + 5):
            raise ValueError('Assessment table identity differs from the reviewed report.')
        rows = item['values']
        if len(rows) != len(FACTORS):
            raise ValueError('Assessment factor rows are incomplete.')
        for row in rows:
            if (len(row) != len(PERIODS)
                    or any(v is not None and (type(v) is not int or not 0 < v <= 1000) for v in row)):
                raise ValueError('Assessment thickness cells are invalid.')
        tables.append(AssessmentTable(case, temperature, item['page'], item['table'],
                                      tuple(tuple(row) for row in rows)))
    return Assessment(digest, REPORT_SHA256, tuple(tables))


def validate_assessment_payload(payload):
    """Shared runtime/build gate bound to the reviewed dataset and report."""
    if not isinstance(payload, bytes) or len(payload) > MAX_DATASET_BYTES:
        raise ValueError('Assessment evidence exceeds its bounded size.')
    digest = sha256(payload).hexdigest()
    if not DATASET_SHA256 or digest != DATASET_SHA256:
        raise ValueError('Assessment evidence does not match the reviewed digest.')
    try:
        return _parse_dataset(payload, digest)
    except (ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        raise ValueError('Assessment evidence has an invalid reviewed schema.') from error


def load_assessment():
    """Read a fresh bounded snapshot before calculation-cache selection."""
    override = os.environ.get('CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY')
    folder = Path(override) if override and not getattr(sys, 'frozen', False) else ROOT / 'calculator-evidence'
    candidate = folder / DATASET_FILENAME
    try:
        if not folder.is_absolute():
            raise ValueError('The evidence folder must be absolute.')
        if override and not getattr(sys, 'frozen', False) and folder.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError('Private assessment evidence must be outside the source checkout.')
        for path in (candidate, *candidate.parents):
            info = path.lstat()
            if path == candidate and not stat.S_ISREG(info.st_mode):
                raise ValueError('Assessment evidence must be a regular file.')
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('Assessment evidence cannot use redirected paths.')
        with candidate.open('rb') as stream:
            return validate_assessment_payload(stream.read(MAX_DATASET_BYTES + 1))
    except FileNotFoundError:
        return Assessment('missing', error='Reviewed FC21278-01-1 Perlifoc data is not installed. Perlifoc thicknesses and quantities are withheld.')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return Assessment('invalid', error='Reviewed FC21278-01-1 Perlifoc data failed integrity validation. Perlifoc thicknesses and quantities are withheld.')


@dataclass(frozen=True)
class PerlifocResult:
    status: str
    note: str
    thickness: object = ''
    actual_factor: object = ''
    table_factor: object = ''
    source: str = ''
    exact: bool = False
    page: object = ''
    table: object = ''


def lookup(assessment, factor, temperature, period, *, exposure, policy='Next higher (estimate)'):
    """Use one exact case/temperature/period; never interpolate or extrapolate."""
    if assessment.error:
        return PerlifocResult('ASSESSMENT DATA UNAVAILABLE', assessment.error + ' ' + SCOPE)
    case = str(exposure).upper()
    if case not in CASES:
        return PerlifocResult('UNSUPPORTED CASE / TEMP', 'The report has no table for this exposure. ' + SCOPE)
    if not _number(temperature) or temperature not in TEMPERATURES:
        return PerlifocResult('UNSUPPORTED CASE / TEMP', 'The report has no table for this exact critical temperature. ' + SCOPE)
    if not _number(period) or period not in PERIODS:
        return PerlifocResult('FRL NOT TABULATED', 'The report does not publish this exact fire-resistance period. ' + SCOPE)
    if not _number(factor) or factor <= 0:
        return PerlifocResult('ENTER POSITIVE FACTOR', 'Enter a valid positive section factor. ' + SCOPE)
    if factor < FACTORS[0] or factor > FACTORS[-1]:
        return PerlifocResult('FACTOR OUT OF RANGE', 'No factor outside the application range is authorised. ' + SCOPE,
                              actual_factor=factor)
    policy_key = str(policy).casefold()
    if policy_key not in ('exact only', 'next higher (estimate)'):
        return PerlifocResult('CHECK LOOKUP POLICY', 'Select Exact only or Next higher (estimate). ' + SCOPE,
                              actual_factor=factor)
    position = bisect_left(FACTORS, factor)
    selected = FACTORS[position]
    exact = factor == selected
    table = assessment.tables[CASES.index(case) * len(TEMPERATURES) + TEMPERATURES.index(temperature)]
    source = f'FC21278-01-1 p{table.page} Table {table.table}; {temperature:g}C; Hp/A {selected}; {period:g} min'
    details = dict(actual_factor=factor, table_factor=selected, source=source,
                   exact=exact, page=table.page, table=table.table)
    if not exact and policy_key == 'exact only':
        return PerlifocResult('NO EXACT FACTOR ROW', 'No exact assessment factor row exists under the selected policy. ' + SCOPE,
                              **details)
    thickness = table.values[position][PERIODS.index(period)]
    if thickness is None:
        return PerlifocResult('NP - NOT PUBLISHED', 'The report shows no published thickness for this case. ' + SCOPE,
                              **details)
    status = 'PUBLISHED - ASSESSMENT TABLE' if exact else 'ESTIMATE - UPPER ASSESSMENT ROW'
    note = (f'{thickness:g} mm from {source}. '
            + (f'Input Hp/A {factor:g}; next higher assessment row, without interpolation. ' if not exact else '')
            + SCOPE + ' Quantities remain estimates; verify site yield.')
    return PerlifocResult(status, note, thickness=thickness, **details)


_OUTPUT_COLUMNS = frozenset(('R', 'X', 'Y', 'AA', 'AB', 'AC', 'AD', 'AL', 'AM', 'AQ', 'AR', 'AS'))
_PERIOD_COLUMNS = dict(zip(('AV', 'AW', 'AX', 'AY', 'AZ', 'BA', 'BB', 'BC'), PERIODS))
_FLAG_COLUMNS = dict(zip(('BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BK'), PERIODS))
_INTERCEPT_COLUMNS = frozenset(column_number(c) for c in (*_OUTPUT_COLUMNS, *_PERIOD_COLUMNS, *_FLAG_COLUMNS))


class PerlifocEngine(MonokoteHollowEngine):
    """Replace Perlifoc thickness/provenance while retaining quantity formulas."""

    def __init__(self, model, inputs=None, formula_overrides=None, *, assessment, perlifoc_assessment):
        super().__init__(model, inputs, formula_overrides, assessment=assessment)
        self.perlifoc_assessment = perlifoc_assessment
        self._perlifoc_cases = {}
        self._perlifoc_bases = {}
        self._perlifoc_results = {}
        self._perlifoc_shared = None
        self._perlifoc_product = None

    def _perlifoc_original(self, row, column):
        return super().cell('ENGINE', row, column_number(column))

    def perlifoc_scope_active(self, row):
        if row not in self._perlifoc_cases:
            self._perlifoc_cases[row] = str(self._perlifoc_original(row, 'A')).casefold() == 'perlifoc hp eco+'
        return self._perlifoc_cases[row]

    def _factor_records(self):
        if self._perlifoc_shared is None:
            shared, product = {}, {}
            cells = self.sheets['SECTIONS']['cells']
            for row in range(986, 1934):
                key = cells.get(f'A{row}', {}).get('value')
                if isinstance(key, str):
                    shared.setdefault(key.casefold(), []).append(row)
            for row in range(986, 4770):
                key = cells.get(f'M{row}', {}).get('value')
                if isinstance(key, str) and key.casefold().startswith('perlifoc hp eco+|'):
                    product.setdefault(key.casefold(), []).append(row)
            self._perlifoc_shared, self._perlifoc_product = shared, product
        return self._perlifoc_shared, self._perlifoc_product

    def _perlifoc_basis(self, row):
        if row in self._perlifoc_bases:
            return self._perlifoc_bases[row]
        method = self._perlifoc_original(row, 'D')
        case = str(self._perlifoc_original(row, 'B')).upper()
        factor, note, issue, named = '', '', None, False
        method_key = str(method).casefold()
        if method_key == 'section':
            named = True
            section = self._perlifoc_original(row, 'AN')
            index = self._perlifoc_original(row, 'BY')
            if not section or not _number(index) or index <= 0:
                issue = ('SELECT STEEL SECTION', 'Select a recognised steel section.')
            elif str(self._perlifoc_original(row, 'BZ')).startswith('EXCLUDED'):
                issue = ('EXCLUDED - SECTION IDENTITY', 'The retained section identity is excluded from use.')
            else:
                family = super().cell('SECTIONS', int(index) + 5, column_number('B'))
                hollow = family in ('SHS', 'RHS', 'CHS')
                if ((case == 'H3' and family not in ('SHS', 'RHS'))
                        or (case == 'H4' and not hollow)
                        or (case in ('R3', 'R4') and hollow)):
                    issue = ('UNSUPPORTED STEEL SECTION', 'The selected steel family does not match this assessed exposure.')
                elif case not in CASES:
                    issue = ('UNSUPPORTED CASE / TEMP', 'The selected exposure is not covered by FC21278-01-1.')
                else:
                    shared, products = self._factor_records()
                    matches = products.get(f'perlifoc hp eco+|{case}|{section}'.casefold(), [])
                    use_shared = not matches
                    if use_shared:
                        matches = shared.get(f'{case}|{section}'.casefold(), [])
                    if len(matches) > 1:
                        issue = ('HOLD - AMBIGUOUS MEMBER', 'More than one retained section factor matches this member.')
                    elif not matches:
                        issue = ('NO SHARED SECTION FACTOR', 'No retained factor is available for this exact section and exposure.')
                    else:
                        record = matches[0]
                        factor = super().cell('SECTIONS', record, column_number('E' if use_shared else 'R'))
                        source = super().cell('SECTIONS', record, column_number('F' if use_shared else 'S'))
                        note = f'Retained shared section factor {factor} m-1; source: {source}. This is an estimate; verify the actual member and exposed faces.'
        elif method_key in ('hp/a', 'esa/m'):
            factor = self._perlifoc_original(row, 'F')
            if method_key == 'esa/m' and _number(factor):
                density = super().cell('SETTINGS', 13, column_number('D'))
                factor = factor * density / 1000 if _number(density) and density > 0 else ''
            note = f'User-entered {method} factor; verify the assessed steel family and exposure.'
        else:
            issue = ('CHECK METHOD', 'Use Section, Hp/A or ESA/M for Perlifoc steel protection.')
        result = factor, note, issue, named
        self._perlifoc_bases[row] = result
        return result

    def _perlifoc_result(self, row, period=None):
        period = self._perlifoc_original(row, 'G') if period is None else period
        key = row, period
        if key not in self._perlifoc_results:
            try:
                factor, note, issue, named = self._perlifoc_basis(row)
                if issue and not self.perlifoc_assessment.error:
                    result = PerlifocResult(issue[0], issue[1] + ' ' + SCOPE)
                else:
                    result = lookup(self.perlifoc_assessment, factor, self._perlifoc_original(row, 'C'), period,
                                    exposure=self._perlifoc_original(row, 'B'), policy=self._perlifoc_original(row, 'AU'))
                    if note:
                        result = replace(result, note=result.note + ' ' + note)
                    if named and _number(result.thickness):
                        result = replace(result, status='ESTIMATE - SHARED FACTOR')
            except FormulaError:
                result = PerlifocResult('BLOCKED - INPUT CALCULATION', 'The retained section inputs could not be calculated. No Perlifoc quantity is authorised. ' + SCOPE)
            self._perlifoc_results[key] = result
        return self._perlifoc_results[key]

    def cell(self, sheet, row, column):
        canonical = self.sheet_names.get(sheet.casefold(), sheet)
        if canonical == 'ENGINE' and 2 <= row <= 1002 and column in _INTERCEPT_COLUMNS and self.perlifoc_scope_active(row):
            name = column_name(column)
            if name in _PERIOD_COLUMNS or name in _FLAG_COLUMNS:
                result = self._perlifoc_result(row, (_PERIOD_COLUMNS | _FLAG_COLUMNS)[name])
                return result.thickness if name in _PERIOD_COLUMNS else ('' if _number(result.thickness) else result.status)
            result = self._perlifoc_result(row)
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
        if (canonical == 'CALCULATOR' and ((row in (29, 30) and 2 <= column <= 10)
                                          or (row == 23 and column == 8))
                and self.perlifoc_scope_active(2)):
            if row in (29, 30) and 2 <= column <= 10:
                result = self._perlifoc_result(2, PERIODS[column - 2])
                if row == 29:
                    return result.thickness
                return ('ASSESSMENT' if result.exact else 'UPPER ROW') if _number(result.thickness) else result.status
            if row == 23 and column == 8:
                result = self._perlifoc_result(2)
                return result.note if _number(result.thickness) else result.status + '. ' + result.note
        return super().cell(sheet, row, column)
