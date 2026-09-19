"""Explicit translation of Quote.xlsm Calculator. No Excel runtime or eval.

Python float intentionally follows Excel's binary floating-point arithmetic.
Nothing is rounded before presentation: the workbook uses ROUNDUP only in B30.
Each registered calculation is keyed by its original worksheet cell.
"""

import json
import math

from .catalog import ROOT, ValidationError, effective_catalog, finite_number

GROUPS = {
    "B2": "access_hire", "B3": "freight_rates", "B5": "freight_rates",
    "B6": "LAFHA_rates", "B7": "travel_rates", "B10": "masking_rates",
    **{f"D{row}": "labour_rates" for row in range(2, 11)},
    **{f"E{row}": "labour_rates" for row in range(26, 29)},
    "D15": "sprays", "D16": "mesh", "D17": "pins", "D18": "access_panels",
    "D19": "mesh", "D20": "primers", "D21": "topcoats", "D22": "boards", "D23": "mastic",
}
# input row, material-price row, requirements row, labour-price row, team selection
LINES = [(15, 63, 35, 65, "D2"), (16, 68, 36, 70, "D3"),
         (17, 73, 37, None, None), (18, 77, 38, 79, "D6"),
         (19, 82, 39, 84, "D8"), (20, 87, 40, 89, "D4"),
         (21, 92, 41, 94, "D5"), (22, 97, 42, 99, "D9"), (23, 102, 43, 104, "D10")]


class ExcelError(Exception):
    def __init__(self, code):
        self.code = code


def specification():
    return json.loads((ROOT / "data" / "calculator.json").read_text(encoding="utf-8"))


def fields(catalog=None):
    catalog = effective_catalog() if catalog is None else catalog
    output = []
    for field in specification()["fields"]:
        field = dict(field)
        if field["cell"] in GROUPS:
            rates = catalog["rate_groups"][GROUPS[field["cell"]]]
            field["options"] = [r["name"] for r in rates]
            field["option_labels"] = {r["name"]: r.get("display_name", r["name"]) for r in rates}
        output.append(field)
    return output


def normalize_inputs(inputs, catalog=None, *, require_teams=True):
    if not isinstance(inputs, dict):
        raise ValidationError("Calculator inputs must be an object keyed by input cell.")
    schema = {f["cell"]: f for f in fields(catalog)}
    if set(inputs) - schema.keys():
        raise ValidationError(f"Unknown or calculated input cells: {', '.join(sorted(set(inputs) - schema.keys()))}.")
    result = {key: f["default"] for key, f in schema.items()}
    for key, value in inputs.items():
        field = schema[key]
        if field["type"] == "number":
            if value is not None and value != "":
                finite_number(value, key)
        elif field["type"] == "select":
            # Preserve VLOOKUP #N/A for blank/unmatched imported selections. The UI
            # offers the original validation list; no invented fallback product.
            if value is not None and (not isinstance(value, str) or len(value) > 1000):
                raise ValidationError(f"{key}: selection must be text of at most 1000 characters.")
        elif not isinstance(value, str) or len(value) > 10000:
            raise ValidationError(f"{key} must be text of at most 10000 characters.")
        result[key] = value
    if not require_teams:
        # Read-only project recovery validates and preserves the original input
        # values but returns no calculated quote until the user selects teams.
        return result
    for row, _, _, _, team in LINES:
        if team is None or result[f"B{row}"] in (None, "", 0):
            continue
        selected = result[team]
        if selected is None or selected == "" or selected.casefold() == "n/a":
            raise ValidationError("Select Teams")
    return result


def masking_breakdown(result):
    """Expose the masking terms already used by F2/F3, also for older snapshots.

    Uses stored cells only: it never consults current pricing or recalculates a
    quote. B56 remains the original locked blank and contributes zero.
    """
    def read(cell):
        if cell in result["errors"]:
            raise ExcelError(result["errors"][cell])
        value = result["cells"][cell]
        if value is None:
            return 0
        if not isinstance(value, (int, float)):
            raise ExcelError("#VALUE!")
        return value

    expressions = {
        "labour_total": lambda: read("B51") * read("B53") + read("B56"),
        "material_base_total": lambda: read("B52") * read("B53"),
        "material_adjustment": lambda: read("B57"),
        "material_total": lambda: read("B52") * read("B53") + read("B57"),
        "total": lambda: read("B58"),
    }
    breakdown = {}
    for name, expression in expressions.items():
        try:
            value = expression()
            breakdown[name] = value if math.isfinite(value) else "#NUM!"
        except ExcelError as exc:
            breakdown[name] = exc.code
    return breakdown


