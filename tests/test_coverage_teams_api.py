"""The estimator's team gate also protects HTTP requests and stored revisions."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.server import create_server


class CoverageTeamsApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.server = create_server(0, Path(cls.temporary.name) / 'teams.sqlite3')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_every_material_mapping_rejects_direct_requests_except_pins(self):
        for row, team in ((15, 'D2'), (16, 'D3'), (18, 'D6'), (19, 'D8'),
                          (20, 'D4'), (21, 'D5'), (22, 'D9'), (23, 'D10')):
            with self.subTest(row=row, team=team):
                status, body = self.request('POST', '/api/calculate',
                    {'inputs': {f'B{row}': 1, team: 'N/A'}})
                self.assertEqual(status, 400)
                self.assertEqual(body['error'], 'Select Teams')
                self.assertNotIn('summary', body)
        status, body = self.request('POST', '/api/calculate', {'inputs': {'B17': 10, 'D3': 'N/A'}})
        self.assertEqual(status, 200)
        self.assertEqual(body['inputs']['B17'], 10)

    def test_rejected_saved_revision_preserves_quote_and_prices_then_allows_correction(self):
        status, saved = self.request('POST', '/api/quotes',
            {'title': 'Team gate saved revision', 'inputs': {'B15': 7.123456789, 'D2': '1 Team - 1x'}})
        self.assertEqual(status, 201)
        inputs = dict(saved['inputs'], D2='N/A')
        status, rejected = self.request('PUT', '/api/quotes/' + saved['id'], {'inputs': inputs})
        self.assertEqual((status, rejected['error']), (400, 'Select Teams'))
        status, reopened = self.request('GET', '/api/quotes/' + saved['id'])
        self.assertEqual(status, 200)
        self.assertEqual(reopened, saved)
        status, recalculated = self.request('POST', '/api/calculate',
            {'inputs': inputs, 'configuration': saved['configuration']})
        self.assertEqual((status, recalculated['error']), (400, 'Select Teams'))
        inputs['D2'] = '1 Team - 1x'
        status, corrected = self.request('PUT', '/api/quotes/' + saved['id'], {'inputs': inputs})
        self.assertEqual(status, 200)
        self.assertEqual(corrected['inputs']['B15'], 7.123456789)
        self.assertEqual(corrected['configuration'], saved['configuration'])
        self.assertEqual(corrected['result'], saved['result'])


if __name__ == '__main__':
    unittest.main()
