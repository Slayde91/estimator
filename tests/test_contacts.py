"""Exercise the directory through the same HTTP and XLSX paths as the browser."""

import base64
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

from estimator.server import create_server


class DirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        directory = Path(self.temp.name)
        self.server = create_server(0, directory / "test.sqlite3", library_directory=directory / "library")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, route, body=None, expected=200, headers=None):
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        try:
            client.request("POST" if body is not None else "GET", "/api/contacts/" + route,
                           json.dumps(body) if body is not None else None, {"Content-Type": "application/json", **(headers or {})})
            response = client.getresponse()
            value = response.read()
            self.assertEqual(response.status, expected, value[:300])
            return json.loads(value) if response.getheader("Content-Type").startswith("application/json") else value
        finally:
            client.close()

    def test_lead_is_linked_to_person_and_company_through_updates(self):
        directory = self.request("directory")
        self.assertEqual(directory["statuses"], ["New", "Assisting", "Interstate", "Qualified", "Disqualified", "Not Applicable"])
        fields = {"name": "Morgan", "phone": "0401", "title": "Foreman", "email": "morgan@example.test",
                  "company": "ACME", "site_address": "First site", "billing_address": "HQ", "description": "Fitout"}
        result = self.request("leads", {"fields": fields, "version": directory["version"]})
        current = self.request("directory")
        contact, account, lead = current["contacts"][0], current["accounts"][0], current["leads"][0]
        self.assertEqual((lead["id"], lead["status"], lead["contact_id"], contact["account_id"]),
                         (result["id"], "New", contact["id"], account["id"]))
        self.assertEqual(account["billing_address"], "HQ")
        for key in ["name", "phone", "company", "title", "email"]:
            self.assertEqual(fields[key], contact[key])
        self.request("leads", {"id": lead["id"], "fields": {**fields, "status": "Assisting"}, "version": current["version"]})
        self.request("leads", {"id": lead["id"], "fields": fields, "version": current["version"]}, 409)
        self.request("leads", {"fields": {**fields, "company": "Acme", "name": "Alex"},
                               "version": self.request("directory")["version"]})
        latest = self.request("directory")
        self.assertEqual(len(latest["accounts"]), 1)
        self.assertEqual(len(latest["contacts"]), 2)
        self.assertEqual({p["account_id"] for p in latest["contacts"]}, {account["id"]})
        self.assertEqual(next(l for l in latest["leads"] if l["id"] == result["id"])["status"], "Assisting")

    def test_convert_replays_durable_project_after_interrupted_directory_update(self):
        from estimator.catalog import ValidationError
        from estimator.project_library import ProjectLibrary
        from estimator.storage import Store
        person = self.request("leads", {"version":0, "fields":{"name":"Alex", "company":"QA Company", "site_address":"QA Site", "description":"Install", "billing_address":"QA HQ"}})
        body = {"id":person["id"], "version":1}
        self.request("leads/convert", body, 400)
        self.assertEqual(len(self.request("directory")["leads"]),1)
        folder = Path(self.temp.name)/"Projects"
        folder.mkdir()
        Store(Path(self.temp.name)/"test.sqlite3").set_project_folder(folder)
        create = ProjectLibrary.create_from_lead
        def interrupt(projects, lead):
            create(projects, lead)
            raise ValidationError("Simulated interruption after saving")
        with patch.object(ProjectLibrary, "create_from_lead", interrupt):
            self.request("leads/convert", body, 400)
        self.assertEqual(len(list(folder.rglob("*.cf.json"))),1)
        self.assertEqual(len(self.request("directory")["leads"]),1)
        saved = self.request("leads/convert", body)
        self.assertEqual(saved,self.request("leads/convert", body))
        self.assertEqual(len(list(folder.rglob("*.cf.json"))),1)
        project = json.loads(Path(saved["path"]).read_bytes())
        self.assertEqual(project["estimate"]["site_address"],"QA Site")
        self.assertEqual(project["estimate"]["client"],"QA Company")
        self.assertIn("Description: Install",project["estimate"]["measurements"])
        current = self.request("directory")
        self.assertFalse(current["leads"])
        self.assertEqual(current["contacts"][0]["account_id"],current["accounts"][0]["id"])

    def upload(self, kind, rows, expected=200):
        template = self.request(f"{kind}/template.xlsx")
        book = load_workbook(BytesIO(template))
        self.assertEqual(book.sheetnames, [kind.title()])
        for row in rows:
            book.active.append(row)
        out = BytesIO()
        book.save(out)
        book.close()
        return self.request(f"{kind}/import", {"filename": "filled.xlsx", "file": base64.b64encode(out.getvalue()).decode(),
                             "version": self.request("directory")["version"]}, expected)

    def test_same_revision_race_and_browser_origin_guards(self):
        create = {"fields": {"name": "Laptop test", "company": "Directory race"}, "version": 0}
        self.request("leads", create, 403, {"Origin": "https://unrelated.example"})
        self.request("leads", create, 403, {"Sec-Fetch-Site": "cross-site"})
        def attempt():
            connection = HTTPConnection("127.0.0.1", self.server.server_port)
            try:
                connection.request("POST", "/api/contacts/leads", json.dumps(create), {"Content-Type": "application/json"})
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()
        with ThreadPoolExecutor(2) as workers:
            writes = [workers.submit(attempt) for _ in range(2)]
        self.assertEqual(sorted(write.result() for write in writes), [200, 409])
        directory = self.request("directory")
        for kind in ("accounts", "contacts", "leads"):
            self.assertEqual(len(directory[kind]), 1)

    def test_oversized_row_is_rejected_before_import(self):
        book = load_workbook(BytesIO(self.request("accounts/template.xlsx")))
        book.active["A5002"] = "Beyond limit"
        out = BytesIO()
        book.save(out)
        book.close()
        reply = self.request("accounts/import", {"version": 0, "filename": "oversized.xlsx",
                             "file": base64.b64encode(out.getvalue()).decode()}, 400)
        self.assertIn("5,000", reply["error"])
        self.assertFalse(self.request("directory")["accounts"])

    def test_excel_templates_round_trip_relate_contacts_and_reject_partial_imports(self):
        bulk = [["Stage", "Warehouse 2"], ["Services", "Warehouse 3"]]
        self.assertEqual(self.upload("accounts", bulk)["added"], 2)
        self.assertEqual(self.upload("accounts", bulk)["matched"], 2)
        valid = ["Alex", "0403 222 222", "STAGE", "Manager", "alex@example.com"]
        invalid = ["Pat", "", "New account", "", "bad@@"]
        self.assertIn("Row 3", self.upload("contacts", [valid, invalid], 400)["error"])
        self.assertFalse(self.request("directory")["contacts"])
        self.assertEqual(self.upload("contacts", [valid])["added"], 1)
        self.assertEqual(self.upload("contacts", [valid])["matched"], 1)
        data = self.request("directory")
        self.assertEqual(len(data["accounts"]), 2)
        account_id = next(a["id"] for a in data["accounts"] if a["company"] == "Stage")
        self.assertEqual(data["contacts"][0]["account_id"], account_id)
        self.assertEqual(data["contacts"][0]["phone"], valid[1])
        self.assertIn("formulas", self.upload("accounts", [["=NOW()", ""]], 400)["error"])
