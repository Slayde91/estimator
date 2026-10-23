"""Extract the private FC21221 certificate using two independent PDF readers.

The report and generated matrix must stay outside a Git checkout. No report or
published thickness matrix is embedded in this importer. Values become exact
integer micrometres; a printed dash remains null, never zero or an estimate.
"""
from argparse import ArgumentParser
from collections import Counter
from decimal import Decimal
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import sys

import pdfplumber
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from estimator.firetex_assessment import authority_for

REPORT_SHA256 = '3b3703934511e1e30c86474fb023aee343f66a172537e9adcbcc1588cad6c5c3'
REPORT_FILENAME = 'FC21221-01-1-C1 - 31-10-2025.pdf'
MAX_REPORT_BYTES = 16 * 1024 * 1024
DATASET_ID = 'firetex-fx6010-fc21221-01-1-c1'
PERIODS = (15, 20, 30, 45, 60, 75, 90, 105, 120)
GROUPS = (
    ('R3', 1, 9, 50, 400, (350, 400, 450, 500, 550, 580, 600, 620, 650, 700, 750)),
    ('R4', 10, 19, 50, 475, (350, 400, 450, 500, 550, 580, 600, 650, 700, 750)),
    ('H3', 20, 28, 40, 350, (350, 400, 450, 500, 550, 600, 620, 650, 700, 750)),
    ('H4', 29, 37, 50, 355, (350, 400, 450, 500, 520, 550, 600, 650, 700, 750)),
    ('CHS', 38, 46, 50, 330, (350, 400, 450, 500, 520, 550, 600, 650, 700, 750)),
)
TOKEN = re.compile(r'^(?:\d+(?:\.\d{1,3})?|-)$')
ROW = re.compile(r'^\s*(\d{2,3})\s+((?:(?:\d+(?:\.\d{1,3})?|-)\s*)+)$')


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def micrometres(token):
    if token == '-':
        return None
    if not TOKEN.fullmatch(token):
        raise ValueError(f'Unexpected thickness token: {token!r}')
    scaled = Decimal(token) * 1000
    if scaled != scaled.to_integral_value() or scaled <= 0:
        raise ValueError(f'Non-exact or nonpositive micrometre thickness: {token}')
    return int(scaled)


def require_external(path, label):
    if not path.is_absolute():
        raise ValueError(f'{label} must be an explicit absolute path.')
    resolved = path.resolve()
    for anchor in (Path(__file__).resolve().parent, resolved.parent):
        for parent in (anchor, *anchor.parents):
            if (parent / '.git').exists() and resolved.is_relative_to(parent.resolve()):
                raise ValueError(f'{label} must remain outside the Git checkout.')
    return resolved


def text_table(page, table, factors, temperatures, period):
    text = page.extract_text()
    title = re.search(r'Table\s+(\d+):\s+FIRETEX FX\s?6010\s+(.+?):\s*Fire Resistance Period\s+(\d+)\s+Minutes', text)
    if not title or int(title[1]) != table or int(title[3]) != period:
        raise ValueError(f'Unexpected table heading on PDF page {table + 1}.')
    lines = text.splitlines()
    header_rows = [index for index, line in enumerate(lines) if line.split() == list(map(str, temperatures))]
    if len(header_rows) != 1:
        raise ValueError(f'Temperature heading differs on table {table}.')
    matrix, found = [], []
    for line in lines[header_rows[0] + 1:]:
        if 'Thickness is intumescent only.' in line:
            break
        match = ROW.fullmatch(line)
        if not match:
            continue
        values = match[2].split()
        if len(values) != len(temperatures):
            raise ValueError(f'Table {table}, factor {match[1]} has {len(values)} text cells.')
        found.append(int(match[1]))
        matrix.append([micrometres(value) for value in values])
    if found != factors:
        raise ValueError(f'Factor rows differ on table {table}: {found}.')
    notes = text.split('Thickness is intumescent only.', 1)
    if len(notes) != 2:
        raise ValueError(f'Missing intumescent-only qualification on table {table}.')
    return matrix, {'heading': title.group(0), 'footnotes': 'Thickness is intumescent only. ' + ' '.join(notes[1].split())}


