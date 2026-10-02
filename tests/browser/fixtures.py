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


def make_physical_pdf(path, *, version=1):
    """Repeated embedded bitmap views never imply distinct physical quantities."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from PIL import Image, ImageDraw
    photograph = Image.new('RGB', (640, 360), '#b9b8b3')
    ink = ImageDraw.Draw(photograph)
    ink.rectangle((30, 25, 610, 335), outline='#555753', width=8)
    ink.ellipse((95, 90, 245, 240), fill='#24272b', outline='#ddddcf', width=8)
    ink.ellipse((365, 90, 535, 260), fill='#24272b', outline='#ddddcf', width=8)
    ink.line((430, 40, 430, 305), fill='#b87642', width=27)
    ink.line((477, 50, 477, 308), fill='#192149', width=8)
    ink.line((489, 50, 489, 308), fill='#253162', width=8)
    ink.line((501, 50, 501, 308), fill='#303e7d', width=8)
    ink.text((90, 275), 'EMPTY CORE', fill='black')
    ink.text((355, 315), 'ONE PIPE + THREE CABLES', fill='black')
    drawing = canvas.Canvas(str(path), pagesize=(842, 595), invariant=1)
    drawing.setFont('Helvetica', 16)
    drawing.drawString(35, 555, 'SYNTHETIC PHYSICAL DRAFT FIXTURE - NOT A SITE ASSESSMENT')
    drawing.setFont('Helvetica', 11)
    if version == 2:
        drawing.drawString(40, 526, 'Defect D-0001: L02 north, FRL -/120/120. Two concrete wall barriers, vertical, 150 mm.')
        drawing.drawString(40, 508, 'Barrier B-0001 has no service. Barrier B-0002 contains one copper pipe and three cables.')
    else:
        drawing.drawString(40, 526, 'Barrier B-01: concrete wall, vertical, 150 mm. Defect D-001: L02 north, FRL -/120/120.')
        drawing.drawString(40, 508, 'Opening O-EMPTY contains no service. Opening O-MIXED contains copper pipe and cables.')
    drawing.drawImage(ImageReader(photograph), 80, 230, width=480, height=270)
    drawing.drawImage(ImageReader(photograph), 40, 40, width=240, height=135)
    drawing.drawImage(ImageReader(photograph), 350, 40, width=240, height=135)
    drawing.drawString(40, 190, 'All three image occurrences repeat the same two views. Image count is not physical quantity.' if version == 2 else 'All three image occurrences repeat the same two openings. Image count is not physical quantity.')
    drawing.showPage()
    drawing.setFont('Helvetica', 14)
    drawing.drawString(40, 540, 'SYNTHETIC TEXT-ONLY REFERENCE PAGE: no embedded images.')
    drawing.setFont('Helvetica', 11)
    drawing.drawString(40, 510, 'This page corroborates the reference only. Do not invent images or placeholder physical records.')
    drawing.save()


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


def make_legacy_physical_project(folder, pdf):
    """Publish an original v1 hierarchy with a real source and untouched audit chain."""
    from copy import deepcopy
    from uuid import uuid4
    from estimator.native_dialogs import SaveSelection
    from estimator.project_library import ProjectLibrary
    from estimator.storage import Store
    from estimator.takeoff_documents import TakeoffDocuments
    from estimator.takeoff_model import upgrade_snapshot
    from estimator.takeoff_physical import new_graph
    from estimator.takeoff_physical_operations import prepare_changes
    from estimator.takeoff_workspace import TakeoffService
    project = folder / 'legacy-physical-project.json'
    store = Store(folder / 'legacy-fixture.sqlite3')
    documents = TakeoffDocuments(folder / 'legacy-staging')
    service = TakeoffService(store, documents)
    class LegacyDialogs:
        def choose_save(self, initial_directory, filename):
            return SaveSelection(str(project), None)
    library = ProjectLibrary(store, LegacyDialogs(), takeoffs=service)
    try:
        session = service.open(); sid = session['session_id']; payload = pdf.read_bytes()
        upload = documents.begin_upload(sid, pdf.name, len(payload))
        documents.write_chunk(sid, upload['upload_id'], 0, payload)
        document = documents.finish_upload(sid, upload['upload_id'])
        service.add_document(sid, document, session['revision'])
        before = deepcopy(service.get(sid)['snapshot'])
        legacy = {**before, 'physical': new_graph(before['project_id'], version=1)}
        ids = [str(uuid4()) for _ in range(4)]
        commands = []
        for index, kind in enumerate(('barrier', 'defect', 'opening', 'service')):
            entity = {'id': ids[index], 'fields': {'label': 'LEGACY-' + kind.upper()},
                      'evidence': [{'document_id': document['id'], 'document_sha256': document['sha256'], 'page': 1,
                                    'note': 'Retained pre-v2 association; do not infer new relationships.'}],
                      'uncertainty': {'state': 'human_review_required', 'note': 'Legacy topology awaiting assignment'}}
            if index:
                entity[('barrier_id', 'defect_id', 'opening_id')[index - 1]] = ids[index - 1]
            if kind == 'opening':
                entity['fields'].update(opening_type='Corehole', size='Legacy 100 mm')
            if kind == 'service':
                entity.update(quantity=3); entity['fields'].update(service='Cable', service_type='Electrical cable')
            commands.append({'op': 'create', 'kind': kind, 'entity': entity})
        after = upgrade_snapshot(before)
        after['physical'] = prepare_changes(legacy, commands, lambda reference: None)['graph']
        service._commit(sid, {'op': 'apply_physical', 'expected_revision': before['revision'], 'request_id': str(uuid4())}, before, after)
        saved = service.get(sid)
        library.save_as({'estimate': {'title': 'Synthetic legacy physical browser fixture'},
                         'takeoffs': saved['snapshot'], 'takeoffs_session_id': sid})
    finally:
        library.close(); documents.close()
    return project


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture-only')
    parser.add_argument('--directory')
    parser.add_argument('--physical-legacy', action='store_true')
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
        physical_fixture = folder / 'synthetic-physical-report.pdf'; make_physical_pdf(physical_fixture)
        physical_v2_fixture = folder / 'synthetic-physical-v2-report.pdf'; make_physical_pdf(physical_v2_fixture, version=2)
        legacy_project = make_legacy_physical_project(folder, physical_fixture) if args.physical_legacy else None
        project = folder / 'browser-project.json'
        class Dialogs:
            def choose_save(self, initial_directory, filename):
                return SaveSelection(str(project), file_fingerprint(project))
            def choose_open(self, initial_directory):
                return str(project) if project.exists() else None
            def choose_folder(self, initial_directory):
                return str(folder)
        server = create_server(0, folder / 'qa.sqlite3', project_dialogs=Dialogs())
        print(json.dumps({'port': server.server_port, 'fixture': str(fixture), 'failed_fixture': str(failed_fixture), 'board_fixture': str(board_fixture), 'area_fixture': str(area_fixture), 'physical_fixture': str(physical_fixture), 'physical_v2_fixture': str(physical_v2_fixture), 'legacy_project': str(legacy_project) if legacy_project else None, 'project': str(project), 'directory': str(folder)}), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
