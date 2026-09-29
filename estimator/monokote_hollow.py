"""Reviewed FAR4856 application policy; the imported workbook stays immutable.

The assessment tables are private, separately packaged evidence. Missing or
changed evidence withholds H4 results, including comparison cells and exports.
WorkbookEngine remains the independent evaluator of the original Excel model.
"""

from bisect import bisect_left
from dataclasses import dataclass
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import stat
import sys

from .catalog import ROOT
from .excel_engine import FormulaError, WorkbookEngine, column_name, column_number


DATASET_FILENAME = 'monokote-far4856-issue2.json'
# Bound to the independently reviewed private artifact before release.
DATASET_SHA256 = 'd75eb118a7061df08d2732393719f902e52042f93de9a955ab0c9ac5386840ff'
DATASET_ID = 'monokote-far4856-issue2'
MAX_DATASET_BYTES = 256 * 1024
TEMPERATURES = (350, 400, 450, 500, 550, 600, 620, 650, 700, 750)
FACTORS = tuple(range(30, 366, 5))
PERIODS = (30, 60, 90, 120, 180, 240)
COMPARISON_PERIODS = (15, 30, 45, 60, 90, 120, 180, 240)
SCOPE = 'Fully exposed SHS, RHS and CHS columns only; verify the assessed construction and engineer-specified critical temperature.'


@dataclass(frozen=True)
class AssessmentTable:
    period: int
    page: int
    table: int
    values: tuple


@dataclass(frozen=True)
class Assessment:
    """Hashable immutable snapshot also used to separate calculation caches."""
    digest: str
    report_sha256: str = ''
    tables: tuple = ()
    blocked_cells: tuple = ()
    error: str = ''


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _parse_dataset(payload, digest):
    data = json.loads(payload)
    if (data.get('schema_version') != 1 or data.get('id') != DATASET_ID
            or data.get('temperatures') != list(TEMPERATURES)
            or data.get('factors') != list(FACTORS)):
        raise ValueError('Assessment schema or axes differ from the reviewed policy.')
    scope = data['scope']
    if (scope.get('exposure') != 'H4' or scope.get('member') != 'hollow_column'
            or scope.get('families') != ['SHS', 'RHS', 'CHS']):
        raise ValueError('Assessment scope differs from the reviewed policy.')
    source = data['source']
    report_hash = source['sha256']
    if (source.get('report') != 'FAR4856 Issue 2' or source.get('date') != '2020-11-09'
            or not isinstance(report_hash, str) or len(report_hash) != 64
            or any(c not in '0123456789abcdef' for c in report_hash)):
        raise ValueError('Assessment source identity is invalid.')
    tables = []
    for index, item in enumerate(data['tables']):
        if (index >= len(PERIODS) or item['period'] != PERIODS[index]
                or item['page'] != index + 9 or item['table'] != index + 1):
            raise ValueError('Assessment table identity is invalid.')
        rows = item['values']
        if len(rows) != len(FACTORS):
            raise ValueError('Assessment factor rows are incomplete.')
        for row in rows:
            if (len(row) != len(TEMPERATURES)
                    or any(v is not None and (not _number(v) or not 0 < v <= 1000) for v in row)):
                raise ValueError('Assessment thickness cells are invalid.')
        tables.append(AssessmentTable(item['period'], item['page'], item['table'],
                                      tuple(tuple(row) for row in rows)))
    if len(tables) != len(PERIODS):
        raise ValueError('Assessment periods are incomplete.')
    blocked = []
    for cell in data['blocked_cells']:
        key = (cell['period'], cell['factor'], cell['temperature'])
        if (key[0] not in PERIODS or key[1] not in FACTORS or key[2] not in TEMPERATURES
                or not isinstance(cell['reason'], str) or not cell['reason'].strip()
                or len(cell['reason']) > 500 or any(previous[:3] == key for previous in blocked)):
            raise ValueError('Assessment hold is invalid.')
        blocked.append((*key, cell['reason']))
    if not any(cell[:3] == (240, 250, 650) for cell in blocked):
        raise ValueError('The unresolved publisher value must remain blocked.')
    return Assessment(digest, report_hash, tuple(tables), tuple(blocked))


