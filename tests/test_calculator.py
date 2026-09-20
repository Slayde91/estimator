import json
import math
from pathlib import Path
import unittest

from estimator.calculator import LINES, calculate, fields, labour_breakdown, masking_breakdown, specification
from estimator.catalog import baseline, effective_catalog, catalog_signature, ValidationError


class CalculatorTests(unittest.TestCase):
    def test_nonzero_coverage_requires_its_own_team_for_every_material_except_pins(self):
        expected = {15: "D2", 16: "D3", 18: "D6", 19: "D8", 20: "D4", 21: "D5", 22: "D9", 23: "D10"}
        self.assertEqual({row: team for row, _, _, _, team in LINES if team}, expected)
        for row, team in expected.items():
            for selection in ("N/A", "n/a", "", None):
                for coverage in (1, -1, .123456789012345):
                    with self.subTest(row=row, team=team, selection=selection, coverage=coverage):
                        inputs = {f"B{row}": coverage, team: selection}
                        before = dict(inputs)
                        with self.assertRaisesRegex(ValidationError, "^Select Teams$"):
                            calculate(inputs)
                        self.assertEqual(inputs, before)
            for coverage in (0, "", None):
                with self.subTest(row=row, coverage=coverage):
                    result = calculate({f"B{row}": coverage, team: "N/A"})
                    self.assertEqual(result["inputs"][f"B{row}"], coverage)
            allowed = calculate({f"B{row}": .123456789012345, team: "1 Team - 1x"})
            self.assertEqual(allowed["inputs"][f"B{row}"], .123456789012345)
        pins = calculate({"B8": 30, "B17": 20, **{team: "N/A" for team in expected.values()}})
        self.assertEqual(pins["inputs"]["B17"], 20)
        self.assertEqual(pins["errors"], {})

    def test_unmatched_historical_team_keeps_its_existing_lookup_error(self):
        result = calculate({"B15": 2, "D2": "Unknown historic team"})
        self.assertEqual(result["inputs"]["D2"], "Unknown historic team")
        self.assertEqual(result["errors"]["A65"], "#N/A")
        self.assertIsNone(result["summary"]["total"])

    def test_product_service_labels_keep_existing_selections_and_calculations(self):
        original = effective_catalog()
        primer = next(rate for rate in original["rate_groups"]["primers"] if rate["inventory_id"] == "204")
        standalone = original["rate_groups"]["labour_rates"][0]
        standalone.update(inventory_id=None, price_mode="override")
        inputs = {"D20": primer["name"], "B20": 142, "D4": "1 Team - 1x", "E26": standalone["name"], "F26": 1}
        configuration = {"catalog": original, "inventory": {"204": {"product_service": "Promat SBR Latex primer / topcoat, 20 kg"}},
                         "rates": {standalone["id"]: {"product_service": "Existing labour service, relabelled"}}}
        changed = effective_catalog(configuration)
        self.assertEqual(catalog_signature(changed), catalog_signature(original))
        before, after = calculate(inputs, {"catalog": original}), calculate(inputs, configuration)
        self.assertEqual(after["cells"], before["cells"])
        self.assertEqual(after["errors"], before["errors"])
        metadata = {field["cell"]: field for field in fields(changed)}
        self.assertEqual(metadata["D7"]["label"], "Masking/Cleaning labour")
        self.assertIn(primer["name"], metadata["D20"]["options"])
        self.assertEqual(metadata["D20"]["option_labels"][primer["name"]], configuration["inventory"]["204"]["product_service"])
        self.assertEqual(metadata["E26"]["option_labels"][standalone["name"]], configuration["rates"][standalone["id"]]["product_service"])

    def test_all_saved_excel_formula_caches(self):
        # The cache fixture is the original workbook snapshot, where B8 was 30.
        # Keep this parity check separate from the browser's intentionally blank default.
        result = calculate({"B8": 30})
        self.assertEqual(result["errors"], {})
        self.assertEqual(len(specification()["cached"]), 151)
        self.assertEqual(len(fields()), 64)
        for cell, expected in specification()["cached"].items():
            with self.subTest(cell=cell):
                actual = result["cells"][cell]
                if isinstance(expected, (int, float)):
                    self.assertTrue(math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9), (actual, expected))
                else:
                    self.assertEqual(actual, expected)

    def test_sqm_items_starts_unfilled(self):
        field = next(field for field in fields() if field["cell"] == "B8")
        self.assertIsNone(field["default"])
        result = calculate()
        self.assertIsNone(result["inputs"]["B8"])
        self.assertEqual(result["cells"]["F8"], "#DIV/0!")
        self.assertIsNone(result["summary"]["rate"])

    def test_zero_area_does_not_hide_other_totals(self):
        result = calculate({"B8": 0})
        self.assertEqual(result["cells"]["F8"], "#DIV/0!")
        self.assertEqual(result["summary"]["total"], 1260)
        self.assertIsNone(result["summary"]["rate"])

    def test_blank_quantity_and_invalid_selection_are_distinct(self):
        self.assertEqual(calculate({"B15": None})["summary"]["total"], 1260)
        result = calculate({"D15": ""})
        self.assertEqual(result["cells"]["A63"], "#N/A")
        self.assertIsNone(result["summary"]["total"])
        self.assertEqual(calculate({"D15": "Missing workbook product"})["cells"]["A63"], "#N/A")

    def test_calculated_cells_and_nonfinite_values_cannot_be_overwritten(self):
        for inputs in ({"F7": 1}, {"B15": float("nan")}, {"B15": True}, {"D15": 123}, {"B15": "1.2"}, [], False):
            with self.subTest(inputs=inputs), self.assertRaises(ValidationError):
                calculate(inputs)

    def test_no_rounding_of_material_quantity_or_money_before_totals(self):
        result = calculate({"B15": 0.5, "B9": 0, "D2": "1 Team - 1x", "F27": 0, "F28": 0})
        self.assertEqual(result["cells"]["D35"], 0.6)
        self.assertTrue(math.isclose(result["cells"]["F63"], 43.1262, abs_tol=1e-12))
        self.assertEqual(result["summary"]["total"], result["cells"]["F63"] + result["cells"]["F65"])
        self.assertIn("1 x Promat Cafco 300", result["notes"])

    def test_notes_that_resemble_excel_errors_are_literal_text(self):
        for notes in ("#N/A", "#VALUE! - awaiting site details", "#DIV/0! is a formula error"):
            result = calculate({"B8": 30, "B12": notes})
            self.assertEqual(result["errors"], {})
            self.assertTrue(result["notes"].startswith(notes + "\n\n---Materials---"))

    def test_masking_breakdown_preserves_excel_errors_and_old_snapshots(self):
        result = calculate({"B15": 1, "C15": 1e-307})
        self.assertEqual(result["masking"]["labour_total"], "#NUM!")
        self.assertEqual(result["masking"]["material_base_total"], "#NUM!")
        json.dumps(result, allow_nan=False)
        original = calculate({"B15": 35.75, "B26": 0.12, "B27": 0.25})
        expected = original.pop("masking")
        self.assertEqual(masking_breakdown(original), expected)

    def test_labour_days_follow_source_components_without_pinning_twice(self):
        self.assertEqual(specification()["formulas"]["F10"].strip(), "= SUM(B44,B53,C119)+0.5*C112")
        self.assertEqual(specification()["formulas"]["B44"], "=SUM(B41,B35,B36,B42,B43,B40,B38,B39)")
        for inputs in ({}, {"B15": 75, "B16": 120, "B18": 3, "B19": 12, "B20": 20, "B21": 20, "B22": 10, "B23": 5,
                           "B9": .2, "B27": .125, "F26": 2.75, "F27": 3,
                           **{team: "1 Team - 1x" for _, _, _, _, team in LINES if team}},
                       {"B15": 18.125, "B9": 0, "B27": -.25, "F26": 0, "F27": 0}):
            with self.subTest(inputs=inputs):
                result = calculate(inputs)
                cells, labour = result["cells"], result["labour"]
                self.assertEqual(len(labour["tasks"]), 8)
                self.assertNotIn("Pins / clips", [task["name"] for task in labour["tasks"]])
                self.assertTrue(math.isclose(sum(task["days"] for task in labour["tasks"]), cells["B44"], rel_tol=1e-12))
                self.assertEqual(labour["masking_days"], cells["B53"])
                self.assertEqual(labour["extra_days"], cells["C119"])
                self.assertEqual(labour["mobilisation_days"], .5*cells["C112"])
                self.assertEqual(labour["total_days"], cells["F10"])
                self.assertTrue(math.isclose(labour["task_days"]+labour["masking_days"]+labour["extra_days"]+labour["mobilisation_days"], cells["F10"], rel_tol=1e-12))
                self.assertNotEqual(labour["total_days"], cells["F2"])

    def test_labour_projection_preserves_errors_missing_cells_and_old_snapshots(self):
        for inputs in ({"C15": 0}, {"B15": 1, "C15": 1e-307, "B27": 1e12}):
            result = calculate(inputs)
            self.assertEqual(result["labour"]["total_days"], result["errors"]["F10"])
            self.assertEqual(result["labour"]["mobilisation_days"], result["errors"].get("C112", .5*result["cells"]["C112"] if isinstance(result["cells"]["C112"], (int,float)) else None))
        missing = {"cells": {"B35": 0, "C112": "", "F10": None}, "errors": {"B53": "#N/A"}}
        before = json.dumps(missing, sort_keys=True)
        projected = labour_breakdown(missing)
        self.assertEqual(projected["tasks"][0]["days"], 0)
        self.assertIsNone(projected["tasks"][1]["days"])
        self.assertIsNone(projected["task_days"])
        self.assertEqual(projected["masking_days"], "#N/A")
        self.assertEqual(projected["mobilisation_days"], "")
        self.assertIsNone(projected["total_days"])
        self.assertEqual(json.dumps(missing, sort_keys=True), before)
        self.assertEqual(labour_breakdown({"cells": {"C112": 0}, "errors": {"C112": "#NUM!"}})["mobilisation_days"], "#NUM!")
        original = calculate({"B15": 19.25, "F26": .75, "F27": 2})
        expected = original.pop("labour")
        before = json.dumps(original, sort_keys=True)
        self.assertEqual(labour_breakdown(original), expected)
        self.assertEqual(json.dumps(original, sort_keys=True), before)

    def test_labour_projection_reconciles_independent_excel_day_fixtures(self):
        fixture = json.loads((Path(__file__).parent / "fixtures" / "excel-calculator-oracle.json").read_text(encoding="utf-8-sig"))
        for scenario in fixture["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                cells = scenario["expected"]
                projected = labour_breakdown({"cells": cells})
                self.assertEqual(projected["total_days"], cells["F10"])
                if isinstance(cells["F10"], (int, float)):
                    subtotal = sum(task["days"] for task in projected["tasks"])
                    self.assertTrue(math.isclose(subtotal, cells["B44"], rel_tol=1e-12, abs_tol=1e-8))
                    total = subtotal + projected["masking_days"] + projected["extra_days"] + projected["mobilisation_days"]
                    self.assertTrue(math.isclose(total, cells["F10"], rel_tol=1e-12, abs_tol=1e-8))


class ExcelOracleTests(unittest.TestCase):
    def test_independently_recalculated_excel_scenarios(self):
        path = Path(__file__).parent / "fixtures" / "excel-calculator-oracle.json"
        # The checked-in fixture is required in CI and never generated by this engine.
        self.assertTrue(path.is_file(), "Missing independently recalculated Excel fixtures")
        oracle = json.loads(path.read_text(encoding="utf-8-sig"))
        data = baseline()
        source_index = {}
        for rows in data["rate_groups"].values():
            for rate in rows:
                for field in ("price", "yield"):
                    source = rate["source"].get(field)
                    if source:
                        source_index[source.replace("Lists!", "")] = (rate["id"], field)
        for scenario in oracle["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                configuration = {"rates": {}}
                for source, expected in scenario.get("lookupOverrides", {}).items():
                    rate_id, field = source_index[source.replace("Lists!", "")]
                    configuration["rates"].setdefault(rate_id, {})[field] = expected
                if scenario["id"] == "dropdown-D2-00":
                    # This source scenario has nonzero coverage with N/A labour.
                    # The user-requested entry rule now rejects it before formulas run.
                    self.assertEqual(scenario["inputs"]["D2"], "N/A")
                    self.assertNotEqual(scenario["inputs"]["B15"], 0)
                    with self.assertRaisesRegex(ValidationError, "^Select Teams$"):
                        calculate(scenario["inputs"], configuration)
                    continue
                actual = calculate(scenario["inputs"], configuration)
                # Reconcile the report's non-overlapping cost components to Excel,
                # using the independently captured workbook totals as the oracle.
                expected_cells = scenario["expected"]
                if isinstance(expected_cells["F7"], (int, float)):
                    c, masking = actual["cells"], actual["masking"]
                    labour = sum(c[f"F{row}"] for row in (65, 70, 79, 84, 89, 94, 99, 104)) + masking["labour_total"] + sum(c[f"D{row}"] for row in (112, 113, 119))
                    materials = sum(c[f"F{row}"] for row in (63, 68, 73, 77, 82, 87, 92, 97, 102)) + masking["material_base_total"] + masking["material_adjustment"] + c["D114"]
                    access = c["D115"] + c["D116"]
                    travel = c["D117"] + c["D118"]
                    for cell, amount in (("F2", labour), ("F3", materials), ("F4", access), ("F5", travel), ("F7", labour + materials + access + travel + c["D27"])):
                        self.assertTrue(math.isclose(amount, expected_cells[cell], rel_tol=1e-12, abs_tol=1e-8), (scenario["id"], cell, amount, expected_cells[cell]))
                for cell, expected in scenario["expected"].items():
                    with self.subTest(cell=cell):
                        result = actual["cells"].get(cell)
                        if isinstance(expected, (int, float)):
                            self.assertIsInstance(result, (int, float), f"{cell}: {result}, expected {expected}")
                            self.assertTrue(math.isclose(result, expected, rel_tol=1e-12, abs_tol=1e-8), f"{cell}: {result} != {expected}")
                        else:
                            self.assertEqual(result, expected, cell)


if __name__ == "__main__":
    unittest.main()
