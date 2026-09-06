"""Prepare an isolated Excel formula harness; never execute or save source macros.

Requires openpyxl. Run before capture_excel_oracle.ps1. The original XLSM's
external spill formulas are replaced ONLY in the harness with their saved Lists
values. Every Calculator formula is copied verbatim and checked after saving.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import pathlib
import warnings
import xml.etree.ElementTree as ET
import zipfile

import openpyxl


def prepare(source: pathlib.Path, output: pathlib.Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        formulas = openpyxl.load_workbook(source, keep_links=False)
        cached = openpyxl.load_workbook(source, data_only=True, keep_links=False)
    harness = openpyxl.Workbook()
    harness.remove(harness.active)
    with zipfile.ZipFile(source) as archive:
        lists_xml = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    empty_text_cells = {
        cell.attrib["r"] for cell in lists_xml.findall(".//s:c", ns)
        if cell.attrib.get("t") == "str" and not cell.findtext("s:v", namespaces=ns)
    }
    for title in ("Lists", "Calculator"):
        destination = harness.create_sheet(title)
        for row in formulas[title]:
            for cell in row:
                destination[cell.coordinate] = (
                    cached[title][cell.coordinate].value if title == "Lists" else cell.value
                )
                destination[cell.coordinate].number_format = cell.number_format
                if title == "Lists" and cell.coordinate in empty_text_cells:
                    # data_only collapses cached empty text to None. Preserve
                    # text semantics: VLOOKUP of empty text differs from blank.
                    destination[cell.coordinate] = '=""'
    # Excel marks the source's #NAME? LET parameter names as legacy XLM names.
    # They are not the actual named ranges used by the Calculator's formulas.
    for name in formulas.defined_names.values():
        if not name.xlm:
            harness.defined_names.add(copy.copy(name))
    harness_path = output / "Quote-formula-harness.xlsx"
    harness.save(harness_path)
    saved = openpyxl.load_workbook(harness_path)
    expected_cells = []
    defaults = {}
    for row in formulas["Calculator"]:
        for cell in row:
            if cell.data_type == "f":
                assert saved["Calculator"][cell.coordinate].value == cell.value
                expected_cells.append(cell.coordinate)
            elif cell.value is not None and not cell.protection.locked:
                defaults[cell.coordinate] = cell.value

    scenarios = []

    def add(identifier, changes=None, overrides=None, base=None):
        scenarios.append({
            "id": identifier,
            "inputs": defaults | (base or {}) | (changes or {}),
            "lookupOverrides": overrides or {},
        })

    add("saved-defaults")
    active = {
        "B8": 123.45, "B15": 37.25, "B16": 42.5, "B17": 51.25,
        "B18": 3.5, "B19": 12.75, "B20": 85.5, "B21": 68.25,
        "B22": 18.75, "B23": 47.125,
        "F26": 0.75, "F27": 2, "F28": 1,
    }
    for row in range(2, 11):
        active[f"D{row}"] = "1 Team - 1x"
    lookup_columns = {
        "B2": "B", "B3": "K", "B5": "K", "B6": "N", "B7": "Q",
        "B10": "H", "D2": "E", "D3": "E", "D4": "E", "D5": "E",
        "D6": "E", "D7": "E", "D8": "E", "D9": "E", "D10": "E",
        "E26": "E", "E27": "E", "E28": "E", "D15": "AE", "D16": "W",
        "D17": "AA", "D18": "T", "D19": "W", "D20": "AP",
        "D21": "AT", "D22": "AH", "D23": "AL",
    }
    for cell in ("B2", "B3", "B5", "B6", "B7"):
        active[cell] = cached["Lists"][lookup_columns[cell] + "2"].value
    add("all-lines-nonzero-decimal", base=active)
    for adjustment in (-1, -0.15, 0.075, 0.25):
        add(f"material-adjustment-{adjustment}", {"B26": adjustment}, base=active)
        add(f"labour-adjustment-{adjustment}", {"B27": adjustment}, base=active)
    add("combined-adjustments", {"B26": 0.175, "B27": 0.225, "B28": -75.43}, base=active)
    add("zero-project-area", {"B8": 0}, base=active)
    add("blank-project-area", {"B8": None}, base=active)
    add("blank-coverage", {f"B{row}": None for row in range(15, 24)}, base=active)
    add("zero-daily-output", {"C15": 0}, base=active)
    add("blank-daily-output", {"C15": None}, base=active)
    add("zero-masking", {"B9": 0}, base=active)
    add("zero-additions", {"F26": 0, "F27": 0, "F28": 0}, base=active)
    add("decimal-hire-quantity", {"B4": 1.375}, base=active)
    add("rounding-sensitive", {
        "B15": 0.00012345, "B26": 0.333333, "B27": 0.111111,
        "B28": 0.005, "F26": 0.012345, "F27": 0.5,
    }, base=active)
    for workflow, product, quantity in (
        ("intumescent-ductwork", "Dulux Firetex 6010", 12.75),
        ("intumescent-structural-steel", "Dulux Firetex 5090", 27.375),
        ("intumescent-slabs", "Dulux Sprayfilm WB3", 8.125),
        ("intumescent-walls", "Nullifire SC902", 19.75),
        ("vermiculite-spray", "Promat Cafco 300", 42.5),
        ("fire-wrap-ductwork", "Trafalgar FyreWRAP 610", 3.375),
    ):
        # Labels classify requested estimating use, not product suitability or
        # fire certification. Workbook quantities are supplied by the estimator.
        add(f"workflow-{workflow}", {"D15": product, "B15": quantity}, base=active)
    # Every available product/dropdown value is exercised. The 12 controls with
    # the same labour list use all 27 values once, then a distinct alternative
    # for each remaining control to validate the field-to-formula wiring.
    exercised = set()
    for input_cell, column in lookup_columns.items():
        options = [cell.value for cell in cached["Lists"][column] if cell.value is not None]
        if column in exercised:
            options = options[-1:]
        exercised.add(column)
        for index, value in enumerate(options):
            add(f"dropdown-{input_cell}-{index:02d}", {input_cell: value}, base=active)
    add("missing-selection", {"D15": "Missing workbook product"}, base=active)
    add("blank-selection", {"D15": None}, base=active)
    # Pricing changes directly override lookup prices and yields in Excel.
    # The inventory formula itself is tested separately from Calculator math.
    for cell, value in {
        "AF2": 91.234567, "F4": 2375.125, "I2": 247.875,
        "C2": 281.375, "Y3": 27.125, "AC2": 36.5,
    }.items():
        add(f"editable-lookup-{cell}", overrides={cell: value}, base=active)
    add("zero-material-yield", overrides={"Y3": 0}, base=active)
    add("blank-material-yield", overrides={"Y3": None}, base=active)
    add("empty-text-material-yield", overrides={"Y3": ""}, base=active)
    plan = {
        "source": source.name,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "oracleMode": "Microsoft Excel recalculation of verbatim Calculator formulas; frozen source cached Lists values with empty-text sentinels preserved; no VBA, links, or XLM names",
        "harnessPath": str(harness_path.resolve()),
        "defaultInputs": defaults,
        "expectedCells": expected_cells,
        "scenarios": scenarios,
    }
    (output / "oracle-plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared {len(scenarios)} scenarios and {len(expected_cells)} exact formula outputs.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.source, arguments.output)
