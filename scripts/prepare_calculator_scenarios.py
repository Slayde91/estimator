"""Prepare source-derived input variations for native Excel oracle capture.

This script writes JSON plans only. It neither recalculates workbooks nor uses
the application's calculation engine or cached formula values as expectations.
The separate native Excel capture creates every expected result.
"""

from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from itertools import product
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from estimator.workbook_catalog import CATALOG_SPECS, column_name, column_number, load_workbook_catalog


def sheets_by_name(model):
    return {sheet["name"]: sheet for sheet in model["sheets"]}


def literal(sheets, sheet, cell, default=None):
    """Read source literal data; formula caches cannot become test expectations."""
    return sheets[sheet]["cells"].get(cell, {}).get("value", default)


def case(identifier, values, *categories, source=None):
    result = {"id": identifier, "values": values, "categories": list(categories)}
    if source:
        result["source"] = source
    return result


def output_selection(model, selected_rows, include_extra=False):
    schedule = model["schedule"]
    selections = {}
    engine_rows = {row - schedule["first_row"] + 3 for row in selected_rows}
    for sheet in model["sheets"]:
        name = sheet["name"]
        cells = []
        for address, entry in sheet["cells"].items():
            if "formula" not in entry:
                continue
            row = int(re.search(r"\d+$", address)[0])
            column = column_number(re.match(r"[A-Z]+", address)[0])
            if name == schedule["sheet"]:
                include = row < schedule["first_row"] or row in selected_rows
            elif name == "ENGINE" and model["id"] == "steel_vermiculite":
                include = row == 2 or row in engine_rows
            elif name == "EXTRA BOARDS":
                include = include_extra
            else:
                include = name in model["pages"]
            if include:
                cells.append([row, column, address])
        if cells:
            max_row = max(cell[0] for cell in cells)
            max_column = max(cell[1] for cell in cells)
            selections[name] = {"range": f"A1:{column_name(max_column)}{max_row}", "cells": cells}
    return selections


def schedule_scenario(model, identifier, cases, *, settings=None, ordinary_inputs=None, extras=None):
    schedule = model["schedule"]
    first, last = schedule["first_row"], schedule["last_row"]
    capacity = last - first + 1
    if len(cases) > capacity:
        raise ValueError(f"{identifier}: {len(cases)} cases exceed {capacity} source rows")
    start_column = "B" if model["id"] == "ductwork" else "A"
    end_column = schedule["input_last_column"]
    columns = [column_name(number) for number in range(column_number(start_column), column_number(end_column) + 1)]
    rows = [[None] * len(columns) for _ in range(capacity)]
    row_cases = []
    for offset, item in enumerate(cases):
        row = first + offset
        rows[offset] = [item["values"].get(column) for column in columns]
        row_cases.append({"row": row, **item})
    if cases and len(cases) < capacity:
        sentinel = deepcopy(cases[0])
        sentinel["id"] = "last_source_row_sentinel"
        sentinel["categories"] = ["last_schedule_row"]
        rows[-1] = [sentinel["values"].get(column) for column in columns]
        row_cases.append({"row": last, **sentinel})
    selected_rows = {item["row"] for item in row_cases}
    # The first cleared row detects state left behind after clearing/replacing a
    # schedule, and distinguishes empty cells from zero and formula empty text.
    if len(cases) < capacity - 1:
        selected_rows.add(first + len(cases))
    inputs = deepcopy(ordinary_inputs or {})
    if settings:
        settings_sheet = next(iter(model["setting_ranges"]))
        inputs.setdefault(settings_sheet, {}).update(settings)
    blocks = [{"sheet": schedule["sheet"], "range": f"{start_column}{first}:{end_column}{last}", "values": rows}]
    if model["id"] == "steel_board":
        extra_rows = [[None] * 9 for _ in range(40)]
        references = [[None] for _ in range(40)]
        for offset, item in enumerate(extras or []):
            extra_rows[offset] = [item["values"].get(column) for column in "ABCDEFGHI"]
            references[offset] = [item["values"].get("N")]
        blocks.extend([
            {"sheet": "EXTRA BOARDS", "range": "A6:I45", "values": extra_rows},
            {"sheet": "EXTRA BOARDS", "range": "N6:N45", "values": references},
        ])
    return {"id": identifier, "inputs": inputs, "input_blocks": blocks,
            "formula_overrides": {}, "outputs": output_selection(model, selected_rows, include_extra=bool(extras)),
            "coverage": {"row_cases": row_cases, "extra_cases": extras or [],
                         "settings_changed": sorted(settings or {}),
                         "selected_schedule_rows": sorted(selected_rows),
                         "note": "Some boundary cases deliberately bypass Excel entry validation to test the original formula error/blank paths."}}


