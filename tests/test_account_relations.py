"""Account ownership and supplementary links must change together or not at all."""

from pathlib import Path
from contextlib import closing
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.account_relations import AccountRelations
from estimator.catalog import ValidationError
from estimator.contacts import ContactsConflict, ContactsStore, LINK_KINDS


def empty_links(**updates):
    return {kind: updates.get(kind, []) for kind in LINK_KINDS}


class KnownProjects:
    def __init__(self):
        self.owner = str(uuid4())
        self.document = str(uuid4())
        self.files = [{"source_project_id": self.owner, "project_no": "PN-00001", "client": "Company A", "site_address": "Site A"}]
        self.documents = [{"id": self.document, "project_id": self.owner, "kind": "quote", "reference": "Q-01",
                           "fields": {"title": "Quote A", "details": {"client": "Company A", "project_no": "PN-00001"}}}]
        self.pending = False
        self.missing = []

    def commercial_register(self):
        return {"documents": self.documents, "scan_pending": self.pending, "error_count": 0,
                "unavailable_sources": self.missing}

    def account_relation_projects(self):
        return {"files": self.files, "scan_pending": self.pending, "error_count": 0, "errors": []}


class AccountRelationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ContactsStore(Path(self.temp.name) / "contacts.sqlite3")
        self.projects = KnownProjects()
        self.relations = AccountRelations(self.store, self.projects)

    def tearDown(self):
        self.temp.cleanup()

    def save(self, kind, fields, ident=None, links=None):
        body = {"fields": fields, "version": self.store.list()["version"]}
        if ident:
            body["id"] = ident
        if links is not None:
            body["links"] = links
        catalog = self.relations.view(ident, include_ids=links) if links is not None else None
        return self.store.save(kind, body, link_catalog=catalog)

    def test_abn_is_canonical_for_company_and_older_edits_preserve_it(self):
        lead = self.save("leads", {"name": "Alex", "phone": "0400", "email": "alex@example.test", "site_address": "Site A", "company": "Company A", "abn_acn": "ABN 12 345 678 901"})
        current = self.store.list()
        account = current["accounts"][0]
        self.assertEqual(current["leads"][0]["abn_acn"], account["abn_acn"])
        edited = self.save("accounts", {"company": "Company A", "billing_address": "Updated HQ"}, account["id"])
        self.assertEqual(edited["account"]["abn_acn"], "ABN 12 345 678 901")
        before = self.store.list()
        with self.assertRaisesRegex(ValidationError, "different ABN/ACN"):
            self.save("leads", {"name": "Someone else", "company": "company a", "abn_acn": "Conflicting"})
        self.assertEqual(self.store.list(), before)
        converted = []
        self.store.convert({"id": lead["id"], "version": before["version"]},
                           lambda data: converted.append(data) or {"path": "saved.cf.json", "project_no": "PN-00002"})
        self.assertEqual(converted[0]["abn_acn"], "ABN 12 345 678 901")

    def test_new_account_reassigns_existing_contact_and_links_all_record_types_atomically(self):
        self.save("leads", {"name": "Alex", "company": "Previous company"})
        before = self.store.list()
        person = before["contacts"][0]
        captured_lead = before["leads"][0]
        self.projects.documents.extend({**self.projects.documents[0], "id": str(uuid4()), "kind": kind}
                                       for kind in ("work_order", "purchase_order"))
        choices = self.relations.view()["choices"]
        links = empty_links(contacts=[person["id"]], projects=[self.projects.owner],
                            **{kind: [choices[kind][0]["id"]] for kind in ("quotes", "work_orders", "purchase_orders")})
        saved = self.save("accounts", {"company": "New company", "abn_acn": "ACN 123"}, links=links)
        current = self.store.list()
        self.assertEqual(current["contacts"][0]["account_id"], saved["id"])
        self.assertEqual(current["contacts"][0]["company"], "New company")
        self.assertEqual(current["leads"][0], captured_lead)
        related = self.relations.view(saved["id"])
        self.assertEqual({kind: [entry["id"] for entry in entries] for kind, entries in related["linked"].items()}, links)
        self.assertEqual(len(self.store.saved_links(saved["id"])), 4)

    def test_unknown_targets_and_stale_version_cannot_partially_update_account_or_contacts(self):
        original = self.save("accounts", {"company": "Original"})
        self.save("contacts", {"name": "Alex", "company": "Elsewhere"})
        person = self.store.list()["contacts"][0]
        before = self.store.list()
        links = empty_links(contacts=[person["id"]], projects=["C:/arbitrary/private.cf.json"])
        with self.assertRaisesRegex(ValidationError, "no longer available"):
            self.save("accounts", {"company": "Renamed", "abn_acn": "ACN should roll back"}, original["id"], links)
        self.assertEqual(self.store.list(), before)
        with self.assertRaises(ContactsConflict):
            self.store.save("accounts", {"id": original["id"], "version": 0, "fields": {"company": "Wrong"},
                                        "links": empty_links(contacts=[person["id"]])},
                            link_catalog=self.relations.view(original["id"]))
        self.assertEqual(self.store.list(), before)

    def test_missing_previously_linked_records_remain_visible_and_retained(self):
        token = f"{self.projects.owner}:{self.projects.document}"
        account = self.save("accounts", {"company": "Other company"}, links=empty_links(quotes=[token]))
        self.projects.documents = []
        current = self.relations.view(account["id"])
        self.assertEqual(current["linked"]["quotes"][0]["id"], token)
        self.assertFalse(current["linked"]["quotes"][0]["available"])
        self.save("accounts", {"company": "Other company", "billing_address": "New HQ"}, account["id"], empty_links(quotes=[token]))
        self.assertEqual(self.store.saved_links(account["id"])[0]["target_id"], token)
        with self.assertRaises(ValidationError):
            self.save("accounts", {"company": "Forged"}, links=empty_links(quotes=[token]))

    def test_primary_account_wins_over_legacy_name_and_does_not_create_manual_links(self):
        account = self.save("accounts", {"company": "Company A"})
        automatic = self.relations.view(account["id"])
        self.assertTrue(automatic["linked"]["projects"][0]["automatic"])
        token = automatic["linked"]["quotes"][0]["id"]
        self.save("accounts", {"company": "Company A"}, account["id"],
                  empty_links(projects=[self.projects.owner], quotes=[token]))
        self.assertFalse(self.store.saved_links(account["id"]))
        self.projects.files[0]["account_id"] = str(uuid4())
        self.assertFalse(self.relations.view(account["id"])["linked"]["projects"])

    def test_contact_linked_to_lead_cannot_lose_its_company(self):
        self.save("leads", {"name": "Alex", "company": "Company A"})
        account = self.store.list()["accounts"][0]
        before = self.store.list()
        with self.assertRaisesRegex(ValidationError, "must keep a company"):
            self.save("accounts", {"company": "Changed"}, account["id"], empty_links())
        self.assertEqual(self.store.list(), before)

    def test_pending_errors_and_filtered_choices_are_explicit(self):
        self.projects.pending = True
        self.projects.missing = [{"title": "Unavailable known project"}]
        view = self.relations.view(search="no match")
        self.assertTrue(view["scan_pending"])
        self.assertEqual(view["error_count"], 1)
        self.assertIn("Unavailable known project", view["errors"][0]["name"])
        self.assertFalse(view["choices"]["projects"])
        self.assertTrue(self.relations.view(search="site a")["choices"]["projects"])

    def test_document_identity_includes_owning_project(self):
        other_owner = str(uuid4())
        self.projects.documents.append({**self.projects.documents[0], "project_id": other_owner})
        tokens = {entry["id"] for entry in self.relations.view()["choices"]["quotes"]}
        self.assertEqual(tokens, {f"{owner}:{self.projects.document}" for owner in (self.projects.owner, other_owner)})


