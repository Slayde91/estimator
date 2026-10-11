"""Local raster and atomic all-page marks retain PDF-only authority."""
import base64
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import FloatObject, NameObject, RectangleObject

from estimator.catalog import ValidationError
from estimator.takeoff_graphics import validate_graphics
from estimator.takeoff_initial_pages import (apply_initial_pages, box_quad, natural_box,
                                            pdf_point_visible, validate_initial_pages_history, visible_size)
from estimator.takeoff_stamp_images import normalize_stamp_image, validate_stamp_image
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_workspace as workspace_fixtures
from tests import test_takeoff_physical_workspace as physical_fixtures
from tests.test_takeoff_graphics import proposal
from tests.test_takeoff_marked_exports import drawing_fixture


def image_upload(format='PNG', size=(16, 8), **kwargs):
    image = Image.new('RGBA' if format == 'PNG' else 'RGB', size, (180, 20, 35, 128) if format == 'PNG' else (180, 20, 35))
    stream = BytesIO(); image.save(stream, format=format, **kwargs)
    return {'mime_type': 'image/png' if format == 'PNG' else 'image/jpeg',
            'content_base64': base64.b64encode(stream.getvalue()).decode('ascii')}


def mixed_pdf():
    reader = PdfReader(BytesIO(drawing_fixture())); writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index == 1:
            page.mediabox = RectangleObject([0, 0, 400, 250]); page.cropbox = RectangleObject([20, 30, 320, 200])
        elif index == 2:
            page.mediabox = RectangleObject([0, 0, 250, 250]); page.cropbox = RectangleObject([30, 10, 200, 180])
            page[NameObject('/UserUnit')] = FloatObject(1.25)
        elif index == 3:
            page.mediabox = RectangleObject([0, 0, 160, 240]); page.cropbox = RectangleObject([5, 10, 120, 220])
            page[NameObject('/UserUnit')] = FloatObject(3)
        writer.add_page(page)
    stream = BytesIO(); writer.write(stream); return stream.getvalue()


class StampInitialPagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        project_fixtures.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = project_fixtures.TakeoffProjectTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.document = self.case.session['snapshot']['documents'][0]

    def command(self, op, **values):
        case = self.case
        case.session = case.service.command(case.session['session_id'], {
            'op': op, 'request_id': str(uuid4()), 'expected_revision': case.session['revision'], **values})
        return case.session

    def graphic(self, **values):
        return self.command('create_graphic', graphic=proposal(self.document, 'stamp', **values))

    def upload_mixed(self):
        data = mixed_pdf(); case = self.case
        upload = case.documents.begin_upload(case.session['session_id'], 'mixed.pdf', len(data))
        case.documents.write_chunk(case.session['session_id'], upload['upload_id'], 0, data)
        self.document = case.documents.finish_upload(case.session['session_id'], upload['upload_id'])
        case.session = case.service.add_document(case.session['session_id'], self.document, case.session['revision'])
        return data

    def initials(self, **values):
        return {'mode': 'steel', 'document_id': self.document['id'], 'source_sha256': self.document['sha256'],
                'page': 1, 'normalized_box': [.2, .2, .5, .5], 'display_rotation': self.document['pages'][0]['rotation'],
                'text': 'AB', 'strokes': [], 'signature_ratio': None, 'text_appearance': {}, 'signature_appearance': {}, **values}

    def export(self):
        return self.case.service.export_workspace(self.case.session['session_id'], 'marked-pdf', {
            'expected_revision': self.case.session['revision'], 'mode': 'steel', 'document_id': self.document['id'], 'item_ids': []})[0]

    def assert_authorities_same(self, before, after):
        for key in set(before) | set(after):
            if key not in ('graphics', 'signatures', 'revision', 'audit_head'):
                self.assertEqual(before.get(key), after.get(key), key)

    def test_image_png_jpeg_normalize_exact_dimensions_hash_and_strip_source_metadata(self):
        from PIL.PngImagePlugin import PngInfo
        metadata = PngInfo(); metadata.add_text('Comment', 'private source metadata')
        for upload in (image_upload(pnginfo=metadata), image_upload('JPEG')):
            normalized = normalize_stamp_image(upload)
            self.assertEqual(set(normalized), {'version', 'mime_type', 'content_base64', 'width', 'height', 'sha256'})
            self.assertEqual((normalized['version'], normalized['mime_type'], normalized['width'], normalized['height']), (1, 'image/png', 16, 8))
            data = base64.b64decode(normalized['content_base64'])
            self.assertEqual(sha256(data).hexdigest(), normalized['sha256'])
            with Image.open(BytesIO(data)) as image:
                self.assertEqual(image.info, {})
                self.assertEqual(image.mode, 'RGBA' if upload['mime_type'] == 'image/png' else 'RGB')
            self.assertEqual(validate_stamp_image(normalized), normalized)
            self.assertEqual(normalize_stamp_image(normalized), normalized)

    def test_image_payloads_fail_closed_without_command_revision_or_authority_changes(self):
        before = deepcopy(self.case.session['snapshot'])
        invalid = [
            {'mime_type': 'image/svg+xml', 'content_base64': base64.b64encode(b'<svg/>').decode()},
            {'mime_type': 'image/png', 'content_base64': 'https://example.test/logo.png'},
            {'mime_type': 'image/png', 'content_base64': image_upload('JPEG')['content_base64']},
            {'mime_type': 'image/png', 'content_base64': base64.b64encode(b'not a PNG').decode()},
            {**image_upload(), 'url': 'file:///private'}, image_upload(size=(4097, 1)), image_upload(size=(2001, 2000)),
        ]
        for image in invalid:
            with self.subTest(image_keys=list(image)), self.assertRaises(ValidationError):
                self.graphic(text='', stamp_image=image)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        for kind, text in (('textbox', ''), ('stamp', 'mixed image/text')):
            with self.assertRaises(ValidationError):
                self.command('create_graphic', graphic=proposal(self.document, kind, text=text, stamp_image=image_upload()))
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_stored_image_sha_dimensions_frame_and_payload_bounds_are_checked(self):
        value = normalize_stamp_image(image_upload())
        for changes in ({'sha256': '0'*64}, {'width': True}, {'height': 9}, {'version': True}, {'mime_type': 'image/jpeg'}, {'content_base64': value['content_base64']+'\n'}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                validate_stamp_image({**value, **changes})
        with patch('estimator.takeoff_stamp_images.MAX_STAMP_IMAGE_BYTES', 5), self.assertRaises(ValidationError):
            normalize_stamp_image(image_upload())
        first = Image.new('RGBA', (8, 8), 'red'); second = Image.new('RGBA', (8, 8), 'blue')
        stream = BytesIO(); first.save(stream, format='PNG', save_all=True, append_images=[second])
        with self.assertRaises(ValidationError):
            normalize_stamp_image({'mime_type': 'image/png', 'content_base64': base64.b64encode(stream.getvalue()).decode()})
        from PIL.PngImagePlugin import PngInfo
        metadata = PngInfo(); metadata.add_text('URL', 'https://example.test')
        upload = image_upload(pnginfo=metadata); data = base64.b64decode(upload['content_base64'])
        with self.assertRaisesRegex(ValidationError, 'normalized pixel chunks'):
            validate_stamp_image({**value, 'content_base64': upload['content_base64'], 'sha256': sha256(data).hexdigest()})

    def test_image_save_reopen_export_pixels_and_legacy_text_stamp_keep_pdf_only_identity(self):
        before = deepcopy(self.case.session['snapshot'])
        legacy = self.graphic()['created_graphic_id']
        response = self.graphic(text='', stamp_image=image_upload())
        identifier = response['created_graphic_id']; state = response['snapshot']
        self.assert_authorities_same(before, state)
        records = {row['id']: row for row in state['graphics']['records']}
        self.assertNotIn('stamp_image', records[legacy])
        stored_image = records[identifier]['stamp_image']
        self.case.request.update(takeoffs=state)
        self.case.library.save_as(self.case.request)
        self.case.dialogs.opened = str(self.case.target)
        reopened = self.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['graphics'], state['graphics'])
        self.case.documents.validate_audit(reopened['takeoffs'])
        page = PdfReader(BytesIO(self.export())).pages[0]
        stamps = [value.get_object() for value in page['/Resources']['/XObject'].values()
                  if value.get_object().get('/Subtype') == '/Image' and value.get_object().get('/Width') == 16]
        self.assertEqual(len(stamps), 1)
        self.assertEqual(stamps[0]['/Height'], 8)
        with Image.open(BytesIO(base64.b64decode(stored_image['content_base64']))) as image:
            self.assertEqual(stamps[0].get_data(), image.convert('RGB').tobytes())
        self.assertIn('/SMask', stamps[0])
        self.assertIn('REVIEWED', page.extract_text())
        self.assertEqual(self.case.documents.document_path(self.document).read_bytes(), self.case.pdf)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], state)

    def test_image_switch_undo_and_total_inline_placement_budget_are_atomic(self):
        result = self.graphic(text='', stamp_image=image_upload())
        identifier = result['created_graphic_id']; image = result['snapshot']['graphics']['records'][0]['stamp_image']
        budget = len(base64.b64decode(image['content_base64']))
        before = deepcopy(result['snapshot'])
        with patch('estimator.takeoff_stamp_images.MAX_STAMP_PROJECT_IMAGE_BYTES', budget), self.assertRaisesRegex(ValidationError, 'across all placements'):
            self.graphic(text='', stamp_image=image)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.command('update_graphic', graphic_id=identifier, changes={'stamp_image': None, 'text': 'TEXT'})
        self.assertNotIn('stamp_image', self.case.session['snapshot']['graphics']['records'][0])
        self.command('undo')
        row = self.case.session['snapshot']['graphics']['records'][0]
        self.assertEqual(row['stamp_image'], image); self.assertEqual(row['id'], identifier); self.assertEqual(row['version'], 3)

    def test_pixel_budget_admits_before_decode_and_repeated_stamp_validation_binds_exact_image(self):
        result = self.graphic(text='', stamp_image=image_upload())
        image = result['snapshot']['graphics']['records'][0]['stamp_image']
        self.graphic(text='', stamp_image=image)
        snapshot = deepcopy(self.case.session['snapshot'])
        with patch('estimator.takeoff_stamp_images.validate_stamp_image', wraps=validate_stamp_image) as decoder:
            validate_graphics(snapshot)
            self.assertEqual(decoder.call_count, 1, 'Identical normalized bytes and all metadata decode once per snapshot')
        with patch('estimator.takeoff_stamp_images.MAX_STAMP_PROJECT_IMAGE_PIXELS', 128), \
                patch('estimator.takeoff_stamp_images._decode', side_effect=AssertionError('Pixel decode must not begin')), \
                self.assertRaisesRegex(ValidationError, '16 million Stamp image pixels'):
            validate_graphics(snapshot)
        before = deepcopy(self.case.session['snapshot'])
        with patch('estimator.takeoff_stamp_images.MAX_STAMP_PROJECT_IMAGE_PIXELS', 256), self.assertRaisesRegex(ValidationError, '16 million'):
            self.graphic(text='', stamp_image=image)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        forged = deepcopy(snapshot); forged['graphics']['records'][1]['stamp_image']['width'] = 15
        with self.assertRaisesRegex(ValidationError, 'dimensions and SHA'):
            validate_graphics(forged)
        for invalid_sha in ([], {}, None):
            forged = deepcopy(snapshot); forged['graphics']['records'][1]['stamp_image']['sha256'] = invalid_sha
            with self.subTest(invalid_sha=invalid_sha), self.assertRaisesRegex(ValidationError, 'dimensions and SHA'):
                validate_graphics(forged)
        forged = deepcopy(snapshot); forged['graphics']['records'][1]['stamp_image']['version'] = True
        with self.assertRaisesRegex(ValidationError, 'normalized PNG version one'):
            validate_graphics(forged)

    def test_all_pages_name_and_signature_are_one_audited_revision_and_normalized_mixed_page_position(self):
        original = self.upload_mixed(); before = deepcopy(self.case.session['snapshot'])
        result = self.command('initial_pages', initials=self.initials(strokes=[[[0, 0], [.4, .8], [1, 1]]], signature_ratio=2))
        state = result['snapshot']
        self.assertEqual(result['revision'], before['revision']+1)
        self.assertEqual(result['initial_pages_count'], 4)
        self.assertEqual(len(result['created_graphic_ids']), 4); self.assertEqual(len(result['created_signature_ids']), 4)
        self.assertEqual(len(set(result['created_graphic_ids']+result['created_signature_ids'])), 8)
        self.assert_authorities_same(before, state)
        self.assertEqual(result['item_results'], [])
        for index, page in enumerate(self.document['pages']):
            graphic = state['graphics']['records'][index]; signature = state['signatures']['records'][index]
            expected_quad = box_quad(page, [.2, .2+.5*.7, .5, .5*.3])
            for actual_point, expected_point in zip(graphic['geometry']['quad_pdf'], expected_quad):
                for actual, expected in zip(actual_point, expected_point):
                    self.assertAlmostEqual(actual, expected, places=12)
            ink = [pdf_point_visible(page, point) for point in signature['quad_pdf']]
            width, height = visible_size(page)
            self.assertAlmostEqual((ink[1][0]-ink[0][0])*width/((ink[3][1]-ink[0][1])*height), 2)
            self.assertTrue(all(.2-1e-9 <= point[0] <= .7+1e-9 and .2-1e-9 <= point[1] <= .55+1e-9 for point in ink))
            self.assertEqual(graphic['version'], 1); self.assertEqual(signature['version'], 1)
        event = self.case.documents.get_blob(state['audit_head'])
        self.assertEqual(event['op'], 'initial_pages')
        self.assertEqual(event['affected_ids']['graphics'], sorted(result['created_graphic_ids']))
        self.assertEqual(event['affected_ids']['signatures'], sorted(result['created_signature_ids']))
        self.case.documents.validate_audit(state)
        self.assertEqual(self.case.documents.document_path(self.document).read_bytes(), original)

    def test_source_display_rotation_maps_selection_then_each_target_natural_orientation(self):
        self.upload_mixed()
        value = self.initials(page=2, display_rotation=180, normalized_box=[.1, .2, .6, .4])
        source = self.document['pages'][1]
        expected = natural_box(source, value['normalized_box'], 180)
        self.command('initial_pages', initials=value)
        for page, graphic in zip(self.document['pages'], self.case.session['snapshot']['graphics']['records']):
            self.assertEqual(graphic['geometry']['quad_pdf'], box_quad(page, expected))

    def test_initial_pages_request_retry_and_stale_revision_cannot_duplicate_batch(self):
        self.upload_mixed(); case = self.case
        request = {'op': 'initial_pages', 'initials': self.initials(), 'request_id': str(uuid4()), 'expected_revision': case.session['revision']}
        first = case.service.command(case.session['session_id'], request)
        self.assertEqual(case.service.command(case.session['session_id'], request), first)
        case.session = first
        with self.assertRaisesRegex(ValidationError, 'changed'):
            case.service.command(first['session_id'], {**request, 'request_id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'different operation'):
            case.service.command(first['session_id'], {**request, 'initials': self.initials(text='CD')})
        self.assertEqual(case.service.get(first['session_id'])['snapshot'], first['snapshot'])

    def test_invalid_any_target_or_capacity_or_audit_failure_rolls_back_whole_batch(self):
        self.upload_mixed(); before = deepcopy(self.case.session['snapshot'])
        for changes in ({'source_sha256': '0'*64}, {'normalized_box': [.9, .1, .2, .2]}, {'text': ''},
                        {'text': '  '}, {'display_rotation': True}, {'text': 'bad\nname'}, {'text': 'x'*81},
                        {'signature_ratio': 2}, {'strokes': [[[0, 0], [2, 1]]], 'signature_ratio': 2},
                        {'text_appearance': []}, {'mode': []}, {'mode': {}}, {'normalized_box': [.2, .2, .05, .05]}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.command('initial_pages', initials=self.initials(**changes))
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        with patch('estimator.takeoff_initial_pages.MAX_VISUAL_RECORDS', 3), self.assertRaisesRegex(ValidationError, 'limit'):
            self.command('initial_pages', initials=self.initials())
        with patch.object(self.case.documents, 'put_blob', side_effect=ValidationError('audit failure')), self.assertRaisesRegex(ValidationError, 'audit failure'):
            self.command('initial_pages', initials=self.initials())
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_initial_pages_save_reopen_export_all_actual_page_text_and_undo_entire_batch(self):
        original = self.upload_mixed(); before = deepcopy(self.case.session['snapshot'])
        self.command('initial_pages', initials=self.initials(text='ZK', strokes=[[[0, 0], [1, 1]]], signature_ratio=2))
        state = deepcopy(self.case.session['snapshot'])
        self.case.request.update(takeoffs=state); self.case.library.save_as(self.case.request)
        self.case.dialogs.opened = str(self.case.target)
        reopened = self.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['graphics'], state['graphics'])
        self.assertEqual(reopened['takeoffs']['signatures'], state['signatures'])
        pages = PdfReader(BytesIO(self.export())).pages
        self.assertEqual(len(pages), 4)
        for page in pages:
            self.assertIn('ZK', page.extract_text())
            self.assertNotIn('/Annots', page)
        self.assertEqual(self.case.documents.document_path(self.document).read_bytes(), original)
        self.command('undo')
        restored = self.case.session['snapshot']
        self.assertNotIn('graphics', restored); self.assertNotIn('signatures', restored)
        self.assert_authorities_same(before, restored)
        self.case.documents.validate_audit(restored)

    def test_initial_pages_history_rejects_partial_pages_changed_authorities_and_existing_identity_edits(self):
        self.upload_mixed(); self.command('initial_pages', initials=self.initials())
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        invalid = deepcopy(event); invalid['after']['graphics']['records'].pop()
        with self.assertRaisesRegex(ValidationError, 'every exact source page'):
            validate_initial_pages_history(invalid)
        invalid = deepcopy(event); invalid['after']['items'].append({'quantity': 1})
        with self.assertRaisesRegex(ValidationError, 'only PDF-only'):
            validate_initial_pages_history(invalid)
        invalid = deepcopy(event); invalid['after']['graphics']['records'][0]['text'] = 'other'
        with self.assertRaisesRegex(ValidationError, 'same entered text'):
            validate_initial_pages_history(invalid)
        invalid = deepcopy(event)
        for point in invalid['after']['graphics']['records'][1]['geometry']['quad_pdf']:
            point[0] += 1
        with self.assertRaisesRegex(ValidationError, 'same normalized placement'):
            validate_initial_pages_history(invalid)
        self.command('initial_pages', initials=self.initials(strokes=[[[0, 0], [1, 1]]], signature_ratio=2))
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        invalid = deepcopy(event)
        for point in invalid['after']['signatures']['records'][1]['quad_pdf']:
            point[0] += 1
        with self.assertRaisesRegex(ValidationError, 'centered contain-fit placement'):
            validate_initial_pages_history(invalid)
        invalid = deepcopy(event); invalid['after']['graphics']['records'][0]['text'] = 'edited existing'
        with self.assertRaisesRegex(ValidationError, 'existing visual identities'):
            validate_initial_pages_history(invalid)

    def test_initial_pages_preserves_confirmed_transfer_and_physical_undo_without_evidence_gate(self):
        case = workspace_fixtures.TakeoffWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        identifier = case.create(); case.confirm(identifier); case.apply(case.preview(identifier))
        before, results = deepcopy(case.state['snapshot']), deepcopy(case.state['item_results'])
        value = self.initials(document_id=case.doc['id'], source_sha256=case.doc['sha256'])
        result = case.service.command(case.sid, {'op': 'initial_pages', 'initials': value,
            'request_id': str(uuid4()), 'expected_revision': before['revision']})
        self.assert_authorities_same(before, result['snapshot']); self.assertEqual(result['item_results'], results)
        physical = physical_fixtures.PhysicalWorkspaceTests(); physical.setUp(); self.addCleanup(physical.doCleanups)
        state, _ = physical.apply([physical.defect()]); before = deepcopy(state['snapshot'])
        value = self.initials(mode='defect_reports', document_id=physical.case.doc['id'], source_sha256=physical.case.doc['sha256'])
        state = physical.service.command(physical.sid, {'op': 'initial_pages', 'initials': value,
            'request_id': str(uuid4()), 'expected_revision': state['revision']})
        self.assert_authorities_same(before, state['snapshot'])
        physical.images.blocked = True
        state = physical.service.command(physical.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': state['revision']})
        self.assert_authorities_same(before, state['snapshot'])

    def test_signature_only_all_pages_no_graphics_or_schema_upgrade(self):
        self.upload_mixed(); before = deepcopy(self.case.session['snapshot'])
        self.command('initial_pages', initials=self.initials(text='', strokes=[[[0, 1], [1, 0]]], signature_ratio=3))
        state = self.case.session['snapshot']
        self.assertNotIn('graphics', state); self.assertEqual(len(state['signatures']['records']), 4)
        self.assertEqual(state['version'], before['version'])
        self.assert_authorities_same(before, state)
        self.case.documents.validate_audit(state)
