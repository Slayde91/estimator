"""Human-readable output labels over the internal workbook parity mapping."""

from functools import lru_cache

from .calculator import LINES, specification


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
    labels = {field["cell"]: field["label"] for field in specification()["fields"]}
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


def calculation_error_details(result):
    """Describe errors without exposing addresses or repeating the same output."""
    details, seen = [], set()
    labels = calculation_labels()
    for cell, code in result.get("errors", {}).items():
        label = labels.get(cell, "Calculated output")
        if (label, code) not in seen:
            details.append({"label": label, "code": code})
            seen.add((label, code))
    return details
