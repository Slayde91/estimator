"""Server-owned project references with a recoverable first-save journal."""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time

from .catalog import ValidationError

MAX_NUMBER = 999_999_999
_ACTIVE = set()
_ACTIVE_LOCK = threading.RLock()


def _windows_process(pid):
    """Read process lifetime without ever sending a Windows termination signal."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        # ERROR_INVALID_PARAMETER identifies a process that no longer exists.
        return ctypes.get_last_error() != 87, None
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True, None
        if code.value != 259:  # STILL_ACTIVE
            return False, None
        times = [wintypes.FILETIME() for _ in range(4)]
        token = None
        if kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            token = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
        return True, token
    finally:
        kernel.CloseHandle(handle)


def _process_status(pid):
    if os.name == "nt":
        return _windows_process(pid)
    try:
        os.kill(pid, 0)  # POSIX existence check; never used on Windows.
        return True, None
    except ProcessLookupError:
        return False, None
    except (PermissionError, OSError):
        return True, None


def request_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value):
        raise ValidationError("Refresh the application before saving a new project.")
    return value


def numbers(project):
    entries = project.get("estimates")
    if entries:
        return {item["id"]: item["workspace"]["estimate"].get("project_no", "") for item in entries}
    return {"estimate-1": project["estimate"].get("project_no", "")}


def owner(project, identifier):
    identity = project.get("certifications", {}).get("project_id")
    return "project:" + identity if isinstance(identity, str) and identity else "save:" + identifier


class ProjectDetails:
    """Allocation records survive process failure without reusing saved numbers.

    A reservation is made before the chooser so its suggested name is accurate.
    Cancellation releases it. Before replacing a file, its exact intended digest
    is journalled; after a crash that digest distinguishes a completed write from
    an interrupted one. A pending save cannot be adopted by another live process.
    """
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.instance = secrets.token_hex(16)
        self.process_token = _process_status(os.getpid())[1]
        with _ACTIVE_LOCK:
            _ACTIVE.add(self.instance)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY CHECK(id=1),prefix TEXT NOT NULL,start_number INTEGER NOT NULL);
                INSERT OR IGNORE INTO preferences VALUES(1,'PN',1);
                CREATE TABLE IF NOT EXISTS sequences(prefix TEXT PRIMARY KEY,next_number INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS occupied(number TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS identities(owner TEXT PRIMARY KEY,numbers_json TEXT NOT NULL,automatic INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS saves(id TEXT PRIMARY KEY,owner TEXT NOT NULL,digest TEXT NOT NULL,
                    numbers_json TEXT NOT NULL,state TEXT NOT NULL,path TEXT,payload_hash TEXT,
                    pid INTEGER NOT NULL,instance TEXT NOT NULL,created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS saves_owner ON saves(owner,state);
            """)
            db.execute("BEGIN IMMEDIATE")
            if "process_token" not in {row[1] for row in db.execute("PRAGMA table_info(saves)")}:
                db.execute("ALTER TABLE saves ADD COLUMN process_token TEXT")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _observe(db, values):
        for value in values:
            if not isinstance(value, str) or not value.strip():
                continue
            value = value.strip()
            db.execute("INSERT OR IGNORE INTO occupied VALUES(?)", (value.casefold(),))
            match = re.fullmatch(r"([a-zA-Z]{1,12})-([0-9]{1,9})", value)
            if match:
                prefix, number = match[1].upper(), int(match[2])
                canonical = f"{prefix}-{number:05d}".casefold()
                db.execute("INSERT OR IGNORE INTO occupied VALUES(?)", (canonical,))
                db.execute("INSERT INTO sequences VALUES(?,?) ON CONFLICT(prefix) DO UPDATE SET next_number=MAX(next_number,excluded.next_number)", (prefix, number + 1))

    def observe(self, values):
        with self.connect() as db:
            self._observe(db, values)

    def register_existing(self, project, project_id=None):
        """Called only after explicit validated file open/import, never from Save."""
        saved = numbers(project)
        identity = project_id or project.get("certifications", {}).get("project_id")
        with self.connect() as db:
            self._observe(db, saved.values())
            if identity:
                # A portable copy of an automatic project retains its original
                # assignment; a forged edit cannot mutate an existing identity.
                previous = db.execute("SELECT numbers_json,automatic FROM identities WHERE owner=?", ("project:" + identity,)).fetchone()
                if previous and previous["automatic"]:
                    expected = set(json.loads(previous["numbers_json"]).values())
                    if set(saved.values()) != expected:
                        raise ValidationError("This project number differs from its recorded automatic number. Open the original saved project.")
                elif not previous:
                    db.execute("INSERT INTO identities VALUES(?,?,0)", ("project:" + identity, json.dumps(saved)))

    def settings(self):
        with self.connect() as db:
            row = db.execute("SELECT prefix,start_number FROM preferences WHERE id=1").fetchone()
            sequence = db.execute("SELECT next_number FROM sequences WHERE prefix=?", (row["prefix"],)).fetchone()
            candidate = max(row["start_number"], sequence[0] if sequence else 1)
            reserved = {number for record in db.execute("SELECT numbers_json FROM saves WHERE state IN ('reserved','prepared')") for number in json.loads(record[0]).values()}
            while f'{row["prefix"]}-{candidate:05d}' in reserved or db.execute("SELECT 1 FROM occupied WHERE number=?", (f'{row["prefix"]}-{candidate:05d}'.casefold(),)).fetchone():
                candidate += 1
            return dict(row) | {"next_number": candidate, "next_reference": f'{row["prefix"]}-{candidate:05d}'}

    @staticmethod
    def validated_settings(value):
        if not isinstance(value, dict) or set(value) != {"prefix", "start_number"}:
            raise ValidationError("Include Prefix and Project start number only.")
        prefix, start = value["prefix"], value["start_number"]
        if not isinstance(prefix, str) or not re.fullmatch(r"[A-Za-z]{1,12}", prefix.strip()):
            raise ValidationError("Prefix must contain 1 to 12 letters.")
        if type(start) is not int or not 1 <= start <= MAX_NUMBER:
            raise ValidationError("Project start number must be a whole number from 1 to 999999999.")
        return prefix.strip().upper(), start

    def save_settings(self, value):
        prefix, start = self.validated_settings(value)
        with self.connect() as db:
            db.execute("UPDATE preferences SET prefix=?,start_number=? WHERE id=1", (prefix, start))
        return self.settings()

    @staticmethod
    def _alive(row):
        if row["pid"] == os.getpid():
            with _ACTIVE_LOCK:
                return row["instance"] in _ACTIVE
        alive, token = _process_status(row["pid"])
        return alive and not (row["process_token"] and token and row["process_token"] != token)

    def recover(self, reader):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in db.execute("SELECT * FROM saves WHERE state IN ('reserved','prepared')").fetchall():
                # A live chooser must never lose its reservation, however long
                # it stays open. Windows process creation time detects PID reuse.
                if self._alive(row):
                    continue
                complete = False
                if row["path"] and row["payload_hash"]:
                    try:
                        complete = hashlib.sha256(reader(row["path"])[0]).hexdigest() == row["payload_hash"]
                    except (OSError, ValidationError):
                        pass
                if complete:
                    self._finish(db, row)
                elif row['state'] == 'prepared':
                    # A crash could occur just after replace, followed by a
                    # deletion or external edit. Retire the uncertain number;
                    # a gap is safer than assigning an already-used reference.
                    self._observe(db, json.loads(row['numbers_json']).values())
                    db.execute("UPDATE saves SET state='conflict' WHERE id=?", (row['id'],))
                else:
                    db.execute("DELETE FROM saves WHERE id=?", (row["id"],))

    @staticmethod
    def _finish(db, row):
        saved = json.loads(row["numbers_json"])
        ProjectDetails._observe(db, saved.values())
        db.execute("INSERT OR IGNORE INTO identities VALUES(?,?,1)", (row["owner"], row["numbers_json"]))
        db.execute("UPDATE saves SET state='saved' WHERE id=?", (row["id"],))

    def begin(self, identifier, captured):
        identifier = request_id(identifier)
        digest = hashlib.sha256(json.dumps(captured, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        identity = owner(captured, identifier)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT * FROM saves WHERE id=?", (identifier,)).fetchone()
            if previous:
                if previous['state'] == 'conflict':
                    raise ValidationError("The previous save was interrupted and its file cannot be confirmed. Its project number has been retained. Open the saved file, or start a new project before saving again.")
                if previous["digest"] != digest or previous["owner"] != identity:
                    raise ValidationError("This save was already submitted with different project contents. Reload the saved project before continuing.")
                if previous["state"] != "saved":
                    raise ValidationError("This new-project save is still running. Finish its file chooser before trying again.")
                return dict(previous) | {"replay": True}
            if db.execute("SELECT 1 FROM saves WHERE owner=? AND state IN ('reserved','prepared')", (identity,)).fetchone():
                raise ValidationError("This project already has a first save in progress.")
            known = db.execute("SELECT numbers_json,automatic FROM identities WHERE owner=?", (identity,)).fetchone()
            if known:
                saved = json.loads(known["numbers_json"])
                primary = next(iter(saved.values()), "")
                wanted = {key: saved.get(key, primary) for key in numbers(captured)}
                if not known["automatic"] and numbers(captured) != wanted:
                    raise ValidationError("Existing project numbers cannot be edited. Reload this project to restore its saved numbers.")
            else:
                preference = db.execute("SELECT prefix,start_number FROM preferences WHERE id=1").fetchone()
                sequence = db.execute("SELECT next_number FROM sequences WHERE prefix=?", (preference["prefix"],)).fetchone()
                candidate = max(preference["start_number"], sequence[0] if sequence else 1)
                pending = {number.casefold() for row in db.execute("SELECT numbers_json FROM saves WHERE state IN ('reserved','prepared')") for number in json.loads(row[0]).values()}
                while True:
                    number = f'{preference["prefix"]}-{candidate:05d}'
                    if candidate > MAX_NUMBER:
                        raise ValidationError("This project prefix has reached its number limit. Choose a different prefix in Project Details settings.")
                    if number.casefold() not in pending and not db.execute("SELECT 1 FROM occupied WHERE number=?", (number.casefold(),)).fetchone():
                        break
                    candidate += 1
                wanted = {key: number for key in numbers(captured)}
            db.execute("INSERT INTO saves(id,owner,digest,numbers_json,state,pid,instance,created,process_token) VALUES(?,?,?,?,'reserved',?,?,?,?)",
                       (identifier, identity, digest, json.dumps(wanted), os.getpid(), self.instance, time.time(), self.process_token))
            return dict(db.execute("SELECT * FROM saves WHERE id=?", (identifier,)).fetchone()) | {"replay": False}

    def prepare(self, identifier, path, payload):
        with self.connect() as db:
            updated = db.execute("UPDATE saves SET state='prepared',path=?,payload_hash=? WHERE id=? AND state='reserved' AND instance=?",
                                 (str(path), hashlib.sha256(payload).hexdigest(), identifier, self.instance)).rowcount
            if updated != 1:
                raise ValidationError("The new-project save reservation expired. Save again to obtain its next number.")

    def finish(self, identifier):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM saves WHERE id=? AND state='prepared'", (identifier,)).fetchone()
            if row is None:
                raise ValidationError("The saved project number could not be confirmed. Reload the saved file before continuing.")
            self._finish(db, row)

    def cancel(self, identifier):
        with self.connect() as db:
            db.execute("DELETE FROM saves WHERE id=? AND state IN ('reserved','prepared') AND instance=?", (identifier, self.instance))

    def known(self, captured, identifier):
        with self.connect() as db:
            return bool(db.execute("SELECT 1 FROM identities WHERE owner=?", (owner(captured, identifier),)).fetchone())

    def recover_request(self, identifier, reader):
        """Confirm bytes already replaced even if the final acknowledgement failed."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM saves WHERE id=?", (identifier,)).fetchone()
            if row and row["path"] and row["payload_hash"]:
                try:
                    if hashlib.sha256(reader(row["path"])[0]).hexdigest() == row["payload_hash"]:
                        self._finish(db, row)
                        return dict(row) | {"state": "saved", "replay": True}
                except (OSError, ValidationError):
                    pass
            return None

    def close(self):
        with _ACTIVE_LOCK:
            _ACTIVE.discard(self.instance)
