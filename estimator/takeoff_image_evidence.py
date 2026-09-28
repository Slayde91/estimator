"""Bounded, immutable retained image evidence; extraction is not approval.

Only this service's verified child output enters the local provenance registry.
Imported evidence can be inspected and saved without acquiring that authority.
Coverage and physical eligibility remain the caller's explicit responsibility.
"""

from copy import deepcopy
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from threading import BoundedSemaphore, RLock
from uuid import UUID, uuid5

from .catalog import ValidationError
from .takeoff_documents import (_canonical, _digest, _directory, _hash_stream, _linked,
    _metadata, _open_regular, _owner, _uuid, _verified, MAX_DOCUMENT_SIZE)

MAX_IMAGE_DESCRIPTORS = 2000
MAX_IMAGE_PROJECT_BYTES = 4 * 1024**3
MAX_IMAGE_FILES = 22000
MAX_IMAGE_MANIFEST = 16 * 1024**2
MAX_IMAGE_OUTPUT = 256 * 1024**2
IMAGE_TIMEOUT = 40
_SLOTS = BoundedSemaphore(2)
_FILE = re.compile(r"(originals|decoder|renditions)/([0-9a-f]{64})\.(bin|png)\Z")
_NAMESPACE = UUID("556693a4-1814-58db-b45f-b692f3743143")


def _fail(message="The retained image evidence has an invalid schema."):
    raise ValidationError(message)


def _exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        _fail()


def _integer(value, lower=0, upper=MAX_IMAGE_OUTPUT):
    if type(value) is not int or not lower <= value <= upper:
        _fail()
    return value


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e25:
        _fail()
    return value


def _text(value, maximum=4096, empty=False):
    if not isinstance(value, str) or not (0 if empty else 1) <= len(value) <= maximum:
        _fail()


