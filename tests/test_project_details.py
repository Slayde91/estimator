import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.project_details import ProjectDetails, MAX_NUMBER, _process_status, numbers
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from tests.test_project_library import Chooser


def captured(number="forged", identity=None):
    value = {"estimate": {"project_no": number, "client": "Client"}}
    if identity:
        value["certifications"] = {"project_id": identity}
    return value


class NumberJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = self.service_at()

    def service_at(self):
        service = ProjectDetails(self.root / "numbers.sqlite3")
        self.addCleanup(service.close)
        return service

    def begin(self, project=None, service=None):
        identifier = str(uuid4())
        ticket = (service or self.service).begin(identifier, project or captured())
        return identifier, ticket

    def complete(self, identifier, service=None):
        service = service or self.service
        path = self.root / (identifier + ".cf.json")
        payload = b'{"durably":"saved"}'
        service.prepare(identifier, path, payload)
        path.write_bytes(payload)
        service.finish(identifier)
        return path

    def test_new_settings_validate_and_never_recycle_successful_assignments(self):
        self.assertEqual(self.service.settings()["next_reference"], "PN-01")
        identifier, ticket = self.begin()
        self.assertEqual(json.loads(ticket["numbers_json"]), {"estimate-1": "PN-01"})
        self.complete(identifier)
        self.assertEqual(self.service.save_settings({"prefix": " pn ", "start_number": 1})["next_reference"], "PN-02")
        self.assertEqual(self.service.save_settings({"prefix": "AB", "start_number": 101})["next_reference"], "AB-101")
        self.assertEqual(self.service.save_settings({"prefix": "PN", "start_number": 1})["next_reference"], "PN-02")
        for invalid in ({"prefix": "../PN", "start_number": 1}, {"prefix": "PN", "start_number": True},
                        {"prefix": "PN", "start_number": 0}, {"prefix": "PN", "start_number": 1.5},
                        {"prefix": "PN", "start_number": 1000000000}, {"prefix": "PN", "start_number": 1, "path": "evil"}):
            with self.assertRaises(ValidationError):
                self.service.save_settings(invalid)

    def test_legacy_database_starts_short_series_without_rewriting_journal_or_owner(self):
        path = self.root / 'legacy.sqlite3'
        identifier = str(uuid4())
        project = captured('PN-00004', 'legacy-project')
        digest = hashlib.sha256(json.dumps(project, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        assignment = json.dumps({'estimate-1': 'PN-00004'})
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript("""CREATE TABLE preferences(id INTEGER PRIMARY KEY,prefix TEXT,start_number INTEGER);
                INSERT INTO preferences VALUES(1,'PN',1);
                CREATE TABLE sequences(prefix TEXT PRIMARY KEY,next_number INTEGER);
                INSERT INTO sequences VALUES('PN',5);
                CREATE TABLE occupied(number TEXT PRIMARY KEY);
                INSERT INTO occupied VALUES('pn-00004');
                CREATE TABLE identities(owner TEXT PRIMARY KEY,numbers_json TEXT,automatic INTEGER);
                CREATE TABLE saves(id TEXT PRIMARY KEY,owner TEXT,digest TEXT,numbers_json TEXT,state TEXT,path TEXT,
                    payload_hash TEXT,pid INTEGER,instance TEXT,created REAL,process_token TEXT);""")
            db.execute('INSERT INTO identities VALUES(?,?,1)', ('project:legacy-project', assignment))
            db.execute('INSERT INTO saves VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (identifier, 'project:legacy-project', digest, assignment, 'saved', 'unchanged.cf.json', 'original-hash', 0, 'old-instance', 12.0, None))
            previous = tuple(db.execute('SELECT * FROM saves').fetchone())
        upgraded = ProjectDetails(path)
        self.addCleanup(upgraded.close)
        self.assertEqual(upgraded.settings()['next_reference'], 'PN-01')
        with upgraded.connect() as db:
            self.assertEqual(tuple(db.execute('SELECT * FROM saves WHERE id=?', (identifier,)).fetchone())[:-1], previous)
            self.assertEqual(db.execute("SELECT next_number FROM sequences WHERE prefix='PN'").fetchone()[0], 5)
        self.assertTrue(upgraded.begin(identifier, project)['replay'])
        old_copy_id, old_copy = self.begin(captured('forged', 'legacy-project'), upgraded)
        self.assertEqual(json.loads(old_copy['numbers_json'])['estimate-1'], 'PN-00004')
        upgraded.cancel(old_copy_id)
        new_id, ticket = self.begin(service=upgraded)
        self.assertEqual(json.loads(ticket['numbers_json'])['estimate-1'], 'PN-01')
        self.complete(new_id, upgraded)
        restarted = ProjectDetails(path)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.settings()['next_reference'], 'PN-02')

    def test_observed_compact_numbers_advance_only_the_short_series(self):
        self.service.observe(['PN-00004', 'PN-02', 'pn-3'])
        self.assertEqual(self.service.settings()['next_reference'], 'PN-04')
        identifier, ticket = self.begin()
        self.assertEqual(json.loads(ticket['numbers_json'])['estimate-1'], 'PN-04')
        self.complete(identifier)
        self.assertEqual(self.service_at().settings()['next_reference'], 'PN-05')

    def test_upgrade_seeds_existing_compact_import_history_once(self):
        path = self.root / 'compact-history.sqlite3'
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript("""CREATE TABLE occupied(number TEXT PRIMARY KEY);
                INSERT INTO occupied VALUES('pn-07');
                INSERT INTO occupied VALUES('pn-00007');
                CREATE TABLE sequences(prefix TEXT PRIMARY KEY,next_number INTEGER);
                INSERT INTO sequences VALUES('PN',8);""")
        upgraded = ProjectDetails(path)
        self.addCleanup(upgraded.close)
        self.assertEqual(upgraded.settings()['next_reference'], 'PN-08')
        with upgraded.connect() as db:
            self.assertEqual([row[0] for row in db.execute('SELECT number FROM occupied ORDER BY number')], ['pn-00007', 'pn-07'])
            self.assertEqual(db.execute("SELECT next_number FROM sequences WHERE prefix='PN'").fetchone()[0], 8)
        restarted = ProjectDetails(path)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.settings()['next_reference'], 'PN-08')

    def test_short_series_skips_legacy_highwater_when_formats_overlap(self):
        self.service.observe(['PN-10004'])
        self.assertEqual(self.service.settings()['next_reference'], 'PN-01')
        self.service.save_settings({'prefix': 'PN', 'start_number': 9999})
        identifier, ticket = self.begin()
        self.assertEqual(json.loads(ticket['numbers_json'])['estimate-1'], 'PN-9999')
        self.complete(identifier)
        self.assertEqual(self.service.settings()['next_reference'], 'PN-10005')
        first, ticket = self.begin()
        self.assertEqual(json.loads(ticket['numbers_json'])['estimate-1'], 'PN-10005')
        second, other = self.begin()
        self.assertEqual(json.loads(other['numbers_json'])['estimate-1'], 'PN-10006')
        self.complete(first)
        self.service.cancel(second)
        self.assertEqual(self.service_at().settings()['next_reference'], 'PN-10006')

    def test_exhausted_overlap_keeps_settings_editable_and_preserves_legacy_counter(self):
        self.service.observe([f'PN-{MAX_NUMBER}'])
        self.assertEqual(self.service.settings()['next_reference'], 'PN-01')
        value = self.service.save_settings({'prefix': 'PN', 'start_number': MAX_NUMBER})
        self.assertTrue(value['exhausted'])
        self.assertEqual(value['next_reference'], '')
        with self.assertRaisesRegex(ValidationError, 'number limit'):
            self.begin()
        self.assertEqual(self.service.save_settings({'prefix': 'NEW', 'start_number': 1})['next_reference'], 'NEW-01')

    def test_uncertain_prepared_short_number_retains_highwater_beyond_overlap(self):
        self.service.save_settings({'prefix': 'PN', 'start_number': 10000})
        identifier, ticket = self.begin()
        self.assertEqual(json.loads(ticket['numbers_json'])['estimate-1'], 'PN-10000')
        self.service.prepare(identifier, self.root / 'uncertain.cf.json', b'not confirmed')
        self.service.close()
        restarted = self.service_at()
        restarted.recover(lambda path: (Path(path).read_bytes(), None))
        self.assertEqual(restarted.save_settings({'prefix': 'PN', 'start_number': 1})['next_reference'], 'PN-10001')
        with self.assertRaisesRegex(ValidationError, 'number has been retained'):
            restarted.begin(identifier, captured())

    def test_cancel_releases_reservation_but_completed_save_retry_is_idempotent(self):
        identifier, _ = self.begin()
        self.service.cancel(identifier)
        identifier, ticket = self.begin()
        self.assertEqual(json.loads(ticket["numbers_json"])["estimate-1"], "PN-01")
        path = self.complete(identifier)
        path.unlink()  # Removing a project must never release its assigned number.
        replay = self.service.begin(identifier, captured())
        self.assertTrue(replay["replay"])
        self.assertEqual(replay["numbers_json"], ticket["numbers_json"])
        with self.assertRaisesRegex(ValidationError, "different project"):
            self.service.begin(identifier, captured("changed"))
        self.assertEqual(self.service.settings()["next_number"], 2)

    def test_parallel_service_instances_reserve_unique_numbers(self):
        services = [self.service_at() for _ in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            tickets = list(pool.map(lambda service: self.begin(service=service), services))
        assigned = [json.loads(ticket["numbers_json"])["estimate-1"] for _, ticket in tickets]
        self.assertEqual(set(assigned), {f"PN-{value:02d}" for value in range(1, 9)})
        for (identifier, _), service in zip(tickets, services):
            self.complete(identifier, service)
        self.assertEqual(self.service.settings()["next_reference"], "PN-09")

    def test_live_chooser_never_expires_and_duplicate_request_cannot_allocate_twice(self):
        identifier, _ = self.begin(captured(identity="same-project"))
        with self.service.connect() as db:
            db.execute("UPDATE saves SET created=0 WHERE id=?", (identifier,))
        self.service_at().recover(lambda path: self.fail("A live chooser must not be read"))
        with self.assertRaisesRegex(ValidationError, "still running"):
            self.service.begin(identifier, captured(identity="same-project"))
        with self.assertRaisesRegex(ValidationError, "in progress"):
            self.begin(captured(identity="same-project"))
        self.assertEqual(self.service.settings()["next_number"], 2)

    def test_crash_after_replace_recovers_and_ambiguous_prepared_number_is_retired(self):
        identifier, _ = self.begin()
        completed = self.root / "completed.cf.json"
        self.service.prepare(identifier, completed, b"completed")
        completed.write_bytes(b"completed")
        pending, _ = self.begin()
        self.service.prepare(pending, self.root / "not-written.cf.json", b"never written")
        reserved, _ = self.begin()
        self.service.close()
        restarted = self.service_at()
        restarted.recover(lambda path: (Path(path).read_bytes(), None))
        self.assertTrue(restarted.begin(identifier, captured())["replay"])
        self.assertEqual(restarted.settings()["next_reference"], "PN-03")
        with self.assertRaisesRegex(ValidationError, "number has been retained"):
            restarted.begin(pending, captured())
        self.assertEqual(json.loads(restarted.begin(reserved, captured())["numbers_json"])["estimate-1"], "PN-03")

    def test_external_replacement_after_crash_cannot_recycle_number_outside_library(self):
        identifier, _ = self.begin()
        target = self.root / "outside-any-linked-folder.cf.json"
        self.service.prepare(identifier, target, b'{"project_no":"PN-01"}')
        target.write_bytes(b'{"project_no":"PN-01"}')
        self.service.close()
        target.write_bytes(b'{"project_no":"PN-01","client":"external edit"}')
        restarted = self.service_at()
        restarted.recover(lambda path: (Path(path).read_bytes(), None))
        self.assertEqual(restarted.settings()["next_reference"], "PN-02")
        with self.assertRaisesRegex(ValidationError, "number has been retained"):
            restarted.begin(identifier, captured())

    def test_legacy_numbers_are_observed_preserved_and_immutable(self):
        old = captured("pn-7", "legacy")
        self.service.register_existing(old)
        self.assertEqual(self.service.settings()["next_reference"], "PN-08")
        _, ticket = self.begin(old)
        self.assertEqual(json.loads(ticket["numbers_json"])["estimate-1"], "pn-7")
        self.service.cancel(ticket["id"])
        with self.assertRaisesRegex(ValidationError, "cannot be edited"):
            self.begin(captured("PN-00042", "legacy"))

    def test_saved_automatic_identity_keeps_number_on_save_as(self):
        identifier, _ = self.begin(captured(identity="project-a"))
        self.complete(identifier)
        _, copy_ticket = self.begin(captured("manually-forged", "project-a"))
        self.assertEqual(json.loads(copy_ticket["numbers_json"])["estimate-1"], "PN-01")
        self.assertEqual(self.service.settings()["next_reference"], "PN-02")
        with self.assertRaisesRegex(ValidationError, "differs"):
            self.service.register_existing(captured("PN-00042", "project-a"))

    def test_windows_process_check_never_sends_signals_and_detects_pid_reuse(self):
        with patch("estimator.project_details.os.name", "nt"), patch("estimator.project_details.os.kill") as kill, \
                patch("estimator.project_details._windows_process", return_value=(True, "new-start")):
            self.assertEqual(_process_status(12345), (True, "new-start"))
            row = {"pid": os.getpid() + 100, "instance": "other", "process_token": "old-start"}
            self.assertFalse(ProjectDetails._alive(row))
            row["process_token"] = "new-start"
            self.assertTrue(ProjectDetails._alive(row))
            kill.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows read-only process API")
    def test_actual_windows_process_probe_leaves_current_process_alive(self):
        alive, token = _process_status(os.getpid())
        self.assertTrue(alive)
        self.assertTrue(token and token.isdigit())


class NumberedProjectLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "state.sqlite3")
        self.dialogs = Chooser()
        self.details = ProjectDetails(self.root / "numbers.sqlite3")
        self.addCleanup(self.details.close)
        self.library = ProjectLibrary(self.store, self.dialogs, project_details=self.details)
        self.addCleanup(self.library.close)
        self.request = {"estimate": {"project_no": "FORGED", "client": "Client", "site_address": "10 Site Road"},
                        "project_save_request": str(uuid4())}
        self.target = self.root / "Saved.cf.json"
        self.dialogs.selection = SaveSelection(str(self.target), None)

    def test_first_success_assigns_number_file_title_all_estimates_and_retries_once(self):
        snapshot = json.loads(export_project(self.store, {"estimate": self.request["estimate"]}))
        workspace = {"estimate": snapshot["estimate"], "calculators": {key: {"inputs": value["inputs"]} for key, value in snapshot["calculators"].items()}}
        request = dict(self.request, estimates=[{"id": "estimate-1", "name": "First", "workspace": workspace},
                                              {"id": "estimate-22222222222222222222222222222222", "name": "Second", "workspace": copy.deepcopy(workspace)}], active_estimate_id="estimate-22222222222222222222222222222222")
        result = self.library.save_as(request)
        self.assertEqual(set(numbers(result["project"]).values()), {"PN-01"})
        self.assertEqual(result["project"]["estimate"]["project_no"], "PN-01")
        self.assertEqual(self.dialogs.calls[0][2], "PN-01- Client- 10 Site Road.cf.json")
        original = self.target.read_bytes()
        self.assertEqual(json.loads(original)["estimates"][0]["workspace"]["estimate"]["project_no"], "PN-01")
        replay = self.library.save_as(request)
        self.assertTrue(replay["replayed"])
        self.assertEqual(len(self.dialogs.calls), 1)
        self.assertEqual(self.target.read_bytes(), original)
        self.assertEqual(self.details.settings()["next_number"], 2)

    def test_cancel_and_failed_write_do_not_consume_a_number(self):
        self.dialogs.selection = None
        self.assertTrue(self.library.save_as(self.request)["cancelled"])
        self.assertEqual(self.details.settings()["next_number"], 1)
        self.dialogs.selection = SaveSelection(str(self.target), None)
        with patch("estimator.project_library._atomic_write", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.library.save_as(self.request)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.details.settings()["next_number"], 1)
        self.assertEqual(self.library.save_as(self.request)["project"]["estimate"]["project_no"], "PN-01")

    def test_saved_bytes_recover_when_acknowledgement_fails(self):
        with patch.object(self.details, "finish", side_effect=OSError("acknowledgement failed")):
            result = self.library.save_as(self.request)
        self.assertTrue(result["replayed"])
        self.assertEqual(self.details.settings()["next_number"], 2)
        self.assertEqual(result["project"]["estimate"]["project_no"], "PN-01")

    def test_save_rejects_number_tampering_without_changing_file(self):
        saved = self.library.save_as(self.request)
        original = self.target.read_bytes()
        snapshot = json.loads(original)
        edited = {"estimate": dict(snapshot["estimate"], project_no="PN-00099"), "save_token": saved["file"]["save_token"], "calculators": {key: {"inputs": value["inputs"]} for key, value in snapshot["calculators"].items()}}
        with self.assertRaisesRegex(ValidationError, "cannot be edited"):
            self.library.save(edited)
        self.assertEqual(self.target.read_bytes(), original)

    def test_discovery_deduplicates_clients_and_keeps_legacy_series_separate(self):
        snapshot = json.loads(export_project(self.store, {"estimate": {"project_no": "PN-00123", "client": "Alpha"}}))
        workspace = {"estimate": snapshot["estimate"], "calculators": {key: {"inputs": value["inputs"]} for key, value in snapshot["calculators"].items()}}
        alternate = copy.deepcopy(workspace)
        alternate["estimate"].update(project_no="PN-00124", client="Beta <literal>")
        self.target.write_bytes(export_project(self.store, dict(workspace, estimates=[
            {"id": "estimate-1", "name": "First", "workspace": workspace},
            {"id": "estimate-22222222222222222222222222222222", "name": "Second", "workspace": alternate}], active_estimate_id="estimate-1")))
        (self.root / "other.cf.json").write_bytes(export_project(self.store, {"estimate": {"client": " alpha "}}))
        self.store.set_project_folder(self.root)
        for _ in range(20):
            found = self.library.clients()
            if not found["scan_pending"]:
                break
        self.assertEqual(found["error_count"], 0)
        self.assertEqual([name.casefold() for name in found["clients"]], ["alpha", "beta <literal>"])
        self.assertEqual(self.details.settings()["next_reference"], "PN-01")

    def test_unreadable_projects_block_new_assignment_not_silent_collision(self):
        broken = json.loads(export_project(self.store, {"estimate": {}}))
        broken["estimate"]["project_no"] = ["invalid"]
        (self.root / "broken.cf.json").write_text(json.dumps(broken), encoding="utf-8")
        self.store.set_project_folder(self.root)
        for _ in range(20):
            if not self.library.clients()["scan_pending"]:
                break
        with self.assertRaisesRegex(ValidationError, "unreadable"):
            self.library.save_as(self.request)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.dialogs.calls, [])

    def test_new_file_arriving_after_client_scan_cannot_duplicate_its_number(self):
        payload = export_project(self.store, {'estimate': {'project_no': 'PN-01', 'client': 'Externally added'}})
        self.store.set_project_folder(self.root)
        for _ in range(20):
            if not self.library.clients()['scan_pending']:
                break
        (self.root / 'arrived.cf.json').write_bytes(payload)
        # Hold the UI cache valid so this cannot pass just because validation
        # happened to outlast the normal cache TTL.
        with patch('estimator.project_library.SCAN_CACHE_SECONDS', 3600):
            saved = self.library.save_as(self.request)
        self.assertEqual(saved['project']['estimate']['project_no'], 'PN-02')


if __name__ == "__main__":
    unittest.main()
