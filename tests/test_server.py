import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from estimator.catalog import ROOT, baseline
from estimator.server import create_server
from test_report import pdf_text


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

    def test_official_logo_is_served_unchanged_with_image_content_type(self):
        status, headers, body = self.request("GET", "/ceasefire-logo.png")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(body, (ROOT / "static/ceasefire-logo.png").read_bytes())

    def test_current_pdf_is_downloadable_and_does_not_save_or_change_prices(self):
        quotes_before = self.request("GET", "/api/quotes")[2]
        pricing_before = self.request("GET", "/api/configuration")[2]
        status, headers, payload = self.request("POST", "/api/quote-report", {"title": 'Duct "/..\\\r\nreport', "inputs": {"B15": 12.25}})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertEqual(headers["Content-Disposition"], 'attachment; filename="Duct-report.pdf"')
        self.assertEqual(int(headers["Content-Length"]), len(payload))
        self.assertEqual(headers["Cache-Control"], "no-store")
        text = pdf_text(payload)
        self.assertIn("Current unsaved estimate", text)
        self.assertIn("Current estimate", text)
        self.assertEqual(self.request("GET", "/api/quotes")[2], quotes_before)
        self.assertEqual(self.request("GET", "/api/configuration")[2], pricing_before)

    def test_saved_pdf_uses_its_snapshot_even_when_catalogue_changes(self):
        _, _, body = self.request("POST", "/api/quotes", {"title": "Historical PDF", "inputs": {"B15": 19.75}})
        quote = json.loads(body)
        with patch("estimator.catalog.baseline", side_effect=AssertionError("Saved report read today's catalogue")), patch("estimator.storage.calculate", side_effect=AssertionError("Saved report recalculated")):
            status, _, payload = self.request("GET", f'/api/quotes/{quote["id"]}/report.pdf')
        self.assertEqual(status, 200)
        text = pdf_text(payload)
        self.assertIn("Saved quote", text)
        self.assertIn(quote["id"], text)
        self.assertIn(f'${quote["result"]["summary"]["total"]:,.2f}', text)
        self.assertEqual(self.request("GET", f'/api/quotes/{quote["id"]}')[2], body)

    def test_edited_saved_preview_preserves_source_lineage_without_saving(self):
        _, _, body = self.request("POST", "/api/quotes", {"title": "Original PDF pricing", "inputs": {"B15": 10}})
        quote = json.loads(body)
        changed = baseline()
        changed["sources"]["quote"]["sha256"] = "later-source-hash"
        with patch("estimator.storage.baseline", return_value=changed):
            status, _, payload = self.request("POST", "/api/quote-report", {"source_quote_id": quote["id"], "title": "Unsaved changes", "inputs": {"B15": 12}, "configuration": quote["configuration"]})
        self.assertEqual(status, 200)
        text = "".join(pdf_text(payload).split())
        self.assertIn(quote["source_hashes"]["quote"]["sha256"], text)
        self.assertNotIn("later-source-hash", text)
        self.assertEqual(self.request("GET", f'/api/quotes/{quote["id"]}')[2], body)

    def test_pdf_requests_validate_inputs_and_respect_origin_boundary(self):
        for data in ({"title": ""}, {"title": "Invalid", "inputs": {"F7": 99}}, {"title": "Invalid", "source_quote_id": 123}):
            self.assertEqual(self.request("POST", "/api/quote-report", data)[0], 400)
        self.assertEqual(self.request("POST", "/api/quote-report", {"title": "Blocked"}, {"Origin": "https://attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/quotes/missing/report.pdf")[0], 404)


if __name__ == "__main__":
    unittest.main()
