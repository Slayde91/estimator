"""Pins use the immutable source sheet and the displayed (rotated and cropped) viewport."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, RectangleObject
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
        for index, source_page in ((-2, 2), (-1, 4)):
            self.assertEqual(pages[index], {**self.doc['pages'][source_page - 1], 'page':len(pages) + index + 1})
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

    def test_invalid_coordinates_and_client_supplied_paths_are_rejected(self):
        for change in ({'x':True}, {'x':-0.01}, {'y':1.01}, {'y':float('nan')}, {'path':'plan.pdf'}, {'page':True}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                normalize_pins([{**self.pin, **change}])
        self.assertEqual(normalize_register(self.register), self.register)

    def test_interactive_field_prints_only_its_saved_appearance_and_missing_appearance_fails(self):
        source = BytesIO()
        canvas = Canvas(source, pagesize=(400, 400))
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
            self.assertNotIn('/AcroForm', reader.trailer['/Root'])
            self.assertFalse({'/A', '/AA', '/Parent', '/V', '/T'} & stamp.keys())
