"""Portable, values-only project snapshots. Loading never writes local storage.

The file carries estimating inputs and a complete pricing snapshot, plus the
three calculator input maps. Results are always recalculated locally; files
cannot introduce formulas, source workbooks, or trusted reference exceptions.
"""

import base64
import binascii
import json
import math
import re
import unicodedata
from urllib.parse import quote

from .calculator import fields
from .catalog import ValidationError, effective_catalog
from .quote_details import QUOTE_DETAIL_LIMITS, validate_quote_details
from .workbook_calculators import source_model, validate_calculator_edits
from .schedule_rows import blank_schedule_defaults, normalize_schedule_rows


PROJECT_FORMAT = "ceasefire-project"
PROJECT_VERSION = 1
PROJECT_FILENAME = "CEASEFIRE-Project.json"
MAX_PROJECT_FILE = 16 * 1_048_576
CALCULATOR_IDS = ("steel_vermiculite", "steel_board", "ductwork")
ESTIMATE_REQUIRED_FIELDS = {"title", "workflow", "measurements", "inputs", "configuration", *QUOTE_DETAIL_LIMITS}
ESTIMATE_FIELDS = {*ESTIMATE_REQUIRED_FIELDS, "work_items"}


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
    return name + ".json"


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


def project_summary(payload):
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
    _check_tree(snapshot)
    if not isinstance(snapshot, dict) or snapshot.get("format") != PROJECT_FORMAT or type(snapshot.get("version")) is not int or snapshot["version"] != PROJECT_VERSION:
        raise ValidationError("This project file format or version is not supported.")
    estimate = snapshot.get("estimate")
    if not isinstance(estimate, dict) or not isinstance(snapshot.get("calculators"), dict):
        raise ValidationError("The project must contain its estimate and calculators.")
    details = project_details({key: estimate.get(key, "") for key in QUOTE_DETAIL_LIMITS})
    title = estimate.get("title")
    if not isinstance(title, str) or len(title) > 1000:
        raise ValidationError("The project quote name is invalid.")
    return {"estimate": {"title": title, **details}}


def project_download_header(filename):
    fallback = filename.encode("ascii", errors="replace").decode("ascii").replace('"', "-")
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def project_details(value=None):
    """Validate shared report identity without accepting quote inputs here."""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(QUOTE_DETAIL_LIMITS):
        raise ValidationError("Project details must contain Project No., Client and Site Address only.")
    return validate_quote_details(value)


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
    elif isinstance(value, str) and any(unicodedata.category(character) == "Cs" for character in value):
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


def export_project(store, request):
    """Return a self-contained snapshot of the active estimate and calculators."""
    if not isinstance(request, dict) or set(request) - {"estimate", "calculators", "penetration"} or "estimate" not in request:
        raise ValidationError("Include the current estimate and optional calculator drafts to save a project.")
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
        raise ValidationError("Project calculators must use the three available calculator names.")
    calculators = {}
    for calculator_id in CALCULATOR_IDS:
        draft = drafts.get(calculator_id)
        if calculator_id in drafts:
            if not isinstance(draft, dict) or 'inputs' not in draft or set(draft) - {"inputs", "schedule_rows"}:
                raise ValidationError("Each calculator draft must contain input values and optional schedule rows only.")
            inputs = draft["inputs"]
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
        "estimate": {key: prepared[key] for key in sorted(ESTIMATE_FIELDS)},
        "calculators": calculators,
    }
    if penetration is not None:
        snapshot["penetration"] = penetration
    payload = json.dumps(snapshot, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    if len(payload) > MAX_PROJECT_FILE:
        raise ValidationError("The project file must be at most 16 MB.")
    return payload


def import_project(store, filename, content_base64):
    """Validate the entire file and return drafts, leaving all local saves intact."""
    # Browsers add collision suffixes before .json (for example "project (1)").
    # The internal format/version, not a user-controlled filename, identifies it.
    if not isinstance(filename, str) or len(filename) > 255 or not filename.lower().endswith(".json"):
        raise ValidationError("Choose a project JSON file.")
    if not isinstance(content_base64, str) or len(content_base64) > ((MAX_PROJECT_FILE + 2) // 3) * 4:
        raise ValidationError("The project file must be at most 16 MB.")
    try:
        payload = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValidationError("The project file upload is invalid.") from error
    return load_project_bytes(store, payload)


def load_project_bytes(store, payload):
    """Validate a portable snapshot from either an upload or the linked folder."""
    if not payload or len(payload) > MAX_PROJECT_FILE:
        raise ValidationError("Choose a nonempty project file of at most 16 MB.")
    try:
        snapshot = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ValidationError("The project file must contain valid JSON.") from error
    _check_tree(snapshot)
    required = {"format", "version", "estimate", "calculators"}
    if not isinstance(snapshot, dict) or not required <= set(snapshot) or set(snapshot) - required - {"penetration"}:
        raise ValidationError("The project file contains missing or unsupported fields.")
    if snapshot["format"] != PROJECT_FORMAT or type(snapshot["version"]) is not int or snapshot["version"] != PROJECT_VERSION:
        raise ValidationError("This project file format or version is not supported.")
    estimate = snapshot["estimate"]
    if (not isinstance(estimate, dict) or not ESTIMATE_REQUIRED_FIELDS <= set(estimate)
            or set(estimate) - ESTIMATE_FIELDS):
        raise ValidationError("The project estimate must contain its complete inputs and pricing snapshot only.")
    if not isinstance(estimate.get("configuration"), dict) or "catalog" not in estimate["configuration"]:
        raise ValidationError("The project must include its own pricing library snapshot.")
    calculators = snapshot["calculators"]
    if not isinstance(calculators, dict) or set(calculators) != set(CALCULATOR_IDS):
        raise ValidationError("The project must contain all three calculators.")
    normalized = {}
    for calculator_id in CALCULATOR_IDS:
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
              "project_details": project_details({key: prepared[key] for key in QUOTE_DETAIL_LIMITS})}
    if penetration is not None:
        result["penetration"] = penetration
    return result
