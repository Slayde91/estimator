"""Clicked-anchor rich Textboxes fit using the actual marked-PDF layout."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import math
import unittest
from uuid import uuid4

from pypdf import PdfReader, PdfWriter
from pypdf.generic import FloatObject, NameObject, RectangleObject
from estimator.catalog import ValidationError
from estimator.takeoff_graphics import validate_history
from estimator.takeoff_model import validate_snapshot
from estimator.takeoff_markup_pdf_worker import _annotation_lines, register_drawing_fonts
from estimator.takeoff_textbox_layout import textbox_layout, validate_textbox_fit
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_project as projects


def rich():
    return {'version': 1, 'blocks': [
        {'kind': 'paragraph', 'runs': [{'text': 'Rich é', 'bold': True, 'italic': True, 'underline': True}]},
        {'kind': 'bullet', 'runs': [{'text': 'Bullet one'}]},
        {'kind': 'number', 'runs': [{'text': 'Number one'}]}]}


class TextboxLayoutTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def value(self, **changes):
        case = self.case
        return {'mode': 'steel', 'document_id': case.doc['id'], 'source_sha256': case.doc['sha256'],
            'page': 1, 'anchor_pdf': [30, 40], 'display_rotation': 90, 'text': 'A short note', 'appearance': {}, **changes}

    def test_preview_and_atomic_creation_keep_exact_anchor_font_and_other_data(self):
        case = self.case; before = deepcopy(case.state['snapshot'])
        value = self.value(appearance={'font_size': 18, 'font_color': '#2468AC'})
        preview = case.service.textbox_layout(case.sid, {'expected_revision': case.state['revision'], **value})
        self.assertEqual(case.service.get(case.sid)['snapshot'], before)
        self.assertEqual(preview['graphic']['geometry']['quad_pdf'][0], value['anchor_pdf'])
        reply = case.command('create_textbox', textbox=value)
        record = reply['snapshot']['graphics']['records'][0]
        self.assertEqual(record['geometry'], preview['graphic']['geometry'])
        self.assertEqual(record['appearance']['font_size'], 18)
        self.assertEqual(record['appearance']['font_color'], '#2468AC')
        self.assertEqual(reply['textbox_layout'], preview['layout'])
        self.assertEqual(reply['created_graphic_id'], record['id'])
        self.assertEqual(reply['revision'], before['revision']+1)
        for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
            self.assertEqual(reply['snapshot'][key], before[key])
        case.command('undo'); self.assertEqual(case.state['snapshot'].get('graphics', {}).get('records', []), [])

    def test_rich_layout_uses_exact_export_lists_newlines_and_glyph_advances(self):
        case = self.case; content = rich(); plain = 'Rich é\nBullet one\nNumber one'
        prepared = textbox_layout(case.state['snapshot'], self.value(text=plain, text_content=content))
        record, layout = prepared['graphic'], prepared['layout']
        width, height = layout['width_pt'], layout['height_pt']
        padding = min(6, width/8, height/8)
        register_drawing_fonts()
        actual = _annotation_lines(content, width-2*padding, record['appearance']['font_size'], 'PDF markup')
        self.assertEqual(len(actual), layout['line_count'])
        self.assertEqual(layout['line_count'], 3)
        self.assertEqual(record['text_content'], content)
        self.assertEqual(record['text'], plain)
        validate_textbox_fit(record, case.state['snapshot'])

    def test_all_display_rotations_cropbox_and_userunit_keep_original_anchor_inside_source(self):
        case = self.case
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                value = self.value(anchor_pdf=[110, 70], display_rotation=rotation, text='A')
                prepared = textbox_layout(case.state['snapshot'], value)
                quad = prepared['graphic']['geometry']['quad_pdf']
                self.assertEqual(quad[0], [110, 70])
                self.assertTrue(all(10 <= x <= 210 and 20 <= y <= 120 for x, y in quad))
                self.assertAlmostEqual(math.dist(quad[0], quad[1])*2, prepared['layout']['width_pt'])
                self.assertAlmostEqual(math.dist(quad[0], quad[3])*2, prepared['layout']['height_pt'])

    def test_wrap_to_remaining_width_never_shrinks_font(self):
        prepared = textbox_layout(self.case.state['snapshot'], self.value(text='words '*14, appearance={'font_size': 12}))
        self.assertGreater(prepared['layout']['line_count'], 1)
        self.assertEqual(prepared['graphic']['appearance']['font_size'], 12)
        self.assertLessEqual(prepared['layout']['width_pt'], 160)

    def test_default_nine_point_multiline_fit_settles_exactly_without_shrinking(self):
        for count in (2, 3):
            with self.subTest(count=count):
                value = self.value(text='\n'.join(['Note']*count), appearance={'font_size': 9})
                prepared = textbox_layout(self.case.state['snapshot'], value)
                self.assertEqual(prepared['layout']['line_count'], count)
                self.assertEqual(prepared['layout']['font_size'], 9)
                text_height = count*9*1.25
                maximum_padding = min(6, prepared['layout']['width_pt']/8)
                self.assertAlmostEqual(prepared['layout']['height_pt'], text_height+2*min(maximum_padding, text_height/6), delta=2e-6)
                validate_textbox_fit(prepared['graphic'], self.case.state['snapshot'])
        edge = textbox_layout(self.case.state['snapshot'], self.value(text='Note\nNote',
                              appearance={'font_size': 9}, anchor_pdf=[195, 70]))
        self.assertAlmostEqual(edge['layout']['height_pt'], 30)

    def test_default_nine_point_rich_lists_and_italic_fit_and_bottom_overflow_is_atomic(self):
        content = rich(); value = self.value(text='Rich é\nBullet one\nNumber one', text_content=content,
                                            appearance={'font_size': 9})
        prepared = textbox_layout(self.case.state['snapshot'], value)
        self.assertEqual(prepared['layout']['line_count'], 3)
        self.assertEqual(prepared['graphic']['appearance']['font_size'], 9)
        validate_textbox_fit(prepared['graphic'], self.case.state['snapshot'])
        before = deepcopy(self.case.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'does not fit'):
            self.case.command('create_textbox', textbox={**value, 'anchor_pdf': [195, 70]})
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_overflow_unsupported_glyph_bad_source_and_schema_reject_before_mutation(self):
        case = self.case; before = deepcopy(case.state['snapshot'])
        for changes in ({'anchor_pdf': [209, 119]}, {'text': 'x'*4001}, {'text': '\U0001F984'},
                        {'source_sha256': 'b'*64}, {'display_rotation': 45}, {'mode': []},
                        {'text': 'long '*700, 'appearance': {'font_size': 144}}, {'text': 'divergent', 'text_content': rich()}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                case.command('create_textbox', textbox=self.value(**changes))
            self.assertEqual(case.service.get(case.sid)['snapshot'], before)

    def test_stale_preview_and_command_retry_have_no_extra_revision(self):
        case = self.case
        with self.assertRaisesRegex(ValidationError, 'changed'):
            case.service.textbox_layout(case.sid, {'expected_revision': case.state['revision']-1, **self.value()})
        request = {'op': 'create_textbox', 'request_id': str(uuid4()), 'expected_revision': case.state['revision'], 'textbox': self.value()}
        first = case.service.command(case.sid, request); repeated = case.service.command(case.sid, request)
        self.assertEqual(first, repeated)
        self.assertEqual(len(first['snapshot']['graphics']['records']), 1)

    def test_old_manual_boxes_still_validate_without_added_layout_fields_or_fit_gate(self):
        case = self.case
        case.command('create_graphic', graphic={'mode': 'steel', 'document_id': case.doc['id'], 'source_sha256': case.doc['sha256'],
            'page': 1, 'kind': 'textbox', 'geometry': {'quad_pdf': [[20, 80], [30, 80], [30, 70], [20, 70]]},
            'text': 'This existing manual box does not fit', 'appearance': {}})
        before = deepcopy(case.state['snapshot'])
        self.assertEqual(validate_snapshot(before), before)
        self.assertNotIn('autosize', before['graphics']['records'][0])
        self.assertEqual(case.service.open(before)['snapshot']['graphics'], before['graphics'])

    def test_create_textbox_history_cannot_create_another_tool_or_modify_registers(self):
        case = self.case; reply = case.command('create_textbox', textbox=self.value())
        event = deepcopy(case.documents.get_blob(reply['snapshot']['audit_head']))
        event['after']['graphics']['records'][0]['kind'] = 'stamp'
        with self.assertRaisesRegex(ValidationError, 'must create one Textbox'): validate_history(event)
        event = deepcopy(case.documents.get_blob(reply['snapshot']['audit_head']))
        event['after']['items'].append({'id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'cannot change measurements'): validate_history(event)


class TextboxLayoutPortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): projects.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = projects.TakeoffProjectTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def test_rich_and_plain_nine_and_twelve_point_rotated_crop_userunit_copies_export_without_font_changes(self):
        case = self.case; writer = PdfWriter()
        for rotation in (0, 90, 180, 270):
            page = PdfReader(BytesIO(projects.TakeoffProjectTests.pdf)).pages[0]
            page.cropbox = RectangleObject([10, 20, 490, 480]); page.rotate(rotation)
            page[NameObject('/UserUnit')] = FloatObject(2)
            writer.add_page(page)
        stream = BytesIO(); writer.write(stream); source = stream.getvalue()
        upload = case.documents.begin_upload(case.session['session_id'], 'rotated-cropped.pdf', len(source))
        case.documents.write_chunk(case.session['session_id'], upload['upload_id'], 0, source)
        doc = case.documents.finish_upload(case.session['session_id'], upload['upload_id'])
        case.session = case.service.add_document(case.session['session_id'], doc, case.session['revision'])
        def command(op, **values):
            case.session = case.service.command(case.session['session_id'], {'op': op,
                'expected_revision': case.session['revision'], 'request_id': str(uuid4()), **values})
        created_ids = []
        for page in doc['pages']:
            for size in (9, 12):
                for formatted in (False, True):
                    with self.subTest(rotation=page['rotation'], size=size, rich=formatted):
                        value = {'mode': 'steel', 'document_id': doc['id'], 'source_sha256': doc['sha256'],
                            'page': page['page'], 'anchor_pdf': [220.123456789, 240.987654321],
                            'display_rotation': page['rotation'], 'appearance': {'font_size': size},
                            'text': 'Rich é\nBullet one\nNumber one' if formatted else 'Plain one\nPlain two\nPlain three'}
                        if formatted: value['text_content'] = rich()
                        command('create_textbox', textbox=value)
                        original = case.session['snapshot']['graphics']['records'][-1]
                        self.assertEqual(original['geometry']['quad_pdf'][0], value['anchor_pdf'])
                        self.assertEqual(original['appearance']['font_size'], size)
                        quad = original['geometry']['quad_pdf']
                        center = [(min(p[axis] for p in quad)+max(p[axis] for p in quad))/2 for axis in (0, 1)]
                        target = [360.6600172251075, 340.69998995211756]
                        copied = {key: deepcopy(original[key]) for key in ('mode', 'document_id', 'source_sha256', 'page', 'kind', 'text', 'appearance')}
                        if formatted: copied['text_content'] = deepcopy(original['text_content'])
                        copied['geometry'] = {'quad_pdf': [[p[axis]+target[axis]-center[axis] for axis in (0, 1)] for p in quad]}
                        validate_textbox_fit(copied, case.session['snapshot'])
                        command('create_graphic', graphic=copied)
                        created_ids.extend([original['id'], case.session['created_graphic_id']])
        before = deepcopy(case.session['snapshot'])
        payload, _, _ = case.service.export_workspace(case.session['session_id'], 'marked-pdf', {
            'expected_revision': case.session['revision'], 'mode': 'steel', 'document_id': doc['id'], 'item_ids': []})
        reader = PdfReader(BytesIO(payload)); self.assertEqual(len(reader.pages), 4)
        for page in reader.pages:
            extracted = page.extract_text().replace('\n', '')
            self.assertIn('Plain onePlain twoPlain three', extracted)
            self.assertIn('Rich é', extracted); self.assertIn('• Bullet one', extracted); self.assertIn('1. Number one', extracted)
        self.assertEqual(len(set(created_ids)), 32)
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)
        self.assertEqual(before['items'], [])
        self.assertEqual(sha256(case.documents.document_path(doc).read_bytes()).hexdigest(), sha256(source).hexdigest())

    def test_actual_rich_pdf_save_reopen_and_original_hash(self):
        case = self.case; doc = case.session['snapshot']['documents'][0]; content = rich()
        case.session = case.service.command(case.session['session_id'], {'op': 'create_textbox',
            'expected_revision': case.session['revision'], 'request_id': str(uuid4()), 'textbox': {'mode': 'steel',
            'document_id': doc['id'], 'source_sha256': doc['sha256'], 'page': 1, 'anchor_pdf': [50, 400],
            'display_rotation': 0, 'text': 'Rich é\nBullet one\nNumber one', 'text_content': content, 'appearance': {'font_size': 12}}})
        original = case.session['snapshot']['graphics']['records'][0]
        quad = original['geometry']['quad_pdf']
        center = [(min(p[axis] for p in quad)+max(p[axis] for p in quad))/2 for axis in (0, 1)]
        target = [400.6600172251075, 300.69998995211756]
        translated = [[p[axis]+target[axis]-center[axis] for axis in (0, 1)] for p in quad]
        copied = {key: deepcopy(original[key]) for key in ('mode', 'document_id', 'source_sha256', 'page', 'kind', 'text', 'text_content', 'appearance')}
        copied['geometry'] = {'quad_pdf': translated}
        case.session = case.service.command(case.session['session_id'], {'op': 'create_graphic',
            'expected_revision': case.session['revision'], 'request_id': str(uuid4()), 'graphic': copied})
        before = deepcopy(case.session['snapshot'])
        payload, _, _ = case.service.export_workspace(case.session['session_id'], 'marked-pdf', {
            'expected_revision': case.session['revision'], 'mode': 'steel', 'document_id': doc['id'], 'item_ids': []})
        reader = PdfReader(BytesIO(payload)); text = '\n'.join(page.extract_text() for page in reader.pages)
        # Rich runs are emitted one glyph at a time by the established worker;
        # pypdf puts each glyph on its own extraction line.
        joined = text.replace('\n', '')
        self.assertIn('Rich é', joined); self.assertIn('• Bullet one', joined); self.assertIn('1. Number one', joined)
        fonts = [font.get_object().get('/BaseFont', '') for page in reader.pages for font in page['/Resources']['/Font'].get_object().values()]
        self.assertTrue(any('Bold' in name for name in fonts))
        bold_segments = []
        for page in reader.pages:
            page.extract_text(visitor_text=lambda value, cm, tm, font, size:
                bold_segments.append(value) if font and 'Bold' in font.get('/BaseFont', '') and size == 12 else None)
        self.assertIn('Rich é', ''.join(bold_segments).replace('\n', ''))
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)
        case.request.update(takeoffs=before); case.library.save_as(case.request)
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        self.assertEqual(opened['takeoffs']['graphics'], before['graphics'])
        self.assertEqual(opened['takeoffs']['items'], [])
        self.assertEqual(sha256(case.documents.document_path(doc).read_bytes()).hexdigest(), doc['sha256'])