def duct_scenarios(model):
    sheets = sheets_by_name(model)
    products = ["CAFCO 300", "MONOKOTE", "FyreWrap"]
    periods = [60, 90, 120, 180, "60/60/60", "90/90/90", "120/120/120", "180/180/180", "240/240/180", "120/120/-", "120/120/60"]
    orientations = ["Horizontal", "Vertical", "Mixed", "Both"]
    exposures = [literal(sheets, "PRODUCT SETTINGS", f"J{row}") for row in range(137, 150)]
    base = {"B": "1000 x 1000", "C": "CAFCO 300", "D": 2.34567, "E": 120,
            "F": 1, "G": 1, "H": "Internal", "I": "Horizontal"}
    cases = []
    for item, period, orientation in product(products, periods, orientations):
        cases.append(case(f"choice_{len(cases)+1}", {**base, "C": item, "E": period, "I": orientation}, "products", "frl_choices", "orientation_choices"))
    for item, exposure in product(products, exposures):
        cases.append(case(f"exposure_{len(cases)+1}", {**base, "C": item, "H": exposure}, "exposure_choices"))
    sizes = ["1000x250", "1000.01x250", "1000x250.01", "1200x1200", "1200.01x1200", "2000x1200", "2000.01x1200", "3000x1200", "3000.01x1200", "2400x2400", "2400.01x2400", "1500x1500", "1500.01x1500", "0x1000", "1000x0", "1000 X 500", "1000 × 500", "1000.125x500.875", "unknown", ""]
    for item, size in product(products, sizes):
        cases.append(case(f"size_{len(cases)+1}", {**base, "C": item, "B": size}, "size_boundaries", "input_normalization"))
    for item in products:
        for changes in ({"D": 0}, {"D": None}, {"D": 0.00001}, {"F": 0, "G": 0}, {"F": None, "G": None}, {"F": 0.5, "G": 1.25}, {"E": 0}, {"E": None}, {"C": ""}):
            cases.append(case(f"blank_zero_decimal_{len(cases)+1}", {**base, "C": item, **changes}, "blank_zero_decimal"))
    scenarios = [schedule_scenario(model, "all_dropdowns_sizes_and_numeric_boundaries", cases)]
    controls = [case(f"settings_product_{index}", {**base, "C": item, "H": "Kitchen exhaust - inside" if item == "FyreWrap" else "External"}, "settings_propagation") for index, item in enumerate(products)]
    scenarios.append(schedule_scenario(model, "uncalibrated_injected_wide_roll", controls, settings={"B35": "Uncalibrated", "B65": "Injected", "B73": "Uncalibrated", "B97": 1.22, "B100": 0.01}))
    scenarios.append(schedule_scenario(model, "calibration_reference_precision", controls, settings={
        "B35": "Calibrated", "B44": 12.34567, "B45": 61.2345, "B46": 13.76543,
        "B65": "Un-injected", "B73": "Calibrated", "B90": 17.23456, "B91": 62.3456,
        "B92": 19.87654, "B97": 0.61, "B100": 0.005,
    }))
    return scenarios


