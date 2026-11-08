"""Contact related records follow canonical identities, never Company guesses."""

from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.commercial_sources import source_id
from estimator.contact_relations import ContactRelations
from estimator.contacts import ContactsStore
from estimator.contacts_http import ContactsHTTP


class KnownProjects:
    def __init__(self):
        self.files = []
        self.documents = []
        self.pending = False
        self.missing = []
        self.errors = []
        self.reads = 0

    def commercial_register(self):
        self.reads += 1
        return {"documents": self.documents, "scan_pending": self.pending, "error_count": len(self.errors), "unavailable_sources": self.missing}

    def account_relation_projects(self):
        self.reads += 1
        return {"files": self.files, "scan_pending": self.pending, "error_count": len(self.errors), "errors": self.errors}


class ContactRelationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "contacts.sqlite3"
        self.store = ContactsStore(self.path)
        self.projects = KnownProjects()
        self.relations = ContactRelations(self.store, self.projects)
        self.contact = self.save("contacts", {"name": "Same Name", "company": "Same Company", "email": "first@example.test"})["contact"]
        self.other = self.save("contacts", {"name": "Same Name", "company": "Same Company", "email": "other@example.test"})["contact"]

    def tearDown(self):
        self.temp.cleanup()

    def save(self, kind, fields, identifier=None):
        return self.store.save(kind, {"version": self.store.list()["version"], "fields": fields, **({"id": identifier} if identifier else {})})

    def project(self, contact_id, *, owner=None, token=None, path=None):
        row = {"source_project_id": owner or str(uuid4()), "account_link_id": token or str(uuid4()),
               "project_no": "PN-01", "client": "Same Company", "site_address": "Site", "contact_id": contact_id,
               "account_id": self.contact["account_id"], "path": path or str(Path(self.temp.name) / f"{uuid4()}.cf.json")}
        self.projects.files.append(row)
        return row

    def document(self, project, kind="quote", *, source=True):
        record = {"id": str(uuid4()), "project_id": project["source_project_id"], "kind": kind, "reference": kind + "-01",
                  "fields": {"title": "Saved document", "details": {"client": "Same Company", "contact": "Same Name"}}}
        if source:
            record["source_file"] = source_id(project["path"])
        self.projects.documents.append(record)
        return record

    def test_only_canonical_contact_projects_and_their_documents_are_related(self):
        expected = self.project(self.contact["id"])
        other = self.project(self.other["id"])
        legacy = self.project("")
        docs = [self.document(expected, kind) for kind in ("quote", "work_order", "purchase_order")]
        self.document(other)
        self.document(legacy)
        before = self.store.list()
        raw = self.path.read_bytes()
        result = self.relations.view(self.contact["id"])
        self.assertEqual([row["id"] for row in result["linked"]["companies"]], [self.contact["account_id"]])
        self.assertEqual([row["id"] for row in result["linked"]["projects"]], [expected["account_link_id"]])
        for key, doc in zip(("quotes", "work_orders", "purchase_orders"), docs):
            self.assertEqual([row["id"] for row in result["linked"][key]], [f'{expected["source_project_id"]}:{doc["id"]}'])
        self.assertEqual(result["version"], before["version"])
        self.assertEqual(self.store.list(), before)
        self.assertEqual(self.path.read_bytes(), raw)
        self.save("contacts", {**{key: self.contact[key] for key in ("phone", "company", "title", "email")}, "name": "Renamed Contact"}, self.contact["id"])
        self.assertEqual(result["linked"], self.relations.view(self.contact["id"])["linked"])

    def test_duplicate_owner_files_require_exact_document_provenance(self):
        mine = self.project(self.contact["id"])
        other = self.project(self.other["id"], owner=mine["source_project_id"])
        exact = self.document(mine)
        self.document(other)
        self.document(mine, source=False)
        unknown = self.document(mine)
        unknown["source_file"] = "unknown-source"
        foreign = self.document(mine)
        foreign["project_id"] = str(uuid4())
        linked = self.relations.view(self.contact["id"])["linked"]
        self.assertEqual([row["id"] for row in linked["quotes"]], [f'{mine["source_project_id"]}:{exact["id"]}'])
        self.projects.files.remove(other)
        result = self.relations.view(self.contact["id"])
        self.assertEqual(len(result["linked"]["quotes"]), 2, "Only absent-source documents may use the unique-owner fallback")

    def test_no_company_and_partial_scan_do_not_invent_or_hide_links(self):
        orphan = self.save("contacts", {"name": "Orphan"})["contact"]
        project = self.project(orphan["id"])
        self.document(project)
        self.projects.pending = True
        self.projects.errors = [{"name": "Unreadable project", "error": "Cannot read"}]
        self.projects.missing = [{"title": "Unavailable source"}]
        result = self.relations.view(orphan["id"])
        self.assertEqual(result["linked"]["companies"], [])
        self.assertEqual(len(result["linked"]["projects"]), 1)
        self.assertEqual(len(result["linked"]["quotes"]), 1)
        self.assertTrue(result["scan_pending"])
        self.assertEqual(result["error_count"], 2)
        self.assertEqual([row["name"] for row in result["errors"]], ["Unreadable project", "Unavailable source"])

    def test_missing_malformed_and_path_ids_are_rejected_before_scanning(self):
        for value in (None, str(uuid4()), "C:/private/project.cf.json", "../project", self.contact["id"].upper()):
            with self.subTest(value=value), self.assertRaisesRegex(ValidationError, "contact could not be found"):
                self.relations.view(value)
        self.assertEqual(self.projects.reads, 0)

    def test_http_contact_links_accepts_one_id_only_and_never_writes(self):
        class Handler:
            command = "GET"
            headers = {}
            path = "/api/contacts/contact-links?id=" + self.contact["id"]

            def send_payload(handler, status, payload):
                handler.status, handler.payload = status, payload

        api = ContactsHTTP(self.path, self.projects)
        handler = Handler()
        before = self.store.list()
        self.assertTrue(api.dispatch(handler, "/api/contacts/contact-links"))
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload["version"], before["version"])
        self.assertEqual(self.store.list(), before)
        for query in ("", "?id=", "?id=x&id=y", "?id=x&path=C:/private", "?search=anyone"):
            handler.path = "/api/contacts/contact-links" + query
            with self.subTest(query=query), self.assertRaises(ValidationError):
                api.dispatch(handler, "/api/contacts/contact-links")

    def test_saved_project_metadata_exposes_only_its_actual_contact(self):
        from estimator.project_file import export_project
        from estimator.project_library import ProjectLibrary
        from estimator.storage import Store
        root = Path(self.temp.name)
        store = Store(root / "state.sqlite3")
        folder = root / "Projects"
        folder.mkdir()
        store.set_project_folder(folder)
        saved = folder / "Saved.cf.json"
        saved.write_bytes(export_project(store, {"estimate": {"project_no": "PN-01", "client": "Same Company", "contact_name": self.contact["name"],
                                                              "account_id": self.contact["account_id"], "contact_id": self.contact["id"]}}))
        library = ProjectLibrary(store)
        try:
            relations = ContactRelations(self.store, library)
            for _ in range(20):
                result = relations.view(self.contact["id"])
                if not result["scan_pending"]:
                    break
            self.assertEqual(len(result["linked"]["projects"]), 1)
            self.assertEqual(relations.view(self.other["id"])["linked"]["projects"], [])
        finally:
            library.close()


if __name__ == "__main__":
    unittest.main()
