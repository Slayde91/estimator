"""Private vector ink persists safely without adding measurement authority."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.takeoff_model import audit_affected, validate_snapshot
from estimator.takeoff_signatures import apply_signature, export_signatures
from estimator.takeoff_markup_pdf_worker import page_transform, transform
from tests import test_takeoff_project as project_fixtures
from tests import test_takeoff_workspace as workspace_fixtures
from tests import test_takeoff_physical_workspace as physical_fixtures
from tests.test_takeoff_annotations import content
from tests.test_takeoff_marked_exports import drawing_fixture


def proposal(document, **values):
    return {'mode': 'steel', 'document_id': document['id'], 'source_sha256': document['sha256'],
            'page': 1, 'quad_pdf': [[30, 90], [100, 90], [100, 50], [30, 50]],
            'strokes': [[[0, 0], [.25, .7], [1, 1]], [[.3, .5], [.6, .4]]], 'appearance': {}, **values}


class TakeoffSignatureTests(unittest.TestCase):
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

    def create(self, **values):
        return self.command('create_signature', signature=proposal(self.document, **values))['created_signature_id']

    def export(self, **values):
        return self.case.service.export_workspace(self.case.session['session_id'], 'marked-pdf', {
            'expected_revision': self.case.session['revision'], 'mode': 'steel', 'document_id': self.document['id'],
            'item_ids': [], **values})

    def test_legacy_open_remains_byte_equivalent_without_optional_collection(self):
        before = deepcopy(self.case.session['snapshot'])
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.assertNotIn('signatures', before)
        self.assertEqual(before['version'], 1)
        self.assertEqual(validate_snapshot(before), before)

    def test_create_edit_delete_undo_audit_and_no_quantity_or_review_authority(self):
        before = deepcopy(self.case.session['snapshot'])
        identifier = self.create()
        state = self.case.session['snapshot']; record = state['signatures']['records'][0]
        self.assertEqual(record['appearance'], {'stroke_color': '#000000', 'stroke_width': 2, 'opacity': 1})
        self.assertEqual(record['quad_pdf'], proposal(self.document)['quad_pdf'])
        self.assertEqual(state['version'], 1)
        self.assertEqual(audit_affected(before, state)['signatures'], [identifier])
        for key in ('items', 'transfers', 'calibrations', 'documents', 'render_checks'):
            self.assertEqual(state[key], before[key])
        self.assertEqual(self.case.session['item_results'], [])
        self.command('update_signature', signature_id=identifier, changes={
            'quad_pdf': [[40, 100], [110, 100], [110, 60], [40, 60]],
            'strokes': [[[0, 1], [1, 0]]], 'appearance': {'opacity': .42, 'stroke_color': '#13579B'}})
        edited = deepcopy(self.case.session['snapshot']['signatures']['records'][0])
        self.assertEqual(edited['version'], 2)
        self.assertEqual(edited['appearance']['stroke_width'], 2)
        self.command('delete_signature', signature_id=identifier)
        self.assertEqual(self.case.session['snapshot']['signatures']['records'], [])
        self.command('undo')
        restored = self.case.session['snapshot']['signatures']['records'][0]
        self.assertEqual(restored['version'], 3)
        self.assertEqual({k: v for k, v in restored.items() if k != 'version'},
                         {k: v for k, v in edited.items() if k != 'version'})
        self.case.documents.validate_audit(self.case.session['snapshot'])
        event = self.case.documents.get_blob(self.case.session['snapshot']['audit_head'])
        self.assertEqual(event['affected_ids']['signatures'], [identifier])
        for op in ('confirm_items', 'review_items'):
            with self.subTest(op=op), self.assertRaisesRegex(ValidationError, 'no longer exists'):
                self.command(op, item_ids=[identifier])
        with self.assertRaisesRegex(ValidationError, 'Remove signatures'):
            self.command('delete_document', document_id=self.document['id'])

    def test_creation_retries_are_idempotent_and_stale_revisions_do_not_mutate(self):
        request = {'op': 'create_signature', 'signature': proposal(self.document), 'request_id': str(uuid4()),
                   'expected_revision': self.case.session['revision']}
        first = self.case.service.command(self.case.session['session_id'], request)
        second = self.case.service.command(self.case.session['session_id'], request)
        self.assertEqual(first, second)
        self.assertEqual(len(first['snapshot']['signatures']['records']), 1)
        with self.assertRaises(ValidationError):
            self.case.service.command(self.case.session['session_id'], {**request, 'request_id': str(uuid4())})
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], first['snapshot'])

    def test_invalid_geometry_ink_style_identity_and_authority_fields_fail_atomically(self):
        before = deepcopy(self.case.session['snapshot'])
        invalid = [
            {'source_sha256': 'b'*64}, {'document_id': str(uuid4())}, {'page': True}, {'page': 2},
            {'mode': 'penetrations'}, {'quantity': 1}, {'version': 1}, {'id': str(uuid4())},
            {'quad_pdf': [[30, 90], [100, 90], [90, 50], [30, 50]]},
            {'quad_pdf': [[30, 90], [100, 90], [110, 50], [40, 50]]},
            {'quad_pdf': [[30, 90], [35, 90], [35, 50], [30, 50]]},
            {'quad_pdf': [[-1, 90], [100, 90], [100, 50], [-1, 50]]},
            {'strokes': []}, {'strokes': [[]]}, {'strokes': [[[0, float('nan')]]]},
            {'strokes': [[[float('inf'), 0]]]}, {'strokes': [[[True, 0]]]},
            {'strokes': [[[-.01, .5]]]}, {'strokes': [[[0, 1.01]]]}, {'strokes': [[0, 1]]},
            {'strokes': [[[0, 0]]]*101}, {'strokes': [[[0, 0]]*4001]},
            {'appearance': {'stroke_color': 'url(https://invalid)'}}, {'appearance': {'fill_enabled': True}},
            {'appearance': {'stroke_width': True}}, {'appearance': {'opacity': 1.01}},
        ]
        for values in invalid:
            with self.subTest(fields=list(values)), self.assertRaises(ValidationError):
                self.create(**values)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        identifier = self.create(strokes=[[[.5, .5]]])
        valid = deepcopy(self.case.session['snapshot'])
        for changes in ({'mode': 'duct'}, {'quantity': 2}, {}, {'strokes': []}, {'appearance': {'font_color': '#FFFFFF'}}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.command('update_signature', signature_id=identifier, changes=changes)
            self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], valid)
        malformed = deepcopy(valid); malformed['signatures']['records'][0]['appearance'] = {}
        with self.assertRaisesRegex(ValidationError, 'Stored signature appearance'):
            validate_snapshot(malformed)

    def test_maximum_strokes_points_combined_cap_and_separate_persistent_identity(self):
        self.create(strokes=[[[0, 0]]*40 for _ in range(100)])
        state = deepcopy(self.case.session['snapshot']); template = state['signatures']['records'][0]
        state['signatures']['records'] = [{**deepcopy(template), 'id': str(uuid4()), 'strokes': [[[0, 0]]]}
                                         for _ in range(1000)]
        validate_snapshot(state)
        state['signatures']['records'].append({**deepcopy(template), 'id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'combined'):
            validate_snapshot(state)
        state['signatures']['records'] = [{**template, 'id': self.document['id']}]
        with self.assertRaisesRegex(ValidationError, 'unique and separate'):
            validate_snapshot(state)
        self.command('create_annotation', annotation={
            'mode': 'steel', 'document_id': self.document['id'], 'source_sha256': self.document['sha256'], 'page': 1,
            'point': [30, 40], 'label_position': [50, 100], 'width': 70, 'height': 35,
            'appearance': {}, 'content': content('A free note')})
        state = deepcopy(self.case.session['snapshot']); template = state['signatures']['records'][0]
        state['signatures']['records'] = [{**deepcopy(template), 'id': str(uuid4()), 'strokes': [[[0, 0]]]}
                                         for _ in range(999)]
        validate_snapshot(state)
        state['signatures']['records'].append({**deepcopy(template), 'id': str(uuid4())})
        with self.assertRaisesRegex(ValidationError, 'combined'):
            validate_snapshot(state)

    def test_save_reopen_preserves_vectors_frozen_prices_calculators_source_and_audit(self):
        identifier = self.create(appearance={'stroke_color': '#13579B', 'stroke_width': 2.25, 'opacity': .61})
        expected = deepcopy(self.case.session['snapshot']['signatures'])
        self.case.request.update(takeoffs=self.case.session['snapshot'])
        self.case.library.save_as(self.case.request)
        saved = json.loads(self.case.target.read_bytes()); original = json.loads(self.case.legacy)
        for key in ('estimate', 'calculators'):
            self.assertEqual(saved[key], original[key])
        self.assertEqual(saved['takeoffs']['signatures'], expected)
        self.case.dialogs.opened = str(self.case.target); reopened = self.case.library.open_file()
        self.assertEqual(reopened['takeoffs']['signatures'], expected)
        self.assertEqual(reopened['takeoffs']['signatures']['records'][0]['id'], identifier)
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.case.documents.validate_audit(reopened['takeoffs'])
        companion = self.case.root / saved['takeoffs']['companion_folder']
        self.assertEqual((companion / 'documents' / (self.document['sha256']+'.pdf')).read_bytes(), self.case.pdf)

    def test_signatures_leave_confirmed_transfer_values_and_calculator_drafts_unchanged(self):
        case = workspace_fixtures.TakeoffWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        item = case.create(); case.confirm(item); case.apply(case.preview(item))
        before = deepcopy(case.state['snapshot']); results = deepcopy(case.state['item_results'])
        calculator = deepcopy(case.state['calculator'])
        case.command('create_signature', signature=proposal(case.doc))
        for key in ('items', 'transfers', 'documents', 'calibrations'):
            self.assertEqual(case.state['snapshot'][key], before[key])
        self.assertEqual(case.state['item_results'], results)
        preview = case.preview(item, inputs=calculator['inputs'], rows=calculator['schedule_rows'], update=True)
        self.assertEqual(preview['changes'], [{'item_id': item, 'row': calculator['schedule_rows'][0], 'action': 'unchanged'}])

    def test_retained_audit_rejects_rewritten_binding_versions_control_op_or_measurements(self):
        identifier = self.create()
        self.command('update_signature', signature_id=identifier, changes={'strokes': [[[0, 0], [1, 1]]]})
        snapshot = self.case.session['snapshot']; event = self.case.documents.get_blob(snapshot['audit_head'])
        for change, message in [('version', 'fresh increasing version'), ('binding', 'source identity'),
                                ('op', 'controlled signature'), ('other', 'cannot change measurements')]:
            forged = deepcopy(event)
            if change == 'version': forged['after']['signatures']['records'][0]['version'] = 1
            elif change == 'binding': forged['after']['signatures']['records'][0]['mode'] = 'duct'
            elif change == 'op': forged['op'] = 'create_item'
            else: forged['after']['render_checks'].append({'document_id': self.document['id'], 'page': 1, 'success': True, 'warnings': []})
            forged['affected_ids'] = audit_affected(forged['before'], forged['after'])
            head = self.case.documents.put_blob(forged)
            with self.subTest(change=change), self.assertRaisesRegex(ValidationError, message):
                self.case.documents.validate_audit({**snapshot, 'audit_head': head})
        self.case.documents.validate_audit(snapshot)

    def test_explicit_export_selection_requires_current_scope_document_distinct_ids(self):
        identifier = self.create()
        self.create(mode='duct')
        before = deepcopy(self.case.session['snapshot'])
        payload, kind, _ = self.export(); self.assertEqual(kind, 'application/pdf')
        text = PdfReader(BytesIO(payload)).pages[0].extract_text()
        self.assertIn('1 signature (visual marks only); no measurement markups.', text)
        self.assertNotIn('No visible markups', text)
        empty = PdfReader(BytesIO(self.export(signature_ids=[])[0])).pages[0].extract_text()
        self.assertIn('No visible markups', empty)
        for values in ({'mode': 'duct', 'signature_ids': [identifier]},
                       {'signature_ids': [identifier, identifier]}, {'signature_ids': [str(uuid4())]}):
            with self.subTest(values=values), self.assertRaisesRegex(ValidationError, 'Export signature IDs'):
                self.export(**values)
        with self.assertRaisesRegex(ValidationError, 'no items'):
            self.case.service.export_workspace(self.case.session['session_id'], 'schedule-xlsx', {
                'expected_revision': self.case.session['revision'], 'mode': 'steel'})
        self.assertEqual(self.case.service.get(self.case.session['session_id'])['snapshot'], before)
        self.command('delete_signature', signature_id=identifier)
        with self.assertRaisesRegex(ValidationError, 'Export signature IDs'):
            self.export(signature_ids=[identifier])

    def test_wall_and_floor_export_combines_modes_without_retyping_records(self):
        wall = self.create(mode='wall'); floor = self.create(mode='slab')
        state = self.case.session['snapshot']
        self.assertEqual([record['id'] for record in export_signatures(state, {}, self.document['id'], ('wall', 'slab'))], [wall, floor])
        text = PdfReader(BytesIO(self.export(mode='walls_floors', signature_ids=[wall, floor])[0])).pages[0].extract_text()
        self.assertIn('2 signatures (visual marks only)', text)
        with self.assertRaisesRegex(ValidationError, 'Export signature IDs'):
            self.export(mode='wall', signature_ids=[floor])

    def test_pdf_vector_positions_for_all_rotations_cropbox_userunit_and_exact_ink_width(self):
        pdf = drawing_fixture(); case = self.case
        upload = case.documents.begin_upload(case.session['session_id'], 'rotation.pdf', len(pdf))
        case.documents.write_chunk(case.session['session_id'], upload['upload_id'], 0, pdf)
        self.document = case.documents.finish_upload(case.session['session_id'], upload['upload_id'])
        case.session = case.service.add_document(case.session['session_id'], self.document, case.session['revision'])
        for page in range(1, 5):
            self.create(page=page, appearance={'stroke_color': '#13579B', 'stroke_width': 2, 'opacity': .6},
                        strokes=[[[0, 0], [.25, .7], [1, 1]]])
        before = deepcopy(case.session['snapshot']); source = case.documents.document_path(self.document)
        source_hash = sha256(source.read_bytes()).hexdigest()
        reader = PdfReader(BytesIO(self.export()[0]))
        for index, page in enumerate(reader.pages):
            metadata = self.document['pages'][index]
            _, drawing_width, drawing_height = page_transform(metadata)
            bottom = float(page.mediabox.height) - drawing_height
            matrix, _, _ = page_transform(metadata, bottom, (float(page.mediabox.width)-drawing_width)/2)
            expected = [transform(point, matrix) for point in ([30, 90], [47.5, 62], [100, 50])]
            ops = page.get_contents().operations
            color_index = next(i for i, (args, op) in enumerate(ops) if op == b'RG'
                and all(abs(float(args[j])-value/255) < 1e-5 for j, value in enumerate((19, 87, 155))))
            ink_ops = ops[color_index:]
            width = next(float(args[0]) for args, op in ink_ops if op == b'w')
            self.assertEqual(width, 2, 'UserUnit scales geometry once, never physical stroke width.')
            path = [(float(args[0]), float(args[1])) for args, op in ink_ops if op in (b'm', b'l')][:3]
            for actual, target in zip(path, expected):
                for a, b in zip(actual, target): self.assertAlmostEqual(a, b, places=5)
            self.assertEqual(len(path), 3)
            self.assertEqual(page.get('/Rotate', 0), 0); self.assertEqual(page.get('/UserUnit', 1), 1)
            self.assertNotIn('/Annots', page)
        self.assertNotIn('/Names', reader.trailer['/Root']); self.assertNotIn('/OpenAction', reader.trailer['/Root'])
        self.assertEqual(sha256(source.read_bytes()).hexdigest(), source_hash)
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)

    def test_signature_undo_on_physical_snapshot_skips_evidence_gate_and_preserves_graph(self):
        case = physical_fixtures.PhysicalWorkspaceTests(); case.setUp(); self.addCleanup(case.doCleanups)
        state, _ = case.apply([case.defect()]); original = deepcopy(state['snapshot']['physical'])
        state = case.service.command(case.sid, {'op': 'create_signature', 'request_id': str(uuid4()),
            'expected_revision': state['revision'], 'signature': proposal(case.case.doc, mode='defect_reports')})
        self.assertEqual(state['snapshot']['version'], 2)
        with patch.object(case.service, '_physical_gate', side_effect=AssertionError('Visual Undo needs no physical gate')):
            state = case.service.command(case.sid, {'op': 'undo', 'request_id': str(uuid4()), 'expected_revision': state['revision']})
        self.assertEqual(state['snapshot']['physical'], original)
        self.assertNotIn('signatures', state['snapshot'])

    def test_physical_scope_and_view_rotation_export_only_selected_signature_vectors(self):
        pdf = drawing_fixture(); case = self.case
        upload = case.documents.begin_upload(case.session['session_id'], 'rotation.pdf', len(pdf))
        case.documents.write_chunk(case.session['session_id'], upload['upload_id'], 0, pdf)
        self.document = case.documents.finish_upload(case.session['session_id'], upload['upload_id'])
        case.session = case.service.add_document(case.session['session_id'], self.document, case.session['revision'])
        ids = [self.create(mode='defect_reports', page=page, strokes=[[[0, 0], [1, 1]]],
                          appearance={'stroke_color': '#13579B'}) for page in range(1, 5)]
        other = self.create(mode='service_plans', appearance={'stroke_color': '#97531B'})
        request = {'expected_revision': case.session['revision'], 'mode': 'penetrations',
                   'physical_scope': 'defect_reports', 'document_id': self.document['id'], 'item_ids': [],
                   'signature_ids': ids, 'rendering': {'zoom': .37, 'rotations': {'1': 90, '2': 180, '3': 270, '4': 0}}}
        before = deepcopy(case.session['snapshot'])
        payload = case.service.export_workspace(case.session['session_id'], 'marked-pdf', request)[0]
        reader = PdfReader(BytesIO(payload))
        for index, page in enumerate(reader.pages):
            metadata = deepcopy(self.document['pages'][index])
            metadata['rotation'] = (metadata['rotation']+request['rendering']['rotations'][str(index+1)])%360
            matrix, width, height = page_transform(metadata)
            self.assertEqual((float(page.mediabox.width), float(page.mediabox.height)), (width, height))
            ops = page.get_contents().operations
            start = next(i for i, (args, op) in enumerate(ops) if op == b'RG'
                and all(abs(float(args[j])-value/255) < 1e-5 for j, value in enumerate((19, 87, 155))))
            path = [(float(args[0]), float(args[1])) for args, op in ops[start:] if op in (b'm', b'l')][:2]
            self.assertEqual(path, [transform(point, matrix) for point in ([30, 90], [100, 50])])
            self.assertNotIn('TAKEOFF LEGEND', page.extract_text())
        with self.assertRaisesRegex(ValidationError, 'Export signature IDs'):
            case.service.export_workspace(case.session['session_id'], 'marked-pdf', {**request, 'signature_ids': [other]})
        service = case.service.export_workspace(case.session['session_id'], 'marked-pdf', {
            **request, 'physical_scope': 'service_plans', 'signature_ids': [other]})[0]
        self.assertTrue(any(op == b'RG' and abs(float(args[0])-151/255) < 1e-5
                            for args, op in PdfReader(BytesIO(service)).pages[0].get_contents().operations))
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'], before)
        self.assertNotIn('physical', before); self.assertNotIn('service_plans', before)

    def test_dot_only_signature_exports_vector_ink_and_empty_selection_removes_it(self):
        self.create(strokes=[[[.5, .5]]], appearance={'stroke_color': '#13579B', 'stroke_width': 2.25})
        page = PdfReader(BytesIO(self.export()[0])).pages[0]
        ops = page.get_contents().operations
        start = next(i for i, (args, op) in enumerate(ops) if op == b'rg'
                     and all(abs(float(args[j])-value/255) < 1e-5 for j, value in enumerate((19, 87, 155))))
        self.assertTrue(any(op == b'c' for _, op in ops[start:]), 'Single-point strokes are vector circles.')
        self.assertTrue(any(op in (b'f', b'f*') for _, op in ops[start:]))
        self.assertFalse(any(op == b'RG' and abs(float(args[0])-19/255) < 1e-5
                             for args, op in PdfReader(BytesIO(self.export(signature_ids=[])[0])).pages[0].get_contents().operations))

    def test_creation_at_combined_capacity_fails_without_changing_candidate(self):
        self.create(strokes=[[[0, 0]]]); state = deepcopy(self.case.session['snapshot'])
        template = state['signatures']['records'][0]
        state['signatures']['records'] = [{**deepcopy(template), 'id': str(uuid4())} for _ in range(1000)]
        before = deepcopy(state)
        with self.assertRaisesRegex(ValidationError, 'combined'):
            apply_signature(state, {'op': 'create_signature', 'signature': proposal(self.document)})
        self.assertEqual(state, before)

    def test_pdf_geometry_budget_includes_all_signature_points_before_worker(self):
        from estimator.takeoff_markup_pdf import export_marked_pdf
        self.create(strokes=[[[0, 0]]*4000])
        state = self.case.session['snapshot']; template = state['signatures']['records'][0]
        signatures = [{**deepcopy(template), 'id': str(uuid4())} for _ in range(51)]
        with patch('estimator.takeoff_markup_pdf.subprocess.run', side_effect=AssertionError('Oversized export started a child')):
            with self.assertRaisesRegex(ValidationError, 'geometry exceeds'):
                export_marked_pdf(self.document, [], {}, {}, {}, self.case.documents,
                    project_id=state['project_id'], revision=state['revision'], mode='steel',
                    snapshot=state, signatures=signatures)


if __name__ == '__main__':
    unittest.main()
