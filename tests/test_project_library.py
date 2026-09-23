import copy
import base64
import http.client
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError, baseline
from estimator.native_dialogs import NativeDialogs, SaveSelection
from estimator.project_file import export_project, project_filename, project_download_header
from estimator.project_library import ProjectLibrary, file_fingerprint, _DIALOG_LOCK, _linked
from estimator.server import create_server
from estimator.storage import Store


class Chooser:
    folder = None
    selection = None
    opened = None

    def __init__(self):
        self.calls = []

    def choose_folder(self, initial_directory):
        self.calls.append(("folder", initial_directory))
        return self.folder

    def choose_save(self, initial_directory, filename):
        self.calls.append(("save", initial_directory, filename))
        return self.selection

    def choose_open(self, initial_directory):
        self.calls.append(("open", initial_directory))
        return self.opened


def database_rows(store):
    with store.connect() as db:
        return {table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                for table in ("settings", "quotes", "calculator_states", "app_preferences")}


class ProjectLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as temporary:
            cls.payload = export_project(Store(Path(temporary) / "source.sqlite3"), {
                "estimate": {"project_no": "Project 17", "client": "A client", "measurements": "Keep this note"},
                "calculators": {"steel_vermiculite": {"inputs": {"SCHEDULE": {"AA1009": "Last location", "A1009": "LAST"}}}},
            })
        snapshot = json.loads(cls.payload)
        cls.request = {"estimate": snapshot["estimate"],
                       "calculators": {key: {"inputs": value["inputs"]} for key, value in snapshot["calculators"].items()}}

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.folder = self.root / "Estimates"
        self.folder.mkdir()
        self.store = Store(self.root / "state.sqlite3")
        self.dialogs = Chooser()
        self.library = ProjectLibrary(self.store, self.dialogs)
        self.addCleanup(self.library.close)

    def test_schema_upgrade_adds_preference_without_rewriting_existing_data(self):
        database = self.root / "old.sqlite3"
        with sqlite3.connect(database) as db:
            db.executescript("CREATE TABLE settings(id INTEGER PRIMARY KEY,data TEXT);"
                             "CREATE TABLE quotes(id TEXT PRIMARY KEY,title TEXT,updated_at TEXT,data TEXT);"
                             "CREATE TABLE calculator_states(id TEXT PRIMARY KEY,data TEXT,updated_at TEXT);"
                             "INSERT INTO settings VALUES(1,'original settings bytes');"
                             "INSERT INTO quotes VALUES('old','Original','date','original quote bytes');"
                             "INSERT INTO calculator_states VALUES('ductwork','original calculator bytes','date');"
                             "PRAGMA user_version=2;")
        db.close()
        upgraded = Store(database)
        upgraded.set_project_folder(self.folder)
        self.assertEqual(Store(database).project_folder(), str(self.folder))
        rows = database_rows(upgraded)
        self.assertEqual(rows["settings"], [(1, "original settings bytes")])
        self.assertEqual(rows["quotes"], [("old", "Original", "date", "original quote bytes")])
        self.assertEqual(rows["calculator_states"], [("ductwork", "original calculator bytes", "date")])
        with upgraded.connect() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)

    def test_cancel_and_invalid_snapshot_never_write_or_open_unnecessary_dialog(self):
        before = database_rows(self.store)
        self.assertEqual(self.library.save_as(self.request), {"cancelled": True})
        self.assertEqual(self.library.link_folder(), {"cancelled": True})
        calls = len(self.dialogs.calls)
        malformed = copy.deepcopy(self.request)
        malformed["calculators"]["steel_vermiculite"]["inputs"] = {"SCHEDULE": {"Z1009": "forged"}}
        with self.assertRaises(ValidationError):
            self.library.save_as(malformed)
        self.assertEqual(len(self.dialogs.calls), calls)
        self.assertEqual(database_rows(self.store), before)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_save_load_and_initial_link_preserve_complete_snapshot_and_other_storage(self):
        self.store.save_quote({"title": "Legacy quote", "inputs": {"B15": 17.25}})
        spray = baseline()["rate_groups"]["sprays"][1]["id"]
        self.store.save_configuration({"rates": {spray: {"price": 987.65}}})
        self.store.save_calculator_state("ductwork", {"CALCULATOR": {"B1010": "Existing local mark"}})
        before = database_rows(self.store)
        target = self.folder / "Project 17.ceasefire-project.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        result = self.library.save_as(self.request)
        self.assertFalse(result["cancelled"])
        self.assertTrue(result["file"]["in_linked_folder"])
        self.assertEqual(result["folder"], str(self.folder))
        self.assertEqual(self.dialogs.calls, [("save", None, "Project 17- A client.json")])
        self.assertEqual(json.loads(target.read_bytes()), json.loads(self.payload))
        self.assertEqual(result["project"]["estimate"]["id"], None)
        listing = self.library.listing()
        self.assertEqual(len(listing["files"]), 1)
        loaded = self.library.load(listing["files"][0]["id"])
        self.assertEqual(loaded["calculators"]["steel_vermiculite"]["inputs"]["SCHEDULE"]["AA1009"], "Last location")
        self.assertEqual(loaded["estimate"]["configuration"], result["project"]["estimate"]["configuration"])
        after = database_rows(self.store)
        for table in ("settings", "quotes", "calculator_states"):
            self.assertEqual(after[table], before[table])

    def test_link_persists_but_later_save_elsewhere_does_not_relink(self):
        self.dialogs.folder = str(self.folder)
        self.assertEqual(self.library.link_folder()["folder"], str(self.folder))
        outside = self.root / "Outside.json"
        self.dialogs.selection = SaveSelection(str(outside), None)
        result = self.library.save_as(self.request)
        self.assertFalse(result["file"]["in_linked_folder"])
        self.assertIsNone(result["file"]["id"])
        self.assertEqual(result["folder"], str(self.folder))
        self.assertEqual(self.dialogs.calls[-1][1], str(self.folder))
        self.assertEqual(Store(self.store.path).project_folder(), str(self.folder))
        self.assertEqual(self.library.listing()["files"], [])

    def test_save_overwrites_only_authorized_file_preserves_precision_and_rotates_capability(self):
        target = self.folder / "Existing.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        saved = self.library.save_as(self.request)
        before = database_rows(self.store)
        request = copy.deepcopy(self.request)
        request["estimate"]["inputs"]["B15"] = 432.123456789
        request["estimate"]["measurements"] = "Latest notes, stored exactly"
        request["calculators"] = {
            "steel_vermiculite": {"inputs": {"SCHEDULE": {"AA1009": "Last spray", "J1009": 12.3456789012345}}},
            "steel_board": {"inputs": {"CALCULATOR": {"F1008": 2.123456789}, "EXTRA BOARDS": {"A45": "Keep allowance"}}},
            "ductwork": {"inputs": {"CALCULATOR": {"D1010": 9.876543210987}, "PRODUCT SETTINGS": {"B97": 1.22}}},
        }
        original_request = copy.deepcopy(request)
        calls = len(self.dialogs.calls)
        overwrite = {**request, "save_token": saved["file"]["save_token"]}
        result = self.library.save(overwrite)
        snapshot = json.loads(target.read_bytes())
        self.assertEqual(len(self.dialogs.calls), calls)
        self.assertEqual(result["file"]["path"], str(target))
        self.assertEqual(snapshot["estimate"]["inputs"]["B15"], 432.123456789)
        self.assertEqual(snapshot["estimate"]["measurements"], request["estimate"]["measurements"])
        self.assertEqual(snapshot["estimate"]["configuration"], saved["project"]["estimate"]["configuration"])
        for name, calculator in request["calculators"].items():
            expected_inputs = calculator["inputs"]
            if name == "ductwork":
                # Canonicalize only the source example's Mixed orientation;
                # retain the precise late-row input and settings as supplied.
                expected_inputs = {**expected_inputs, "CALCULATOR": {**expected_inputs["CALCULATOR"], "I13": "Both"}}
            self.assertEqual(snapshot["calculators"][name]["inputs"], expected_inputs)
        self.assertEqual(request, original_request)
        self.assertNotEqual(result["file"]["save_token"], overwrite["save_token"])
        with self.assertRaisesRegex(ValidationError, "no longer available"):
            self.library.save(overwrite)
        self.assertEqual(database_rows(self.store), before)
        self.assertNotIn("save_token", self.library.listing()["files"][0])

    def test_project_attachments_require_saved_capability_and_never_overwrite(self):
        with self.assertRaisesRegex(ValidationError, 'There is no saved project'):
            self.library.save_attachment({"project_token": None, "filename": "scope.pdf", "content_base64": "QQ=="})
        target = self.folder / "Existing.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        saved = self.library.save_as(self.request)
        token = saved["file"]["save_token"]
        first = self.library.save_attachment({"project_token": token, "filename": "scope notes.txt",
                                              "content_base64": base64.b64encode(b"first").decode("ascii")})
        second = self.library.save_attachment({"project_token": token, "filename": "scope notes.txt",
                                               "content_base64": base64.b64encode(b"second").decode("ascii")})
        self.assertEqual((first["filename"], second["filename"]), ("scope notes.txt", "scope notes (1).txt"))
        self.assertEqual((self.folder / first["filename"]).read_bytes(), b"first")
        self.assertEqual((self.folder / second["filename"]).read_bytes(), b"second")
        self.assertEqual(target.read_bytes(), self.payload)

    def test_project_attachments_reject_paths_invalid_content_and_stale_projects(self):
        target = self.folder / "Existing.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        token = self.library.save_as(self.request)["file"]["save_token"]
        for filename in ("../outside.txt", "folder/file.txt", "CON.txt", "trailing. ", "bad?.txt"):
            with self.subTest(filename=filename), self.assertRaisesRegex(ValidationError, "valid filename"):
                self.library.save_attachment({"project_token": token, "filename": filename, "content_base64": "QQ=="})
        with self.assertRaisesRegex(ValidationError, "content is invalid"):
            self.library.save_attachment({"project_token": token, "filename": "safe.txt", "content_base64": "%%%"})
        target.write_text("changed outside the application", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "changed or was removed"):
            self.library.save_attachment({"project_token": token, "filename": "safe.txt", "content_base64": "QQ=="})
        self.assertFalse((self.folder / "safe.txt").exists())

    def test_older_browser_cannot_remove_saved_current_item_on_save_or_save_as(self):
        from estimator.penetration_calculator import definition
        current = copy.deepcopy(definition({})['defaults'])
        current['rows'][0]['inputs'].update(T='Keep my unscheduled item', O=2.123456789)
        schedule = {**copy.deepcopy(current), 'rows': []}
        request = {**copy.deepcopy(self.request), 'penetration': {'draft': schedule, 'composer': current}}
        target = self.folder / 'Schedule and current item.json'
        self.dialogs.selection = SaveSelection(str(target), None)
        saved = self.library.save_as(request)
        before = target.read_bytes()
        older = {**request, 'penetration': {'draft': schedule}}
        with self.assertRaisesRegex(ValidationError, 'Refresh the application'):
            self.library.save({**older, 'save_token': saved['file']['save_token']})
        self.assertEqual(target.read_bytes(), before)
        self.dialogs.selection = SaveSelection(str(target), file_fingerprint(target))
        with self.assertRaisesRegex(ValidationError, 'Refresh the application'):
            self.library.save_as(older)
        self.assertEqual(target.read_bytes(), before)
        # A complete current browser can still save the project, using the same
        # capability retained after the rejected incomplete write.
        current['rows'][0]['inputs']['O'] = 3.123456789
        receipt = self.library.save({**request, 'save_token': saved['file']['save_token']})
        self.assertEqual(receipt['project']['penetration']['composer']['rows'][0]['inputs']['O'], 3.123456789)
        self.assertEqual(receipt['project']['penetration']['draft']['rows'], [])

    def test_save_refuses_unknown_path_modified_deleted_or_replaced_target(self):
        target = self.folder / "Existing.json"
        target.write_bytes(self.payload)
        self.dialogs.opened = str(target)
        opened = self.library.open_file()
        request = {**self.request, "save_token": opened["file"]["save_token"]}
        before = database_rows(self.store)
        for invalid in ({**request, "path": str(target)}, {**request, "save_token": str(target)},
                        {**request, "save_token": None}, {**request, "calculators": {}}):
            with self.assertRaises(ValidationError):
                self.library.save(invalid)
        target.write_text("Changed externally", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "changed or was removed"):
            self.library.save(request)
        self.assertEqual(target.read_text(), "Changed externally")
        target.unlink()
        with self.assertRaisesRegex(ValidationError, "changed or was removed"):
            self.library.save(request)
        self.assertFalse(target.exists())
        self.assertEqual(database_rows(self.store), before)

    def test_save_failure_is_atomic_and_retains_target_for_retry(self):
        target = self.folder / "Existing.json"
        target.write_bytes(self.payload)
        self.dialogs.opened = str(target)
        opened = self.library.open_file()
        request = {**copy.deepcopy(self.request), "save_token": opened["file"]["save_token"]}
        request["estimate"]["measurements"] = "Retry me"
        with patch("estimator.project_library.os.replace", side_effect=PermissionError("locked")):
            with self.assertRaisesRegex(ValidationError, "could not be saved"):
                self.library.save(request)
        self.assertEqual(target.read_bytes(), self.payload)
        self.assertEqual([path.name for path in self.folder.iterdir()], [target.name])
        self.library.save(request)
        self.assertEqual(json.loads(target.read_bytes())["estimate"]["measurements"], "Retry me")

    def test_native_open_and_folder_load_authorize_only_the_selected_snapshot(self):
        target = self.root / "Outside.json"
        target.write_bytes(self.payload)
        before = database_rows(self.store)
        self.assertEqual(self.library.open_file(), {"cancelled": True})
        self.dialogs.opened = str(target)
        opened = self.library.open_file()
        self.assertEqual(opened["file"]["path"], str(target))
        self.assertIsNone(opened["file"]["id"])
        self.assertEqual(database_rows(self.store), before)
        self.library.save({**self.request, "save_token": opened["file"]["save_token"]})
        inside = self.folder / "Inside.json"
        inside.write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        loaded = self.library.load(self.library.listing()["files"][0]["id"])
        result = self.library.save({**self.request, "save_token": loaded["file"]["save_token"]})
        self.assertEqual(result["file"]["path"], str(inside))

    def test_simultaneous_saves_cannot_consume_one_capability_twice(self):
        target = self.folder / "Existing.json"
        target.write_bytes(self.payload)
        self.dialogs.opened = str(target)
        opened = self.library.open_file()
        request = {**self.request, "save_token": opened["file"]["save_token"]}
        original_export = export_project
        barrier = threading.Barrier(2)
        outcomes = []
        def prepare(*args):
            payload = original_export(*args)
            barrier.wait(timeout=30)
            return payload
        def save():
            try:
                outcomes.append(self.library.save(request))
            except Exception as error:
                outcomes.append(error)
        with patch("estimator.project_library.export_project", side_effect=prepare):
            workers = [threading.Thread(target=save) for _ in range(2)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=60)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(sum(isinstance(value, dict) for value in outcomes), 1, outcomes)
        self.assertEqual(sum(isinstance(value, ValidationError) for value in outcomes), 1, outcomes)
        self.assertEqual(json.loads(target.read_bytes()), json.loads(self.payload))

    def test_successful_file_save_is_reported_when_initial_folder_preference_fails(self):
        target = self.folder / "Saved.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        before = database_rows(self.store)
        with patch.object(self.store, "set_project_folder", side_effect=sqlite3.OperationalError("locked")):
            result = self.library.save_as(self.request)
        self.assertFalse(result["cancelled"])
        self.assertIn("saved", result["warning"])
        self.assertIsNone(result["folder"])
        self.assertFalse(result["file"]["in_linked_folder"])
        self.assertEqual(json.loads(target.read_bytes()), json.loads(self.payload))
        self.assertEqual(database_rows(self.store), before)

    def test_overwrite_requires_unchanged_confirmed_target_and_is_atomic_on_failure(self):
        target = self.folder / "Existing.json"
        target.write_bytes(self.payload)
        self.dialogs.selection = SaveSelection(str(target), file_fingerprint(target))
        target.write_text("Changed by another process", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "changed"):
            self.library.save_as(self.request)
        self.assertEqual(target.read_text(), "Changed by another process")
        self.dialogs.selection = SaveSelection(str(target), file_fingerprint(target))
        before = database_rows(self.store)
        with patch("estimator.project_library.os.replace", side_effect=PermissionError("locked")):
            with self.assertRaisesRegex(ValidationError, "could not be saved"):
                self.library.save_as(self.request)
        self.assertEqual(target.read_text(), "Changed by another process")
        self.assertEqual([path.name for path in self.folder.iterdir()], [target.name])
        self.assertEqual(database_rows(self.store), before)
        saved = self.library.save_as(self.request)
        self.assertFalse(saved["cancelled"])
        self.assertEqual(json.loads(target.read_bytes()), json.loads(self.payload))

    def test_new_target_appearing_during_write_is_not_overwritten(self):
        target = self.folder / "Collision.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        original_fsync = os.fsync
        def collision(descriptor):
            original_fsync(descriptor)
            target.write_text("Someone else's file", encoding="utf-8")
        with patch("estimator.project_library.os.fsync", side_effect=collision):
            with self.assertRaisesRegex(ValidationError, "changed"):
                self.library.save_as(self.request)
        self.assertEqual(target.read_text(), "Someone else's file")
        self.assertIsNone(self.store.project_folder())
        self.assertEqual([path.name for path in self.folder.iterdir()], [target.name])

    def test_listing_errors_limits_unavailable_folder_and_opaque_ids(self):
        (self.folder / "valid.json").write_bytes(self.payload)
        (self.folder / "broken.json").write_text('{"format":"ceasefire-project","version":1}', encoding="utf-8")
        (self.folder / "ignored.txt").write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        listing = self.library.listing()
        self.assertEqual([item["name"] for item in listing["files"]], ["valid.json"])
        self.assertEqual([item["name"] for item in listing["errors"]], ["broken.json"])
        identifier = listing["files"][0]["id"]
        for value in ("../valid.json", str(self.folder / "valid.json"), "0" * 64, [], None):
            with self.assertRaises(ValidationError):
                self.library.load(value)
        with patch("estimator.project_library.MAX_PROJECT_FILES", 1):
            self.assertTrue(self.library.listing(refresh=True)["scan_pending"])
        with patch("estimator.project_library.MAX_LIST_BYTES", 1):
            self.library._cache.clear()
            self.assertTrue(self.library.listing(refresh=True)["scan_pending"])
        other = self.root / "Other"
        other.mkdir()
        (other / "valid.json").write_bytes(self.payload)
        self.store.set_project_folder(other)
        with self.assertRaises(ValidationError):
            self.library.load(identifier)
        self.store.set_project_folder(self.root / "missing")
        self.assertEqual(len(self.library.listing()["errors"]), 1)

    def test_scan_ignores_unrelated_json_without_using_names_or_nested_markers(self):
        unrelated = {
            "CEASEFIRE Project.json": b'{}',
            "export.json": b'{"format":"exporter-data","estimate":{"title":"Export"}}',
            "array.json": b'[{"format":"ceasefire-project"}]',
            "nested.json": b'{"export":{"format":"ceasefire-project"}}',
            "text.json": b'"format: ceasefire-project"',
            "number.json": b'12.5',
            "true.json": b'true',
            "null.json": b'null',
            "malformed.json": b'{"export":',
            "prose.json": b'not JSON {"format":"ceasefire-project"}',
            "encoding.json": b'\xffbroken',
            "deep-export.json": b'{"data":' + b'[' * 1100 + b'0' + b']' * 1100 + b'}',
        }
        for name, payload in unrelated.items():
            (self.folder / name).write_bytes(payload)
        (self.folder / "arbitrary-name.json").write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        from estimator.project_file import project_summary
        with patch("estimator.project_library.project_summary", wraps=project_summary) as summary, patch("estimator.project_library.load_project_bytes", side_effect=AssertionError("Listing recalculated a project")):
            listing = self.library.listing()
        self.assertEqual([item["name"] for item in listing["files"]], ["arbitrary-name.json"])
        self.assertEqual(listing["errors"], [])
        self.assertEqual(listing["scanned_files"], len(unrelated) + 1)
        self.assertEqual(summary.call_count, 1)
        self.assertFalse(listing["scan_pending"])

    def test_recognized_project_errors_remain_strict_and_unrelated_manual_open_fails(self):
        invalid = {
            "version.json": b'{"format":"ceasefire-project","version":999}',
            "missing-fields.json": b'{"format":"ceasefire-project","version":1}',
            "truncated.json": b'{"format":"ceasefire-project","version":',
            "duplicate.json": b'{"format":"exporter","format":"ceasefire-project","version":1}',
            "nonfinite.json": b'{"format":"ceasefire-project","number":NaN}',
            "overflow.json": b'{"format":"ceasefire-project","number":1e999}',
            "encoding.json": b'{"format":"ceasefire-project","value":"\xff"}',
            "nested.json": b'{"format":"ceasefire-project","data":' + b'[' * 40 + b'0' + b']' * 40 + b'}',
            "escaped-marker.json": b'{"for\\u006dat":"ceasefire-\\u0070roject","version":',
        }
        for name, payload in invalid.items():
            (self.folder / name).write_bytes(payload)
        self.store.set_project_folder(self.folder)
        listing = self.library.listing()
        self.assertEqual(listing["files"], [])
        self.assertEqual({item["name"] for item in listing["errors"]}, set(invalid))
        self.assertEqual(listing["scanned_files"], len(invalid))
        target = self.folder / "unrelated.json"
        before = database_rows(self.store)
        for payload in (b'{}', b'{"format":"exporter"}', b'{'):
            target.write_bytes(payload)
            self.dialogs.opened = str(target)
            with self.assertRaises(ValidationError):
                self.library.open_file()
        self.assertEqual(database_rows(self.store), before)

    def test_ignored_files_refresh_into_projects_and_known_corruption_is_not_hidden(self):
        target = self.folder / "changing.json"
        target.write_bytes(b'{"format":"exporter"}')
        self.store.set_project_folder(self.folder)
        from estimator.project_library import _read_file
        with patch("estimator.project_library._read_file", wraps=_read_file) as read:
            self.assertEqual(self.library.listing()["errors"], [])
            self.assertEqual(self.library.listing(refresh=True)["files"], [])
            self.assertEqual(read.call_count, 1)
            target.write_bytes(self.payload)
            listed = self.library.listing(refresh=True)
            self.assertEqual([item["name"] for item in listed["files"]], [target.name])
            self.assertEqual(read.call_count, 2)
            target.write_bytes(b'{')
            for expected_reads in (3, 4):
                broken = self.library.listing(refresh=True)
                self.assertEqual([item["name"] for item in broken["errors"]], [target.name])
                self.assertEqual(broken["files"], [])
                self.assertEqual(read.call_count, expected_reads)
            target.write_bytes(b'{"format":"different-export"}')
            unrelated = self.library.listing(refresh=True)
            self.assertEqual((unrelated["files"], unrelated["errors"]), ([], []))
            target.write_bytes(b'{')
            self.assertEqual(self.library.listing(refresh=True)["errors"], [])
            target.write_bytes(self.payload)
            self.assertEqual(len(self.library.listing(refresh=True)["files"]), 1)
            for foreign in (
                b'{"format":"different-export","value":' + b'[' * 40 + b'0' + b']' * 40 + b'}',
                b'{"format":"different-export","value":1e999}',
                b'{"format":"different-export","value":1,"value":2}',
            ):
                target.write_bytes(foreign)
                unrelated = self.library.listing(refresh=True)
                self.assertEqual((unrelated["files"], unrelated["errors"]), ([], []))
                target.write_bytes(self.payload)
                self.assertEqual(len(self.library.listing(refresh=True)["files"]), 1)
        target.unlink()
        self.assertEqual(self.library.listing(refresh=True)["files"], [])
        self.assertEqual(self.library._cache, {})
        target.write_bytes(b'{')
        self.assertEqual(self.library.listing(refresh=True)["errors"], [])

    def test_oversized_scan_reads_one_bounded_prefix_and_charges_each_read(self):
        (self.folder / "unrelated.json").write_bytes(b'{"export":"' + b'x' * 1000 + b'"}')
        (self.folder / "project.json").write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        from estimator.project_library import _read_file
        read_sizes = []
        def bounded_read(*args, **kwargs):
            result = _read_file(*args, **kwargs)
            read_sizes.append(len(result[0]))
            return result
        with patch("estimator.project_library.MAX_PROJECT_FILE", 256), patch("estimator.project_library.MAX_LIST_BYTES", 513), patch("estimator.project_library._read_file", side_effect=bounded_read):
            first = self.library.listing()
            self.assertTrue(first["scan_pending"])
            self.assertEqual(first["scanned_files"], 1)
            for _ in range(5):
                listing = self.library.listing()
                if not listing["scan_pending"]:
                    break
            self.assertFalse(listing["scan_pending"])
            self.assertEqual(read_sizes, [257, 257])
            self.assertEqual(listing["files"], [])
            self.assertEqual([item["name"] for item in listing["errors"]], ["project.json"])
            self.assertIn("16 MB", listing["errors"][0]["error"])
            self.assertEqual(listing["scanned_files"], 2)

    def test_ignored_json_still_counts_toward_scan_batch_limits(self):
        for number in range(7):
            (self.folder / f"export-{number}.json").write_bytes(b'{}')
        (self.folder / "project.json").write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        with patch("estimator.project_library.MAX_PROJECT_FILES", 2), patch("estimator.project_library.MAX_SCAN_ENTRIES", 3):
            for calls in range(10):
                listing = self.library.listing()
                if not listing["scan_pending"]:
                    break
        self.assertGreater(calls, 1)
        self.assertFalse(listing["scan_pending"])
        self.assertEqual(listing["scanned_files"], 8)
        self.assertEqual([item["name"] for item in listing["files"]], ["project.json"])
        self.assertEqual(listing["errors"], [])

    def test_loading_revalidates_changed_source_and_file_size(self):
        target = self.folder / "valid.json"
        target.write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        identifier = self.library.listing()["files"][0]["id"]
        changed = json.loads(self.payload)
        changed["calculators"]["ductwork"]["source_sha256"] = "other source"
        target.write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "different calculator source"):
            self.library.load(identifier)
        with patch("estimator.project_library.MAX_PROJECT_FILE", 100):
            with self.assertRaisesRegex(ValidationError, "16 MB"):
                self.library.load(identifier)

    def test_reparse_files_and_directories_are_rejected(self):
        target = self.folder / "valid.json"
        target.write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        original_lstat = Path.lstat
        for linked in (target, self.folder):
            def reparse(path, *args, **kwargs):
                info = original_lstat(path, *args, **kwargs)
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400, st_size=info.st_size) if path == linked else info
            with patch.object(Path, "lstat", reparse):
                listing = self.library.listing(refresh=True)
                self.assertEqual(listing["files"], [])
                self.assertEqual(len(listing["errors"]), 1)
                self.dialogs.folder = str(self.folder)
                if linked == self.folder:
                    with self.assertRaisesRegex(ValidationError, "symbolic link or junction"):
                        self.library.link_folder()
                else:
                    self.dialogs.selection = SaveSelection(str(target), None)
                    with self.assertRaisesRegex(ValidationError, "not links"):
                        self.library.save_as(self.request)

    def test_dialog_lock_and_native_adapter_do_not_invoke_shell_or_accept_bad_results(self):
        with _DIALOG_LOCK:
            with self.assertRaisesRegex(ValidationError, "open file dialog"):
                self.library.link_folder()
        self.assertEqual(self.dialogs.calls, [])
        native = NativeDialogs()
        with patch("estimator.native_dialogs.subprocess.run", return_value=SimpleNamespace(stdout='null')) as run:
            self.assertIsNone(native.choose_save(str(self.folder), '$(bad); title.json'))
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertEqual(json.loads(run.call_args.kwargs["input"])["filename"], '$(bad); title.json')
            self.assertNotIn('$(bad)', ' '.join(run.call_args.args[0]))
        with patch("estimator.native_dialogs.subprocess.run", side_effect=subprocess.TimeoutExpired("dialog", 600)):
            with self.assertRaisesRegex(ValidationError, "native file dialog"):
                native.choose_folder()
        with patch("estimator.native_dialogs.subprocess.run", return_value=SimpleNamespace(stdout=json.dumps({"path": str(self.folder / "Selected.json")}))) as run:
            self.assertEqual(native.choose_open(str(self.folder)), str(self.folder / "Selected.json"))
            self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"kind": "open", "directory": str(self.folder)})
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_filename_sanitization_retains_names_without_paths_or_header_injection(self):
        self.assertEqual(project_filename("CON"), "_CON.json")
        self.assertEqual(project_filename('  A/B: quote?  '), "A-B- quote-.json")
        filename = project_filename('A\r\n"é/quote')
        header = project_download_header(filename)
        self.assertNotIn("\r", header)
        self.assertNotIn("\n", header)
        self.assertIn("filename*=UTF-8''A---%C3%A9-quote", header)
        self.assertLessEqual(len(project_filename("😀" * 400).encode("utf-16-le")) // 2, 255)

    def test_recursive_duplicate_filenames_search_sort_pagination_and_nested_save(self):
        for directory in (self.folder / "2025", self.folder / "2026" / "Client"):
            directory.mkdir(parents=True)
            (directory / "Same quote.json").write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        listing = self.library.listing(sort="name_asc", limit=1)
        self.assertEqual((listing["total"], listing["matched"], len(listing["files"])), (2, 2, 1))
        first = listing["files"][0]
        second = self.library.listing(sort="name_asc", limit=1, offset=1)["files"][0]
        self.assertEqual(first["relative_path"], "2025/Same quote.json")
        self.assertEqual(second["relative_folder"], "2026/Client")
        self.assertNotEqual(first["id"], second["id"])
        for entry in (first, second):
            loaded = self.library.load(entry["id"])
            self.assertEqual(loaded["file"]["relative_path"], entry["relative_path"])
            self.assertTrue(Path(loaded["file"]["path"]).is_absolute())
        searched = self.library.listing(search="2026/client", sort="modified_asc")
        self.assertEqual([item["id"] for item in searched["files"]], [second["id"]])
        self.dialogs.selection = SaveSelection(str(self.folder / "2026" / "New quote.json"), None)
        saved = self.library.save_as(self.request)
        self.assertTrue(saved["file"]["in_linked_folder"])
        self.assertEqual(saved["file"]["relative_path"], "2026/New quote.json")
        self.assertEqual(self.library.load(saved["file"]["id"])["file"]["relative_path"], "2026/New quote.json")

    def test_scan_budgets_continue_until_every_descendant_is_discovered(self):
        for number in range(7):
            directory = self.folder / str(number)
            directory.mkdir()
            (directory / "Quote.json").write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        with patch("estimator.project_library.MAX_PROJECT_FILES", 2), patch("estimator.project_library.MAX_SCAN_ENTRIES", 3), patch("estimator.project_library.MAX_LIST_BYTES", len(self.payload) + 1):
            for calls in range(30):
                listing = self.library.listing()
                if not listing["scan_pending"]:
                    break
            self.assertGreater(calls, 1)
            self.assertFalse(listing["scan_pending"])
            self.assertEqual(listing["total"], 7)
            self.assertEqual(len({item["id"] for item in listing["files"]}), 7)
            self.assertEqual(listing["errors"], [])

    def test_metadata_cache_avoids_calculation_and_rereads_only_changed_files(self):
        target = self.folder / "Quote.json"
        target.write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        from estimator.project_library import _read_file
        with patch("estimator.project_library._read_file", wraps=_read_file) as read, patch("estimator.project_library.load_project_bytes", side_effect=AssertionError("Listing recalculated a project")):
            first = self.library.listing()
            self.assertEqual(read.call_count, 1)
            self.assertTrue(self.library.listing(search="client")["cached"])
            self.library.listing(refresh=True)
            self.assertEqual(read.call_count, 1)
            changed = json.loads(self.payload)
            changed["estimate"]["title"] = "Changed project"
            target.write_text(json.dumps(changed), encoding="utf-8")
            self.assertEqual(self.library.listing(refresh=True)["files"][0]["title"], "Changed project")
            self.assertEqual(read.call_count, 2)
        target.unlink()
        self.assertEqual(self.library.listing(refresh=True)["files"], [])
        with self.assertRaises(ValidationError):
            self.library.load(first["files"][0]["id"])

    def test_deferred_file_replaced_by_directory_does_not_repeat_forever(self):
        for name in ("First.json", "Second.json"):
            (self.folder / name).write_bytes(self.payload)
        self.store.set_project_folder(self.folder)
        with patch("estimator.project_library.MAX_LIST_BYTES", len(self.payload) + 1):
            self.assertTrue(self.library.listing()["scan_pending"])
            deferred = self.library._scan["deferred"]
            self.assertIsNotNone(deferred)
            deferred.unlink()
            deferred.mkdir()
            (deferred / "Nested.json").write_bytes(self.payload)
            for _ in range(10):
                listing = self.library.listing()
                if not listing["scan_pending"]:
                    break
            self.assertFalse(listing["scan_pending"])
            self.assertEqual(listing["total"], 2)
            self.assertIn(deferred.name + "/Nested.json", [item["relative_path"] for item in listing["files"]])

    def test_cloud_placeholders_are_allowed_but_name_redirection_is_not(self):
        regular = 0o100644
        for variant in range(16):
            self.assertFalse(_linked(SimpleNamespace(st_mode=regular, st_file_attributes=0x400, st_reparse_tag=0x9000001A | (variant << 12))))
        for tag in (0, 0xA0000003, 0xA000000C, 0x80000021, 0x9000001C):
            self.assertTrue(_linked(SimpleNamespace(st_mode=regular, st_file_attributes=0x400, st_reparse_tag=tag)))
        self.assertTrue(_linked(SimpleNamespace(st_mode=0o120777)))

    def test_bad_pagination_arguments_and_unreadable_subfolder_are_reported(self):
        for arguments in ({"limit": 0}, {"limit": 201}, {"offset": -1}, {"offset": "../x"}, {"sort": "bad"}, {"refresh": "yes"}):
            with self.assertRaises(ValidationError):
                self.library.listing(**arguments)
        directory = self.folder / "Unavailable"
        directory.mkdir()
        self.store.set_project_folder(self.folder)
        scandir = os.scandir
        def unreadable(path):
            if path == directory:
                raise PermissionError("Access denied")
            return scandir(path)
        with patch("estimator.project_library.os.scandir", side_effect=unreadable):
            listing = self.library.listing()
        self.assertFalse(listing["scan_pending"])
        self.assertEqual(listing["errors"], [{"name": "Unavailable", "error": "Access denied"}])


class ProjectLibraryApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "state.sqlite3")
        self.dialogs = Chooser()
        self.server = create_server(0, self.store.path, self.dialogs)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=60)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_native_routes_cancel_validate_methods_and_origins_without_writes(self):
        before = database_rows(self.store)
        self.assertEqual(self.request("GET", "/api/projects")[1]["folder"], None)
        self.assertEqual(self.request("POST", "/api/projects/link-folder", {}), (200, {"cancelled": True}))
        self.assertEqual(self.request("POST", "/api/project/save-as", {"estimate": {}}), (200, {"cancelled": True}))
        self.assertEqual(self.request("POST", "/api/project/open", {}), (200, {"cancelled": True}))
        calls = len(self.dialogs.calls)
        for method, route, body in (("GET", "/api/projects/link-folder", None), ("PUT", "/api/project/save-as", {"estimate": {}}),
                                    ("POST", "/api/projects/link-folder", {"path": str(self.root)}),
                                    ("POST", "/api/project/open", {"path": str(self.root / "file.json")}),
                                    ("PUT", "/api/project/open", {}),
                                    ("GET", "/api/project/save", None),
                                    ("POST", "/api/project/save", {"path": str(self.root / "file.json"), "estimate": {}}),
                                    ("POST", "/api/projects/load", {"path": "../file.json"})):
            self.assertGreaterEqual(self.request(method, route, body)[0], 400)
        self.assertEqual(self.request("POST", "/api/project/save-as", {"estimate": {}}, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/project/open", {}, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/project/save", {}, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/projects/link-folder", {}, {"Host": "evil.example"})[0], 403)
        self.assertEqual(len(self.dialogs.calls), calls)
        self.assertEqual(database_rows(self.store), before)

    def test_full_native_save_folder_list_and_load_preserve_storage(self):
        target = self.root / "Saved.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        before = database_rows(self.store)
        status, saved = self.request("POST", "/api/project/save-as", {"estimate": {"project_no": "Saved native"}})
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["project"]["estimate"]["project_no"], "Saved native")
        status, listing = self.request("GET", "/api/projects")
        self.assertEqual(status, 200)
        status, loaded = self.request("POST", "/api/projects/load", {"id": listing["files"][0]["id"]})
        self.assertEqual(status, 200, loaded)
        self.assertEqual(loaded["estimate"]["configuration"], saved["project"]["estimate"]["configuration"])
        for table in ("settings", "quotes", "calculator_states"):
            self.assertEqual(database_rows(self.store)[table], before[table])

    def test_project_attachment_route_uses_saved_project_capability(self):
        target = self.root / "Saved.json"
        self.dialogs.selection = SaveSelection(str(target), None)
        status, saved = self.request("POST", "/api/project/save-as", {"estimate": {"project_no": "Attachment target"}})
        self.assertEqual(status, 200, saved)
        status, attachment = self.request("POST", "/api/project/attachment", {
            "project_token": saved["file"]["save_token"], "filename": "inspection photo.jpg",
            "content_base64": base64.b64encode(b"image bytes").decode("ascii"),
        })
        self.assertEqual(status, 200, attachment)
        self.assertEqual(attachment["filename"], "inspection photo.jpg")
        self.assertEqual((self.root / "inspection photo.jpg").read_bytes(), b"image bytes")
        self.assertEqual(self.request("POST", "/api/project/attachment", {
            "project_token": None, "filename": "no-project.txt", "content_base64": "QQ==",
        })[0], 400)

    def test_project_pricing_preview_is_read_only_and_validates_configuration(self):
        before = database_rows(self.store)
        status, response = self.request("POST", "/api/configuration/preview", {"configuration": {"inventory": {}, "rates": {}}})
        self.assertEqual(status, 200)
        self.assertIn("fields", response)
        self.assertEqual(response["configuration"], {"inventory": {}, "rates": {}})
        self.assertEqual(self.request("POST", "/api/configuration/preview", {"configuration": {"rates": {"missing": {"price": 1}}}})[0], 400)
        self.assertEqual(self.request("POST", "/api/configuration/preview", {"configuration": {}, "path": "bad"})[0], 400)
        self.assertEqual(database_rows(self.store), before)

    def test_native_open_and_save_http_preserve_complete_state_without_exposing_path_writes(self):
        target = self.root / "Selected.json"
        payload = export_project(self.store, {"estimate": {"project_no": "Native target"}})
        target.write_bytes(payload)
        self.dialogs.opened = str(target)
        before = database_rows(self.store)
        status, loaded = self.request("POST", "/api/project/open", {})
        self.assertEqual(status, 200, loaded)
        token = loaded["file"]["save_token"]
        snapshot = json.loads(payload)
        body = {"save_token": token, "estimate": snapshot["estimate"],
                "calculators": {name: {"inputs": value["inputs"]} for name, value in snapshot["calculators"].items()}}
        body["estimate"]["inputs"]["B15"] = 234.567890123
        status, saved = self.request("POST", "/api/project/save", body)
        self.assertEqual(status, 200, saved)
        self.assertNotEqual(saved["file"]["save_token"], token)
        self.assertEqual(json.loads(target.read_bytes())["estimate"]["inputs"]["B15"], 234.567890123)
        self.assertEqual(self.request("POST", "/api/project/save", body)[0], 400)
        status, imported = self.request("POST", "/api/project/import", {
            "filename": "Selected.json", "content_base64": base64.b64encode(payload).decode("ascii")})
        self.assertEqual(status, 200, imported)
        self.assertNotIn("file", imported)
        self.assertNotIn("save_token", imported)
        self.assertEqual(database_rows(self.store), before)

    def test_recursive_search_and_page_query_options_are_validated(self):
        parent = self.root / "Estimates"
        nested = parent / "Client work"
        nested.mkdir(parents=True)
        payload = export_project(self.store, {"estimate": {"project_no": "P27", "client": "Example client"}})
        (parent / "Quote.json").write_bytes(payload)
        (nested / "Quote.json").write_bytes(payload)
        self.store.set_project_folder(parent)
        status, response = self.request("GET", "/api/projects?search=Client%20work&sort=name_asc&offset=0&limit=1&refresh=1")
        self.assertEqual(status, 200, response)
        self.assertEqual((response["total"], response["matched"], len(response["files"])), (2, 1, 1))
        self.assertEqual(response["files"][0]["relative_path"], "Client work/Quote.json")
        for suffix in ("?path=x", "?limit=1&limit=2", "?limit=201", "?offset=-1", "?sort=wrong", "?refresh=yes"):
            self.assertEqual(self.request("GET", "/api/projects" + suffix)[0], 400, suffix)


if __name__ == "__main__":
    unittest.main()
