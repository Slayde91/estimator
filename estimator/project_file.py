"""Portable, values-only project snapshots. Loading never writes local storage.

The file carries estimating inputs and a complete pricing snapshot, plus the
calculator input maps. Results are always recalculated locally; files
cannot introduce formulas, source workbooks, or trusted reference exceptions.
"""

import base64
import binascii
import json
import math
import re
import unicodedata
from copy import deepcopy
from urllib.parse import quote

from .calculator import fields
from .catalog import ValidationError, effective_catalog
from .quote_details import QUOTE_DETAIL_LIMITS, validate_quote_details
from .workbook_calculators import source_model, validate_calculator_edits
from .schedule_rows import blank_schedule_defaults, empty_schedule_inputs, normalize_schedule_rows
from .edition import require_project_edition, validate_edition


PROJECT_FORMAT = "ceasefire-project"
PROJECT_VERSION = 1
TAKEOFF_PROJECT_VERSION = 2
PROJECT_EXTENSION = ".cf.json"
PROJECT_FILENAME = "CEASEFIRE-Project" + PROJECT_EXTENSION
MAX_PROJECT_FILE = 16 * 1_048_576
LEGACY_CALCULATOR_IDS = ("steel_vermiculite", "steel_board", "ductwork")
CALCULATOR_IDS = (*LEGACY_CALCULATOR_IDS, "steel_intumescent")
OPTIONAL_CALCULATOR_IDS = ("steel_intumescent",)
PROJECT_STATUSES = ("New", "Quote", "Engage", "Won", "Lost")
_LEGACY_PROJECT_STATUSES = {"Draft": "New", "Review": "Quote", "Presented": "Engage", "Accepted": "Won"}
WORKSPACE_FIELDS = {"estimate", "calculators", "penetration", "takeoffs", "library_drafts"}
MAX_PROJECT_ESTIMATES = 50
# Contact/account metadata is optional in historical portable files.
ESTIMATE_REQUIRED_FIELDS = {"title", "workflow", "measurements", "inputs", "configuration", "client", "site_address", "project_no"}
ESTIMATE_FIELDS = {*ESTIMATE_REQUIRED_FIELDS, *QUOTE_DETAIL_LIMITS, "work_items"}


def validate_project_status(value):
    if isinstance(value, str):
        value = _LEGACY_PROJECT_STATUSES.get(value, value)
        if value in PROJECT_STATUSES:
            return value
    raise ValidationError("Choose New, Quote, Engage, Won or Lost for the project status.")


