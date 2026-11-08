"""Complete project files under one explicitly linked local folder."""

from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from .catalog import ValidationError
from .commercial_sources import CommercialSources, source_id
from .edition import require_project_edition, validate_edition
from .native_dialogs import NativeDialogs, SaveSelection
from .quote_details import QUOTE_DETAIL_LIMITS, compose_quote_title, validate_quote_details
from .project_file import CALCULATOR_IDS, LEGACY_CALCULATOR_IDS, OPTIONAL_CALCULATOR_IDS, ESTIMATE_FIELDS, ESTIMATE_REQUIRED_FIELDS, MAX_PROJECT_FILE, PROJECT_EXTENSION, assert_project_overwrite, export_project, has_project_identity, is_project_filename, load_project_bytes, project_filename, project_summary, validate_project_status, estimate_descriptors, WORKSPACE_FIELDS


MAX_PROJECT_FILES = 200
MAX_SCAN_ENTRIES = 2000
MAX_SCAN_SECONDS = 0.2
MAX_LIST_BYTES = 64 * 1_048_576
MAX_PROJECT_ATTACHMENT = 16 * 1_048_576
SCAN_CACHE_SECONDS = 5
_DIALOG_LOCK = threading.Lock()


class ProjectDetailsConflict(ValidationError):
    """The pane's saved-file revision no longer matches its selected project."""


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


def _quote_save_directory(selected_folder, filename):
    """Prepare one safe quote folder before showing Save As."""
    if selected_folder is None:
        return None
    root = _directory(selected_folder)
    folder = root / filename[:-len(PROJECT_EXTENSION)]
    try:
        folder.mkdir(exist_ok=True)
    except OSError as error:
        raise ValidationError("The quote folder could not be created. Check the linked Project folder and try again.") from error
    # Recheck existing folders and every ancestor; never follow a junction or link.
    return str(_directory(folder))


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


def _attachment_filename(value):
    """Accept one portable leaf filename without rewriting user intent."""
    if not isinstance(value, str) or not value:
        raise ValidationError("Choose a file with a valid filename.")
    try:
        length = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise ValidationError("Choose a file with a valid filename.") from error
    if (length > 255 or value != value.rstrip(" .") or value in {".", ".."}
            or Path(value).name != value or re.search(r'[<>:"/\\|?*\x00-\x1f]', value)):
        raise ValidationError("Choose a file with a valid filename.")
    stem = value.split(".", 1)[0]
    if re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", stem):
        raise ValidationError("Choose a file with a valid filename.")
    return value


def _decode_attachment(value):
    if not isinstance(value, str):
        raise ValidationError("The uploaded file content is invalid.")
    try:
        payload = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValidationError("The uploaded file content is invalid.") from error
    if len(payload) > MAX_PROJECT_ATTACHMENT:
        raise ValidationError("Each project file must be 16 MB or smaller.")
    return payload


def _preserve_penetration_inputs(path, request, *, previous_snapshot=None):
    incoming = request.get("penetration")
    aware = (isinstance(incoming, dict) and type(incoming.get("library_tracking_version")) is int
             and incoming["library_tracking_version"] == 1)
    if isinstance(incoming, dict) and "composer" in incoming and aware:
        return
    snapshot = previous_snapshot
    recognized = snapshot is not None
    if snapshot is None:
        existing, _ = _read_file(path)
        try:
            snapshot = json.loads(existing)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return
        recognized = has_project_identity(existing)
    if isinstance(snapshot, dict) and recognized and "penetration" in snapshot:
        previous = snapshot["penetration"]
        missing_composer = isinstance(previous, dict) and "composer" in previous and (not isinstance(incoming, dict) or "composer" not in incoming)
        if "penetration" not in request or missing_composer:
            raise ValidationError("Refresh the application and reload this project before saving its Firestopping Estimator inputs.")
        if not aware and isinstance(previous, dict):
            # An older browser strips row metadata even when it sends both
            # drafts. Never infer identities back onto possibly reused row IDs.
            for key in ("draft", "composer"):
                draft = previous.get(key)
                rows = draft.get("rows") if isinstance(draft, dict) else None
                if isinstance(rows, list) and any(isinstance(row, dict) and "library_item_id" in row for row in rows):
                    raise ValidationError("Refresh the application and reload this project before saving its Firestopping Estimator library items.")


def _preserve_library_drafts(path, request):
    """An older browser must not silently remove a project's library copies."""
    if 'library_drafts' in request:
        return
    existing, _ = _read_file(path)
    try:
        snapshot = json.loads(existing)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return
    if isinstance(snapshot, dict) and has_project_identity(existing) and 'library_drafts' in snapshot:
        raise ValidationError('Refresh the application and reload this project before saving its project library drafts.')


def _preserve_optional_calculators(path, request):
    """An older browser cannot remove a calculator it has not loaded."""
    incoming = request.get('calculators', {})
    missing = set(OPTIONAL_CALCULATOR_IDS) - set(incoming)
    if not missing:
        return
    existing, _ = _read_file(path)
    try:
        snapshot = json.loads(existing)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return
    calculators = snapshot.get('calculators') if isinstance(snapshot, dict) else None
    if not has_project_identity(existing) or not isinstance(calculators, dict):
        return
    from .schedule_rows import empty_schedule_inputs, normalize_schedule_rows
    from .workbook_calculators import source_model
    for identity in missing & set(calculators):
        previous = calculators[identity]
        inputs = previous.get('inputs') if isinstance(previous, dict) else None
        if not isinstance(inputs, dict):
            raise ValidationError('Reload this project in the current application before saving its steel intumescent calculator inputs.')
        defaults = empty_schedule_inputs(identity)
        if ('schedule_rows' in previous
                and previous['schedule_rows'] != normalize_schedule_rows(identity, defaults)):
            raise ValidationError('Reload this project in the current application before saving its steel intumescent calculator inputs.')
        schedule_sheet = source_model(identity)['schedule']['sheet']
        for sheet, cells in inputs.items():
            if not isinstance(cells, dict):
                raise ValidationError('Reload this project in the current application before saving its steel intumescent calculator inputs.')
            for address, value in cells.items():
                changed = (value not in (None, '') if sheet == schedule_sheet
                           else value != defaults.get(sheet, {}).get(address))
                if changed:
                    raise ValidationError('Reload this project in the current application before saving its steel intumescent calculator inputs.')


def _file_id(folder, name):
    return hashlib.sha256((str(folder) + "\0" + name).encode("utf-8")).hexdigest()


def _open_default_file(path):
    """Ask the desktop to open one already validated regular file."""
    if hasattr(os, "startfile"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)], close_fds=True)
    else:
        subprocess.Popen(["xdg-open", str(path)], close_fds=True)


def _preserve_project_contacts(request, previous):
    """Old browser windows must not silently erase newly stored identity fields."""
    incoming = request.get("estimate", {})
    saved = previous.get("estimate", {})
    if any(saved.get(key) and key not in incoming for key in ("contact_name", "contact_phone", "contact_email", "account_id", "contact_id", "billing_address", "abn_acn")):
        raise ValidationError("Reload this application before saving so the project's Contact and Company details are retained.")


