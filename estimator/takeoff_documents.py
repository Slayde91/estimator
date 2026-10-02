"""Immutable local takeoff evidence, bounded uploads and portable companions.

Paths are derived from validated IDs only. Upload ownership is an opaque caller
capability. The caller owns draft/project revisions and acceptance operations.
"""

from collections import OrderedDict
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
from threading import BoundedSemaphore, RLock
import uuid
from weakref import WeakValueDictionary

from .catalog import ValidationError


CHUNK_SIZE = 8 * 1024 * 1024
MAX_DOCUMENT_SIZE = 250 * 1024 * 1024
MAX_DOCUMENTS = 100
MAX_PROJECT_PAGES = 2000
MAX_PROJECT_BYTES = MAX_DOCUMENT_SIZE * MAX_DOCUMENTS
MAX_AUDIT_BLOB = 32 * 1024 * 1024
MAX_AUDIT_EVENTS = 10000
MAX_AUDIT_BYTES = 256 * 1024 * 1024
PARSER_TIMEOUT = 40
DISK_RESERVE = 64 * 1024 * 1024
MAX_SPOOLS = 4
MAX_SPOOL_BYTES = 1024 * 1024 * 1024
MAX_AUDIT_RECORDS = 4096
MAX_AUDIT_CACHE_BYTES = 32 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}\Z")
_PARSER_SLOTS = BoundedSemaphore(2)


