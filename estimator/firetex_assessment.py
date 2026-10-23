"""Integrity-bound private FIRETEX certificate tables.

The certificates and complete publisher matrices are private build inputs.
Settings cannot change the printed DFT or extend the assessed scope.
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

PRODUCTS = ('FIRETEX FX5090', 'FIRETEX FX6010')
MAX_DATASET_BYTES = 512 * 1024


@dataclass(frozen=True)
class Table:
    case: str
    period: int
    table: int
    pages: tuple
    temperatures: tuple
    factors: tuple
    values: tuple


@dataclass(frozen=True)
class Assessment:
    product: str
    digest: str
    report_sha256: str = ''
    tables: tuple = ()
    error: str = ''


@dataclass(frozen=True)
class Authority:
    product: str
    DATASET_ID: str
    DATASET_SHA256: str
    REPORT_SHA256: str
    report: str
    date: str
    filename: str
    page_count: int
    table_count: int
    beam_cap_um: int
    hollow_beam_cap_um: int
    MAX_DATASET_BYTES: int = MAX_DATASET_BYTES

    @property
    def DATASET_FILENAME(self):
        return self.DATASET_ID + '.json'

    def validate_assessment_payload(self, payload):
        if not isinstance(payload, bytes) or len(payload) > self.MAX_DATASET_BYTES:
            raise ValueError('Assessment evidence exceeds its bounded size.')
        digest = sha256(payload).hexdigest()
        if digest != self.DATASET_SHA256:
            raise ValueError('Assessment evidence does not match the reviewed digest.')
        try:
            data = json.loads(payload)
            expected_source = dict(report=self.report, date=self.date, sha256=self.REPORT_SHA256,
                                   filename=self.filename, pages=self.page_count)
            if (type(data['schema_version']) is not int or data['schema_version'] != 1
                    or data['id'] != self.DATASET_ID or data['product'] != self.product
                    or data['source'] != expected_source or data['thickness_unit'] != 'micrometre'
                    or len(data['tables']) != self.table_count):
                raise ValueError('Assessment source identity, units or completeness differ.')
            tables, identities = [], set()
            for index, item in enumerate(data['tables'], 1):
                case, period = item['case'], item['period_min']
                factors, temps, pages, rows = (item[key] for key in
                                               ('factors', 'temperatures_c', 'pages', 'dft_um'))
                if (case not in ('R3', 'R4', 'H3', 'H4', 'CHS')
                        or type(period) is not int or period not in (15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180)
                        or (case, period) in identities or type(item['table']) is not int or item['table'] != index
                        or pages != [index + 1] or any(type(p) is not int for p in pages)
                        or not isinstance(factors, list) or not 1 <= len(factors) <= 100
                        or any(type(v) is not int or not 1 <= v <= 500 for v in factors)
                        or factors != list(range(factors[0], factors[-1] + 1, 5))
                        or not isinstance(temps, list) or not 1 <= len(temps) <= 20
                        or any(type(v) is not int or not 350 <= v <= 750 for v in temps)
                        or temps != sorted(set(temps)) or len(rows) != len(factors)):
                    raise ValueError('Assessment table identity or axes are invalid.')
                for row in rows:
                    if (len(row) != len(temps)
                            or any(v is not None and (type(v) is not int or not 0 < v <= 15000) for v in row)):
                        raise ValueError('Assessment thickness or blank cells are invalid.')
                identities.add((case, period))
                tables.append(Table(case, period, item['table'], tuple(pages), tuple(temps),
                                    tuple(factors), tuple(tuple(r) for r in rows)))
            return Assessment(self.product, digest, self.REPORT_SHA256, tuple(tables))
        except (ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
            raise ValueError('Assessment evidence has an invalid reviewed schema.') from error


AUTHORITIES = (
    Authority(PRODUCTS[0], 'firetex-fx5090-fc20571-01-c1', '1755c9b8aa7bdb10786ec0aa3fb45ba953ab9809c97022770a128049ff35cadb',
              '3e26ff0c292717614fa8a6b5a691913b9f6ddfd0b8f44158d174ec74219fe07a',
              'FC20571/01/C1', '2025-04-08', 'FC20571-01-C1 FINAL.pdf', 41, 40, 5282, 5180),
    Authority(PRODUCTS[1], 'firetex-fx6010-fc21221-01-1-c1', 'ab3cffb3c2c7f91c15650846494921865dab9a923459875fed9fa0e01b03219d',
              '3b3703934511e1e30c86474fb023aee343f66a172537e9adcbcc1588cad6c5c3',
              'FC21221-01-1-C1', '2025-10-31', 'FC21221-01-1-C1 - 31-10-2025.pdf', 47, 46, 5770, 5661),
)


def authority_for(product):
    return next((item for item in AUTHORITIES if item.product == product), None)


def load_assessment(authority):
    """Freshly read bounded bytes before selecting any application cache."""
    override = os.environ.get('CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY')
    folder = Path(override) if override and not getattr(sys, 'frozen', False) else ROOT / 'calculator-evidence'
    candidate = folder / authority.DATASET_FILENAME
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
            return authority.validate_assessment_payload(stream.read(authority.MAX_DATASET_BYTES + 1))
    except FileNotFoundError:
        error = f'Reviewed {authority.report} {authority.product} data is not installed.'
        return Assessment(authority.product, 'missing', error=error + ' Thickness and quantities are withheld.')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        error = f'Reviewed {authority.report} {authority.product} data failed integrity validation.'
        return Assessment(authority.product, 'invalid', error=error + ' Thickness and quantities are withheld.')


def load_assessments():
    return tuple(load_assessment(authority) for authority in AUTHORITIES)


def lookup(assessment, factor, temperature, period, *, case='R3'):
    """Select bounded printed cells. Never interpolate, extrapolate or fill blanks."""
    result = dict(dft=None, factor='', status='', source='', note='')
    authority = authority_for(assessment.product)
    scope = ('DFT is intumescent only. Match steel family, exposure, concrete slab contact and all certificate conditions. '
             'The supplied certificate is general information; retain the full assessment for project suitability.')
    def blocked(status, note):
        return dict(result, status=status, note=note + ' ' + scope)
    if authority is None or assessment.error or len(assessment.tables) != authority.table_count:
        return blocked('ASSESSMENT DATA UNAVAILABLE', assessment.error or 'Assessment tables are incomplete.')
    case = str(case).upper()
    beam = case in ('R4B', 'H4B')
    selected_case = {'R4B': 'R4', 'H4B': 'H4', 'RHS': 'H4', 'R4C': 'R4'}.get(case, case)
    if assessment.product == PRODUCTS[0] and selected_case == 'CHS':
        selected_case = 'H4'
    if selected_case not in ('R3', 'R4', 'H3', 'H4', 'CHS'):
        return blocked('UNSUPPORTED CASE', 'Select an assessed beam or column case.')
    if type(period) not in (int, float) or not math.isfinite(period):
        return blocked('FRL NOT TABULATED', 'Select an exact published fire period for this member case.')
    table = next((t for t in assessment.tables if (t.case, t.period) == (selected_case, period)), None)
    if table is None:
        return blocked('FRL NOT TABULATED', 'No table covers this fire period and member case.')
    if type(factor) not in (int, float) or not math.isfinite(factor) or factor <= 0:
        return blocked('ENTER POSITIVE FACTOR', 'Enter a valid positive section factor (m⁻¹).')
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or not table.temperatures[0] <= temperature <= table.temperatures[-1]:
        return blocked('TEMPERATURE OUT OF RANGE', 'Critical temperature is outside this table.')
    if temperature not in table.temperatures:
        return blocked('TEMPERATURE NOT TABULATED', 'Select an exact printed temperature for this product and member case.')
    minimum, maximum = table.factors[0], table.factors[-1]
    if beam:
        # The certificate cover also limits transferred beam section factors.
        source_case = 'R3' if selected_case == 'R4' else 'H3'
        beam_tables = [t for t in assessment.tables if t.case == source_case]
        minimum = max(minimum, min(t.factors[0] for t in beam_tables))
        maximum = min(maximum, max(t.factors[-1] for t in beam_tables))
    if factor < minimum or factor > maximum:
        return blocked('FACTOR OUT OF RANGE', 'Section factor is outside the published range for this member case.')
    position = bisect_left(table.factors, factor)
    temp_position = table.temperatures.index(temperature)
    selected_factor, selected_temp = table.factors[position], table.temperatures[temp_position]
    result['factor'] = selected_factor
    result['source'] = f'{authority.report} p{table.pages[0]} Table {table.table}; {selected_temp:g}C; factor {selected_factor:g}; {period:g} min'
    value = table.values[position][temp_position]
    if value is None:
        return dict(result, status='NP - NOT PUBLISHED', note='The selected printed cell is blank. ' + scope)
    if factor != selected_factor:
        lower_value = table.values[position - 1][temp_position]
        if lower_value is None or value < lower_value:
            return dict(result, status='SOURCE REVIEW - FACTOR INTERVAL',
                        note='The bounding printed cells do not support a conservative next-row estimate. Enter a published factor or obtain a project-specific design. ' + scope)
    cap = authority.beam_cap_um if selected_case == 'R4' else authority.hollow_beam_cap_um
    if beam and value > cap:
        return dict(result, status='BEAM THICKNESS LIMIT', note=f'Four-sided beam DFT exceeds the certificate limit of {cap} µm. ' + scope)
    exact = factor == selected_factor
    details = [f'{value:g} µm from {result["source"]}.']
    if not exact:
        details.append('Table estimate: next higher published section factor at the exact printed temperature; no interpolation.')
    if beam:
        details.append(f'Four-sided beam transfer; maximum {cap} µm and section factor {maximum:g} m⁻¹.')
    if selected_case in ('R3', 'H3'):
        details.append('Three-sided beam with concrete slab contact.')
    return dict(result, dft=value,
                status='PUBLISHED - CERTIFICATE TABLE' if exact else 'ESTIMATE - CONSERVATIVE TABLE',
                note=' '.join(details) + ' ' + scope)
