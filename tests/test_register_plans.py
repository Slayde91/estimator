"""Pins use the immutable source sheet and the displayed (rotated and cropped) viewport."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from pypdf import PdfReader, Transformation
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, RectangleObject
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.passive_fire_register import normalize_register, render_register_pdf
from estimator.register_plans import append_plan_pages, normalize_pins
from estimator.storage import Store
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_pdf_worker import parse_pdf_stream
from estimator.takeoff_workspace import TakeoffService
from test_passive_fire_register import completed_entry
from test_takeoff_pdf_tools import drawing


class RegisterPlansTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name)
        documents = TakeoffDocuments(path / 'evidence')
        self.addCleanup(documents.close)
        self.service = TakeoffService(Store(path / 'state.sqlite3'), documents)
        state = self.service.open()
        self.session, self.project = state['session_id'], state['snapshot']['project_id']
        self.original = drawing('Synthetic drawing', pages=4)
        upload = documents.begin_upload(self.session, 'Synthetic plan.pdf', len(self.original))['upload_id']
        documents.write_chunk(self.session, upload, 0, self.original)
        self.doc = documents.finish_upload(self.session, upload)
        self.service.add_document(self.session, self.doc, 0)
        self.sessions = {self.project:self.session}
        self.pin = {'project_id':self.project, 'document_id':self.doc['id'], 'sha256':self.doc['sha256'],
                    'page':2, 'x':.18, 'y':.70}
        first, second = completed_entry(), completed_entry()
        first['plan_pins'] = [self.pin, {**self.pin, 'page':4, 'x':.52, 'y':.34}]
        second.update(access='NA', plan_pins=[{**self.pin, 'x':.63, 'y':.25}])
        self.register = normalize_register({'entries':[first, second]})

    def export(self):
        return render_register_pdf(self.register, {'client':'Synthetic QA', 'site_address':'Training site'},
            company=DEFAULTS, plan_append=lambda pdf, rows: append_plan_pages(pdf, rows, self.sessions, self.service))

    def test_only_pinned_sheets_follow_register_and_group_all_entry_side_ids(self):
        output = self.export()
        pdf = PdfReader(BytesIO(output))
        pages = parse_pdf_stream(BytesIO(output))['pages']
        texts = [page.extract_text() for page in pdf.pages]
        self.assertTrue(all('Synthetic drawing' not in text for text in texts[:-2]))
        self.assertIn('Synthetic drawing page 2', texts[-2])
        self.assertIn('001 / 001-2', texts[-2])
        self.assertIn('002', texts[-2])
        self.assertNotIn('002-2', texts[-2])
        self.assertIn('Synthetic drawing page 4', texts[-1])
        self.assertIn('001 / 001-2', texts[-1])
        self.assertNotIn('002', texts[-1])
        for index in (-2, -1):
            self.assertEqual(pages[index], {**pages[0], 'page':len(pages) + index + 1})
        self.assertEqual(self.service.documents.document_path(self.doc).read_bytes(), self.original)

    def test_unrelated_session_changed_sha_and_removed_source_do_not_export(self):
        rows = self.register['entries']
        other = self.service.open()['session_id']
        for sessions in ({}, {self.project:other}):
            with self.subTest(sessions=sessions), self.assertRaises(ValidationError):
                append_plan_pages(b'', rows, sessions, self.service)
        for change in ({'sha256':'0'*64}, {'page':7}, {'document_id':str(uuid4())}):
            altered = deepcopy(rows)
            altered[0]['plan_pins'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValidationError):
                append_plan_pages(b'', altered, self.sessions, self.service)
        forged = self.service.open(self.service.get(self.session)['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'evidence'):
            append_plan_pages(b'', rows, {self.project:forged['session_id']}, self.service)

    def test_portrait_and_landscape_appendices_keep_pin_on_source_point_for_every_crop_and_rotation(self):
        def oversize_plans(writer):
            for index, page in enumerate(writer.pages):
                bounds = [12, 7, 75, 140] if index >= 4 else list(page.cropbox)
                x0, y0, x1, y1 = bounds
                fx, fy = {0: (.2, .7), 90: (.3, .2), 180: (.8, .3), 270: (.7, .8)}[page.rotation]
                # Mark the exact source point picked at (.2, .3) in PDF.js.
                x, y = x0 + fx * (x1 - x0), y0 + fy * (y1 - y0)
                contents = page.get_contents()
                contents.operations.extend([([FloatObject(v) for v in (x - 2, y - 2, 4, 4)], b're'), ([], b'S')])
                page.replace_contents(contents)
                page.add_transformation(Transformation().scale(12))
                page.mediabox = RectangleObject([value * 12 for value in page.mediabox])
                page.cropbox = RectangleObject([value * 12 for value in bounds])

        source = drawing('Rotation check', 8, oversize_plans)
        documents = self.service.documents
        upload = documents.begin_upload(self.session, 'Cropped sheets.pdf', len(source))['upload_id']
        documents.write_chunk(self.session, upload, 0, source)
        doc = documents.finish_upload(self.session, upload)
        self.service.add_document(self.session, doc, 1)
        pins = [{**self.pin, 'document_id': doc['id'], 'sha256': doc['sha256'],
                 'page': index, 'x': .2, 'y': .3} for index in range(1, 9)]
        # Older registers may have several pins on one entry.
        self.register['entries'][0]['plan_pins'] = pins
        self.register['entries'][1]['plan_pins'] = []
        sources = PdfReader(BytesIO(source)).pages
        self.check_fitted_plans(PdfReader(BytesIO(self.export())), sources, landscape_report=False)

        body = BytesIO()
        canvas = Canvas(body, pagesize=landscape(A4))
        canvas.setTitle('Passive Fire Registers')
        canvas.drawString(20, 20, 'Completed inspections')
        canvas.showPage()
        canvas.save()
        rows = self.register['entries']
        sessions = {**self.sessions, str(uuid4()): str(uuid4())}  # Additional session for a draft.
        with self.assertRaises(ValidationError):
            append_plan_pages(body.getvalue(), rows, sessions, self.service)
        with self.assertRaises(ValidationError):
            append_plan_pages(body.getvalue(), rows, {}, self.service, allow_unused_sessions=True)
        result = append_plan_pages(body.getvalue(), rows, sessions, self.service, allow_unused_sessions=True)
        register = PdfReader(BytesIO(result))
        self.assertEqual(register.metadata.title, 'Passive Fire Registers')
        self.check_fitted_plans(register, sources, landscape_report=True)
        self.assertEqual(documents.document_path(doc).read_bytes(), source)

    def check_fitted_plans(self, pdf, sources, *, landscape_report):
        paper = pdf.pages[0]
        self.assertEqual(paper.cropbox.width > paper.cropbox.height, landscape_report)
        for number, page in enumerate(pdf.pages[-8:], 1):
            with self.subTest(sheet=number, landscape=landscape_report):
                self.assertEqual(page.cropbox, paper.cropbox)
                self.assertEqual(page.mediabox, paper.mediabox)
                self.assertEqual(page.user_unit, paper.user_unit)
                self.assertEqual(page.rotation, 0)
                source_marker, exported_pin = [], []
                def capture_point(operator, operands, matrix, _text_matrix):
                    transform = Transformation(tuple(matrix))
                    if operator == b're' and operands[2:] == [4, 4]:
                        source_marker.extend(transform.apply_on((float(operands[0]) + 2, float(operands[1]) + 2)))
                    if operator == b'm' and not exported_pin:
                        exported_pin.extend(transform.apply_on(tuple(map(float, operands))))
                label_axis = []
                def capture_label(text, matrix, text_matrix, _font, _size):
                    if text.strip() == '001 / 001-2':
                        label_axis.extend(Transformation(tuple(text_matrix)).transform(Transformation(tuple(matrix))).ctm[:2])
                page.extract_text(visitor_operand_before=capture_point, visitor_text=capture_label)
                source_page = sources[number - 1]
                width, height = source_page.cropbox.width, source_page.cropbox.height
                if source_page.rotation in (90, 270):
                    width, height = height, width
                turned = (width > height) != landscape_report
                self.assertEqual(label_axis, [0, -1] if turned else [1, 0])
                self.assertEqual(len(exported_pin), 2)
                self.assertEqual(len(source_marker), 2)
                for actual, expected in zip(exported_pin, source_marker):
                    self.assertAlmostEqual(actual, expected, places=3)
                if turned:
                    width, height = height, width
                scale = min(paper.cropbox.width / width, paper.cropbox.height / height)
                for coordinate, paper_size, fitted_size, fraction in (
                    (exported_pin[0], paper.cropbox.width, width * scale, .7 if turned else .2),
                    (exported_pin[1], paper.cropbox.height, height * scale, .8 if turned else .7),
                ):
                    self.assertAlmostEqual(coordinate, (paper_size - fitted_size) / 2 + fraction * fitted_size, places=3)

    def test_invalid_coordinates_and_client_supplied_paths_are_rejected(self):
        for change in ({'x':True}, {'x':-0.01}, {'y':1.01}, {'y':float('nan')}, {'path':'plan.pdf'}, {'page':True}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                normalize_pins([{**self.pin, **change}])
        self.assertEqual(normalize_register(self.register), self.register)

    def test_interactive_field_prints_only_its_saved_appearance_and_missing_appearance_fails(self):
        source = BytesIO()
        canvas = Canvas(source, pagesize=(1600, 800))
        canvas.drawString(10, 10, 'Interactive source')
        canvas.acroForm.textfield(name='area', value='Plant room', x=25, y=50, width=115, height=30)
        canvas.showPage(); canvas.save()
        def missing_appearance(writer):
            annotation = DictionaryObject({NameObject('/Subtype'):NameObject('/Widget'),
                NameObject('/Rect'):RectangleObject([10, 10, 100, 30])})
            writer.pages[0][NameObject('/Annots')] = ArrayObject([writer._add_object(annotation)])
        documents = self.service.documents
        for revision, data in enumerate((source.getvalue(), drawing('Missing appearance', 1, missing_appearance)), 1):
            upload = documents.begin_upload(self.session, 'Interactive.pdf', len(data))['upload_id']
            documents.write_chunk(self.session, upload, 0, data)
            doc = documents.finish_upload(self.session, upload)
            self.service.add_document(self.session, doc, revision)
            self.register['entries'][0]['plan_pins'] = [{**self.pin, 'document_id':doc['id'], 'sha256':doc['sha256'], 'page':1}]
            if revision == 2:
                with self.assertRaisesRegex(ValidationError, 'no saved appearance'):
                    self.export()
                continue
            reader = PdfReader(BytesIO(self.export()))
            stamp = reader.pages[-1]['/Annots'][0].get_object()
            self.assertEqual(stamp['/Subtype'], '/Stamp')
            self.assertIn(b'Plant room', stamp['/AP']['/N'].get_data())
            page = reader.pages[-1]
            scale = float(page.mediabox.height) / 1600
            dx = (float(page.mediabox.width) - 800 * scale) / 2
            for actual, expected in zip(stamp['/Rect'], (dx + 50*scale, 1460*scale, dx + 80*scale, 1575*scale)):
                self.assertAlmostEqual(actual, expected, places=4)
            self.assertEqual(stamp['/AP']['/N']['/Matrix'][:4], [0, -1, 1, 0])
            self.assertNotIn('/AcroForm', reader.trailer['/Root'])
            self.assertFalse({'/A', '/AA', '/Parent', '/V', '/T'} & stamp.keys())
