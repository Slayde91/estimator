"""Import the reviewed private Perlifoc assessment without publishing its matrix.

Both --report and --output are explicit. Output must be outside this checkout.
The coordinate extraction is checked independently against PDF text rows before
any output is written. Blank source cells stay null. Existing files are never
overwritten. Only small identity/count receipts are printed.
"""

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import stat


ROOT = Path(__file__).resolve().parents[1]
DATASET_ID = 'perlifoc-fc21278-01-1'
REPORT_SHA256 = 'e2bec404557eee77dcdbbc68935701c2d960c5f3aac16299bca9dedc38c86c21'
TEMPERATURES = tuple(range(350, 751, 50))
FACTORS = (68, *range(70, 471, 10), 476)
PERIODS = (15, 30, 45, 60, 90, 120, 180, 240, 360)
CASES = ('R3', 'R4', 'H3', 'H4')
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


def _coordinate_values(page):
    """Use cell boundaries and vertical row positions; never collapse blanks."""
    tables = page.find_tables()
    if len(tables) != 1 or len(tables[0].rows[-1].cells) != len(PERIODS) + 1:
        raise ValueError('The source table structure is unexpected.')
    boxes = tables[0].rows[-1].cells
    anchors = []
    for word in page.crop(boxes[0]).extract_words():
        label = word['text']
        if not re.fullmatch(r'(?:≤68|\d+)', label):
            raise ValueError('An assessment factor label is invalid.')
        anchors.append((int(label.replace('≤', '')), (word['top'] + word['bottom']) / 2))
    if tuple(factor for factor, _ in anchors) != FACTORS:
        raise ValueError('Assessment factor rows differ from the reviewed grid.')
    values = [[None] * len(PERIODS) for _ in FACTORS]
    for column, box in enumerate(boxes[1:]):
        for word in page.crop(box).extract_words():
            if not re.fullmatch(r'\d+', word['text']):
                raise ValueError('A source thickness is not an integer.')
            y = (word['top'] + word['bottom']) / 2
            row = min(range(len(anchors)), key=lambda i: abs(anchors[i][1] - y))
            if abs(anchors[row][1] - y) >= 2 or values[row][column] is not None:
                raise ValueError('A source thickness cannot be assigned unambiguously.')
            values[row][column] = int(word['text'])
    return values


def _text_values(text):
    """Independent text extraction; fail if missing cells are not trailing."""
    rows = {}
    for line in text.splitlines():
        match = re.fullmatch(r'\s*(≤68|\d+)\s+((?:\d+\s*)+)\s*', line)
        if not match:
            continue
        factor = int(match[1].replace('≤', ''))
        if factor not in FACTORS:
            continue
        values = [int(value) for value in match[2].split()]
        if not 1 <= len(values) <= len(PERIODS) or factor in rows:
            raise ValueError('Independent text rows are ambiguous.')
        rows[factor] = values + [None] * (len(PERIODS) - len(values))
    if tuple(rows) != FACTORS:
        raise ValueError('Independent text factor rows are incomplete.')
    return [rows[factor] for factor in FACTORS]


def extract_dataset(report):
    """Return deterministic data only after two independent full-grid reads agree."""
    report = _safe_path(report)
    with report.open('rb') as stream:
        payload = stream.read(MAX_REPORT_BYTES + 1)
    if len(payload) > MAX_REPORT_BYTES or sha256(payload).hexdigest() != REPORT_SHA256:
        raise ValueError('The report does not match the reviewed FC21278-01-1 source.')
    import pdfplumber
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(payload))
    tables = []
    with pdfplumber.open(BytesIO(payload)) as pdf:
        if len(pdf.pages) != 46 or len(reader.pages) != 46:
            raise ValueError('The complete reviewed report must contain 46 pages.')
        for index in range(36):
            page = index + 11
            temperature = TEMPERATURES[index % len(TEMPERATURES)]
            case = CASES[index // len(TEMPERATURES)]
            values = _coordinate_values(pdf.pages[page - 1])
            independent = _text_values(reader.pages[page - 1].extract_text())
            if values != independent:
                raise ValueError(f'Independent extraction disagrees on PDF page {page}.')
            tables.append({'case': case, 'temperature': temperature, 'page': page,
                           'table': index + 5, 'values': values})
    return {'schema_version': 1, 'id': DATASET_ID,
            'source': {'report': 'FC21278-01-1', 'date': '2025-11-04',
                       'sha256': REPORT_SHA256, 'filename': report.name},
            'temperatures': list(TEMPERATURES), 'factors': list(FACTORS),
            'periods': list(PERIODS), 'tables': tables}


def import_assessment(report, output):
    output = _safe_path(output)
    if output.is_relative_to(ROOT.resolve()) or output == output.parent:
        raise ValueError('Private assessment output must remain outside the repository.')
    receipt_path = output.with_suffix('.verification.json')
    if output.exists() or receipt_path.exists():
        raise FileExistsError('Existing private evidence or verification receipts are never overwritten.')
    data = extract_dataset(report)
    payload = (json.dumps(data, indent=2, ensure_ascii=True, allow_nan=False) + '\n').encode('utf-8')
    cells = [value for table in data['tables'] for row in table['values'] for value in row]
    receipt = {'id': DATASET_ID, 'dataset_sha256': sha256(payload).hexdigest(),
               'report_sha256': REPORT_SHA256, 'bytes': len(payload), 'tables': len(data['tables']),
               'positions': len(cells), 'numeric_cells': sum(v is not None for v in cells),
               'blank_cells': sum(v is None for v in cells),
               'independent_text_comparison': 'all positions match'}
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
