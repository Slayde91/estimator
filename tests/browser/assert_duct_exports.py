"""Check the actual browser downloads against the selected reopened fixture item."""
import csv
import json
from pathlib import Path
import sys

from openpyxl import load_workbook


def assert_row(row, item, source, transfers):
    expected = {
        'Item ID': item['id'], 'Item version': item['version'], 'Mode': 'duct',
        'Mark / run': 'D-001', 'Level': item['fields']['level'],
        'Width mm': 600, 'Height mm': 400, 'Quantity': item['quantity'],
        'Length per item m': 10, 'Total length m': 10 * item['quantity'],
        'FRL': '120/120/120', 'Product': 'FyreWrap', 'Exposure': 'Internal',
        'Source document ID': source['id'], 'Source document': source['name'],
        'Source page': item['geometry']['page'],
        'Confirmation ID': item['confirmation']['id'],
    }
    for key, value in expected.items():
        actual = row[key]
        if isinstance(value, (int, float)):
            assert float(actual) == value, (key, actual, value)
        else:
            assert actual == value, (key, actual, value)
    assert 'Source SHA-256' not in row
    assert 'Confirmation digest' not in row
    assert json.loads(row['Geometry PDF points']) == item['geometry']['points']
    assert json.loads(row['Measurement basis']) == item['measurement']
    references = json.loads(row['Evidence references'])
    assert len(references) == len(item['evidence'])
    for actual, retained in zip(references, item['evidence']):
        assert all(actual[key] == value for key, value in retained.items())
    actual_transfers = json.loads(row['Transfer references'])
    assert {entry['id'] for entry in actual_transfers} == {entry['id'] for entry in transfers}
    assert any(entry['calculator_id'] == 'ductwork' for entry in actual_transfers)


def main():
    expected_path, csv_path, xlsx_path = map(Path, sys.argv[1:])
    expected = json.loads(expected_path.read_text(encoding='utf-8'))
    snapshot = expected['snapshot']
    item = next(item for item in snapshot['items'] if item['id'] == expected['itemId'])
    source = next(source for source in snapshot['documents'] if source['id'] == item['geometry']['document_id'])
    transfers = [entry for entry in snapshot['transfers'] if entry['item_id'] == item['id']]
    with csv_path.open(encoding='utf-8-sig', newline='') as stream:
        csv_rows = list(csv.DictReader(stream))
    assert len(csv_rows) == 1, 'CSV exports exactly the selected item'
    assert_row(csv_rows[0], item, source, transfers)
    workbook = load_workbook(xlsx_path, read_only=True, data_only=False)
    try:
        sheet = workbook['Confirmed Takeoffs']
        values = list(sheet.values)
        assert len(values) == 2, 'XLSX exports a header and exactly the selected item'
        xlsx_row = dict(zip(values[0], values[1]))
        assert_row(xlsx_row, item, source, transfers)
        assert all(cell.data_type != 'f' for row in sheet for cell in row), 'Register contains literal values'
    finally:
        workbook.close()
    print(json.dumps({'csv': str(csv_path), 'xlsx': str(xlsx_path), 'rows': 1,
                      'itemId': item['id'], 'sourceId': source['id'], 'sourceSha256': source['sha256'],
                      'dimensions': [600, 400], 'lengthPerItem': 10,
                      'fieldsAndProvenanceVerified': True, 'literalXlsxValues': True}))


if __name__ == '__main__':
    main()