def labour_breakdown(result):
    """Explain source F10 using stored cells only, including older snapshots.

    F10 = SUM(B44,B53,C119)+0.5*C112. B37 repeats meshing days and is
    deliberately excluded from B44. These are days, not the F2 labour cost.
    """
    from .presentation import MATERIAL_NAMES

    cells, errors = result.get("cells", {}), result.get("errors", {})

    def read(address):
        return errors.get(address, cells.get(address))

    mobilisation = read("C112")
    if isinstance(mobilisation, (int, float)) and not isinstance(mobilisation, bool):
        mobilisation *= 0.5
    return {
        "tasks": [{"name": name, "days": read(f"B{requirement}")}
                  for name, (_, _, requirement, labour, _) in zip(MATERIAL_NAMES, LINES)
                  if labour is not None],
        "task_days": read("B44"),
        "masking_days": read("B53"),
        "extra_days": read("C119"),
        "mobilisation_days": mobilisation,
        "total_days": read("F10"),
    }


def calculate(inputs=None, configuration=None):
    catalog = effective_catalog(configuration)
    inputs = normalize_inputs({} if inputs is None else inputs, catalog)
    cells = dict(inputs)
    expressions = {}
    errors = {}

    def register(cell, expression):
        expressions[cell] = expression

    def value(cell):
        if cell not in cells:
            try:
                cells[cell] = expressions[cell]() if cell in expressions else None
                if isinstance(cells[cell], float) and not math.isfinite(cells[cell]):
                    raise ExcelError("#NUM!")
            except ZeroDivisionError:
                cells[cell] = "#DIV/0!"
                errors[cell] = "#DIV/0!"
            except ExcelError as exc:
                cells[cell] = exc.code
                errors[cell] = exc.code
        v = cells[cell]
        if cell in errors:
            raise ExcelError(errors[cell])
        return v

    def n(cell):
        v = value(cell)
        if v is None or (cell in inputs and v == ""):
            return 0
        if not isinstance(v, (int, float)):
            raise ExcelError("#VALUE!")
        return v

    def total(*refs):
        # SUM ignores text and empty cells, propagates referenced Excel errors.
        return sum(v for ref in refs if isinstance(v := value(ref), (int, float)))

    def lookup(selection, column="price"):
        selected = value(selection)
        for rate in catalog["rate_groups"][GROUPS[selection]]:
            if isinstance(selected, str) and rate["name"].casefold() == selected.casefold():
                return rate.get(column) if rate.get(column) is not None else 0
        raise ExcelError("#N/A")

    for row, price_row, req_row, labour_row, team in LINES:
        if row not in (15, 18):
            register(f"F{row}", lambda row=row: lookup(f"D{row}", "yield"))
        else:
            cells[f"F{row}"] = "N/A"
        register(f"A{price_row - 1}", lambda row=row: value(f"D{row}") or 0)
        register(f"A{price_row}", lambda row=row: lookup(f"D{row}"))
        register(f"B{price_row}", lambda row=row: (n(f"B{row}") if row in (15,18) else n(f"B{row}") / n(f"F{row}")) * (1+n("B26")))
        register(f"C{price_row}", lambda row=row, p=price_row: n(f"B{p}")*n(f"E{row}"))
        register(f"D{price_row}", lambda p=price_row: n(f"B{p}")+n(f"C{p}"))
        register(f"F{price_row}", lambda p=price_row: n(f"A{p}")*n(f"D{p}"))
        register(f"D{req_row}", lambda p=price_row: n(f"D{p}"))
        if row == 17:
            register("B37", lambda: n("B36"))
        else:
            register(f"B{req_row}", lambda q=req_row, r=row: (n(f"D{q}")/n(f"C{r}"))*(1+n("B27")))
            register(f"A{labour_row}", lambda team=team: lookup(team))
            register(f"B{labour_row}", lambda q=req_row: n(f"B{q}"))
            register(f"F{labour_row}", lambda p=labour_row: n(f"A{p}")*n(f"B{p}"))
    register("B44", lambda: total("B41", "B35", "B36", "B42", "B43", "B40", "B38", "B39"))
    register("B45", lambda: n("B44")/5)
    register("B50", lambda: n("B9"))
    register("B51", lambda: lookup("D7"))
    register("B52", lambda: lookup("B10")*(1+n("B26")))
    register("B53", lambda: n("B35")*n("B9"))
    register("B54", lambda: n("B53")/5)
    register("B55", lambda: n("B51")*n("B53")+n("B52")*n("B53"))
    # B56 is blank and locked in the source workbook, contributing zero to SUM.
    cells["B56"] = None
    register("B57", lambda: n("B52")*n("B53")*n("B26"))
    register("B58", lambda: total("B55", "B56", "B57"))
    register("F107", lambda: total("F63","F65","F68","F70","F73","F77","F79","F82","F84","F87","F89","F92","F94","F97","F99","F102","F104"))
    for row, selection in [(112,"E27"),(113,"E28"),(114,"B5"),(115,"B3"),(116,"B2"),(117,"B7"),(118,"B6"),(119,"E26")]:
        register(f"B{row}", lambda s=selection: lookup(s))
        register(f"D{row}", lambda r=row: n(f"B{r}")*n(f"C{r}"))
    register("C112", lambda: n("F27")*(1+n("B27")))
    register("C113", lambda: n("F28"))
    register("C114", lambda: n("F27"))
    register("C115", lambda: n("F27")*n("B4"))
    register("C116", lambda: (n("F10")/5)*n("B4"))
    register("C117", lambda: n("F27"))
    register("C118", lambda: n("F10"))
    register("C119", lambda: n("F26")*(1+n("B27")))
    register("D120", lambda: total(*(f"D{r}" for r in range(112,120))))
    register("F10", lambda: total("B44","B53","C119")+0.5*n("C112"))
    register("F2", lambda: total("F65","F70","F79","F84","F89","F94","F99","F104")+total("D112","D113","D119")+n("B51")*n("B53")+n("B56"))
    register("F3", lambda: total("F63","F68","F73","F77","F82","F87","F92","F97","F102","D114")+n("B52")*n("B53")+n("B57"))
    register("F4", lambda: total("D115","D116"))
    register("F5", lambda: total("D117","D118"))
    register("F6", lambda: total("F2","F3","F4","F5"))
    register("D27", lambda: n("B28"))
    register("F7", lambda: n("F6")+n("D27"))
    register("F8", lambda: n("F7")/n("B8"))
    register("D26", lambda: total("D120","F107","B58"))
    register("D28", lambda: n("D26")+n("D27"))

    def material_notes():
        lines = []
        for row, _, req, _, _ in LINES:
            qty = n(f"D{req}")
            if qty > 0:
                lines.append(f"{math.ceil(qty)} x {value(f'D{row}') or ''}")
        result = (value("B12") or "") + "\n\n---Materials---\n\n" + "\n".join(lines)
        access = value("B2") or ""
        if "scis" in access.casefold() or "ewp" in access.casefold():
            result += "\n" + access
        if n("B9") > 0:
            result += "\n" + (value("B10") or "")
        return result

    register("B30", material_notes)
    for cell in expressions:
        try:
            value(cell)
        except ExcelError:
            pass
    summary_refs = {"labour":"F2","material":"F3","access":"F4","travel":"F5","subtotal":"F6","total":"F7","rate":"F8","days":"F10"}
    result = {
        "inputs": inputs, "cells": cells, "errors": errors,
        "summary": {k: cells[c] if c not in errors else None for k,c in summary_refs.items()},
        "materials": [{"name": inputs[f"D{r}"], "quantity": cells[f"D{q}"], "price": cells[f"A{p}"], "total": cells[f"F{p}"], "days": cells[f"B{q}"], "source": f"Calculator!D{q}/F{p}"} for r,p,q,_,_ in LINES],
        "notes": cells["B30"],
    }
    result["masking"] = masking_breakdown(result)
    result["labour"] = labour_breakdown(result)
    return result
