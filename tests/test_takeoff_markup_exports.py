"""Viewer derivatives preserve separate workspace copies and evidence authority."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.takeoff_markup_exports import prepare_copies
from tests import test_takeoff_marked_exports as fixtures


class ViewerMarkupExportTests(unittest.TestCase):
    setUpClass = fixtures.TakeoffMarkedPDFTests.setUpClass
    setUp = fixtures.TakeoffMarkedPDFTests.setUp
    command = fixtures.TakeoffMarkedPDFTests.command
    create_marks = fixtures.TakeoffMarkedPDFTests.create_marks

    def request(self, kind='current-all', **changes):
        return {'expected_revision': self.case.session['revision'], 'kind': kind, 'mode': 'steel',
                **({'document_id': self.document['id']} if kind.startswith('current-') else {}), **changes}

    def test_viewer_halo_keeps_actual_coloured_filled_text_visible(self):
        from reportlab.pdfgen.canvas import Canvas
        from estimator.takeoff_markup_pdf_worker import _viewer_text, register_drawing_fonts
        from PIL import Image
        register_drawing_fonts(); stream = BytesIO(); canvas = Canvas(stream, pagesize=(360, 120), invariant=1)
        _viewer_text(canvas, 'Rise 1,001.125 mm', 20, 65, 16, '#1e3344', 3)
        _viewer_text(canvas, 'STEEL-COPY', 20, 25, 16, '#1e3344', 3)
        canvas.save(); data = stream.getvalue(); reader = PdfReader(BytesIO(data)); mode = 0; marks = []
        for arguments, operation in reader.pages[0].get_contents().operations:
            if operation == b'Tr': mode = int(arguments[0])
            elif operation == b'Tj': marks.append((str(arguments[0]), mode))
        for label in ('Rise 1,001.125 mm', 'STEEL-COPY'):
            self.assertIn((label, 1), marks, 'The white outline remains behind each drawing label')
            self.assertIn((label, 0), marks, 'Each coloured drawing label must explicitly paint filled glyphs')
        poppler = shutil.which('pdftoppm')
        if poppler is None:
            self.skipTest('PDF text-render modes checked; Poppler is unavailable for the additional rendered-ink check.')
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); source = folder/'labels.pdf'; source.write_bytes(data)
            rendered = subprocess.run([poppler, '-singlefile', '-scale-to', '720', '-png', str(source), str(folder/'labels')], capture_output=True, timeout=30)
            self.assertEqual(rendered.returncode, 0, rendered.stderr.decode(errors='replace'))
            with Image.open(folder/'labels.png') as image:
                rgb = image.convert('RGB'); width, height = rgb.size
                # Each half contains only one label; white halo alone paints no
                # dark ink and fails independently of successful PDF extraction.
                for bounds in ((0, 0, width, height//2), (0, height//2, width, height)):
                    dark = sum(max(pixel) < 170 for pixel in rgb.crop(bounds).getdata())
                    self.assertGreater(dark, 100, 'Rendered labels must contain visible dark foreground glyphs')

    def export(self, kind='current-all', **changes):
        self.progress = []
        return self.case.service.export_markups(self.case.session['session_id'], self.request(kind, **changes),
            lambda completed, total: self.progress.append((completed, total)))

    def note(self, mode, page, text):
        self.command('record_render', document_id=self.document['id'], page=page, success=True, warnings=[])
        self.command('create_annotation', annotation={'mode': mode, 'document_id': self.document['id'],
            'source_sha256': self.document['sha256'], 'page': page, 'point': [25, 35], 'label_position': [40, 70],
            'width': 100, 'height': 30, 'appearance': {},
            'content': {'version': 1, 'blocks': [{'kind': 'paragraph', 'runs': [{'text': text}]}]}})

    def test_four_downloads_separate_workspace_copies_and_only_marked_pages(self):
        ids = self.create_marks()
        self.note('duct', 2, 'DUCT-ONLY-COPY')
        self.note('wall', 3, 'WALL-COPY'); self.note('slab', 3, 'FLOOR-COPY')
        before = deepcopy(self.case.session['snapshot'])
        source = self.case.documents.document_path(self.document); original = source.read_bytes()
        visibility = {'item_ids': [ids[0], ids[2]], 'annotation_ids': [], 'signature_ids': [], 'graphic_ids': [], 'legend_ids': []}
        current = PdfReader(BytesIO(self.export(visibility=visibility)[0]))
        self.assertEqual(len(current.pages), 4)
        for index, page in enumerate(current.pages):
            text = page.extract_text()
            self.assertIn(f'ORIGINAL DRAWING ROTATION {index*90}', text)
            self.assertNotIn('TAKEOFF LEGEND', text)
            self.assertEqual('B-ROT-' in text, index in (0, 2))
            self.assertNotIn('DUCT-ONLY-COPY', text)
        current_marked = PdfReader(BytesIO(self.export('current-marked', visibility=visibility)[0]))
        self.assertEqual(len(current_marked.pages), 2)
        self.assertIn('ROTATION 0', current_marked.pages[0].extract_text()); self.assertIn('ROTATION 180', current_marked.pages[1].extract_text())
        all_pages = PdfReader(BytesIO(self.export('all-all')[0])); self.assertEqual(len(all_pages.pages), 12)
        self.assertTrue(all('B-ROT-' in page.extract_text() for page in all_pages.pages[:4]))
        self.assertTrue(all('B-ROT-' not in page.extract_text() for page in all_pages.pages[4:]))
        self.assertIn('DUCT-ONLY-COPY', ''.join(all_pages.pages[5].extract_text().split()))
        self.assertIn('WALL-COPY', ''.join(all_pages.pages[10].extract_text().split()))
        self.assertIn('FLOOR-COPY', ''.join(all_pages.pages[10].extract_text().split()))
        all_marked = PdfReader(BytesIO(self.export('all-marked')[0])); self.assertEqual(len(all_marked.pages), 6)
        self.assertEqual(self.progress[-1], (6, 6)); self.assertTrue(all(a <= b == 6 for a, b in self.progress))
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_view_rotation_uses_verified_visible_box_without_added_legend_area(self):
        ids = self.create_marks(); rendering = {self.document['id']: {'zoom': .75, 'rotations': {'1': 90}}}
        reader = PdfReader(BytesIO(self.export(rendering=rendering)[0]))
        self.assertEqual((float(reader.pages[0].mediabox.width), float(reader.pages[0].mediabox.height)), (200, 400))
        self.assertEqual((float(reader.pages[1].mediabox.width), float(reader.pages[1].mediabox.height)), (200, 400))
        self.assertEqual(reader.pages[0].get('/Rotate', 0), 0)
        self.assertIn('B-ROT-0', reader.pages[0].extract_text())

    def test_physical_signature_and_graphics_only_documents_are_included_without_quantity_graphs(self):
        from tests.test_takeoff_signatures import proposal as signature
        from tests.test_takeoff_graphics import proposal as graphic
        self.command('record_render', document_id=self.document['id'], page=4, success=True, warnings=[])
        for scope in ('defect_reports', 'service_plans'):
            self.command('create_signature', signature=signature(self.document, mode=scope, page=4))
            self.command('create_graphic', graphic=graphic(self.document, 'textbox', mode=scope, page=4,
                text=scope, geometry={'quad_pdf': [[30, 110], [200, 110], [200, 40], [30, 40]]}))
        before = deepcopy(self.case.session['snapshot'])
        self.assertNotIn('physical', before); self.assertNotIn('service_plans', before)
        reader = PdfReader(BytesIO(self.export('all-marked')[0])); self.assertEqual(len(reader.pages), 2)
        for index, scope in enumerate(('defect_reports', 'service_plans')):
            text = ''.join(reader.pages[index].extract_text().split())
            self.assertIn(scope, text); self.assertNotIn(('service_plans' if index == 0 else 'defect_reports'), text)
        self.assertEqual(len(PdfReader(BytesIO(self.export('all-all')[0])).pages), 8)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_combined_pdf_retains_distinct_optional_layer_identities_and_default_visibility(self):
        from tests import test_takeoff_project as project_fixtures
        other = project_fixtures.TakeoffProjectTests(); other.pdf = fixtures.drawing_fixture(annotations='link', layers='same-names')
        other.setUp(); self.addCleanup(other.doCleanups)
        self.case = other; self.document = other.session['snapshot']['documents'][0]
        self.note('steel', 1, 'STEEL-COPY'); self.note('duct', 1, 'DUCT-COPY')
        reader = PdfReader(BytesIO(self.export('all-marked')[0])); self.assertEqual(len(reader.pages), 2)
        properties = [page['/Resources']['/Properties'] for page in reader.pages]
        hidden = [value.raw_get('/Hidden') for value in properties]
        visible = [value.raw_get('/Visible') for value in properties]
        layers = reader.trailer['/Root']['/OCProperties']
        self.assertEqual(len(layers['/OCGs']), 4); self.assertEqual(len(set(hidden + visible)), 4)
        self.assertEqual(set(layers['/D']['/OFF']), set(hidden)); self.assertEqual(set(layers['/D']['/ON']), set(visible))
        for page in reader.pages:
            self.assertNotIn('/Annots', page)
        self.assertNotIn('/OpenAction', reader.trailer['/Root']); self.assertNotIn('/Names', reader.trailer['/Root'])

    def test_http_native_destination_is_captured_before_worker_and_raw_contract_remains_pdf(self):
        from estimator.catalog import ROOT
        from estimator.takeoff_http import TakeoffHTTP
        self.create_marks(); request = self.request('current-marked')
        adapter = TakeoffHTTP(self.case.service, ROOT, "default-src 'self'")
        class Handler:
            command = 'POST'
            path = '/api/takeoffs/sessions/' + self.case.session['session_id'] + '/export/markup-pdf'
            def read_json(self): return deepcopy(request)
            def pdf_company_details(self, kind): return {}
            def capture_download(self, value):
                self.selection = value
                if value != {'project_token': None}: raise ValidationError('Invalid destination.')
                return 'isolated-target'
            def download_progress(self, completed, total): self.progress = (completed, total)
            def send_download(self, *values, **options): self.download, self.download_options = values, options
        handler = Handler(); self.assertTrue(adapter.dispatch(handler, handler.path))
        self.assertEqual(len(handler.download), 3); self.assertTrue(handler.download[0].startswith(b'%PDF-'))
        request['download'] = {'project_token': None}; handler = Handler()
        self.assertTrue(adapter.dispatch(handler, handler.path)); self.assertEqual(handler.download[3], 'isolated-target')
        self.assertEqual(handler.progress, (4, 4)); self.assertEqual(handler.selection, request['download'])
        for suffix in ('export/markup-pdf', 'export/marked-pdf', 'export/register-xlsx', 'export/csv', 'physical/export/register-xlsx'):
            for malformed in (None, [], {}, {'project_token': 'invalid'}):
                request['download'] = malformed; invalid = Handler(); invalid.path = invalid.path.rsplit('/export/',1)[0] + '/' + suffix
                with self.subTest(suffix=suffix, malformed=malformed), patch('estimator.takeoff_markup_exports.subprocess.Popen', side_effect=AssertionError('Worker started')), self.assertRaisesRegex(ValidationError, 'Invalid destination'):
                    adapter.dispatch(invalid, invalid.path)
        handler.path += '?extra=1'
        with self.assertRaisesRegex(ValidationError, 'structured request'): adapter.dispatch(handler, handler.path.split('?')[0])

    def test_visibility_and_source_selection_fail_closed_before_worker(self):
        ids = self.create_marks()
        empty = dict(item_ids=[], annotation_ids=[], signature_ids=[], graphic_ids=[], legend_ids=[])
        for changes in ({'expected_revision': True}, {'kind': 'bad'}, {'mode': 'wall'},
                        {'document_id': str(uuid4())}, {'document_id': []}, {'document_id': {}}, {'path': 'C:/private.pdf'},
                        {'visibility': {**empty, 'item_ids': [str(uuid4())]}},
                        {'visibility': {**empty, 'item_ids': [ids[0], ids[0]]}},
                        {'rendering': {self.document['id']: {'zoom': 0, 'rotations': {}}}},
                        {'rendering': {self.document['id']: {'zoom': 1, 'rotations': {'5': 90}}}}):
            with self.subTest(changes=changes), patch('estimator.takeoff_markup_exports.subprocess.Popen', side_effect=AssertionError('Worker started')), self.assertRaises(ValidationError):
                self.export(**changes)
        with self.assertRaisesRegex(ValidationError, 'no visible marked pages'):
            self.export('current-marked', visibility=empty)
        with self.assertRaisesRegex(ValidationError, 'current visibility'):
            self.export('all-all', visibility=empty)
        self.assertEqual(len(PdfReader(BytesIO(self.export('current-all', visibility=empty)[0])).pages), 4)

    def test_changed_revision_and_closed_session_reject_completed_derivative(self):
        self.create_marks(); before = deepcopy(self.case.session['snapshot'])
        def revise(*args, **kwargs):
            self.command('update_item', item_id=before['items'][0]['id'], changes={'fields': {'mark': 'NEW-DRAFT'}})
            return b'%PDF-fake', 'application/pdf', 'fake.pdf'
        with patch('estimator.takeoff_markup_exports.export_markups', side_effect=revise), self.assertRaisesRegex(ValidationError, 'changed while preparing'):
            self.export()
        def close(*args, **kwargs):
            self.case.service.close(self.case.session['session_id'])
            return b'%PDF-fake', 'application/pdf', 'fake.pdf'
        with patch('estimator.takeoff_markup_exports.export_markups', side_effect=close), self.assertRaisesRegex(ValidationError, 'session is unavailable'):
            self.export()

    def test_audit_evidence_changed_during_worker_is_rejected_without_revision_change(self):
        self.create_marks(); before = deepcopy(self.case.session['snapshot'])
        audit = self.case.documents.root / 'audit' / (before['audit_head'] + '.json')
        def corrupt(*args, **kwargs):
            audit.write_bytes(b'{"changed":true}')
            return b'%PDF-fake', 'application/pdf', 'fake.pdf'
        with patch('estimator.takeoff_markup_exports.export_markups', side_effect=corrupt), self.assertRaises(ValidationError):
            self.export()
        self.assertEqual(self.case.service._session(self.case.session['session_id'])['snapshot'], before)

    def test_nonunit_zoom_retains_all_five_addition_values_and_exact_screen_offsets(self):
        from estimator.takeoff_markup_pdf_worker import page_transform, transform
        ids = self.create_marks(); point = [100, 30]
        additions = [{'id': str(uuid4()), 'kind': 'riser' if index % 2 == 0 else 'drop',
            'length_mm': 1001.125 + index, 'document_id': self.document['id'], 'page': 1,
            'anchor': {'point_index': 1, 'point': point}} for index in range(5)]
        self.command('update_item', item_id=ids[0], changes={'geometry': {**self.case.session['snapshot']['items'][0]['geometry'],
            'points': [[20, 40], point]}})
        self.command('update_item', item_id=ids[0], changes={'length_additions': additions, 'appearance': {'display_values': True}})
        before = deepcopy(self.case.session['snapshot'])
        expected = [('Rise' if index % 2 == 0 else 'Drop') + f' {1001.125+index:,.3f} mm' for index in range(5)]
        matrix, _, _ = page_transform(self.document['pages'][0]); x, y = transform(point, matrix)
        for zoom in (.5, 2):
            reader = PdfReader(BytesIO(self.export(rendering={self.document['id']: {'zoom': zoom, 'rotations': {}}})[0]))
            observed = []
            def visit(value, cm, tm, font, size):
                text = value.strip()
                if text in expected:
                    observed.append((text, tm[4]*cm[0]+tm[5]*cm[2]+cm[4], tm[4]*cm[1]+tm[5]*cm[3]+cm[5], size))
            text = reader.pages[0].extract_text(visitor_text=visit)
            self.assertNotIn('see legend', text)
            for index, label in enumerate(expected):
                self.assertIn(label, text)
                matches = [value for value in observed if value[0] == label]
                self.assertTrue(matches)
                for _, px, py, size in matches:
                    self.assertAlmostEqual(size, 11/zoom, places=4)
                    self.assertAlmostEqual(px, x+22/zoom, places=4)
                    self.assertAlmostEqual(py, y-(17+index*16)/zoom, places=4)
            self.assertIn('mm', text)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_sources_and_request_geometry_are_reverified_and_bounds_are_enforced(self):
        self.create_marks(); before = deepcopy(self.case.session['snapshot'])
        with patch('estimator.takeoff_markup_exports.MAX_PAGES', 3), self.assertRaisesRegex(ValidationError, 'bounded'):
            self.export()
        source = self.case.documents.document_path(self.document); source.write_bytes(b'%PDF-changed')
        with self.assertRaises(ValidationError): self.export()
        self.assertEqual(self.case.service._session(self.case.session['session_id'])['snapshot'], before)


if __name__ == '__main__': unittest.main()
