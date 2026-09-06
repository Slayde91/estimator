import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from estimator.server import create_server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = create_server(0, Path(cls.temp.name) / "test.sqlite3")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            supplied = {"Content-Type": "application/json", **(headers or {})}
            connection.request(method, path, body=json.dumps(body) if isinstance(body, dict) else body, headers=supplied)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_bootstrap_calculation_save_and_reopen_round_trip(self):
        status, _, payload = self.request("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(payload)["fields"]), 64)
        status, _, payload = self.request("POST", "/api/calculate", {"inputs": {"B15": 12.25}})
        self.assertEqual(status, 200)
        total = json.loads(payload)["summary"]["total"]
        status, _, payload = self.request("POST", "/api/quotes", {"title": "Integration quote", "inputs": {"B15": 12.25}})
        self.assertEqual(status, 201)
        quote = json.loads(payload)
        status, _, payload = self.request("GET", "/api/quotes/" + quote["id"])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)["result"]["summary"]["total"], total)

    def test_cross_site_and_dns_rebinding_requests_are_rejected(self):
        for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"}, {"Origin": "null"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/api/configuration", {}, headers)[0], 403)
        self.assertEqual(self.request("PUT", "/api/configuration", "inventory=x", {"Content-Type": "text/plain"})[0], 400)

    def test_bad_json_and_unknown_cells_are_rejected(self):
        for body in ("[1]", '{"inputs":{"B15":NaN}}', "{", {"inputs": {"F7": 0}}, {"inputs": {"B15": 10**400}}):
            self.assertEqual(self.request("POST", "/api/calculate", body)[0], 400)

    def test_only_allowlisted_static_files_are_served(self):
        for path in ("/.runtime/estimator.sqlite3", "/../README.md", "/data/baseline.json", "/%2e%2e/README.md"):
            self.assertEqual(self.request("GET", path)[0], 404)
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Ceasefire", body)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])


if __name__ == "__main__":
    unittest.main()