def _digest(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ValidationError("Invalid evidence digest.")
    return value


def _uuid(value):
    if not isinstance(value, str):
        raise ValidationError("Invalid takeoff identity.")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError as error:
        raise ValidationError("Invalid takeoff identity.") from error
    return value


def _owner(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256:
        raise ValidationError("A current takeoff session is required.")
    return value


def _linked(info):
    if stat.S_ISLNK(info.st_mode):
        return True
    if not getattr(info, "st_file_attributes", 0) & 0x400:
        return False
    # Match the project's established OneDrive policy: documented cloud tags
    # do not redirect names. Junctions, symlinks and unknown providers do.
    return getattr(info, "st_reparse_tag", 0) & 0xFFFF0FFF != 0x9000001A


def _directory(path, create=False):
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValidationError("Evidence folders must be contained local folders.")
    for current in reversed((path, *path.parents)):
        try:
            info = current.lstat()
        except FileNotFoundError:
            if not create:
                raise ValidationError("The evidence folder is missing.") from None
            try:
                current.mkdir()
            except FileExistsError:
                pass
            info = current.lstat()
        if _linked(info) or not stat.S_ISDIR(info.st_mode):
            raise ValidationError("Evidence folders cannot be symbolic links or reparse points.")
    return path


def _identity(info):
    # Windows CRT fstat and path stat do not agree on ctime semantics.
    # Exact content hashing supplies integrity in addition to stable identity.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


@contextmanager
def _open_regular(path, maximum, *, allow_empty=False):
    path = Path(path)
    _directory(path.parent)
    try:
        before = path.lstat()
        if _linked(before) or not stat.S_ISREG(before.st_mode) or not (0 if allow_empty else 1) <= before.st_size <= maximum:
            raise ValidationError("The evidence file is not a bounded regular file.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            if _identity(before) != _identity(os.fstat(stream.fileno())):
                raise ValidationError("The evidence changed while being opened.")
            yield stream
            if _identity(before) != _identity(os.fstat(stream.fileno())) or _identity(before) != _identity(path.lstat()):
                raise ValidationError("The evidence changed while being read.")
    except OSError as error:
        raise ValidationError("The retained evidence is missing or cannot be read.") from error


def _hash_stream(stream):
    value = hashlib.sha256()
    stream.seek(0)
    while chunk := stream.read(1024 * 1024):
        value.update(chunk)
    stream.seek(0)
    return value.hexdigest()


def _verified(path, digest, maximum, *, allow_empty=False):
    with _open_regular(path, maximum, allow_empty=allow_empty) as stream:
        if _hash_stream(stream) != _digest(digest):
            raise ValidationError("The retained evidence hash has changed.")


def _remove_created(path, identity):
    """Remove only this operation's temporary file, never a replacement."""
    try:
        _directory(path.parent)
        info = path.lstat()
        if not _linked(info) and stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == identity:
            path.unlink()
    except (OSError, ValidationError):
        pass


def _filename(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 255 or value != value.rstrip(" .")
            or Path(value).name != value or re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', value)
            or not value.lower().endswith(".pdf")
            or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", value.split(".")[0])):
        raise ValidationError("Choose a PDF with a safe filename.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValidationError("The PDF filename contains invalid text.") from error
    return value


def _canonical(value):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        raise ValidationError("Evidence metadata must contain valid finite JSON values.") from error
    if not 0 < len(encoded) <= MAX_AUDIT_BLOB:
        raise ValidationError("The takeoff audit segment is too large.")
    return encoded


def _metadata(document):
    if not isinstance(document, dict) or set(document) != {"id", "name", "sha256", "size", "pages"}:
        raise ValidationError("Invalid retained PDF metadata.")
    _uuid(document["id"])
    _filename(document["name"])
    _digest(document["sha256"])
    if type(document["size"]) is not int or not 1 <= document["size"] <= MAX_DOCUMENT_SIZE:
        raise ValidationError("Each PDF must be nonempty and at most 250 MiB.")
    pages = document["pages"]
    if not isinstance(pages, list) or not 1 <= len(pages) <= MAX_PROJECT_PAGES:
        raise ValidationError("A project supports at most 2,000 pages.")
    for number, page in enumerate(pages, 1):
        if not isinstance(page, dict) or set(page) != {"page", "width", "height", "view", "media_box", "crop_box", "rotation", "user_unit"}:
            raise ValidationError("Invalid PDF page metadata.")
        if type(page["page"]) is not int or page["page"] != number or type(page["rotation"]) is not int or page["rotation"] not in (0, 90, 180, 270):
            raise ValidationError("Invalid PDF page identity or rotation.")
        for box in (page["view"], page["media_box"], page["crop_box"]):
            if not isinstance(box, list) or len(box) != 4:
                raise ValidationError("Invalid PDF page bounds.")
        numbers = [page["width"], page["height"], page["user_unit"], *page["view"], *page["media_box"], *page["crop_box"]]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or abs(value) > 1e9 or not math.isfinite(value) for value in numbers):
            raise ValidationError("Invalid PDF page dimensions.")
        media, crop, view = page["media_box"], page["crop_box"], page["view"]
        if (not 0 < page["user_unit"] <= 75000 or not 0 < page["width"] == view[2] - view[0]
                or not 0 < page["height"] == view[3] - view[1]
                or view != [max(media[0], crop[0]), max(media[1], crop[1]), min(media[2], crop[2]), min(media[3], crop[3])]):
            raise ValidationError("Inconsistent PDF page dimensions.")
    return document


class _AuditDocument:
    """Private shared metadata; never returned through the mutable blob API."""
    def __init__(self, metadata):
        self.metadata = metadata


class TakeoffDocuments:
    def __init__(self, root):
        self.root = _directory(root, create=True)
        self._uploads = {}
        self._lock = RLock()
        self._parsed = {}
        self._spools = OrderedDict()
        self._sources = {}
        self._audit_sources = {}
        # Semantic summaries omit full item states. Every use still requires
        # fresh file bytes and SHA verification; no stat-only integrity cache.
        self._audit_records = OrderedDict()
        self._audit_cache_bytes = 0
        self._audit_documents = WeakValueDictionary()
        self._closing = False
        self._closed_owners = set()
        for name in ("uploads", "documents", "audit"):
            _directory(self.root / name, create=True)

    def _space(self, size, directory=None):
        if shutil.disk_usage(directory or self.root).free < size + DISK_RESERVE:
            raise ValidationError("There is not enough free disk space to retain this evidence.")

    def begin_upload(self, owner, filename, size, sha256=None):
        owner, filename = _owner(owner), _filename(filename)
        if type(size) is not int or not 1 <= size <= MAX_DOCUMENT_SIZE:
            raise ValidationError("Each PDF must be nonempty and at most 250 MiB.")
        if sha256 is not None:
            _digest(sha256)
        with self._lock:
            if owner in self._closed_owners:
                raise ValidationError("This takeoff session has closed.")
            owned = [value for value in self._uploads.values() if value["owner"] == owner]
            if len(owned) >= MAX_DOCUMENTS or sum(value["size"] for value in owned) + size > MAX_PROJECT_BYTES:
                raise ValidationError("A takeoff project supports at most 100 PDFs and 25,000 MiB of source PDFs.")
            # Reserve capacity for all active upload sessions, not only this window.
            remaining = sum(value["size"] - value["offset"] for value in self._uploads.values() if not value.get("document"))
            self._space(size + remaining)
            identifier = secrets.token_urlsafe(32)
            path = self.root / "uploads" / (identifier + ".part")
            with path.open("xb"):
                pass
            info = path.lstat()
            self._uploads[identifier] = {"owner": owner, "name": filename, "size": size,
                "sha256": sha256, "offset": 0, "path": path, "finishing": False,
                "file_identity": (info.st_dev, info.st_ino), "hasher": hashlib.sha256()}
            return {"upload_id": identifier, "offset": 0, "chunk_size": CHUNK_SIZE}

    def _upload(self, owner, upload_id):
        _owner(owner)
        if not isinstance(upload_id, str) or upload_id not in self._uploads or self._uploads[upload_id]["owner"] != owner:
            raise ValidationError("This upload does not belong to the current takeoff session.")
        return self._uploads[upload_id]

    def write_chunk(self, owner, upload_id, offset, payload):
        if type(offset) is not int or offset < 0 or not isinstance(payload, bytes) or not 0 < len(payload) <= CHUNK_SIZE:
            raise ValidationError("Upload a nonempty chunk of at most 8 MiB at a valid offset.")
        with self._lock:
            item = self._upload(owner, upload_id)
            if item["finishing"] or item.get("document"):
                raise ValidationError("The PDF upload is already finishing or complete.")
            if offset + len(payload) > item["size"] or offset > item["offset"]:
                raise ValidationError("The upload chunk is out of sequence or exceeds the PDF size.")
            _directory(item["path"].parent)
            before = item["path"].lstat()
            if (_linked(before) or not stat.S_ISREG(before.st_mode) or before.st_size != item["offset"]
                    or (before.st_dev, before.st_ino) != item["file_identity"]):
                raise ValidationError("The staged PDF upload changed unexpectedly.")
            flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(item["path"], flags), "r+b") as stream:
                if _identity(before) != _identity(os.fstat(stream.fileno())):
                    raise ValidationError("The staged PDF upload changed unexpectedly.")
                stream.seek(offset)
                if offset < item["offset"]:
                    if offset + len(payload) > item["offset"] or stream.read(len(payload)) != payload:
                        raise ValidationError("A repeated upload chunk does not match the retained bytes.")
                else:
                    self._space(len(payload))
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                    item["hasher"].update(payload)
                    item["offset"] += len(payload)
            return {"upload_id": upload_id, "offset": item["offset"], "complete": item["offset"] == item["size"]}

    def _parse(self, path, expected_sha256):
        _digest(expected_sha256)
        if not _PARSER_SLOTS.acquire(blocking=False):
            raise ValidationError("Two PDFs are already being inspected. Retry when an inspection finishes.")
        try:
            try:
                result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("takeoff_pdf_worker.py")), str(path)],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=PARSER_TIMEOUT, check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except subprocess.TimeoutExpired as error:
                raise ValidationError("PDF processing exceeded its time limit. The PDF was not accepted.") from error
        finally:
            _PARSER_SLOTS.release()
        if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
            raise ValidationError("The PDF exceeded parser resource limits or could not be parsed safely.")
        try:
            data = json.loads(result.stdout)
        except (ValueError, UnicodeError) as error:
            raise ValidationError("The PDF parser did not return valid metadata.") from error
        if not isinstance(data, dict) or set(data) != {"pages", "sha256"}:
            raise ValidationError(data.get("error", "The PDF could not be parsed safely.") if isinstance(data, dict) else "Invalid PDF parser response.")
        if data["sha256"] != expected_sha256:
            raise ValidationError("The PDF changed before inspection. Its page metadata was not accepted.")
        return data["pages"]

    def _copy(self, source, destination, digest, maximum, *, allow_empty=False):
        """Copy exact verified bytes, never overwrite an existing evidence object."""
        _directory(destination.parent, create=True)
        try:
            destination.lstat()
        except FileNotFoundError:
            pass
        else:
            _verified(destination, digest, maximum, allow_empty=allow_empty)
            return
        with _open_regular(source, maximum, allow_empty=allow_empty) as incoming:
            size = os.fstat(incoming.fileno()).st_size
            self._space(size, destination.parent)
            if _hash_stream(incoming) != digest:
                raise ValidationError("The source evidence hash has changed.")
            created = False
            identity = None
            try:
                try:
                    output = destination.open("xb")
                    created = True
                except FileExistsError:
                    _verified(destination, digest, maximum, allow_empty=allow_empty)
                    return
                with output:
                    info = os.fstat(output.fileno())
                    identity = info.st_dev, info.st_ino
                    checksum = hashlib.sha256()
                    while chunk := incoming.read(1024 * 1024):
                        output.write(chunk)
                        checksum.update(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if checksum.hexdigest() != digest:
                    raise ValidationError("The source evidence changed while being copied.")
                _directory(destination.parent)
            except Exception:
                if created and identity is not None:
                    _remove_created(destination, identity)
                raise
        _verified(destination, digest, maximum, allow_empty=allow_empty)

    def finish_upload(self, owner, upload_id):
        with self._lock:
            item = self._upload(owner, upload_id)
            if item.get("document"):
                self.document_path(item["document"])
                return deepcopy(item["document"])
            if item["finishing"] or item["offset"] != item["size"]:
                raise ValidationError("Upload every PDF byte before processing the document.")
            item["finishing"] = True
        try:
            with _open_regular(item["path"], MAX_DOCUMENT_SIZE) as stream:
                info = os.fstat(stream.fileno())
                if (info.st_dev, info.st_ino) != item["file_identity"]:
                    raise ValidationError("The staged PDF was replaced before processing.")
                digest = _hash_stream(stream)
            if digest != item["hasher"].hexdigest():
                raise ValidationError("The staged PDF differs from the uploaded chunks.")
            if item["sha256"] and item["sha256"] != digest:
                raise ValidationError("The uploaded PDF does not match its declared hash.")
            pages = self._parse(item["path"], digest)
            document = _metadata({"id": str(uuid.uuid4()), "name": item["name"], "sha256": digest,
                                  "size": item["size"], "pages": pages})
            with self._lock:
                if item.get("abandoned"):
                    raise ValidationError("The takeoff session closed while this PDF was being inspected.")
                existing = [value["document"] for value in self._uploads.values()
                            if value["owner"] == owner and value.get("document")]
                if sum(len(value["pages"]) for value in existing) + len(pages) > MAX_PROJECT_PAGES:
                    raise ValidationError("A project supports at most 2,000 pages; this PDF was not added.")
                destination = self.root / "documents" / (digest + ".pdf")
                self._copy(item["path"], destination, digest, MAX_DOCUMENT_SIZE)
                item["document"] = document
                self._parsed[digest] = deepcopy(pages)
                _remove_created(item["path"], item["file_identity"])
                return deepcopy(document)
        finally:
            with self._lock:
                item["finishing"] = False
                if item.get("abandoned"):
                    _remove_created(item["path"], item["file_identity"])
                    self._uploads.pop(upload_id, None)

    def cancel_upload(self, owner, upload_id):
        with self._lock:
            item = self._upload(owner, upload_id)
            if item["finishing"]:
                raise ValidationError("The PDF is being inspected. Wait for inspection before cancelling it.")
            if not item.get("document"):
                _remove_created(item["path"], item["file_identity"])
            del self._uploads[upload_id]
            return {"cancelled": True}

    def close_owner(self, owner):
        """Abandon only this window's pending work; keep all immutable evidence."""
        _owner(owner)
        with self._lock:
            self._closed_owners.add(owner)
            self._sources.pop(owner, None)
            self._audit_sources.pop(owner, None)
            for upload_id, item in list(self._uploads.items()):
                if item["owner"] != owner:
                    continue
                if item["finishing"]:
                    item["abandoned"] = True
                    continue
                if not item.get("document"):
                    _remove_created(item["path"], item["file_identity"])
                del self._uploads[upload_id]
        if getattr(self, 'images', None) is not None:
            self.images.close_owner(owner)

    def document_path(self, document, verify=True):
        _metadata(document)
        path = self.root / "documents" / (document["sha256"] + ".pdf")
        if verify:
            with _open_regular(path, MAX_DOCUMENT_SIZE) as stream:
                if os.fstat(stream.fileno()).st_size != document["size"] or _hash_stream(stream) != document["sha256"]:
                    raise ValidationError("The retained PDF has changed or no longer matches its source.")
            pages = self._parsed.get(document["sha256"])
            if pages is None:
                pages = self._parse(path, document["sha256"])
                self._parsed[document["sha256"]] = deepcopy(pages)
            if document["pages"] != pages:
                raise ValidationError("The saved PDF page geometry differs from the retained original.")
        return path

    def validate_project_documents(self, documents, owner=None):
        issues = []
        if not isinstance(documents, list) or len(documents) > MAX_DOCUMENTS:
            return [{"code": "DOCUMENT_LIMIT", "message": "A project supports at most 100 PDFs."}]
        seen, page_count, size = set(), 0, 0
        for document in documents:
            try:
                _metadata(document)
                if document["id"] in seen:
                    raise ValidationError("Duplicate PDF document identity.")
                seen.add(document["id"])
                page_count += len(document["pages"])
                size += document["size"]
                source = self._sources.get(owner, {}).get(document["id"])
                if source is not None:
                    _verified(source, document["sha256"], MAX_DOCUMENT_SIZE)
                self.document_path(document)
            except ValidationError as error:
                issues.append({"document_id": document.get("id") if isinstance(document, dict) else None,
                               "code": "EVIDENCE_UNAVAILABLE", "message": str(error)})
        if page_count > MAX_PROJECT_PAGES or size > MAX_PROJECT_BYTES:
            issues.append({"code": "DOCUMENT_LIMIT", "message": "A project supports at most 2,000 PDF pages and 25,000 MiB."})
        return issues

    def assert_documents(self, documents, owner=None):
        issues = self.validate_project_documents(documents, owner)
        if issues:
            raise ValidationError(issues[0]["message"])

    def _spool(self, document):
        """Retain bounded verified streams; ranges never reread the entire PDF."""
        _metadata(document)
        digest = document["sha256"]
        with self._lock:
            if self._closing:
                raise ValidationError("The document service has closed.")
            entry = self._spools.get(digest)
            if entry is not None:
                if entry["size"] != document["size"] or self._parsed.get(digest) != document["pages"]:
                    raise ValidationError("The PDF metadata differs from its verified original.")
                self._spools.move_to_end(digest)
                entry["readers"] += 1
                return entry
            path = self.document_path(document)
            size = document["size"]
            while (len(self._spools) >= MAX_SPOOLS or sum(value["size"] for value in self._spools.values()) + size > MAX_SPOOL_BYTES):
                available = next((key for key, value in self._spools.items() if not value["readers"]), None)
                if available is None:
                    raise ValidationError("The PDF viewer is busy. Retry after another page finishes loading.")
                self._spools.pop(available)["stream"].close()
            self._space(size)
            stream = tempfile.TemporaryFile(dir=self.root / "uploads")
            try:
                checksum = hashlib.sha256()
                with _open_regular(path, MAX_DOCUMENT_SIZE) as source:
                    while chunk := source.read(1024 * 1024):
                        stream.write(chunk)
                        checksum.update(chunk)
                if checksum.hexdigest() != digest:
                    raise ValidationError("The retained PDF hash changed.")
                stream.flush()
            except Exception:
                stream.close()
                raise
            entry = {"stream": stream, "size": size, "lock": RLock(), "readers": 1}
            self._spools[digest] = entry
            return entry

    @contextmanager
    def iter_document(self, document, range_header=None):
        entry = self._spool(document)
        try:
            with entry["lock"]:
                yield from self._range(entry["stream"], entry["size"], range_header)
        finally:
            with self._lock:
                entry["readers"] -= 1
                if self._closing and not entry["readers"]:
                    entry["stream"].close()
                    self._spools.pop(document["sha256"], None)

    def _range(self, stream, size, range_header):
            start, end, status = 0, size - 1, 200
            headers = {"Accept-Ranges": "bytes", "Content-Type": "application/pdf",
                       "Content-Disposition": 'inline; filename="source.pdf"'}
            if range_header is not None:
                match = re.fullmatch(r"bytes=(\d{0,18})-(\d{0,18})", range_header) if isinstance(range_header, str) else None
                if not match or not any(match.groups()):
                    yield 416, {**headers, "Content-Range": f"bytes */{size}", "Content-Length": "0"}, iter(())
                    return
                left, right = match.groups()
                start = int(left) if left else max(0, size - int(right))
                end = min(size - 1, int(right)) if left and right else size - 1
                if start > end or start >= size:
                    yield 416, {**headers, "Content-Range": f"bytes */{size}", "Content-Length": "0"}, iter(())
                    return
                status = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            headers["Content-Length"] = str(end - start + 1)
            stream.seek(start)

            def chunks():
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValidationError("The PDF changed while streaming.")
                    remaining -= len(chunk)
                    yield chunk

            yield status, headers, chunks()

    def close(self):
        """Close idle cache handles. In-flight readers retain their own handle."""
        with self._lock:
            self._closing = True
            for digest, entry in list(self._spools.items()):
                if not entry["readers"]:
                    entry["stream"].close()
                    del self._spools[digest]

    def put_blob(self, value, kind="audit"):
        if kind != "audit":
            raise ValidationError("Unsupported evidence blob kind.")
        payload = _canonical(value)
        digest = hashlib.sha256(payload).hexdigest()
        with self._lock:
            destination = self.root / "audit" / (digest + ".json")
            if destination.exists():
                _verified(destination, digest, MAX_AUDIT_BLOB)
                return digest
            self._space(len(payload))
            descriptor, name = tempfile.mkstemp(dir=self.root / "uploads", suffix=".json")
            temporary = Path(name)
            info = os.fstat(descriptor)
            identity = info.st_dev, info.st_ino
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                self._copy(temporary, destination, digest, MAX_AUDIT_BLOB)
            finally:
                _remove_created(temporary, identity)
        return digest

    def get_blob(self, digest, kind="audit"):
        if kind != "audit":
            raise ValidationError("Unsupported evidence blob kind.")
        digest = _digest(digest)
        with _open_regular(self.root / "audit" / (digest + ".json"), MAX_AUDIT_BLOB) as stream:
            payload = stream.read(MAX_AUDIT_BLOB + 1)
            if hashlib.sha256(payload).hexdigest() != digest:
                raise ValidationError("The audit history hash has changed.")
        try:
            value = json.loads(payload)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ValidationError("The audit history is invalid.") from error
        if not isinstance(value, dict) or _canonical(value) != payload:
            raise ValidationError("The audit history is not canonical JSON.")
        return value

    def _companion(self, snapshot, project_file_path, create=False):
        project = _uuid(snapshot.get("project_id"))
        relative = f".ceasefire-evidence/{project}"
        if snapshot.get("companion_folder", relative) != relative:
            raise ValidationError("The project has an invalid evidence companion folder.")
        parent = _directory(Path(project_file_path).absolute().parent)
        return _directory(parent / ".ceasefire-evidence" / project, create=create), relative

    def _audit_record(self, digest):
        """Read fresh bytes, then reuse only their immutable semantic summary."""
        from .takeoff_model import audit_state_digest
        digest = _digest(digest)
        with self._lock:
            record = self._audit_records.get(digest)
            if record is not None:
                self._audit_records.move_to_end(digest)
        if record is not None:
            _verified(self.root / "audit" / (digest + ".json"), digest, MAX_AUDIT_BLOB)
            return record
        event = self.get_blob(digest)
        fields = {"version", "project_id", "revision", "previous", "request_id", "op", "at", "before", "after"}
        attribution = {"actor", "affected_ids"}
        if (set(event) not in (fields, fields | attribution) or type(event["version"]) is not int or event["version"] not in (1, 2)
                or type(event["revision"]) is not int or event["revision"] < 1):
            raise ValidationError("The audit event has an unsupported schema or broken revision sequence.")
        if event['version'] == 2 and set(event) != fields | attribution:
            raise ValidationError('Physical audit events require session attribution and affected identities.')
        _uuid(event["project_id"])
        _uuid(event["request_id"])
        if event["previous"] is not None:
            _digest(event["previous"])
        if any(not isinstance(event[key], str) or not 1 <= len(event[key]) <= 100 for key in ("op", "at")):
            raise ValidationError("The audit event must retain its operation and timestamp.")
        if "actor" in event:
            actor = event["actor"]
            if not isinstance(actor, dict) or set(actor) != {"kind", "session_id"} or actor["kind"] != "local-session":
                raise ValidationError("The audit actor must identify its local session.")
            _uuid(actor["session_id"])
            affected = event["affected_ids"]
            limits = {"items": 20000, "documents": 200, "calibrations": 4000, "transfers": 60000}
            if event['version'] == 2:
                limits.update(physical=20000, image_extractions=4000)
            if not isinstance(affected, dict) or set(affected) != set(limits):
                raise ValidationError("The audit affected IDs must identify every supported collection.")
            for name, limit in limits.items():
                identifiers = affected[name]
                if (not isinstance(identifiers, list) or len(identifiers) > limit
                        or any(not isinstance(value, str) for value in identifiers)):
                    raise ValidationError("The audit affected IDs must be bounded UUID lists.")
                for identifier in identifiers:
                    _uuid(identifier)
                if identifiers != sorted(set(identifiers)):
                    raise ValidationError("The audit affected IDs must be sorted and unique.")
        documents, images = {}, {}
        for side in ("before", "after"):
            state = event[side]
            revision = event["revision"] - (1 if side == "before" else 0)
            if (not isinstance(state, dict) or state.get("project_id") != event["project_id"]
                    or type(state.get("version")) is not int or state['version'] not in (1, 2)
                    or type(state.get("revision")) is not int or state["revision"] != revision):
                raise ValidationError("The audit history contains invalid takeoff state.")
            state_documents = state.get("documents", [])
            if not isinstance(state_documents, list) or len(state_documents) > MAX_DOCUMENTS:
                raise ValidationError("The audit history contains an invalid PDF collection.")
            for document in state_documents:
                # Equality alone cannot prove schema validity: Python considers
                # True equal to 1, but page identities must be actual integers.
                _metadata(document)
                identifier = document.get("id") if isinstance(document, dict) else None
                if not isinstance(identifier, str):
                    raise ValidationError("Invalid retained PDF metadata.")
                previous = documents.get(identifier)
                if previous is not None:
                    if previous.metadata != document:
                        raise ValidationError("An original PDF identity was rewritten in the audit history.")
                    continue
                with self._lock:
                    shared = self._audit_documents.get(identifier)
                if shared is None or shared.metadata != document:
                    shared = _AuditDocument(document)
                    with self._lock:
                        self._audit_documents[identifier] = shared
                documents[identifier] = shared
            from .takeoff_model import validate_physical_extension
            validate_physical_extension(state)
            for descriptor in state.get('image_extractions', []):
                prior = images.get(descriptor['id'])
                if prior is not None and prior != descriptor:
                    raise ValidationError('An image extraction identity was rewritten in the audit history.')
                images[descriptor['id']] = descriptor
        before_version, after_version = event['before']['version'], event['after']['version']
        if (event['version'] != after_version or before_version > after_version
                or (before_version != after_version and event['op'] not in ('apply_physical', 'extract_images'))):
            raise ValidationError('The takeoff schema changed outside a controlled physical operation.')
        before_graph, after_graph = event['before'].get('physical'), event['after'].get('physical')
        if any(graph and graph['version'] == 2 for graph in (before_graph, after_graph)):
            # Numbered identities survive edits and Undo. A future legacy
            # migration needs an explicit contract rather than a silent swap.
            from .takeoff_physical import graph_collections
            if event['before']['revision'] == 0 and before_graph is not None:
                raise ValidationError('The initial audit state cannot contain an unrecorded numbered physical hierarchy.')
            if before_graph and (not after_graph or before_graph['version'] != after_graph['version']
                                 or before_graph['id'] != after_graph['id']):
                raise ValidationError('The numbered physical hierarchy cannot be replaced in audit history.')
            old_entities = {entity['id']: (kind, entity['display_id'])
                            for kind, collection in graph_collections(before_graph).items()
                            for entity in before_graph[collection]} if before_graph else {}
            new_entities = {entity['id']: (kind, entity['display_id'])
                            for kind, collection in graph_collections(after_graph).items()
                            for entity in after_graph[collection]}
            if any(new_entities.get(identifier) != identity for identifier, identity in old_entities.items()):
                raise ValidationError('A numbered physical identity was removed or rewritten in audit history.')
            for kind in graph_collections(after_graph):
                previous_max = max((int(number[2:]) for entry_kind, number in old_entities.values()
                                    if entry_kind == kind), default=0)
                added = sorted(int(number[2:]) for identifier, (entry_kind, number) in new_entities.items()
                               if entry_kind == kind and identifier not in old_entities)
                if added != list(range(previous_max + 1, previous_max + 1 + len(added))):
                    raise ValidationError('New physical display IDs must continue the retained sequence.')
        if "affected_ids" in event:
            from .takeoff_model import audit_affected
            if event["affected_ids"] != audit_affected(event["before"], event["after"]):
                raise ValidationError("The audit affected IDs do not match its retained state changes.")
        retained = tuple(documents.values())
        # Count repeated metadata conservatively, even though records share it.
        weight = 512 + len(_canonical([entry.metadata for entry in retained])) + len(_canonical(list(images.values())))
        record = {"project_id": event["project_id"], "revision": event["revision"], "previous": event["previous"],
                  "before": audit_state_digest(event["before"]), "after": audit_state_digest(event["after"]),
                  "documents": retained, 'images': tuple(images.values()), "size": len(_canonical(event)), "weight": weight}
        if weight <= MAX_AUDIT_CACHE_BYTES:
            with self._lock:
                existing = self._audit_records.pop(digest, None)
                if existing is not None:
                    self._audit_cache_bytes -= existing["weight"]
                self._audit_records[digest] = record
                self._audit_cache_bytes += weight
                while len(self._audit_records) > MAX_AUDIT_RECORDS or self._audit_cache_bytes > MAX_AUDIT_CACHE_BYTES:
                    _, removed = self._audit_records.popitem(last=False)
                    self._audit_cache_bytes -= removed["weight"]
        return record

    def _graph(self, snapshot, loader):
        documents, images = {}, {}
        from .takeoff_model import validate_physical_extension
        validate_physical_extension(snapshot)
        for descriptor in snapshot.get('image_extractions', []):
            images[descriptor['id']] = descriptor
        current = snapshot.get("documents", [])
        if not isinstance(current, list) or len(current) > MAX_DOCUMENTS:
            raise ValidationError("A project supports at most 100 PDFs.")
        for document in current:
            _metadata(document)
            if document["id"] in documents:
                raise ValidationError("Duplicate PDF document identity.")
            documents[document["id"]] = document
        audit, head, seen = [], snapshot.get("audit_head"), set()
        audit_bytes = 0
        expected_after = None
        expected_revision = snapshot.get("revision")
        if type(expected_revision) is not int or expected_revision < 0 or (head is None and expected_revision != 0):
            raise ValidationError("The takeoff revision is missing its audit history.")
        while head is not None:
            _digest(head)
            if head in seen or len(seen) >= MAX_AUDIT_EVENTS:
                raise ValidationError("The audit history is cyclic or exceeds its review limit.")
            seen.add(head)
            record = loader(head)
            audit_bytes += record["size"]
            if audit_bytes > MAX_AUDIT_BYTES:
                raise ValidationError("The retained audit history exceeds its 256 MiB read budget.")
            if record["project_id"] != snapshot["project_id"]:
                raise ValidationError("The audit history belongs to a different project or is incomplete.")
            if record["revision"] != expected_revision:
                raise ValidationError("The audit event has an unsupported schema or broken revision sequence.")
            audit.append(head)
            for retained in record["documents"]:
                document = retained.metadata
                previous = documents.get(document["id"])
                if previous is not None and previous != document:
                    raise ValidationError("An original PDF identity was rewritten in the audit history.")
                documents[document["id"]] = document
                if len(documents) > MAX_DOCUMENTS:
                    raise ValidationError("A project supports at most 100 retained PDFs, including history.")
            for descriptor in record['images']:
                previous = images.get(descriptor['id'])
                if previous is not None and previous != descriptor:
                    raise ValidationError('An image extraction identity was rewritten in the audit history.')
                images[descriptor['id']] = descriptor
                if len(images) > 2000:
                    raise ValidationError('The project retains too many image extraction events, including history.')
            if expected_after is not None and record["after"] != expected_after:
                raise ValidationError("The audit history contains an unrecorded physical-state change.")
            expected_after = record["before"]
            expected_revision -= 1
            head = record["previous"]
        if expected_revision != 0:
            raise ValidationError("The audit history does not reach its initial revision.")
        if sum(len(document["pages"]) for document in documents.values()) > MAX_PROJECT_PAGES:
            raise ValidationError("A project supports at most 2,000 retained PDF pages, including history.")
        if sum(image['total_bytes'] for image in images.values()) > 4 * 1024**3:
            raise ValidationError('The retained image evidence exceeds 4 GiB, including history.')
        return list(documents.values()), audit, list(images.values())

    def assert_add_capacity(self, snapshot, document):
        """Refuse intake that could create a draft too large to save with history."""
        _metadata(document)
        documents, _, _ = self._graph(snapshot, self._audit_record)
        if any(value["id"] == document["id"] for value in documents):
            raise ValidationError("This PDF identity is already retained in the project history.")
        if len(documents) + 1 > MAX_DOCUMENTS:
            raise ValidationError("The project already retains 100 PDFs, including deleted-document history. Start another project for additional PDFs.")
        if sum(len(value["pages"]) for value in documents) + len(document["pages"]) > MAX_PROJECT_PAGES:
            raise ValidationError("This PDF would exceed 2,000 retained pages, including deleted-document history. Start another project for additional pages.")
        if sum(value["size"] for value in documents) + document["size"] > MAX_PROJECT_BYTES:
            raise ValidationError("This PDF would exceed the project's retained source-byte limit.")

    def validate_audit(self, snapshot, owner=None):
        """Verify every retained event and physical-state transition in the chain."""
        source = self._audit_sources.get(owner)
        reached_source = False

        def load(digest):
            nonlocal reached_source
            if source and digest == source["head"]:
                reached_source = True
            if reached_source:
                _verified(source["folder"] / "audit" / (digest + ".json"), digest, MAX_AUDIT_BLOB)
            return self._audit_record(digest)

        self._graph(snapshot, load)
        if source and source["head"] is not None and not reached_source:
            raise ValidationError("The audit history no longer includes this window's saved source history.")

    def assert_image_evidence(self, snapshot, owner=None):
        """Reverify current and historical images for save/approved evidence use."""
        documents, _, images = self._graph(snapshot, self._audit_record)
        self.assert_documents(documents, owner=owner)
        if images:
            self._images().assert_evidence(images, documents, owner=owner)

    def publish(self, snapshot, project_file_path):
        with self._lock:
            _uuid(snapshot.get("project_id"))
            documents, audit, images = self._graph(snapshot, self._audit_record)
            self.assert_documents(documents)
            folder, relative = self._companion(snapshot, project_file_path, create=True)
            for document in documents:
                name = document["sha256"] + ".pdf"
                self._copy(self.root / "documents" / name, folder / "documents" / name, document["sha256"], MAX_DOCUMENT_SIZE)
            for digest in audit:
                self._copy(self.root / "audit" / (digest + ".json"), folder / "audit" / (digest + ".json"), digest, MAX_AUDIT_BLOB)
            if images:
                self._images().publish(images, documents, folder)
            return {**deepcopy(snapshot), "companion_folder": relative}

    def _images(self):
        manager = getattr(self, 'images', None)
        if manager is None:
            raise ValidationError('The retained image evidence service is unavailable.')
        return manager

    def register_source(self, owner, snapshot, project_file_path):
        """Bind a window to its portable originals; never infer authority from a path."""
        _owner(owner)
        project = _uuid(snapshot.get("project_id"))
        relative = f".ceasefire-evidence/{project}"
        if snapshot.get("companion_folder", relative) != relative:
            raise ValidationError("The project has an invalid evidence companion folder.")
        parent = _directory(Path(project_file_path).absolute().parent)
        folder = parent / ".ceasefire-evidence" / project
        mapping = {}
        for document in snapshot.get("documents", []):
            _metadata(document)
            mapping[document["id"]] = folder / "documents" / (document["sha256"] + ".pdf")
        with self._lock:
            if owner in self._closed_owners:
                raise ValidationError("This takeoff session has closed.")
            self._sources[owner] = mapping
            self._audit_sources[owner] = {"head": snapshot.get("audit_head"), "folder": folder}
        if snapshot.get('image_extractions'):
            self._images().bind_source(owner, snapshot['image_extractions'], folder)

    def bind_source(self, owner, snapshot, project_file_path):
        """Rebind only after the caller atomically commits its saved project."""
        self.register_source(owner, snapshot, project_file_path)
        documents, _, images = self._graph(snapshot, self._audit_record)
        folder, _ = self._companion(snapshot, project_file_path)
        self._bind_retained(owner, documents, images, folder)

    def _bind_retained(self, owner, documents, images, folder):
        """A new saved path must cover historical assets as well as visible ones."""
        _owner(owner)
        mapping = {document['id']: folder / 'documents' / (document['sha256'] + '.pdf') for document in documents}
        with self._lock:
            if owner in self._closed_owners:
                raise ValidationError('This takeoff session has closed.')
            self._sources[owner] = mapping
        if getattr(self, 'images', None) is not None:
            self.images.bind_source(owner, images, folder)
        elif images:
            self._images()

    def restore(self, snapshot, project_file_path, owner=None):
        """Diagnose missing evidence without preventing old estimating inputs opening."""
        issues = []
        try:
            if owner is not None:
                self.register_source(owner, snapshot, project_file_path)
            folder, _ = self._companion(snapshot, project_file_path)

            def load(digest):
                _verified(folder / "audit" / (digest + ".json"), digest, MAX_AUDIT_BLOB)
                self._copy(folder / "audit" / (digest + ".json"), self.root / "audit" / (digest + ".json"), digest, MAX_AUDIT_BLOB)
                return self._audit_record(digest)

            documents, _, images = self._graph(snapshot, load)
            if owner is not None:
                self._bind_retained(owner, documents, images, folder)
        except (ValidationError, OSError) as error:
            issues.append({"code": "EVIDENCE_UNAVAILABLE", "message": str(error)})
            documents = snapshot.get("documents", [])
            images = snapshot.get('image_extractions', [])
            folder = None
        for document in documents:
            try:
                _metadata(document)
                if folder is None:
                    raise ValidationError("The project evidence companion is missing or invalid.")
                name = document["sha256"] + ".pdf"
                # Check the portable original even when the cache already contains it.
                _verified(folder / "documents" / name, document["sha256"], MAX_DOCUMENT_SIZE)
                self._copy(folder / "documents" / name, self.root / "documents" / name, document["sha256"], MAX_DOCUMENT_SIZE)
                self.document_path(document)
            except (ValidationError, OSError) as error:
                issues.append({"document_id": document.get("id") if isinstance(document, dict) else None,
                               "code": "EVIDENCE_UNAVAILABLE", "message": str(error)})
        if images:
            if folder is None:
                issues.append({'code': 'IMAGE_EVIDENCE_UNAVAILABLE', 'message': 'The retained image evidence companion is missing or invalid.'})
            else:
                try:
                    issues.extend(self._images().restore(images, documents, folder, owner=owner))
                except (ValidationError, OSError) as error:
                    issues.append({'code': 'IMAGE_EVIDENCE_UNAVAILABLE', 'message': str(error)})
        return issues