def _metadata(path, info, project, folder, payload):
    from .commercial_documents import commercial_cards
    estimate = project["estimate"]
    cards = project["commercial_cards"] if "commercial_cards" in project else commercial_cards(project.get("commercial_documents"))
    inside = folder is not None and path.is_relative_to(folder)
    relative = path.relative_to(folder).as_posix() if inside else path.name
    return {"id": _file_id(folder, relative) if inside else None, "name": path.name,
            "path": str(path), "relative_path": relative,
            "relative_folder": str(Path(relative).parent).replace("\\", "/") if inside else "",
            "title": estimate["title"], "project_no": estimate.get("project_no", ""),
            "client": estimate.get("client", ""), "site_address": estimate.get("site_address", ""),
            "account_id": estimate.get("account_id", ""), "contact_id": estimate.get("contact_id", ""),
            "source_project_id": project.get("source_project_id") or (project.get("certifications") or {}).get("project_id"),
            "commercial_cards": cards, "quote_cards": [card for card in cards if card['kind'] == 'quote'],
            "clients": project.get("clients", [estimate.get("client", "")]),
            "project_numbers": project.get("project_numbers", [estimate.get("project_no", "")]),
            "project_status": project.get("project_status", "Draft"),
            "estimates": [{"id": entry["id"], "name": entry["name"]} for entry in project.get("estimates", [{"id": "estimate-1", "name": "Estimate 1"}])],
            "active_estimate_id": project.get("active_estimate_id", "estimate-1"),
            "revision": hashlib.sha256(payload).hexdigest(),
            "modified_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(), "size": info.st_size}


@contextmanager
def _dialog():
    if not _DIALOG_LOCK.acquire(blocking=False):
        raise ValidationError("A file chooser is still starting or waiting on this computer. Check behind the browser. If no window appears, wait 20 seconds and try again.")
    try:
        yield
    finally:
        _DIALOG_LOCK.release()


def _project_save_path(selection):
    if not isinstance(selection, SaveSelection) or not isinstance(selection.path, str):
        raise ValidationError("The native file dialog returned an invalid selection.")
    path = Path(selection.path)
    if not path.is_absolute() or not is_project_filename(path.name) or ".." in path.parts:
        raise ValidationError("Save the project as a .cf.json file in an existing folder.")
    return path


def _atomic_write(selection, payload):
    path = _project_save_path(selection)
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
    def __init__(self, store, dialogs=None, *, takeoffs=None, certifications=None, documentation=None, edition='full', project_details=None):
        self.edition = validate_edition(edition)
        if self.edition == 'standard' and takeoffs is not None:
            raise ValidationError('The standard edition cannot attach a TAKEOFFS service.')
        self.store = store
        self.takeoffs = takeoffs
        self.certifications = certifications
        self.documentation = documentation
        self.project_details = project_details
        self.commercial = None
        self.swms = None
        self.dialogs = dialogs if dialogs is not None else NativeDialogs()
        self._lock = threading.RLock()
        self._cache = {}
        self._scan = None
        # Only native selections and validated folder loads grant write access.
        # Browser requests receive opaque, session-only capabilities, never a
        # writable path argument. Each successful Save consumes its capability.
        self._save_targets = {}
        self._commercial_sources = CommercialSources(store, project_details)
        self._commercial_walk = None
        self._outside_file_cache = {}

    def _capture_takeoffs(self, request):
        prepared = self._capture_workspace(request)
        if "estimates" in request or "active_estimate_id" in request:
            entries = request.get("estimates")
            if not isinstance(entries, list) or not 1 <= len(entries) <= 50:
                raise ValidationError("Include the complete project estimate collection.")
            captured = []
            for entry in entries:
                if not isinstance(entry, dict) or set(entry) != {"id", "name", "workspace"}:
                    raise ValidationError("Each project estimate requires its ID, name and workspace.")
                workspace = entry["workspace"]
                if not isinstance(workspace, dict) or set(workspace) - WORKSPACE_FIELDS - {"takeoffs_session_id"}:
                    raise ValidationError("An estimate contains unsupported workspace fields.")
                captured.append({**entry, "workspace": self._capture_workspace(workspace)})
            prepared["estimates"] = estimate_descriptors(captured, request.get("active_estimate_id"))
        return prepared

    def restore_import(self, project):
        return self._restore_takeoffs(project, None)

    def prepare_estimate(self, request):
        if not isinstance(request, dict) or set(request) - WORKSPACE_FIELDS - {'takeoffs_session_id'}:
            raise ValidationError('Include one complete estimate workspace only.')
        captured = self._capture_workspace(request)
        prepared = load_project_bytes(self.store, export_project(self.store, captured, edition=self.edition), edition=self.edition)
        if 'takeoffs_session_id' in request:
            prepared['takeoffs_session_id'] = request['takeoffs_session_id']
        return prepared

    def _preserve_estimates(self, path, request):
        """Apply existing overwrite guards to the same estimate across a switch."""
        payload, _ = _read_file(path)
        assert_project_overwrite(payload, edition=self.edition)
        if not has_project_identity(payload):
            return request
        try:
            previous = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return request
        if isinstance(previous, dict):
            _preserve_project_contacts(request, previous)
        if not isinstance(previous, dict) or ('estimates' not in previous and 'estimates' not in request):
            return request
        incoming = {entry['id']: entry['workspace'] for entry in request.get('estimates', [])}
        prior_entries = previous.get('estimates', [{'id':'estimate-1', 'workspace':previous}])
        for entry in prior_entries:
            workspace = incoming.get(entry['id'])
            if workspace is None:
                raise ValidationError('Reload the project before saving so every named estimate is retained.')
            for key in WORKSPACE_FIELDS:
                if key in entry['workspace'] and key not in workspace:
                    raise ValidationError('Reload the project before saving so every estimate workspace is complete.')
            if not set(entry['workspace']['calculators']) <= set(workspace['calculators']):
                raise ValidationError('Reload all calculators for each project estimate before saving.')
            _preserve_penetration_inputs(path, workspace, previous_snapshot=entry['workspace'])
            _preserve_project_contacts(workspace, entry['workspace'])
        active = incoming[previous.get('active_estimate_id', 'estimate-1')]
        return {**{key: value for key, value in request.items() if key not in WORKSPACE_FIELDS}, **active}

    def _capture_workspace(self, request):
        """Do not let a browser manufacture evidence paths or confirmation state."""
        require_project_edition(request, self.edition)
        if not isinstance(request, dict):
            raise ValidationError('Include the complete project as an object.')
        prepared = {key: value for key, value in request.items() if key != 'takeoffs_session_id'}
        if 'takeoffs' in prepared:
            if self.takeoffs is None:
                raise ValidationError('Takeoff workspace is unavailable. Reopen the project in the current application.')
            prepared['takeoffs'] = self.takeoffs.capture(request.get('takeoffs_session_id'), prepared['takeoffs'])
        elif 'takeoffs_session_id' in request:
            raise ValidationError('Include the takeoff snapshot with its workspace selection.')
        if 'certifications' in prepared:
            if self.certifications is None:
                raise ValidationError('The project certificate workspace is unavailable. Reopen the project in the current application.')
            prepared['certifications'] = self.certifications.capture(prepared['certifications'])
        if 'documentation' in prepared:
            incoming = request['documentation']
            certificate = request.get('certifications')
            if (self.documentation is None or not isinstance(incoming, dict) or not isinstance(certificate, dict)
                    or incoming.get('workspace_id') != certificate.get('workspace_id')):
                raise ValidationError('Capture document history with the same explicit project workspace as the current project.')
            prepared['documentation'] = self.documentation.capture(incoming)
        if 'swms' in prepared:
            workspace_id = request.get('certifications', {}).get('workspace_id')
            if self.swms is None or not workspace_id:
                raise ValidationError('SWMS require their current project workspace.')
            prepared['swms'] = self.swms.capture(workspace_id, request['swms'])
        if 'commercial_documents' in prepared:
            workspace_id = request.get('certifications', {}).get('workspace_id')
            if self.commercial is None or not workspace_id:
                raise ValidationError('Commercial documents require their current project workspace.')
            prepared['commercial_documents'] = self.commercial.capture(workspace_id, request['commercial_documents'])
        return prepared

    def _publish_takeoffs(self, request, path):
        prepared = dict(request)
        if 'takeoffs' in request and 'estimates' not in request:
            prepared['takeoffs'] = self.takeoffs.documents.publish(request['takeoffs'], path)
        if 'certifications' in request:
            prepared['certifications'] = self.certifications.publish(request['certifications'], path)
        if 'commercial_documents' in request:
            self.commercial.files.transfer(request['commercial_documents'], path)
        if 'documentation' in request:
            prepared['documentation'] = self.documentation.publish(request['documentation'], path)
        if 'estimates' in request:
            prepared['estimates'] = [{**entry, 'workspace': self._publish_takeoffs(entry['workspace'], path)} for entry in request['estimates']]
            active = next(entry['workspace'] for entry in prepared['estimates'] if entry['id'] == request['active_estimate_id'])
            for key in WORKSPACE_FIELDS:
                prepared.pop(key, None)
            prepared.update(active)
        return prepared

    def _saved_takeoff_source(self, request, captured, path):
        if 'estimates' in captured:
            requests = {entry['id']: entry['workspace'] for entry in request['estimates']}
            warnings = [self._saved_takeoff_source(requests[entry['id']], entry['workspace'], path) for entry in captured['estimates']]
            return next((warning for warning in warnings if warning), None)
        if 'takeoffs' not in captured:
            return None
        try:
            self.takeoffs.saved_source(request['takeoffs_session_id'], captured['takeoffs'], path)
        except Exception:
            # JSON and its assets are already committed. Report the actual save
            # result while requiring the saved evidence to be reopened.
            return 'The project was saved, but its evidence session could not be rebound. Reopen the saved project before continuing takeoff work.'
        return None

    def _activate_saved_documents(self, request, project):
        """A completed file save grants creation only to its captured workspace."""
        incoming = request.get('certifications')
        if self.certifications is None or not isinstance(incoming, dict):
            return
        token = incoming.get('workspace_id')
        if not token:
            return
        expected = (project.get('certifications') or {}).get('project_id')
        try:
            if expected != self.certifications.project_id(token):
                raise ValidationError('The saved project document workspace changed.')
            self.certifications.activate_created_project(token, project['estimate'].get('project_no', ''))
        except ValidationError:
            # The file is already committed. A concurrently discarded capability
            # must not be revived or turn this receipt into a false save failure.
            return 'The project was saved, but its document workspace changed. Reload the saved project before creating documents.'

    def _restore_takeoffs(self, project, path):
        require_project_edition(project, self.edition)
        workspace = None
        restored_sessions = []
        try:
            if self.certifications is not None:
                workspace = self.certifications.restore(project.get('certifications'), path)
                project = {**project, 'certification_workspace_id': workspace['workspace_id']}
            if 'documentation' in project and (self.documentation is None or workspace is None):
                raise ValidationError('Open this saved document history in the current application with its project workspace.')
            if self.documentation is not None and workspace is not None:
                self.documentation.restore(project.get('documentation'), workspace['workspace_id'], path)
            if self.swms is not None and workspace is not None:
                self.swms.restore(workspace['workspace_id'], project.get('swms'))
            elif 'swms' in project:
                raise ValidationError('Open this project with its SWMS workspace available.')
            if self.commercial is not None and workspace is not None:
                self.commercial.files.transfer(project.get('commercial_documents'), path, restore=True)
                self.commercial.restore(workspace['workspace_id'], project.get('commercial_documents'))
                if path:
                    with self.commercial._connect() as db:
                        self.commercial.unfiled.bind_file(db, workspace['workspace_id'])
            elif 'commercial_documents' in project:
                raise ValidationError('Open this project with its commercial document workspace available.')
            if workspace is not None and path is not None:
                self.certifications.activate_created_project(workspace['workspace_id'], project['estimate'].get('project_no', ''))
            if 'estimates' in project:
                entries = []
                for entry in project['estimates']:
                    child = dict(entry['workspace'])
                    if 'takeoffs' in child:
                        if self.takeoffs is None:
                            raise ValidationError('This application cannot open an estimate with takeoffs.')
                        session = self.takeoffs.open(child['takeoffs'], source_path=path)
                        restored_sessions.append(session['session_id'])
                        child.update(takeoffs=session['snapshot'], takeoffs_session_id=session['session_id'], takeoffs_issues=session.get('issues', []))
                    entries.append({**entry, 'workspace': child})
                project['estimates'] = entries
                active = next(entry['workspace'] for entry in entries if entry['id'] == project['active_estimate_id'])
                for key in WORKSPACE_FIELDS | {'fields', 'takeoffs_session_id', 'takeoffs_issues'}:
                    project.pop(key, None)
                    if key in active:
                        project[key] = active[key]
                if self.project_details:
                    self.project_details.register_existing(project, workspace.get('project_id') if workspace else None)
                return project
            if 'takeoffs' not in project:
                if self.project_details:
                    self.project_details.register_existing(project, workspace.get('project_id') if workspace else None)
                return project
            if self.takeoffs is None:
                raise ValidationError('This application cannot open a takeoff workspace.')
            session = self.takeoffs.open(project['takeoffs'], source_path=path)
            result = {**project, 'takeoffs': session['snapshot'],
                      'takeoffs_session_id': session['session_id'], 'takeoffs_issues': session.get('issues', [])}
            if self.project_details:
                self.project_details.register_existing(result, workspace.get('project_id') if workspace else None)
            return result
        except Exception:
            for session_id in restored_sessions:
                self.takeoffs.close(session_id)
            if workspace is not None:
                self.certifications.discard(workspace['workspace_id'])
            raise

    def _preserve_takeoffs(self, path, request):
        previous, _ = _read_file(path)
        assert_project_overwrite(previous, edition=self.edition)
        try:
            snapshot = json.loads(previous)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return
        if isinstance(snapshot, dict) and snapshot.get('format') == 'ceasefire-project':
            if 'estimates' in snapshot:
                previous = {entry['id'] for entry in snapshot['estimates']}
                incoming = {entry['id'] for entry in request.get('estimates', [])}
                if not previous <= incoming:
                    raise ValidationError('Reload this project before saving so every named estimate is retained.')
            if 'swms' in snapshot and 'swms' not in request:
                raise ValidationError('Reload this project before saving so its SWMS are retained.')
            if 'commercial_documents' in snapshot and 'commercial_documents' not in request:
                raise ValidationError('Reload this project before saving so its commercial documents are retained.')
        if isinstance(snapshot, dict) and snapshot.get('format') == 'ceasefire-project' and 'takeoffs' in snapshot and 'takeoffs' not in request:
            raise ValidationError('Reload this project before saving; this window has not loaded its takeoffs.')
        if isinstance(snapshot, dict) and snapshot.get('format') == 'ceasefire-project' and 'certifications' in snapshot and 'certifications' not in request:
            raise ValidationError('Reload this project before saving; this window has not loaded its certificates. No saved revisions were removed.')
        if isinstance(snapshot, dict) and snapshot.get('format') == 'ceasefire-project' and 'documentation' in snapshot and 'documentation' not in request:
            raise ValidationError('Reload this project before saving; this window has not loaded its document history. No revisions were removed.')

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
        discovered = []
        consumed = processed = inspected = 0
        deadline = time.monotonic() + MAX_SCAN_SECONDS
        # Yield between filesystem operations so a cold/cloud-backed directory
        # can show partial results. A single OS call can still block independently.
        while (inspected < MAX_SCAN_ENTRIES and processed < MAX_PROJECT_FILES
               and (inspected == 0 or time.monotonic() < deadline)):
            path = scan["deferred"]
            if path is not None:
                # Consume before inspecting: a file can become a directory,
                # link or non-project entry between continuation requests.
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
                # Reserved companion stores contain immutable evidence, never
                # project library entries. Do not enumerate or hydrate them.
                if entry.name.casefold() == ".ceasefire-evidence":
                    continue
                # Ignore every other file type before stat, reading or project
                # validation. Real directories are retained for traversal;
                # unrelated files and links cannot flood the project errors.
                if not is_project_filename(entry.name):
                    try:
                        if not entry.is_dir(follow_symlinks=False):
                            continue
                    except OSError:
                        continue
            relative = path.relative_to(scan["folder"]).as_posix()
            try:
                info = path.lstat()
                if _linked(info):
                    raise ValidationError("Linked files and folders are not followed. Move the project into this estimates folder to include it.")
                if stat.S_ISDIR(info.st_mode):
                    scan["directories"].append(path)
                    continue
                if not is_project_filename(path.name):
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
                            value = _metadata(path, info, project_summary(payload, edition=self.edition), scan["folder"], payload)
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
                    discovered.append(value)
                processed += 1
                scan["json_files"] += 1
            except (OSError, ValidationError) as error:
                scan["errors"].append({"name": relative, "error": str(error)})
            scan["deferred"] = None
        self._commercial_sources.remember(discovered)
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
        project = load_project_bytes(self.store, payload, edition=self.edition)
        project = self._restore_takeoffs(project, path)
        return {**project, "file": self._authorize_save(path, info, payload, _metadata(path, info, project, folder, payload))}

    def scheduler_project(self, identifier):
        """Read the current project stage and address without opening a workspace."""
        with self._lock:
            _, path = self._project_path(identifier)
            payload, _ = _read_file(path)
            project = project_summary(payload, edition=self.edition)
            return {"id": identifier, "title": project["estimate"]["title"],
                    "site_address": project["estimate"].get("site_address", ""),
                    "project_status": project["project_status"]}

    def read_details(self, request):
        """Read only selected project identity; never open or apply its workspace."""
        if not isinstance(request, dict) or set(request) != {"id"}:
            raise ValidationError("Choose a project from the linked folder.")
        with self._lock:
            _, path = self._project_path(request["id"])
            payload, info = _read_file(path)
            summary = project_summary(payload, edition=self.edition)
            metadata = _metadata(path, info, summary, self._scan["folder"], payload)
            return {"id": metadata["id"], "revision": metadata["revision"],
                    "project_id": summary.get("source_project_id"),
                    "details": validate_quote_details(summary["estimate"]), "file": metadata}

    def save_details(self, request, *, accounts):
        """Conditionally update shared identity only, preserving all workspace data."""
        from .contacts import company_key
        from .project_details import request_id
        if not isinstance(request, dict) or set(request) != {"id", "revision", "details", "request_id"}:
            raise ValidationError("Include the selected project, revision, complete details and request ID only.")
        identifier = request_id(request["request_id"])
        if not isinstance(request["revision"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["revision"]):
            raise ValidationError("Reload the selected project's details before saving.")
        if not isinstance(request["details"], dict) or set(request["details"]) != set(QUOTE_DETAIL_LIMITS):
            raise ValidationError("Include all project detail fields only.")
        details = validate_quote_details(request["details"])
        # Account directory access happens outside the project lock; lead conversion
        # can hold the directory transaction while creating a project.
        directory = accounts.list() if details["account_id"] or details["contact_id"] else None
        account_valid = contact_valid = True
        if details["account_id"]:
            account = next((row for row in directory["accounts"] if row["id"] == details["account_id"]), None)
            account_valid = account is not None and company_key(account["company"]) == company_key(details["client"])
        if details["contact_id"]:
            contact = next((row for row in directory["contacts"] if row["id"] == details["contact_id"]), None)
            contact_valid = contact is not None and contact["name"] == details["contact_name"]
        digest = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        with self._lock:
            _, path = self._project_path(request["id"])
            payload, info = _read_file(path)
            revision = hashlib.sha256(payload).hexdigest()
            summary = project_summary(payload, edition=self.edition)
            receipts = getattr(self, "_details_receipts", {})
            receipt = receipts.get(identifier)
            if receipt is not None and receipt != (digest, str(path), revision):
                raise ProjectDetailsConflict("This project details request has changed or the project was edited again. Reopen its pane.")
            if receipt is None and revision != request["revision"]:
                raise ProjectDetailsConflict("The project changed. Reopen its details before saving.")
            previous = validate_quote_details(summary["estimate"])
            if not account_valid and any(details[key] != previous[key] for key in ("account_id", "client")):
                raise ValidationError("Choose an existing Company for this Client, or add a new Company.")
            if not contact_valid and any(details[key] != previous[key] for key in ("contact_id", "contact_name")):
                raise ValidationError("Choose an existing Contact for this name, or enter the name without a Contact link.")
            if details["project_no"] != previous["project_no"]:
                raise ValidationError("Project numbers are assigned automatically and cannot be changed here.")
            if not details["account_id"] and details["client"] != previous["client"] and details["client"]:
                raise ValidationError("Choose an existing Company for this Client, or add a new Company.")
            if receipt is None:
                snapshot = json.loads(payload.decode("utf-8-sig"))
                estimates = [snapshot["estimate"], *[entry["workspace"]["estimate"] for entry in snapshot.get("estimates", [])]]
                for estimate in estimates:
                    number = estimate.get("project_no", "")
                    estimate.update(details)
                    # Imported historical collections can retain distinct numbers.
                    # The pane must not rewrite any estimate's immutable number.
                    estimate["project_no"] = number
                    estimate["title"] = compose_quote_title(**{key: estimate[key] for key in ("project_no", "client", "site_address")}, fallback=estimate.get("title"))
                updated = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
                if len(updated) > MAX_PROJECT_FILE:
                    raise ValidationError("The updated project exceeds the 16 MB file limit.")
                # Validate identity/collection structure without recalculating or
                # re-exporting pricing, attachments, or issued document snapshots.
                summary = project_summary(updated, edition=self.edition)
                selection = SaveSelection(str(path), {"size": info.st_size, "mtime_ns": info.st_mtime_ns, "sha256": revision})
                path, info = _atomic_write(selection, updated)
                payload = updated
                revision = hashlib.sha256(payload).hexdigest()
                receipts[identifier] = (digest, str(path), revision)
                while len(receipts) > 256:
                    receipts.pop(next(iter(receipts)))
                self._details_receipts = receipts
            folder = self._scan["folder"]
            metadata = _metadata(path, info, summary, folder, payload)
            self._scan["files"][metadata["id"]] = metadata
            self._cache.pop((str(folder), str(path)), None)
            return {"id": metadata["id"], "revision": revision,
                    "project_id": summary.get("source_project_id"), "details": details,
                    "file": self._authorize_save(path, info, payload, metadata)}

    def update_status(self, request):
        """Change only the portable status, with a required last-read revision."""
        if not isinstance(request, dict) or set(request) not in ({"id", "revision", "project_status"}, {"save_token", "revision", "project_status"}):
            raise ValidationError("Include the selected project, revision and status only.")
        status = validate_project_status(request["project_status"])
        with self._lock:
            token = request.get("save_token")
            if "save_token" in request:
                selection = self._save_targets.get(token) if isinstance(token, str) else None
                if selection is None:
                    raise ValidationError("The project selection is no longer available. Reload the project.")
                path = _project_save_path(selection)
                if file_fingerprint(path) != selection.fingerprint:
                    raise ValidationError("The project changed. Reload it before changing its status.")
            else:
                _, path = self._project_path(request["id"])
            payload, info = _read_file(path)
            revision = hashlib.sha256(payload).hexdigest()
            if not isinstance(request["revision"], str) or request["revision"] != revision:
                raise ValidationError("The project changed. Refresh the project list before changing its status.")
            project = load_project_bytes(self.store, payload, edition=self.edition)
            snapshot = json.loads(payload.decode("utf-8-sig"))
            snapshot["project_status"] = status
            updated = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
            if len(updated) > MAX_PROJECT_FILE:
                raise ValidationError("The updated project exceeds the 16 MB file limit.")
            selection = SaveSelection(str(path), {"size": info.st_size, "mtime_ns": info.st_mtime_ns, "sha256": revision})
            path, info = _atomic_write(selection, updated)
            project["project_status"] = status
            selected_folder = self.store.project_folder()
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = _metadata(path, info, project, folder, updated)
            if self._scan is not None and self._scan["folder"] == folder and metadata["id"]:
                self._scan["files"][metadata["id"]] = metadata
                self._cache.pop((str(folder), str(path)), None)
            if token is not None:
                del self._save_targets[token]
            return {"file": self._authorize_save(path, info, updated, metadata)}

    def delete_project(self, request):
        """Remove a project from the board while retaining recoverable file bytes."""
        if not isinstance(request, dict) or set(request) != {"id", "revision"}:
            raise ValidationError("Include the selected project and revision only.")
        with self._lock:
            _, path = self._project_path(request["id"])
            payload, info = _read_file(path)
            revision = hashlib.sha256(payload).hexdigest()
            if not isinstance(request["revision"], str) or request["revision"] != revision:
                raise ValidationError("The project changed. Refresh the project list before deleting it.")
            load_project_bytes(self.store, payload, edition=self.edition)
            expected = {"size": info.st_size, "mtime_ns": info.st_mtime_ns, "sha256": revision}
            folder = _directory(path.parent)
            if file_fingerprint(path) != expected:
                raise ValidationError("The project changed. Refresh the project list before deleting it.")
            retained = folder / (".ceasefire-deleted-" + secrets.token_hex(16) + ".json")
            try:
                path.rename(retained)
            except OSError as error:
                raise ValidationError("The project could not be deleted. Check folder permissions and retry.") from error
            self._scan["files"].pop(request["id"], None)
            self._commercial_sources.delete(path)
            self._commercial_walk = None
            self._cache.pop((str(self._scan["folder"]), str(path)), None)
            return {"deleted": True, "retained_file": str(retained)}

    def _project_path(self, identifier):
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
        try:
            info = path.lstat()
        except OSError as error:
            raise ValidationError("The project is no longer available. Refresh the list.") from error
        if _linked(info) or not stat.S_ISREG(info.st_mode):
            raise ValidationError("The project is no longer a regular file. Refresh the list.")
        return value, path

    @staticmethod
    def _relative_parts(value, *, allow_empty):
        if not isinstance(value, str) or len(value) > 2000 or "\\" in value:
            raise ValidationError("Choose a file or folder shown on the project files page.")
        if value == "" and allow_empty:
            return ()
        parts = value.split("/")
        if not parts or any(not part or part in {".", ".."} for part in parts):
            raise ValidationError("Choose a file or folder shown on the project files page.")
        try:
            return tuple(_attachment_filename(part) for part in parts)
        except ValidationError as error:
            raise ValidationError("Choose a file or folder shown on the project files page.") from error

    def _project_entry(self, identifier, relative_path, *, directory):
        project, project_path = self._project_path(identifier)
        root = _directory(project_path.parent)
        parts = self._relative_parts(relative_path, allow_empty=directory)
        candidate = root.joinpath(*parts)
        if directory:
            candidate = _directory(candidate)
            if not candidate.is_relative_to(root):
                raise ValidationError("Choose a folder within this project folder.")
            return project, project_path, root, candidate
        parent = _directory(candidate.parent)
        candidate = parent / candidate.name
        if not candidate.is_relative_to(root):
            raise ValidationError("Choose a file within this project folder.")
        try:
            info = candidate.lstat()
        except OSError as error:
            raise ValidationError("That project file is no longer available. Refresh the folder.") from error
        if _linked(info) or not stat.S_ISREG(info.st_mode):
            raise ValidationError("Choose a regular file shown on the project files page.")
        return project, project_path, root, candidate

    def browse_files(self, request):
        if not isinstance(request, dict) or set(request) != {"id", "relative_path"}:
            raise ValidationError("Choose a project and folder from the project files page.")
        project, project_path, root, directory = self._project_entry(
            request["id"], request["relative_path"], directory=True)
        entries, errors = [], []
        try:
            with os.scandir(directory) as stream:
                for entry in stream:
                    path = Path(entry.path)
                    relative = path.relative_to(root).as_posix()
                    try:
                        info = path.lstat()
                        if _linked(info):
                            raise ValidationError("Linked files and folders are not opened.")
                        if stat.S_ISDIR(info.st_mode):
                            entries.append({"type": "folder", "name": path.name, "relative_path": relative})
                        elif stat.S_ISREG(info.st_mode):
                            entries.append({"type": "file", "name": path.name, "relative_path": relative,
                                            "size": info.st_size,
                                            "modified_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat()})
                    except (OSError, ValidationError) as error:
                        errors.append({"name": path.name, "error": str(error)})
        except OSError as error:
            raise ValidationError("This project folder cannot be read. Check its permissions and try again.") from error
        entries.sort(key=lambda item: (item["type"] != "folder", item["name"].casefold()))
        return {"project": {"id": request["id"], "title": project["title"], "name": project_path.name},
                "relative_path": directory.relative_to(root).as_posix() if directory != root else "",
                "entries": entries, "errors": errors}

    def open_project_file(self, request):
        if not isinstance(request, dict) or set(request) != {"id", "relative_path"}:
            raise ValidationError("Choose a project file from the project files page.")
        _, _, root, path = self._project_entry(request["id"], request["relative_path"], directory=False)
        try:
            _open_default_file(path)
        except OSError as error:
            raise ValidationError("The file could not be opened in its default application.") from error
        return {"opened": True, "name": path.name, "relative_path": path.relative_to(root).as_posix()}

    def _authorize_save(self, path, info, payload, metadata):
        token = secrets.token_urlsafe(32)
        fingerprint = {"size": info.st_size, "mtime_ns": info.st_mtime_ns,
                       "sha256": hashlib.sha256(payload).hexdigest()}
        with self._lock:
            self._save_targets[token] = SaveSelection(str(path), fingerprint)
            self._commercial_sources.remember([metadata])
            self._commercial_walk = None
        return {**metadata, "save_token": token}

    def capture_download(self, request, *, project_id=None):
        """Bind an export to its requesting window's selected file, not global state."""
        from .download_files import DownloadDestination, standard_downloads_directory
        if not isinstance(request, dict) or set(request) != {'project_token'}:
            raise ValidationError('Download options must contain the current project token only.')
        token = request['project_token']
        if token is None:
            if project_id is not None:
                raise ValidationError('Save this project before downloading its commercial documents.')
            return DownloadDestination(standard_downloads_directory(), 'downloads')
        if not isinstance(token, str) or not 1 <= len(token) <= 200:
            raise ValidationError('The download project selection is invalid. Reload the project or use Save As.')
        with self._lock:
            selection = self._save_targets.get(token)
            if selection is None:
                raise ValidationError('The download project selection is no longer available. Reload the project or use Save As.')
            if file_fingerprint(selection.path) != selection.fingerprint:
                raise ValidationError('The project file changed or was removed. Reload it or use Save As before downloading.')
            if project_id is not None:
                payload, _ = _read_file(selection.path)
                if hashlib.sha256(payload).hexdigest() != selection.fingerprint['sha256']:
                    raise ValidationError('The project file changed before its document workspace could be checked. Reload it.')
                snapshot = json.loads(payload.decode('utf-8-sig'))
                from .certification_projects import validate_manifest
                manifest = snapshot.get('certifications')
                if not isinstance(manifest, dict):
                    raise ValidationError('Save the current project before downloading its commercial documents.')
                if validate_manifest(manifest)['project_id'] != project_id:
                    raise ValidationError('The document workspace belongs to a different project. Save or reload this project before downloading.')
            return DownloadDestination(_directory(Path(selection.path).parent), 'project')

    def save_attachment(self, request):
        """Save an uploaded file beside the project selected by an opaque capability."""
        if not isinstance(request, dict) or set(request) != {"project_token", "filename", "content_base64"}:
            raise ValidationError("Include the current saved project and one file to upload.")
        token = request["project_token"]
        if not isinstance(token, str):
            raise ValidationError('There is no saved project. Please click "Save As" and select a project folder.')
        filename = _attachment_filename(request["filename"])
        if filename.casefold() == '.ceasefire-evidence':
            raise ValidationError('This filename is reserved for portable project evidence and document revisions.')
        payload = _decode_attachment(request["content_base64"])
        with self._lock:
            selection = self._save_targets.get(token)
            if selection is None:
                raise ValidationError('The saved project is no longer available. Please click "Save As" again.')
            if file_fingerprint(selection.path) != selection.fingerprint:
                raise ValidationError('The project file changed or was removed. Reload it or use Save As before uploading files.')
            folder = _directory(Path(selection.path).parent)
            if is_project_filename(filename):
                stem, suffix = filename[:-len(PROJECT_EXTENSION)], filename[-len(PROJECT_EXTENSION):]
            else:
                stem, suffix = Path(filename).stem, Path(filename).suffix
            path, identity = None, None
            try:
                for number in range(10000):
                    candidate = folder / (filename if number == 0 else f"{stem} ({number}){suffix}")
                    try:
                        descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                             | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600)
                    except FileExistsError:
                        continue
                    path = candidate
                    with os.fdopen(descriptor, "wb") as stream:
                        info = os.fstat(stream.fileno())
                        if _linked(info) or not stat.S_ISREG(info.st_mode):
                            raise OSError("The created destination is not a regular file.")
                        identity = info.st_dev, info.st_ino
                        stream.write(payload)
                        stream.flush()
                        os.fsync(stream.fileno())
                    _directory(folder)
                    return {"saved": True, "path": str(path), "filename": path.name,
                            "original_filename": filename, "size": len(payload)}
                raise ValidationError("Too many files share this name. Rename the file and try again.")
            except (OSError, ValidationError) as error:
                if path is not None and identity is not None:
                    try:
                        info = path.lstat()
                        if (info.st_dev, info.st_ino) == identity:
                            path.unlink()
                    except OSError:
                        pass
                if isinstance(error, ValidationError):
                    raise
                raise ValidationError("The file could not be saved to the project folder. Check its permissions and available disk space, then try again.") from error

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
            if not path.is_absolute() or ".." in path.parts or not is_project_filename(path.name):
                raise ValidationError("Choose a .cf.json project file in an accessible folder.")
            payload, info = _read_file(path)
            project = load_project_bytes(self.store, payload, edition=self.edition)
            project = self._restore_takeoffs(project, path)
            selected_folder = self.store.project_folder()
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = self._authorize_save(path, info, payload, _metadata(path, info, project, folder, payload))
            return {"cancelled": False, **project, "file": metadata}

    def save(self, request):
        require_project_edition(request, self.edition)
        required = {"save_token", "estimate", "calculators"}
        if not isinstance(request, dict) or not required <= set(request) or set(request) - required - {"penetration", "takeoffs", "takeoffs_session_id", "library_drafts", "certifications", "documentation", "project_status", "estimates", "active_estimate_id", "commercial_documents", "swms"}:
            raise ValidationError("Save requires the current project selection and its complete estimate and calculators.")
        if (not isinstance(request["calculators"], dict)
                or not set(LEGACY_CALCULATOR_IDS) <= set(request["calculators"])
                or set(request["calculators"]) - set(CALCULATOR_IDS)):
            raise ValidationError("Save must include the three original calculator drafts and any loaded steel intumescent draft.")
        if (not isinstance(request["estimate"], dict) or not ESTIMATE_REQUIRED_FIELDS <= set(request["estimate"])
                or set(request["estimate"]) - ESTIMATE_FIELDS):
            raise ValidationError("Save must include the complete estimate inputs and pricing snapshot.")
        token = request["save_token"]
        if not isinstance(token, str):
            raise ValidationError('Choose the project with Load Project or "Save As" before using Save.')
        with self._lock:
            selection = self._save_targets.get(token)
            if selection is None:
                raise ValidationError('This project selection is no longer available. Use Load Project or "Save As".')
            selected_path = _project_save_path(selection)
        captured = self._capture_takeoffs({key: request[key] for key in ("estimate", "calculators", "penetration", "takeoffs", "takeoffs_session_id", "library_drafts", "certifications", "documentation", "project_status", "estimates", "active_estimate_id", "commercial_documents", "swms") if key in request})
        if "project_status" not in captured:
            if file_fingerprint(selected_path) != selection.fingerprint:
                raise ValidationError('The project file changed or was removed outside this window. Reload it or use "Save As".')
            existing, _ = _read_file(selected_path)
            captured["project_status"] = project_summary(existing, edition=self.edition)["project_status"]
        payload = export_project(self.store, captured, edition=self.edition)
        project = load_project_bytes(self.store, payload, edition=self.edition)
        # Serialize writes and recheck the capability after preparation so two
        # simultaneous requests cannot both consume one saved-file version.
        with self._lock:
            if self._save_targets.get(token) is not selection:
                raise ValidationError('The project was already saved by another request. Reload it or use "Save As".')
            path = selected_path
            if file_fingerprint(path) != selection.fingerprint:
                raise ValidationError('The project file changed or was removed outside this window. Reload it or use "Save As".')
            if self.project_details:
                from .project_details import numbers
                existing, _ = _read_file(path)
                prior = numbers(json.loads(existing))
                incoming = numbers(captured)
                if any(value != prior.get(key, value) or key not in prior and value not in set(prior.values()) for key, value in incoming.items()):
                    raise ValidationError('Existing project numbers cannot be edited. Reload this project to restore its saved numbers.')
            preservation = self._preserve_estimates(path, request)
            _preserve_penetration_inputs(path, preservation)
            _preserve_library_drafts(path, preservation)
            _preserve_optional_calculators(path, preservation)
            self._preserve_takeoffs(path, preservation)
            selected_folder = self.store.project_folder()
            if 'takeoffs' in captured or 'certifications' in captured or 'documentation' in captured or 'estimates' in captured:
                captured = self._publish_takeoffs(captured, path)
                payload = export_project(self.store, captured, edition=self.edition)
                project = load_project_bytes(self.store, payload, edition=self.edition)
            with self._commercial_publication(request, captured, selection, payload):
                path, info = _atomic_write(selection, payload)
            warning = self._saved_takeoff_source(request, captured, path)
            document_warning = self._activate_saved_documents(request, project)
            if document_warning:
                warning = (warning + ' ' if warning else '') + document_warning
            del self._save_targets[token]
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = _metadata(path, info, project, folder, payload)
            metadata["in_linked_folder"] = folder is not None and path.is_relative_to(folder)
            self.close()
            if folder is not None:
                self._start_scan(folder)
                if metadata["in_linked_folder"]:
                    self._scan["files"][metadata["id"]] = metadata
            else:
                self._scan = None
            metadata = self._authorize_save(path, info, payload, metadata)
        result = {"cancelled": False, "file": metadata, "folder": selected_folder, "project": project}
        if warning:
            result['warning'] = warning
        return result

    def _other_commercial_file(self, identifier, raw_path, project):
        path = Path(raw_path)
        _directory(path.parent)
        info = path.lstat()
        if _linked(info) or not stat.S_ISREG(info.st_mode) or not is_project_filename(path.name):
            raise ValidationError('The recorded source is no longer a regular project file.')
        previous = self._outside_file_cache.get(identifier)
        if previous and previous[0] == _identity(info) and previous[1]['source_project_id'] == project:
            return previous[1]
        payload, info = _read_file(path)
        summary = project_summary(payload, edition=self.edition)
        if summary['source_project_id'] != project:
            raise ValidationError('The recorded location now belongs to another project.')
        metadata = _metadata(path, info, summary, None, payload)
        self._outside_file_cache[identifier] = (_identity(info), metadata)
        return metadata

    @contextmanager
    def _commercial_publication(self, request, captured, selection, payload):
        workspace = request.get('certifications', {}).get('workspace_id')
        if not self.commercial or not workspace:
            yield
            return
        self.recover_commercial_publications()
        path = _project_save_path(selection)
        digest = hashlib.sha256(payload).hexdigest()
        self.commercial.unfiled.prepare_publication(workspace, path, digest, (selection.fingerprint or {}).get('sha256', ''))
        replaced = False
        try:
            with self.commercial.publishing(workspace, captured.get('commercial_documents')):
                yield
                replaced = True
        except Exception:
            if not replaced:
                self.commercial.unfiled.cancel_publication(workspace, path, digest)
            raise

    def recover_commercial_publications(self):
        # A power loss can interrupt the handover after the file rename but before
        # SQLite commits. Only the exact previously selected file and bytes prove
        # that the file took ownership; an older file at the same path does not.
        def verify(row):
            if row['project_id'] in self._commercial_sources.ignored_owners():
                return False
            path = Path(row['path'])
            try:
                payload, info = _read_file(path)
                if hashlib.sha256(payload).hexdigest() != row['digest']:
                    return False
                summary = project_summary(payload, edition=self.edition)
                if summary['source_project_id'] != row['project_id']:
                    return False
            except (ValidationError, OSError):
                return False
            self._commercial_sources.remember([_metadata(path, info, summary, None, payload)])
            self._commercial_walk = None
            return True
        if self.commercial:
            with self._lock:
                self.commercial.unfiled.recover_publications(verify)

    @staticmethod
    def _commercial_source_token(owner):
        return hashlib.sha256(('commercial-source-owner\0' + owner).encode('utf-8')).hexdigest()

    def commercial_source_metadata(self):
        """Known ownership labels only: no folder scan, stat, or project reads."""
        with self._lock:
            labels = {row[2]: row[3] for row in self._commercial_sources.records() if not row[4]}
            if self.commercial:
                for owner, title in self.commercial.issued_source_labels():
                    labels.setdefault(owner, title)
            ignored = self._commercial_sources.ignored_owners()
            return {'sources': [{'id': self._commercial_source_token(owner), 'title': title, 'ignored': owner in ignored}
                                for owner, title in sorted(labels.items())]}

    def ignore_commercial_source(self, token, *, ignored=True):
        with self._lock:
            owners = {row[2] for row in self._commercial_sources.records()}
            if self.commercial:
                owners.update(owner for owner, _ in self.commercial.issued_source_labels())
            owner = next((owner for owner in owners if self._commercial_source_token(owner) == token), None)
            if owner is None:
                raise ValidationError('Choose a registered project source to ignore.')
            self._commercial_sources.ignore_owner(owner, ignored)
            self._commercial_walk = None
            return {'ignored': ignored, 'id': token}

    def commercial_register(self, *, refresh=False, active_workspace=None):
        # Continue a cold external-file scan between requests. Only the linked
        # folder is enumerated; all other reads target a previously selected file.
        with self._lock:
            self.recover_commercial_publications()
            ignored = self._commercial_sources.ignored_owners()
            folder = self.store.project_folder()
            walk = self._commercial_walk
            if refresh or walk is None or walk['folder'] != folder:
                listing = self.listing(limit=200, refresh=refresh)
                if listing['scan_pending']:
                    self._commercial_walk = None
                    return {'documents': [], 'revisions': {}, 'scan_pending': True, 'error_count': listing['error_count'], 'unavailable_sources': []}
                linked = (list(self._scan['files'].values()) if folder and self._scan
                          and self._scan['folder'] == Path(folder) else [])
                files = {source_id(f['path']): f for f in linked if f['source_project_id'] not in ignored}
                records = self._commercial_sources.records()
                walk = {'folder': folder, 'files': files, 'errors': listing['error_count'], 'missing': [],
                        'known_owners': {row[2] for row in records},
                        'pending': deque(row for row in records if not row[4] and row[0] not in files and row[2] not in ignored)}
                self._commercial_walk = walk
            deadline = time.monotonic() + MAX_SCAN_SECONDS
            for _ in range(MAX_PROJECT_FILES):
                if not walk['pending']:
                    break
                identifier, path, owner, title, _deleted = walk['pending'].popleft()
                try:
                    walk['files'][identifier] = self._other_commercial_file(identifier, path, owner)
                except (OSError, ValidationError):
                    self._outside_file_cache.pop(identifier, None)
                    walk['missing'].append((owner, {'id': self._commercial_source_token(owner), 'title': title, 'path': path, 'reason': 'unavailable'}))
                if time.monotonic() >= deadline:
                    break
            if walk['pending']:
                return {'documents': [], 'revisions': {}, 'scan_pending': True, 'error_count': walk['errors'], 'unavailable_sources': []}
            self._commercial_walk = None
            files = walk['files']
            present = {f['source_project_id'] for f in files.values()}
            missing = [item for owner, item in walk['missing'] if owner not in present]
            documents = []
            for identifier, file in files.items():
                for card in file['commercial_cards']:
                    details = {key: file[key] for key in ('project_no', 'client', 'site_address')}
                    documents.append({**card, 'fields': {**card['fields'], 'details': {**card['fields']['details'], **details}},
                                      'source_file': file['id'] or identifier, 'source_revision': file['revision'], 'source_path': file['path']})
            if self.commercial:
                local_cards = self.commercial.unfiled.cards(active_workspace)
                documents.extend(local_cards)
                present.update(card['project_id'] for card in local_cards)
                self.commercial.apply_register_numbers(documents)
                for owner, title in self.commercial.issued_source_labels():
                    if owner not in present and owner not in walk['known_owners'] and owner not in ignored:
                        missing.append({'id': self._commercial_source_token(owner), 'title': title, 'reason': 'unlocated'})
            return {'documents': documents, 'revisions': {f['path']: f['revision'] for f in files.values()},
                    'scan_pending': False, 'error_count': walk['errors'], 'unavailable_sources': missing}

    def account_relation_projects(self):
        """Snapshot current authorized metadata after one bounded scan batch.

        Account links use stable project IDs. No caller-provided path is read,
        and explicitly ignored sources never enter this related-record catalog.
        """
        listing = self.listing(limit=1)
        with self._lock:
            ignored = self._commercial_sources.ignored_owners()
            folder = self.store.project_folder()
            linked = (list(self._scan['files'].values()) if folder and self._scan
                      and self._scan['folder'] == Path(folder) else [])
            registered = {row[0] for row in self._commercial_sources.records() if not row[4] and row[2] not in ignored}
            outside = [cached[1] for identifier, cached in self._outside_file_cache.items() if identifier in registered]
            return {**listing, 'files': [{**row, 'account_link_id': str(uuid.uuid5(uuid.NAMESPACE_URL,
                                            'classifire:account-project-file:' + source_id(row['path'])))} for row in (*linked, *outside)
                                        if row['source_project_id'] not in ignored]}

    def quote_register(self):
        register = self.commercial_register()
        register['documents'] = [doc for doc in register['documents'] if doc['kind'] == 'quote']
        return register

    @contextmanager
    def commercial_file(self, identifier, revision, *, find_issued=False):
        """Grant one conditional operation on a current or previously authorized owner file."""
        from .commercial_documents import CommercialConflict
        with self._lock:
            if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{64}', identifier):
                raise ValidationError('Choose a document from its board.')
            selected = self._commercial_sources.resolve(identifier)
            if selected:
                path = Path(selected[0])
                _directory(path.parent)
            else:
                # A previously opened tab can still hold a linked-folder file ID.
                _, path = self._project_path(identifier)
            payload, info = _read_file(path)
            actual_revision = hashlib.sha256(payload).hexdigest()
            if actual_revision != revision and not find_issued:
                raise CommercialConflict('The saved project changed. Reopen its board and select the document again.')
            summary = project_summary(payload, edition=self.edition)
            if selected and summary['source_project_id'] != selected[1]:
                raise CommercialConflict('This file now belongs to a different project. Load its current copy from Projects.')
            snapshot = json.loads(payload.decode('utf-8-sig'))
            def commit():
                updated = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, indent=2).encode('utf-8')
                if len(updated) > MAX_PROJECT_FILE:
                    raise ValidationError('The updated project exceeds the 16 MB file limit.')
                selection = SaveSelection(str(path), {'size': info.st_size, 'mtime_ns': info.st_mtime_ns, 'sha256': revision})
                _, after = _atomic_write(selection, updated)
                from .commercial_documents import commercial_cards
                summary['commercial_cards'] = commercial_cards(snapshot['commercial_documents'])
                folder = self._scan['folder'] if self._scan else None
                metadata = _metadata(path, after, summary, folder, updated)
                if folder is not None and metadata['id']:
                    self._scan['files'][metadata['id']] = metadata
                    self._cache.pop((str(folder), str(path)), None)
                self._outside_file_cache.pop(source_id(path), None)
                self._commercial_walk = None
                return metadata['revision']
            yield path, snapshot, actual_revision, commit

    def clients(self, *, refresh=False):
        """Continue the bounded linked-folder scan; never follow arbitrary paths."""
        listing = self.listing(limit=200, refresh=refresh)
        clients = {}
        with self._lock:
            records = list(self._scan['files'].values()) if self._scan else []
        for row in records:
            for value in row.get('clients', [row.get('client', '')]):
                if value.strip():
                    clients.setdefault(value.strip().casefold(), value.strip())
        if self.project_details:
            self.project_details.observe(value for row in records for value in row.get('project_numbers', [row.get('project_no', '')]))
        return {'clients': sorted(clients.values(), key=str.casefold), 'scan_pending': listing['scan_pending'],
                'error_count': listing['error_count'], 'errors': listing['errors']}

    @staticmethod
    def _apply_project_numbers(captured, values):
        from copy import deepcopy
        from .quote_details import compose_quote_title
        captured = deepcopy(captured)
        def apply(estimate, number):
            if estimate.get('project_no', '') != number:
                estimate['project_no'] = number
                estimate['title'] = compose_quote_title(number, estimate.get('client', ''), estimate.get('site_address', ''))
        if captured.get('estimates'):
            for entry in captured['estimates']:
                apply(entry['workspace']['estimate'], values[entry['id']])
            active = next(entry['workspace']['estimate'] for entry in captured['estimates'] if entry['id'] == captured['active_estimate_id'])
            captured['estimate'] = deepcopy(active)
        else:
            apply(captured['estimate'], values['estimate-1'])
        return captured

    def _saved_number_result(self, ticket, request=None):
        self.recover_commercial_publications()
        path = Path(ticket['path'])
        payload, info = _read_file(path)
        if hashlib.sha256(payload).hexdigest() != ticket['payload_hash']:
            raise ValidationError('The completed project save has since changed. Load the saved project before continuing.')
        project = load_project_bytes(self.store, payload, edition=self.edition)
        selected = self.store.project_folder()
        try:
            folder = _directory(selected) if selected else None
        except ValidationError:
            folder = None
        metadata = _metadata(path, info, project, folder, payload)
        metadata['in_linked_folder'] = folder is not None and path.is_relative_to(folder)
        result = {'cancelled': False, 'file': self._authorize_save(path, info, payload, metadata),
                  'folder': selected, 'project': project, 'replayed': True}
        warning = self._activate_saved_documents(request or {}, project)
        if warning:
            result['warning'] = warning
        return result

    def create_from_lead(self, lead):
        from .schedule_rows import empty_schedule_inputs
        if not self.store.project_folder():
            raise ValidationError('Link a folder in Projects before converting a lead.')
        notes = '\n'.join(f'{label}: {lead[key]}' for key, label in (
            ('name', 'Contact'), ('phone', 'Phone'), ('email', 'Email'), ('title', 'Title'),
            ('billing_address', 'Billing address'), ('description', 'Description')) if lead[key])
        request = {'project_save_request': lead['id'],
                   'estimate': {'client': lead['company'], 'site_address': lead['site_address'], 'measurements': notes,
                                'contact_name': lead['name'], 'contact_phone': lead['phone'],
                                'contact_email': lead['email'], 'billing_address': lead.get('billing_address', ''),
                                'abn_acn': lead.get('abn_acn', ''), 'account_id': lead.get('account_id') or '',
                                'contact_id': lead.get('contact_id') or ''},
                   'calculators': {key: {'inputs': empty_schedule_inputs(key)} for key in CALCULATOR_IDS}}
        result = self.save_as(request, linked_folder=True)
        return {'project_no': result['file']['project_no'], 'path': result['file']['path']}

    def save_as(self, request, *, linked_folder=False):
        if self.project_details is None:
            if linked_folder:
                raise ValidationError('Project numbering is unavailable.')
            return self._save_as(request)
        from .project_details import request_id
        if not isinstance(request, dict):
            raise ValidationError('Include the complete project as an object.')
        identifier = request_id(request.get('project_save_request', str(uuid.uuid4())))
        request = {key: value for key, value in request.items() if key != 'project_save_request'}
        captured = self._capture_takeoffs(request)
        # Complete validation still precedes reservations and native dialogs.
        load_project_bytes(self.store, export_project(self.store, captured, edition=self.edition), edition=self.edition)
        self.project_details.recover(_read_file)
        if not self.project_details.known(captured, identifier):
            # A file can arrive from another window or a synced folder after
            # the client dropdown was populated. Allocation must not rely on
            # that short-lived display cache. Re-scan metadata in bounded
            # batches; no calculator or report work is involved.
            discovered = self.clients(refresh=True)
            for _ in range(99):
                if not discovered['scan_pending']:
                    break
                discovered = self.clients()
            if discovered['scan_pending']:
                raise ValidationError('The project folder is still being read. Wait for the previous clients to finish loading and save again.')
            if discovered['error_count']:
                raise ValidationError('Resolve unreadable project files in the linked folder before assigning a new project number.')
        ticket = self.project_details.begin(identifier, captured)
        if ticket['replay']:
            return self._saved_number_result(ticket, request)
        prepared = self._apply_project_numbers(captured, json.loads(ticket['numbers_json']))
        try:
            result = self._save_as(request, captured=prepared, ticket=ticket, linked_folder=linked_folder)
            if result.get('cancelled'):
                self.project_details.cancel(identifier)
            return result
        except Exception:
            recovered = self.project_details.recover_request(identifier, _read_file)
            if recovered:
                return self._saved_number_result(recovered, request)
            self.project_details.cancel(identifier)
            raise

    def _save_as(self, request, *, captured=None, ticket=None, linked_folder=False):
        # No dialog or preference/file writes until the complete captured state is valid.
        captured = self._capture_takeoffs(request) if captured is None else captured
        payload = export_project(self.store, captured, edition=self.edition)
        project = load_project_bytes(self.store, payload, edition=self.edition)
        with _dialog():
            selected_folder = self.store.project_folder()
            filename = project_filename(project["estimate"]["title"])
            initial_directory = _quote_save_directory(selected_folder, filename)
            if linked_folder:
                if initial_directory is None:
                    raise ValidationError('Link a folder in Projects before converting a lead.')
                # New files only. The normal atomic writer rejects existing paths
                # even if an unrelated file arrives after project-number allocation.
                selection = SaveSelection(str(Path(initial_directory) / filename), None)
            else:
                selection = self.dialogs.choose_save(initial_directory, filename)
            if selection is None:
                return {"cancelled": True}
            selected_path = _project_save_path(selection)
            with self._lock:
                if isinstance(selection, SaveSelection) and selection.fingerprint is not None:
                    if "project_status" not in request:
                        if file_fingerprint(selected_path) != selection.fingerprint:
                            raise ValidationError("The selected file changed. Reload the project or use Save As to confirm its current contents.")
                        existing, _ = _read_file(selected_path)
                        if has_project_identity(existing):
                            captured["project_status"] = project_summary(existing, edition=self.edition)["project_status"]
                            payload = export_project(self.store, captured, edition=self.edition)
                            project = load_project_bytes(self.store, payload, edition=self.edition)
                    preservation = self._preserve_estimates(selected_path, request)
                    _preserve_penetration_inputs(selected_path, preservation)
                    _preserve_library_drafts(selected_path, preservation)
                    _preserve_optional_calculators(selected_path, preservation)
                    self._preserve_takeoffs(selected_path, preservation)
                if 'takeoffs' in captured or 'certifications' in captured or 'documentation' in captured or 'estimates' in captured:
                    captured = self._publish_takeoffs(captured, selected_path)
                    payload = export_project(self.store, captured, edition=self.edition)
                    project = load_project_bytes(self.store, payload, edition=self.edition)
                if ticket:
                    self.project_details.prepare(ticket['id'], selected_path, payload)
                with self._commercial_publication(request, captured, selection, payload):
                    path, saved_info = _atomic_write(selection, payload)
                if ticket:
                    self.project_details.finish(ticket['id'])
                warning = self._saved_takeoff_source(request, captured, path)
                document_warning = self._activate_saved_documents(request, project)
                if document_warning:
                    warning = (warning + ' ' if warning else '') + document_warning
            if selected_folder is None:
                try:
                    self.store.set_project_folder(path.parent)
                    selected_folder = str(path.parent)
                except Exception:
                    # The file has already been saved; never report this as a failed save.
                    warning = (warning + ' ' if warning else '') + "The project was saved, but its folder could not be linked. Use Link folder to try again."
            try:
                folder = _directory(selected_folder) if selected_folder else None
            except ValidationError:
                folder = None
            metadata = _metadata(path, saved_info, project, folder, payload)
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