def validate_assessment_payload(payload):
    """Shared runtime/build gate; never accepts an unreviewed digest."""
    if not isinstance(payload, bytes) or len(payload) > MAX_DATASET_BYTES:
        raise ValueError('Assessment evidence exceeds its bounded size.')
    digest = sha256(payload).hexdigest()
    if not DATASET_SHA256 or digest != DATASET_SHA256:
        raise ValueError('Assessment evidence does not match the reviewed digest.')
    try:
        return _parse_dataset(payload, digest)
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError('Assessment evidence has an invalid reviewed schema.') from error


def load_assessment():
    """Read and verify a bounded snapshot on every request, before cache reuse."""
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
            payload = stream.read(MAX_DATASET_BYTES + 1)
        return validate_assessment_payload(payload)
    except FileNotFoundError:
        return Assessment('missing', error='Reviewed FAR4856 Issue2 data is not installed. H4 thicknesses and quantities are withheld.')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return Assessment('invalid', error='Reviewed FAR4856 Issue2 data failed integrity validation. H4 thicknesses and quantities are withheld.')


@dataclass(frozen=True)
class HollowResult:
    status: str
    note: str
    thickness: object = ''
    actual_factor: object = ''
    table_factor: object = ''
    source: str = ''
    exact: bool = False


def lookup(assessment, factor, temperature, period, *, policy='Next higher (estimate)'):
    """Exact period/temperature; never interpolate or extend factor limits."""
    if assessment.error:
        return HollowResult('ASSESSMENT DATA UNAVAILABLE', assessment.error + ' ' + SCOPE)
    if not _number(temperature) or temperature not in TEMPERATURES:
        return HollowResult('UNSUPPORTED CASE / TEMP', 'FAR4856 Issue2 has no table for this exact critical temperature. ' + SCOPE)
    if not _number(period) or period not in PERIODS:
        return HollowResult('FRL NOT TABULATED', 'FAR4856 Issue2 does not publish this exact fire-resistance period. ' + SCOPE)
    if not _number(factor) or factor <= 0:
        return HollowResult('ENTER POSITIVE FACTOR', 'Enter a valid positive hollow-section factor. ' + SCOPE)
    if factor < FACTORS[0] or factor > FACTORS[-1]:
        return HollowResult('FACTOR OUT OF RANGE', 'The factor is outside FAR4856 Issue2. No extrapolation or reduced factor is permitted. ' + SCOPE, actual_factor=factor)
    if policy not in ('Exact only', 'Next higher (estimate)'):
        return HollowResult('CHECK LOOKUP POLICY', 'Select Exact only or Next higher (estimate). ' + SCOPE, actual_factor=factor)
    position = bisect_left(FACTORS, factor)
    selected = FACTORS[position]
    exact = factor == selected
    table = assessment.tables[PERIODS.index(period)]
    source = f'FAR4856 Issue2 p{table.page} Table {table.table}; {temperature:g}C; Hp/A up to {selected}'
    if not exact and policy == 'Exact only':
        return HollowResult('NO EXACT FACTOR ROW', 'No exact assessment factor row is available under the selected policy. ' + SCOPE,
                            actual_factor=factor, table_factor=selected, source=source)
    held = next((cell[3] for cell in assessment.blocked_cells if cell[:3] == (period, selected, temperature)), None)
    if held:
        return HollowResult('BLOCKED - SOURCE REVIEW', held + ' No thickness or quantities are authorised. ' + SCOPE,
                            actual_factor=factor, table_factor=selected, source=source, exact=exact)
    thickness = table.values[position][TEMPERATURES.index(temperature)]
    if thickness is None:
        return HollowResult('NP - NOT PUBLISHED', 'The assessment shows no published thickness for this factor, temperature and period. ' + SCOPE,
                            actual_factor=factor, table_factor=selected, source=source, exact=exact)
    status = 'PUBLISHED - ASSESSMENT TABLE' if exact else 'ESTIMATE - UPPER ASSESSMENT ROW'
    note = (f'{thickness:g} mm from {source}. '
            + (f'Input Hp/A {factor:g}; next higher assessment row, without interpolation. ' if not exact else '')
            + SCOPE + ' Quantities remain estimating values; verify site yield.')
    return HollowResult(status, note, thickness, factor, selected, source, exact)


