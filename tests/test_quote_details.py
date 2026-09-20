from copy import deepcopy
import re
import unittest
from unittest.mock import patch

from estimator.calculator import calculate
from estimator.catalog import ValidationError, baseline
from estimator.presentation import ADDITION_NAMES, MATERIAL_NAMES
from estimator.quote_details import compile_work_summary, compose_quote_title, validate_quote_details
from estimator.storage import WORKFLOWS


class QuoteIdentityTests(unittest.TestCase):
    def test_complete_partial_and_empty_titles_use_requested_order_and_separator(self):
        self.assertEqual(compose_quote_title(" P-123 ", " Client Ltd ", " 8 Road "), "P-123- Client Ltd- 8 Road")
        self.assertEqual(compose_quote_title(client="Client Ltd", site_address="8 Road"), "Client Ltd- 8 Road")
        self.assertEqual(compose_quote_title(project_no="P-123", site_address="8 Road"), "P-123- 8 Road")
        self.assertEqual(compose_quote_title(site_address="8 Road"), "8 Road")
        self.assertEqual(compose_quote_title(), "Untitled quote")
        self.assertEqual(compose_quote_title(fallback=" Legacy title "), "Legacy title")
        self.assertEqual(compose_quote_title(fallback=" "), "Untitled quote")

    def test_metadata_preserves_omitted_fields_and_explicit_empty_clears(self):
        previous = {"client": "Original client", "site_address": "Original site", "project_no": "P-1", "title": "Old"}
        self.assertEqual(validate_quote_details({"client": " New client "}, previous),
                         {"client": "New client", "site_address": "Original site", "project_no": "P-1"})
        self.assertEqual(validate_quote_details({"site_address": " "}, previous),
                         {"client": "Original client", "site_address": "", "project_no": "P-1"})
        self.assertEqual(validate_quote_details({}), {"client": "", "site_address": "", "project_no": ""})
        self.assertEqual(previous["site_address"], "Original site")

    def test_bounds_unicode_and_invalid_metadata(self):
        self.assertEqual(len(compose_quote_title("P" * 100, "C" * 200, "S" * 400)), 704)
        self.assertEqual(validate_quote_details({"client": "Café 中文"})["client"], "Café 中文")
        for field, limit in (("project_no", 100), ("client", 200), ("site_address", 400)):
            for invalid in (None, True, 12, {}, "x" * (limit + 1), "line\nbreak", "tab\tstop", "null\0", "delete\x7f", "c1\x85", "\ud800"):
                with self.subTest(field=field, invalid=repr(invalid)), self.assertRaises(ValidationError):
                    validate_quote_details({field: invalid})
        with self.assertRaises(ValidationError):
            validate_quote_details([])