def board_scenarios(model):
    sheets = sheets_by_name(model)
    products = [literal(sheets, "PRODUCTS", f"A{row}") for row in range(6, 10)]
    base = {"A": "Oracle member", "B": "Oracle location", "C": "PROMATECT-XS", "D": "200UC46",
            "F": 2.34567, "G": 4, "H": 120, "I": "Column", "J": 550,
            "M": "Standard", "O": "Auto", "P": "Published first", "Q": "Standard box"}
    catalogue_cases = []
    for index, row in enumerate(range(6, 1348)):
        identifier = literal(sheets, "STEEL LIBRARY", f"A{row}")
        catalogue_cases.append(case(f"steel_{index+1}", {**base, "A": identifier, "D": identifier, "C": products[index % len(products)]}, "all_steel_ids", source=f"STEEL LIBRARY!A{row}"))
    scenarios = [schedule_scenario(model, f"steel_catalogue_{start//200+1:02d}", catalogue_cases[start:start+200])
                 for start in range(0, len(catalogue_cases), 200)]
    cases = []
    for item in products:
        for period in (0, 15, 30, 45, 60, 61, 90, 91, 120, 121, 180, 240, 241):
            cases.append(case(f"period_{len(cases)+1}", {**base, "C": item, "H": period}, "frl_boundaries"))
        for temperature in (None, 550, 620, 600):
            cases.append(case(f"temperature_{len(cases)+1}", {**base, "C": item, "J": temperature}, "temperature_choices"))
        for sides in (1, 2, 3, 4):
            cases.append(case(f"sides_{len(cases)+1}", {**base, "C": item, "G": sides}, "sides_choices"))
        for layout in ("Standard", "Rotate", "Partial depth", "Opposite B", "Opposite D", "Custom girth"):
            cases.append(case(f"layout_{len(cases)+1}", {**base, "C": item, "M": layout, "N": 100.123, "V": 0.91234}, "layout_choices", "geometry_overrides"))
        for layer in ("Auto", "Single", "Double"):
            cases.append(case(f"layer_{len(cases)+1}", {**base, "C": item, "O": layer}, "layer_choices"))
        for lookup in ("Published first", "General only"):
            cases.append(case(f"lookup_{len(cases)+1}", {**base, "C": item, "P": lookup}, "lookup_choices"))
        for detail in ("Standard box", "XS top of wall", "Promat trapezoid unfilled", "Special / engineered"):
            cases.append(case(f"detail_{len(cases)+1}", {**base, "C": item, "Q": detail, "I": "Beam", "J": 620, "G": 3, "X": "Oracle design reference"}, "detail_choices", "beam_column_choices"))
        for family in ("I/H", "Channel", "Angle", "SHS", "RHS", "CHS", "Tee"):
            cases.append(case(f"manual_family_{len(cases)+1}", {**base, "C": item, "D": None, "E": 18.234567, "K": family, "R": 200.125, "S": 180.875, "T": 58.7654, "U": 46.12345, "W": 0.012345}, "manual_esa_family_choices", "geometry_overrides"))
    for changes in ({"F": 0}, {"F": None}, {"F": 0.00001}, {"L": 0.125}, {"L": 0}, {"D": None, "E": None}, {"H": None}, {"D": "unknown"}):
        cases.append(case(f"blank_zero_decimal_{len(cases)+1}", {**base, **changes}, "blank_zero_decimal"))
    extras = []
    for index, row in enumerate(range(14, 32)):
        extras.append(case(f"stock_board_{index+1}", {
            "A": literal(sheets, "PRODUCTS", f"A{row}"), "B": literal(sheets, "PRODUCTS", f"B{row}"),
            "C": literal(sheets, "PRODUCTS", f"D{row}"), "D": 1.25 if index % 2 else None,
            "E": 543.21 if index % 2 else None, "F": 234.56 if index % 2 else None,
            "G": None if index % 2 else 0.345678, "H": 0.125, "I": "Oracle stock allowance", "N": "Source stock row " + str(row),
        }, "all_stock_boards", "extra_boards", source=f"PRODUCTS!A{row}:J{row}"))
    scenarios.append(schedule_scenario(model, "advanced_choices_boundaries_and_all_stock", cases, extras=extras))
    control = [case(f"settings_{index}", {**base, "C": item, "E": 18.2345, "D": None, "K": "I/H", "R": 200, "S": 200, "T": 58.8, "U": 46.1}, "settings_propagation") for index, item in enumerate(products)]
    settings = {}
    for address in sorted({field["cell"] for field in model["fields"]["SETTINGS"]}):
        value = literal(sheets, "SETTINGS", address)
        if isinstance(value, (int, float)):
            settings[address] = value * 1.001 if value else 0.125
    settings.update({"B10": 0.125, "B21": 2e-8, "B33": "COREX|20+20", "B34": "COREX|25+20"})
    scenarios.append(schedule_scenario(model, "all_editable_settings_changed", control + cases[:12], settings=settings, extras=extras))
    scenarios.append(schedule_scenario(model, "zero_waste_rounding_and_manual_geometry", control + cases[-8:], settings={"B10": 0, "B21": 1e-8}, extras=extras))
    return scenarios


