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

from openpyxl import Workbook, load_workbook

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
        # Conversion exercises a real numbered project write and durable recovery.
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=60 if route == "leads/convert" else 10)
        try:
            client.request("POST" if body is not None else "GET", "/api/contacts/" + route,
                           json.dumps(body) if body is not None else None, {"Content-Type": "application/json", **(headers or {})})
            response = client.getresponse()
            value = response.read()
            self.assertEqual(response.status, expected, value[:300])
            return json.loads(value) if response.getheader("Content-Type").startswith("application/json") else value
        finally:
            client.close()

    def test_new_contact_minimum_fields_are_enforced_before_http_directory_writes(self):
        before = self.request('directory')
        complete = {'name': 'Required Contact', 'phone': '0400', 'company': 'Manual Company', 'email': 'person@example.test'}
        for field in complete:
            with self.subTest(field=field):
                self.request('contacts', {'version': before['version'], 'fields': {**complete, field: ''}}, expected=400)
                self.assertEqual(self.request('directory'), before)
        saved = self.request('contacts', {'version': before['version'], 'fields': complete})
        self.assertEqual(saved['contact']['title'], '')
        self.assertEqual(saved['contact']['company'], 'Manual Company')

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

    def test_possible_contact_duplicate_requires_review_without_partial_writes(self):
        fields = {"name": "Jo García", "phone": "0400", "company": "Example", "email": "josé@example.test"}
        saved = self.request("contacts", {"version": 0, "fields": fields})["contact"]
        before = self.request("directory")
        changed = {**fields, "name": "JO  GARCÍA", "email": "JOSÉ@example.test", "phone": "0401"}
        for kind in ("contacts", "leads"):
            fields_to_save = {**changed, "billing_address": "Do not write"} if kind == "leads" else changed
            body = {"version": before["version"], "fields": fields_to_save, "create_separate_contact": "true"}
            self.assertEqual(self.request(kind, body, expected=409)["matching_contacts"], [saved["id"]])
            self.assertEqual(self.request("directory"), before)
        lead = self.request("leads", {"version": before["version"], "fields": changed, "contact_id": saved["id"]})
        self.assertEqual(self.request("directory")["contacts"], before["contacts"])
        self.request("contacts", {"version": before["version"], "fields": changed, "create_separate_contact": True}, 409)
        separate = self.request("contacts", {"version": lead["version"], "fields": changed, "create_separate_contact": True})
        self.assertNotEqual(separate["id"], saved["id"])
        # A shared mailbox, a shared name or the same person name at another company is insufficient.
        for override in ({"name": "Pat"}, {"email": "second@example.test"}, {"company": "Other Company"}):
            self.request("contacts", {"fields": {**fields, **override}, "version": self.request("directory")["version"]})

    def test_convert_replays_durable_project_after_interrupted_directory_update(self):
        from estimator.catalog import ValidationError
        from estimator.project_library import ProjectLibrary
        from estimator.storage import Store
        person = self.request("leads", {"version":0, "fields":{"name":"Alex", "phone":"0400", "email":"alex@example.test", "company":"QA Company", "site_address":"QA Site", "description":"Install", "billing_address":"QA HQ",
            "next_action":"Confirm access with the site manager", "follow_up_date":"2027-02-22"}})
        lead, = self.request("directory")["leads"]
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
        self.assertEqual(self.request("directory")["leads"], [lead])
        self.assertEqual(self.request("contact-links?id="+lead["contact_id"])["converted_leads"], [])
        saved = self.request("leads/convert", body)
        self.assertEqual(saved,self.request("leads/convert", body))
        self.assertEqual(len(list(folder.rglob("*.cf.json"))),1)
        project = json.loads(Path(saved["path"]).read_bytes())
        self.assertEqual(project["estimate"]["site_address"],"QA Site")
        self.assertEqual(project["estimate"]["client"],"QA Company")
        for field in ("contact_id", "account_id"):
            self.assertEqual(project["estimate"][field], lead[field])
        self.assertIn("Description: Install",project["estimate"]["measurements"])
        current = self.request("directory")
        self.assertFalse(current["leads"])
        self.assertEqual(current["contacts"][0]["account_id"],current["accounts"][0]["id"])
        # Lead conversion intentionally has no certificate/commercial workspace;
        # its saved file must still be a valid existing Project link target.
        self.assertNotIn("certifications", project)
        catalog = self.request("account-links")
        for _ in range(20):
            if not catalog["scan_pending"]:
                break
            catalog = self.request("account-links")
        self.assertTrue(any(saved["project_no"] in row["label"] for row in catalog["choices"]["projects"]))
        for endpoint, key in (("contact-links", "contact_id"), ("account-links", "account_id")):
            related = self.request(endpoint + "?id=" + lead[key])
            history, = related["converted_leads"]
            self.assertEqual((history["lead_id"], history["project_no"], history["snapshot"]), (person["id"], saved["project_no"], lead))
            self.assertTrue(any(saved["project_no"] in row["label"] for row in related["linked"]["projects"]))

    def test_incomplete_lead_conversion_has_no_project_or_directory_side_effects(self):
        from estimator.project_library import ProjectLibrary
        from estimator.storage import Store
        folder = Path(self.temp.name) / "Projects"
        folder.mkdir()
        Store(Path(self.temp.name) / "test.sqlite3").set_project_folder(folder)
        lead = self.request("leads", {"version": 0, "fields": {"name": "Partial Lead", "company": "Draft Company"}})
        before = self.request("directory")
        with patch.object(ProjectLibrary, "create_from_lead") as create:
            result = self.request("leads/convert", {"id": lead["id"], "version": before["version"]}, 400)
        self.assertIn("Complete Name, Phone, Company, Email and Site address", result["error"])
        create.assert_not_called()
        self.assertEqual(self.request("directory"), before)
        self.assertEqual(list(folder.rglob("*.cf.json")), [])

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
        before = self.request("directory")
        changed = [valid[0], "new phone", valid[2], "new title", valid[4]]
        with_new_company = ["Other", "123", "Rollback Company", "", "other@example.test"]
        conflict = self.upload("contacts", [with_new_company, changed], 400)
        self.assertIn("Row 3", conflict["error"])
        self.assertIn("already has this name and email", conflict["error"])
        self.assertEqual(self.request("directory"), before)
        data = self.request("directory")
        self.assertEqual(len(data["accounts"]), 2)
        account_id = next(a["id"] for a in data["accounts"] if a["company"] == "Stage")
        self.assertEqual(data["contacts"][0]["account_id"], account_id)
        self.assertEqual(data["contacts"][0]["phone"], valid[1])
        self.assertIn("formulas", self.upload("accounts", [["=NOW()", ""]], 400)["error"])

    def test_account_links_http_validates_queries_and_all_link_targets(self):
        choices = self.request("account-links")
        self.assertEqual(set(choices["linked"]), {"contacts", "projects", "quotes", "work_orders", "purchase_orders"})
        account = self.request("accounts", {"fields": {"company": "Account", "abn_acn": "ABN 12"}, "version": 0})
        self.assertEqual(account["account"]["abn_acn"], "ABN 12")
        self.assertEqual(self.request("account-links?id=" + account["id"])["version"], 1)
        self.request("account-links?id=unknown", expected=400)
        self.request("account-links?search=one&search=two", expected=400)
        bad_links = {kind: [] for kind in choices["linked"]}
        bad_links["projects"] = ["C:/not-an-authorized-project.cf.json"]
        self.request("accounts", {"id": account["id"], "fields": {"company": "Changed"}, "version": 1, "links": bad_links}, 400)
        self.assertEqual(self.request("directory")["accounts"][0]["company"], "Account")
        bad_links["projects"] = None
        self.request("accounts", {"id": account["id"], "fields": {"company": "Changed"}, "version": 1, "links": bad_links}, 400)

    def test_account_template_supports_abn_and_original_two_column_template(self):
        self.assertEqual(self.upload("accounts", [["ABN Company", "HQ", "12 345 678 901"]])["added"], 1)
        self.assertEqual(self.request("directory")["accounts"][0]["abn_acn"], "12 345 678 901")
        book = Workbook()
        book.active.title = "Accounts"
        book.active.append(["Company", "Billing Address"])
        book.active.append(["Legacy Company", "Legacy HQ"])
        output = BytesIO()
        book.save(output)
        book.close()
        self.request("accounts/import", {"version": 1, "filename": "old-template.xlsx",
                                         "file": base64.b64encode(output.getvalue()).decode()})
        companies = {row["company"]: row for row in self.request("directory")["accounts"]}
        self.assertEqual(companies["Legacy Company"]["abn_acn"], "")
