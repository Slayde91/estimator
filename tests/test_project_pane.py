"""Selected-file metadata editing must not open or replace any workspace."""

from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.contacts import ContactsStore
from estimator.follow_up import legacy_actions
from estimator.crm_participants import CRMParticipants
from estimator.project_file import export_project, load_project_bytes
from estimator.project_library import ProjectLibrary, ProjectDetailsConflict
from estimator.project_temp import open_project_temp
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

    def test_linked_site_address_denied_write_fails_once_and_can_be_retried(self):
        service = CRMParticipants(self.root / "participants.sqlite3", self.library, self.accounts)
        actor = {"id": str(uuid4()), "name": "Synthetic user"}
        site = service.create_site({"id": str(uuid4()), "name": "Shared site", "address": "Linked address"}, actor)
        request = self.request(site_address="Updated address")
        service.save({"project": self.file["id"], "project_revision": request["revision"],
                      "version": 0, "site_id": site["id"], "participants": []}, actor)
        previous = self.path.read_bytes()
        # Simulate the effective Windows ACL: the directory exists and can be
        # read, but opening any new temporary file there is denied.
        real_open = os.open
        attempts = []
        def deny_creation(path, flags, *args, **kwargs):
            if flags & os.O_CREAT and Path(path).parent == self.root:
                attempts.append(path)
                if len(attempts) > 1:
                    self.fail("Permission denied must not trigger another filename attempt")
                raise PermissionError("Access denied")
            return real_open(path, flags, *args, **kwargs)
        with patch("os.open", side_effect=deny_creation), self.assertRaisesRegex(ValidationError, "permission to create"):
            self.save(request)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(self.read()["details"]["site_address"], "Old Site")
        self.assertEqual(self.save(request)["details"]["site_address"], "Updated address")
        linked = service.view(self.file["id"])
        self.assertEqual((linked["site_id"], linked["site_address"]), (site["id"], "Updated address"))
        self.assertEqual([site["address"] for site in linked["linked_sites"]], ["Updated address", "Linked address"])

    def test_temporary_name_collisions_preserve_existing_files_and_are_bounded(self):
        collision = self.root / ".cf-first.tmp"
        collision.write_bytes(b"existing contents")
        with patch("estimator.project_temp.secrets.token_hex", side_effect=["first", "second"]):
            descriptor, writable = open_project_temp(self.root)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(b"separate file")
        self.assertEqual(writable.read_bytes(), b"separate file")
        with patch("estimator.project_temp.secrets.token_hex", return_value="first") as draw, self.assertRaises(FileExistsError):
            open_project_temp(self.root)
        self.assertEqual(draw.call_count, 8)
        self.assertEqual(collision.read_bytes(), b"existing contents")

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

    def test_project_reminder_retains_legacy_edits_and_checks_dates(self):
        self.assertEqual(self.read()["details"]["follow_up_date"], "")
        other = self.other.read_bytes()
        reminder = {"next_action": "Call\nsite manager", "follow_up_date": "2028-02-29"}
        def old_request(**changes):
            request = self.request(**changes)
            request["details"].pop("follow_up_actions")
            return request
        result = self.save(old_request(**reminder))
        self.assertEqual(result["file"]["follow_up_date"], reminder["follow_up_date"])
        before = self.path.read_bytes()
        for change in ({"follow_up_date": "2027-02-29"}, {"follow_up_date": "20271025"},
                       {"follow_up_date": 1}, {"next_action": "A" * 501}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                self.save(old_request(**change))
            self.assertEqual(self.path.read_bytes(), before)
        legacy = old_request(contact_phone="234")
        for key in reminder:
            del legacy["details"][key]
        self.save(legacy)
        native = json.loads(self.path.read_bytes())
        self.assertEqual(native["project_follow_up"], {"actions":legacy_actions(reminder)})
        for entry in native["estimates"]:
            self.assertFalse(reminder.keys() & entry["workspace"]["estimate"].keys())
        cleared = self.save(old_request(follow_up_date=""))
        self.assertEqual(cleared["details"]["next_action"], reminder["next_action"])
        self.assertEqual(cleared["file"]["follow_up_date"], "")
        self.assertEqual(self.other.read_bytes(), other)

    def test_date_only_decision_retry_and_new_action_after_long_history(self):
        # Simulate a historical singleton directly in an old portable file.
        old = json.loads(self.path.read_bytes())
        old["project_follow_up"] = {"next_action":"", "follow_up_date":"2028-02-29"}
        self.path.write_text(json.dumps(old), encoding="utf8")
        lead = self.read()["details"]["follow_up_actions"][0]
        self.assertEqual(self.read()["details"]["follow_up_actions"][0]["id"], lead["id"])
        closing = self.request(follow_up_actions=[{**lead, "status":"Completed"}])
        first = self.save(closing)
        self.assertEqual(first["project_follow_up"], self.save(closing)["project_follow_up"])
        self.assertEqual(len(first["project_follow_up"]["history"]), 1)
        self.assertEqual(first["file"]["follow_up_date"], "")
        previous = first["details"]["follow_up_actions"]
        long_history = previous + [{**lead, "id":str(uuid4()), "status":"Canceled"} for _ in range(110)]
        self.save(self.request(follow_up_actions=long_history))
        new_action = {**lead, "id":str(uuid4()), "next_action":"Next site inspection", "follow_up_date":"2030-01-01"}
        result = self.save(self.request(follow_up_actions=[*long_history, new_action]))
        self.assertEqual(len(result["project_follow_up"]["history"]), 111)
        self.assertEqual(result["file"]["next_action"], new_action["next_action"])

    def test_project_actions_and_history_commit_once_and_only_to_the_selected_file(self):
        untouched = self.other.read_bytes()
        call = {"id":str(uuid4()), "next_action":"Call site manager", "follow_up_date":"2027-02-20", "status":""}
        plans = {**call, "id":str(uuid4()), "next_action":"Review plans", "follow_up_date":"2027-01-05"}
        saved = self.save(self.request(follow_up_actions=[call, plans]))
        self.assertEqual((saved["file"]["next_action"], saved["file"]["follow_up_date"]), ("Review plans", "2027-01-05"))
        finished = {**plans, "next_action":"Plans reviewed", "status":"Completed"}
        closing = self.request(follow_up_actions=[call, finished])
        stale = self.request(follow_up_actions=[{**call, "status":"Canceled"}, plans])
        original = self.path.read_bytes()
        with patch('estimator.project_library._atomic_write', side_effect=OSError('fixture')), self.assertRaises(OSError):
            self.save(closing)
        self.assertEqual(self.path.read_bytes(), original)
        committed = self.save(closing)
        first_bytes = self.path.read_bytes()
        self.assertEqual(self.save(closing)["project_follow_up"], committed["project_follow_up"])
        self.assertEqual(self.path.read_bytes(), first_bytes)
        with self.assertRaises(ProjectDetailsConflict):
            self.save(stale)
        for lost in ([finished], [call], [call, plans], [call, {**finished, "next_action":"edited"}]):
            with self.assertRaises(ValidationError):
                self.save(self.request(follow_up_actions=lost))
            self.assertEqual(self.path.read_bytes(), first_bytes)
        self.assertEqual(committed["file"]["follow_up_date"], call["follow_up_date"])
        final = self.save(self.request(follow_up_actions=[{**call, "status":"Canceled"}, finished]))
        self.assertEqual(final["file"]["next_action"], "")
        self.assertEqual(final["file"]["follow_up_date"], "")
        self.assertEqual(self.read()["project_follow_up"], final["project_follow_up"])
        self.assertEqual(self.other.read_bytes(), untouched)
        activity = CRMParticipants(self.root / "participants.sqlite3", self.library, self.accounts)
        events = activity.activity(final["id"], final["revision"])["events"]
        decisions = [(row["label"], row["subject"]) for row in events if row["label"].startswith("Follow-up")]
        self.assertEqual(decisions, [("Follow-up completed", "Plans reviewed · 2027-01-05"),
                                     ("Follow-up canceled", "Call site manager · 2027-02-20")])
        other = self.library.listing()["files"]
        peer = next(row for row in other if row["path"] == str(self.other))
        self.assertFalse(any(row["label"].startswith("Follow-up") for row in activity.activity(peer["id"], peer["revision"])["events"]))

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
