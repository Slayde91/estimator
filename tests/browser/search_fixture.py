"""Disposable text-search sources; never runs against the live database or port."""
from io import BytesIO
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def make_search_pdf(path):
    from reportlab.pdfgen import canvas
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject, RectangleObject
    raw = BytesIO()
    drawing = canvas.Canvas(raw, pagesize=(600, 600), invariant=1)
    for y, prefix in ((500, 'Upper'), (300, 'Centre'), (90, 'Lower')):
        text = drawing.beginText(70, y)
        text.setFont('Helvetica', 14); text.textOut(prefix + ' fire rated ')
        text.setFont('Helvetica-Bold', 14); text.textOut('wall')
        text.setFont('Helvetica', 14); text.textOut(' protects cable. Other sentence.')
        drawing.drawText(text)
    drawing.showPage()
    drawing.rect(20, 20, 100, 100); drawing.showPage()
    drawing.setFont('Helvetica', 15); drawing.drawString(100, 300, 'The fire rated wall protects three services.'); drawing.showPage()
    drawing.setFont('Helvetica', 8)
    for line in range(51):
        drawing.drawString(20, 580 - line * 10, 'wall ' * 10)
    drawing.save()
    writer = PdfWriter()
    for page in PdfReader(raw).pages:
        writer.add_page(page)
    writer.pages[2].cropbox = RectangleObject([20, 30, 580, 570])
    writer.pages[2].rotate(90)
    writer.pages[2][NameObject('/UserUnit')] = NumberObject(2)
    with path.open('wb') as output:
        writer.write(output)


if __name__ == '__main__':
    from estimator.server import create_server
    from reportlab.pdfgen import canvas
    parser = argparse.ArgumentParser(); parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve(); folder.mkdir(parents=True, exist_ok=True)
    fixture = folder / 'search-sentences.pdf'; make_search_pdf(fixture)
    other = folder / 'other-document.pdf'
    drawing = canvas.Canvas(str(other), pagesize=(600, 600), invariant=1)
    drawing.setFont('Helvetica', 14); drawing.drawString(40, 450, 'Elsewhere fire rated wall.'); drawing.save()
    server = create_server(0, folder / 'qa.sqlite3')
    print(json.dumps({'port': server.server_port, 'fixture': str(fixture), 'other': str(other)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
