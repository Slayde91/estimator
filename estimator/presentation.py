"""Human-readable output labels over the internal workbook parity mapping."""

from functools import lru_cache

from .calculator import DISPLAY_LABELS, GROUPS, LINES, specification
from .catalog import effective_catalog


MATERIAL_NAMES = (
    "Spray / wrap", "Mesh", "Pins / clips", "Access panels", "Fan enclosure mesh",
    "Primer", "Topcoat", "Board", "Mastic",
)
ADDITION_NAMES = (
    "Mobilisation", "Administration", "Material freight", "Access freight",
    "Access hire", "Travel", "Accommodation", "Extra labour",
)


@lru_cache(maxsize=1)
def calculation_labels():
    labels = {field["cell"]: DISPLAY_LABELS.get(field["cell"], field["label"])
              for field in specification()["fields"]}
    for name, (row, price, requirement, labour, _) in zip(MATERIAL_NAMES, LINES):
        labels.update({
            f"B{row}": f"{name} coverage", f"C{row}": f"{name} daily output",
            f"D{row}": f"{name} product", f"E{row}": f"{name} wastage",
            f"F{row}": f"{name} yield", f"A{price - 1}": f"{name} product",
            f"A{price}": f"{name} unit sell rate", f"B{price}": f"{name} adjusted base units",
            f"C{price}": f"{name} wastage units", f"D{price}": f"{name} priced quantity",
            f"F{price}": f"{name} material amount", f"D{requirement}": f"{name} priced quantity",
            f"B{requirement}": f"{name} labour days",
        })
        if labour:
            labels.update({f"A{labour}": f"{name} daily labour rate", f"B{labour}": f"{name} labour days",
                           f"F{labour}": f"{name} labour amount"})
    for row, name in enumerate(ADDITION_NAMES, 112):
        labels.update({f"B{row}": f"{name} rate", f"C{row}": f"{name} quantity", f"D{row}": f"{name} amount"})
    labels.update({
        "B44": "Total task labour days", "B45": "Total task labour weeks",
        "B50": "Masking allowance", "B51": "Masking daily labour rate", "B52": "Masking daily material rate",
        "B53": "Masking days", "B54": "Masking weeks", "B55": "Masking base subtotal",
        "B56": "Masking labour adjustment", "B57": "Masking material adjustment", "B58": "Masking total",
        "F107": "Materials and task labour subtotal", "D120": "Additions subtotal",
        "D26": "Subtotal", "D27": "Fixed adjustment", "D28": "Grand total",
        "F2": "Labour total", "F3": "Material total", "F4": "Access total", "F5": "Travel and accommodation total",
        "F6": "Subtotal", "F7": "Grand total", "F8": "Rate per area or item", "F10": "Total project days",
        "B30": "Generated material notes",
    })
    return labels


def calculation_error_details(result, configuration=None, *, catalog=None):
    """Show each independent cause once, using the product named in this estimate."""
    errors = result.get("errors", {})
    if not errors:
        return []
    catalog = effective_catalog(configuration) if catalog is None else catalog
    roots = set(result.get("error_roots", errors))
    inputs = result.get("inputs", {})
    duplicates = {item["id"]: item for item in result.get("work_items", [])}
    labels = calculation_labels()
    selections = {"B51": "D7", "B52": "B10"}
    selections.update({f"B{row}": selection for row, selection in
                       enumerate(("E27", "E28", "B5", "B3", "B2", "B7", "B6", "E26"), 112)})
    material_cells = {}
    for name, (row, price, req, labour, team) in zip(MATERIAL_NAMES, LINES):
        for cell in (f"F{row}", f"A{price}", f"B{price}", f"B{req}"):
            material_cells[cell] = (name, row)
        if team:
            selections[f"A{labour}"] = team

    details, seen = [], set()
    for key, code in errors.items():
        cell, selected_inputs, cells = key, inputs, result.get("cells", {})
        if key.startswith("duplicate:"):
            item_id, cell = key[len("duplicate:"):].rsplit(":", 1)
            item = duplicates.get(item_id)
            if item:
                row = item["source_row"]
                selected_inputs = {**inputs, **{f"{col}{row}": value for col, value in item["inputs"].items()}}
                cells = {f"F{row}": item["yield"]}
        if (cell in labels or key.startswith("duplicate:")) and key not in roots:
            continue
        label = labels.get(cell, "Firestopping schedule" if key.startswith("firestopping") else "Estimate calculation")
        message = None
        if cell in material_cells:
            name, row = material_cells[cell]
            selected = selected_inputs.get(f"D{row}") or name
            product = next((rate for rate in catalog["rate_groups"][GROUPS[f"D{row}"]]
                            if rate["name"].casefold() == selected.casefold()), None)
            product_name = product.get("display_name", product["name"]) if product else selected
            if product is None:
                message = f'{name} product "{product_name}" is missing from the estimate pricing. Select an available product or add it to the Pricing Library and update the estimate pricing.'
            elif code in ("#DIV/0!", "#VALUE!") and row not in (15, 18) and cells.get(f"F{row}") in (None, "", 0):
                message = f"{product_name} has a missing or zero yield. Enter a yield greater than zero in the Pricing Library, then update the estimate pricing."
            elif code == "#DIV/0!" and selected_inputs.get(f"C{row}") in (None, "", 0):
                message = f"{product_name} has a missing or zero daily output. Enter a daily output greater than zero in the {name} estimate row."
            elif product.get("price") is None:
                message = f"{product_name} has no pricing information. Enter its price in the Pricing Library, then update the estimate pricing."
        if message is None:
            if cell in selections and code == "#N/A":
                choice = selected_inputs.get(selections[cell]) or "No selection"
                message = f'{label} could not be found for "{choice}". Choose an available rate or update the estimate pricing.'
            elif code == "#DIV/0!":
                message = f"{label} needs a nonzero quantity or yield. Check the inputs used for this calculation."
            elif code == "#N/A":
                message = f"{label} has an unavailable selection. Check the selected item and its rate in the estimate pricing."
            elif code == "#NUM!":
                message = f"{label} exceeds the supported numeric range. Check its quantities and rates."
            elif code == "#VALUE!":
                message = f"{label} contains an invalid value. Check its quantities and rates."
            else:
                message = str(code) if not str(code).startswith("#") else f"{label} could not be calculated. Check its inputs."
        if message not in seen:
            details.append({"label": label, "code": code, "message": message})
            seen.add(message)
    return details
