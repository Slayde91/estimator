"""Extract private FC20571/01/C1 evidence with two independent PDF readers.

Every published position, including explicit dash cells, must agree. Input and
output paths are explicit, bounded and cannot use redirected filesystem paths.
Private evidence stays outside the checkout; existing outputs are not replaced.
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
DATASET_ID = 'firetex-fx5090-fc20571-01-c1'
SOURCE_FILENAME = 'FC20571-01-C1 FINAL.pdf'
REPORT_SHA256 = '3e26ff0c292717614fa8a6b5a691913b9f6ddfd0b8f44158d174ec74219fe07a'
MAX_REPORT_BYTES = 20 * 1024 * 1024
TEMPERATURES = tuple(range(350, 751, 50))
PERIODS_OPEN = (15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180)
PERIODS_H3 = (15, 30, 45, 60, 75, 90, 105, 120, 150)
PERIODS_H4 = (15, 20, 30, 45, 60, 75, 90, 105, 120)


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


def source_case(table):
    if table <= 11:
        return 'R3', PERIODS_OPEN[table - 1], tuple(range(55, 336, 5))
    if table <= 22:
        return 'R4', PERIODS_OPEN[table - 12], tuple(range(60, 376, 5))
    if table <= 31:
        return 'H3', PERIODS_H3[table - 23], tuple(range(50, 256, 5))
    return 'H4', PERIODS_H4[table - 32], tuple(range(40, 341, 5))


def micrometres(token):
    if token == '-':
        return None
    if not re.fullmatch(r'\d+\.\d{1,3}', token):
        raise ValueError('Unexpected source cell token ' + repr(token))
    exact = Decimal(token) * 1000
    if exact != int(exact):
        raise ValueError('Non-integer micrometre source thickness')
    return int(exact)


def plumber_grid(page, factors):
    words = page.extract_words(extra_attrs=['non_stroking_color', 'size'])
    candidates = defaultdict(list)
    for word in words:
        if word['text'] in {str(t) for t in TEMPERATURES} and word['top'] < 150:
            candidates[round(word['top'], 1)].append(word)
    matches = [sorted(row, key=lambda w: w['x0']) for row in candidates.values()
               if tuple(int(w['text']) for w in sorted(row, key=lambda w: w['x0'])) == TEMPERATURES]
    if len(matches) != 1:
        raise ValueError('pdfplumber temperature header ambiguous')
    headers = matches[0]
    tables = page.find_tables()
    if len(tables) != 1:
        raise ValueError('pdfplumber table bounds ambiguous')
    bbox = tables[0].bbox
    anchors = [w for w in words if re.fullmatch(r'\d+', w['text']) and w['x1'] < headers[0]['x0'] - 10
               and headers[0]['bottom'] < w['top'] < bbox[3]]
    if tuple(int(w['text']) for w in anchors) != factors:
        raise ValueError('pdfplumber factor axis differs')
    center = lambda w: ((w['x0'] + w['x1']) / 2, (w['top'] + w['bottom']) / 2)
    cells = {}
    for word in words:
        x, y = center(word)
        if not (headers[0]['bottom'] < word['top'] < bbox[3] and word['x0'] > anchors[0]['x1'] + 10):
            continue
        if not re.fullmatch(r'\d+\.\d{1,3}|-', word['text']):
            raise ValueError('Unexpected pdfplumber body token ' + repr(word['text']))
        row = min(anchors, key=lambda w: abs(center(w)[1] - y))
        col = min(range(9), key=lambda i: abs(center(headers[i])[0] - x))
        key = int(row['text']), col
        if abs(center(row)[1] - y) > .3 or abs(center(headers[col])[0] - x) > 1.5 or key in cells:
            raise ValueError('pdfplumber cell assignment ambiguous')
        if tuple(word['non_stroking_color']) not in ((0.,), (0., 0., 0.)):
            raise ValueError('Unexpected colored thickness')
        cells[key] = micrometres(word['text'])
    if len(cells) != len(factors) * 9:
        raise ValueError('pdfplumber did not account for every source position')
    return [[cells[f, col] for col in range(9)] for f in factors]


def pypdf_grid(page, factors):
    chunks = []
    def visitor(text, cm, tm, font, size):
        token = text.strip()
        if re.fullmatch(r'\d+(?:\.\d+)?|-', token) and 7.5 < size < 9.1:
            if cm != [1., 0., 0., 1., 0., 0.]:
                raise ValueError('Unexpected independent coordinate transform')
            chunks.append((token, tm[4], tm[5]))
    page.extract_text(visitor_text=visitor)
    candidates = defaultdict(list)
    for token, x, y in chunks:
        if token in {str(t) for t in TEMPERATURES} and y > 690:
            candidates[round(y, 1)].append((int(token), x, y))
    matches = [sorted(row, key=lambda v: v[1]) for row in candidates.values()
               if tuple(v[0] for v in sorted(row, key=lambda v: v[1])) == TEMPERATURES]
    if len(matches) != 1:
        raise ValueError('pypdf temperature header ambiguous')
    headers = matches[0]
    anchors = sorted([(int(t), x, y) for t, x, y in chunks if re.fullmatch(r'\d+', t)
                      and x < headers[0][1] - 12 and 100 < y < headers[0][2] - 5], key=lambda v: -v[2])
    if tuple(v[0] for v in anchors) != factors:
        raise ValueError('pypdf factor axis differs')
    parts = defaultdict(list)
    for token, x, y in chunks:
        if not (x > anchors[0][1] + 20 and anchors[-1][2] - .4 <= y < headers[0][2] - 5):
            continue
        row = min(anchors, key=lambda v: abs(v[2] - y))
        col = min(range(9), key=lambda i: abs(headers[i][1] - x))
        if abs(row[2] - y) > .3 or abs(headers[col][1] - x) > 20:
            raise ValueError('pypdf body token assignment ambiguous')
        parts[row[0], col].append((x, token))
    if len(parts) != len(factors) * 9:
        raise ValueError('pypdf did not account for every source position')
    return [[micrometres(''.join(token for _, token in sorted(parts[f, col]))) for col in range(9)] for f in factors]


def extract_dataset(report):
    report = _safe_path(report)
    with report.open('rb') as stream:
        payload = stream.read(MAX_REPORT_BYTES + 1)
    if len(payload) > MAX_REPORT_BYTES or sha256(payload).hexdigest() != REPORT_SHA256:
        raise ValueError('Report identity differs')
    import pdfplumber
    from pypdf import PdfReader

    independent = PdfReader(BytesIO(payload))
    if len(independent.pages) != 41:
        raise ValueError('Report page count differs')
    tables, receipts = [], []
    with pdfplumber.open(BytesIO(payload)) as reader:
        if len(reader.pages) != 41:
            raise ValueError('Independent report page count differs')
        for number in range(2, 42):
            text = independent.pages[number - 1].extract_text()
            heading = re.search(r'Table\s*(\d+): FIRETEX FX5090 (.*?): Fire Resistance Period (\d+) Minutes', text)
            if not heading or int(heading[1]) != number - 1:
                raise ValueError('Table/page identity differs on page ' + str(number))
            table = int(heading[1])
            case, period, factors = source_case(table)
            if int(heading[3]) != period:
                raise ValueError('Table period differs')
            if 'Thickness (mm) Required for a Design Temperature of' not in text:
                raise ValueError('Table units differ')
            values = plumber_grid(reader.pages[number - 1], factors)
            other = pypdf_grid(independent.pages[number - 1], factors)
            if values != other:
                raise ValueError('Independent whole-matrix comparison differs on page ' + str(number))
            footnote = text[text.index('Thickness is intumescent only.'):].strip()
            tables.append({'case': case, 'period_min': period, 'table': table, 'pages': [number],
                           'temperatures_c': list(TEMPERATURES), 'factors': list(factors), 'dft_um': values})
            receipts.append({'page': number, 'table': table, 'case': case, 'period_min': period,
                             'source_heading': heading[2], 'factor_min': factors[0], 'factor_max': factors[-1],
                             'factor_rows': len(factors), 'numeric_cells': sum(v is not None for row in values for v in row),
                             'dash_cells': sum(v is None for row in values for v in row), 'footnote': footnote,
                             'independent_comparison': 'all positions including explicit dash cells match exactly'})
    data = {'schema_version': 1, 'id': DATASET_ID, 'product': 'FIRETEX FX5090',
            'source': {'report': 'FC20571/01/C1', 'date': '2025-04-08', 'sha256': REPORT_SHA256,
                       'filename': SOURCE_FILENAME, 'pages': 41},
            'thickness_unit': 'micrometre', 'tables': tables}
    return data, receipts


def import_assessment(report, output):
    output = _safe_path(output)
    if output.is_relative_to(ROOT.resolve()) or output == output.parent:
        raise ValueError('Private assessment output must remain outside the repository.')
    receipt_path = _safe_path(output.with_suffix('.verification.json'))
    if output.exists() or receipt_path.exists():
        raise FileExistsError('Existing private evidence or verification receipts are never overwritten.')
    data, receipts = extract_dataset(report)
    encoded = encode(data)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from estimator.firetex_assessment import authority_for
    assessment = authority_for('FIRETEX FX5090').validate_assessment_payload(encoded)
    receipt = {'id': DATASET_ID, 'report_sha256': assessment.report_sha256,
               'dataset_sha256': sha256(encoded).hexdigest(), 'dataset_bytes': len(encoded), 'tables': 40,
               'positions': sum(r['factor_rows'] * 9 for r in receipts),
               'numeric_cells': sum(r['numeric_cells'] for r in receipts), 'dash_cells': sum(r['dash_cells'] for r in receipts),
               'unit_conversion': 'Published decimal millimetres multiplied exactly by 1000 using Decimal to integer micrometres.',
               'comparison': 'Independent pypdf text-run coordinates and pdfplumber word coordinates, including every explicit dash cell.',
               'importer_sha256': sha256(Path(__file__).read_bytes()).hexdigest(), 'pages': receipts}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream:
        stream.write(encoded)
    with receipt_path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(receipt, stream, ensure_ascii=False, indent=2); stream.write('\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    receipt = import_assessment(args.report, args.output)
    print(json.dumps({k: v for k, v in receipt.items() if k != 'pages'}, indent=2))


if __name__ == '__main__':
    main()
