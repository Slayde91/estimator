"""Complete project files in one explicitly linked local folder."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import itertools
import os
from pathlib import Path
import re
import stat
import tempfile
import threading

from .catalog import ValidationError
from .native_dialogs import NativeDialogs, SaveSelection
from .project_file import MAX_PROJECT_FILE, export_project, load_project_bytes, project_filename


MAX_PROJECT_FILES = 200
MAX_SCAN_ENTRIES = 2000
MAX_LIST_BYTES = 64 * 1_048_576
_DIALOG_LOCK = threading.Lock()


def _linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


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


def _read_file(path):
    """Read a bounded regular file and reject replacement during the read."""
    path = Path(path)
    parent = _directory(path.parent)
    if path.parent != parent:
        path = parent / path.name
    try:
        before = path.lstat()
        if _linked(before) or not stat.S_ISREG(before.st_mode):
            raise ValidationError("Project files must be regular files, not links.")
        if before.st_size > MAX_PROJECT_FILE:
            raise ValidationError("The project file must be at most 16 MB.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if _identity(before) != _identity(opened):
                raise ValidationError("The project file changed while opening it. Try again.")
            payload = stream.read(MAX_PROJECT_FILE + 1)
            after = os.fstat(stream.fileno())
        if len(payload) > MAX_PROJECT_FILE or _identity(before) != _identity(after) or _identity(before) != _identity(path.lstat()):
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


def _file_id(folder, name):
    return hashlib.sha256((str(folder) + "\0" + name).encode("utf-8")).hexdigest()


def _metadata(path, info, project, folder):
    estimate = project["estimate"]
    inside = folder is not None and path.parent == folder
    return {"id": _file_id(folder, path.name) if inside else None, "name": path.name,
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
            raise ValidationError("The selected file changed after the dialog. Save again to confirm its current contents.")
        descriptor, temporary = tempfile.mkstemp(prefix=".ceasefire-project-", suffix=".tmp", dir=folder)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            saved_info = os.fstat(stream.fileno())
        # Recheck both the directory and confirmed file after preparing the bytes.
        if _directory(folder) != folder or file_fingerprint(path) != expected:
            raise ValidationError("The selected file changed after the dialog. Save again to confirm its current contents.")
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

    def _entries(self, folder):
        with os.scandir(folder) as iterator:
            entries = list(itertools.islice(iterator, MAX_SCAN_ENTRIES + 1))
        truncated = len(entries) > MAX_SCAN_ENTRIES
        paths = sorted((Path(entry.path) for entry in entries[:MAX_SCAN_ENTRIES]
                        if entry.name.lower().endswith(".json")), key=lambda path: path.name.casefold())
        return paths[:MAX_PROJECT_FILES], truncated or len(paths) > MAX_PROJECT_FILES

    def listing(self):
        selected = self.store.project_folder()
        result = {"folder": selected, "files": [], "errors": [], "truncated": False}
        if selected is None:
            return result
        try:
            folder = _directory(selected)
            paths, result["truncated"] = self._entries(folder)
            total = 0
            for path in paths:
                try:
                    size = path.lstat().st_size
                    if total + min(size, MAX_PROJECT_FILE) > MAX_LIST_BYTES:
                        result["truncated"] = True
                        break
                    total += min(size, MAX_PROJECT_FILE)
                    payload, info = _read_file(path)
                    project = load_project_bytes(self.store, payload)
                    result["files"].append(_metadata(path, info, project, folder))
                except (OSError, ValidationError) as error:
                    result["errors"].append({"name": path.name, "error": str(error)})
            result["files"].sort(key=lambda item: (item["modified_at"], item["name"]), reverse=True)
        except (OSError, ValidationError) as error:
            result["errors"].append({"name": "Estimates folder", "error": str(error)})
        return result

    def link_folder(self):
        with _dialog():
            selected = self.dialogs.choose_folder(self.store.project_folder())
            if selected is None:
                return {"cancelled": True}
            folder = _directory(selected)
            self.store.set_project_folder(folder)
        return {"cancelled": False, **self.listing()}

    def load(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise ValidationError("Choose a project from the linked estimates folder.")
        selected = self.store.project_folder()
        if selected is None:
            raise ValidationError("Link an estimates folder first.")
        folder = _directory(selected)
        try:
            paths, _ = self._entries(folder)
        except OSError as error:
            raise ValidationError("The estimates folder cannot be read.") from error
        path = next((path for path in paths if _file_id(folder, path.name) == identifier), None)
        if path is None:
            raise ValidationError("The project is no longer in the linked folder. Refresh the list.")
        payload, info = _read_file(path)
        project = load_project_bytes(self.store, payload)
        return {**project, "file": _metadata(path, info, project, folder)}

    def save_as(self, request):
        # No dialog or preference/file writes until the complete captured state is valid.
        payload = export_project(self.store, request)
        project = load_project_bytes(self.store, payload)
        with _dialog():
            selected_folder = self.store.project_folder()
            selection = self.dialogs.choose_save(selected_folder, project_filename(project["estimate"]["title"]))
            if selection is None:
                return {"cancelled": True}
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
            metadata.update({"path": str(path), "in_linked_folder": folder is not None and path.parent == folder})
        response = {"cancelled": False, "file": metadata, "folder": selected_folder, "project": project}
        if warning:
            response["warning"] = warning
        return response
