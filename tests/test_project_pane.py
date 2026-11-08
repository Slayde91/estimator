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
        for key in ("contact_name", "contact_phone", "contact_email", "account_id"):
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
                "details": {**current["details"], **changes}}

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
