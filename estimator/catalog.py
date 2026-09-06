"""Immutable workbook baseline and separately validated user pricing overrides."""

from copy import deepcopy
import json
import hashlib
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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


def validate_configuration(value, data=None):
    data = baseline() if data is None else data
    if not isinstance(value, dict) or set(value) - {"inventory", "rates", "catalog_signature"}:
        raise ValidationError("Configuration must contain inventory and rates overrides only.")
    result = {"inventory": {}, "rates": {}}
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
        allowed = {"supplier_price", "markup", "sales_price", "name", "sales_description"} if category == "inventory" else {"price", "yield"}
        for key, changes in edits.items():
            if key not in records[category] or not isinstance(changes, dict) or set(changes) - allowed:
                raise ValidationError(f"Unknown {category} item or field: {key}.")
            record = records[category][key]
            for field, field_value in changes.items():
                if field in {"name", "sales_description"}:
                    if not isinstance(field_value, str) or not field_value.strip() or len(field_value) > 1000:
                        raise ValidationError(f"{key}.{field} must be nonempty text of at most 1000 characters.")
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
    data = baseline() if data is None else deepcopy(data)
    edits = validate_configuration({} if configuration is None else configuration, data)
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
                if {"supplier_price", "markup", "sales_price"} & patch.keys():
                    rate["price"] = linked["sales_price"]
                # Selection keys remain stable when the catalog display text is edited.
                name_field = "sales_description" if data["rate_group_rules"][group]["name_column"] == "G" else "name"
                rate["display_name"] = patch.get(name_field, rate["name"])
            rate.update(edits["rates"].get(rate["id"], {}))
    return data
