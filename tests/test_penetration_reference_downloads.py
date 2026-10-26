"""Optional Takeoffs references are captured only in disposable download inputs."""
from contextlib import ExitStack
from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.penetration_calculator import normalize_draft
from estimator.server import create_server


SESSION = str(uuid4())
ROUTES = (
    ('/api/penetration/report.pdf', 'draft', 'estimator.penetration_report.render_penetration_pdf'),
    ('/api/penetration/register.xlsx', 'draft', 'estimator.penetration_report.build_penetration_register'),
    ('/api/penetration/item.pdf', 'item', 'estimator.penetration_item_exports.render_item_pdf'),
    ('/api/penetration/item.xlsx', 'item', 'estimator.penetration_item_exports.build_item_xlsx'),
    ('/api/project/full-schedule.pdf', 'penetration', 'estimator.project_reports.build_project_report'),
    ('/api/project/full-product-summary.pdf', 'penetration', 'estimator.project_reports.build_project_report'),
)


def legacy_row(identifier='legacy'):
    return {'id': identifier, 'inputs': {'K': 'Copper Pipes', 'M': 'Vertical', 'O': 2.34567890123456},
            'takeoff_source': {'version': 1, 'scope': 'service_plans',
                **{key: str(uuid4()) for key in ('project_id', 'graph_id', 'service_id', 'barrier_id')},
                'service_revision': 1, 'barrier_revision': 2, 'context_sha256': 'a' * 64,
                'service_size': 'literal 25 mm'}}


class ReferenceDownloadHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = create_server(0, Path(cls.temp.name) / 'test.sqlite3', library_directory=Path(cls.temp.name) / 'library')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def request(self, route, body):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request('POST', route, json.dumps(body), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def body(self, key, rows=None, with_session=True):
        rows = deepcopy(rows if rows is not None else [legacy_row()])
        body = {'configuration': {}, **({'takeoff_session_id': SESSION} if with_session else {})}
        if key == 'item':
            body.update(item=rows[0], globals={})
        else:
            body[key] = {'globals': {}, 'rows': rows}
            if key == 'penetration':
                body['calculators'] = {}
        return body

    @staticmethod
    def resolver(_service, _session, draft):
        return {'row_references': {row['id']: {'systems': [{'id': 'chosen-one'}, {'id': 'chosen-two'}]}
                                   for row in draft['rows']}}

    @staticmethod
    def builder_draft(key, builder):
        args = builder.call_args.args
        if key == 'penetration':
            return deepcopy(args[1])
        return deepcopy(args[0]['result']['draft'] if key == 'item' else args[0]['draft'])

    def test_all_download_routes_capture_session_references_without_changing_request_inputs(self):
        for route, key, target in ROUTES:
            with self.subTest(route=route):
                body = self.body(key); before = deepcopy(body); lookup_drafts = []
                def resolve(service, session, draft):
                    lookup_drafts.append(deepcopy(draft))
                    return self.resolver(service, session, draft)
                with patch('estimator.takeoff_workspace.TakeoffService.firestopping_references', autospec=True, side_effect=resolve) as lookup, patch(target, return_value=b'owned download fixture') as builder:
                    status, payload = self.request(route, body)
                self.assertEqual((status, payload), (200, b'owned download fixture'))
                self.assertEqual(lookup.call_count, 1)
                self.assertEqual(lookup.call_args.args[1], SESSION)
                expected = normalize_draft({'globals': {}, 'rows': [before['item']]} if key == 'item' else before[key])
                self.assertEqual(lookup_drafts, [expected])
                captured = self.builder_draft(key, builder)
                self.assertEqual(captured['rows'][0]['takeoff_reference_ids'], ['chosen-one', 'chosen-two'])
                captured['rows'][0].pop('takeoff_reference_ids')
                self.assertEqual(captured, expected)
                self.assertEqual(body, before)

    def test_without_a_session_existing_downloads_do_not_assign_matching_references(self):
        for route, key, target in ROUTES:
            with self.subTest(route=route):
                body = self.body(key, with_session=False)
                with patch('estimator.takeoff_workspace.TakeoffService.firestopping_references', autospec=True) as lookup, patch(target, return_value=b'owned download fixture') as builder:
                    status, _ = self.request(route, body)
                self.assertEqual(status, 200); lookup.assert_not_called()
                self.assertNotIn('takeoff_reference_ids', self.builder_draft(key, builder)['rows'][0])

    def test_explicit_clear_persisted_references_and_unlinked_manual_rows_remain_unchanged(self):
        rows = [legacy_row(), dict(legacy_row('explicit'), technical_reference_ids=[]),
                dict(legacy_row('portable'), takeoff_reference_ids=['retained']),
                {'id': 'manual', 'inputs': {'K': 'Copper Pipes', 'M': 'Vertical'}}]
        for route, key, target in (entry for entry in ROUTES if entry[1] != 'item'):
            with self.subTest(route=route):
                body = self.body(key, rows); before = deepcopy(body)
                with patch('estimator.takeoff_workspace.TakeoffService.firestopping_references', autospec=True, side_effect=self.resolver), patch(target, return_value=b'owned download fixture') as builder:
                    status, _ = self.request(route, body)
                self.assertEqual(status, 200)
                captured = self.builder_draft(key, builder)
                self.assertEqual(captured['rows'][1:], normalize_draft(before[key])['rows'][1:])
                self.assertEqual(captured['rows'][0]['takeoff_reference_ids'], ['chosen-one', 'chosen-two'])
                self.assertEqual(body, before)

    def test_unknown_payload_fields_still_fail_before_any_document_is_built(self):
        for route, key, target in ROUTES:
            with self.subTest(route=route):
                body = self.body(key); body['report_url'] = 'https://untrusted.invalid/report.pdf'
                with patch('estimator.takeoff_workspace.TakeoffService.firestopping_references', autospec=True, side_effect=self.resolver), patch(target) as builder:
                    status, payload = self.request(route, body)
                self.assertEqual(status, 400, payload); builder.assert_not_called()

    def test_malformed_or_unavailable_sessions_cannot_reach_document_builders(self):
        invalid = [None, 1, True, [], {}, '../private', 'https://untrusted.invalid/', '', 'X' * 10000, str(uuid4())]
        with ExitStack() as stack:
            builders = [stack.enter_context(patch(target)) for target in dict.fromkeys(entry[2] for entry in ROUTES)]
            for route, key, _target in ROUTES:
                for session in invalid:
                    with self.subTest(route=route, session=repr(session)[:50]):
                        body = self.body(key); body['takeoff_session_id'] = session
                        status, payload = self.request(route, body)
                        self.assertEqual(status, 400, payload)
            for builder in builders:
                builder.assert_not_called()

    def test_malformed_session_is_rejected_even_when_combined_report_has_no_firestopping(self):
        for session in ('../private', 'https://untrusted.invalid/', None, {}):
            with self.subTest(session=session), patch('estimator.project_reports.build_project_report') as builder:
                body = {'calculators': {}, 'penetration': None, 'takeoff_session_id': session}
                status, payload = self.request('/api/project/full-schedule.pdf', body)
                self.assertEqual(status, 400, payload); builder.assert_not_called()


if __name__ == '__main__':
    unittest.main()
