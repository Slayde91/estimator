"""Synthetic retained evidence for Technical Library export acceptance."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json

from PIL import Image, ImageDraw

from test_firestopping_library import editable_library

REPORT_URL = 'https://tfire.com.au/documents/synthetic-report.pdf'


def technical_library(root):
    data = editable_library(root)
    image = Image.new('RGB', (640, 360), 'white')
    drawing = ImageDraw.Draw(image)
    drawing.rectangle((35, 30, 250, 290), fill='#b71926')
    drawing.ellipse((390, 80, 550, 240), fill='#234d86')
    drawing.text((275, 300), 'SYNTHETIC SOURCE', fill='black')
    output = BytesIO()
    image.save(output, format='PNG')
    (root / 'images/diagram-a.png').write_bytes(output.getvalue())
    data['images'][0]['sha256'] = sha256(output.getvalue()).hexdigest()
    record = data['libraries']['technical']['items'][0]
    record['fields'] = [
        {'label': 'Manufacturer', 'value': 'Synthetic manufacturer'},
        {'label': 'System Products', 'value': '=Literal source text'},
        {'label': 'Installation Details', 'value': 'Retain original conditions.\nDo not infer technical suitability.'},
        {'label': 'Report Number', 'value': 'SYN-123\nUnlinked source report', 'report_links': [{'label': 'SYN-123', 'url': REPORT_URL}]},
        {'label': 'Service Size / Configuration', 'value': 'Independent source alternatives',
         'table': {'columns': ['Configuration', 'Service', 'FRL'], 'rows': [['source-a', 'Copper pipe 25 mm', '-/90/90'], ['source-b', 'Steel pipe 50 mm', '-/120/120']]}},
        {'label': 'Diagrams & Figures', 'value': '', 'images': [{'id': 'diagram-a', 'caption': 'Synthetic retained source diagram'}]},
        {'label': 'Lead Time', 'value': 'Hidden source metadata'},
    ]
    record['notice'] = 'Synthetic evidence only; retain every source condition.'
    second = deepcopy(record)
    second.update(id='report-a-v2', title='V2 — Separate source record', fields=[{'label': 'System Products', 'value': 'Separate second item'}])
    data['libraries']['technical']['items'].append(second)
    data['links'][0]['notice'] = 'A source relationship does not establish suitability.'
    (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
    return data
