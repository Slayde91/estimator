"""Independent PDF notes persist and export without acquiring quantity authority."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import math
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.takeoff_graphics import (apply_graphic, export_graphics, graphic_geometry_cost,
                                       validate_graphic, validate_graphics)
from estimator.takeoff_model import audit_affected, validate_snapshot
from estimator.takeoff_markup_pdf_worker import page_transform, transform
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_workspace as workspace_fixtures
from tests import test_takeoff_physical_workspace as physical_fixtures
from tests.test_takeoff_marked_exports import drawing_fixture
from tests.test_takeoff_annotations import content


KINDS = ('cloud', 'textbox', 'stamp', 'line', 'polyline', 'arrow', 'rectangle', 'circle', 'polygon')


def proposal(document, kind='rectangle', **changes):
    geometry = ({'quad_pdf': [[30, 110], [200, 110], [200, 40], [30, 40]]}
                if kind in ('cloud', 'textbox', 'stamp', 'rectangle', 'circle') else
                {'points': [[30, 90], [100, 50], [150, 90]]} if kind in ('polyline', 'polygon') else
                {'points': [[30, 90], [100, 50]]})
    return {'mode': 'steel', 'document_id': document['id'], 'source_sha256': document['sha256'],
            'page': 1, 'kind': kind, 'geometry': geometry,
            'text': 'Literal <b>text</b> é' if kind == 'textbox' else 'REVIEWED' if kind == 'stamp' else '',
            'appearance': {}, **changes}


class TakeoffGraphicTests(unittest.TestCase):
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

    def create(self, kind='rectangle', **values):
        return self.command('create_graphic', graphic=proposal(self.document, kind, **values))['created_graphic_id']

    def record(self, identifier):
        return next(value for value in self.case.session['snapshot']['graphics']['records'] if value['id'] == identifier)

    def test_line_enabled_roundtrip_legacy_records_and_strict_boolean(self):
        identifier = self.create(appearance={'stroke_enabled': False})
        saved = deepcopy(self.case.session['snapshot'])
        self.assertIs(self.record(identifier)['appearance']['stroke_enabled'], False)
        reopened = self.case.service.open(saved)['snapshot']
        self.assertEqual(reopened, saved)
        legacy = deepcopy(saved)
        del legacy['graphics']['records'][0]['appearance']['stroke_enabled']
        before = json.dumps(legacy, sort_keys=True)
        validate_snapshot(legacy)
        self.assertEqual(json.dumps(legacy, sort_keys=True), before)
        for invalid in (0, 1, 'false', None):
            with self.assertRaises(ValidationError):
                self.create(appearance={'stroke_enabled': invalid})

    def test_pdf_disabled_borders_are_unstroked_not_zero_width_hairlines(self):
        from reportlab.pdfgen.canvas import Canvas
        from estimator.takeoff_markup_pdf_worker import _paint_graphics
        from estimator.takeoff_graphics import graphic_appearance
        for kind in ('rectangle', 'circle', 'cloud', 'polygon', 'arrow'):
            for enabled in (True, False):
                graphic = proposal(self.document, kind)
                graphic['appearance'] = graphic_appearance({'stroke_enabled': enabled, 'fill_enabled': True})
                stream = BytesIO()
                pdf = Canvas(stream, pagesize=(300, 300), invariant=1)
                _paint_graphics(pdf, [graphic], [1, 0, 0, 1, 0, 0], (0, 0, 300, 300))
                pdf.save()
                operations = PdfReader(BytesIO(stream.getvalue())).pages[0].get_contents().operations
                painted = [operator for _, operator in operations if operator in (b'S', b's', b'B', b'B*', b'b', b'b*')]
                self.assertEqual(bool(painted), enabled, (kind, enabled))
                self.assertFalse(any(operator == b'w' and operands == [0] for operands, operator in operations))

    def export(self, **values):
        return self.case.service.export_workspace(self.case.session['session_id'], 'marked-pdf', {
            'expected_revision': self.case.session['revision'], 'mode': 'steel', 'document_id': self.document['id'],
            'item_ids': [], **values})

    def test_absent_legacy_namespace_stays_absent_and_canonical_snapshot_bytes_identical(self):
        before = deepcopy(self.case.session['snapshot'])
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
        self.assertNotIn('graphics', before)
        self.assertEqual(canonical(validate_snapshot(before)), canonical(before))
        reopened = self.case.service.open(json.loads(canonical(before)))
        self.assertEqual(canonical(reopened['snapshot']), canonical(before))
        self.assertNotIn('graphics', reopened['snapshot'])
        self.case.request.update(takeoffs=self.case.session['snapshot'])
        self.case.library.save_as(self.case.request)
        stored = json.loads(self.case.target.read_bytes())
        self.assertNotIn('graphics', stored['takeoffs'])
        self.case.dialogs.opened = str(self.case.target)
        loaded = self.case.library.open_file()
        self.assertNotIn('graphics', loaded['takeoffs'])
        self.assertEqual(loaded['takeoffs'], stored['takeoffs'])
        self.assertEqual(sha256(self.case.documents.document_path(self.document).read_bytes()).hexdigest(), self.document['sha256'])

    def test_pdf_count_retains_manual_lengths_without_register_or_calibration_effects(self):
        before = deepcopy(self.case.session['snapshot'])
        geometry = {'points': [[30, 90], [100, 50]], 'lengths_m': [1.23456789012345, 4.5]}
        identifier = self.create('count', geometry=geometry)
        record = self.record(identifier)
        self.assertEqual(record['geometry'], geometry)
        for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
            self.assertEqual(self.case.session['snapshot'][key], before[key])
        reopened = self.case.service.open(deepcopy(self.case.session['snapshot']))
        self.assertEqual(reopened['snapshot']['graphics']['records'][-1], record)
        moved = deepcopy(geometry); moved['points'][0] = [40, 80]
        self.command('update_graphic', graphic_id=identifier, changes={'geometry': moved})
        self.assertEqual(self.record(identifier)['geometry']['lengths_m'], geometry['lengths_m'])
        for lengths in ([], [1], [True, 4], [0, 4], [-1, 4], [float('inf'), 4], [1e13, 4]):
            with self.subTest(lengths=lengths), self.assertRaises(ValidationError):
                validate_graphic({**record, 'geometry': {**geometry, 'lengths_m': lengths}}, self.case.session['snapshot'])
        # A single marker is valid and still does not derive length from scale.
        single = self.create('count', geometry={'points': [[30, 90]], 'lengths_m': [2]})
        self.assertEqual(self.record(single)['geometry']['lengths_m'], [2])

    def test_all_tools_have_separate_ids_bounded_styles_and_no_measurement_or_review_effect(self):
        before = deepcopy(self.case.session['snapshot'])
        ids = [self.create(kind) for kind in KINDS]
        state = self.case.session['snapshot']
        self.assertEqual(len(set(ids)), len(KINDS))
        for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
            self.assertEqual(state[key], before[key])
        self.assertEqual(self.case.session['item_results'], [])
        for identifier in ids:
            record = self.record(identifier)
            self.assertEqual(record['version'], 1)
            self.assertEqual(set(record['appearance']), {'stroke_enabled', 'stroke_color', 'stroke_width', 'opacity', 'fill_enabled', 'fill_color', 'font_color', 'font_size'})
            self.assertNotIn('quantity', record); self.assertNotIn('review', record); self.assertNotIn('confirmation', record)
            with self.assertRaisesRegex(ValidationError, 'no longer exists'):
                self.command('confirm_items', item_ids=[identifier])
        self.case.documents.validate_audit(state)
        self.assertEqual(audit_affected(before, state)['graphics'], sorted(ids))
        with self.assertRaisesRegex(ValidationError, 'Remove PDF markups'):
            self.command('delete_document', document_id=self.document['id'])

    def test_create_retry_hash_and_revision_guards_and_fresh_repeated_creation(self):
        request = {'op': 'create_graphic', 'graphic': proposal(self.document), 'request_id': str(uuid4()),
                   'expected_revision': self.case.session['revision']}
        first = self.case.service.command(self.case.session['session_id'], request)
        self.assertEqual(self.case.service.command(self.case.session['session_id'], request), first)
        self.case.session = first
        with self.assertRaisesRegex(ValidationError, 'different operation'):
            self.case.service.command(first['session_id'], {**request, 'graphic': proposal(self.document, 'circle')})
        with self.assertRaisesRegex(ValidationError, 'changed'):
            self.case.service.command(first['session_id'], {**request, 'request_id': str(uuid4())})
        second = self.create()
        self.assertNotEqual(second, first['created_graphic_id'])
        self.assertEqual(len(self.case.session['snapshot']['graphics']['records']), 2)

    def test_edit_delete_and_undo_keep_identity_and_fresh_versions_without_other_state_changes(self):
        identifier = self.create('textbox')
        self.command('update_graphic', graphic_id=identifier, changes={'text': 'Changed é', 'appearance': {'font_size': 10, 'stroke_color': '#13579B'}})
        edited = deepcopy(self.record(identifier))
        self.assertEqual(edited['version'], 2)
        before = deepcopy(self.case.session['snapshot'])
        self.command('delete_graphic', graphic_id=identifier)
        self.command('undo')
        restored = self.record(identifier)
        self.assertEqual(restored['version'], 3)
        self.assertEqual({k: v for k, v in restored.items() if k != 'version'}, {k: v for k, v in edited.items() if k != 'version'})
        for key in ('documents', 'items', 'calibrations', 'transfers', 'render_checks'):
            self.assertEqual(self.case.session['snapshot'][key], before[key])
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        self.assertEqual(event['affected_ids']['graphics'], [identifier])
        self.case.documents.validate_audit(self.case.session['snapshot'])

    def test_rich_textbox_content_is_optional_bounded_literal_and_consistent(self):
        legacy = self.create('textbox')
        self.assertNotIn('text_content', self.record(legacy))
        formatted = {'version': 1, 'blocks': [
            {'kind': 'paragraph', 'runs': [{'text': 'Literal <b>note</b>', 'bold': True, 'italic': True, 'underline': True}]},
            {'kind': 'bullet', 'runs': [{'text': 'Bullet é'}]},
            {'kind': 'number', 'runs': [{'text': 'Number one'}]},
            {'kind': 'number', 'runs': [{'text': 'Number two'}]}]}
        plain = 'Literal <b>note</b>\nBullet é\nNumber one\nNumber two'
        before = deepcopy(self.case.session['snapshot'])
        identifier = self.create('textbox', text=plain, text_content=formatted)
        self.assertEqual(self.record(identifier)['text_content'], formatted)
        for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
            self.assertEqual(self.case.session['snapshot'][key], before[key])
        before = deepcopy(self.case.session['snapshot'])
        invalid = [({'text': 'divergent', 'text_content': formatted}, 'textbox'), ({'text_content': None}, 'textbox'),
                   ({'text_content': {**formatted, 'html': '<b>bad</b>'}}, 'textbox'),
                   ({'text_content': content('note', bold='yes'), 'text': 'note'}, 'textbox'),
                   ({'text_content': content('x'*4001), 'text': 'x'*4001}, 'textbox'),
                   ({'text_content': content('note'), 'text': 'note'}, 'stamp'),
                   ({'text_content': content(''), 'text': ''}, 'rectangle')]
        for values, kind in invalid:
            with self.subTest(values=values, kind=kind), self.assertRaises(ValidationError):
                self.create(kind, **values)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        with self.assertRaisesRegex(ValidationError, 'exactly match'):
            self.command('update_graphic', graphic_id=identifier, changes={'text': 'lost formatting'})
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        edited = deepcopy(formatted); edited['blocks'][0]['runs'][0]['bold'] = False
        self.command('update_graphic', graphic_id=identifier, changes={'text_content': edited, 'text': plain})
        self.assertEqual(self.record(identifier)['id'], identifier)
        self.assertEqual(self.record(identifier)['version'], 2)
        self.command('undo')
        self.assertEqual(self.record(identifier)['text_content'], formatted)
        self.case.documents.validate_audit(self.case.session['snapshot'])
        self.assertNotIn('text_content', self.record(legacy))

    def test_rich_textbox_save_reopen_preserves_source_ids_and_markup_only_authority(self):
        formatted = content('Saved literal <script>note</script>', bold=True, italic=True, underline=True)
        identifier = self.create('textbox', text='Saved literal <script>note</script>', text_content=formatted)
        before = deepcopy(self.case.session['snapshot'])
        self.case.request.update(takeoffs=before)
        self.case.library.save_as(self.case.request)
        stored = json.loads(self.case.target.read_bytes())
        self.case.dialogs.opened = str(self.case.target)
        reopened = self.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['graphics'], before['graphics'])
        self.assertEqual(stored['takeoffs']['graphics'], before['graphics'])
        for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
            self.assertEqual(reopened['takeoffs'][key], before[key])
        self.assertEqual(reopened['takeoffs']['graphics']['records'][0]['id'], identifier)
        self.assertEqual(sha256(self.case.documents.document_path(self.document).read_bytes()).hexdigest(), self.document['sha256'])

    def test_rich_textbox_actual_pdf_retains_style_lists_font_size_and_fails_closed(self):
        formatted = {'version': 1, 'blocks': [
            {'kind': 'paragraph', 'runs': [{'text': 'Bold literal', 'bold': True, 'italic': True, 'underline': True}]},
            {'kind': 'bullet', 'runs': [{'text': 'Bullet'}]},
            {'kind': 'number', 'runs': [{'text': 'First'}]},
            {'kind': 'number', 'runs': [{'text': 'Second'}]}]}
        plain = 'Bold literal\nBullet\nFirst\nSecond'
        identifier = self.create('textbox', text=plain, text_content=formatted, appearance={'font_size': 10, 'stroke_color': '#13579B'})
        before = deepcopy(self.case.session['snapshot'])
        page = PdfReader(BytesIO(self.export()[0])).pages[0]
        compact = ''.join(page.extract_text().split())
        self.assertIn('Boldliteral•Bullet1.First2.Second', compact)
        segments = []
        page.extract_text(visitor_text=lambda value, cm, tm, font, size: segments.append((value, cm, font, size)))
        bold = ''.join(value for value, _, font, _ in segments if font and 'Bold' in font.get('/BaseFont', '')).replace('\n', '')
        self.assertIn('Bold literal', bold)
        self.assertTrue(any(abs(float(cm[2])-.18) < 1e-6 and float(size) == 10 for value, cm, _, size in segments if value.strip()), 'Italic has its own glyph transform at the requested font size.')
        ops = page.get_contents().operations
        # First line baseline is 70-6-10=54; underline is exactly 1.2pt below it.
        self.assertEqual(sum(op == b'l' and abs(float(args[1])-52.8) < 1e-5 for args, op in ops), len('Bold literal'))
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        oversized = content('Many characters '*30, bold=True)
        self.command('update_graphic', graphic_id=identifier, changes={'text': 'Many characters '*30, 'text_content': oversized})
        before = deepcopy(self.case.session['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'more text than its box'): self.export()
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.command('update_graphic', graphic_id=identifier, changes={'text': 'Unmapped \U0001f600', 'text_content': content('Unmapped \U0001f600', italic=True)})
        before = deepcopy(self.case.session['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'unsupported by the drawing PDF font'): self.export()
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_hostile_fields_text_geometry_sources_and_nonfinite_coordinates_fail_atomically(self):
        before = deepcopy(self.case.session['snapshot'])
        bad = [
            {'id': str(uuid4())}, {'quantity': 1}, {'review': {}}, {'kind': 'javascript'},
            {'mode': 'penetrations'}, {'source_sha256': 'b'*64}, {'page': True}, {'page': 2},
            {'document_id': str(uuid4())}, {'geometry': {'quad_pdf': [[0, 0], [1, 0], [1, 1], [0, 1]]}},
            {'geometry': {'quad_pdf': [[30, 110], [200, 110], [180, 40], [30, 40]]}},
            {'geometry': {'quad_pdf': [[30, 110], [200, 110], [210, 40], [40, 40]]}},
            {'geometry': {'quad_pdf': [[-1, 110], [200, 110], [200, 40], [-1, 40]]}},
            {'geometry': {'quad_pdf': [[30, 110], [200, 110], [200, 40], [30, math.nan]]}},
            {'geometry': {'quad_pdf': [[30, 110], [200, 110], [200, 40], [30, 40]], 'src': 'https://bad'}},
            {'text': 'text on a rectangle'}, {'appearance': {'stroke_color': 'url(javascript:bad)'}},
            {'appearance': {'font_size': True}}, {'appearance': {'font_size': 145}}, {'appearance': {'opacity': math.inf}},
            {'appearance': {'fill_enabled': 1}}, {'appearance': {'stroke_width': 0}}, {'appearance': {'font': 'remote.ttf'}},
        ]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValidationError): self.create(**change)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        for kind, text_value in (('textbox', ''), ('textbox', 'x'*4001), ('textbox', '\u202eprivate'),
                                 ('textbox', '\ud800'), ('stamp', 'x'*81), ('stamp', 'Two\nlines'), ('stamp', '   ')):
            with self.subTest(kind=kind), self.assertRaises(ValidationError): self.create(kind, text=text_value)
        for kind, path in [('line', [[0, 0], [0, 0]]), ('arrow', [[0, 0], [10, 0], [20, 0]]),
                           ('polyline', [[0, 0], [True, 1]]), ('polyline', [[0, 0], [math.inf, 1]]),
                           ('polygon', [[20, 20], [60, 60], [20, 60], [60, 20]])]:
            with self.subTest(kind=kind), self.assertRaises(ValidationError): self.create(kind, geometry={'points': path})
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_edits_cannot_rebind_kind_scope_source_or_smuggle_nested_geometry_fields(self):
        identifier = self.create('line'); before = deepcopy(self.case.session['snapshot'])
        for changes in ({'kind': 'arrow'}, {'source_sha256': 'b'*64}, {'mode': 'duct'}, {'page': 2},
                        {'quantity': 2}, {}, {'geometry': {'points': [[30, 50], [70, 50]], 'markup': '<svg/>'}},
                        {'appearance': {'font_size': False}}, {'text': 'unbound note'}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.command('update_graphic', graphic_id=identifier, changes=changes)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        for collection in ({'version': True, 'records': []}, {'version': 2, 'records': []}, {'version': 1, 'records': [], 'extra': 0}):
            with self.assertRaises(ValidationError): validate_graphics({**before, 'graphics': collection})

    def test_point_text_limits_and_combined_visual_capacity_and_cross_namespace_identity(self):
        path = [[20+i*.1, 30+(i%2)] for i in range(1000)]
        self.create('polyline', geometry={'points': path})
        with self.assertRaises(ValidationError): self.create('polyline', geometry={'points': path+[[120, 30]]})
        self.create('textbox', text='x'*4000)
        template = deepcopy(self.record(self.create()))
        state = deepcopy(self.case.session['snapshot'])
        state['graphics']['records'] = [{**deepcopy(template), 'id': str(uuid4())} for _ in range(1000)]
        validate_snapshot(state)
        with self.assertRaisesRegex(ValidationError, 'combined'):
            apply_graphic(state, {'op': 'create_graphic', 'graphic': proposal(self.document)})
        state['graphics']['records'].append({**template, 'id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'combined'): validate_snapshot(state)
        state['graphics']['records'] = [{**template, 'id': self.document['id']}]
        with self.assertRaisesRegex(ValidationError, 'unique and separate'): validate_snapshot(state)
        self.command('create_annotation', annotation={'mode': 'steel', 'document_id': self.document['id'],
            'source_sha256': self.document['sha256'], 'page': 1, 'point': [30, 40], 'label_position': [50, 100],
            'width': 70, 'height': 35, 'appearance': {}, 'content': content('A separate note')})
        state = deepcopy(self.case.session['snapshot'])
        state['graphics']['records'] = [{**deepcopy(template), 'id': str(uuid4())} for _ in range(999)]
        validate_snapshot(state)
        state['graphics']['records'].append({**template, 'id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'combined'): validate_snapshot(state)
        state['graphics']['records'] = [{**template, 'id': state['annotations']['callouts'][0]['id']}]
        with self.assertRaisesRegex(ValidationError, 'unique and separate'): validate_snapshot(state)

    def test_project_roundtrip_preserves_all_graphic_fields_frozen_prices_calculators_and_original_pdf(self):
        ids = [self.create(kind, appearance={'stroke_color': '#13579B', 'font_size': 10, 'opacity': .61}) for kind in KINDS]
        expected = deepcopy(self.case.session['snapshot']['graphics'])
        self.case.request.update(takeoffs=self.case.session['snapshot'])
        self.case.library.save_as(self.case.request)
        saved = json.loads(self.case.target.read_bytes()); original = json.loads(self.case.legacy)
        for key in ('estimate', 'calculators'): self.assertEqual(saved[key], original[key])
        self.assertEqual(saved['takeoffs']['graphics'], expected)
        self.case.dialogs.opened = str(self.case.target); reopened = self.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['graphics'], expected)
        self.assertEqual([record['id'] for record in reopened['takeoffs']['graphics']['records']], ids)
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.case.documents.validate_audit(reopened['takeoffs'])
        companion = self.case.root / saved['takeoffs']['companion_folder']
        self.assertEqual((companion / 'documents' / (self.document['sha256']+'.pdf')).read_bytes(), self.case.pdf)

    def test_graphics_do_not_change_confirmed_transfer_or_signatures_and_annotations(self):
        case = workspace_fixtures.TakeoffWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        item = case.create(); case.confirm(item); case.apply(case.preview(item))
        before = deepcopy(case.state['snapshot']); calculator = deepcopy(case.state['calculator']); results = deepcopy(case.state['item_results'])
        created = case.command('create_graphic', graphic=proposal(case.doc, 'arrow'))['created_graphic_id']
        case.command('update_graphic', graphic_id=created, changes={'appearance': {'stroke_color': '#2468AB'}})
        for key in ('items', 'transfers', 'documents', 'calibrations'): self.assertEqual(case.state['snapshot'][key], before[key])
        self.assertEqual(case.state['item_results'], results)
        result = case.preview(item, inputs=calculator['inputs'], rows=calculator['schedule_rows'], update=True)
        self.assertEqual(result['changes'], [{'item_id': item, 'row': calculator['schedule_rows'][0], 'action': 'unchanged'}])
        signature = {'mode': 'steel', 'document_id': self.document['id'], 'source_sha256': self.document['sha256'],
            'page': 1, 'quad_pdf': [[30, 100], [100, 100], [100, 50], [30, 50]], 'strokes': [[[0, 0], [1, 1]]], 'appearance': {}}
        self.command('create_signature', signature=signature)
        retained = deepcopy(self.case.session['snapshot']['signatures'])
        identifier = self.create()
        self.command('delete_graphic', graphic_id=identifier); self.command('undo')
        self.assertEqual(self.case.session['snapshot']['signatures'], retained)

    def test_retained_audit_rejects_rewritten_tool_source_version_operation_and_other_state(self):
        identifier = self.create()
        self.command('update_graphic', graphic_id=identifier, changes={'appearance': {'stroke_color': '#13579B'}})
        state = self.case.session['snapshot']; event = self.case.documents.get_blob(state['audit_head'])
        for change, message in [('version', 'fresh increasing version'), ('kind', 'source or tool identity'),
                                ('mode', 'source or tool identity'), ('op', 'controlled markup'), ('other', 'cannot change measurements')]:
            forged = deepcopy(event)
            record = forged['after']['graphics']['records'][0]
            if change == 'version': record['version'] = 1
            elif change == 'kind': record['kind'] = 'circle'
            elif change == 'mode': record['mode'] = 'duct'
            elif change == 'op': forged['op'] = 'create_item'
            else: forged['after']['render_checks'].append({'document_id': self.document['id'], 'page': 1, 'success': True, 'warnings': []})
            forged['affected_ids'] = audit_affected(forged['before'], forged['after'])
            head = self.case.documents.put_blob(forged)
            with self.subTest(change=change), self.assertRaisesRegex(ValidationError, message):
                self.case.documents.validate_audit({**state, 'audit_head': head})
        initial = deepcopy(state); initial.update(audit_head=None, revision=0)
        with self.assertRaisesRegex(ValidationError, 'creation history'): self.case.documents.validate_audit(initial)
        self.case.documents.validate_audit(state)

    def test_physical_signature_independence_and_undo_do_not_change_graph_or_require_image_review(self):
        case = physical_fixtures.PhysicalWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        state, _ = case.apply([case.defect()]); original = deepcopy(state['snapshot']['physical'])
        state = case.service.command(case.sid, {'op': 'create_graphic', 'request_id': str(uuid4()),
            'expected_revision': state['revision'], 'graphic': proposal(case.case.doc, 'rectangle', mode='defect_reports')})
        self.assertEqual(state['snapshot']['physical'], original)
        case.images.blocked = True
        state = case.service.command(case.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': state['revision']})
        self.assertEqual(state['snapshot']['physical'], original)
        self.assertNotIn('graphics', state['snapshot'])

    def test_all_workspace_modes_and_export_selection_is_exact_source_and_scope(self):
        ids = {mode: self.create(mode=mode) for mode in ('steel', 'duct', 'wall', 'slab', 'defect_reports', 'service_plans')}
        state = self.case.session['snapshot']
        for mode, identifier in ids.items():
            self.assertEqual([record['id'] for record in export_graphics(state, {}, self.document['id'], (mode,))], [identifier])
            self.assertEqual(export_graphics(state, {'graphic_ids': []}, self.document['id'], (mode,)), [])
            for bad in ([identifier, identifier], [str(uuid4())], list(set(ids.values())-{identifier}), [True]):
                with self.assertRaisesRegex(ValidationError, 'Export PDF markup IDs'):
                    export_graphics(state, {'graphic_ids': bad}, self.document['id'], (mode,))
        with self.assertRaisesRegex(ValidationError, 'Export PDF markup IDs'):
            export_graphics(state, {'graphic_ids': [ids['steel']]}, str(uuid4()), ('steel',))
        self.command('delete_graphic', graphic_id=ids['steel'])
        with self.assertRaisesRegex(ValidationError, 'Export PDF markup IDs'): self.export(graphic_ids=[ids['steel']])

    def test_real_pdf_all_tools_vector_paint_and_literal_unicode_text_preserve_source_and_state(self):
        ids = [self.create(kind, appearance={'stroke_color': '#13579B', 'font_size': 10, 'fill_enabled': True}) for kind in KINDS]
        before = deepcopy(self.case.session['snapshot']); source = self.case.documents.document_path(self.document)
        original = source.read_bytes()
        reader = PdfReader(BytesIO(self.export(graphic_ids=ids)[0]))
        text = reader.pages[0].extract_text()
        self.assertIn('Literal <b>text</b> é', text)
        self.assertIn('REVIEWED', text)
        self.assertIn('9 PDF markups (visual marks only); no measurement markups.', text)
        operations = reader.pages[0].get_contents().operations
        self.assertGreater(sum(op == b'c' for _, op in operations), 4, 'Cloud and ellipse are real vector curves.')
        self.assertGreater(sum(op == b'l' for _, op in operations), 5, 'Arrow, line/polyline and polygon remain vector paths.')
        empty = PdfReader(BytesIO(self.export(graphic_ids=[])[0])).pages[0].extract_text()
        self.assertNotIn('REVIEWED', empty)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_rotated_cropbox_userunit_line_vectors_have_exact_source_projection_and_physical_ink_width(self):
        pdf = drawing_fixture(); case = self.case
        upload = case.documents.begin_upload(case.session['session_id'], 'rotation.pdf', len(pdf))
        case.documents.write_chunk(case.session['session_id'], upload['upload_id'], 0, pdf)
        self.document = case.documents.finish_upload(case.session['session_id'], upload['upload_id'])
        case.session = case.service.add_document(case.session['session_id'], self.document, case.session['revision'])
        for page in range(1, 5): self.create('line', page=page, appearance={'stroke_color': '#13579B', 'stroke_width': 2})
        reader = PdfReader(BytesIO(self.export()[0]))
        for index, page in enumerate(reader.pages):
            metadata = self.document['pages'][index]
            _, drawing_width, drawing_height = page_transform(metadata)
            matrix, _, _ = page_transform(metadata, float(page.mediabox.height)-drawing_height, (float(page.mediabox.width)-drawing_width)/2)
            expected = [transform(point, matrix) for point in ([30, 90], [100, 50])]
            operations = page.get_contents().operations
            start = next(i for i, (args, op) in enumerate(operations) if op == b'RG'
                and all(abs(float(args[j])-value/255) < 1e-5 for j, value in enumerate((19, 87, 155))))
            ink = operations[start:]
            self.assertEqual(next(float(args[0]) for args, op in ink if op == b'w'), 2)
            path = [(float(args[0]), float(args[1])) for args, op in ink if op in (b'm', b'l')][:2]
            for actual, target in zip(path, expected):
                for a, b in zip(actual, target): self.assertAlmostEqual(a, b, places=5)
            self.assertEqual(len(path), 2)
            self.assertNotIn('/Annots', page)

    def test_physical_scopes_and_view_rotation_filter_graphics_without_creating_physical_graph(self):
        defect = self.create('arrow', mode='defect_reports', appearance={'stroke_color': '#13579B'})
        plan = self.create('rectangle', mode='service_plans', appearance={'stroke_color': '#97531B'})
        request = {'expected_revision': self.case.session['revision'], 'mode': 'penetrations',
                   'physical_scope': 'defect_reports', 'document_id': self.document['id'], 'item_ids': [],
                   'graphic_ids': [defect], 'rendering': {'zoom': .37, 'rotations': {'1': 90}}}
        before = deepcopy(self.case.session['snapshot'])
        payload = self.case.service.export_workspace(self.case.session['session_id'], 'marked-pdf', request)[0]
        page = PdfReader(BytesIO(payload)).pages[0]
        self.assertNotIn('TAKEOFF LEGEND', page.extract_text())
        for args, op in page.get_contents().operations:
            if op == b'RG': self.assertFalse(abs(float(args[0])-151/255) < 1e-5 and abs(float(args[1])-83/255) < 1e-5)
        with self.assertRaisesRegex(ValidationError, 'Export PDF markup IDs'):
            self.case.service.export_workspace(self.case.session['session_id'], 'marked-pdf', {**request, 'graphic_ids': [plan]})
        self.case.service.export_workspace(self.case.session['session_id'], 'marked-pdf', {**request, 'physical_scope': 'service_plans', 'graphic_ids': [plan]})
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.assertNotIn('physical', before); self.assertNotIn('service_plans', before)

    def test_walls_floors_pdf_combines_only_native_surface_scopes(self):
        wall = self.create(mode='wall'); floor = self.create(mode='slab')
        payload = self.export(mode='walls_floors', graphic_ids=[wall, floor])[0]
        self.assertIn('2 PDF markups (visual marks only)', PdfReader(BytesIO(payload)).pages[0].extract_text())
        with self.assertRaisesRegex(ValidationError, 'Export PDF markup IDs'): self.export(mode='wall', graphic_ids=[floor])

    def test_text_overflow_and_unsupported_glyph_reject_export_without_changing_retained_notes(self):
        identifier = self.create('textbox', text='Many retained characters '*20,
                                 geometry={'quad_pdf': [[30, 100], [60, 100], [60, 70], [30, 70]]})
        before = deepcopy(self.case.session['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'more text than its box'): self.export()
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.command('update_graphic', graphic_id=identifier, changes={'text': 'Unmapped \U0001f600'})
        before = deepcopy(self.case.session['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'unsupported by the drawing PDF font'): self.export()
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)

    def test_geometry_admission_counts_derived_cloud_curves_before_starting_pdf_worker(self):
        identifier = self.create('cloud'); template = self.record(identifier)
        self.assertEqual(graphic_geometry_cost(template), 772)
        graphics = [{**deepcopy(template), 'id': str(uuid4())} for _ in range(260)]
        from estimator.takeoff_markup_pdf import export_marked_pdf
        state = self.case.session['snapshot']
        with patch('estimator.takeoff_markup_pdf.subprocess.run', side_effect=AssertionError('Worker must not start')):
            with self.assertRaisesRegex(ValidationError, 'geometry exceeds'):
                export_marked_pdf(self.document, [], {}, {}, {}, self.case.documents, project_id=state['project_id'],
                                  revision=state['revision'], mode='steel', snapshot=state, graphics=graphics)


if __name__ == '__main__':
    unittest.main()