class AccountMigrationTests(unittest.TestCase):
    def test_previous_directory_migrates_without_changing_ids_or_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "contacts.sqlite3"
            ident = str(uuid4())
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript("CREATE TABLE revision(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);"
                                 "INSERT INTO revision VALUES(1,7);"
                                 "CREATE TABLE accounts(id TEXT PRIMARY KEY,company TEXT NOT NULL,lookup_key TEXT NOT NULL UNIQUE,billing_address TEXT NOT NULL);")
                db.execute("INSERT INTO accounts VALUES(?,?,?,?)", (ident, "Existing", "existing", "HQ"))
            directory = ContactsStore(path).list()
            self.assertEqual(directory["version"], 7)
            self.assertEqual(directory["accounts"], [{"id": ident, "company": "Existing", "billing_address": "HQ", "abn_acn": ""}])


class SavedProjectIdentityTests(unittest.TestCase):
    def test_plain_project_identity_survives_details_and_first_certificate_metadata(self):
        from estimator.project_file import export_project
        from estimator.project_library import ProjectLibrary
        from estimator.storage import Store
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = Store(root / "state.sqlite3")
            folder = root / "Projects"
            folder.mkdir()
            store.set_project_folder(folder)
            saved = folder / "Plain.cf.json"
            saved.write_bytes(export_project(store, {"estimate": {"project_no": "PN-00001", "client": "Plain company"}}))
            directory = ContactsStore(root / "contacts.sqlite3")
            library = ProjectLibrary(store)
            try:
                relations = AccountRelations(directory, library)
                view = relations.view()
                for _ in range(20):
                    if not view["scan_pending"]:
                        break
                    view = relations.view()
                original = view["choices"]["projects"][0]["id"]
                metadata = next(iter(library._scan["files"].values()))
                self.assertIsNone(metadata["source_project_id"])
                # Certificate ownership is introduced later without renaming the
                # saved project. It must not invalidate an existing Account link.
                metadata.update(source_project_id=str(uuid4()), client="Updated company", title="New project title")
                with patch.object(library, "listing", return_value={"files": [], "scan_pending": False, "error_count": 0, "errors": []}):
                    updated = library.account_relation_projects()["files"][0]
                    self.assertEqual(updated["account_link_id"], original)
                account = directory.save("accounts", {"version": 0, "fields": {"company": "Related company"},
                    "links": empty_links(projects=[original])}, link_catalog=view)
                renamed = folder / "Renamed.cf.json"
                saved.rename(renamed)
                library.listing(refresh=True)
                changed = relations.view(account["id"])
                self.assertFalse(changed["linked"]["projects"][0]["available"])
                self.assertNotEqual(changed["choices"]["projects"][0]["id"], original)
            finally:
                library.close()