class WorkSummaryTests(unittest.TestCase):
    def test_workflow_and_active_products_update_without_recalculating_or_mutating_snapshot(self):
        result = calculate({"B15": 12.5})
        before = deepcopy(result)
        for workflow in WORKFLOWS:
            with self.subTest(workflow=workflow), patch("estimator.calculator.calculate", side_effect=AssertionError("must not calculate")):
                text = compile_work_summary(workflow, result)
            self.assertTrue(text.startswith("Workflow: " + workflow + "."))
            self.assertIn("Spray / wrap: Promat Cafco 300", text)
            self.assertIn("quantity 12.50 bags / drums / rolls", text)
            self.assertIn("Daily output 30.00 units/day", text)
            self.assertIn("labour 1 Team - 1x", text)
            self.assertNotIn("Board:", text)
        self.assertEqual(result, before)
        changed = calculate({"B15": 12.5, "D15": baseline()["rate_groups"]["sprays"][2]["name"]})
        self.assertNotEqual(compile_work_summary(WORKFLOWS[0], changed), compile_work_summary(WORKFLOWS[0], result))

    def test_active_materials_masking_additions_and_adjustments_are_described(self):
        data = baseline()
        inputs = {"B8": 30, **{f"B{row}": 10 for row in range(15, 24)}}
        inputs.update({f'D{row}': '1 Team - 1x' for row in range(2, 11)})
        selection_groups = {"B2": "access_hire", "B3": "freight_rates", "B5": "freight_rates",
                            "B6": "LAFHA_rates", "B7": "travel_rates"}
        inputs.update({cell: next(rate["name"] for rate in data["rate_groups"][group] if rate["name"] != "N/A")
                       for cell, group in selection_groups.items()})
        inputs.update({"B26": .1, "B27": .2, "B28": 30.25, "B4": 2, "F26": 1.5})
        result = calculate(inputs)
        self.assertEqual(result["errors"], {})
        text = compile_work_summary(WORKFLOWS[1], result)
        for label in MATERIAL_NAMES + ADDITION_NAMES:
            self.assertIn(label + ":", text)
        self.assertIn("Masking / cleaning:", text)
        self.assertIn("masking material adjustment", text)
        self.assertIn("global material adjustment 10.00%", text)
        self.assertIn("global labour adjustment 20.00%", text)
        self.assertIn("fixed adjustment $30.25", text)
        self.assertIn("Access quantity: 2.00", text)
        self.assertIn("Pinning follows meshing labour", text)
        self.assertNotRegex(text, r"Calculator!|\b[ABCDEF](?:[1-9]|[1-9][0-9]|1[012][0-9])\b")

    def test_generated_numbers_use_two_decimal_half_up_format_without_changing_values(self):
        result = calculate({"B15": 10.125, "E15": .02675, "B26": .123456, "B28": -2.675})
        before = deepcopy(result)
        text = compile_work_summary(WORKFLOWS[0], result)
        self.assertIn("quantity 10.13", text)
        self.assertIn("wastage 2.68%", text)
        self.assertIn("unit sell rate $71.88", text)
        self.assertIn("global material adjustment 12.35%", text)
        self.assertIn("fixed adjustment $-2.68", text)
        self.assertIsNone(re.search(r"\d+\.\d{3,}", text))
        self.assertEqual(result, before)
        large = deepcopy(result)
        large["cells"]["F7"] = 1.234567890123456e45
        self.assertNotIn("e+", compile_work_summary(WORKFLOWS[0], large))
        self.assertIn(".00", compile_work_summary(WORKFLOWS[0], large))

    def test_zero_blank_missing_and_error_values_do_not_fabricate_work_or_totals(self):
        zero = calculate({"B15": None, "F26": 0, "F27": 0, "F28": 0, "B9": ""})
        text = compile_work_summary("", zero)
        self.assertIn("No active material quantities entered.", text)
        self.assertNotIn("Spray / wrap:", text)
        self.assertNotIn("Masking / cleaning:", text)
        self.assertNotIn("Extra labour:", text)
        self.assertIn("quote total $0.00", text)
        error = calculate({"B15": 10, "C15": 0})
        error_before = deepcopy(error)
        text = compile_work_summary(WORKFLOWS[0], error)
        self.assertIn("Daily output 0.00", text)
        self.assertIn("quote total unavailable (#DIV/0!)", text)
        self.assertIn("Review the calculation errors", text)
        self.assertEqual(error, error_before)
        self.assertIn("not entered", compile_work_summary(None, {}))

    def test_selected_options_and_literal_product_text_remain_in_summary(self):
        result = calculate({"B15": 4, "B2": "N/A"})
        changed = deepcopy(result)
        changed["inputs"]["D15"] = "Product <literal> 2.3456mm"
        changed["inputs"]["B2"] = "Selected access equipment"
        text = compile_work_summary(WORKFLOWS[0], changed)
        self.assertIn("Product <literal> 2.3456mm", text)
        self.assertIn("Access hire: Selected access equipment", text)
        self.assertNotIn("Selected access equipment", compile_work_summary(WORKFLOWS[0], result))


if __name__ == "__main__":
    unittest.main()
