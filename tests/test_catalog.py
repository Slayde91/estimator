"""Inventory/cache provenance and linked configuration regression checks."""

from copy import deepcopy
import json
import os
from pathlib import Path
import unittest

from estimator.catalog import baseline, effective_catalog, validate_configuration, ValidationError
from estimator.calculator import calculate
from scripts.import_workbooks import extract, extract_calculator, translate_shared_formula


GROUP_COUNTS = {
    "access_hire": 13, "labour_rates": 27, "masking_rates": 3, "freight_rates": 13,
    "LAFHA_rates": 2, "travel_rates": 8, "access_panels": 6, "mesh": 3, "pins": 2,
    "sprays": 30, "boards": 33, "mastic": 13, "primers": 7, "topcoats": 6,
}


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.data = baseline()
        self.inventory = {item["id"]: item for item in self.data["inventory"]}

    def test_complete_imported_source_and_list_counts(self):
        self.assertEqual(len(self.data["inventory"]), 417)
        self.assertEqual(len(self.inventory), 417)
        self.assertEqual([item["source"]["row"] for item in self.data["inventory"]], list(range(2, 419)))
        self.assertEqual({name: len(rows) for name, rows in self.data["rate_groups"].items()}, GROUP_COUNTS)
        self.assertEqual(sum(item["pricing_mode"] == "supplier_markup" for item in self.inventory.values()), 377)
        self.assertEqual(self.data["markup"], 0.3)
        self.assertEqual(self.data["sources"]["inventory"]["sha256"], "1da308509611a8c099c62d29acc310d3d39ec6a84176e895f39e8711eba720e1")
        self.assertEqual(self.data["sources"]["quote"]["sha256"], "97fd43c4e55d3744e4348bf3596a3ab2a67357f12891524bfdb115f43b45c1a0")

    def test_critical_prices_and_units_preserve_exact_excel_values(self):
        cafco = self.inventory["200"]
        self.assertEqual((cafco["supplier_price"], cafco["sales_price"], cafco["properties"]["weight"]), (55.29, 71.877, 20))
        self.assertEqual(cafco["source"]["cells"]["sales_price"], "H35")
        board = self.inventory["239"]
        self.assertEqual(board["sales_price"], 213.12199999999999)
        self.assertEqual(board["calculated_sell_price"], 213.122)
        self.assertEqual(board["properties"]["sqm"], 0.75)
        self.assertEqual(self.inventory["915"]["sales_price"], 2080)
        self.assertIsNone(self.inventory["915"]["supplier_price"])

    def test_every_rate_is_linked_to_exact_inventory_price_and_yield(self):
        yield_properties = {"U": "sqm", "W": "metres_per_tube", "X": "sqm_per_box", "Y": "sqm_per_drum"}
        for group, rows in self.data["rate_groups"].items():
            rule = self.data["rate_group_rules"][group]
            field = "name" if rule["name_column"] == "B" else "sales_description"
            for rate in rows:
                with self.subTest(group=group, rate=rate["id"]):
                    linked = self.inventory[rate["inventory_id"]]
                    self.assertEqual(rate["name"], linked[field])
                    self.assertEqual(rate["price"], linked["sales_price"])
                    self.assertEqual(rate["source"]["inventory_price"], f"INVENTORY!H{linked['source']['row']}")
                    if rule["yield_column"]:
                        expected = linked["properties"][yield_properties[rule["yield_column"]]]
                        if expected is None or (rule["yield_column"] in {"U", "W", "Y"} and expected == 0):
                            expected = ""
                        self.assertEqual(rate["yield"], expected)

    def test_all_filtered_choices_preserve_source_order_and_no_extra_na(self):
        for group, rule in self.data["rate_group_rules"].items():
            field = "name" if rule["name_column"] == "B" else "sales_description"
            expected = [item[field] for item in self.data["inventory"] if any(k.casefold() in item[field].casefold() for k in rule["keywords"])]
            self.assertEqual([r["name"] for r in self.data["rate_groups"][group]], expected)
        for group in ("boards", "mastic", "primers", "topcoats"):
            self.assertNotIn("N/A", [r["name"] for r in self.data["rate_groups"][group]])

    def test_unmodified_catalog_keeps_exact_prices_and_dropdown_text(self):
        result = effective_catalog(data=self.data)
        for group, rows in self.data["rate_groups"].items():
            for original, current in zip(rows, result["rate_groups"][group]):
                self.assertEqual(current["price"], original["price"])
                self.assertEqual(current["yield"], original["yield"])
                self.assertEqual(current.get("display_name", current["name"]), original["name"])

    def test_empty_text_yields_remain_distinct_from_missing_yield_columns(self):
        self.assertEqual(self.data["rate_groups"]["mesh"][0]["yield"], "")
        self.assertEqual(self.data["rate_groups"]["pins"][0]["yield"], "")
        self.assertEqual(self.data["rate_groups"]["mastic"][2]["yield"], "")
        self.assertIsNone(self.data["rate_groups"]["sprays"][0]["yield"])
        self.assertEqual(self.inventory["915"]["calculated_sell_price"], "")


class CalculatorSourceTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / "data" / "calculator.json"
        self.data = json.loads(path.read_text(encoding="utf-8"))

    def test_all_64_unlocked_inputs_and_151_formulas_present(self):
        expected = {f"B{r}" for r in range(2, 11)} | {f"D{r}" for r in range(2, 11)} | {"B12"}
        expected |= {f"{c}{r}" for r in range(15, 24) for c in "BCDE"}
        expected |= {f"{c}{r}" for r in range(26, 29) for c in "BEF"}
        self.assertEqual({field["cell"] for field in self.data["fields"]}, expected)
        self.assertEqual(len(self.data["fields"]), 64)
        self.assertEqual(len(self.data["formulas"]), 151)
        self.assertEqual(set(self.data["formulas"]), set(self.data["cached"]))
        self.assertFalse(expected & set(self.data["formulas"]))
        self.assertEqual(self.data["cached"]["F7"], 1260)
        self.assertEqual(self.data["cached"]["F8"], 42)
        self.assertEqual(self.data["formulas"]["B39"], "=(D39/C19)*(1+global_labour)")

    def test_unicode_labels_and_defaults_match_inventory_dropdown_keys(self):
        fields = {field["cell"]: field for field in self.data["fields"]}
        inventory = baseline()
        self.assertEqual(fields["D20"]["default"], "Luxepoxy 4 (4L- 50\u00b5m) Primer")
        self.assertEqual(fields["B16"]["label"], "Meshing coverage(M\u00b2)")
        self.assertEqual(fields["D20"]["default"], inventory["rate_groups"]["primers"][3]["name"])
        self.assertEqual(fields["D21"]["default"], inventory["rate_groups"]["topcoats"][3]["name"])
        self.assertEqual(fields["B9"]["format"], "percent")
        self.assertEqual(fields["B12"]["type"], "text")
        self.assertEqual(sum(field["type"] == "select" for field in fields.values()), 27)

    def test_shared_formula_translation_preserves_absolute_references_and_strings(self):
        formula = 'SUM(A1,$B2,C$3,$D$4,"A1",\'Sheet A1\'!E5,global_material)'
        self.assertEqual(translate_shared_formula(formula, "A1", "C3"), 'SUM(C3,$B4,E$3,$D$4,"A1",\'Sheet A1\'!G7,global_material)')


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.data = baseline()

    def test_supplier_and_markup_changes_update_every_linked_category(self):
        result = effective_catalog({"inventory": {"204": {"supplier_price": 300, "markup": 0.2}}}, self.data)
        item = next(r for r in result["inventory"] if r["id"] == "204")
        self.assertEqual(item["sales_price"], 360)
        self.assertEqual(item["calculated_sell_price"], 360)
        for group in ("primers", "topcoats"):
            self.assertEqual(result["rate_groups"][group][0]["price"], 360)
            self.assertEqual(result["rate_groups"][group][0]["yield"], 142)
        self.assertEqual(self.data["rate_groups"]["primers"][0]["price"], 384.93)

    def test_supplier_only_markup_only_zero_and_decimal_updates(self):
        cases = [({"supplier_price": 100}, 130), ({"markup": 0}, 55.29), ({"markup": 0.125}, 55.29 * 1.125), ({"supplier_price": 0}, 0)]
        for patch, expected in cases:
            with self.subTest(patch=patch):
                result = effective_catalog({"inventory": {"200": patch}}, self.data)
                self.assertEqual(result["rate_groups"]["sprays"][1]["price"], expected)

    def test_manual_labour_price_override(self):
        result = effective_catalog({"inventory": {"915": {"sales_price": 2345.67}}}, self.data)
        self.assertEqual(result["rate_groups"]["labour_rates"][3]["price"], 2345.67)
        self.assertEqual(result["rate_groups"]["labour_rates"][4]["price"], 3680)

    def test_explicit_rate_override_takes_precedence_and_is_local(self):
        result = effective_catalog({"inventory": {"204": {"supplier_price": 300}}, "rates": {"primers:1": {"price": 401.25, "yield": 155.5}}}, self.data)
        self.assertEqual(result["rate_groups"]["primers"][0]["price"], 401.25)
        self.assertEqual(result["rate_groups"]["primers"][0]["yield"], 155.5)
        self.assertEqual(result["rate_groups"]["topcoats"][0]["price"], 390)
        self.assertEqual(result["rate_groups"]["topcoats"][0]["yield"], 142)

    def test_blank_and_empty_text_yield_overrides_keep_distinct_excel_errors(self):
        inputs = {"D16": "Promat Promamesh", "B16": 10}
        physical_blank = calculate(inputs, {"rates": {"mesh:2": {"yield": None}}})
        empty_text = calculate(inputs, {"rates": {"mesh:2": {"yield": ""}}})
        self.assertEqual(physical_blank["cells"]["F16"], 0)
        self.assertEqual(physical_blank["cells"]["B68"], "#DIV/0!")
        self.assertEqual(empty_text["cells"]["F16"], "")
        self.assertEqual(empty_text["cells"]["B68"], "#VALUE!")

    def test_original_baseline_and_configuration_are_immutable(self):
        original = deepcopy(self.data)
        config = {"inventory": {"200": {"supplier_price": 99}}, "rates": {"boards:1": {"yield": 1.25}}}
        config_before = deepcopy(config)
        modified = effective_catalog(config, self.data)
        modified["inventory"][0]["name"] = "Changed outside calculation"
        self.assertEqual(self.data, original)
        self.assertEqual(config, config_before)
        self.assertEqual(baseline(), original)

    def test_edited_names_follow_source_column_without_changing_selection_keys(self):
        result = effective_catalog({"inventory": {"204": {"name": "Inventory label", "sales_description": "New coating description"}, "200": {"name": "Cafco renamed"}}}, self.data)
        self.assertEqual(result["rate_groups"]["primers"][0]["display_name"], "New coating description")
        self.assertEqual(result["rate_groups"]["topcoats"][0]["name"], "20kg SBR Latex - Promat")
        self.assertEqual(result["rate_groups"]["sprays"][1]["display_name"], "Cafco renamed")
        self.assertEqual(result["rate_groups"]["sprays"][1]["name"], "Promat Cafco 300")

    def test_unknown_fields_invalid_types_and_nonfinite_values_rejected(self):
        invalid = [None, [], {"extra": {}}, {"inventory": []}, {"inventory": {"missing": {}}},
            {"rates": {"unknown:1": {"price": 1}}}, {"inventory": {"200": {"unknown": 1}}},
            {"inventory": {"200": {"supplier_price": True}}}, {"inventory": {"200": {"markup": "30%"}}},
            {"inventory": {"200": {"name": "  "}}}, {"inventory": {"200": {"name": "a" * 1001}}},
            {"inventory": {"915": {"supplier_price": 10}}}, {"inventory": {"915": {"markup": 0.5}}},
            {"inventory": {"200": {"sales_price": 20}}},
            {"rates": {"mesh:2": {"yield": -1}}}]
        invalid.extend({"inventory": {"200": {"supplier_price": number}}} for number in (float("nan"), float("inf"), -float("inf"), -1, 1e13))
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValidationError):
                validate_configuration(config, self.data)


@unittest.skipUnless(os.environ.get("ESTIMATOR_WORKBOOK_DIR"), "Set ESTIMATOR_WORKBOOK_DIR to verify original workbook extraction")
class OriginalWorkbookExtractionTests(unittest.TestCase):
    def test_reproducible_baseline_matches_original_workbooks(self):
        root = Path(os.environ["ESTIMATOR_WORKBOOK_DIR"])
        regenerated = extract(root / "Inventory_list.xlsm", root / "Quote.xlsm")
        self.assertEqual(regenerated, baseline())

    def test_reproducible_calculator_matches_original_workbook(self):
        root = Path(os.environ["ESTIMATOR_WORKBOOK_DIR"])
        regenerated = extract_calculator(root / "Quote.xlsm")
        path = Path(__file__).resolve().parents[1] / "data" / "calculator.json"
        self.assertEqual(regenerated, json.loads(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
