"""Free call-outs persist as safe presentation, without measurement authority."""

from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.takeoff_annotations import MAX_CONTENT_CHARACTERS, validate_content
from estimator.takeoff_model import audit_affected, validate_snapshot
from tests import test_takeoff_project as fixtures
from tests import test_takeoff_workspace as workspace_fixtures
from tests import test_takeoff_physical_workspace as physical_fixtures
from tests.test_takeoff_marked_exports import drawing_fixture


def content(text='Retain this note', **marks):
    return {'version': 1, 'blocks': [{'kind': 'paragraph', 'runs': [{'text': text, **marks}]}]}


class TakeoffAnnotationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = fixtures.TakeoffProjectTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.document = self.case.session['snapshot']['documents'][0]

    def command(self, op, **values):
        case = self.case
        case.session = case.service.command(case.session['session_id'], {
            'op': op, 'request_id': str(uuid4()), 'expected_revision': case.session['revision'], **values})
        return case.session

    def proposal(self, **values):
        return {'mode': 'steel', 'document_id': self.document['id'], 'source_sha256': self.document['sha256'],
                'page': 1, 'point': [70.1234567890123, 200.2345678901234], 'label_position': [110, 330],
                'width': 238, 'height': 120, 'appearance': {}, 'content': content(), **values}

    def create(self, **values):
        return self.command('create_annotation', annotation=self.proposal(**values))['created_annotation_id']

    def export(self, **values):
        case = self.case
        return case.service.export_workspace(case.session['session_id'], 'marked-pdf', {
            'expected_revision': case.session['revision'], 'mode': 'steel', 'document_id': self.document['id'],
            'item_ids': [], **values})

    def test_legacy_open_does_not_add_an_annotation_collection_or_change_schema(self):
        before = deepcopy(self.case.session['snapshot'])
        result = self.case.service.get(self.case.session['session_id'])['snapshot']
        self.assertEqual(before, result)
        self.assertNotIn('annotations', result)
        self.assertEqual(result['version'], 1)
        self.assertEqual(validate_snapshot(result), result)

    def test_create_edit_move_delete_and_undo_keep_source_coordinates_and_no_measurement_authority(self):
        before = deepcopy(self.case.session['snapshot'])
        identifier = self.create()
        state = self.case.session['snapshot']
        record = state['annotations']['callouts'][0]
        self.assertEqual(record['appearance']['stroke_color'], '#FF3300')
        self.assertEqual(record['appearance']['opacity'], .75)
        self.assertEqual(state['version'], 1)
        self.assertEqual(record['point'], self.proposal()['point'])
        for key in ('items', 'transfers', 'calibrations', 'render_checks'):
            self.assertEqual(state[key], before[key])
        self.assertEqual(self.case.session['item_results'], [])
        self.assertEqual(audit_affected(before, state)['annotations'], [identifier])
        self.command('update_annotation', annotation_id=identifier, changes={
            'content': content('Edited <script>literal text</script>', bold=True, italic=True, underline=True),
            'point': [80.1234567890123, 215.2345678901234], 'label_position': [125, 325],
            'appearance': {'fill_enabled': False, 'opacity': .42}})
        changed = deepcopy(self.case.session['snapshot']['annotations']['callouts'][0])
        self.assertEqual(changed['id'], identifier)
        self.assertEqual(changed['version'], 2)
        self.command('delete_annotation', annotation_id=identifier)
        self.assertEqual(self.case.session['snapshot']['annotations']['callouts'], [])
        self.command('undo')
        restored = self.case.session['snapshot']['annotations']['callouts'][0]
        self.assertEqual({key: value for key, value in restored.items() if key != 'version'},
                         {key: value for key, value in changed.items() if key != 'version'})
        self.assertEqual(restored['version'], 3)
        for op in ('confirm_items', 'review_items'):
            with self.subTest(op=op), self.assertRaisesRegex(ValidationError, 'no longer exists'):
                self.command(op, item_ids=[identifier])
        with self.assertRaisesRegex(ValidationError, 'Remove free call-outs'):
            self.command('delete_document', document_id=self.document['id'])
        self.assertEqual(self.case.session['snapshot']['items'], [])
        self.assertNotIn('physical', self.case.session['snapshot'])

    def test_creation_request_retry_returns_same_annotation_identity_without_duplication(self):
        request = {'op': 'create_annotation', 'annotation': self.proposal(), 'request_id': str(uuid4()),
                   'expected_revision': self.case.session['revision']}
        first = self.case.service.command(self.case.session['session_id'], request)
        second = self.case.service.command(self.case.session['session_id'], request)
        self.assertEqual(first, second)
        self.assertEqual(len(first['snapshot']['annotations']['callouts']), 1)

    def test_free_note_does_not_change_confirmed_measurement_receipts_or_current_transfer_values(self):
        case = workspace_fixtures.TakeoffWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        item_id = case.create()
        case.confirm(item_id); case.apply(case.preview(item_id))
        before = deepcopy(case.state['snapshot']); results = deepcopy(case.state['item_results'])
        calculator = deepcopy(case.state['calculator'])
        case.command('create_annotation', annotation={
            'mode': 'steel', 'document_id': case.doc['id'], 'source_sha256': case.doc['sha256'], 'page': 1,
            'point': [65.1234567890123, 40.1234567890123], 'label_position': [75, 85], 'width': 70, 'height': 35,
            'appearance': {}, 'content': content('Presentation only')})
        for key in ('items', 'transfers', 'documents', 'calibrations'):
            self.assertEqual(case.state['snapshot'][key], before[key])
        self.assertEqual(case.state['item_results'], results)
        self.assertEqual(case.state['snapshot']['items'][0]['state'], 'confirmed')
        self.assertEqual(case.state['snapshot']['transfers'][0]['values'], before['transfers'][0]['values'])
        inputs = calculator['inputs']; rows = calculator['schedule_rows']
        preview = case.preview(item_id, inputs=inputs, rows=rows, update=True)
        self.assertEqual(preview['changes'], [{'item_id': item_id, 'row': rows[0], 'action': 'unchanged'}])

    def test_malformed_unbounded_or_authority_shaped_content_and_geometry_are_rejected_atomically(self):
        before = deepcopy(self.case.session['snapshot'])
        for values in ({'source_sha256': 'b'*64}, {'point': [-1, 20]}, {'label_position': [900, 900]},
                       {'width': 0}, {'height': True}, {'mode': 'penetrations'}, {'quantity': 1},
                       {'appearance': {'font_color': 'url(https://invalid)'}},
                       {'appearance': {'marker_size': 10}}, {'content': content('x'*(MAX_CONTENT_CHARACTERS+1))},
                       {'content': content('hidden\u202econtrol')}, {'content': content('delete\u007fcontrol')}, {'content': content('text', bold='true')},
                       {'content': {'version': 1, 'html': '<script>alert(1)</script>'}}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                self.create(**values)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.assertEqual(validate_content(content('<b>Literal HTML</b>')), content('<b>Literal HTML</b>'))
        self.create()
        malformed = deepcopy(self.case.session['snapshot'])
        malformed['annotations']['callouts'][0]['appearance'] = {}
        with self.assertRaisesRegex(ValidationError, 'Stored call-out appearance'):
            validate_snapshot(malformed)

    def test_save_and_reopen_preserve_content_identity_calculators_frozen_prices_and_exact_original(self):
        identifier = self.create(content={'version': 1, 'blocks': [
            {'kind': 'paragraph', 'runs': [{'text': 'Bold ', 'bold': True}, {'text': 'italic', 'italic': True}]},
            {'kind': 'bullet', 'runs': [{'text': 'Underlined note', 'underline': True}]},
            {'kind': 'number', 'runs': [{'text': 'Final note'}]}]})
        expected = deepcopy(self.case.session['snapshot']['annotations'])
        self.case.request.update(takeoffs=self.case.session['snapshot'])
        self.case.library.save_as(self.case.request)
        saved = json.loads(self.case.target.read_bytes())
        legacy = json.loads(self.case.legacy)
        for key in ('estimate', 'calculators'):
            self.assertEqual(saved[key], legacy[key])
        self.assertEqual(saved['takeoffs']['annotations'], expected)
        self.case.dialogs.opened = str(self.case.target)
        opened = self.case.library.open_file()
        self.assertEqual(opened['takeoffs']['annotations'], expected)
        self.assertEqual(opened['takeoffs']['annotations']['callouts'][0]['id'], identifier)
        self.assertEqual(opened['takeoffs_issues'], [])
        companion = self.case.root / saved['takeoffs']['companion_folder']
        retained = companion / 'documents' / (self.document['sha256']+'.pdf')
        self.assertEqual(retained.read_bytes(), self.case.pdf)

    def test_pdf_contains_every_literal_formatted_character_and_visibility_scope_is_separate(self):
        identifier = self.create(content={'version': 1, 'blocks': [
            {'kind': 'paragraph', 'runs': [{'text': 'SAFE <b>literal</b>', 'bold': True}, {'text': ' italic', 'italic': True}]},
            {'kind': 'bullet', 'runs': [{'text': 'Underlined LAST_TOKEN', 'underline': True}]}]})
        self.create(mode='duct', content=content('DUCT_ONLY'))
        original = self.case.documents.document_path(self.document).read_bytes()
        payload, kind, _ = self.export(annotation_ids=[identifier])
        reader = PdfReader(BytesIO(payload))
        text = ''.join(page.extract_text() for page in reader.pages)
        compact = ''.join(text.split())
        self.assertIn('SAFE<b>literal</b>italic', compact)
        self.assertIn('UnderlinedLAST_TOKEN', compact)
        self.assertNotIn('DUCT_ONLY', text)
        self.assertIn('1 free Call-out (drawing notes only); no measurement markups.', text)
        self.assertNotIn('No visible markups', text)
        self.assertEqual(kind, 'application/pdf')
        operations = reader.pages[0].get_contents().operations
        self.assertTrue(any(operator == b'l' for _, operator in operations), 'Leader and underline have vector paths.')
        self.assertNotIn('LAST_TOKEN', PdfReader(BytesIO(self.export(annotation_ids=[])[0])).pages[0].extract_text())
        self.assertIn('No visible markups', PdfReader(BytesIO(self.export(annotation_ids=[])[0])).pages[0].extract_text())
        with self.assertRaisesRegex(ValidationError, 'selected mode'):
            self.export(mode='duct', annotation_ids=[identifier])
        self.assertEqual(sha256(self.case.documents.document_path(self.document).read_bytes()).digest(), sha256(original).digest())
        with self.assertRaisesRegex(ValidationError, 'no items'):
            self.case.service.export_workspace(self.case.session['session_id'], 'schedule-xlsx', {
                'expected_revision': self.case.session['revision'], 'mode': 'steel'})

    def test_pdf_fails_explicitly_if_all_text_cannot_fit_or_font_cannot_render_it(self):
        identifier = self.create(width=10, height=10, content=content('This text cannot fit.' * 50))
        with self.assertRaisesRegex(ValidationError, 'more text than its box|too narrow'):
            self.export()
        self.command('update_annotation', annotation_id=identifier, changes={'width': 238, 'height': 120, 'content': content('Unsupported \U0001f600')})
        with self.assertRaisesRegex(ValidationError, 'unsupported by the drawing PDF font'):
            self.export()

    def test_narrow_box_shrinks_font_before_rejecting_a_character(self):
        self.create(width=10, height=30, content=content('W', bold=True))
        page = PdfReader(BytesIO(self.export()[0])).pages[0]
        self.assertIn('W', page.extract_text())
        fonts = [float(values[1]) for values, operator in page.get_contents().operations if operator == b'Tf']
        self.assertTrue(any(4 <= size < 10 for size in fonts))

    def test_mixed_drawing_caption_counts_notes_separately_without_measurement_register_rows(self):
        identifier = self.create(content=content('Free note alongside a measured item'))
        self.command('create_item', item={'mode': 'steel', 'quantity': 2,
            'geometry': {'document_id': self.document['id'], 'page': 1, 'points': [[30, 40], [80, 40]]},
            'measurement': {'method': 'cited', 'length_m': 1.234567890123, 'citation': 'Explicit source length'},
            'fields': {'mark': 'MEASURED-ONLY', 'section': '100UC15', 'member_type': 'Beam',
                       'exposure': 'Re-entrant - 3 sides', 'fire_period_min': 120}, 'evidence': []})
        item = self.case.session['snapshot']['items'][0]
        before = deepcopy(self.case.session['snapshot'])
        mixed = PdfReader(BytesIO(self.export(item_ids=[item['id']], annotation_ids=[identifier])[0]))
        measurements = PdfReader(BytesIO(self.export(item_ids=[item['id']], annotation_ids=[])[0]))
        text = mixed.pages[0].extract_text()
        self.assertIn('1 free Call-out (drawing notes only); excluded from measurement register.', text)
        self.assertIn('MEASURED-ONLY', text)
        self.assertIn('2.47 m total', text)
        self.assertNotIn('no measurement markups', text)
        self.assertEqual(list(mixed.pages[0].mediabox), list(measurements.pages[0].mediabox))
        self.assertEqual(mixed.pages[0].get('/Rotate', 0), measurements.pages[0].get('/Rotate', 0))
        self.assertEqual(mixed.pages[0].get('/UserUnit', 1), measurements.pages[0].get('/UserUnit', 1))
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_rotated_cropped_userunit_pdf_exports_preserve_original_annotation_positions(self):
        self.case.pdf = drawing_fixture()
        upload = self.case.documents.begin_upload(self.case.session['session_id'], 'rotation.pdf', len(self.case.pdf))
        self.case.documents.write_chunk(self.case.session['session_id'], upload['upload_id'], 0, self.case.pdf)
        self.document = self.case.documents.finish_upload(self.case.session['session_id'], upload['upload_id'])
        self.case.session = self.case.service.add_document(self.case.session['session_id'], self.document, self.case.session['revision'])
        for page in range(1, 5):
            self.create(page=page, point=[50.123456789, 65.23456789], label_position=[70, 80], width=70, height=30,
                        content=content(f'ROTATION {90*(page-1)}'))
        before = deepcopy(self.case.session['snapshot'])
        reader = PdfReader(BytesIO(self.export()[0]))
        self.assertEqual(len(reader.pages), 4)
        for page, output in enumerate(reader.pages, 1):
            self.assertIn(f'ROTATION {90*(page-1)}', ''.join(output.extract_text().splitlines()))
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_retained_audit_rejects_rewritten_source_or_nonincreasing_versions(self):
        identifier = self.create()
        self.command('update_annotation', annotation_id=identifier, changes={'content': content('Changed')})
        snapshot = self.case.session['snapshot']
        event = self.case.documents.get_blob(snapshot['audit_head'])
        for change in ('version', 'binding', 'op'):
            forged = deepcopy(event)
            if change == 'version':
                forged['after']['annotations']['callouts'][0]['version'] = 1
                message = 'fresh increasing version'
            elif change == 'binding':
                forged['after']['annotations']['callouts'][0]['mode'] = 'duct'
                message = 'source identity'
            else:
                forged['op'] = 'create_item'
                message = 'controlled annotation'
            head = self.case.documents.put_blob(forged)
            with self.subTest(change=change), self.assertRaisesRegex(ValidationError, message):
                self.case.documents.validate_audit({**snapshot, 'audit_head': head})
        self.case.documents.validate_audit(snapshot)

    def test_annotation_undo_on_physical_snapshot_does_not_enter_physical_evidence_gate(self):
        case = physical_fixtures.PhysicalWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        state, _ = case.apply([case.defect()])
        original = deepcopy(state['snapshot']['physical'])
        document = case.case.doc
        create = {'op': 'create_annotation', 'request_id': str(uuid4()), 'expected_revision': state['revision'],
                  'annotation': {'mode': 'duct', 'document_id': document['id'], 'source_sha256': document['sha256'],
                      'page': 1, 'point': [70, 40], 'label_position': [75, 90], 'width': 70, 'height': 30,
                      'appearance': {}, 'content': content('Free note')}}
        state = case.service.command(case.sid, create)
        with patch.object(case.service, '_physical_gate', side_effect=AssertionError('Annotation Undo requires no physical gate')):
            state = case.service.command(case.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': state['revision']})
        self.assertEqual(state['snapshot']['physical'], original)
        self.assertNotIn('annotations', state['snapshot'])


if __name__ == '__main__':
    unittest.main()
