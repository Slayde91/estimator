"""Check documents from the disposable library editor fixture only."""
import argparse
import base64
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from openpyxl import load_workbook
from PIL import Image
from pypdf import PdfReader
from estimator.penetration_calculator import calculate, definition


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capture', required=True, type=Path)
    parser.add_argument('--file', required=True, type=Path)
    args = parser.parse_args()
    captured = json.loads(args.capture.read_text(encoding='utf-8'))
    expected = calculate({'globals': captured['globals'], 'rows': [captured['item']]}, captured['configuration'])
    row = expected['rows'][0]
    diagram = captured.get('diagram')
    diagram_hash = sha256(base64.b64decode(diagram['content_base64'])).hexdigest() if diagram else None
    if args.file.suffix == '.pdf':
        reader = PdfReader(args.file)
        text = '\n'.join(page.extract_text() for page in reader.pages)
        assert captured['item']['inputs']['T'] in text
        assert 'Unscheduled composer retained' not in text
        images = [image.image for page in reader.pages for image in page.images]
        if diagram:
            source = Image.open(BytesIO(base64.b64decode(diagram['content_base64'])))
            assert sum(image.size == source.size for image in images) == 1
            assert diagram_hash in text and diagram['filename'] in text
        else:
            assert all(image.size != (640, 360) for image in images)
            assert 'No source diagram is attached to this current item.' in text
    else:
        workbook = load_workbook(args.file, data_only=False)
        assert 'Schedule' not in workbook.sheetnames
        inputs = {record[2]: record for record in workbook['Inputs'].iter_rows(min_row=5, values_only=True)}
        metadata = definition(captured['configuration'])
        assert len(inputs) == len(metadata['row_fields'])
        for field in metadata['row_fields']:
            value = row['inputs'].get(field['column'])
            assert inputs[field['column']][3] == (None if value == '' else value), field['column']
        assert workbook['Item']['B5'].value == captured['item']['id']
        assert workbook['Item']['B8'].value == expected['summary']['grand_total']
        values = '\n'.join(str(cell.value) for sheet in workbook for record in sheet for cell in record)
        assert 'Unscheduled composer retained' not in values
        assert all(cell.data_type != 'f' and cell.hyperlink is None for sheet in workbook for record in sheet for cell in record)
        if diagram_hash:
            assert diagram_hash in values
    print(json.dumps({'passed': True, 'file': args.file.name, 'diagram_sha256': diagram_hash, 'fields_exact': True}))


if __name__ == '__main__':
    main()
