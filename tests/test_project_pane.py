"""Selected-file metadata editing must not open or replace any workspace."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.contacts import ContactsStore
from estimator.project_file import export_project, load_project_bytes
from estimator.project_library import ProjectLibrary, ProjectDetailsConflict
from estimator.quote_details import QUOTE_DETAIL_LIMITS
from estimator.storage import Store


class ProjectPaneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as root:
            cls.base = json.loads(export_project(Store(Path(root) / "source.sqlite3"), {
                "estimate": {"project_no": "PN-00001", "client": "Legacy Company", "site_address": "Old Site",
                             "measurements": "Keep quantities and notes", "inputs": {"B8": 21.23456789}}}))
        # A historical multi-estimate project has none of the new optional keys.
        for key in ("contact_name", "contact_phone", "contact_email", "account_id", "contact_id", "billing_address", "abn_acn"):
            cls.base["estimate"].pop(key, None)
        workspace = {key: deepcopy(cls.base[key]) for key in ("estimate", "calculators")}
        cls.base.update(estimates=[{"id": "estimate-1", "name": "Estimate 1", "workspace": workspace},
                                  {"id": "estimate-" + "a" * 32, "name": "Estimate 2", "workspace": deepcopy(workspace)}],
                        active_estimate_id="estimate-1")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = Store(self.root / "state.sqlite3")
        self.store.set_project_folder(self.root)
        self.path = self.root / "Selected.cf.json"
        self.path.write_text(json.dumps(self.base), encoding="utf-8")
        self.other = self.root / "Other.cf.json"
        self.other.write_bytes(self.path.read_bytes())
        self.accounts = ContactsStore(self.root / "contacts.sqlite3")
        self.library = ProjectLibrary(self.store)
        self.addCleanup(self.library.close)
        listing = self.library.listing()
        while listing["scan_pending"]:
            listing = self.library.listing()
        self.file = next(row for row in listing["files"] if row["name"] == self.path.name)

    def read(self):
        return self.library.read_details({"id": self.file["id"]})

    def request(self, **changes):
        current = self.read()
        return {"id": current["id"], "revision": current["revision"], "request_id": str(uuid4()),
                "details": {**current["details"], **{key:current["details"].get(key) or value for key,value in
                            {"contact_name":"Synthetic Contact", "contact_phone":"0400 000 001", "contact_email":"project@example.test"}.items()}, **changes}}

    def save(self, request):
        return self.library.save_details(request, accounts=self.accounts)

    def test_read_and_save_do_not_open_or_recalculate_workspace(self):
        before = deepcopy(self.base)
        untouched = self.other.read_bytes()
        request = self.request(contact_name="New Contact", contact_phone="123", contact_email="pat@example.com", site_address="New Site")
        with patch("estimator.project_library.load_project_bytes", side_effect=AssertionError("must not open")):
            result = self.save(request)
        after = json.loads(self.path.read_bytes())
        for snapshot in (before, after):
            for estimate in [snapshot["estimate"], *[entry["workspace"]["estimate"] for entry in snapshot["estimates"]]]:
                for key in (*QUOTE_DETAIL_LIMITS, "title"):
                    estimate.pop(key, None)
        self.assertEqual(before, after)
        self.assertEqual(self.other.read_bytes(), untouched)
        self.assertTrue(result["file"]["save_token"])
        saved = json.loads(self.path.read_bytes())
        self.assertTrue(all(entry["workspace"]["estimate"]["contact_name"] == "New Contact" for entry in saved["estimates"]))
        loaded = load_project_bytes(self.store, self.path.read_bytes())
        self.assertEqual(loaded["estimate"]["contact_email"], "pat@example.com")

    def test_legacy_file_loads_and_explicit_account_selection_is_checked(self):
        self.assertEqual(load_project_bytes(self.store, self.path.read_bytes())["estimate"]["account_id"], "")
        for changes in ({"account_id": str(uuid4())}, {"client": "Unknown New Company"}, {"project_no": "PN-99999"}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.save(self.request(**changes))
        self.accounts.save("accounts", {"version": 0, "fields": {"company": "Known Company", "billing_address": ""}})
        account = self.accounts.list()["accounts"][0]
        result = self.save(self.request(client=account["company"], account_id=account["id"]))
        self.assertEqual(result["file"]["account_id"], account["id"])

    def test_project_billing_overrides_round_trip_all_estimates_without_changing_company(self):
        self.accounts.save("accounts", {"version": 0, "fields": {"company": "Known Company", "billing_address": "Company HQ", "abn_acn": "Company ABN"}})
        directory = self.accounts.list()
        company = directory["accounts"][0]
        untouched = self.other.read_bytes()
        request = self.request(client=company["company"], account_id=company["id"],
                               billing_address="Project accounts\nPO Box 42", abn_acn="Project ACN")
        self.save(request)
        saved = json.loads(self.path.read_bytes())
        for estimate in [saved["estimate"], *[row["workspace"]["estimate"] for row in saved["estimates"]]]:
            self.assertEqual(estimate["billing_address"], "Project accounts\nPO Box 42")
            self.assertEqual(estimate["abn_acn"], "Project ACN")
        loaded = load_project_bytes(self.store, self.path.read_bytes())
        self.assertEqual(loaded["estimate"]["billing_address"], "Project accounts\nPO Box 42")
        self.assertEqual(loaded["project_details"]["abn_acn"], "Project ACN")
        self.assertEqual(self.accounts.list(), directory)
        self.assertEqual(self.other.read_bytes(), untouched)

    def contact(self, name="Alex Same", phone="111", email="alex@example.test", company="External Company"):
        saved = self.accounts.save("contacts", {"version": self.accounts.list()["version"],
            "fields": {"name": name, "phone": phone, "email": email, "company": company}})
        return next(row for row in self.accounts.list()["contacts"] if row["id"] == saved["id"])

    def test_contact_link_uses_id_and_keeps_overrides_without_changing_directory_or_client(self):
        first = self.contact()
        second = self.contact(phone="222", email="second@example.test", company="Another Company")
        directory = self.accounts.list()
        original = self.read()["details"]
        result = self.save(self.request(contact_id=second["id"], contact_name=second["name"],
            contact_phone="Project override", contact_email="override@example.test"))
        self.assertNotEqual(first["id"], result["details"]["contact_id"])
        self.assertEqual(result["file"]["contact_id"], second["id"])
        self.assertEqual({key: result["details"][key] for key in ("client", "account_id")},
                         {key: original[key] for key in ("client", "account_id")})
        self.assertEqual(self.accounts.list(), directory)
        loaded = load_project_bytes(self.store, self.path.read_bytes())
        self.assertEqual(loaded["estimate"]["contact_id"], second["id"])
        self.assertEqual(loaded["estimate"]["contact_phone"], "Project override")
        self.assertEqual(loaded["estimate"]["contact_email"], "override@example.test")
        self.assertTrue(all(entry["workspace"]["estimate"]["contact_id"] == second["id"] for entry in loaded["estimates"]))

    def test_contact_selection_checks_identity_but_manual_names_remain_supported(self):
        contact = self.contact()
        for changes in ({"contact_id": str(uuid4()), "contact_name": contact["name"]},
                        {"contact_id": contact["id"], "contact_name": "A different person"}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValidationError, "existing Contact"):
                self.save(self.request(**changes))
        saved = self.save(self.request(contact_id=contact["id"], contact_name=contact["name"]))
        self.assertEqual(saved["details"]["contact_id"], contact["id"])
        manual = self.save(self.request(contact_id="", contact_name="Manual contact", contact_phone="Manual phone"))
        self.assertEqual(manual["details"]["contact_phone"], "Manual phone")

    def test_unknown_imported_contact_can_be_retained_or_explicitly_unlinked(self):
        snapshot = json.loads(self.path.read_bytes())
        snapshot["estimate"].update(contact_id=str(uuid4()), contact_name="Portable Contact", contact_phone="Portable phone")
        self.path.write_text(json.dumps(snapshot), encoding="utf-8")
        saved = self.save(self.request(site_address="New address"))
        self.assertEqual(saved["details"]["contact_id"], snapshot["estimate"]["contact_id"])
        self.assertEqual(saved["details"]["contact_phone"], "Portable phone")
        with self.assertRaisesRegex(ValidationError, "existing Contact"):
            self.save(self.request(contact_name="Changed Contact"))
        self.assertEqual(self.save(self.request(contact_id="", contact_name="Manual Contact"))["details"]["contact_id"], "")

    def test_later_directory_edits_do_not_rewrite_saved_contact_snapshots(self):
        contact = self.contact()
        saved = self.save(self.request(contact_id=contact["id"], contact_name=contact["name"],
            contact_phone="Snapshot phone", contact_email="snapshot@example.test"))
        self.accounts.save("contacts", {"id": contact["id"], "version": self.accounts.list()["version"],
            "fields": {"name": "New directory name", "phone": "New directory phone", "email": "new@example.test",
                       "company": contact["company"]}})
        directory = self.accounts.list()
        result = self.save(self.request(site_address="Only the site changed"))
        for key in ("contact_id", "contact_name", "contact_phone", "contact_email"):
            self.assertEqual(result["details"][key], saved["details"][key])
        self.assertEqual(self.accounts.list(), directory)

    def test_revision_conflicts_and_retries_never_clobber_later_edits(self):
        request = self.request(contact_name="First")
        stale = deepcopy(request)
        stale["request_id"] = str(uuid4())
        first = self.save(request)
        self.assertEqual(self.save(request)["revision"], first["revision"])
        with self.assertRaises(ProjectDetailsConflict):
            self.save(stale)
        self.save(self.request(contact_name="Second"))
        with self.assertRaises(ProjectDetailsConflict):
            self.save(request)
        self.assertEqual(self.read()["details"]["contact_name"], "Second")

    def test_imported_unknown_account_is_retained_until_explicitly_relinked(self):
        snapshot = json.loads(self.path.read_bytes())
        snapshot["estimate"]["account_id"] = str(uuid4())
        self.path.write_text(json.dumps(snapshot), encoding="utf-8")
        result = self.save(self.request(contact_name="Portable Contact"))
        self.assertEqual(result["details"]["account_id"], snapshot["estimate"]["account_id"])

    def test_historical_named_estimate_numbers_cannot_be_reassigned(self):
        snapshot = json.loads(self.path.read_bytes())
        snapshot["estimates"][1]["workspace"]["estimate"]["project_no"] = "Legacy 17"
        self.path.write_text(json.dumps(snapshot), encoding="utf-8")
        self.save(self.request(contact_name="Shared Contact"))
        saved = json.loads(self.path.read_bytes())
        self.assertEqual(saved["estimates"][1]["workspace"]["estimate"]["project_no"], "Legacy 17")
        self.assertTrue(saved["estimates"][1]["workspace"]["estimate"]["title"].startswith("Legacy 17- "))

    def test_atomic_failure_does_not_consume_retry_or_modify_file(self):
        request = self.request(contact_name="Retry")
        before = self.path.read_bytes()
        with patch("estimator.project_library._atomic_write", side_effect=ValidationError("write failed")), self.assertRaises(ValidationError):
            self.save(request)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(self.save(request)["details"]["contact_name"], "Retry")

    def test_endpoint_rejects_paths_and_incomplete_metadata(self):
        for body in ({"id": str(self.path)}, {"id": self.file["id"], "path": str(self.path)}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                self.library.read_details(body)
        request = self.request()
        del request["details"]["account_id"]
        with self.assertRaises(ValidationError):
            self.save(request)

    def test_older_browser_cannot_drop_contact_fields_and_required_values_cannot_be_cleared(self):
        contact = self.contact(name="Saved Person", email="person@example.com")
        self.save(self.request(contact_id=contact["id"], contact_name=contact["name"], contact_email=contact["email"],
                               billing_address="Saved billing address", abn_acn="ABN 123"))
        before = self.path.read_bytes()
        saved = json.loads(before)
        loaded = self.library.load(self.file["id"])
        def workspace(value, *, omit=False):
            estimate = deepcopy(value["estimate"])
            for key in ("contact_name", "contact_email", "contact_id", "billing_address", "abn_acn"):
                if omit:
                    estimate.pop(key, None)
                else:
                    estimate[key] = ""
            return {"estimate": estimate, "calculators": {key: {field: entry[field] for field in ("inputs", "schedule_rows") if field in entry}
                                                        for key, entry in value["calculators"].items()}}
        def request(omit):
            return {**workspace(saved, omit=omit), "save_token": loaded["file"]["save_token"],
                    "active_estimate_id": saved["active_estimate_id"],
                    "estimates": [{**entry, "workspace": workspace(entry["workspace"], omit=omit)} for entry in saved["estimates"]]}
        with self.assertRaisesRegex(ValidationError, "Reload this application"):
            self.library.save(request(True))
        self.assertEqual(self.path.read_bytes(), before)
        id_only = request(False)
        for value in [id_only, *[entry["workspace"] for entry in id_only["estimates"]]]:
            value["estimate"].update(contact_name=contact["name"], contact_email=contact["email"])
            value["estimate"].pop("contact_id")
        with self.assertRaisesRegex(ValidationError, "Reload this application"):
            self.library.save(id_only)
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaisesRegex(ValidationError, "Complete required Project details"):
            self.library.save(request(False))
        self.assertEqual(self.path.read_bytes(), before)
        optional_clear = request(False)
        for value in [optional_clear, *[entry["workspace"] for entry in optional_clear["estimates"]]]:
            value["estimate"].update(contact_name=contact["name"], contact_email=contact["email"])
        result = self.library.save(optional_clear)
        self.assertEqual(result["project"]["estimate"]["contact_name"], contact["name"])
        self.assertEqual(result["project"]["estimate"]["contact_id"], "")
        self.assertEqual(result["project"]["estimate"]["billing_address"], "")
        self.assertEqual(result["project"]["estimate"]["abn_acn"], "")
