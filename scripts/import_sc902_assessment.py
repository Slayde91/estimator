"""Extract the private FC18580-01-01 SC902 matrix from the reviewed full PDF.

Two independent coordinate readers must agree at every table position before
writing. Blank cells and applicable red values retain their exact positions.
Both paths are explicit; outputs must remain private, outside this checkout.
Existing evidence and verification receipts are never overwritten.
"""

import argparse
from collections import defaultdict
from decimal import Decimal
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
DATASET_ID = 'nullifire-sc902-fc18580-01-01'
SOURCE_FILENAME = 'FC18580-01-01-Nullifire-SC902-2020-REPORT-Final.pdf'
REPORT_SHA256 = '3bf3499358d6f2e4b75a8ed1402995cba8f9f72142ee81e79ed22fc73e4a4344'
TEMPERATURES = (350, 400, 450, 500, 520, 550, 580, 600, 620, 650, 700, 750)
PERIODS = (15, 30, 45, 60, 75, 90, 105, 120)
CASES = ('R3', 'R4', 'RHS', 'CHS')
MAX_REPORT_BYTES = 20 * 1024 * 1024


def _safe_path(path):
    path = Path(path).absolute()
    for candidate in (path, *path.parents):
        if not candidate.exists() and not candidate.is_symlink():
            continue
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Private assessment paths cannot be redirected.')
    return path.resolve()


