"""Reviewed yield overlays checked against retained native Microsoft Excel values.

The capture is deliberately separate from original-default parity fixtures.
No runtime defaults are applied to the source graph, and no expected result is
created by the application engine.
"""

import gzip
import hashlib
import json
from pathlib import Path
import unittest

from estimator.excel_engine import WorkbookEngine
from estimator.workbook_calculators import source_model
from tests.test_workbook_parity import excel_equal, scenario_inputs


FIXTURE_DIRECTORY = Path(__file__).resolve().parent / "fixtures" / "calculators"
FIXTURE_NAME = "steel_vermiculite-reviewed-yields.json.gz"
YIELD_CELLS = ("D40", "D73", "D105", "D182", "D238")
SCENARIOS = (
    "original_defaults_checkpoint", "reviewed_direct_all_products",
    "reviewed_equivalent_density_fallback", "explicit_user_yield_and_waste_override",
    "invalid_direct_or_fallback_inputs",
)


def read_capture():
    return json.loads(gzip.decompress((FIXTURE_DIRECTORY / FIXTURE_NAME).read_bytes()).decode("utf-8-sig"))


class ReviewedYieldFixtureTests(unittest.TestCase):
    def test_native_capture_integrity_provenance_and_coverage(self):
        payload = (FIXTURE_DIRECTORY / FIXTURE_NAME).read_bytes()
        raw = gzip.decompress(payload)
        manifest = json.loads((FIXTURE_DIRECTORY / "steel_vermiculite-reviewed-yields.meta.json").read_text(encoding="utf-8"))
        capture = json.loads(raw.decode("utf-8-sig"))
        self.assertEqual(hashlib.sha256(payload).hexdigest(), manifest["gzip_sha256"])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), manifest["capture_sha256"])
        self.assertEqual(capture["source_sha256"], source_model("steel_vermiculite")["source"]["sha256"])
        self.assertEqual(capture["source_sha256"], manifest["source_sha256"])
        self.assertEqual(capture["oracle"]["application"], "Microsoft Excel")
        for field in ("version", "build", "captured_utc"):
            self.assertTrue(capture["oracle"][field])
        self.assertEqual(tuple(scenario["id"] for scenario in capture["scenarios"]), SCENARIOS)
        count = sum(len(cells) for scenario in capture["scenarios"] for cells in scenario["expected"].values())
        self.assertEqual(count, 6565)
        self.assertEqual(count, manifest["outputs"])
        for scenario in capture["scenarios"]:
            self.assertFalse(scenario["formula_overrides"])
            self.assertTrue(set(YIELD_CELLS).issubset(scenario["expected"]["SETTINGS"]))
            self.assertTrue({f"G{row}" for row in range(20, 25)}.issubset(scenario["expected"]["BAGS"]))
        original = capture["scenarios"][0]
        self.assertFalse(original["inputs"])
        self.assertFalse(original["input_blocks"])

    def test_native_cases_demonstrate_fallback_override_precision_and_pooled_rows(self):
        scenarios = {entry["id"]: entry for entry in read_capture()["scenarios"]}
        direct = scenarios["reviewed_direct_all_products"]
        fallback = scenarios["reviewed_equivalent_density_fallback"]
        override = scenarios["explicit_user_yield_and_waste_override"]
        invalid = scenarios["invalid_direct_or_fallback_inputs"]
        direct_cells = ("D37", "D70", "D102", "D179", "D235")
        for yield_cell, direct_cell in zip(YIELD_CELLS, direct_cells):
            self.assertTrue(excel_equal(direct["expected"]["SETTINGS"][yield_cell],
                                        fallback["expected"]["SETTINGS"][yield_cell]))
            self.assertIsNone(fallback["inputs"]["SETTINGS"][direct_cell])
            self.assertEqual(override["expected"]["SETTINGS"][yield_cell],
                             override["inputs"]["SETTINGS"][direct_cell])
            self.assertNotEqual(override["expected"]["SETTINGS"][yield_cell],
                                round(override["expected"]["SETTINGS"][yield_cell], 2))
            self.assertEqual(invalid["expected"]["SETTINGS"][yield_cell], "")
        # Each product has multiple active lines, so product totals exercise
        # the pooled purchasing calculation rather than a single-row shortcut.
        for row in range(20, 25):
            self.assertGreaterEqual(direct["expected"]["BAGS"][f"B{row}"], 2)
            self.assertGreater(direct["expected"]["BAGS"][f"E{row}"], 0)
            self.assertGreaterEqual(direct["expected"]["BAGS"][f"G{row}"], 1)
        for row in range(10, 20):
            self.assertEqual(direct["expected"]["SCHEDULE"][f"W{row}"], "QUANTIFIED - ESTIMATE")
        self.assertEqual(direct["expected"]["SCHEDULE"]["W1009"], "QUANTIFIED - ESTIMATE")
        self.assertEqual(direct["expected"]["SCHEDULE"]["W20"], "")


class ReviewedYieldNativeParityTests(unittest.TestCase):
    def test_all_reviewed_yield_scenarios_match_native_excel(self):
        model = source_model("steel_vermiculite")
        for scenario in read_capture()["scenarios"]:
            with self.subTest(scenario=scenario["id"]):
                engine = WorkbookEngine(model, scenario_inputs(scenario), scenario["formula_overrides"])
                mismatches = []
                for sheet, cells in scenario["expected"].items():
                    for address, expected in cells.items():
                        try:
                            actual = engine.value(sheet, address)
                            if not excel_equal(actual, expected):
                                mismatches.append((sheet, address, expected, actual))
                        except Exception as error:
                            mismatches.append((sheet, address, expected, repr(error)))
                self.assertFalse(mismatches, f"{len(mismatches)} native Excel discrepancies: {mismatches[:20]!r}")


if __name__ == "__main__":
    unittest.main()
