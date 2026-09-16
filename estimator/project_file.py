"""Portable, values-only project snapshots. Loading never writes local storage.

The file carries estimating inputs and a complete pricing snapshot, plus the
three calculator input maps. Results are always recalculated locally; files
cannot introduce formulas, source workbooks, or trusted reference exceptions.
"""

import base64
import binascii
import json
import math
import unicodedata

from .calculator import fields
from .catalog import ValidationError, effective_catalog
from .quote_details import QUOTE_DETAIL_LIMITS, validate_quote_details
from .workbook_calculators import source_model, validate_calculator_edits


PROJECT_FORMAT = "ceasefire-project"
PROJECT_VERSION = 1
PROJECT_FILENAME = "CEASEFIRE-Project.ceasefire-project.json"
MAX_PROJECT_FILE = 16 * 1_048_576
CALCULATOR_IDS = ("steel_vermiculite", "steel_board", "ductwork")
ESTIMATE_FIELDS = {"title", "workflow", "measurements", "inputs", "configuration", *QUOTE_DETAIL_LIMITS}


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
    return validate_calculator_edits(calculator_id, value, {})


def export_project(store, request):
    """Return a self-contained snapshot of the active estimate and calculators."""
    if not isinstance(request, dict) or set(request) - {"estimate", "calculators"} or "estimate" not in request:
        raise ValidationError("Include the current estimate and optional calculator drafts to save a project.")
    _check_tree(request)
    estimate = request["estimate"]
    if not isinstance(estimate, dict) or set(estimate) - ESTIMATE_FIELDS:
        raise ValidationError("Project estimate contains unknown fields; include inputs and pricing, not calculated results.")
    prepared = store.prepare_quote(estimate)
    drafts = request.get("calculators", {})
    if not isinstance(drafts, dict) or set(drafts) - set(CALCULATOR_IDS):
        raise ValidationError("Project calculators must use the three available calculator names.")
    calculators = {}
    for calculator_id in CALCULATOR_IDS:
        draft = drafts.get(calculator_id)
        if calculator_id in drafts:
            if not isinstance(draft, dict) or set(draft) != {"inputs"}:
                raise ValidationError("Each calculator draft must contain its input values only.")
            inputs = draft["inputs"]
        else:
            inputs = store.calculator_state(calculator_id)["inputs"]
        calculators[calculator_id] = {
            "source_sha256": source_model(calculator_id)["source"]["sha256"],
            "inputs": _portable_inputs(calculator_id, inputs),
        }
    snapshot = {
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "estimate": {key: prepared[key] for key in sorted(ESTIMATE_FIELDS)},
        "calculators": calculators,
    }
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
    if not payload or len(payload) > MAX_PROJECT_FILE:
        raise ValidationError("Choose a nonempty project file of at most 16 MB.")
    try:
        snapshot = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ValidationError("The project file must contain valid JSON.") from error
    _check_tree(snapshot)
    if not isinstance(snapshot, dict) or set(snapshot) != {"format", "version", "estimate", "calculators"}:
        raise ValidationError("The project file contains missing or unsupported fields.")
    if snapshot["format"] != PROJECT_FORMAT or type(snapshot["version"]) is not int or snapshot["version"] != PROJECT_VERSION:
        raise ValidationError("This project file format or version is not supported.")
    estimate = snapshot["estimate"]
    if not isinstance(estimate, dict) or set(estimate) != ESTIMATE_FIELDS:
        raise ValidationError("The project estimate must contain its complete inputs and pricing snapshot only.")
    if not isinstance(estimate.get("configuration"), dict) or "catalog" not in estimate["configuration"]:
        raise ValidationError("The project must include its own pricing library snapshot.")
    calculators = snapshot["calculators"]
    if not isinstance(calculators, dict) or set(calculators) != set(CALCULATOR_IDS):
        raise ValidationError("The project must contain all three calculators.")
    normalized = {}
    for calculator_id in CALCULATOR_IDS:
        calculator = calculators[calculator_id]
        if not isinstance(calculator, dict) or set(calculator) != {"inputs", "source_sha256"}:
            raise ValidationError("Project calculators must contain input values and source version only.")
        source_hash = source_model(calculator_id)["source"]["sha256"]
        if calculator["source_sha256"] != source_hash:
            raise ValidationError("The project uses a different calculator source workbook version. Update to a compatible application before loading it.")
        normalized[calculator_id] = {"inputs": _portable_inputs(calculator_id, calculator["inputs"]), "source_sha256": source_hash}
    prepared = store.prepare_quote(estimate)
    # This is a new active draft, never a reference to a local saved quote.
    prepared["id"] = None
    metadata = fields(effective_catalog(prepared["configuration"]))
    return {"estimate": prepared, "fields": metadata, "calculators": normalized,
            "project_details": project_details({key: prepared[key] for key in QUOTE_DETAIL_LIMITS})}
