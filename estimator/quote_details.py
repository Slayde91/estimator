"""Quote identity and readable work descriptions over stored calculator values.

These helpers format existing facts. They never price an item, infer geometry,
choose a technical system, or replace the workbook's calculation results.
"""

from decimal import Decimal, ROUND_HALF_UP, localcontext
import math
import unicodedata

from .calculator import LINES
from .catalog import ValidationError
from .presentation import ADDITION_NAMES, MATERIAL_NAMES


QUOTE_DETAIL_LIMITS = {"client": 200, "site_address": 400, "project_no": 100}
_DETAIL_LABELS = {"client": "Client", "site_address": "Site address", "project_no": "Project number"}
_ADDITION_SELECTIONS = ("E27", "E28", "B5", "B3", "B2", "B7", "B6", "E26")
_ADDITION_UNITS = ("mobilisations", "fees", "deliveries", "round trips", "weeks", "round trips", "team nights", "days")


def validate_quote_details(data, previous=None):
    """Return trimmed metadata; omitted keys preserve prior values, empty clears."""
    if not isinstance(data, dict):
        raise ValidationError("Quote details must be an object.")
    previous = previous or {}
    details = {}
    for key, maximum in QUOTE_DETAIL_LIMITS.items():
        value = data[key] if key in data else previous.get(key, "")
        if not isinstance(value, str) or len(value) > maximum:
            raise ValidationError(f"{_DETAIL_LABELS[key]} must be text of at most {maximum} characters.")
        if any(unicodedata.category(character) in {"Cc", "Cs"} for character in value):
            raise ValidationError(f"{_DETAIL_LABELS[key]} cannot contain control characters or line breaks.")
        details[key] = value.strip()
    return details


def compose_quote_title(project_no="", client="", site_address="", fallback="Untitled quote"):
    """Join populated project/client/site fields using the requested '- ' format."""
    details = validate_quote_details({"project_no": project_no, "client": client, "site_address": site_address})
    parts = [details[key] for key in ("project_no", "client", "site_address") if details[key]]
    if parts:
        return "- ".join(parts)
    return fallback.strip() if isinstance(fallback, str) and fallback.strip() else "Untitled quote"


def _number(value, *, percent=False, money=False):
    """Two display decimals, with decimal half-up rounding and no state mutation."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "not entered" if value is None or value == "" else "unavailable"
    number = Decimal(str(value))
    if percent:
        number *= 100
    with localcontext() as context:
        context.prec = max(28, number.adjusted() + 4)
        rounded = number.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if not rounded:
        rounded = Decimal("0")
    text = format(rounded, ",.2f")
    return ("$" if money else "") + text + ("%" if percent else "")


def _text(value, fallback="not selected"):
    if not isinstance(value, str) or not value.strip():
        return fallback
    return " ".join(value.split())


def _nonzero(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value != 0


def _selected(value):
    return isinstance(value, str) and value.strip().casefold() not in {"", "n/a"}


def compile_work_summary(workflow, result):
    """Describe active work using only the supplied calculation snapshot.

    Product and option text stays literal; generated quantities, percentages,
    rates and amounts use two decimals. Missing/error values are identified,
    never replaced by a manufactured numeric result.
    """
    inputs = result.get("inputs", {})
    cells = result.get("cells", {})
    errors = result.get("errors", {})

    def value(cell, **options):
        if cell in errors:
            return "unavailable (" + _text(errors[cell], "calculation error") + ")"
        return _number(cells.get(cell, inputs.get(cell)), **options)

    def active(*references):
        return any(cell in errors or _nonzero(cells.get(cell, inputs.get(cell))) for cell in references)

    lines = ["Workflow: " + _text(workflow, "not recorded") + "."]
    materials = []
    for label, (row, price_row, requirement_row, labour_row, team) in zip(MATERIAL_NAMES, LINES):
        references = [f"B{row}", f"D{requirement_row}", f"F{price_row}", f"B{requirement_row}"]
        if labour_row:
            references.append(f"F{labour_row}")
        if not active(*references):
            continue
        unit = "bags / drums / rolls" if row == 15 else "panels" if row == 18 else "linear m" if row == 23 else "m²"
        measure = "quantity" if row in (15, 18) else "coverage"
        detail = (f"{label}: {_text(inputs.get(f'D{row}'))}; {measure} {value(f'B{row}')} {unit}; "
                  f"wastage {value(f'E{row}', percent=True)}; priced quantity {value(f'D{requirement_row}')} units")
        if row not in (15, 18):
            detail += f"; yield {value(f'F{row}')} {unit}/unit"
        detail += f"; unit sell rate {value(f'A{price_row}', money=True)}; materials {value(f'F{price_row}', money=True)}."
        if labour_row:
            detail += (f" Daily output {value(f'C{row}')} units/day; labour {_text(inputs.get(team))}, "
                       f"{value(f'B{requirement_row}')} days at {value(f'A{labour_row}', money=True)}/day "
                       f"({value(f'F{labour_row}', money=True)}).")
        else:
            detail += f" Pinning follows meshing labour ({value(f'B{requirement_row}')} days), with no separate labour charge."
        materials.append(detail)
    lines.extend(materials or ["No active material quantities entered."])

    if active("B53", "B58") or (materials and _nonzero(inputs.get("B9")) and active("B15", "B35")):
        masking = ("Masking / cleaning: " + _text(inputs.get("B10")) + "; allowance " +
                   value("B9", percent=True) + " of spray / wrap labour days; " + value("B53") +
                   " days; labour " + _text(inputs.get("D7")) + " at " + value("B51", money=True) +
                   "/day; materials " + value("B52", money=True) + "/day")
        if active("B57"):
            masking += "; masking material adjustment " + value("B57", money=True)
        lines.append(masking + "; masking total " + value("B58", money=True) + ".")

    for row, label, selection, unit in zip(range(112, 120), ADDITION_NAMES, _ADDITION_SELECTIONS, _ADDITION_UNITS):
        has_quantity_or_error = active(f"C{row}", f"D{row}")
        if row == 119 and not has_quantity_or_error:
            continue
        if not has_quantity_or_error and not _selected(inputs.get(selection)):
            continue
        # Unselected zero-price services can have derived quantities. They do
        # not describe selected work unless an amount/error requires attention.
        if not _selected(inputs.get(selection)) and not active(f"D{row}"):
            continue
        detail = (f"{label}: {_text(inputs.get(selection))}; {value(f'C{row}')} {unit}; "
                  f"unit sell rate {value(f'B{row}', money=True)}; amount {value(f'D{row}', money=True)}.")
        if row == 116:
            detail += " Access quantity: " + value("B4") + "."
        lines.append(detail)

    adjustments = []
    for cell, label in (("B26", "global material adjustment"), ("B27", "global labour adjustment")):
        if active(cell):
            adjustments.append(label + " " + value(cell, percent=True))
    if active("D27"):
        adjustments.append("fixed adjustment " + value("D27", money=True))
    if adjustments:
        lines.append("Adjustments: " + "; ".join(adjustments) + ".")
    lines.append("Project measure: " + value("B8") + " area / items; total project duration " +
                 value("F10") + " days; quote total " + value("F7", money=True) + ".")
    if errors:
        lines.append("Some calculated amounts or durations are unavailable. Review the calculation errors before relying on this estimate.")
    return "\n".join(lines)