_OUTPUT_COLUMNS = frozenset(('R', 'X', 'Y', 'AA', 'AB', 'AC', 'AD', 'AL', 'AM', 'AQ', 'AS'))
_PERIOD_COLUMNS = dict(zip(('AV', 'AW', 'AX', 'AY', 'AZ', 'BA', 'BB', 'BC'), COMPARISON_PERIODS))
_FLAG_COLUMNS = dict(zip(('BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BK'), COMPARISON_PERIODS))
_INTERCEPT_COLUMNS = frozenset(column_number(c) for c in (*_OUTPUT_COLUMNS, *_PERIOD_COLUMNS, *_FLAG_COLUMNS))


class MonokoteHollowEngine(WorkbookEngine):
    """Application-only H4 projection over unchanged Excel inputs/formulas.

Only the reviewed thickness route and its display/provenance are replaced.
Existing girth, area, volume, yield, waste and pooled-bag formulas remain in
the source graph and consume the corrected estimating thickness through AD.
"""

    def __init__(self, model, inputs=None, formula_overrides=None, *, assessment):
        super().__init__(model, inputs, formula_overrides)
        self.assessment = assessment
        self._hollow_cases = {}
        self._hollow_basis = {}
        self._hollow_results = {}
        self._named_factors = None

    def _original(self, row, column):
        return super().cell('ENGINE', row, column_number(column))

    def _affected(self, row):
        if row not in self._hollow_cases:
            self._hollow_cases[row] = (self._original(row, 'A') == 'MONOKOTE MK-6 HY'
                                       and self._original(row, 'B') == 'H4')
        return self._hollow_cases[row]

    def hollow_scope_active(self, row):
        return self._affected(row)

    def _named_factor(self, section):
        if self._named_factors is None:
            self._named_factors = {}
            cells = self.sheets['THICKNESS DATA']['cells']
            prefix = 'MONOKOTE MK-6 HY|H4|550|'
            for address, cell in cells.items():
                value = cell.get('value')
                if address.startswith('A') and isinstance(value, str) and value.startswith(prefix):
                    row = address[1:]
                    factor = cells.get('H' + row, {}).get('value')
                    source = cells.get('Z' + row, {}).get('value', '')
                    page = cells.get('AA' + row, {}).get('value', '')
                    self._named_factors.setdefault(value[len(prefix):], []).append((factor, source, page))
        return self._named_factors.get(section, [])

    def _basis(self, row):
        if row in self._hollow_basis:
            return self._hollow_basis[row]
        method = self._original(row, 'D')
        factor, note, issue = '', '', None
        if method == 'Section':
            section = self._original(row, 'AN')
            index = self._original(row, 'BY')
            if not section or not _number(index) or index <= 0:
                issue = ('SELECT STEEL SECTION', 'Select a recognised hollow steel section.')
            elif str(self._original(row, 'BZ')).startswith('EXCLUDED'):
                issue = ('EXCLUDED - SECTION IDENTITY', 'The retained section identity is excluded from use.')
            else:
                family = super().cell('SECTIONS', int(index) + 5, column_number('B'))
                if family not in ('SHS', 'RHS', 'CHS'):
                    issue = ('UNSUPPORTED HOLLOW SECTION', 'FAR4856 H4 requires SHS, RHS or CHS; open sections are not covered.')
                else:
                    named = self._named_factor(section)
                    if len(named) > 1:
                        issue = ('HOLD - AMBIGUOUS MEMBER', 'More than one retained named factor matches this section.')
                    elif named:
                        factor, source, page = named[0]
                        note = f'Retained printed section factor {factor} m-1 from {source} p{page}; thickness is governed by FAR4856 Issue2.'
                    else:
                        index = self._original(row, 'P')
                        if _number(index) and index > 0:
                            factor = super().cell('SECTIONS', int(index) + 985, column_number('R'))
                            source = super().cell('SECTIONS', int(index) + 985, column_number('S'))
                            note = f'Retained shared section factor {factor} m-1; source: {source}. Verify the actual section geometry.'
                        else:
                            issue = ('NO SHARED SECTION FACTOR', 'No retained section factor is available for this hollow member.')
        elif method in ('Hp/A', 'ESA/M'):
            factor = self._original(row, 'F')
            if method == 'ESA/M' and _number(factor):
                density = super().cell('SETTINGS', 13, column_number('D'))
                factor = factor * density / 1000 if _number(density) and density > 0 else ''
            note = f'User-entered {method} factor; verify the fully exposed hollow-column geometry and source.'
        else:
            issue = ('CHECK METHOD', 'Use Section, Hp/A or ESA/M for FAR4856 hollow columns.')
        result = factor, note, issue
        self._hollow_basis[row] = result
        return result

    def _result(self, row, period=None):
        period = self._original(row, 'G') if period is None else period
        key = row, period
        if key not in self._hollow_results:
            try:
                factor, note, issue = self._basis(row)
                if issue and not self.assessment.error:
                    result = HollowResult(issue[0], issue[1] + ' ' + SCOPE)
                else:
                    result = lookup(self.assessment, factor, self._original(row, 'C'), period,
                                    policy=self._original(row, 'AU'))
                    if note:
                        result = HollowResult(result.status, result.note + ' ' + note,
                                              result.thickness, result.actual_factor,
                                              result.table_factor, result.source, result.exact)
            except FormulaError:
                result = HollowResult('BLOCKED - INPUT CALCULATION', 'The retained section inputs could not be calculated. No assessment quantity is authorised. ' + SCOPE)
            self._hollow_results[key] = result
        return self._hollow_results[key]

    def cell(self, sheet, row, column):
        canonical = self.sheet_names.get(sheet.casefold(), sheet)
        if canonical == 'ENGINE' and 2 <= row <= 1002 and column in _INTERCEPT_COLUMNS and self._affected(row):
            name = column_name(column)
            if name in _PERIOD_COLUMNS or name in _FLAG_COLUMNS:
                result = self._result(row, (_PERIOD_COLUMNS | _FLAG_COLUMNS)[name])
                return result.thickness if name in _PERIOD_COLUMNS else ('' if _number(result.thickness) else result.status)
            result = self._result(row)
            if name in ('AA', 'AD'):
                return result.thickness
            if name == 'R':
                return result.actual_factor
            if name == 'Y':
                return result.table_factor
            if name == 'X':
                return ''  # The assessment publishes Hp/A, not paired ESA/M.
            if name == 'AB':
                return '' if _number(result.thickness) else result.status
            if name == 'AC':
                return result.status
            if name == 'AL':
                return result.source
            if name in ('AM', 'AQ'):
                return result.note if _number(result.thickness) else result.status + '. ' + result.note
            if name == 'AS':
                period = self._original(row, 'G')
                return PERIODS.index(period) + 9 if period in PERIODS else ''
        if canonical == 'CALCULATOR' and row == 30 and 2 <= column <= 9 and self._affected(2):
            result = self._result(2, COMPARISON_PERIODS[column - 2])
            return ('ASSESSMENT' if result.exact else 'UPPER ROW') if _number(result.thickness) else result.status
        if canonical == 'CALCULATOR' and row == 23 and column == 8 and self._affected(2):
            result = self._result(2)
            return result.note if _number(result.thickness) else result.status + '. ' + result.note
        return super().cell(sheet, row, column)
