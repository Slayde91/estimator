"""Synthetic drawings and disposable native-dialog targets for browser QA."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def make_pdf(path):
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from PIL import Image, ImageDraw
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject, RectangleObject, DecodedStreamObject, DictionaryObject
    source = BytesIO()
    drawing = canvas.Canvas(source, pagesize=(842, 595), invariant=1)
    pdfmetrics.registerFont(TTFont('TakeoffFixture', str(ROOT / 'static/fonts/Montserrat-Variable.ttf')))
    drawing.setFont('TakeoffFixture', 18)
    drawing.drawString(35, 555, 'SYNTHETIC TAKEOFF DRAWING — L02')
    drawing.setFont('TakeoffFixture', 12)
    drawing.drawString(100, 425, 'B17 | 100UC15 | 10.0 m | CAFCO 300 | 120 min | 550 C | 3 sides')
    drawing.setStrokeColorRGB(.8, 0, 0); drawing.setLineWidth(6)
    drawing.line(100, 400, 500, 400)
    drawing.setStrokeColorRGB(0, .2, .8); drawing.setLineWidth(2)
    drawing.rect(100, 170, 400, 40)
    drawing.drawString(100, 225, 'D-001 | 600 x 400 | 10.0 m | FRL 120/120/120')
    drawing.drawString(100, 90, 'Calibration baseline = 10 m')
    drawing.line(100, 75, 500, 75)
    drawing.showPage()
    raster = Image.new('RGB', (800, 500), 'white')
    ink = ImageDraw.Draw(raster)
    ink.rectangle((100, 100, 700, 400), outline='blue', width=6)
    ink.line((100, 250, 700, 250), fill='red', width=10)
    drawing.drawImage(ImageReader(raster), 20, 20, width=800, height=500)
    drawing.showPage()
    drawing.setFont('TakeoffFixture', 16); drawing.drawString(100, 300, 'Rotated crop with UserUnit 2')
    drawing.line(100, 200, 500, 200); drawing.showPage(); drawing.save()
    reader = PdfReader(source); writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.pages[2].cropbox = RectangleObject([20, 30, 800, 570])
    writer.pages[2].rotate(90)
    writer.pages[2][NameObject('/UserUnit')] = NumberObject(2)
    # Exercise the bundled non-WASM JPEG2000 fallback under strict CSP.
    image = Image.new('RGB', (64, 64), (25, 145, 70)); encoded = BytesIO()
    image.save(encoded, format='JPEG2000')
    from pypdf.generic import EncodedStreamObject
    obj = EncodedStreamObject(); obj._data = encoded.getvalue()
    obj.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                NameObject('/Width'): NumberObject(64), NameObject('/Height'): NumberObject(64),
                NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8),
                NameObject('/Filter'): NameObject('/JPXDecode')})
    page = writer.add_blank_page(300, 300)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/Im0'): writer._add_object(obj)})})
    stream = DecodedStreamObject(); stream.set_data(b'q 220 0 0 220 40 40 cm /Im0 Do Q')
    page[NameObject('/Contents')] = writer._add_object(stream)
    with Path(path).open('wb') as output:
        writer.write(output)


def make_board_pdf(path):
    """Explicitly artificial board requirements for transfer browser acceptance."""
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont('BoardFixture', str(ROOT / 'static/fonts/Montserrat-Variable.ttf')))
    drawing = canvas.Canvas(str(path), pagesize=(842, 595), invariant=1)
    drawing.setFont('BoardFixture', 18)
    drawing.drawString(35, 555, 'SYNTHETIC BOARD TRANSFER ACCEPTANCE - NOT A PROJECT DESIGN')
    drawing.setFont('BoardFixture', 11)
    drawing.drawString(75, 490, 'Supported test requirements: 100UC15 | TRAFALGAR COREX | Beam | 120 min | 620 C | 3 sides')
    drawing.drawString(100, 425, 'BOARD-MEASURED | 2 separate physical members | 10.0 m EACH')
    drawing.setStrokeColorRGB(.8, 0, 0); drawing.setLineWidth(5)
    drawing.line(100, 400, 500, 400)
    drawing.drawString(100, 285, 'BOARD-CITED | 3 separate physical members | 7.25 m EACH')
    drawing.setStrokeColorRGB(0, .2, .8); drawing.setLineWidth(2)
    drawing.rect(100, 230, 290, 20)
    drawing.drawString(100, 180, 'BOARD-UNSUPPORTED | 1 beam | 10.0 m | COREX | 120 min | 550 C | 3 sides')
    drawing.drawString(100, 160, 'Deliberately unsupported: transfer must preserve requirements and refuse this row.')
    drawing.drawString(100, 90, 'Calibration baseline = 10 m; uniform horizontal and vertical scale')
    drawing.line(100, 75, 500, 75)
    drawing.save()


def make_failed_image_pdf(path):
    """Structurally valid PDF whose image bytes cannot be decoded completely."""
    from pypdf import PdfWriter
    from pypdf.generic import (NameObject, NumberObject, DictionaryObject,
                              EncodedStreamObject, DecodedStreamObject)
    writer = PdfWriter(); page = writer.add_blank_page(300, 300)
    broken = EncodedStreamObject(); broken._data = b'not-a-jpeg-image'
    broken.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                   NameObject('/Width'): NumberObject(64), NameObject('/Height'): NumberObject(64),
                   NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8),
                   NameObject('/Filter'): NameObject('/DCTDecode')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/Im0'): writer._add_object(broken)})})
    contents = DecodedStreamObject(); contents.set_data(b'q 220 0 0 220 40 40 cm /Im0 Do Q')
    page[NameObject('/Contents')] = writer._add_object(contents)
    with Path(path).open('wb') as stream:
        writer.write(stream)


def make_area_pdf(path):
    """True-plane synthetic wall/slab surfaces, with an offset rotated copy."""
    from reportlab.pdfgen import canvas
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject, RectangleObject
    source = BytesIO()
    drawing = canvas.Canvas(source, pagesize=(842, 595), invariant=1)
    for name in ('WALL ELEVATION: ONE TREATED FACE', 'SLAB SOFFIT: TRUE-PLANE SURFACE'):
        drawing.setFont('Helvetica', 16)
        drawing.drawString(50, 550, 'SYNTHETIC AREA ACCEPTANCE - NOT A PROJECT DESIGN')
        drawing.setFont('Helvetica', 11)
        drawing.drawString(100, 510, name)
        drawing.drawString(100, 490, 'Concrete | nominated board treatment | FRL 120/120/120')
        drawing.setLineWidth(2)
        drawing.rect(100, 200, 400, 240)
        drawing.setStrokeColorRGB(.8, 0, 0)
        drawing.rect(180, 260, 80, 80)
        drawing.setStrokeColorRGB(0, 0, 0)
        drawing.drawString(100, 170, 'Surface: 10 m x 6 m = 60 m2; exclusion: 2 m x 2 m = 4 m2')
        drawing.drawString(100, 150, 'Net treated area = 56 m2. One physical surface; no inferred faces.')
        drawing.drawString(100, 100, 'Baseline 10 m. Uniform scale in both axes.')
        drawing.line(100, 75, 500, 75)
        drawing.showPage()
    drawing.save()
    writer = PdfWriter()
    for page in PdfReader(source).pages:
        writer.add_page(page)
    writer.pages[1].cropbox = RectangleObject([20, 30, 800, 570])
    writer.pages[1].rotate(90)
    writer.pages[1][NameObject('/UserUnit')] = NumberObject(2)
    with Path(path).open('wb') as stream:
        writer.write(stream)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture-only')
    parser.add_argument('--directory')
    args = parser.parse_args()
    if args.fixture_only:
        make_pdf(args.fixture_only)
    else:
        from estimator.server import create_server
        from estimator.native_dialogs import SaveSelection
        from estimator.project_library import file_fingerprint
        folder = Path(args.directory or tempfile.mkdtemp(prefix='ceasefire-takeoffs-browser-')).resolve()
        folder.mkdir(parents=True, exist_ok=True)
        fixture = folder / 'synthetic-drawings.pdf'; make_pdf(fixture)
        failed_fixture = folder / 'failed-image.pdf'; make_failed_image_pdf(failed_fixture)
        board_fixture = folder / 'synthetic-board.pdf'; make_board_pdf(board_fixture)
        area_fixture = folder / 'synthetic-surfaces.pdf'; make_area_pdf(area_fixture)
        project = folder / 'browser-project.json'
        class Dialogs:
            def choose_save(self, initial_directory, filename):
                return SaveSelection(str(project), file_fingerprint(project))
            def choose_open(self, initial_directory):
                return str(project) if project.exists() else None
            def choose_folder(self, initial_directory):
                return str(folder)
        server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs())
        print(json.dumps({'port': server.server_port, 'fixture': str(fixture), 'failed_fixture': str(failed_fixture), 'board_fixture': str(board_fixture), 'area_fixture': str(area_fixture), 'project': str(project), 'directory': str(folder)}), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
