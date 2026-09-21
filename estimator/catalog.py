"""Immutable defaults, replaceable pricing libraries, and validated overrides."""

from copy import deepcopy
import json
import hashlib
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_INVENTORY_ITEMS = 5000
MAX_RATE_ITEMS = 10000
FIRESTOPPING_GROUPS = (
    {"key": "workers", "label": "Teams/Crews", "list_column": "AK"},
    {"key": "boards", "label": "Board or Batt Type", "list_column": "M"},
    {"key": "collars", "label": "Collar Type", "list_column": "B"},
    {"key": "frames", "label": "Frame Type", "list_column": "AN"},
    {"key": "wraps", "label": "Wrap Type", "list_column": "E"},
    {"key": "mastics", "label": "Mastic Type", "list_column": "S"},
    {"key": "materials", "label": "Materials", "list_column": "AR"},
)


class ValidationError(ValueError):
    """Input rejected before changing persisted data."""


def baseline():
    return json.loads((ROOT / "data" / "baseline.json").read_text(encoding="utf-8"))


def finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{label} must be a number.")
    if abs(value) > 1e12 or not math.isfinite(value):
        raise ValidationError(f"{label} must be finite and at most 1 trillion in magnitude.")
    return value


def catalog_signature(data=None):
    """Stable lookup identities, excluding prices/yields which a quote freezes."""
    data = baseline() if data is None else data
    identities = {group: [(r["id"], r["name"], r.get("inventory_id")) for r in rows]
                  for group, rows in data["rate_groups"].items()}
    return hashlib.sha256(json.dumps(identities, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def has_yield(rate):
    """Imported records have an explicit flag; older snapshots retain provenance."""
    return rate.get("uses_yield", bool(rate.get("source", {}).get("yield")))


def yield_unit(group, rate):
    """Calculation unit, independent of descriptive labels in older snapshots.

    Calculator B16:B22 are square-metre coverage (except quantity-only B18),
    while B23 is linear metres. Each yield lookup divides that coverage into
    purchased units. Product packaging does not change these dimensions.
    """
    if not has_yield(rate):
        return ""
    return "m / unit" if group == "mastic" else "m² / unit"


def product_service_name(product=None, records=()):
    """One descriptive label, without changing any estimator lookup identity.

    Explicit labels win. Otherwise choose the longest existing label, retaining
    the first candidate on ties (description, product name, then rate labels).
    """
    product = product or {}
    rates = [record[-1] if isinstance(record, tuple) else record for record in records]
    for record in (product, *rates):
        value = record.get("product_service")
        if isinstance(value, str) and value.strip():
            return value
    candidates = [product.get("sales_description"), product.get("name")]
    for rate in rates:
        candidates.extend((rate.get("display_name"), rate.get("name")))
    candidates = [value for value in candidates if isinstance(value, str) and value.strip()]
    return max(candidates, key=lambda value: len(value.strip()), default="")


def _text(value, label, maximum=1000, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValidationError(f"{label} must be {'text' if empty else 'nonempty text'} of at most {maximum} characters.")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        raise ValidationError(f"{label} contains unsupported control characters.")
    return value


def _amount(value, label, blank=False, minimum=0):
    if blank and (value is None or value == ""):
        return value
    finite_number(value, label)
    if value < minimum:
        raise ValidationError(f"{label} cannot be below {minimum}.")
    return value


def validate_catalog(value):
    """Validate a complete replacement without changing the workbook defaults.

    Groups are the estimator's existing calculation categories. A replacement
    may add/remove their choices, but cannot redefine what a category means.
    Source metadata is retained for audit only, never interpreted as formulas.
    """
    allowed = {"schema_version", "sources", "markup", "inventory", "rate_groups", "rate_group_rules", "provenance_notes"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValidationError("Pricing library must contain inventory and rate groups with supported metadata only.")
    data = deepcopy(value)
    reference = baseline()
    if data.get("schema_version", 1) != 1 or isinstance(data.get("schema_version"), bool):
        raise ValidationError("Unsupported pricing library schema version.")
    data["schema_version"] = 1
    notes = data.setdefault("provenance_notes", [])
    if not isinstance(notes, list) or len(notes) > 50:
        raise ValidationError("Library provenance notes must be a list with at most 50 entries.")
    for note in notes:
        _text(note, "Library provenance note", 2000)
    data["markup"] = _amount(data.get("markup", reference["markup"]), "Library markup", minimum=-1)
    sources = data.setdefault("sources", {})
    if not isinstance(sources, dict) or len(sources) > 20:
        raise ValidationError("Library sources must be an object with at most 20 entries.")
    for key, source in sources.items():
        _text(key, "Source name", 200)
        if not isinstance(source, dict) or set(source) - {"filename", "sha256"}:
            raise ValidationError(f"Source {key} must contain a filename and SHA-256 hash only.")
        for field in ("filename", "sha256"):
            _text(source.get(field), f"Source {key} {field}", 1000)
    if not isinstance(data.get("inventory"), list) or len(data["inventory"]) > MAX_INVENTORY_ITEMS:
        raise ValidationError(f"Library inventory must be a list of at most {MAX_INVENTORY_ITEMS} products.")
    groups = data.get("rate_groups")
    if not isinstance(groups, dict) or groups.keys() != reference["rate_groups"].keys():
        raise ValidationError("Library must include exactly the 14 supported rate groups.")
    supplied_rules = data.get("rate_group_rules", reference["rate_group_rules"])
    if not isinstance(supplied_rules, dict) or supplied_rules.keys() != reference["rate_group_rules"].keys():
        raise ValidationError("Library rate group rules do not match the supported categories.")
    for group, rule in supplied_rules.items():
        if not isinstance(rule, dict) or any(rule.get(field) != reference["rate_group_rules"][group][field]
                                             for field in ("name_column", "yield_column")):
            raise ValidationError(f"Library cannot change the calculation rules for {group}.")
    data["rate_group_rules"] = deepcopy(reference["rate_group_rules"])
    inventory_ids = set()
    inventory_fields = {"id", "item_code", "name", "sales_description", "product_service", "supplier_price", "supplier_price_raw",
                        "sales_price", "calculated_sell_price", "pricing_mode", "markup", "status", "inventory_type", "properties", "source",
                        "firestopping_groups"}
    firestopping_keys = {group["key"] for group in FIRESTOPPING_GROUPS}
    for item in data["inventory"]:
        if not isinstance(item, dict) or set(item) - inventory_fields:
            raise ValidationError("Inventory products contain unsupported fields.")
        key = _text(item.get("id"), "Inventory ID", 200)
        if key in inventory_ids:
            raise ValidationError(f"Duplicate inventory ID: {key}.")
        inventory_ids.add(key)
        for field in ("name", "sales_description"):
            _text(item.get(field), f"Inventory {key} {field}", empty=field == "sales_description")
        if "product_service" in item:
            _text(item["product_service"], f"Inventory {key} Product/Service")
        if "firestopping_groups" in item:
            assigned = item["firestopping_groups"]
            if not isinstance(assigned, list) or len(assigned) > len(FIRESTOPPING_GROUPS):
                raise ValidationError(f"Inventory {key} Firestopping groups must be a list with at most {len(FIRESTOPPING_GROUPS)} entries.")
            if any(not isinstance(group, str) or group not in firestopping_keys for group in assigned):
                raise ValidationError(f"Inventory {key} contains an unsupported Firestopping group.")
            if len(set(assigned)) != len(assigned):
                raise ValidationError(f"Inventory {key} contains duplicate Firestopping groups.")
        if not isinstance(item.get("pricing_mode"), str) or item["pricing_mode"] not in {"supplier_markup", "manual"}:
            raise ValidationError(f"Inventory {key} has an unsupported pricing mode.")
        _amount(item.get("sales_price"), f"Inventory {key} sales price")
        _amount(item.get("markup"), f"Inventory {key} markup", minimum=-1)
        if item.get("supplier_price") is not None or item["pricing_mode"] == "supplier_markup":
            _amount(item.get("supplier_price"), f"Inventory {key} supplier price")
        else:
            item["supplier_price"] = None
        item.setdefault("item_code", key)
        if isinstance(item["item_code"], str):
            _text(item["item_code"], f"Inventory {key} item code", 200, empty=True)
        else:
            finite_number(item["item_code"], f"Inventory {key} item code")
        for field in ("status", "inventory_type"):
            item.setdefault(field, "")
            _text(item[field], f"Inventory {key} {field}", empty=True)
        item.setdefault("calculated_sell_price", item["sales_price"])
        _amount(item["calculated_sell_price"], f"Inventory {key} calculated sell price", blank=True)
        properties = item.setdefault("properties", {})
        if not isinstance(properties, dict) or len(properties) > 30:
            raise ValidationError(f"Inventory {key} properties must be an object with at most 30 values.")
        for name, number in properties.items():
            _text(name, f"Inventory {key} property name", 100)
            if isinstance(number, str):
                # The original inventory includes dimension ranges, e.g. 40-65.
                # These descriptive properties do not drive rate yield lookups.
                _text(number, f"Inventory {key} {name}", 1000, empty=True)
            else:
                _amount(number, f"Inventory {key} {name}", blank=True)
        if not isinstance(item.setdefault("source", {}), dict):
            raise ValidationError(f"Inventory {key} source must be an object.")
    rate_ids = set()
    rate_fields = {"id", "name", "display_name", "product_service", "price", "yield", "yield_unit", "inventory_id", "source", "uses_yield", "price_mode"}
    for group, rows in groups.items():
        if not isinstance(rows, list):
            raise ValidationError(f"Rate group {group} must be a list.")
        names = set()
        uses_yield = bool(data["rate_group_rules"][group]["yield_column"])
        for rate in rows:
            if not isinstance(rate, dict) or set(rate) - rate_fields:
                raise ValidationError(f"Rate group {group} contains unsupported fields.")
            key = _text(rate.get("id"), "Rate ID", 200)
            if key in rate_ids:
                raise ValidationError(f"Duplicate rate ID: {key}.")
            rate_ids.add(key)
            if len(rate_ids) > MAX_RATE_ITEMS:
                raise ValidationError(f"Library must contain at most {MAX_RATE_ITEMS} rates.")
            name = _text(rate.get("name"), f"Rate {key} name")
            if name.casefold() in names:
                raise ValidationError(f"Duplicate choice name in {group}: {name}.")
            names.add(name.casefold())
            if "display_name" in rate:
                _text(rate["display_name"], f"Rate {key} display name")
            if "product_service" in rate:
                _text(rate["product_service"], f"Rate {key} Product/Service")
            linked = rate.get("inventory_id")
            if linked is not None and (not isinstance(linked, str) or linked not in inventory_ids):
                raise ValidationError(f"Rate {key} refers to an unknown inventory product.")
            rate["inventory_id"] = linked
            mode = rate.setdefault("price_mode", "inventory" if linked is not None else "override")
            if not isinstance(mode, str) or mode not in {"inventory", "override"} or (mode == "inventory" and linked is None):
                raise ValidationError(f"Rate {key} has an unsupported pricing mode or is missing its linked product.")
            _amount(rate.get("price"), f"Rate {key} price")
            if "uses_yield" in rate and (type(rate["uses_yield"]) is not bool or rate["uses_yield"] != uses_yield):
                raise ValidationError(f"Rate {key} cannot change whether its category uses a yield.")
            rate["uses_yield"] = uses_yield
            if "yield_unit" in rate:
                _text(rate["yield_unit"], f"Rate {key} yield unit", 100, empty=True)
                if not uses_yield and rate["yield_unit"]:
                    raise ValidationError(f"Rate {key} does not use a yield unit.")
            if uses_yield:
                _amount(rate.get("yield"), f"Rate {key} yield", blank=True)
            elif rate.get("yield") is not None:
                raise ValidationError(f"Rate {key} does not use a yield.")
            rate.setdefault("yield", None)
            if not isinstance(rate.setdefault("source", {}), dict):
                raise ValidationError(f"Rate {key} source must be an object.")
    try:
        serialized = json.dumps(data, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValidationError("Library metadata must contain valid finite JSON values.") from exc
    if len(serialized.encode("utf-8")) > 12_000_000:
        raise ValidationError("Pricing library exceeds the 12 MB data limit.")
    return data


def configuration_catalog(configuration=None, data=None):
    """Choose a configuration's own library, never the current global settings.

    Old quote configurations without an embedded library still use the original
    workbook baseline. The caller passes global settings explicitly for new work.
    """
    if configuration is not None and isinstance(configuration, dict) and "catalog" in configuration:
        return validate_catalog(configuration["catalog"])
    return baseline() if data is None else deepcopy(data)


def validate_configuration(value, data=None):
    if not isinstance(value, dict) or set(value) - {"inventory", "rates", "catalog_signature", "catalog"}:
        raise ValidationError("Configuration must contain inventory and rates overrides and an optional pricing library only.")
    data = configuration_catalog(value, data)
    result = {"inventory": {}, "rates": {}}
    if "catalog" in value:
        result["catalog"] = data
    if "catalog_signature" in value:
        if value["catalog_signature"] != catalog_signature(data):
            raise ValidationError("This quote uses a different catalogue structure. Its saved results remain available; explicitly use current pricing to recalculate it.")
        result["catalog_signature"] = value["catalog_signature"]
    records = {
        "inventory": {r["id"]: r for r in data["inventory"]},
        "rates": {r["id"]: r for rows in data["rate_groups"].values() for r in rows},
    }
    for category in ("inventory", "rates"):
        edits = value.get(category, {})
        if not isinstance(edits, dict):
            raise ValidationError(f"{category} overrides must be an object.")
        allowed = ({"supplier_price", "markup", "sales_price", "name", "sales_description", "product_service"}
                   if category == "inventory" else {"price", "yield", "product_service"})
        for key, changes in edits.items():
            if key not in records[category] or not isinstance(changes, dict) or set(changes) - allowed:
                raise ValidationError(f"Unknown {category} item or field: {key}.")
            record = records[category][key]
            for field, field_value in changes.items():
                if field == "yield" and not has_yield(record):
                    raise ValidationError(f"{key} does not use a material yield.")
                if field in {"name", "sales_description", "product_service"}:
                    _text(field_value, f"{key}.{field}")
                else:
                    if field == "yield" and (field_value is None or field_value == ""):
                        # VLOOKUP distinguishes a genuinely blank cell (zero) from
                        # a formula returning empty text (#VALUE! when dividing).
                        continue
                    finite_number(field_value, f"{key}.{field}")
                    if field in {"supplier_price", "sales_price", "price", "yield"} and field_value < 0:
                        raise ValidationError(f"{key}.{field} cannot be negative.")
                    if field == "markup" and field_value < -1:
                        raise ValidationError("Markup cannot be below -100%.")
                    if category == "inventory" and field in {"supplier_price", "markup"} and record["pricing_mode"] != "supplier_markup":
                        raise ValidationError(f"{key} has a manual selling price; edit that price instead.")
                    if category == "inventory" and field == "sales_price" and record["pricing_mode"] == "supplier_markup":
                        raise ValidationError(f"{key} selling price is calculated from supplier price and markup.")
            result[category][key] = deepcopy(changes)
    return result


def effective_catalog(configuration=None, data=None):
    configuration = {} if configuration is None else configuration
    edits = validate_configuration(configuration, data)
    data = edits["catalog"] if "catalog" in edits else configuration_catalog(data=data)
    inventory = {}
    for item in data["inventory"]:
        patch = edits["inventory"].get(item["id"], {})
        item.update(patch)
        # Keep the imported H value until a pricing input changes. The workbook's
        # inventory H is a stored sales price, not a live reference to O/P.
        if "supplier_price" in patch or "markup" in patch:
            item["sales_price"] = item["supplier_price"] * (1 + item["markup"])
            item["calculated_sell_price"] = item["sales_price"]
        inventory[item["id"]] = item
    for group, rows in data["rate_groups"].items():
        for rate in rows:
            linked = inventory.get(rate.get("inventory_id"))
            if linked:
                patch = edits["inventory"].get(linked["id"], {})
                if rate.get("price_mode", "inventory") == "inventory" and {"supplier_price", "markup", "sales_price"} & patch.keys():
                    rate["price"] = linked["sales_price"]
                # Selection keys remain stable when the catalog display text is edited.
                name_field = "sales_description" if data["rate_group_rules"][group]["name_column"] == "G" else "name"
                rate["display_name"] = patch.get(name_field, rate.get("display_name", rate["name"]))
            rate.update(edits["rates"].get(rate["id"], {}))
            # A single product label is presentation metadata. Raw rate names,
            # IDs, prices and yields remain the calculator's stable inputs.
            label = (linked or {}).get("product_service") or rate.get("product_service")
            if label:
                rate["display_name"] = label
    return data