def encode(value):
    return (json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def pypdf_grid(page, temperatures):
    chunks = []
    def visitor(text, cm, tm, font, size):
        text = text.strip()
        if re.fullmatch(r'\d+(?:\.\d+)?', text) and abs(size - 9.96) < .05:
            if cm != [1., 0., 0., 1., 0., 0.]:
                raise ValueError('Unexpected PDF coordinate transform')
            chunks.append((text, tm[4], tm[5]))
    page.extract_text(visitor_text=visitor)
    candidates = defaultdict(list)
    for t, x, y in chunks:
        if '.' not in t and int(t) in TEMPERATURES and y > 650:
            candidates[round(y, 2)].append((int(t), x, y))
    matches = [sorted(row, key=lambda v: v[1]) for row in candidates.values()
               if tuple(v[0] for v in sorted(row, key=lambda v: v[1])) == temperatures]
    if len(matches) != 1:
        raise ValueError('Independent temperature header differs')
    headers = matches[0]
    header_y = headers[0][2]
    anchors = [(int(t), x, y) for t, x, y in chunks if '.' not in t and x < headers[0][1] - 12 and 65 < y < header_y - 6]
    if len({t for t, _, _ in anchors}) != len(anchors):
        raise ValueError('Independent factor rows are ambiguous')
    values = {f: [None] * len(temperatures) for f, _, _ in anchors}
    for text, x, y in chunks:
        if '.' not in text:
            continue
        # Some source digits are separate PDF text runs; join only within this cell.
        suffix = sorted((xx, part) for part, xx, yy in chunks
                        if '.' not in part and abs(yy - y) <= .1 and x < xx < x + 30)
        text += ''.join(part for _, part in suffix)
        row = min(anchors, key=lambda item: abs(item[2] - y))
        column = min(range(len(headers)), key=lambda i: abs(headers[i][1] - x))
        if abs(row[2] - y) > .1 or abs(headers[column][1] - x) > 8 or values[row[0]][column] is not None:
            raise ValueError('Independent thickness coordinate is ambiguous')
        if not re.fullmatch(r'\d+\.\d{1,3}', text):
            raise ValueError('Source precision exceeds integer micrometres')
        values[row[0]][column] = int(Decimal(text) * 1000)
    return values


def plumber_grid(page, temperatures):
    words = page.extract_words(extra_attrs=['non_stroking_color'])
    candidates = defaultdict(list)
    for word in words:
        if word['text'] in {str(t) for t in TEMPERATURES} and word['top'] < 180:
            candidates[round(word['top'], 2)].append(word)
    matches = [sorted(row, key=lambda w: w['x0']) for row in candidates.values()
               if tuple(int(w['text']) for w in sorted(row, key=lambda w: w['x0'])) == temperatures]
    if len(matches) != 1:
        raise ValueError('Coordinate temperature header differs')
    headers = matches[0]
    tables = page.find_tables()
    if len(tables) != 1:
        raise ValueError('Unexpected table count')
    bounds = tables[0].bbox
    anchors = [w for w in words if re.fullmatch(r'\d+', w['text'])
               and w['x1'] < headers[0]['x0'] - 10 and headers[0]['bottom'] < w['top'] < bounds[3]]
    factors = [int(w['text']) for w in anchors]
    if len(set(factors)) != len(factors):
        raise ValueError('Coordinate factor rows are ambiguous')
    values = {f: [None] * len(temperatures) for f in factors}
    red = {f: [False] * len(temperatures) for f in factors}
    center = lambda word: ((word['x0'] + word['x1']) / 2, (word['top'] + word['bottom']) / 2)
    for word in words:
        if not re.fullmatch(r'\d+\.\d{1,3}', word['text']):
            continue
        x, y = center(word)
        if not (bounds[0] < x < bounds[2] and headers[0]['bottom'] < y < bounds[3]):
            continue
        row = min(anchors, key=lambda item: abs(center(item)[1] - y))
        column = min(range(len(headers)), key=lambda i: abs(center(headers[i])[0] - x))
        factor = int(row['text'])
        if abs(center(row)[1] - y) > .1 or abs(center(headers[column])[0] - x) > 1 or values[factor][column] is not None:
            raise ValueError('Coordinate thickness assignment is ambiguous')
        values[factor][column] = int(Decimal(word['text']) * 1000)
        color = tuple(word['non_stroking_color'])
        if color not in ((1., 0., 0.), (0.,), (0., 0., 0.)):
            raise ValueError('Unexpected thickness text color: ' + str(color))
        red[factor][column] = color == (1., 0., 0.)
    return values, red


def extract_dataset(report):
    """Return deterministic data only when the entire reviewed matrix agrees."""
    report = _safe_path(report)
    with report.open('rb') as stream:
        payload = stream.read(MAX_REPORT_BYTES + 1)
    if len(payload) > MAX_REPORT_BYTES or sha256(payload).hexdigest() != REPORT_SHA256:
        raise ValueError('The report does not match the reviewed FC18580-01-01 source.')
    import pdfplumber
    from pypdf import PdfReader

    independent = PdfReader(BytesIO(payload))
    if len(independent.pages) != 53:
        raise ValueError('The complete reviewed report must contain 53 pages.')
    combined = {}
    with pdfplumber.open(BytesIO(payload)) as reader:
        if len(reader.pages) != 53 or len(independent.pages) != 53:
            raise ValueError('The complete report must have 53 pages')
        for number in range(9, 54):
            text = independent.pages[number - 1].extract_text()
            match = re.search(r'Table\s+(\d+)(/cont)?\s*:\s*Nullifire SC901/902 (.*?)\s*[\u2013-]\s*(\d+) Minutes', text)
            if match is None:
                raise ValueError('Source table heading not found on page ' + str(number))
            table = int(match[1]); period = int(match[4]); case = CASES[(table - 3) // 8]
            if period != PERIODS[(table - 3) % 8]:
                raise ValueError('Source table period mismatch')
            temperatures = tuple(t for t in TEMPERATURES if t != 520 or case not in ('R3', 'R4'))
            grid, red = plumber_grid(reader.pages[number - 1], temperatures)
            other = pypdf_grid(independent.pages[number - 1], temperatures)
            if grid != other:
                raise ValueError('Full independent comparison differs on page ' + str(number))
            identity = case, period
            record = combined.setdefault(identity, {'case': case, 'period_min': period, 'table': table,
                'source_heading': match[3], 'temperatures_c': list(temperatures), 'pages': [], 'rows': {}, 'mesh_required': case == 'RHS'})
            if set(record['rows']) & set(grid):
                raise ValueError('Continued source factor row overlaps')
            record['pages'].append(number)
            for factor, values in grid.items():
                record['rows'][factor] = {'factor': factor, 'dft_um': values,
                    'red_applicable': red[factor], 'page': number}
    tables = []
    for case in CASES:
        for period in PERIODS:
            record = combined[case, period]
            rows = [record['rows'][factor] for factor in sorted(record['rows'])]
            record['factors'] = [row['factor'] for row in rows]
            record['dft_um'] = [row['dft_um'] for row in rows]
            record['red_applicable'] = [row['red_applicable'] for row in rows]
            record['source_pages_by_row'] = [row['page'] for row in rows]
            del record['rows']
            tables.append(record)
    data = {'schema_version': 1, 'id': 'nullifire-sc902-fc18580-01-01',
        'source': {'report': 'FC18580-01-01', 'date': '2024-03-20', 'sha256': REPORT_SHA256,
                   'filename': SOURCE_FILENAME, 'pages': 53},
        'thickness_unit': 'micrometre', 'source_table_unit': 'decimal millimetres; exact integer micrometres',
        'temperatures_c': list(TEMPERATURES), 'periods_min': list(PERIODS), 'tables': tables}
    return data


def import_assessment(report, output):
    output = _safe_path(output)
    if output.is_relative_to(ROOT.resolve()) or output == output.parent:
        raise ValueError('Private assessment output must remain outside the repository.')
    receipt_path = output.with_suffix('.verification.json')
    if output.exists() or receipt_path.exists():
        raise FileExistsError('Existing private evidence or verification receipts are never overwritten.')
    data = extract_dataset(report)
    payload = encode(data)
    # Use the same bounded, pinned authority as runtime and packaging.
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from estimator.sc902_assessment import validate_assessment_payload
    assessment = validate_assessment_payload(payload)
    cells = [value for table in data['tables'] for row in table['dft_um'] for value in row]
    receipt = {'id': DATASET_ID, 'dataset_sha256': assessment.digest,
               'report_sha256': assessment.report_sha256, 'bytes': len(payload),
               'tables': len(data['tables']), 'table_pages': 45, 'positions': len(cells),
               'numeric_cells': sum(v is not None for v in cells),
               'blank_cells': sum(v is None for v in cells),
               'red_applicable_cells': sum(v for table in data['tables'] for row in table['red_applicable'] for v in row),
               'independent_position_comparison': 'all 45 table pages match exactly',
               'thickness_unit': 'micrometre; printed millimetres multiplied exactly by 1000'}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream:
        stream.write(payload)
    with receipt_path.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(import_assessment(args.report, args.output), indent=2))


if __name__ == '__main__':
    main()