def coordinate_table(page, table, factors, temperatures):
    words = page.extract_words(x_tolerance=1, y_tolerance=1, extra_attrs=['non_stroking_color'])
    groups = []
    for word in sorted(words, key=lambda item: ((item['top'] + item['bottom']) / 2, item['x0'])):
        centre = (word['top'] + word['bottom']) / 2
        target = next((group for group in groups if abs(group[0] - centre) <= 1), None)
        if target is None:
            target = [centre, []]
            groups.append(target)
        target[1].append(word)
    headers = []
    for y, row in groups:
        numbers = sorted([word for word in row if re.fullmatch(r'\d{3}', word['text'])], key=lambda item: item['x0'])
        if [word['text'] for word in numbers] == list(map(str, temperatures)):
            headers.append((y, numbers))
    if len(headers) != 1:
        raise ValueError(f'Coordinate temperature headings differ on table {table}.')
    header_y, header = headers[0]
    centres = [(word['x0'] + word['x1']) / 2 for word in header]
    spacing = min(b - a for a, b in zip(centres, centres[1:]))
    factor_limit = centres[0] - spacing / 2
    row_labels = sorted([word for word in words
                         if (word['x0'] + word['x1']) / 2 < factor_limit
                         and (word['top'] + word['bottom']) / 2 > header_y + 2
                         and re.fullmatch(r'\d{2,3}', word['text'])], key=lambda item: item['top'])
    if [int(word['text']) for word in row_labels] != factors:
        raise ValueError(f'Coordinate factor rows differ on table {table}.')
    matrix, colours = [], Counter()
    for label in row_labels:
        y = (label['top'] + label['bottom']) / 2
        row = [word for word in words if abs((word['top'] + word['bottom']) / 2 - y) <= 1.5
               and (word['x0'] + word['x1']) / 2 >= factor_limit]
        values = []
        for x in centres:
            matches = [word for word in row if abs((word['x0'] + word['x1']) / 2 - x) < spacing * .45]
            if len(matches) != 1:
                raise ValueError(f'Table {table}, factor {label["text"]} has {len(matches)} coordinate cells at x={x}.')
            word = matches[0]
            values.append(micrometres(word['text']))
            colours[str(word.get('non_stroking_color'))] += 1
        if len(row) != len(temperatures):
            raise ValueError(f'Extra/unmapped coordinate word on table {table}, factor {label["text"]}.')
        matrix.append(values)
    return matrix, colours


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    source = require_external(args.report, 'Report')
    output = require_external(args.output, 'Output')
    receipt_path = require_external(args.receipt, 'Receipt')
    if output.exists() or receipt_path.exists() or len({source, output, receipt_path}) != 3:
        raise ValueError('Output and receipt must be distinct new files.')
    with source.open('rb') as stream:
        report_payload = stream.read(MAX_REPORT_BYTES + 1)
    if len(report_payload) > MAX_REPORT_BYTES:
        raise ValueError('Report exceeds its bounded input size.')
    digest = sha256(report_payload).hexdigest()
    if digest != REPORT_SHA256:
        raise ValueError('Report bytes differ from the reviewed FC21221-01-1-C1 source.')
    reader = PdfReader(BytesIO(report_payload))
    dataset = {'schema_version': 1, 'id': DATASET_ID, 'product': 'FIRETEX FX6010',
               'source': {'report': 'FC21221-01-1-C1', 'date': '2025-10-31', 'sha256': digest,
                          'filename': REPORT_FILENAME, 'pages': len(reader.pages)},
               'thickness_unit': 'micrometre', 'tables': []}
    receipt = {'schema_version': 1, 'source_sha256': digest, 'dataset_id': DATASET_ID,
               'methods': ['pypdf text rows with explicit dash positions', 'pdfplumber word coordinates and independent row/column assignment'],
               'tables': [], 'numeric_cell_colours': Counter()}
    if len(reader.pages) != 47:
        raise ValueError('Expected all 47 certificate pages.')
    with pdfplumber.open(BytesIO(report_payload)) as pdf:
        for case, first, last, low, high, temperatures in GROUPS:
            factors = list(range(low, high + 1, 5))
            periods = (*PERIODS, 150) if case == 'R4' else PERIODS
            for table, period in zip(range(first, last + 1), periods, strict=True):
                matrix, notes = text_table(reader.pages[table], table, factors, temperatures, period)
                coordinates, colours = coordinate_table(pdf.pages[table], table, factors, temperatures)
                if matrix != coordinates:
                    mismatches = [(factor, temperature, matrix[r][c], coordinates[r][c])
                                  for r, factor in enumerate(factors) for c, temperature in enumerate(temperatures)
                                  if matrix[r][c] != coordinates[r][c]]
                    raise ValueError(f'Table {table} reader mismatch: {mismatches[:10]}')
                record = {'case': case, 'period_min': period, 'table': table, 'pages': [table + 1],
                          'temperatures_c': list(temperatures), 'factors': factors, 'dft_um': matrix}
                dataset['tables'].append(record)
                flat = [value for row in matrix for value in row]
                receipt['tables'].append({'case': case, 'period_min': period, 'table': table, 'page': table + 1,
                                          'rows': len(factors), 'columns': len(temperatures),
                                          'positions_matched': len(flat), 'numeric': sum(value is not None for value in flat),
                                          'unavailable_dashes': sum(value is None for value in flat), **notes})
                receipt['numeric_cell_colours'].update(colours)
    payload = canonical(dataset)
    authority = authority_for(dataset['product'])
    if authority is None:
        raise ValueError('No reviewed authority covers this assessment output.')
    authority.validate_assessment_payload(payload)
    receipt.update(dataset_sha256=sha256(payload).hexdigest(), dataset_bytes=len(payload),
                   tables_matched=len(dataset['tables']), positions_matched=sum(item['positions_matched'] for item in receipt['tables']),
                   numeric=sum(item['numeric'] for item in receipt['tables']),
                   unavailable_dashes=sum(item['unavailable_dashes'] for item in receipt['tables']),
                   mismatches=0)
    receipt['numeric_cell_colours'] = dict(receipt['numeric_cell_colours'])
    with output.open('xb') as stream:
        stream.write(payload)
    with receipt_path.open('xb') as stream:
        stream.write(canonical(receipt))
    print(json.dumps({key: value for key, value in receipt.items() if key != 'tables'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
