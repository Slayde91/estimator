"""Public synthetic scanned-label PDF; private drawing bytes never enter Git."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def make_label_pdf(path):
    from PIL import Image, ImageDraw, ImageFont
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject, RectangleObject
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    image = Image.new('RGB', (1400, 180), 'white')
    drawing = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(ROOT / 'static/fonts/Vera.ttf'), 48)
    drawing.text((15, 10), 'AIR CONDITIONER', font=font, fill='black')
    drawing.text((15, 76), 'BEYOND', font=font, fill='black')
    image_stream = BytesIO()
    image.save(image_stream, format='PNG')
    original = BytesIO()
    pdf = canvas.Canvas(original, pagesize=(600, 600), invariant=1)
    pdf.setFont('Helvetica', 12)
    pdf.drawString(40, 550, 'Native AIR CONDITIONER text remains searchable.')
    for x, y in ((80, 420), (200, 180)):
        pdf.drawImage(ImageReader(image_stream), x, y, width=350, height=45)
    pdf.showPage()
    # Deliberately sideways original page: OCR must handle quarter turns, then
    # invert CropBox/Rotate/UserUnit into the retained original coordinates.
    pdf.drawImage(ImageReader(image_stream), 80, 420, width=350, height=45)
    pdf.showPage()
    pdf.rect(100, 100, 200, 200)
    pdf.save()
    writer = PdfWriter()
    for page in PdfReader(original).pages:
        writer.add_page(page)
    writer.pages[1].cropbox = RectangleObject([20, 30, 580, 570])
    writer.pages[1].rotate(90)
    writer.pages[1][NameObject('/UserUnit')] = NumberObject(2)
    with path.open('wb') as stream:
        writer.write(stream)


if __name__ == '__main__':
    from estimator.server import create_server
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    folder = Path(parser.parse_args().directory).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    fixture = folder / 'scanned-drawing-labels.pdf'
    make_label_pdf(fixture)
    server = create_server(0, folder / 'qa.sqlite3')
    print(json.dumps({'port': server.server_port, 'fixture': str(fixture)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