def vermiculite_scenarios(model):
    sheets = sheets_by_name(model)
    products = [literal(sheets, "SETTINGS", f"P{row}") for row in range(6, 11)]
    period_values = [literal(sheets, "SETTINGS", f"BI{row}") for row in range(6, 14)]
    case_labels = {literal(sheets, "SETTINGS", f"BL{row}"): literal(sheets, "SETTINGS", f"BK{row}") for row in range(6, 12)}
    families = {literal(sheets, "SECTIONS", f"A{row}"): literal(sheets, "SECTIONS", f"B{row}") for row in range(6, 561)}
    base = {"A": "Oracle member", "B": "CAFCO 300", "C": case_labels["R3"], "D": 620,
            "E": "Section", "F": "410UB54", "H": 120, "I": 2, "J": 1.234567}
    cases = []
    for index, row in enumerate(range(6, 559)):
        identifier = literal(sheets, "SETTINGS", f"BM{row}")
        hollow = families[identifier] in ("SHS", "RHS", "CHS")
        cases.append(case(f"active_section_{index+1}", {**base, "A": identifier, "B": products[index % 5], "F": identifier,
                         "C": case_labels["H4"] if hollow else case_labels["R3"], "D": 550 if hollow else 620}, "all_active_sections", source=f"SETTINGS!BM{row}"))
    scenarios = [schedule_scenario(model, "all_active_section_choices", cases)]
    series_cases = []
    for row in range(6, 90):
        item = literal(sheets, "SETTINGS", f"AE{row}")
        exposure = literal(sheets, "SETTINGS", f"AF{row}")
        temperature = literal(sheets, "SETTINGS", f"AG{row}")
        first = literal(sheets, "SETTINGS", f"AI{row}", 0)
        last = literal(sheets, "SETTINGS", f"AJ{row}", 0)
        low = literal(sheets, "THICKNESS DATA", f"E{1465+first}") if first else None
        high = literal(sheets, "THICKNESS DATA", f"E{1465+last}") if last else None
        factor = low if isinstance(low, (int, float)) else 100
        values = {**base, "B": item, "C": case_labels[exposure], "D": temperature, "E": "Hp/A", "F": None, "G": factor, "L": 2.345678}
        for period in period_values:
            series_cases.append(case(f"series_{row-5}_period_{period}", {**values, "H": period}, "all_design_series", "all_period_choices", source=f"SETTINGS!AD{row}:AM{row}"))
        if isinstance(low, (int, float)) and isinstance(high, (int, float)):
            for label, factor in (("below_min", low-0.01), ("between_rows", low+0.12345), ("above_max", high+0.01)):
                series_cases.append(case(f"series_{row-5}_{label}", {**values, "G": factor}, "factor_boundaries", source=f"SETTINGS!AI{row}:AJ{row}"))
        series_cases.append(case(f"series_{row-5}_esa", {**values, "E": "ESA/M", "G": 25.123456}, "esa_method", "all_design_series"))
        if exposure == "C":
            series_cases.append(case(f"series_{row-5}_lower_web", {**values, "E": "Lower web (mm)", "G": 20.125}, "lower_web_method"))
    for start in range(0, len(series_cases), 1000):
        scenarios.append(schedule_scenario(model, f"all_series_periods_and_bounds_{start//1000+1:02d}", series_cases[start:start+1000]))
    control = []
    for index, item in enumerate(products):
        control.append(case(f"yield_product_{index+1}", {**base, "B": item, "E": "Hp/A", "F": None, "G": 190, "L": 3.456789}, "all_product_yields"))
    for changes in ({"I": 0}, {"I": None}, {"I": 1.5}, {"J": 0}, {"J": 0.00001}, {"K": 0}, {"K": 1.23456}, {"L": 0}, {"L": 1.234567}, {"F": "unknown"}, {"B": ""}):
        control.append(case(f"quantity_boundary_{len(control)+1}", {**base, **changes}, "blank_zero_decimal", "quantity_precedence"))
    groups = [(36,37,38,39,42),(69,70,71,72,75),(101,102,103,104,107),(178,179,180,181,184),(234,235,236,237,240)]
    variations = [
        ("direct_yields_and_waste", {"D10": "Oracle project", "D11": "Oracle design", "D12": "Confirmed by project designer", "D13": 7800, "D14": "Exact only"}),
        ("density_fallback_yields", {"D14": "Next higher (estimate)"}),
        ("missing_yield_and_zero_area", {}),
        ("formula_backed_mass_changes", {}),
        ("rounding_manual_bags_and_helpers", {}),
    ]
    methods = ["Hp/A", "ESA/M", "Lower web (mm)", "Section", "Hp/A"]
    for index, (name, settings) in enumerate(variations):
        settings = dict(settings)
        for product_index, (mass, direct, density, waste, basis) in enumerate(groups):
            if index == 0:
                settings.update({f"D{direct}": 0.051234567 + product_index * 0.003, f"D{waste}": 0.125,
                                 f"D{basis}": "Native oracle verified input variation"})
            elif index == 1:
                settings.update({f"D{mass}": 20.12345 + product_index, f"D{direct}": None, f"D{density}": 390.12345 + product_index * 40, f"D{waste}": 0})
            elif index == 2:
                settings.update({f"D{direct}": None, f"D{density}": None})
            elif index == 3:
                settings[f"D{mass}"] = 21.123456 + product_index
        settings.update({"D346": 1.234567, "D347": 6543.21, "D348": 51.2345,
                         "D358": ("RHS", "CHS", "SHS", "SHS", "CHS")[index],
                         "D359": 200.125, "D360": 180.375 if index == 0 else 200.125,
                         "D361": 6.125, "D362": 3 if index == 1 else 4, "D372": 18.7654})
        single = {"D6": products[index], "D7": case_labels["C"] if index == 2 else case_labels["R3"],
                  "D8": 550 if index == 2 else 620, "D9": methods[index], "D10": "410UB54" if index == 3 else None,
                  "D11": 20.125 if index == 2 else 25.125 if index == 1 else 190.123,
                  "D12": 120, "D14": 2, "D15": 1.234567, "D16": None, "D17": 4.56789}
        manual = {"D6": products[index], "D7": 0 if index == 2 else 12.345678, "D8": 19.87654}
        scenarios.append(schedule_scenario(model, name, control, settings=settings,
                                           ordinary_inputs={"CALCULATOR": single, "BAGS": manual}))
    return scenarios


