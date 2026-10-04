"""Thickness is a read-only projection of current, receipt-bound native cells."""
from copy import deepcopy
import unittest
from uuid import uuid4

from estimator.catalog import ROOT, ValidationError
from estimator.takeoff_exports import linked_register_results
from estimator.takeoff_http import TakeoffHTTP
from estimator.workbook_calculators import calculator_session
from tests import test_takeoff_workspace as fixtures


class TakeoffLinkedResultTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def request(self, drafts=None, **changes):
        return {'expected_revision': self.case.state['revision'],
                'calculator_drafts': drafts or {}, **changes}

    def read(self, drafts=None, **changes):
        return self.case.service.linked_register_results(self.case.sid, self.request(drafts, **changes))

    def linked(self, calculator='steel_vermiculite'):
        identifier = self.case.create()
        fields = ({'section': '410UB54', 'product': 'MONOKOTE MK-6 HY', 'critical_temperature': 620}
                  if calculator == 'steel_vermiculite' else
                  {'product': 'TRAFALGAR COREX', 'critical_temperature': 620})
        self.case.command('update_item', item_id=identifier, changes={'fields': fields})
        self.case.confirm(identifier)
        self.case.apply(self.case.preview(identifier, calculator))
        draft = self.case.state['calculator']
        return identifier, {calculator: {key: deepcopy(draft[key]) for key in ('inputs', 'schedule_rows')}}

    def test_empty_or_unlinked_register_has_no_invented_results_and_does_not_change_state(self):
        identifier = self.case.create()
        before = deepcopy(self.case.state['snapshot'])
        result = self.read()
        self.assertEqual(result['linked_results'], {identifier: []})
        self.assertEqual(result['project_id'], before['project_id'])
        self.assertEqual(result['revision'], before['revision'])
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_spray_is_exact_original_p_cell_with_published_o_and_source_provenance(self):
        identifier, drafts = self.linked()
        before = deepcopy(self.case.state['snapshot']); original = deepcopy(drafts)
        result = self.read(drafts)['linked_results'][identifier][0]
        _, engine, lock = calculator_session('steel_vermiculite', drafts['steel_vermiculite']['inputs'])
        binding = before['transfers'][0]
        with lock:
            self.assertEqual(result['estimating_thickness_mm'], engine.value('SCHEDULE', f"P{binding['row']}"))
            self.assertEqual(result['published_thickness_mm'], engine.value('SCHEDULE', f"O{binding['row']}"))
        self.assertEqual(result['status'], 'Current')
        self.assertEqual(result['binding_id'], binding['id'])
        self.assertEqual(result['sheet'], binding['sheet'])
        self.assertEqual(result['calculator_source_sha256'], binding['source_sha256'])
        self.assertRegex(result['calculator_draft_sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(drafts, original)

    def test_board_uses_exact_total_ab_and_preserves_stack_and_layers(self):
        identifier, drafts = self.linked('steel_board')
        result = self.read(drafts)['linked_results'][identifier][0]
        binding = self.case.state['snapshot']['transfers'][0]
        _, engine, lock = calculator_session('steel_board', drafts['steel_board']['inputs'])
        with lock:
            for key, column in (('total_thickness_mm', 'AB'), ('board_stack_mm', 'Z'), ('board_layers', 'AA')):
                self.assertEqual(result[key], engine.value('CALCULATOR', f"{column}{binding['row']}"))
        self.assertEqual(result['status'], 'Current')
        self.assertIsNone(result['estimating_thickness_mm'])

    def test_duct_returns_native_continuous_wrap_thickness_and_withholds_stale_rows(self):
        identifier = self.case.create('duct', quantity=1); self.case.confirm(identifier)
        self.case.apply(self.case.preview(identifier, 'ductwork'))
        native = self.case.state['calculator']; drafts = {'ductwork': {key: deepcopy(native[key]) for key in ('inputs', 'schedule_rows')}}
        result = self.read(drafts)['linked_results'][identifier][0]
        binding = self.case.state['snapshot']['transfers'][0]
        _, engine, lock = calculator_session('ductwork', drafts['ductwork']['inputs'])
        with lock:
            expected = engine.value('CALCULATOR', f"R{binding['row']}") * engine.value('PRODUCT SETTINGS', 'B96') * 1000
        self.assertEqual(result['status'], 'Current'); self.assertEqual(result['duct_thickness_mm'], expected)
        self.assertIn('local penetration layers excluded', result['duct_thickness_basis'])
        drafts['ductwork']['inputs']['CALCULATOR'][f"D{binding['row']}"] += .25
        stale = self.read(drafts)['linked_results'][identifier][0]
        self.assertEqual(stale['status'], 'Unavailable'); self.assertIsNone(stale['duct_thickness_mm'])

    def test_missing_or_other_schedule_draft_withholds_the_linked_thickness(self):
        identifier, _ = self.linked()
        result = self.read()['linked_results'][identifier][0]
        self.assertEqual(result['status'], 'Unavailable')
        self.assertIsNone(result['estimating_thickness_mm'])
        self.assertNotIn('calculator_draft_sha256', result)

    def test_edited_removed_or_omitted_destination_row_cannot_supply_old_result(self):
        identifier, drafts = self.linked()
        binding = self.case.state['snapshot']['transfers'][0]
        for alteration in ('edit', 'remove', 'omit'):
            supplied = deepcopy(drafts); draft = supplied['steel_vermiculite']
            if alteration == 'edit': draft['inputs']['SCHEDULE'][f"J{binding['row']}"] += 0.125
            elif alteration == 'remove': draft['schedule_rows'] = [binding['row'] + 1]
            else: draft['inputs']['SCHEDULE'].pop(f"J{binding['row']}")
            with self.subTest(alteration=alteration):
                result = self.read(supplied)['linked_results'][identifier][0]
                self.assertEqual(result['status'], 'Unavailable')
                self.assertIsNone(result['estimating_thickness_mm'])

    def test_takeoff_edit_and_reconfirmation_still_require_explicit_link_update(self):
        identifier, drafts = self.linked()
        self.case.command('update_item', item_id=identifier, changes={'quantity': 3})
        result = self.read(drafts)['linked_results'][identifier][0]
        self.assertEqual(result['status'], 'Unavailable')
        self.case.confirm(identifier)
        result = self.read(drafts)['linked_results'][identifier][0]
        self.assertEqual(result['status'], 'Unavailable')
        draft = drafts['steel_vermiculite']
        self.case.apply(self.case.preview(identifier, inputs=draft['inputs'], rows=draft['schedule_rows'], update=True),
                        inputs=draft['inputs'], rows=draft['schedule_rows'])
        current = self.case.state['calculator']
        self.assertEqual(self.read({current['id']: {key: current[key] for key in ('inputs', 'schedule_rows')}})
                         ['linked_results'][identifier][0]['status'], 'Current')

    def test_detaching_preserves_manual_calculator_values_but_removes_thickness_link(self):
        identifier, drafts = self.linked()
        original = deepcopy(drafts)
        self.case.command('detach_transfers', item_ids=[identifier], calculator_id='steel_vermiculite')
        self.assertEqual(self.read(drafts)['linked_results'][identifier], [])
        self.assertEqual(drafts, original)

    def test_visual_appearance_change_preserves_confirmed_calculator_result(self):
        identifier, drafts = self.linked()
        original = self.read(drafts)['linked_results'][identifier][0]
        version = self.case.state['snapshot']['items'][0]['version']
        self.case.command('update_item', item_id=identifier, changes={
            'appearance': {'stroke_color': '#FF00FF', 'stroke_width': 12, 'opacity': 0.41}})
        result = self.read(drafts)['linked_results'][identifier][0]
        self.assertEqual(self.case.state['snapshot']['items'][0]['version'], version)
        self.assertEqual(result, original)

    def test_forged_receipt_hash_version_sheet_and_source_cannot_supply_current_values(self):
        identifier, drafts = self.linked()
        snapshot = self.case.state['snapshot']
        for changes in ({'id': str(uuid4())}, {'source_sha256': 'b' * 64}, {'item_version': 999},
                        {'sheet': 'CALCULATOR'}, {'input_hash': 'c' * 64}, {'status': 'conflict'}):
            forged = deepcopy(snapshot); forged['transfers'][0].update(changes)
            with self.subTest(changes=changes):
                result = linked_register_results(forged, self.request(drafts), store=self.case.store)
                record = result['linked_results'][identifier][0]
                self.assertEqual(record['status'], 'Unavailable')
                self.assertIsNone(record['estimating_thickness_mm'])

    def test_forged_confirmation_or_absent_local_approval_cannot_grant_results(self):
        identifier, drafts = self.linked()
        snapshot = deepcopy(self.case.state['snapshot'])
        snapshot['items'][0]['confirmation']['id'] = str(uuid4())
        self.assertEqual(linked_register_results(snapshot, self.request(drafts), store=self.case.store)
                         ['linked_results'][identifier][0]['status'], 'Unavailable')
        with self.case.store.connect() as db:
            db.execute('DELETE FROM takeoff_approvals')
        self.assertEqual(self.read(drafts)['linked_results'][identifier][0]['status'], 'Unavailable')

    def test_invalid_drafts_output_injection_and_revision_are_rejected(self):
        self.case.create()
        for changes in ({'expected_revision': True}, {'expected_revision': -1}, {'item_ids': []},
                        {'calculator_drafts': {'steel_board': {'inputs': {'CALCULATOR': {'AB9': 12}}, 'schedule_rows': [9]}}},
                        {'calculator_drafts': {'steel_vermiculite': {'inputs': {}, 'schedule_rows': None}}},
                        {'calculator_drafts': {'unknown': {'inputs': {}, 'schedule_rows': [11]}}}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError): self.read(**changes)

    def test_changed_evidence_and_tampered_audit_are_blocked(self):
        _, drafts = self.linked()
        self.case.documents.blocked = True
        with self.assertRaisesRegex(ValidationError, 'Changed'): self.read(drafts)
        self.case.documents.blocked = False
        self.case.service._session(self.case.sid)['snapshot']['items'][0]['quantity'] += 1
        with self.assertRaisesRegex(ValidationError, 'audit head'): self.read(drafts)

    def test_http_route_returns_json_and_query_overrides_are_rejected(self):
        identifier, drafts = self.linked()
        adapter = TakeoffHTTP(self.case.service, ROOT, "default-src 'self'")
        request = self.request(drafts)
        class Handler:
            command = 'POST'
            path = '/api/takeoffs/sessions/' + self.case.sid + '/linked-results'
            def read_json(self): return request
            def send_payload(self, status, payload): self.status, self.result = status, payload
        handler = Handler()
        self.assertTrue(adapter.dispatch(handler, handler.path))
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.result['linked_results'][identifier][0]['status'], 'Current')
        route = handler.path; handler.path += '?calculator_id=steel_board'
        with self.assertRaisesRegex(ValidationError, 'structured request'): adapter.dispatch(handler, route)


if __name__ == '__main__':
    unittest.main()
