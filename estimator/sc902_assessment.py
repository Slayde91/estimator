"""Private, integrity-bound FC18580-01-01 Nullifire SC902 table authority.

Published decimal millimetres are stored as exact integer micrometres. The
report and its matrix are deliberately excluded from the source checkout.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import stat
import sys

from .catalog import ROOT


DATASET_FILENAME = 'nullifire-sc902-fc18580-01-01.json'
DATASET_ID = 'nullifire-sc902-fc18580-01-01'
DATASET_SHA256 = '715e66891943f49e45c473781a58865d6d357fb92beddde88d9e9a65b99167fe'
REPORT_SHA256 = '3bf3499358d6f2e4b75a8ed1402995cba8f9f72142ee81e79ed22fc73e4a4344'
MAX_DATASET_BYTES = 512 * 1024
TEMPERATURES = (350, 400, 450, 500, 520, 550, 580, 600, 620, 650, 700, 750)
PERIODS = (15, 30, 45, 60, 75, 90, 105, 120)
CASES = ('R3', 'R4', 'RHS', 'CHS')
SOURCE_HEADINGS = ('I-Section Beams', 'Columns',
                   'Rectangular Hollow Sections', 'Circular Hollow Sections')
FACTOR_MAXIMA = ((320,) * 8, (320,) * 8, (370,) * 7 + (230,),
                 (395,) * 5 + (380, 245, 175))
SCOPE = ('FC18580-01-01, 20 March 2024: verify the steel family, exposed sides, '
         'engineer-specified critical temperature and all report/application conditions. '
         'Hollow-section tables cover columns. Values are intumescent-only dry film thickness.')


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _axis_matches(value, expected):
    return isinstance(value, list) and all(type(v) is int for v in value) and value == list(expected)


def table_temperatures(case):
    return tuple(t for t in TEMPERATURES if t != 520 or case not in ('R3', 'R4'))


def table_factors(case, period):
    lower = 40 if case == 'CHS' else 50
    upper = FACTOR_MAXIMA[CASES.index(case)][PERIODS.index(period)]
    return tuple(range(lower, upper + 1, 5))


def table_pages(case, period):
    index = PERIODS.index(period)
    if case == 'R3':
        return (9 + index,)
    if case == 'R4':
        return (17 + index,)
    if case == 'RHS':
        return (25 + 2 * index, 26 + 2 * index) if index < 7 else (39,)
    return (40 + 2 * index, 41 + 2 * index) if index < 6 else (52 + index - 6,)


@dataclass(frozen=True)
class AssessmentTable:
    case: str
    period: int
    table: int
    temperatures: tuple
    pages: tuple
    factors: tuple
    values: tuple
    red_applicable: tuple
    source_pages_by_row: tuple
    mesh_required: bool


@dataclass(frozen=True)
class Assessment:
    digest: str
    report_sha256: str = ''
    tables: tuple = ()
    error: str = ''


def _parse_dataset(payload, digest):
    data = json.loads(payload)
    if (type(data.get('schema_version')) is not int or data['schema_version'] != 1
            or data.get('id') != DATASET_ID or not _axis_matches(data.get('temperatures_c'), TEMPERATURES)
            or not _axis_matches(data.get('periods_min'), PERIODS) or data.get('thickness_unit') != 'micrometre'
            or data.get('source_table_unit') != 'decimal millimetres; exact integer micrometres'):
        raise ValueError('Assessment schema, units or axes differ from the reviewed policy.')
    source = data['source']
    if (source.get('report') != 'FC18580-01-01' or source.get('date') != '2024-03-20'
            or source.get('sha256') != REPORT_SHA256 or type(source.get('pages')) is not int or source['pages'] != 53
            or source.get('filename') != 'FC18580-01-01-Nullifire-SC902-2020-REPORT-Final.pdf'):
        raise ValueError('Assessment source identity differs from the reviewed report.')
    if len(data['tables']) != len(CASES) * len(PERIODS):
        raise ValueError('Assessment tables are incomplete.')
    tables = []
    for index, item in enumerate(data['tables']):
        case = CASES[index // len(PERIODS)]
        period = PERIODS[index % len(PERIODS)]
        temperatures = table_temperatures(case)
        pages = table_pages(case, period)
        if (item['case'] != case or type(item['period_min']) is not int or item['period_min'] != period
                or type(item['table']) is not int or item['table'] != index + 3
                or item['source_heading'] != SOURCE_HEADINGS[CASES.index(case)]
                or not _axis_matches(item['temperatures_c'], temperatures) or not _axis_matches(item['pages'], pages)
                or type(item['mesh_required']) is not bool or item['mesh_required'] != (case == 'RHS')):
            raise ValueError('Assessment table identity differs from the reviewed report.')
        factors = item['factors']
        if (any(type(f) is not int for f in factors)
                or factors != list(table_factors(case, period))):
            raise ValueError('Assessment factor axis differs from the reviewed report.')
        rows, red, row_pages = item['dft_um'], item['red_applicable'], item['source_pages_by_row']
        if len(rows) != len(factors) or len(red) != len(factors) or len(row_pages) != len(factors):
            raise ValueError('Assessment factor rows are incomplete.')
        expected_pages = [pages[0] if row < 55 or len(pages) == 1 else pages[1]
                          for row in range(len(factors))]
        if any(type(p) is not int for p in row_pages) or row_pages != expected_pages:
            raise ValueError('Assessment row page identities are invalid.')
        for row, flags in zip(rows, red):
            if (len(row) != len(temperatures) or len(flags) != len(temperatures)
                    or any(v is not None and (type(v) is not int or not 0 < v <= 10000) for v in row)
                    or any(type(flag) is not bool for flag in flags)
                    or any(flag and value is None for flag, value in zip(flags, row))):
                raise ValueError('Assessment thickness cells, blanks or applicability flags are invalid.')
        tables.append(AssessmentTable(case, period, item['table'], temperatures, pages, tuple(factors),
                                      tuple(tuple(r) for r in rows), tuple(tuple(r) for r in red),
                                      tuple(row_pages), item['mesh_required']))
    return Assessment(digest, REPORT_SHA256, tuple(tables))


def validate_assessment_payload(payload):
    """Shared runtime/build gate: both reviewed bytes and schema must match."""
    if not isinstance(payload, bytes) or len(payload) > MAX_DATASET_BYTES:
        raise ValueError('Assessment evidence exceeds its bounded size.')
    digest = sha256(payload).hexdigest()
    if digest != DATASET_SHA256:
        raise ValueError('Assessment evidence does not match the reviewed digest.')
    try:
        return _parse_dataset(payload, digest)
    except (ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        raise ValueError('Assessment evidence has an invalid reviewed schema.') from error


def load_assessment():
    """Read a fresh private snapshot before selecting any calculation cache."""
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
            if (stat.S_ISLNK(info.st_mode)
                    or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)):
                raise ValueError('Assessment evidence cannot use redirected paths.')
        with candidate.open('rb') as stream:
            return validate_assessment_payload(stream.read(MAX_DATASET_BYTES + 1))
    except FileNotFoundError:
        return Assessment('missing', error='Reviewed FC18580-01-01 SC902 data is not installed. Thickness and quantities are withheld.')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return Assessment('invalid', error='Reviewed FC18580-01-01 SC902 data failed integrity validation. Thickness and quantities are withheld.')


def lookup(assessment, factor, temperature, period, *, case='R3'):
    """Conservative printed row/temperature selection; never fill a blank cell."""
    result = {'dft': None, 'factor': '', 'status': '', 'source': '', 'note': ''}
    def blocked(status, note):
        return dict(result, status=status, note=note + ' ' + SCOPE)
    if assessment.error or len(assessment.tables) != len(CASES) * len(PERIODS):
        return blocked('ASSESSMENT DATA UNAVAILABLE', assessment.error or 'Assessment tables are incomplete.')
    case = str(case).upper()
    if case not in CASES:
        return blocked('UNSUPPORTED CASE', 'No table covers this steel exposure.')
    if not _number(period) or period not in PERIODS:
        return blocked('FRL NOT TABULATED', 'Select an exact published fire-resistance period.')
    if not _number(temperature) or not TEMPERATURES[0] <= temperature <= TEMPERATURES[-1]:
        return blocked('TEMPERATURE OUT OF RANGE', 'Critical temperature must be between 350 and 750 C.')
    if not _number(factor) or factor <= 0:
        return blocked('ENTER POSITIVE FACTOR', 'Enter a valid positive A/V section factor.')
    table = assessment.tables[CASES.index(case) * len(PERIODS) + PERIODS.index(period)]
    if factor > table.factors[-1]:
        return blocked('FACTOR OUT OF RANGE', 'The factor exceeds the last published row for this case and period.')
    position = bisect_left(table.factors, factor)
    selected_factor = table.factors[position]
    temp_position = bisect_right(table.temperatures, temperature) - 1
    selected_temperature = table.temperatures[temp_position]
    page = table.source_pages_by_row[position]
    result['factor'] = selected_factor
    result['source'] = (f'FC18580-01-01 p{page} Table {table.table}; {selected_temperature:g}C; '
                        f'A/V {selected_factor}; {period:g} min')
    dft = table.values[position][temp_position]
    mesh = ' Mesh is required for rectangular hollow sections.' if table.mesh_required else ''
    if dft is None:
        return blocked('NP - NOT PUBLISHED', 'The selected table cell is blank; no thickness or quantity is authorised.' + mesh)
    changes = []
    if factor < table.factors[0]:
        changes.append(f'Input A/V {factor:g}: minimum published row applies under report page 8.')
    elif factor != selected_factor:
        changes.append(f'Input A/V {factor:g}: next higher published row used without interpolation.')
    if temperature != selected_temperature:
        changes.append(f'Input {temperature:g} C: lower published temperature used under report page 8.')
    if table.red_applicable[position][temp_position]:
        changes.append('The red printed value is expressly applicable under report page 8.')
    result['dft'] = float(dft)
    result['status'] = 'ESTIMATE - CONSERVATIVE ASSESSMENT' if changes and (factor != selected_factor or temperature != selected_temperature) else 'PUBLISHED - ASSESSMENT TABLE'
    result['source'] += f'; {dft / 1000:g} mm = {dft:g} µm DFT'
    result['note'] = (f'Published {dft / 1000:g} mm converted exactly to {dft:g} µm DFT. '
                      + ' '.join(changes) + mesh + ' ' + SCOPE)
    return result
