"""Complete project files under one explicitly linked local folder."""

from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import threading
import time

from .catalog import ValidationError
from .native_dialogs import NativeDialogs, SaveSelection
from .project_file import CALCULATOR_IDS, ESTIMATE_FIELDS, MAX_PROJECT_FILE, export_project, has_project_identity, load_project_bytes, project_filename, project_summary


MAX_PROJECT_FILES = 200
MAX_SCAN_ENTRIES = 2000
MAX_LIST_BYTES = 64 * 1_048_576
SCAN_CACHE_SECONDS = 5
_DIALOG_LOCK = threading.Lock()


def _linked(info):
    if stat.S_ISLNK(info.st_mode):
        return True
    if not getattr(info, "st_file_attributes", 0) & 0x400:
        return False
    # OneDrive cloud placeholders do not redirect names. Reject junctions,
    # symlinks and unknown reparse providers; allow only the documented cloud
    # tag family (CLOUD and CLOUD_1 through CLOUD_F).
    return getattr(info, "st_reparse_tag", 0) & 0xFFFF0FFF != 0x9000001A


def _directory(value):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ValidationError("Choose an absolute local folder path.")
    try:
        for component in (path, *path.parents):
            info = component.lstat()
            if _linked(info) or not stat.S_ISDIR(info.st_mode):
                raise ValidationError("Choose a regular folder, not a symbolic link or junction.")
        return path.resolve(strict=True)
    except OSError as error:
        raise ValidationError("The estimates folder is unavailable. Link an accessible folder and try again.") from error


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _read_file(path, *, scan=False):
    """Read a bounded regular file and reject replacement during the read.

    A scan may inspect the bounded prefix of an oversized file to determine
    whether a project warning applies. Explicit opens always reject its size.
    """
    path = Path(path)
    parent = _directory(path.parent)
    if path.parent != parent:
        path = parent / path.name
    try:
        before = path.lstat()
        if _linked(before) or not stat.S_ISREG(before.st_mode):
            raise ValidationError("Project files must be regular files, not links.")
        if before.st_size > MAX_PROJECT_FILE and not scan:
            raise ValidationError("The project file must be at most 16 MB.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if _identity(before) != _identity(opened):
                raise ValidationError("The project file changed while opening it. Try again.")
            payload = stream.read(MAX_PROJECT_FILE + 1)
            after = os.fstat(stream.fileno())
        if (len(payload) > MAX_PROJECT_FILE and not scan) or _identity(before) != _identity(after) or _identity(before) != _identity(path.lstat()):
            raise ValidationError("The project file changed while reading it. Try again.")
        return payload, before
    except OSError as error:
        raise ValidationError("The project file cannot be read. Refresh the folder and try again.") from error


def file_fingerprint(path):
    """Also used by injected dialog adapters in tests."""
    try:
        Path(path).lstat()
    except FileNotFoundError:
        return None
    payload, info = _read_file(path)
    return {"size": info.st_size, "mtime_ns": info.st_mtime_ns, "sha256": hashlib.sha256(payload).hexdigest()}


def _preserve_penetration_inputs(path, request):
    if "penetration" in request:
        return
    existing, _ = _read_file(path)
    try:
        snapshot = json.loads(existing)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return
    if isinstance(snapshot, dict) and has_project_identity(existing) and "penetration" in snapshot:
        raise ValidationError("Refresh the application and reload this project before saving its Penetration Calculator inputs.")


def _file_id(folder, name):
    return hashlib.sha256((str(folder) + "\0" + name).encode("utf-8")).hexdigest()


def _metadata(path, info, project, folder):
    estimate = project["estimate"]
    inside = folder is not None and path.is_relative_to(folder)
    relative = path.relative_to(folder).as_posix() if inside else path.name
    return {"id": _file_id(folder, relative) if inside else None, "name": path.name,
            "path": str(path), "relative_path": relative,
            "relative_folder": str(Path(relative).parent).replace("\\", "/") if inside else "",
            "title": estimate["title"], "project_no": estimate.get("project_no", ""),
            "client": estimate.get("client", ""), "site_address": estimate.get("site_address", ""),
            "modified_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(), "size": info.st_size}


@contextmanager
def _dialog():
    if not _DIALOG_LOCK.acquire(blocking=False):
        raise ValidationError("Finish the open file dialog before starting another one.")
    try:
        yield
    finally:
        _DIALOG_LOCK.release()


def _atomic_write(selection, payload):
    if not isinstance(selection, SaveSelection) or not isinstance(selection.path, str):
        raise ValidationError("The native file dialog returned an invalid selection.")
    path = Path(selection.path)
    if not path.is_absolute() or not path.name.lower().endswith(".json") or ".." in path.parts:
        raise ValidationError("Save the project as a JSON file in an existing folder.")
    folder = _directory(path.parent)
    path = folder / path.name
    expected = selection.fingerprint
    if expected is not None and (not isinstance(expected, dict) or set(expected) != {"size", "mtime_ns", "sha256"}
                                 or type(expected["size"]) is not int or type(expected["mtime_ns"]) is not int
                                 or not isinstance(expected["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", expected["sha256"])):
        raise ValidationError("The selected file could not be checked safely. Choose it again.")
    temporary = None
    try:
        if file_fingerprint(path) != expected:
            raise ValidationError("The selected file changed. Reload the project or use Save As to confirm its current contents.")
        descriptor, temporary = tempfile.mkstemp(prefix=".ceasefire-project-", suffix=".tmp", dir=folder)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            saved_info = os.fstat(stream.fileno())
        # Recheck both the directory and confirmed file after preparing the bytes.
        if _directory(folder) != folder or file_fingerprint(path) != expected:
            raise ValidationError("The selected file changed. Reload the project or use Save As to confirm its current contents.")
        os.replace(temporary, path)
        temporary = None
        return path, saved_info
    except OSError as error:
        raise ValidationError("The project could not be saved. Check the folder permissions and try again.") from error
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


class ProjectLibrary:
    def __init__(self, store, dialogs=None):
        self.store = store
        self.dialogs = dialogs if dialogs is not None else NativeDialogs()
        self._lock = threading.RLock()
        self._cache = {}
        self._scan = None
        # Only native selections and validated folder loads grant write access.
        # Browser requests receive opaque, session-only capabilities, never a
        # writable path argument. Each successful Save consumes its capability.
        self._save_targets = {}

    def close(self):
        """Release a partially scanned directory when the server shuts down."""
        with self._lock:
            if self._scan is not None and self._scan["iterator"] is not None:
                self._scan["iterator"].close()
                self._scan["iterator"] = None

    def _start_scan(self, folder):
        if self._scan is not None and self._scan["folder"] != folder:
            self._cache.clear()
        else:
            # Availability failures (including cloud hydration) can recover
            # without changing size/mtime. Force their reread while retaining
            # known project identity if corruption later removes its marker.
            # Completed scans still prune every removed path from this cache.
            self._cache = {key: (None, value[1], value[2]) if "error" in value[1] else value
                           for key, value in self._cache.items()}
        self.close()
        self._scan = {"folder": folder, "directories": deque([folder]), "iterator": None,
                      "current": None, "deferred": None, "files": {}, "errors": [], "seen": set(),
                      "entries": 0, "json_files": 0, "completed": None, "scanned_at": None}

    def _scan_batch(self):
        """Bound each request, retaining traversal state so no total cap hides files."""
        scan = self._scan
        consumed = processed = inspected = 0
        while inspected < MAX_SCAN_ENTRIES and processed < MAX_PROJECT_FILES:
            path = scan["deferred"]
            if path is not None:
                # Consume before inspecting: a file can become a directory,
                # link or non-JSON entry between continuation requests.
                scan["deferred"] = None
                inspected += 1
            if path is None:
                if scan["iterator"] is None:
                    if not scan["directories"]:
                        scan["completed"] = time.monotonic()
                        # Prune removed files and folders from the identity cache.
                        self._cache = {key: value for key, value in self._cache.items() if key in scan["seen"]}
                        break
                    directory = scan["directories"].popleft()
                    inspected += 1
                    try:
                        _directory(directory)
                        scan["iterator"] = os.scandir(directory)
                        scan["current"] = directory
                    except (OSError, ValidationError) as error:
                        scan["errors"].append({"name": directory.relative_to(scan["folder"]).as_posix(), "error": str(error)})
                        continue
                try:
                    entry = next(scan["iterator"])
                except StopIteration:
                    scan["iterator"].close()
                    scan["iterator"] = None
                    continue
                except OSError as error:
                    scan["errors"].append({"name": str(scan["current"].relative_to(scan["folder"])), "error": str(error)})
                    scan["iterator"].close()
                    scan["iterator"] = None
                    continue
                path = Path(entry.path)
                inspected += 1
                scan["entries"] += 1
            relative = path.relative_to(scan["folder"]).as_posix()
            try:
                info = path.lstat()
                if _linked(info):
                    raise ValidationError("Linked files and folders are not followed. Move the project into this estimates folder to include it.")
                if stat.S_ISDIR(info.st_mode):
                    scan["directories"].append(path)
                    continue
                if not path.name.lower().endswith(".json"):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise ValidationError("Project files must be regular files, not links.")
                key = (str(scan["folder"]), str(path))
                identity = _identity(info)
                cached = self._cache.get(key)
                if cached is None or cached[0] != identity:
                    if consumed + min(info.st_size, MAX_PROJECT_FILE + 1) > MAX_LIST_BYTES:
                        scan["deferred"] = path
                        break
                    consumed += min(info.st_size, MAX_PROJECT_FILE + 1)
                    recognized = cached[2] if cached is not None else False
                    try:
                        payload, info = _read_file(path, scan=True)
                        recognized = has_project_identity(payload, previously_recognized=recognized)
                        if recognized:
                            if info.st_size > MAX_PROJECT_FILE:
                                raise ValidationError("The project file must be at most 16 MB.")
                            value = _metadata(path, info, project_summary(payload), scan["folder"])
                        else:
                            value = {"ignored": True}
                    except (OSError, ValidationError) as error:
                        value = {"name": relative, "error": str(error)}
                    cached = (identity, value, recognized)
                    self._cache[key] = cached
                scan["seen"].add(key)
                value = cached[1]
                if "error" in value:
                    scan["errors"].append(value)
                elif not value.get("ignored"):
                    scan["files"][value["id"]] = value
                processed += 1
                scan["json_files"] += 1
            except (OSError, ValidationError) as error:
                scan["errors"].append({"name": relative, "error": str(error)})
            scan["deferred"] = None
        scan["scanned_at"] = datetime.now(timezone.utc).isoformat()

    def listing(self, search="", sort="modified_desc", offset=0, limit=100, refresh=False):
        if not isinstance(search, str) or len(search) > 500 or sort not in {"modified_desc", "modified_asc", "name_asc", "name_desc"}:
            raise ValidationError("Choose a valid project search and sort order.")
        try:
            if isinstance(offset, bool) or isinstance(limit, bool):
                raise ValueError
            offset, limit = int(offset), int(limit)
            if offset < 0 or not 1 <= limit <= 200:
                raise ValueError
        except (TypeError, ValueError) as error:
            raise ValidationError("Choose a nonnegative project offset and a page size between 1 and 200.") from error
        if refresh not in (True, False, "0", "1"):
            raise ValidationError("Refresh must be 0 or 1.")
        refresh = refresh in (True, "1")
        selected = self.store.project_folder()
        result = {"folder": selected, "files": [], "errors": [], "truncated": False,
                  "total": 0, "matched": 0, "offset": offset, "limit": limit, "scan_pending": False,
                  "scanned_entries": 0, "scanned_files": 0, "scanned_at": None, "cached": False, "error_count": 0}
        if selected is None:
            return result
        try:
            folder = _directory(selected)
            with self._lock:
                if self._scan is None or self._scan["folder"] != folder or refresh or (
                        self._scan["completed"] is not None and time.monotonic() - self._scan["completed"] > SCAN_CACHE_SECONDS):
                    self._start_scan(folder)
                result["cached"] = self._scan["completed"] is not None
                if not result["cached"]:
                    self._scan_batch()
                scan = self._scan
                needle = search.strip().casefold()
                files = [value for value in scan["files"].values() if not needle or needle in " ".join(
                    value[key] for key in ("title", "name", "relative_path", "project_no", "client", "site_address")).casefold()]
                field = "modified_at" if sort.startswith("modified") else "title"
                files.sort(key=lambda value: (value[field].casefold(), value["relative_path"].casefold()), reverse=sort.endswith("desc"))
                pending = scan["completed"] is None
                result.update(files=files[offset:offset + limit], total=len(scan["files"]), matched=len(files),
                              errors=scan["errors"][:200], error_count=len(scan["errors"]), scan_pending=pending,
                              truncated=pending, scanned_at=scan["scanned_at"], scanned_entries=scan["entries"], scanned_files=scan["json_files"])
        except (OSError, ValidationError) as error:
            result["errors"].append({"name": "Estimates folder", "error": str(error)})
            result["error_count"] = len(result["errors"])
        return result

    def link_folder(self):
        with _dialog():
            selected = self.dialogs.choose_folder(self.store.project_folder())
            if selected is None:
                return {"cancelled": True}
            folder = _directory(selected)
            self.store.set_project_folder(folder)
        return {"cancelled": False, **self.listing(refresh=True)}

    def load(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise ValidationError("Choose a project from the linked estimates folder.")
        selected = self.store.project_folder()
        if selected is None:
            raise ValidationError("Link an estimates folder first.")
        folder = _directory(selected)
        with self._lock:
            value = self._scan["files"].get(identifier) if self._scan is not None and self._scan["folder"] == folder else None
        if value is None:
            raise ValidationError("The project is no longer in the linked folder. Refresh the list.")
        path = Path(value["path"])
        if not path.is_relative_to(folder) or _file_id(folder, path.relative_to(folder).as_posix()) != identifier:
            raise ValidationError("Choose a project from the linked estimates folder.")
        payload, info = _read_file(path)
        project = load_project_bytes(self.store, payload)
        return {**project, "file": self._authorize_save(path, info, payload, _metadata(path, info, project, folder))}

    def _authorize_save(self, path, info, payload, metadata):
        token = secrets.token_urlsafe(32)
        fingerprint = {"size": info.st_size, "mtime_ns": info.st_mtime_ns,
                       "sha256": hashlib.sha256(payload).hexdigest()}
        with self._lock:
            self._save_targets[token] = SaveSelection(str(path), fingerprint)
        return {**metadata, "save_token": token}

    def capture_download(self, request):
        """Bind an export to its requesting window's selected file, not global state."""
        from .download_files import DownloadDestination, standard_downloads_directory
        if not isinstance(request, dict) or set(request) != {'project_token'}:
            raise ValidationError('Download options must contain the current project token only.')
        token = request['project_token']
        if token is None:
            return DownloadDestination(standard_downloads_directory(), 'downloads')
        if not isinstance(token, str) or not 1 <= len(token) <= 200:
            raise ValidationError('The download project selection is invalid. Reload the project or use Save As.')
        with self._lock:
            selection = self._save_targets.get(token)
            if selection is None:
                raise ValidationError('The download project selection is no longer available. Reload the project or use Save As.')
            if file_fingerprint(selection.path) != selection.fingerprint:
                raise ValidationError('The project file changed or was removed. Reload it or use Save As before downloading.')
            return DownloadDestination(_directory(Path(selection.path).parent), 'project')

    def write_download(self, destination, filename, payload):
        from .download_files import write_download_file
        with self._lock:
            # The captured authorization remains valid for this one download
            # even if Save rotates the token while the report is rendering.
            return write_download_file(destination, filename, payload)

    def open_file(self):
        with _dialog():
            selected = self.dialogs.choose_open(self.store.project_folder())
            if selected is None:
                return {"cancelled": True}
            path = Path(selected)
            if not path.is_absolute() or ".." in path.parts or not path.name.lower().endswith(".json"):
                raise ValidationError("Choose a project JSON file in an accessible folder.")
            payload, info = _read_file(path)
            project = load_project_bytes(self.store, payload)
            selected_folder = self.store.project_folder()
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = self._authorize_save(path, info, payload, _metadata(path, info, project, folder))
            return {"cancelled": False, **project, "file": metadata}

    def save(self, request):
        required = {"save_token", "estimate", "calculators"}
        if not isinstance(request, dict) or not required <= set(request) or set(request) - required - {"penetration"}:
            raise ValidationError("Save requires the current project selection and its complete estimate and calculators.")
        if not isinstance(request["calculators"], dict) or set(request["calculators"]) != set(CALCULATOR_IDS):
            raise ValidationError("Save must include all three calculator drafts.")
        if not isinstance(request["estimate"], dict) or set(request["estimate"]) != ESTIMATE_FIELDS:
            raise ValidationError("Save must include the complete estimate inputs and pricing snapshot.")
        token = request["save_token"]
        if not isinstance(token, str):
            raise ValidationError('Choose the project with Load Project or "Save As" before using Save.')
        with self._lock:
            selection = self._save_targets.get(token)
            if selection is None:
                raise ValidationError('This project selection is no longer available. Use Load Project or "Save As".')
        payload = export_project(self.store, {key: request[key] for key in ("estimate", "calculators", "penetration") if key in request})
        project = load_project_bytes(self.store, payload)
        # Serialize writes and recheck the capability after preparation so two
        # simultaneous requests cannot both consume one saved-file version.
        with self._lock:
            if self._save_targets.get(token) is not selection:
                raise ValidationError('The project was already saved by another request. Reload it or use "Save As".')
            path = Path(selection.path)
            if file_fingerprint(path) != selection.fingerprint:
                raise ValidationError('The project file changed or was removed outside this window. Reload it or use "Save As".')
            _preserve_penetration_inputs(path, request)
            selected_folder = self.store.project_folder()
            path, info = _atomic_write(selection, payload)
            del self._save_targets[token]
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = _metadata(path, info, project, folder)
            metadata["in_linked_folder"] = folder is not None and path.is_relative_to(folder)
            self.close()
            if folder is not None:
                self._start_scan(folder)
                if metadata["in_linked_folder"]:
                    self._scan["files"][metadata["id"]] = metadata
            else:
                self._scan = None
            metadata = self._authorize_save(path, info, payload, metadata)
        return {"cancelled": False, "file": metadata, "folder": selected_folder, "project": project}

    def save_as(self, request):
        # No dialog or preference/file writes until the complete captured state is valid.
        payload = export_project(self.store, request)
        project = load_project_bytes(self.store, payload)
        with _dialog():
            selected_folder = self.store.project_folder()
            selection = self.dialogs.choose_save(selected_folder, project_filename(project["estimate"]["title"]))
            if selection is None:
                return {"cancelled": True}
            with self._lock:
                if isinstance(selection, SaveSelection) and selection.fingerprint is not None:
                    _preserve_penetration_inputs(Path(selection.path), request)
                path, saved_info = _atomic_write(selection, payload)
            warning = None
            if selected_folder is None:
                try:
                    self.store.set_project_folder(path.parent)
                    selected_folder = str(path.parent)
                except Exception:
                    # The file has already been saved; never report this as a failed save.
                    warning = "The project was saved, but its folder could not be linked. Use Link folder to try again."
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = _metadata(path, saved_info, project, folder)
            metadata.update({"path": str(path), "in_linked_folder": folder is not None and path.is_relative_to(folder)})
            with self._lock:
                self.close()
                if folder is not None:
                    self._start_scan(folder)
                    if metadata["in_linked_folder"]:
                        self._scan["files"][metadata["id"]] = metadata
                else:
                    self._scan = None
        metadata = self._authorize_save(path, saved_info, payload, metadata)
        response = {"cancelled": False, "file": metadata, "folder": selected_folder, "project": project}
        if warning:
            response["warning"] = warning
        return response