def _list(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        _fail()
    return value


def _issues(value):
    for issue in _list(value, 256):
        _exact(issue, ("code", "message"))
        _text(issue["code"], 100)
        _text(issue["message"], 300)


def _reference(value):
    if value is not None:
        _exact(value, ("object", "generation"))
        _integer(value["object"], 1, 2**31-1)
        _integer(value["generation"], 0, 65535)


def _path(value):
    if not isinstance(value, str) or not (match := _FILE.fullmatch(value)):
        _fail("Image evidence filenames must be fixed content-addressed paths.")
    kind, digest, extension = match.groups()
    if extension != ("png" if kind == "renditions" else "bin"):
        _fail("Image evidence filenames have an invalid kind or extension.")
    return kind, digest


def _stable_id(value):
    return str(uuid5(_NAMESPACE, sha256(_canonical(value)).hexdigest()))


def validate_descriptor(value):
    """Pure validation, usable before a project acquires any runtime services."""
    _exact(value, ("id", "document_id", "source_sha256", "manifest_sha256", "manifest_size", "total_bytes", "pages"))
    _uuid(value["id"])
    _uuid(value["document_id"])
    _digest(value["source_sha256"])
    _digest(value["manifest_sha256"])
    _integer(value["manifest_size"], 1, MAX_IMAGE_MANIFEST)
    _integer(value["total_bytes"], value["manifest_size"], MAX_IMAGE_OUTPUT+MAX_IMAGE_MANIFEST)
    pages = _list(value["pages"], 25)
    if not pages:
        _fail("Image extraction must identify its requested pages.")
    for page in pages:
        _integer(page, 1, 2000)
    if pages != list(range(pages[0], pages[0]+len(pages))):
        _fail("Image extraction pages must be one exact contiguous range.")
    return value


def _bounded_json(value):
    nodes = 0
    stack = [(value, 0)]
    while stack:
        node, depth = stack.pop()
        nodes += 1
        if nodes > 300000 or depth > 80:
            _fail("Image metadata exceeds its bounded node or nesting limit.")
        if isinstance(node, dict):
            for key, child in node.items():
                _text(key, 4096)
                stack.append((child, depth+1))
        elif isinstance(node, list):
            stack.extend((child, depth+1) for child in node)
        elif isinstance(node, str):
            _text(node, 65536, empty=True)
        elif node is not None and not isinstance(node, bool):
            _number(node)


def _validate_manifest(value, document, descriptor):
    try:
        return _validate_manifest_fields(value, document, descriptor)
    except ValidationError:
        raise
    except (TypeError, ValueError, KeyError, IndexError, OverflowError, RecursionError) as error:
        raise ValidationError("The retained image evidence has invalid typed metadata or references.") from error


def _validate_manifest_fields(value, document, descriptor):
    """Validate every address and cross-reference before touching child files."""
    validate_descriptor(descriptor)
    _bounded_json(value)
    _exact(value, ("version", "source", "extraction", "pages", "assets", "occurrences", "files", "issues", "coverage"))
    if type(value["version"]) is not int or value["version"] != 1:
        _fail()
    source = value["source"]
    _exact(source, ("sha256", "size", "page_count"))
    _digest(source["sha256"])
    _integer(source["size"], 1, MAX_DOCUMENT_SIZE)
    total = _integer(source["page_count"], 1, 2000)
    if source["sha256"] != descriptor["source_sha256"]:
        _fail("Image evidence belongs to a different source PDF.")
    if document is not None:
        _metadata(document)
        if (document["id"] != descriptor["document_id"] or document["sha256"] != source["sha256"]
                or document["size"] != source["size"] or len(document["pages"]) != total):
            _fail("Image evidence does not match the retained PDF identity and metadata.")
    extraction = value["extraction"]
    _exact(extraction, ("id", "at", "engine", "pypdf_version", "pillow_version"))
    if extraction["id"] != descriptor["id"] or extraction["engine"] != "takeoffs-image-evidence-v1":
        _fail("Image evidence has an unsupported extraction identity or engine.")
    _uuid(extraction["id"])
    _text(extraction["at"], 100)
    _text(extraction["pypdf_version"], 100)
    _text(extraction["pillow_version"], 100)
    files = {}
    for entry in _list(value["files"], MAX_IMAGE_FILES):
        _exact(entry, ("relative_path", "sha256", "size"))
        kind, digest = _path(entry["relative_path"])
        if digest != _digest(entry["sha256"]) or entry["relative_path"] in files:
            _fail("Image evidence inventory contains a duplicate or mismatched address.")
        _integer(entry["size"], 1 if kind == "renditions" else 0, MAX_IMAGE_OUTPUT)
        files[entry["relative_path"]] = entry
    file_bytes = sum(entry["size"] for entry in files.values())
    if file_bytes > MAX_IMAGE_OUTPUT or descriptor["total_bytes"] != descriptor["manifest_size"]+file_bytes:
        _fail("Image evidence byte accounting does not match its descriptor.")

    def blob(entry, kinds=("originals",)):
        if not isinstance(entry, dict) or not {"relative_path", "sha256", "size"} <= set(entry):
            _fail()
        kind, digest = _path(entry["relative_path"])
        _integer(entry["size"], 1 if kind == "renditions" else 0, MAX_IMAGE_OUTPUT)
        if kind not in kinds or entry["sha256"] != digest or files.get(entry["relative_path"]) != {
                key: entry[key] for key in ("relative_path", "sha256", "size")}:
            _fail("Image evidence references a missing or inconsistent immutable file.")

    def metadata(node, depth=0):
        if not isinstance(node, dict) or depth > 64:
            _fail()
        kind = node.get("type")
        if kind == "null":
            _exact(node, ("type",))
        elif kind in ("name", "number", "boolean"):
            _exact(node, ("type", "value"))
            if kind == "name":
                _text(node["value"], 4096)
            elif kind == "number":
                _number(node["value"])
            elif type(node["value"]) is not bool:
                _fail()
        elif kind == "reference":
            if set(node) not in ({"type", "value", "cycle"}, {"type", "value", "target"}):
                _fail()
            _reference(node["value"])
            if node["value"] is None or ("cycle" in node and node["cycle"] is not True):
                _fail()
            if "target" in node:
                metadata(node["target"], depth+1)
        elif kind == "bytes":
            _exact(node, ("type", "sha256", "size", "relative_path"))
            blob(node)
        elif kind == "text":
            _exact(node, ("type", "value", "original"))
            _text(node["value"], 65536, empty=True)
            _exact(node["original"], ("sha256", "size", "relative_path"))
            blob(node["original"])
        elif kind in ("stream", "dictionary"):
            _exact(node, ("type", "entries", "encoded_stream") if kind == "stream" else ("type", "entries"))
            if not isinstance(node["entries"], dict):
                _fail()
            for key, entry in node["entries"].items():
                _text(key, 4096)
                metadata(entry, depth+1)
            if kind == "stream":
                _exact(node["encoded_stream"], ("sha256", "size", "relative_path"))
                blob(node["encoded_stream"])
        elif kind == "array":
            _exact(node, ("type", "items"))
            for entry in _list(node["items"], 10000):
                metadata(entry, depth+1)
        else:
            _fail("Image evidence has unsupported typed PDF metadata.")

    def operator_path(path):
        _list(path, 67)
        if not path or len(path) % 2 != 1:
            _fail()
        for index, component in enumerate(path):
            if index % 2:
                _text(component, 4096)
            else:
                _integer(component, 0, 49999)

    assets = {}
    for asset in _list(value["assets"], 512):
        _exact(asset, ("id", "original", "source_locator", "metadata", "rendition", "issues"))
        _uuid(asset["id"])
        if asset["id"] in assets:
            _fail("Image asset identities must be unique.")
        assets[asset["id"]] = asset
        original, locator = asset["original"], asset["source_locator"]
        if not isinstance(original, dict) or not isinstance(locator, dict):
            _fail()
        blob(original)
        if original.get("kind") == "encoded-image-stream":
            _exact(original, ("sha256", "size", "relative_path", "kind"))
            _exact(locator, ("kind", "object_ref"))
            if locator["kind"] != "xobject":
                _fail()
            _reference(locator["object_ref"])
        elif original.get("kind") == "inline-decoded-content-span":
            _exact(original, ("sha256", "size", "relative_path", "kind", "enclosing_streams", "decoded_start", "decoded_end", "decoder_payload"))
            start = _integer(original["decoded_start"], 0, 32*1024**2)
            end = _integer(original["decoded_end"], start+1, 32*1024**2)
            if end-start != original["size"]:
                _fail("Inline original bytes do not match their exact source span.")
            _exact(original["decoder_payload"], ("sha256", "size", "relative_path", "may_be_normalized"))
            blob(original["decoder_payload"], ("decoder",))
            if original["decoder_payload"]["may_be_normalized"] is not True:
                _fail()
            streams = _list(original["enclosing_streams"], 10000)
            if not streams:
                _fail()
            previous_end = -1
            for entry in streams:
                _exact(entry, ("object_ref", "encoded_stream", "metadata", "decoded_start", "decoded_end"))
                _reference(entry["object_ref"])
                _exact(entry["encoded_stream"], ("sha256", "size", "relative_path"))
                blob(entry["encoded_stream"])
                metadata(entry["metadata"])
                if _integer(entry["decoded_start"], 0, 32*1024**2) != previous_end+1:
                    _fail()
                previous_end = _integer(entry["decoded_end"], entry["decoded_start"], 32*1024**2)
            if end > previous_end:
                _fail()
            _exact(locator, ("kind", "page", "operator_path", "original_settings"))
            if locator["kind"] != "inline" or locator["page"] not in descriptor["pages"]:
                _fail()
            operator_path(locator["operator_path"])
            metadata(locator["original_settings"])
        else:
            _fail("Image evidence must identify the exact original stream representation.")
        metadata(asset["metadata"])
        if asset["id"] != _stable_id([source["sha256"], original, locator, asset["metadata"]]):
            _fail("An image asset identity does not bind its original source and metadata.")
        rendition = asset["rendition"]
        _issues(asset["issues"])
        if rendition is not None:
            _exact(rendition, ("sha256", "size", "relative_path", "mime", "width", "height", "derivative", "page_composite"))
            blob(rendition, ("renditions",))
            width, height = _integer(rendition["width"], 1, 16000000), _integer(rendition["height"], 1, 16000000)
            if (width*height > 16000000 or rendition["mime"] != "image/png"
                    or rendition["derivative"] is not True or rendition["page_composite"] is not False):
                _fail()
        elif not asset["issues"]:
            _fail("An unavailable display rendition must explain its diagnostic failure.")

    def quad(points):
        if len(_list(points, 4)) != 4:
            _fail()
        for point in points:
            if len(_list(point, 2)) != 2:
                _fail()
            for coordinate in point:
                _number(coordinate)

    occurrences, per_page = {}, {page: [] for page in descriptor["pages"]}
    for occurrence in _list(value["occurrences"], 512):
        _exact(occurrence, ("id", "asset_id", "page", "operator_path", "resource_name", "object_ref", "ctm", "quad_pdf", "page_boxes", "rotation", "user_unit", "clip_context", "appearance_status", "issues"))
        _uuid(occurrence["id"])
        _uuid(occurrence["asset_id"])
        page = _integer(occurrence["page"], 1, total)
        if occurrence["id"] in occurrences or page not in per_page or occurrence["asset_id"] not in assets:
            _fail("Image occurrences have duplicate identities or unresolved source references.")
        occurrences[occurrence["id"]] = occurrence
        per_page[page].append(occurrence["id"])
        operator_path(occurrence["operator_path"])
        if occurrence["id"] != _stable_id([source["sha256"], page, occurrence["operator_path"]]):
            _fail("An image occurrence identity does not match its source location.")
        if occurrence["resource_name"] is not None:
            _text(occurrence["resource_name"], 4096)
        _reference(occurrence["object_ref"])
        if len(_list(occurrence["ctm"], 6)) != 6:
            _fail()
        for coordinate in occurrence["ctm"]:
            _number(coordinate)
        quad(occurrence["quad_pdf"])
        a, b, c, d, e, f = occurrence["ctm"]
        if occurrence["quad_pdf"] != [[e, f], [a+e, b+f], [a+c+e, b+d+f], [c+e, d+f]]:
            _fail("An image occurrence quad does not match its painting transform.")
        _exact(occurrence["page_boxes"], ("media_box", "crop_box", "view"))
        for box in occurrence["page_boxes"].values():
            if len(_list(box, 4)) != 4:
                _fail()
            for coordinate in box:
                _number(coordinate)
        _integer(occurrence["rotation"], 0, 270)
        if occurrence["rotation"] % 90 or not 0 < _number(occurrence["user_unit"]) <= 75000:
            _fail()
        if document is not None:
            page_metadata = document["pages"][page-1]
            if (any(occurrence["page_boxes"][key] != page_metadata[key] for key in occurrence["page_boxes"])
                    or occurrence["rotation"] != page_metadata["rotation"] or occurrence["user_unit"] != page_metadata["user_unit"]):
                _fail("An image occurrence page geometry differs from its source PDF.")
        clips = _list(occurrence["clip_context"], 34)
        for index, clip in enumerate(clips):
            _exact(clip, ("kind", "quad_pdf") if index == 0 else ("kind", "quad_pdf", "object_ref"))
            if clip["kind"] != ("page-crop" if index == 0 else "form-bbox"):
                _fail()
            quad(clip["quad_pdf"])
            if index:
                _reference(clip["object_ref"])
        if not clips:
            _fail()
        _issues(occurrence["issues"])
        asset = assets[occurrence["asset_id"]]
        if occurrence["appearance_status"] != ("unverified" if occurrence["issues"] else "decoded-asset"):
            _fail()
        if any(issue not in occurrence["issues"] for issue in asset["issues"]) or (asset["rendition"] is None and not occurrence["issues"]):
            _fail()
    if set(assets) != {occurrence["asset_id"] for occurrence in occurrences.values()}:
        _fail("Retained image assets must have explicit source occurrences.")
    pages = _list(value["pages"], 25)
    if [page.get("page") if isinstance(page, dict) else None for page in pages] != descriptor["pages"]:
        _fail("Image evidence page coverage differs from its requested range.")
    for page in pages:
        _exact(page, ("page", "status", "occurrence_ids", "issues"))
        _integer(page["page"], 1, total)
        _list(page["occurrence_ids"], 512)
        if page["occurrence_ids"] != per_page[page["page"]] or page["status"] not in ("complete", "partial", "failed"):
            _fail()
        _issues(page["issues"])
        has_issues = bool(page["issues"] or any(occurrences[identifier]["issues"] for identifier in page["occurrence_ids"]))
        if (page["status"] == "complete") == has_issues:
            _fail("Image evidence coverage suppresses an unresolved page diagnostic.")
    _exact(value["coverage"], ("requested_pages", "processed_pages", "complete_pages", "failed_pages", "unrequested_pages"))
    for covered in value["coverage"].values():
        for page in _list(covered, 2000):
            _integer(page, 1, total)
    expected = {"requested_pages": descriptor["pages"], "processed_pages": descriptor["pages"],
        "complete_pages": [page["page"] for page in pages if page["status"] == "complete"],
        "failed_pages": [page["page"] for page in pages if page["status"] != "complete"],
        "unrequested_pages": [page for page in range(1, total+1) if page not in per_page]}
    if value["coverage"] != expected:
        _fail("Image evidence reports inconsistent page coverage.")
    _issues(value["issues"])
    codes = {issue["code"] for issue in value["issues"]}
    if ((expected["failed_pages"] and "INCOMPLETE_IMAGE_COVERAGE" not in codes)
            or (expected["unrequested_pages"] and "PARTIAL_DOCUMENT_RANGE" not in codes)):
        _fail("Image evidence is missing its coverage diagnostic.")
    return value


class TakeoffImageEvidence:
    def __init__(self, store, documents):
        self.store, self.documents, self.root = store, documents, documents.root
        self._lock, self._sources, self._closed = RLock(), {}, set()
        for name in ("image-manifests", "image-files", "image-jobs"):
            _directory(self.root/name, create=True)
        with store.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS takeoff_image_extractions ("
                "manifest_sha256 TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, manifest_text TEXT NOT NULL)")

    def _collection(self, descriptors, documents):
        _list(descriptors, MAX_IMAGE_DESCRIPTORS)
        mapping = {}
        for document in _list(documents, 100):
            _metadata(document)
            if document["id"] in mapping:
                _fail("Duplicate image source document identity.")
            mapping[document["id"]] = document
        identifiers, digests, size = set(), set(), 0
        for descriptor in descriptors:
            validate_descriptor(descriptor)
            if descriptor["id"] in identifiers or descriptor["manifest_sha256"] in digests:
                _fail("Image extraction descriptors must have unique identities and manifests.")
            identifiers.add(descriptor["id"]); digests.add(descriptor["manifest_sha256"])
            if descriptor["document_id"] not in mapping or descriptor["source_sha256"] != mapping[descriptor["document_id"]]["sha256"]:
                _fail("Image extraction has no matching retained source document.")
            size += descriptor["total_bytes"]
        if size > MAX_IMAGE_PROJECT_BYTES:
            _fail("Retained image evidence exceeds the 4 GiB project limit.")
        return mapping

    @staticmethod
    def _descriptor(manifest, document_id, payload):
        return {"id": manifest["extraction"]["id"], "document_id": document_id,
            "source_sha256": manifest["source"]["sha256"], "manifest_sha256": sha256(payload).hexdigest(),
            "manifest_size": len(payload), "total_bytes": len(payload)+sum(entry["size"] for entry in manifest["files"]),
            "pages": manifest["coverage"]["requested_pages"]}

    def _manifest_path(self, descriptor, folder=None):
        return (self.root if folder is None else Path(folder))/"image-manifests"/(descriptor["manifest_sha256"]+".json")

    def _read_at(self, descriptor, document, folder=None):
        validate_descriptor(descriptor)
        with _open_regular(self._manifest_path(descriptor, folder), MAX_IMAGE_MANIFEST) as stream:
            payload = stream.read(MAX_IMAGE_MANIFEST+1)
        if len(payload) != descriptor["manifest_size"] or sha256(payload).hexdigest() != descriptor["manifest_sha256"]:
            _fail("The retained image manifest hash or size has changed.")
        try:
            manifest = json.loads(payload)
            if _canonical(manifest) != payload:
                _fail("The image evidence manifest is not canonical JSON.")
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ValidationError("The image evidence manifest is invalid JSON.") from error
        return _validate_manifest(manifest, document, descriptor)

    @staticmethod
    def _verify_file(path, entry, rendition=None):
        kind, _ = _path(entry["relative_path"])
        with _open_regular(path, MAX_IMAGE_OUTPUT, allow_empty=kind != "renditions") as stream:
            if os.fstat(stream.fileno()).st_size != entry["size"] or _hash_stream(stream) != entry["sha256"]:
                _fail("A retained image evidence file has changed or is missing bytes.")
            if kind == "renditions":
                header = stream.read(24)
                if len(header) != 24 or header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
                    _fail("An image display rendition is not a bounded PNG.")
                width, height = int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")
                if not width or not height or width*height > 16000000:
                    _fail("An image display rendition exceeds the decoded pixel limit.")
                if rendition and (width != rendition["width"] or height != rendition["height"]):
                    _fail("An image display rendition differs from its declared dimensions.")

    def _verify_assets(self, manifest, folder=None):
        base = (self.root if folder is None else Path(folder))/"image-files"
        renditions = {}
        for asset in manifest["assets"]:
            entry = asset["rendition"]
            if entry:
                previous = renditions.get(entry["relative_path"])
                if previous and (previous["width"], previous["height"]) != (entry["width"], entry["height"]):
                    _fail("Repeated image renditions disagree about their pixel dimensions.")
                renditions[entry["relative_path"]] = entry
        for entry in manifest["files"]:
            self._verify_file(base/entry["relative_path"], entry, renditions.get(entry["relative_path"]))

    def read(self, descriptor, document, verify_assets=False):
        manifest = self._read_at(descriptor, document)
        if verify_assets:
            self._verify_assets(manifest)
        return manifest

    def registered(self, descriptor):
        validate_descriptor(descriptor)
        with self.store.connect() as db:
            row = db.execute("SELECT source_sha256, manifest_text FROM takeoff_image_extractions WHERE manifest_sha256=?",
                (descriptor["manifest_sha256"],)).fetchone()
        if row is None or row[0] != descriptor["source_sha256"]:
            return False
        try:
            payload = row[1].encode("utf-8")
            if len(payload) != descriptor["manifest_size"] or sha256(payload).hexdigest() != descriptor["manifest_sha256"]:
                return False
            value = json.loads(payload)
            return self._descriptor(value, descriptor["document_id"], payload) == descriptor
        except (TypeError, ValueError, KeyError, UnicodeError, RecursionError):
            return False

    def extract(self, document, first_page, page_count):
        _metadata(document)
        _integer(first_page, 1, len(document["pages"]))
        _integer(page_count, 1, 25)
        if first_page+page_count-1 > len(document["pages"]):
            _fail("The requested image extraction pages are outside the source PDF.")
        if not _SLOTS.acquire(blocking=False):
            _fail("Two image extractions are already running. Retry when one finishes.")
        try:
            self.documents._space(MAX_IMAGE_OUTPUT+MAX_IMAGE_MANIFEST+2*document["size"])
            source = self.documents.document_path(document)
            _directory(self.root/"image-jobs")
            with tempfile.TemporaryDirectory(prefix="extract-", dir=self.root/"image-jobs") as directory:
                job = _directory(directory)
                snapshot, output, response = job/"source.pdf", job/"output", job/"manifest.json"
                self.documents._copy(source, snapshot, document["sha256"], MAX_DOCUMENT_SIZE)
                with response.open("xb") as stdout:
                    try:
                        result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("takeoff_image_worker.py")),
                            str(snapshot), str(output), document["sha256"], str(first_page), str(page_count)],
                            stdout=stdout, stderr=subprocess.DEVNULL, timeout=IMAGE_TIMEOUT, check=False,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    except subprocess.TimeoutExpired as error:
                        raise ValidationError("Image extraction exceeded its time limit; no evidence was accepted.") from error
                if result.returncode:
                    _fail("Image extraction exceeded its resource limits or failed safely.")
                with _open_regular(response, MAX_IMAGE_MANIFEST) as stream:
                    payload = stream.read(MAX_IMAGE_MANIFEST+1)
                try:
                    manifest = json.loads(payload)
                    if not isinstance(manifest, dict) or "error" in manifest:
                        _fail("Image extraction could not safely inspect the selected source pages.")
                    if _canonical(manifest) != payload:
                        _fail("Image extraction did not return canonical metadata.")
                    descriptor = self._descriptor(manifest, document["id"], payload)
                except (TypeError, ValueError, KeyError, UnicodeError, RecursionError) as error:
                    raise ValidationError("Image extraction returned invalid metadata.") from error
                _validate_manifest(manifest, document, descriptor)
                if descriptor["pages"] != list(range(first_page, first_page+page_count)):
                    _fail("Image extraction returned a different page range.")
                _directory(output)
                inventory = {entry["relative_path"] for entry in manifest["files"]}
                found = set()
                for name in output.iterdir():
                    if name.name not in ("originals", "decoder", "renditions"):
                        _fail("Image extraction produced an unexpected output path.")
                    _directory(name)
                    for path in name.iterdir():
                        relative = name.name+"/"+path.name
                        _path(relative)
                        info = path.lstat()
                        if _linked(info) or not stat.S_ISREG(info.st_mode):
                            _fail("Image extraction produced an unsafe output file.")
                        found.add(relative)
                if found != inventory:
                    _fail("Image extraction file inventory does not match its output folder.")
                for entry in manifest["files"]:
                    self._verify_file(output/entry["relative_path"], entry)
                for entry in manifest["files"]:
                    self.documents._copy(output/entry["relative_path"], self.root/"image-files"/entry["relative_path"],
                        entry["sha256"], MAX_IMAGE_OUTPUT, allow_empty=not entry["relative_path"].startswith("renditions/"))
                self.documents._copy(response, self._manifest_path(descriptor), descriptor["manifest_sha256"], MAX_IMAGE_MANIFEST)
                self.read(descriptor, document, verify_assets=True)
                with self.store.connect() as db:
                    db.execute("INSERT OR IGNORE INTO takeoff_image_extractions(manifest_sha256,source_sha256,manifest_text) VALUES(?,?,?)",
                        (descriptor["manifest_sha256"], descriptor["source_sha256"], payload.decode("utf-8")))
                if not self.registered(descriptor):
                    _fail("The local image extraction provenance record could not be verified.")
                return deepcopy(descriptor)
        finally:
            _SLOTS.release()

    def _bound(self, owner, descriptor, document, assets=False):
        if owner is None:
            return
        _owner(owner)
        with self._lock:
            if owner in self._closed:
                _fail("This takeoff image evidence session has closed.")
            folder = self._sources.get(owner, {}).get(descriptor["manifest_sha256"])
        if folder is not None:
            manifest = self._read_at(descriptor, document, folder)
            if assets:
                self._verify_assets(manifest, folder)

    def assert_evidence(self, descriptors, documents, owner=None, require_registered=False):
        mapping = self._collection(descriptors, documents)
        self.documents.assert_documents([mapping[identifier] for identifier in {entry["document_id"] for entry in descriptors}], owner)
        for descriptor in descriptors:
            document = mapping[descriptor["document_id"]]
            self._bound(owner, descriptor, document, assets=True)
            self.read(descriptor, document, verify_assets=True)
            if require_registered and not self.registered(descriptor):
                _fail("This imported image evidence has no local extraction provenance. Extract the selected PDF pages again.")

    def publish(self, descriptors, documents, folder):
        mapping = self._collection(descriptors, documents)
        folder = _directory(folder, create=True)
        for descriptor in descriptors:
            manifest = self.read(descriptor, mapping[descriptor["document_id"]], verify_assets=True)
            for entry in manifest["files"]:
                self.documents._copy(self.root/"image-files"/entry["relative_path"], folder/"image-files"/entry["relative_path"],
                    entry["sha256"], MAX_IMAGE_OUTPUT, allow_empty=not entry["relative_path"].startswith("renditions/"))
            self.documents._copy(self._manifest_path(descriptor), self._manifest_path(descriptor, folder),
                descriptor["manifest_sha256"], MAX_IMAGE_MANIFEST)

    def bind_source(self, owner, descriptors, folder):
        _owner(owner)
        _list(descriptors, MAX_IMAGE_DESCRIPTORS)
        folder = Path(folder).absolute()
        if ".." in folder.parts:
            _fail("The portable image evidence folder must be contained.")
        # Missing folders still bind, so a warm cache cannot hide their loss.
        for parent in (folder, *folder.parents):
            try:
                info = parent.lstat()
            except FileNotFoundError:
                continue
            if _linked(info) or not stat.S_ISDIR(info.st_mode):
                _fail("Portable image evidence folders cannot redirect their paths.")
        mapping = {}
        for descriptor in descriptors:
            validate_descriptor(descriptor)
            mapping[descriptor["manifest_sha256"]] = folder
        with self._lock:
            if owner in self._closed:
                _fail("This takeoff image evidence session has closed.")
            self._sources[owner] = mapping

    def close_owner(self, owner):
        _owner(owner)
        with self._lock:
            self._closed.add(owner)
            self._sources.pop(owner, None)

    def restore(self, descriptors, documents, folder, owner=None):
        issues = []
        try:
            mapping = self._collection(descriptors, documents)
            if owner is not None:
                self.bind_source(owner, descriptors, folder)
        except (ValidationError, OSError) as error:
            return [{"code": "IMAGE_EVIDENCE_UNAVAILABLE", "message": str(error)}]
        for descriptor in descriptors:
            try:
                document = mapping[descriptor["document_id"]]
                manifest = self._read_at(descriptor, document, folder)
                self._verify_assets(manifest, folder)
                # Verify portable bytes before _copy's existing-cache fast path.
                for entry in manifest["files"]:
                    self.documents._copy(Path(folder)/"image-files"/entry["relative_path"], self.root/"image-files"/entry["relative_path"],
                        entry["sha256"], MAX_IMAGE_OUTPUT, allow_empty=not entry["relative_path"].startswith("renditions/"))
                self.documents._copy(self._manifest_path(descriptor, folder), self._manifest_path(descriptor),
                    descriptor["manifest_sha256"], MAX_IMAGE_MANIFEST)
                self.read(descriptor, document, verify_assets=True)
                if not self.registered(descriptor):
                    issues.append({"image_extraction_id": descriptor["id"], "code": "IMAGE_EXTRACTION_UNREGISTERED",
                        "message": "Imported image evidence needs a fresh local extraction before it can authorize physical review."})
            except (ValidationError, OSError) as error:
                issues.append({"image_extraction_id": descriptor["id"], "code": "IMAGE_EVIDENCE_UNAVAILABLE", "message": str(error)})
        return issues

    def rendition(self, descriptor, document, asset_id, owner=None):
        _uuid(asset_id)
        self._bound(owner, descriptor, document)
        manifest = self.read(descriptor, document)
        asset = next((entry for entry in manifest["assets"] if entry["id"] == asset_id), None)
        if asset is None or asset["rendition"] is None:
            _fail("This source image has no supported retained display rendition.")
        entry = asset["rendition"]
        with self._lock:
            folder = self._sources.get(owner, {}).get(descriptor["manifest_sha256"])
        if folder is not None:
            self._verify_file(folder/"image-files"/entry["relative_path"], entry, entry)
        path = self.root/"image-files"/entry["relative_path"]
        self._verify_file(path, entry, entry)
        with _open_regular(path, MAX_IMAGE_OUTPUT) as stream:
            payload = stream.read(MAX_IMAGE_OUTPUT+1)
        if len(payload) != entry["size"] or sha256(payload).hexdigest() != entry["sha256"]:
            _fail("The image rendition changed while being read.")
        return payload, "image/png"
