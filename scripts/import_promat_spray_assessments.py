"""Reproduce the reviewed private Promat spray dataset from three complete PDFs.

This tool never downloads or publishes reports. Numerical output and receipts
must be outside the repository. Obtain the complete official reports separately
and observe their reproduction conditions; no report text is written by this tool.
"""
import argparse
from collections import Counter
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from estimator import promat_spray_assessment as policy


def _number(value):
    value = (value or '').strip().removeprefix('\u2264')
    if not re.fullmatch(r'\d+(?:\.\d+)?', value):
        raise ValueError('Unexpected numerical table cell.')
    number = Decimal(value)
    return int(number) if number == int(number) else float(number)


def _source(path, expected):
    path = Path(path).resolve()
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            or not 0 < info.st_size <= 30 * 1024 * 1024):
        raise ValueError('Source PDF must be a bounded regular file.')
    raw = path.read_bytes()
    if sha256(raw).hexdigest() != expected or not raw.startswith(b'%PDF-'):
        raise ValueError('The complete source PDF does not match the reviewed report digest.')
    return path, raw


def import_assessments(paths, output):
    output = Path(output)
    if len(paths) != 3 or not output.is_absolute():
        raise ValueError('Provide the three complete PDFs and an absolute private output path.')
    output = output.resolve()
    if (output.is_relative_to(ROOT) or output.exists()
            or not output.parent.is_dir() or output.with_suffix(output.suffix + '.receipt.json').exists()):
        raise ValueError('Use a new output path outside the repository.')
    import pdfplumber
    from pypdf import PdfReader

    data = {'schema_version': 1, 'id': policy.DATASET_ID,
            'products': [policy.product_metadata(p) for p in policy.PRODUCTS], 'tables': []}
    verification = []
    source_refs = []
    for index, (product, source_input) in enumerate(zip(policy.PRODUCTS, paths)):
        source, original = _source(source_input, policy.REPORT_SHA256S[index])
        reader = PdfReader(source)
        if len(reader.pages) != policy.product_metadata(product)['page_count']:
            raise ValueError('Unexpected complete-report page count.')
        source_refs.append({'path': str(source), 'sha256': sha256(original).hexdigest(), 'size': len(original)})
        factors, periods, temperatures = policy.FACTORS[index], policy.PERIODS[index], policy.TEMPERATURES[index]
        raw_tables = {}
        page_rows = {}
        with pdfplumber.open(source) as pdf:
            cache = {}
            families = ('C', 'H', 'R') if index == 2 else ('H', 'R')
            for family in families:
                # CP2 source tables run by period; the other reports run by temperature.
                source_axes = periods if index == 1 else temperatures
                for axis in source_axes:
                    temp, period = (temperatures[0], axis) if index == 1 else (axis, periods[0])
                    locator = policy.source_locator(product, family, temp, period)
                    table_id = locator['table']
                    rows = {}
                    source_headers = None
                    for page_number in locator['pages']:
                        if page_number not in cache:
                            cache[page_number] = pdf.pages[page_number - 1].extract_tables()
                        candidates = cache[page_number]
                        if index == 1:
                            ids = [11, 12] if page_number == 17 else [20, 21, 22] if page_number == 25 else [table_id]
                            cells = candidates[ids.index(table_id)]
                        else:
                            if len(candidates) != 1:
                                raise ValueError('Unexpected source table grid membership.')
                            cells = candidates[0]
                        header = cells[2 if index == 1 else 1]
                        source_headers = [_number(v) for v in header if v and re.fullmatch(r'\d+(?:\.\d+)?', v.strip())]
                        expected_headers = list(temperatures) if index == 1 else list(periods[:-1] if index == 0 and temp == 350 else periods)
                        if source_headers != expected_headers:
                            raise ValueError('Source temperature/period headings differ.')
                        for grid_row in cells:
                            row = [v for v in grid_row if v is not None]
                            if not row or not re.fullmatch(r'\u2264?\d+(?:\.\d+)?', (row[0] or '').strip()):
                                continue
                            if len(row) != len(source_headers) + (1 if index == 1 else 2):
                                raise ValueError('Source table cells do not align with the exact headings.')
                            values = [_number(v) if v and v.strip() else None for v in row]
                            factor = values[0 if index == 1 else 1]
                            if factor not in factors or factor in rows:
                                raise ValueError('Unexpected or repeated source factor.')
                            rows[factor] = values[1 if index == 1 else 2:]
                            page_rows.setdefault(page_number, []).append(tuple(v for v in values if v is not None))
                    if list(rows) != list(factors[:len(rows)]) or index != 1 and len(rows) != len(factors):
                        raise ValueError('Source factor rows are incomplete or reordered.')
                    raw_tables[(family, axis)] = (rows, source_headers)
            for family in families:
                for temperature in temperatures:
                    values = []
                    for factor in factors:
                        row = []
                        for period in periods:
                            source_axis = period if index == 1 else temperature
                            cells, headers = raw_tables[(family, source_axis)]
                            if period not in headers and index != 1:
                                row.append(None)
                            elif factor not in cells:
                                row.append(None)
                            else:
                                row.append(cells[factor][headers.index(temperature if index == 1 else period)])
                        values.append(row)
                    data['tables'].append({'product': product, 'case': family, 'temperature': temperature,
                        'values': values, 'period_sources': [policy.source_locator(product, family, temperature, period) for period in periods]})
        for page_number, expected_rows in sorted(page_rows.items()):
            # An independent text extractor checks every nonblank numeric row;
            # the vector grid above preserves the position of blank cells.
            text = reader.pages[page_number - 1].extract_text(extraction_mode='layout')
            actual = []
            for line in text.splitlines():
                parts = line.split()
                if len(parts) > 1 and all(re.fullmatch(r'\u2264?\d+(?:\.\d+)?', part) for part in parts):
                    actual.append(tuple(_number(part) for part in parts))
            if Counter(expected_rows) - Counter(actual):
                raise ValueError('Independent numerical source row check failed.')
            verification.append({'product': product, 'page': page_number, 'rows_checked': len(expected_rows)})
        if source.read_bytes() != original:
            raise ValueError('Source PDF changed during extraction.')
    payload = (json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode()
    assessment = policy.validate_assessment_payload(payload)
    with output.open('xb') as stream:
        stream.write(payload)
    receipt = {'schema_version': 1, 'dataset_id': policy.DATASET_ID, 'result': 'PASS',
               'importer_sha256': sha256(Path(__file__).read_bytes()).hexdigest(),
               'output': {'path': str(output), 'size': len(payload), 'sha256': sha256(payload).hexdigest()},
               'sources': source_refs, 'tables': len(assessment.tables), 'source_tables': 65,
               'independent_numeric_rows': verification,
               'boundary': 'Private numerical evidence only; no report text, application state, source catalog or public repository written.'}
    with output.with_suffix(output.suffix + '.receipt.json').open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cafco', required=True)
    parser.add_argument('--cp2', required=True)
    parser.add_argument('--fendolite', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    receipt = import_assessments([args.cafco, args.cp2, args.fendolite], args.output)
    print(json.dumps({'result': receipt['result'], 'output': receipt['output'], 'tables': receipt['tables']}))


if __name__ == '__main__':
    main()
