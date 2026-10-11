"""Deleted register rows are historical inspection data, never active items."""
from copy import deepcopy
import json
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_project as projects


class DeletedItemTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def query(self, **changes):
        case = self.case
        return case.service.deleted_items(case.sid, {'expected_revision': case.state['revision'], 'mode': 'steel', **changes})

    def test_deleted_projection_retains_last_record_but_no_active_result_or_quantity(self):
        case = self.case; identifier = case.create(); exact = deepcopy(case.state['snapshot']['items'][0])
        case.command('delete_items', item_ids=[identifier]); before = deepcopy(case.state['snapshot'])
        result = self.query()
        self.assertEqual(result['total'], 1); self.assertTrue(result['read_only'])
        row = result['records'][0]
        self.assertEqual(row['item'], exact); self.assertEqual(row['status'], 'deleted')
        self.assertEqual(row['deletion_audit_sha256'], before['audit_head'])
        self.assertEqual(row['deletion_revision'], before['revision'])
        self.assertEqual(case.service.get(case.sid)['snapshot'], before)
        self.assertEqual(case.service.get(case.sid)['item_results'], [])

    def test_undo_active_id_is_excluded_and_no_revision_written_by_read(self):
        case = self.case; identifier = case.create(); case.command('delete_items', item_ids=[identifier])
        self.assertEqual(self.query()['total'], 1)
        case.command('undo'); revision = case.state['revision']
        self.assertEqual(self.query()['total'], 0)
        self.assertEqual(case.service.get(case.sid)['revision'], revision)
        self.assertEqual(case.state['snapshot']['items'][0]['id'], identifier)

    def test_linked_deletion_history_never_recreates_cleared_calculator_values_and_excludes_linked_undo(self):
        case = self.case; identifier = case.create(); case.confirm(identifier)
        preview = case.preview(identifier); case.apply(preview)
        original = deepcopy(case.state['snapshot']['items'][0])
        calculators = {'steel_vermiculite': {'inputs': deepcopy(preview['inputs']), 'schedule_rows': preview['schedule_rows']}}
        case.state = case.service.delete_linked_items(case.sid, {'expected_revision': case.state['revision'],
            'request_id': str(uuid4()), 'item_ids': [identifier], 'calculators': calculators})
        before = deepcopy(case.state['snapshot']); cleared = deepcopy(case.state['calculators'])
        result = self.query()
        self.assertEqual(result['records'][0]['item'], original)
        self.assertEqual(result['records'][0]['deletion_op'], 'linked_delete')
        self.assertEqual(case.service.get(case.sid)['snapshot'], before)
        self.assertEqual(case.state['calculators'], cleared)
        with case.store.connect() as database:
            rows_before = database.execute('SELECT * FROM takeoff_linked_deletions').fetchall()
        self.query(query='B17')
        with case.store.connect() as database:
            self.assertEqual(database.execute('SELECT * FROM takeoff_linked_deletions').fetchall(), rows_before)
        case.state = case.service.undo_linked_delete(case.sid, {'expected_revision': case.state['revision'],
            'request_id': str(uuid4()), 'calculators': cleared})
        self.assertEqual(self.query()['total'], 0)
        self.assertEqual(case.state['calculators'], calculators)

    def test_query_filters_whole_history_before_pagination_and_scope(self):
        case = self.case
        ids = [case.create(fields={'mark': 'EARLY TARGET'}), case.create(fields={'mark': 'later'}), case.create(mode='duct')]
        for identifier in ids: case.command('delete_items', item_ids=[identifier])
        self.assertEqual(self.query(limit=1)['total'], 2)
        self.assertEqual(self.query(limit=1)['records'][0]['item']['fields']['mark'], 'later')
        found = self.query(query='target', limit=1)
        self.assertEqual(found['total'], 1); self.assertEqual(found['records'][0]['item']['id'], ids[0])
        self.assertEqual(self.query(offset=1, limit=1)['records'][0]['item']['id'], ids[0])
        self.assertEqual(self.query(mode='duct')['total'], 1)

    def test_marker_edit_is_not_deleted_item_but_last_marker_removal_is(self):
        case = self.case
        case.command('add_standalone_count', mode='steel', document_id=case.doc['id'], page=1,
            markers=[{'point': [30, 30]}, {'point': [50, 30]}], fields={'mark': 'Count'}, appearance={})
        item = case.state['snapshot']['items'][0]; identifier = item['id']
        case.command('delete_count_marker', item_id=identifier, member_id=item['member_ids'][0])
        self.assertEqual(self.query()['total'], 0)
        member = case.state['snapshot']['items'][0]['member_ids'][0]
        case.command('delete_count_marker', item_id=identifier, member_id=member)
        row = self.query()['records'][0]
        self.assertEqual(row['item']['id'], identifier); self.assertEqual(row['item']['quantity'], 1)
        self.assertEqual(row['deletion_op'], 'delete_count_marker')

    def test_stale_request_limits_and_missing_history_fail_closed(self):
        case = self.case; identifier = case.create(); case.command('delete_items', item_ids=[identifier])
        before = deepcopy(case.state['snapshot'])
        for changes in ({'expected_revision': before['revision']-1}, {'query': 'x'*1001}, {'query': []},
                        {'limit': 101}, {'limit': True}, {'offset': -1}, {'mode': 'defect_reports'}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError): self.query(**changes)
        del case.documents.blobs[before['audit_head']]
        with self.assertRaises(ValidationError): self.query()
        self.assertEqual(case.service._session(case.sid)['snapshot'], before)

    def test_cycles_and_rewritten_survivors_are_rejected(self):
        case = self.case; first = case.create(); second = case.create(); case.command('delete_items', item_ids=[first])
        head = case.state['snapshot']['audit_head']; event = case.documents.blobs[head]
        event['before']['items'][1]['fields']['mark'] = 'forged survivor'
        with self.assertRaisesRegex(ValidationError, 'without rewriting'): self.query()
        event['before']['items'][1]['fields']['mark'] = 'B17'; event['previous'] = head
        with self.assertRaisesRegex(ValidationError, 'cyclic'): self.query()


class DeletedItemPortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): projects.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case = projects.TakeoffProjectTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def command(self, op, **values):
        case = self.case
        case.session = case.service.command(case.session['session_id'], {'op': op, 'expected_revision': case.session['revision'], 'request_id': str(uuid4()), **values})

    def test_save_reopen_retains_exact_deleted_row_and_tampered_blob_blocks_inspection(self):
        case = self.case; doc = case.session['snapshot']['documents'][0]
        self.command('create_item', item={'mode': 'steel', 'geometry': {'document_id': doc['id'], 'page': 1, 'points': [[50, 300], [450, 300]]},
            'measurement': {'method': 'cited', 'length_m': 8.35, 'citation': 'Synthetic drawing dimension'}, 'quantity': 1, 'fields': {'mark': 'Archived'}})
        original = deepcopy(case.session['snapshot']['items'][0]); self.command('delete_items', item_ids=[original['id']])
        before = deepcopy(case.session['snapshot']); head = before['audit_head']
        case.request.update(takeoffs=before); case.library.save_as(case.request)
        stored = json.loads(case.target.read_bytes())
        self.assertEqual(stored['takeoffs']['items'], [])
        self.assertNotIn('deleted_items', stored['takeoffs'])
        case.dialogs.opened = str(case.target); opened = case.library.open_file()
        sid = opened['takeoffs_session_id']
        result = case.service.deleted_items(sid, {'expected_revision': opened['takeoffs']['revision'], 'mode': 'steel'})
        self.assertEqual(result['records'][0]['item'], original)
        self.assertEqual(case.service.get(sid)['snapshot']['items'], [])
        (case.documents.root / 'audit' / (head+'.json')).write_text('{}', encoding='utf-8')
        with self.assertRaises(ValidationError):
            case.service.deleted_items(sid, {'expected_revision': opened['takeoffs']['revision'], 'mode': 'steel'})
