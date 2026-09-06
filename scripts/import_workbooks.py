"""Extract the checked-in baseline from source workbooks without Excel or macros.

Developer tool only; the application reads data/baseline.json at runtime.
Uses only the Python standard library. Cached values are preserved, and every
Calculator rate group is independently reconciled to its inventory formulas.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import posixpath
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile


NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PROPERTY_COLUMNS = {
    "weight": "Q", "width_mm": "R", "length_mm": "S", "thickness_mm": "T",
    "sqm": "U", "diameter_mm": "V", "metres_per_tube": "W",
    "sqm_per_box": "X", "sqm_per_drum": "Y", "volume_litres": "Z", "volume_ml": "AA",
}
RATE_GROUPS = {
    "access_hire": ("B", "C", None, "B", None),
    "labour_rates": ("E", "F", None, "B", None),
    "masking_rates": ("H", "I", None, "B", None),
    "freight_rates": ("K", "L", None, "B", None),
    "LAFHA_rates": ("N", "O", None, "B", None),
    "travel_rates": ("Q", "R", None, "B", None),
    "access_panels": ("T", "U", None, "B", None),
    "mesh": ("W", "X", "Y", "B", "U"),
    "pins": ("AA", "AB", "AC", "B", "X"),
    "sprays": ("AE", "AF", None, "B", None),
    "boards": ("AH", "AI", "AJ", "G", "U"),
    "mastic": ("AL", "AM", "AN", "G", "W"),
    "primers": ("AP", "AQ", "AR", "G", "Y"),
    "topcoats": ("AT", "AU", "AV", "G", "Y"),
}


def translate_shared_formula(formula: str, origin: str, target: str) -> str:
    """Translate OOXML shared A1 references while preserving quoted literals."""
    def coordinates(address):
        match = re.fullmatch(r"([A-Z]+)(\d+)", address)
        column = 0
        for character in match.group(1):
            column = column * 26 + ord(character) - 64
        return column, int(match.group(2))

    source_column, source_row = coordinates(origin)
    target_column, target_row = coordinates(target)
    def replace(match):
        if match.group(1) is None:
            return match.group(0)
        column_text, row_text = match.group(1), match.group(2)
        column, row = coordinates(column_text.replace("$", "") + row_text.replace("$", ""))
        if not column_text.startswith("$"):
            column += target_column - source_column
        if not row_text.startswith("$"):
            row += target_row - source_row
        if column < 1 or row < 1:
            raise ValueError("Shared formula translation generated an invalid reference")
        translated_column = ""
        while column:
            column, remainder = divmod(column - 1, 26)
            translated_column = chr(65 + remainder) + translated_column
        return ("$" if column_text.startswith("$") else "") + translated_column + ("$" if row_text.startswith("$") else "") + str(row)
    return re.sub(r'"(?:[^"]|"")*"|\'(?:[^\']|\'\')*\'|(?<![A-Za-z0-9_])(\$?[A-Z]{1,3})(\$?\d+)(?![A-Za-z0-9_])', replace, formula)


class SourceWorkbook:
    """Read the OOXML source and caches without calculating or saving a workbook."""

    def __init__(self, path: Path):
        self.path = path
        # A single immutable byte snapshot prevents hashes and extraction drifting.
        data = path.read_bytes()
        self.sha256 = hashlib.sha256(data).hexdigest()
        self.archive = ZipFile(io.BytesIO(data))
        self.strings = []
        if "xl/sharedStrings.xml" in self.archive.namelist():
            root = ET.fromstring(self.archive.read("xl/sharedStrings.xml"))
            self.strings = ["".join(si.itertext()) for si in root.findall("x:si", NS)]
        workbook = ET.fromstring(self.archive.read("xl/workbook.xml"))
        rels = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall(f"{{{REL_NS}}}Relationship")}
        self.sheet_paths = {}
        for sheet in workbook.findall("x:sheets/x:sheet", NS):
            target = targets[sheet.attrib[f"{{{DOC_REL_NS}}}id"]]
            self.sheet_paths[sheet.attrib["name"]] = (
                target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            )
        self.names = {n.attrib["name"]: n.text for n in workbook.findall("x:definedNames/x:definedName", NS)}
        styles = ET.fromstring(self.archive.read("xl/styles.xml"))
        self.formats = {0: "General", 9: "percent", 10: "percent", 49: "@"}
        self.formats.update({int(fmt.attrib["numFmtId"]): fmt.attrib["formatCode"] for fmt in styles.findall("x:numFmts/x:numFmt", NS)})
        self.styles = []
        for style in styles.findall("x:cellXfs/x:xf", NS):
            protection = style.find("x:protection", NS)
            self.styles.append({"locked": protection is None or protection.attrib.get("locked", "1") != "0", "format_id": int(style.attrib.get("numFmtId", 0))})

    def sheet(self, name: str) -> dict:
        root = ET.fromstring(self.archive.read(self.sheet_paths[name]))
        cells = {}
        shared = {}
        pending = []
        for cell in root.findall("x:sheetData/x:row/x:c", NS):
            raw = cell.findtext("x:v", namespaces=NS)
            kind = cell.attrib.get("t", "n")
            if kind == "s":
                value = self.strings[int(raw)] if raw is not None else None
            elif kind == "inlineStr":
                value = "".join(cell.find("x:is", NS).itertext())
            elif kind == "str":
                value = raw or ""
            elif kind == "e":
                value = raw
            elif raw is None or raw == "":
                value = None
            elif kind == "b":
                value = raw == "1"
            else:
                value = float(raw) if any(c in raw for c in ".Ee") else int(raw)
            formula = cell.find("x:f", NS)
            if formula is not None and formula.attrib.get("t") == "shared":
                if formula.text:
                    shared[formula.attrib["si"]] = (cell.attrib["r"], formula.text)
                else:
                    pending.append((cell.attrib["r"], formula.attrib["si"]))
            cells[cell.attrib["r"]] = {
                "value": value,
                "formula": formula.text if formula is not None else None,
                "has_formula": formula is not None,
                "style": int(cell.attrib.get("s", 0)),
            }
        for address, shared_id in pending:
            origin, formula = shared[shared_id]
            cells[address]["formula"] = translate_shared_formula(formula, origin, address)
        return cells


def assert_equal(actual, expected, context: str) -> None:
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        matches = math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10)
    else:
        matches = actual == expected
    if not matches:
        raise ValueError(f"{context}: source mismatch: {actual!r} != {expected!r}")


def extract(inventory_path: Path, quote_path: Path) -> dict:
    inventory_book = SourceWorkbook(inventory_path)
    quote_book = SourceWorkbook(quote_path)
    inv = inventory_book.sheet("INVENTORY")
    lists = quote_book.sheet("Lists")
    value = lambda cells, address: cells.get(address, {}).get("value")
    assert_equal(inventory_book.names["markup"], "MARKUP!$B$3", "Inventory markup name")
    markup = value(inventory_book.sheet("MARKUP"), "B3")
    for column, label in {"A": "*ItemCode", "B": "ItemName", "G": "SalesDescription", "H": "SalesUnitPrice", "O": "Supplier Price", "P": "Price + 30%", "U": "SQM"}.items():
        assert_equal(value(inv, column + "1"), label, "Inventory header " + column)

    rows = sorted({int(re.sub(r"\D", "", address)) for address in inv if address.startswith("A") and re.match(r"A\d+$", address) and address != "A1" and value(inv, address) is not None})
    inventory = []
    ids = set()
    for row in rows:
        item_code = value(inv, f"A{row}")
        identifier = str(item_code)
        if identifier in ids:
            raise ValueError(f"Duplicate inventory item code {identifier}")
        ids.add(identifier)
        supplier_raw = value(inv, f"O{row}")
        supplier = supplier_raw if isinstance(supplier_raw, (int, float)) else None
        sales = value(inv, f"H{row}")
        calculated = value(inv, f"P{row}")
        mode = "supplier_markup" if supplier is not None else "manual"
        if mode == "supplier_markup":
            assert_equal(calculated, supplier * (1 + markup), f"INVENTORY!P{row}")
            assert_equal(sales, calculated, f"INVENTORY!H{row} versus P{row}")
        props = {key: value(inv, f"{column}{row}") for key, column in PROPERTY_COLUMNS.items()}
        assert_equal(props["sqm"], (props["width_mm"] or 0) / 1000 * (props["length_mm"] or 0) / 1000, f"INVENTORY!U{row}")
        inventory.append({
            "id": identifier, "item_code": item_code,
            "name": value(inv, f"B{row}"), "sales_description": value(inv, f"G{row}"),
            "supplier_price": supplier, "supplier_price_raw": supplier_raw,
            "sales_price": sales, "calculated_sell_price": calculated,
            "pricing_mode": mode, "markup": markup,
            "status": value(inv, f"M{row}"), "inventory_type": value(inv, f"N{row}"),
            "properties": props,
            "source": {"workbook": "Inventory_list.xlsm", "sheet": "INVENTORY", "row": row,
                "cells": {"item_code": f"A{row}", "name": f"B{row}", "sales_description": f"G{row}",
                    "supplier_price": f"O{row}", "sales_price": f"H{row}", "calculated_sell_price": f"P{row}",
                    **{key: f"{column}{row}" for key, column in PROPERTY_COLUMNS.items()}},
                "markup": "MARKUP!B3"},
        })

    groups, rules = {}, {}
    for group_name, (name_col, price_col, yield_col, inventory_name_col, inventory_yield_col) in RATE_GROUPS.items():
        formula = lists[name_col + "1"]["formula"]
        keyword_match = re.search(r"_xlpm\.keywords,\s*\{([^}]+)\}", formula)
        if keyword_match is None:
            raise ValueError(f"Cannot extract filter keywords for {group_name}")
        keywords = re.findall(r'"([^"]+)"', keyword_match.group(1))
        expected_rows = [r for r in rows if 2 <= r <= 2099 and any(k.casefold() in str(value(inv, f"{inventory_name_col}{r}") or "").casefold() for k in keywords)]
        actual_names = [value(lists, f"{name_col}{r}") for r in range(1, 1001) if value(lists, f"{name_col}{r}") is not None]
        expected_names = [value(inv, f"{inventory_name_col}{r}") for r in expected_rows]
        assert_equal(actual_names, expected_names, f"Lists!{name_col}1 filter {group_name}")
        entries = []
        for list_row, name in enumerate(actual_names, 1):
            # XLOOKUP exact defaults: case-insensitive, first matching row.
            inventory_row = next(r for r in rows if str(value(inv, f"{inventory_name_col}{r}") or "").casefold() == name.casefold())
            price = value(lists, f"{price_col}{list_row}")
            assert_equal(price, value(inv, f"H{inventory_row}"), f"Lists!{price_col}{list_row}")
            yield_value = value(lists, f"{yield_col}{list_row}") if yield_col else None
            if yield_col:
                expected_yield = value(inv, f"{inventory_yield_col}{inventory_row}")
                # U/W/Y array formulas replace zero with blank; X returns blank source as blank.
                if expected_yield is None or (inventory_yield_col in ("U", "W", "Y") and expected_yield == 0):
                    expected_yield = ""
                assert_equal(yield_value, expected_yield, f"Lists!{yield_col}{list_row}")
            entries.append({
                "id": f"{group_name}:{list_row}", "name": name, "price": price, "yield": yield_value,
                "inventory_id": str(value(inv, f"A{inventory_row}")),
                "source": {"workbook": "Quote.xlsm", "sheet": "Lists", "name": f"{name_col}{list_row}",
                    "price": f"{price_col}{list_row}", "yield": f"{yield_col}{list_row}" if yield_col else None,
                    "inventory_name": f"INVENTORY!{inventory_name_col}{inventory_row}",
                    "inventory_price": f"INVENTORY!H{inventory_row}",
                    "inventory_yield": f"INVENTORY!{inventory_yield_col}{inventory_row}" if inventory_yield_col else None},
            })
        groups[group_name] = entries
        rules[group_name] = {"name_column": inventory_name_col, "keywords": keywords,
            "price_column": "H", "yield_column": inventory_yield_col,
            "source_formula": formula,
            "price_formula": lists[price_col + "1"]["formula"],
            "yield_formula": lists[yield_col + "1"]["formula"] if yield_col else None}

    return {
        "schema_version": 1,
        "sources": {"inventory": {"filename": "Inventory_list.xlsm", "sha256": inventory_book.sha256},
            "quote": {"filename": "Quote.xlsm", "sha256": quote_book.sha256}},
        "markup": markup,
        "inventory": inventory, "rate_groups": groups, "rate_group_rules": rules,
        "provenance_notes": [
            "Inventory O is supplier price; P calculates O*(1+MARKUP!B3), returning blank for zero. H is the stored sales price used by Quote Lists.",
            "Inventory README column letters are stale. Headers and executable formulas establish O/P/H as the pricing columns.",
            "Rows 2:418 contain the 417 inventory records. The remaining table rows are formula-only placeholders.",
            "All 14 Lists filters, cached choices, prices and yields were checked against their linked inventory source values during extraction.",
            "Unmodified sales prices preserve column H exactly. Supplier/markup overrides recalculate supplier*(1+markup); manual labour and service prices use editable sales_price.",
            "No workbook macros were executed and no source workbook was saved. README instructions and unrelated workbook content are excluded from imported data.",
        ],
    }


def extract_calculator(quote_path: Path) -> dict:
    """Retain Calculator source fields/formulas, including extended validations."""
    book = SourceWorkbook(quote_path)
    cells = book.sheet("Calculator")
    sheet_xml = ET.fromstring(book.archive.read(book.sheet_paths["Calculator"]))
    select_ranges = []
    for validation in sheet_xml.iter():
        if validation.tag.split("}")[-1] == "dataValidation" and validation.attrib.get("type") == "list":
            sqref = validation.attrib.get("sqref")
            if sqref is None:
                sqref = next((child.text for child in validation if child.tag.split("}")[-1] == "sqref"), "")
            select_ranges.extend(sqref.split())

    def address_parts(address):
        match = re.fullmatch(r"([A-Z]+)([0-9]+)", address)
        if match is None:
            raise ValueError(f"Unsupported Calculator address {address}")
        column = 0
        for character in match.group(1):
            column = column * 26 + ord(character) - ord("A") + 1
        return int(match.group(2)), column

    def is_select(address):
        row, column = address_parts(address)
        for cell_range in select_ranges:
            bounds = cell_range.split(":")
            first_row, first_column = address_parts(bounds[0])
            last_row, last_column = address_parts(bounds[-1])
            if first_row <= row <= last_row and first_column <= column <= last_column:
                return True
        return False

    fields = []
    for address in sorted(cells, key=address_parts):
        cell = cells[address]
        style = book.styles[cell["style"]]
        if style["locked"] or cell["has_formula"] or cell["value"] is None:
            continue
        row, column = address_parts(address)
        if row <= 12:
            section = "Labour teams" if column == 4 else "Job and access"
            label = cells[f"{'C' if column == 4 else 'A'}{row}"]["value"]
        elif 15 <= row <= 23:
            section = "Materials"
            label_cell = f"A{row}" if column == 2 else f"{chr(column + 64)}14"
            label = cells[label_cell]["value"]
        elif 26 <= row <= 28:
            section = "Adjustments and additions"
            label = cells[f"A{row}"]["value"] if column == 2 else f"Addition {row - 25}" if column == 5 else f"Amount for {cells[f'E{row}']['value']}"
        else:
            raise ValueError(f"New unlocked field {address} needs an explicit label/section mapping")
        fields.append({"cell": address, "label": label, "section": section,
            "type": "select" if is_select(address) else "text" if isinstance(cell["value"], str) else "number",
            "default": cell["value"], "format": book.formats[style["format_id"]]})
    formulas = {}
    cached = {}
    for address, cell in cells.items():
        if cell["has_formula"]:
            if not cell["formula"]:
                raise ValueError(f"Shared Calculator formula {address} needs explicit expansion")
            formulas[address] = "=" + cell["formula"]
            cached[address] = cell["value"]
    return {"source": "Quote.xlsm!Calculator", "fields": fields, "formulas": formulas, "cached": cached,
        "excluded_cells": {"A1": "Pre-existing literal #VALUE!; no dependents", "B56": "Locked blank included as zero in SUM"}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--quote", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "baseline.json")
    parser.add_argument("--calculator-output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "calculator.json")
    args = parser.parse_args()
    result = extract(args.inventory, args.quote)
    calculator = extract_calculator(args.quote)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.calculator_output.parent.mkdir(parents=True, exist_ok=True)
    args.calculator_output.write_text(json.dumps(calculator, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"inventory_records": len(result["inventory"]), "rate_groups": {k: len(v) for k,v in result["rate_groups"].items()}, "calculator_fields": len(calculator["fields"]), "calculator_formulas": len(calculator["formulas"]), "sources": result["sources"]}, indent=2))


if __name__ == "__main__":
    main()
