"""Long selected source descriptions stay literal, bounded and portable.

All library edits, physical transactions, exports and projects are disposable.
No source text, physical identity or commercial authority is inferred or cut.
"""
from copy import deepcopy
import csv
from hashlib import sha256
from io import BytesIO, StringIO
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from openpyxl import load_workbook

from estimator.catalog import ValidationError
from estimator.takeoff_library_links import validate_assignments, validate_history
from estimator import takeoff_physical as physical
from tests import test_takeoff_library_barrier_import as import_fixtures
from tests.test_takeoff_physical_v2 import apply, create


class LibraryLongTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import_fixtures.LibraryBarrierImportTests.setUpClass()

    def setUp(self):
        self.case = import_fixtures.LibraryBarrierImportTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.links = self.case.fixture
        self.service, self.sid = self.case.service, self.case.sid

    def state(self):
        return self.case.state()

    def select_long_description(self, blank=False):
        edit = self.links.library.edit('pkb-001')
        draft = deepcopy(edit['draft'])
        description = ('Exact source <script>literal</script> \U0001f525\n' * 300)[:10000]
        inputs = draft['rows'][0]['inputs']
        inputs.update(T=description, U='Exact system detail ' * 480,
                      Q='Retain application words ' * 320,
                      R='Retain installation words ' * 320,
                      AL=25.123456789012, AQ=50.234567890123, AR=75.345678901234)
        if blank:
            inputs['K'] = 'Blank Seal'
        self.links.library.action('pkb-001', 'save', {
            'draft': draft, 'revision': edit['revision'], 'pricing_token': edit['pricing_token']})
        self.case.library = self.links.library.takeoff_record('pkb-001')
        selected = self.case.library
        self.assertEqual(selected['inputs']['T'], description)
        self.assertEqual(selected['title'], description)
        captured = {key: selected[key] for key in
                    ('id', 'library_id', 'title', 'source_sha256', 'revision', 'inputs')}
        self.assertEqual(selected['metadata_sha256'], sha256(json.dumps(captured, ensure_ascii=False,
            sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest())
        notes = selected['import_fields']['barrier']['notes']
        self.assertGreater(len(notes), 30000)
        for column in ('T', 'U', 'Q', 'R'):
            self.assertIn(inputs[column], notes, column)
        self.links.assert_source_unchanged()
        return selected

    def assert_no_commercial_change(self, before, stored):
        after = self.state()
        for key in ('documents', 'items', 'calibrations', 'transfers', 'render_checks'):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(self.links.calculator_storage(), stored)
        self.assertEqual(self.links.draft, {'globals': {'J': 'No'}, 'rows': []})
        self.links.assert_source_unchanged()

    def test_long_selected_description_creates_exact_unconfirmed_physical_fields(self):
        selected = self.select_long_description()
        before, stored = deepcopy(self.state()), self.links.calculator_storage()
        proposed = self.case.proposal()
        after = self.case.apply(proposed)[0]['snapshot']
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        for kind, collection in (('barrier', 'barriers'), ('service', 'services')):
            entity = after['physical'][collection][0]
            self.assertEqual(entity['fields'], selected['import_fields'][kind])
            self.assertEqual(entity['uncertainty']['state'], 'human_review_required')
        service = after['physical']['services'][0]
        for key in ('diameter_mm', 'width_mm', 'height_mm'):
            self.assertEqual(service['fields'][key], selected['import_fields']['service'][key])
        record = after['library_assignments']['records'][0]
        self.assertEqual(record['library']['title'], selected['title'])
        self.assertEqual(record['library']['metadata_sha256'], selected['metadata_sha256'])
        self.assertEqual(record['state'], 'draft')
        self.assertIsNone(record['confirmation'])
        self.assertIsNone(record['schedule_binding'])
        validate_assignments(after)
        self.assert_no_commercial_change(before, stored)

    def test_long_notes_on_existing_barrier_leave_every_original_exact(self):
        selected = self.select_long_description()
        barrier = self.case.barrier(**selected['import_fields']['barrier'])
        original = create('service', barrier['id'], service='Original service', notes='Keep my words')
        original['entity']['quantity'] = 17
        self.links.physical([original])
        before, stored = deepcopy(self.state()), self.links.calculator_storage()
        after = self.case.apply(self.case.proposal(barrier))[0]['snapshot']
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['barriers'], before['physical']['barriers'])
        self.assertEqual(after['physical']['services'][0], before['physical']['services'][0])
        self.assertEqual(after['physical']['services'][1]['fields'], selected['import_fields']['service'])
        self.assert_no_commercial_change(before, stored)

    def test_long_blank_seal_notes_and_title_create_no_service(self):
        selected = self.select_long_description(blank=True)
        before, stored = deepcopy(self.state()), self.links.calculator_storage()
        after = self.case.apply(self.case.proposal())[0]['snapshot']
        self.assertEqual(after['physical']['defects'], before['physical']['defects'])
        self.assertEqual(after['physical']['services'], [])
        self.assertEqual(after['physical']['barriers'][0]['fields'], selected['import_fields']['barrier'])
        self.assertEqual(after['library_assignments']['records'][0]['library']['title'], selected['title'])
        self.assert_no_commercial_change(before, stored)

    def test_long_notes_and_title_survive_audit_undo_save_and_reopen(self):
        selected = self.select_long_description()
        before = deepcopy(self.state())
        imported = self.case.apply(self.case.proposal())[0]['snapshot']
        event = self.links.case.documents.get_blob(imported['audit_head'])
        self.assertEqual(event['op'], 'import_library_item')
        validate_history(event)
        self.assertEqual(event['after']['physical']['barriers'][0]['fields']['notes'],
                         selected['import_fields']['barrier']['notes'])
        undone = self.service.command(self.sid, {'op': 'undo', 'expected_revision': imported['revision'],
                                                'request_id': str(uuid4())})['snapshot']
        self.assertEqual(undone['physical']['defects'], before['physical']['defects'])
        for collection in ('barriers', 'services'):
            historical = undone['physical'][collection][0]
            self.assertTrue(historical['deleted'])
            self.assertEqual(historical['fields'], imported['physical'][collection][0]['fields'])
        record = undone['library_assignments']['records'][0]
        self.assertEqual(record['library'], imported['library_assignments']['records'][0]['library'])
        self.assertGreater(record['version'], imported['library_assignments']['records'][0]['version'])
        self.links.case.documents.validate_audit(undone, owner=self.sid)
        self.links.case.library.save_as({**deepcopy(self.links.case.base), 'takeoffs': undone,
            'takeoffs_session_id': self.sid, 'penetration': {'draft': deepcopy(self.links.draft)}})
        payload = self.links.case.target.read_bytes()
        self.service.close(self.sid)
        self.links.case.dialogs.opened = str(self.links.case.target)
        reopened = self.links.case.library.open_file()
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(reopened['takeoffs']['physical'], undone['physical'])
        self.assertEqual(reopened['takeoffs']['library_assignments'], undone['library_assignments'])
        self.links.case.documents.validate_audit(reopened['takeoffs'], owner=reopened['takeoffs_session_id'])
        self.assertEqual(self.links.case.target.read_bytes(), payload)
        self.links.assert_source_unchanged()

    def test_csv_and_chunked_xlsx_reconstruct_every_long_source_character(self):
        selected = self.select_long_description()
        self.case.apply(self.case.proposal())
        note = selected['import_fields']['barrier']['notes']
        payload, _, _ = self.service.export_physical(self.sid, 'csv')
        rows = list(csv.DictReader(StringIO(payload.decode('utf-8-sig'))))
        barrier = next(row for row in rows if row['entity_type'] == 'barrier')
        self.assertEqual(barrier['notes'], note)
        payload, _, _ = self.service.export_physical(self.sid, 'xlsx')
        workbook = load_workbook(BytesIO(payload), data_only=False)
        self.addCleanup(workbook.close)
        rows = list(workbook['Provenance Detail'].values)
        chunks = [dict(zip(rows[0], row)) for row in rows[1:]]
        parts = sorted((row for row in chunks if row['record_id'] == barrier['entity_id']
                        and row['column'] == 'notes'), key=lambda row: row['part'])
        self.assertGreater(len(parts), 1)
        self.assertEqual(''.join(row['exact_text [concatenate in part order]'] for row in parts), note)
        self.assertTrue(all(row['sha256'] == sha256(note.encode()).hexdigest() for row in parts))
        self.links.assert_source_unchanged()

    def test_global_note_budget_failure_rolls_back_the_entire_library_import(self):
        self.select_long_description()
        before, stored = deepcopy(self.state()), self.links.calculator_storage()
        with patch.object(physical, 'MAX_TOTAL_TEXT', 30000):
            with self.assertRaisesRegex(ValidationError, 'total descriptive text limit'):
                self.case.apply(self.case.proposal())
        self.assertEqual(self.state(), before)
        self.assert_no_commercial_change(before, stored)

    def test_library_import_rejects_out_of_contract_title_without_cutting_source(self):
        context = self.links.library._context('pkb-001')
        saved = deepcopy(context[2])
        saved['draft']['rows'][0]['inputs']['T'] = 'x' * 10001
        before = deepcopy(self.state())
        with patch.object(self.links.library, '_context', return_value=(*context[:2], saved, *context[3:])):
            with self.assertRaisesRegex(ValidationError, 'retained draft text limit'):
                self.links.library.takeoff_record('pkb-001')
        self.assertEqual(self.state(), before)
        self.assertEqual(saved['draft']['rows'][0]['inputs']['T'], 'x' * 10001)
        self.links.assert_source_unchanged()


class PhysicalNotesBoundTests(unittest.TestCase):
    def graph(self):
        return physical.new_graph(str(uuid4()), version=2)

    def test_only_notes_have_a_larger_bound_and_keep_unicode_literal(self):
        note = '\U0001f525' * physical.MAX_NOTES
        graph = apply(self.graph(), create('defect', notes=note))
        self.assertEqual(graph['defects'][0]['fields']['notes'], note)
        physical.validate_graph(graph)
        for fields in ({'notes': note + 'x'}, {'label': 'x' * (physical.MAX_TEXT + 1)},
                       {'location': 'x' * (physical.MAX_TEXT + 1)}):
            with self.subTest(fields=list(fields)), self.assertRaises(ValidationError):
                apply(graph, create('defect', **fields))

    def test_long_notes_still_reject_control_characters_and_unpaired_surrogates(self):
        for bad in ('\x00', '\x01', '\ud800', '\udfff'):
            graph = self.graph()
            before = deepcopy(graph)
            with self.subTest(code=ord(bad)), self.assertRaises(ValidationError):
                apply(graph, create('defect', notes='Long literal words ' * 200 + bad))
            self.assertEqual(graph, before)
        text = 'Literal <script>words</script>\n\r\t' * 200
        self.assertEqual(apply(self.graph(), create('defect', notes=text))['defects'][0]['fields']['notes'], text)

    def test_larger_notes_still_count_toward_global_budget_after_deletion(self):
        command = create('defect', notes='x' * 10000)
        graph = apply(self.graph(), command)
        graph = apply(graph, {'op': 'delete', 'entity_id': command['entity']['id'], 'cascade': False})
        before = deepcopy(graph)
        with patch.object(physical, 'MAX_TOTAL_TEXT', 10000):
            with self.assertRaisesRegex(ValidationError, 'total descriptive text limit'):
                apply(graph, create('defect', notes='one more'))
        self.assertEqual(graph, before)


if __name__ == '__main__':
    unittest.main()
