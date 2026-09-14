"""Prepare reviewed-yield inputs for the native Excel capture, never expectations.

The source workbook is copied byte-for-byte into an ignored directory. Run
capture_calculator_oracle.ps1 separately to obtain the expected values from a
private Microsoft Excel instance. Numeric assumptions are independently copied
from docs/VERMICULITE_YIELD_REVIEW.md, not the runtime defaults or engine.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from estimator.workbook_catalog import column_name, load_workbook_catalog
from scripts.prepare_calculator_scenarios import case, output_selection, schedule_scenario


SOURCE = Path("C:/Users/tanas/OneDrive - Ceasefire PFP/Quotes/Quote Estimates/Ceasefire Calculators/Ceasefire_Steel_Vermiculite_Estimator_NEW.xlsx")
PRODUCTS = (
    # Product, bag mass/direct yield/density/waste/yield-used rows, reviewed kg,
    # reviewed m3/bag, and an existing native-Excel quantified steel example.
    ("CAFCO 300", (36, 37, 38, 39, 40), 20, 0.0651,
     ("300X200X8RHS", "Hollow - 4 sides", 550, 165)),
    ("MANDOLITE CP2", (69, 70, 71, 72, 73), 20, 0.0516,
     ("400WC328", "Re-entrant - 3 sides", 620, 206)),
    ("FENDOLITE MII", (101, 102, 103, 104, 105), 20, 0.031,
     ("410UB59.7", "Re-entrant - 3 sides", 620, 392)),
    ("PERLIFOC HP ECO+", (178, 179, 180, 181, 182), 17, 17 / 350,
     ("300X300X8SHS", "Hollow - 4 sides", 550, 168)),
    ("MONOKOTE MK-6 HY", (234, 235, 236, 237, 238), 21.8,
     27 * 0.002359737216, ("200UC52.2", "Re-entrant - 3 sides", 620, 334)),
)


def reviewed_settings():
    result = {}
    for _product, rows, mass, direct, _example in PRODUCTS:
        result.update({f"D{rows[0]}": mass, f"D{rows[1]}": direct,
                       f"D{rows[2]}": mass / direct, f"D{rows[3]}": 0})
    return result


def representative_cases():
    result = []
    for index, (product, _rows, _mass, _direct, example) in enumerate(PRODUCTS):
        section, exposure, temperature, original_row = example
        base = {"A": f"Reviewed yield {index + 1}", "B": product,
                "C": exposure, "D": temperature, "E": "Section", "F": section,
                "G": None, "H": 120, "I": 2, "J": 1.234567, "K": None, "L": None}
        lineage = ("steel_vermiculite-variations.json.gz:"
                   f"all_active_section_choices:SCHEDULE!A{original_row}:L{original_row}")
        result.append(case(f"product_{index + 1}_section", base,
                           "reviewed_products", "decimal_length", source=lineage))
        result.append(case(f"product_{index + 1}_area_override",
                           {**base, "A": f"Pooled area {index + 1}", "I": 3,
                            "J": 2.3456789, "L": 0.123456789},
                           "pooled_product_totals", "area_override", source=lineage))
    return result


def include_yield_inputs(scenario):
    """Capture the actual entered values as well as their formula results."""
    selection = scenario["outputs"]["SETTINGS"]
    indexed = {cell[2]: cell for cell in selection["cells"]}
    for _product, rows, _mass, _direct, _example in PRODUCTS:
        for row in rows:
            indexed[f"D{row}"] = [row, 4, f"D{row}"]
    selection["cells"] = sorted(indexed.values())
    last_column = column_name(max(cell[1] for cell in selection["cells"]))
    selection["range"] = f"A1:{last_column}{max(cell[0] for cell in selection['cells'])}"


def scenarios(model):
    checkpoint = {"id": "original_defaults_checkpoint", "inputs": {},
                  "input_blocks": [], "formula_overrides": {},
                  "outputs": output_selection(model, {10, 11, 1009}),
                  "coverage": {"note": "Unmodified source graph; no reviewed default overlay."}}
    reviewed = reviewed_settings()
    examples = representative_cases()
    result = [checkpoint, schedule_scenario(model, "reviewed_direct_all_products", examples, settings=reviewed)]
    fallback = deepcopy(reviewed)
    overrides = deepcopy(reviewed)
    invalid = deepcopy(reviewed)
    for index, (_product, rows, mass, _direct, _example) in enumerate(PRODUCTS):
        fallback[f"D{rows[1]}"] = None
        overrides.update({f"D{rows[0]}": mass + 0.123456789,
                          f"D{rows[1]}": 0.043210987654321 + index * 0.00123456789,
                          f"D{rows[2]}": 987.654321 + index,
                          f"D{rows[3]}": 0.03123456789 * (index + 1)})
        invalid[f"D{rows[1]}"] = [0, -0.01, "pending", None, None][index]
        if index == 3:
            invalid[f"D{rows[2]}"] = 0
        if index == 4:
            invalid[f"D{rows[0]}"] = 0
    result.extend([
        schedule_scenario(model, "reviewed_equivalent_density_fallback", examples, settings=fallback),
        schedule_scenario(model, "explicit_user_yield_and_waste_override", examples, settings=overrides),
        schedule_scenario(model, "invalid_direct_or_fallback_inputs", examples, settings=invalid),
    ])
    for scenario in result:
        include_yield_inputs(scenario)
        scenario["coverage"]["yield_products"] = [item[0] for item in PRODUCTS]
        scenario["coverage"]["basis"] = "docs/VERMICULITE_YIELD_REVIEW.md; all expected values must be captured by native Excel."
    return result


def prepare(source_path, output_directory):
    source_path, output_directory = source_path.resolve(), output_directory.resolve()
    model = load_workbook_catalog("steel_vermiculite")
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if source_hash != model["source"]["sha256"]:
        raise ValueError("Source workbook differs from the immutable packaged source")
    # An existing run must never silently overwrite an earlier oracle capture.
    output_directory.mkdir(parents=True, exist_ok=False)
    copy_path = output_directory / "source-copy.xlsx"
    shutil.copyfile(source_path, copy_path)
    if hashlib.sha256(copy_path.read_bytes()).hexdigest() != source_hash:
        raise ValueError("Disposable copy does not match the original workbook")
    generated = scenarios(model)
    plan = {"schema_version": 1, "purpose": "Reviewed explicit yield overlays, native Excel expected outputs only",
            "workbooks": [{"id": model["id"], "source_sha256": source_hash,
                           "copy_path": str(copy_path), "scenarios": generated}]}
    plan_path = output_directory / "plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    coverage = {"source_sha256": source_hash, "scenarios": len(generated),
                "products": [item[0] for item in PRODUCTS],
                "outputs": sum(len(output["cells"]) for scenario in generated for output in scenario["outputs"].values()),
                "scenario_outputs": {scenario["id"]: sum(len(output["cells"]) for output in scenario["outputs"].values()) for scenario in generated}}
    (output_directory / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"plan": str(plan_path), **coverage}, indent=2))
    return plan_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output-directory", type=Path, required=True)
    arguments = parser.parse_args()
    prepare(arguments.source, arguments.output_directory)


if __name__ == "__main__":
    main()
