import copy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.project_file import export_project, load_project_bytes, project_summary
from estimator.project_library import ProjectLibrary, file_fingerprint
from estimator.storage import Store


class ProjectStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as directory:
            cls.payload = export_project(Store(Path(directory) / "source.sqlite3"), {"estimate": {"title": "Status fixture"}})

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = Store(self.root / "state.sqlite3")
        self.store.set_project_folder(self.root)
        self.path = self.root / "Fixture.cf.json"
        self.path.write_bytes(self.payload)
        self.library = ProjectLibrary(self.store)
        self.addCleanup(self.library.close)
        self.file = self.library.listing()["files"][0]

    def change(self, status, file=None):
        selected = file or self.file
        return self.library.update_status({"id": selected["id"], "revision": selected["revision"], "project_status": status})["file"]

    def test_legacy_projects_default_to_draft_and_invalid_status_is_rejected(self):
        snapshot = json.loads(self.payload)
        snapshot.pop("project_status")
        legacy = json.dumps(snapshot).encode()
        self.assertEqual(project_summary(legacy)["project_status"], "Draft")
        self.assertEqual(load_project_bytes(self.store, legacy)["project_status"], "Draft")
        snapshot["project_status"] = "Paid"
        with self.assertRaises(ValidationError):
            project_summary(json.dumps(snapshot).encode())

    def test_status_round_trip_preserves_all_project_values_and_rotates_revision(self):
        original = json.loads(self.path.read_bytes())
        file = self.change("Review")
        expected = copy.deepcopy(original)
        expected["project_status"] = "Review"
        self.assertEqual(json.loads(self.path.read_bytes()), expected)
        self.assertNotEqual(file["revision"], self.file["revision"])
        self.assertEqual(self.library.load(file["id"])["project_status"], "Review")
        self.assertEqual(self.library.listing()["files"][0]["project_status"], "Review")
        with self.assertRaises(ValidationError):
            self.change("Lost")
        self.assertEqual(json.loads(self.path.read_bytes()), expected)

    def test_external_edits_reject_status_and_delete_without_writes(self):
        self.path.write_bytes(self.payload + b"\n")
        with self.assertRaises(ValidationError):
            self.change("Accepted")
        with self.assertRaises(ValidationError):
            self.library.delete_project({"id": self.file["id"], "revision": self.file["revision"]})
        self.assertEqual(self.path.read_bytes(), self.payload + b"\n")

    def test_older_save_clients_preserve_the_current_status(self):
        file = self.change("Presented")
        loaded = self.library.load(file["id"])
        snapshot = json.loads(self.path.read_bytes())
        request = {"save_token": loaded["file"]["save_token"], "estimate": snapshot["estimate"],
                   "calculators": {key: {"inputs": value["inputs"], "schedule_rows": value["schedule_rows"]}
                                   for key, value in snapshot["calculators"].items()}}
        saved = self.library.save(request)
        self.assertEqual(saved["project"]["project_status"], "Presented")

    def test_native_selection_updates_status_without_a_folder_scan(self):
        class Dialogs:
            def choose_open(dialogs, folder):
                return str(self.path)

        unscanned = ProjectLibrary(self.store, Dialogs())
        self.addCleanup(unscanned.close)
        selected = unscanned.open_file()["file"]
        self.assertIsNone(unscanned._scan)
        request = {"save_token": selected["save_token"], "revision": selected["revision"], "project_status": "Accepted"}
        result = unscanned.update_status(request)
        self.assertEqual(result["file"]["project_status"], "Accepted")
        with self.assertRaises(ValidationError):
            unscanned.update_status(request)

    def test_older_save_as_clients_preserve_an_existing_project_status(self):
        self.change("Lost")
        snapshot = json.loads(self.payload)

        class Dialogs:
            def choose_save(dialogs, directory, filename):
                return SaveSelection(str(self.path), file_fingerprint(self.path))

        self.library.dialogs = Dialogs()
        request = {"estimate": snapshot["estimate"],
                   "calculators": {key: {"inputs": value["inputs"]}
                                   for key, value in snapshot["calculators"].items()}}
        result = self.library.save_as(request)
        self.assertEqual(result["project"]["project_status"], "Lost")

    def test_status_rejects_forged_selections_and_never_writes_a_path_argument(self):
        for request in [
            {"save_token": "forged", "revision": self.file["revision"], "project_status": "Lost"},
            {"id": self.file["id"], "revision": self.file["revision"], "project_status": "Lost", "path": str(self.path)},
        ]:
            with self.assertRaises(ValidationError):
                self.library.update_status(request)
        self.assertEqual(self.path.read_bytes(), self.payload)

    def test_delete_retains_recoverable_bytes_and_companion_files(self):
        companion = self.root / "Drawing.pdf"
        companion.write_bytes(b"Retained companion")
        result = self.library.delete_project({"id": self.file["id"], "revision": self.file["revision"]})
        self.assertFalse(self.path.exists())
        self.assertEqual(Path(result["retained_file"]).read_bytes(), self.payload)
        self.assertEqual(companion.read_bytes(), b"Retained companion")
        self.assertEqual(self.library.listing(refresh=True)["files"], [])


if __name__ == "__main__":
    unittest.main()