def prepare(base_plan_path):
    base_plan = json.loads(Path(base_plan_path).read_text(encoding="utf-8-sig"))
    definitions = {entry["id"]: entry for entry in base_plan["workbooks"]}
    result = {"schema_version": 1, "purpose": "Native Microsoft Excel varied-input oracle; no application expected values", "workbooks": []}
    generators = {"ductwork": duct_scenarios, "steel_board": board_scenarios, "steel_vermiculite": vermiculite_scenarios}
    for identifier, generator in generators.items():
        model = load_workbook_catalog(identifier)
        definition = definitions[identifier]
        if definition["source_sha256"] != model["source"]["sha256"]:
            raise ValueError(f"{identifier}: native copy and packaged source provenance differ")
        scenarios = generator(model)
        approved = next((scenario["formula_overrides"] for scenario in definition["scenarios"]
                         if scenario["id"] == "approved_fixed_instruction_text"), {})
        for scenario in scenarios:
            scenario["formula_overrides"] = deepcopy(approved)
        categories = Counter(category for scenario in scenarios for row_case in scenario["coverage"]["row_cases"] for category in row_case["categories"])
        categories.update(category for scenario in scenarios for extra in scenario["coverage"]["extra_cases"] for category in extra["categories"])
        result["workbooks"].append({"id": identifier, "copy_path": definition["copy_path"],
                                   "source_sha256": definition["source_sha256"], "scenarios": scenarios,
                                   "coverage": {"scenarios": len(scenarios), "row_cases": sum(len(scenario["coverage"]["row_cases"]) for scenario in scenarios),
                                                "categories": dict(sorted(categories.items())),
                                                "outputs": sum(len(output["cells"]) for scenario in scenarios for output in scenario["outputs"].values()),
                                                "settings_changed": sorted({cell for scenario in scenarios for cell in scenario["coverage"]["settings_changed"]})}})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-plan", type=Path, default=ROOT / ".runtime/calculators-audit/native/plan.json")
    parser.add_argument("--output", type=Path, default=ROOT / ".runtime/calculators-audit/native/variation-plan.json")
    arguments = parser.parse_args()
    plan = prepare(arguments.base_plan)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(plan, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    coverage = {entry["id"]: entry["coverage"] for entry in plan["workbooks"]}
    arguments.output.with_name("variation-coverage.json").write_text(json.dumps(coverage, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(coverage, indent=2))


if __name__ == "__main__":
    main()