def estimate_descriptors(value, active_id):
    """Validate the bounded collection before any nested workspace processing."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PROJECT_ESTIMATES:
        raise ValidationError("A project must contain between 1 and 50 named estimates.")
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"id", "name", "workspace"}:
            raise ValidationError("Each project estimate requires its ID, name and workspace only.")
        identifier, name, workspace = item["id"], item["name"], item["workspace"]
        if not isinstance(identifier, str) or not re.fullmatch(r"estimate-(?:1|[0-9a-f]{32})", identifier) or identifier in seen:
            raise ValidationError("Project estimates require unique supported IDs.")
        if not isinstance(name, str) or not name.strip() or len(name) > 150:
            raise ValidationError("Give every estimate a name between 1 and 150 characters.")
        if not isinstance(workspace, dict) or not {"estimate", "calculators"} <= set(workspace) or set(workspace) - WORKSPACE_FIELDS:
            raise ValidationError("An estimate workspace must contain its estimate, calculators and supported project data only.")
        if (not isinstance(workspace["estimate"], dict) or not ESTIMATE_REQUIRED_FIELDS <= set(workspace["estimate"])
                or not isinstance(workspace["calculators"], dict) or not set(LEGACY_CALCULATOR_IDS) <= set(workspace["calculators"])):
            raise ValidationError("Every named estimate must include its complete estimate inputs and original calculator drafts.")
        seen.add(identifier)
        result.append({"id": identifier, "name": name, "workspace": workspace})
    if not isinstance(active_id, str) or active_id not in seen:
        raise ValidationError("Choose an active estimate from this project's estimate collection.")
    return result


def project_filename(title):
    """Use the quote name without allowing path components or Windows devices."""
    name = unicodedata.normalize("NFC", str(title or "Untitled quote"))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "-", name).strip(" .")
    # Leave ample room for the extension, including supplementary Unicode chars.
    name = name.encode("utf-16-le")[:240].decode("utf-16-le", errors="ignore").rstrip(" .")
    if not name:
        name = "Untitled quote"
    if re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name):
        name = "_" + name
    return name + PROJECT_EXTENSION


def is_project_filename(filename):
    """Keep file selection separate from validation of the snapshot contents."""
    return isinstance(filename, str) and filename.lower().endswith(PROJECT_EXTENSION)


def has_project_identity(payload, *, previously_recognized=False):
    """Recognize a top-level format marker without accepting a project.

    Folder scans may ignore unrelated JSON, including broken exporter files.
    Decode root members in order so a recognized project still reaches strict
    validation when its later contents are truncated or otherwise invalid.
    Nested markers and quoted mentions never identify a project. A previously
    recognized file remains reportable if it becomes invalid JSON, but valid
    unrelated JSON replaces that identity. This bounded probe is not used to
    open or authorize files.
    """
    payload = payload[:MAX_PROJECT_FILE + 1]
    text = payload.decode("utf-8-sig", errors="replace")
    whitespace = re.compile(r"[ \t\r\n]*")
    position = whitespace.match(text).end()
    decoder = json.JSONDecoder()
    try:
        if text[position:position + 1] == "{":
            position += 1
        else:
            position = len(text)
        while position < len(text):
            position = whitespace.match(text, position).end()
            key, position = decoder.raw_decode(text, position)
            if not isinstance(key, str):
                break
            position = whitespace.match(text, position).end()
            if text[position:position + 1] != ":":
                break
            position = whitespace.match(text, position + 1).end()
            value, position = decoder.raw_decode(text, position)
            if key == "format" and value == PROJECT_FORMAT:
                return True
            position = whitespace.match(text, position).end()
            if text[position:position + 1] != ",":
                break
            position += 1
    except (ValueError, RecursionError):
        pass
    if previously_recognized:
        try:
            json.loads(payload.decode("utf-8-sig"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError, RecursionError, ValidationError):
            return True
    return False


def project_summary(payload, *, edition='full'):
    """Read display metadata without calculating or applying a project.

    Browsing a folder must remain cheap. Full pricing, source and calculator
    validation still runs in load_project_bytes immediately before opening.
    """
    if not payload or len(payload) > MAX_PROJECT_FILE:
        raise ValidationError("Choose a nonempty project file of at most 16 MB.")
    try:
        snapshot = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ValidationError("The project file must contain valid JSON.") from error
    require_project_edition(snapshot, edition)
    _check_tree(snapshot)
    if not isinstance(snapshot, dict) or snapshot.get("format") != PROJECT_FORMAT or type(snapshot.get("version")) is not int or snapshot["version"] not in {PROJECT_VERSION, TAKEOFF_PROJECT_VERSION}:
        raise ValidationError("This project file format or version is not supported.")
    estimate = snapshot.get("estimate")
    if not isinstance(estimate, dict) or not isinstance(snapshot.get("calculators"), dict):
        raise ValidationError("The project must contain its estimate and calculators.")
    details = project_details({key: estimate.get(key, "") for key in QUOTE_DETAIL_LIMITS})
    title = estimate.get("title")
    if not isinstance(title, str) or len(title) > 1000:
        raise ValidationError("The project quote name is invalid.")
    from .commercial_documents import commercial_cards
    certificate = snapshot.get("certifications")
    source_project_id = certificate.get("project_id") if isinstance(certificate,dict) else None
    from .directory_documents import snapshot_cards
    result = {"source_project_id": source_project_id, "commercial_cards": commercial_cards(snapshot.get("commercial_documents")), "estimate": {"title": title, **details},
              "directory_cards": snapshot_cards(snapshot, source_project_id), "certification_manifest": certificate,
              "project_status": validate_project_status(snapshot.get("project_status", "New")),
              "clients": [details["client"]], "project_numbers": [details["project_no"]]}
    if "estimates" in snapshot or "active_estimate_id" in snapshot:
        entries = estimate_descriptors(snapshot.get("estimates"), snapshot.get("active_estimate_id"))
        result["estimates"] = [{"id": entry["id"], "name": entry["name"]} for entry in entries]
        result["active_estimate_id"] = snapshot["active_estimate_id"]
        for entry in entries:
            child = project_details({key: entry['workspace']['estimate'].get(key, '') for key in QUOTE_DETAIL_LIMITS})
            result['clients'].append(child['client'])
            result['project_numbers'].append(child['project_no'])
    return result


def project_download_header(filename):
    fallback = filename.encode("ascii", errors="replace").decode("ascii").replace('"', "-")
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def project_details(value=None):
    """Validate shared report identity without accepting quote inputs here."""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(QUOTE_DETAIL_LIMITS):
        raise ValidationError("Project details contain unsupported fields.")
    return validate_quote_details(value)


_SURROGATE = re.compile(r'[\ud800-\udfff]')


def _same_project_values(left, right):
    """Compare untrusted JSON without treating booleans as numeric inputs.

    Reuse is request-local and only safe for the same types as well as values:
    Python's ordinary equality considers True and 1 equal, while calculator
    input validation deliberately rejects booleans.
    """
    if left is right:
        return True
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_project_values(value, right[key]) for key, value in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_project_values(a, b) for a, b in zip(left, right))
    return left == right


def _check_tree(value, depth=0):
    # Bound nesting independently of Python's JSON decoder recursion limit.
    if depth > 32:
        raise ValidationError("The project file contains excessively nested data.")
    if isinstance(value, dict):
        for key, child in value.items():
            _check_tree(key, depth + 1)
            _check_tree(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _check_tree(child, depth + 1)
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValidationError("Project values must contain finite numbers.")
    elif isinstance(value, str) and _SURROGATE.search(value):
        raise ValidationError("Project text contains an invalid Unicode character.")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError("The project file contains duplicate JSON fields.")
        result[key] = value
    return result


def _reject_constant(value):
    raise ValidationError(f"Invalid project number: {value}.")


def _portable_inputs(calculator_id, value):
    # An untrusted file cannot nominate its own saved-reference allowlist.
    # Source and reviewed baseline references remain usable on any computer.
    if not isinstance(value, dict):
        raise ValidationError("Each project calculator must contain a worksheet input object.")
    return validate_calculator_edits(calculator_id, blank_schedule_defaults(calculator_id, value), {})


def _portable_penetration(value, *, saved=False):
    """Keep the separate estimator draft tied to its immutable workbook source."""
    from .penetration_calculator import normalize_composer, normalize_draft, source_model as penetration_source
    required = {"draft", "source_sha256"} if saved else {"draft"}
    optional = {"composer"} if saved else {"composer", "library_tracking_version"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - optional:
        raise ValidationError("Firestopping Estimator projects must contain their schedule, optional composer and source version only.")
    if "library_tracking_version" in value and (type(value["library_tracking_version"]) is not int or value["library_tracking_version"] != 1):
        raise ValidationError("The Firestopping Estimator library tracking version is not supported.")
    source_hash = penetration_source()["source"]["sha256"]
    if saved and value["source_sha256"] != source_hash:
        raise ValidationError("The project uses a different Firestopping Estimator workbook version.")
    result = {"source_sha256": source_hash, "draft": normalize_draft(value["draft"])}
    if "composer" in value:
        result["composer"] = normalize_composer(value["composer"])
    return result


def export_project(store, request, *, edition='full'):
    """Return a portable project snapshot with verified evidence manifests."""
    payload, _, _ = prepare_project_export(store, request, edition=edition)
    return payload


def prepare_project_export(store, request, *, edition='full'):
    """Keep the verified portable values and calculation together for linked Quote schedules."""
    snapshot, prepared = _export_project_snapshot(store, request, edition=edition)
    payload = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    if len(payload) > MAX_PROJECT_FILE:
        raise ValidationError("The complete project, including all estimates, must be at most 16 MB.")
    return payload, snapshot, prepared


def _export_project_snapshot(store, request, *, edition, tree_checked=False):
    """Normalize nested estimates without separate JSON round trips."""
    require_project_edition(request, edition)
    if not isinstance(request, dict) or set(request) - {"estimate", "calculators", "penetration", "takeoffs", "library_drafts", "certifications", "documentation", "project_status", "estimates", "active_estimate_id", "commercial_documents", "swms", "passive_fire_register"} or "estimate" not in request:
        raise ValidationError("Include the current estimate and optional calculator drafts to save a project.")
    if not tree_checked:
        _check_tree(request)
    estimate = request["estimate"]
    if not isinstance(estimate, dict) or set(estimate) - ESTIMATE_FIELDS:
        raise ValidationError("Project estimate contains unknown fields; include inputs and pricing, not calculated results.")
    penetration = _portable_penetration(request["penetration"]) if "penetration" in request else None
    quote_inputs = dict(estimate)
    if penetration is not None:
        quote_inputs['penetration'] = {key: penetration[key] for key in ('source_sha256', 'draft')}
    prepared = store.prepare_quote(quote_inputs)
    drafts = request.get("calculators", {})
    if not isinstance(drafts, dict) or set(drafts) - set(CALCULATOR_IDS):
        raise ValidationError("Project calculators must use the available calculator names.")
    calculators = {}
    for calculator_id in CALCULATOR_IDS:
        draft = drafts.get(calculator_id)
        if calculator_id in drafts:
            if not isinstance(draft, dict) or 'inputs' not in draft or set(draft) - {"inputs", "schedule_rows"}:
                raise ValidationError("Each calculator draft must contain input values and optional schedule rows only.")
            inputs = draft["inputs"]
        elif calculator_id in OPTIONAL_CALCULATOR_IDS and set(drafts) == set(LEGACY_CALCULATOR_IDS):
            # An older project's complete three-map draft cannot opt into a
            # different project's locally saved SC902 schedule by omission.
            inputs = empty_schedule_inputs(calculator_id)
            draft = {"inputs": inputs}
        else:
            draft = store.calculator_state(calculator_id)
            inputs = draft["inputs"]
        inputs = _portable_inputs(calculator_id, inputs)
        calculators[calculator_id] = {
            "source_sha256": source_model(calculator_id)["source"]["sha256"],
            "inputs": inputs,
            "schedule_rows": normalize_schedule_rows(calculator_id, inputs, draft.get('schedule_rows')),
        }
    snapshot = {
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "project_status": validate_project_status(request.get("project_status", "New")),
        "estimate": {key: prepared[key] for key in sorted(ESTIMATE_FIELDS)},
        "calculators": calculators,
    }
    if penetration is not None:
        snapshot["penetration"] = penetration
    if "library_drafts" in request:
        from .project_library_drafts import normalize_library_drafts
        snapshot["library_drafts"] = normalize_library_drafts(request["library_drafts"])
    if "certifications" in request:
        from .certification_projects import validate_manifest
        snapshot["certifications"] = validate_manifest(request["certifications"])
    if "documentation" in request:
        from .project_documentation import validate_manifest
        snapshot["documentation"] = validate_manifest(request["documentation"])
        if snapshot.get('certifications', {}).get('project_id') != snapshot['documentation']['project_id']:
            raise ValidationError('Saved project documents require the same explicit project identity as their project workspace.')
    if "takeoffs" in request:
        from .takeoff_model import validate_snapshot
        snapshot["takeoffs"] = validate_snapshot(request["takeoffs"])
        snapshot["version"] = TAKEOFF_PROJECT_VERSION
    if "passive_fire_register" in request:
        from .passive_fire_register import normalize_register
        snapshot["passive_fire_register"] = normalize_register(request["passive_fire_register"])
    if "swms" in request:
        from .swms import validate_swms_snapshot
        snapshot["swms"] = validate_swms_snapshot(request["swms"])
        if snapshot["swms"] is not None and snapshot.get("certifications", {}).get("project_id") != snapshot["swms"]["project_id"]:
            raise ValidationError("SWMS must belong to the saved project workspace.")
    if "commercial_documents" in request:
        from .commercial_documents import validate_commercial_documents
        snapshot["commercial_documents"] = validate_commercial_documents(request["commercial_documents"])
        if snapshot["commercial_documents"] is not None and snapshot.get("certifications", {}).get("project_id") != snapshot["commercial_documents"]["project_id"]:
            raise ValidationError("Commercial documents must belong to the saved certificate/project workspace.")
    if "estimates" in request or "active_estimate_id" in request:
        entries = estimate_descriptors(request.get("estimates"), request.get("active_estimate_id"))
        normalized = []
        source_workspace = {key: request[key] for key in WORKSPACE_FIELDS if key in request}
        for entry in entries:
            # The active workspace is sent both at the root and in estimates.
            # Reuse only exact input equality after validating the root; other
            # estimates still receive their complete independent validation.
            child = ({key: deepcopy(snapshot[key]) for key in WORKSPACE_FIELDS if key in snapshot}
                     if _same_project_values(entry['workspace'], source_workspace) else
                     _export_project_snapshot(store, entry['workspace'], edition=edition, tree_checked=True)[0])
            normalized.append({"id": entry["id"], "name": entry["name"],
                               "workspace": {key: child[key] for key in WORKSPACE_FIELDS if key in child}})
        active = next(entry["workspace"] for entry in normalized if entry["id"] == request["active_estimate_id"])
        if {key: snapshot[key] for key in WORKSPACE_FIELDS if key in snapshot} != active:
            raise ValidationError("The current workspace must match the selected project estimate.")
        snapshot["estimates"] = normalized
        snapshot["active_estimate_id"] = request["active_estimate_id"]
    return snapshot, prepared


def import_project(store, filename, content_base64, *, edition='full'):
    """Validate the entire file and return drafts, leaving all local saves intact."""
    validate_edition(edition)
    # The extension selects project files; the internal format/version still
    # validates their contents. Renamed legacy snapshots retain their data.
    if not is_project_filename(filename) or len(filename) > 255:
        raise ValidationError("Choose a .cf.json project file.")
    if not isinstance(content_base64, str) or len(content_base64) > ((MAX_PROJECT_FILE + 2) // 3) * 4:
        raise ValidationError("The complete project, including all estimates, must be at most 16 MB.")
    try:
        payload = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValidationError("The project file upload is invalid.") from error
    return load_project_bytes(store, payload, edition=edition)


def load_project_bytes(store, payload, *, edition='full'):
    """Validate a portable snapshot from either an upload or the linked folder."""
    validate_edition(edition)
    if not payload or len(payload) > MAX_PROJECT_FILE:
        raise ValidationError("Choose a nonempty project file of at most 16 MB.")
    try:
        snapshot = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ValidationError("The project file must contain valid JSON.") from error
    require_project_edition(snapshot, edition)
    _check_tree(snapshot)
    return _load_project_snapshot(store, snapshot, edition=edition)


def _load_project_snapshot(store, snapshot, *, edition):
    """Validate sub-workspaces within the already decoded, tree-checked file."""
    require_project_edition(snapshot, edition)
    required = {"format", "version", "estimate", "calculators"}
    if not isinstance(snapshot, dict) or not required <= set(snapshot) or set(snapshot) - required - {"penetration", "takeoffs", "library_drafts", "certifications", "documentation", "project_status", "estimates", "active_estimate_id", "commercial_documents", "swms", "passive_fire_register"}:
        raise ValidationError("The project file contains missing or unsupported fields.")
    if snapshot["format"] != PROJECT_FORMAT or type(snapshot["version"]) is not int or snapshot["version"] not in {PROJECT_VERSION, TAKEOFF_PROJECT_VERSION}:
        raise ValidationError("This project file format or version is not supported.")
    if (snapshot["version"] == TAKEOFF_PROJECT_VERSION) != ("takeoffs" in snapshot):
        raise ValidationError("Takeoff projects require version 2 and a complete takeoff snapshot.")
    estimate = snapshot["estimate"]
    if (not isinstance(estimate, dict) or not ESTIMATE_REQUIRED_FIELDS <= set(estimate)
            or set(estimate) - ESTIMATE_FIELDS):
        raise ValidationError("The project estimate must contain its complete inputs and pricing snapshot only.")
    if not isinstance(estimate.get("configuration"), dict) or "catalog" not in estimate["configuration"]:
        raise ValidationError("The project must include its own pricing library snapshot.")
    calculators = snapshot["calculators"]
    if (not isinstance(calculators, dict) or not set(LEGACY_CALCULATOR_IDS) <= set(calculators)
            or set(calculators) - set(CALCULATOR_IDS)):
        raise ValidationError("The project must contain its three original calculators and may include the steel intumescent calculator.")
    normalized = {}
    for calculator_id in CALCULATOR_IDS:
        if calculator_id not in calculators:
            # Loading a legacy file only returns an empty new draft. It never
            # reads or rewrites a receiver's independently saved SC902 state.
            inputs = empty_schedule_inputs(calculator_id)
            normalized[calculator_id] = {"inputs": inputs,
                "source_sha256": source_model(calculator_id)["source"]["sha256"],
                "schedule_rows": normalize_schedule_rows(calculator_id, inputs)}
            continue
        calculator = calculators[calculator_id]
        if (not isinstance(calculator, dict) or not {"inputs", "source_sha256"} <= set(calculator)
                or set(calculator) - {"inputs", "source_sha256", "schedule_rows"}):
            raise ValidationError("Project calculators must contain input values, source version and optional schedule rows only.")
        source_hash = source_model(calculator_id)["source"]["sha256"]
        if calculator["source_sha256"] != source_hash:
            raise ValidationError("The project uses a different calculator source workbook version. Update to a compatible application before loading it.")
        inputs = _portable_inputs(calculator_id, calculator["inputs"])
        normalized[calculator_id] = {"inputs": inputs, "source_sha256": source_hash,
                                     "schedule_rows": normalize_schedule_rows(calculator_id, inputs, calculator.get('schedule_rows'))}
    penetration = _portable_penetration(snapshot["penetration"], saved=True) if "penetration" in snapshot else None
    quote_inputs = {**estimate, "work_items": estimate.get("work_items", [])}
    if penetration is not None:
        quote_inputs['penetration'] = {key: penetration[key] for key in ('source_sha256', 'draft')}
    prepared = store.prepare_quote(quote_inputs, read_only=True)
    # This is a new active draft, never a reference to a local saved quote.
    prepared["id"] = None
    metadata = fields(effective_catalog(prepared["configuration"]))
    result = {"estimate": prepared, "fields": metadata, "calculators": normalized,
              "project_status": validate_project_status(snapshot.get("project_status", "New")),
              "project_details": project_details({key: prepared[key] for key in QUOTE_DETAIL_LIMITS})}
    if penetration is not None:
        result["penetration"] = penetration
    if "library_drafts" in snapshot:
        from .project_library_drafts import normalize_library_drafts
        result["library_drafts"] = normalize_library_drafts(snapshot["library_drafts"])
    if "certifications" in snapshot:
        from .certification_projects import validate_manifest
        result["certifications"] = validate_manifest(snapshot["certifications"])
    if "documentation" in snapshot:
        from .project_documentation import validate_manifest
        result["documentation"] = validate_manifest(snapshot["documentation"])
        if result.get('certifications', {}).get('project_id') != result['documentation']['project_id']:
            raise ValidationError('Saved project documents do not match this project workspace identity.')
    if "takeoffs" in snapshot:
        from .takeoff_model import validate_snapshot
        result["takeoffs"] = validate_snapshot(snapshot["takeoffs"])
    if "passive_fire_register" in snapshot:
        from .passive_fire_register import normalize_register
        result["passive_fire_register"] = normalize_register(snapshot["passive_fire_register"])
    if "swms" in snapshot:
        from .swms import validate_swms_snapshot
        result["swms"] = validate_swms_snapshot(snapshot["swms"])
        if result["swms"] is not None and result.get("certifications", {}).get("project_id") != result["swms"]["project_id"]:
            raise ValidationError("SWMS do not match this project workspace identity.")
    if "commercial_documents" in snapshot:
        from .commercial_documents import validate_commercial_documents
        result["commercial_documents"] = validate_commercial_documents(snapshot["commercial_documents"])
        if result["commercial_documents"] is not None and result.get("certifications", {}).get("project_id") != result["commercial_documents"]["project_id"]:
            raise ValidationError("Commercial documents do not match this project workspace identity.")
    if "estimates" in snapshot or "active_estimate_id" in snapshot:
        entries = estimate_descriptors(snapshot.get("estimates"), snapshot.get("active_estimate_id"))
        active = next(entry["workspace"] for entry in entries if entry["id"] == snapshot["active_estimate_id"])
        source_workspace = {key: snapshot[key] for key in WORKSPACE_FIELDS if key in snapshot}
        if source_workspace != active:
            raise ValidationError("The saved current workspace does not match its active estimate.")
        normalized = []
        for entry in entries:
            workspace = entry["workspace"]
            child = {"format": PROJECT_FORMAT, "version": TAKEOFF_PROJECT_VERSION if "takeoffs" in workspace else PROJECT_VERSION, **workspace}
            if workspace is active and _same_project_values(workspace, source_workspace):
                # Raw root/active equality was checked above. Give each API
                # location its own mutable data, as a normal JSON decode does.
                prepared = {key: deepcopy(value) for key, value in result.items()
                            if key in WORKSPACE_FIELDS | {'fields', 'project_details'}}
                prepared['project_status'] = 'New'
            else:
                prepared = _load_project_snapshot(store, child, edition=edition)
            normalized.append({"id": entry["id"], "name": entry["name"], "workspace": prepared})
        result["estimates"] = normalized
        result["active_estimate_id"] = snapshot["active_estimate_id"]
    return result


def assert_project_overwrite(payload, *, edition='full'):
    """A reduced edition must never erase data it cannot load or understand.

    This is called on the actual selected target immediately before its atomic
    replacement. Return the decoded snapshot when the edition requires strict
    parsing, so the remaining overwrite checks can reuse it.
    """
    if validate_edition(edition) == 'full':
        return
    try:
        snapshot = json.loads(payload.decode('utf-8-sig'), object_pairs_hook=_unique_object,
                              parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ValidationError('This existing file cannot be checked for edition compatibility. '
                              'Choose a new filename; the original file has not been changed.') from error
    require_project_edition(snapshot, edition)
    if isinstance(snapshot, dict) and snapshot.get('format') == PROJECT_FORMAT:
        if type(snapshot.get('version')) is not int or snapshot['version'] != PROJECT_VERSION:
            raise ValidationError('This existing project version is not supported by this edition. '
                                  'Choose a new filename; the original file has not been changed.')
    return snapshot
