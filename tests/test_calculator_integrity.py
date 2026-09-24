"""Strict integrity detection with bounded, actionable diagnostics."""

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import gzip
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.check_calculator_integrity import (
    audit_calculator, compare_catalogs, format_catalog_difference, main,
)


def catalog():
    return {"source": {"sha256": "a" * 64, "size": 100, "filename": "source.xlsx"},
            "styles": {"cell_styles": [{"locked": True}]},
            "sheets": [{"name": "SETTINGS", "cells": {
                "A1": {"value": "literal", "data_type": "str", "style": 1},
                "B1": {"formula": "1+1", "cached_value": 2, "data_type": "n", "style": 2},
            }, "rows": {"1": {"ht": "20"}}}], "pages": ["SETTINGS"]}


class CatalogDifferenceTests(unittest.TestCase):
    def test_equal_catalogs_match_without_mutation(self):
        expected = catalog()
        actual = deepcopy(expected)
        self.assertTrue(compare_catalogs(expected, actual)["matches"])
        self.assertEqual(expected, actual)

    def test_every_category_is_strict_including_source_cache_and_styles(self):
        expected = catalog()
        actual = deepcopy(expected)
        actual["source"]["sha256"] = "b" * 64
        actual["styles"]["cell_styles"][0]["locked"] = False
        actual["sheets"][0]["cells"]["B1"]["formula"] = "2+2"
        actual["sheets"][0]["cells"]["B1"]["cached_value"] = 4
        actual["sheets"][0]["cells"]["A1"]["value"] = "changed"
        actual["sheets"][0]["cells"]["A1"]["data_type"] = "n"
        actual["sheets"][0]["rows"]["1"]["ht"] = "30"
        result = compare_catalogs(expected, actual)
        self.assertFalse(result["matches"])
        self.assertFalse(result["extracted_content_matches"])
        self.assertEqual(result["difference_count"], 7)
        self.assertEqual(result["category_counts"], dict.fromkeys([
            "source_identity", "styles", "formula_text", "formula_caches",
            "literal_values", "data_types", "workbook_metadata"], 1))
        formula = result["category_samples"]["formula_text"][0]
        self.assertEqual(formula["path"], "/sheets/0/cells/B1/formula")
        self.assertEqual(formula["expected_sheet"], "SETTINGS")

    def test_formula_encoding_raw_literal_and_inventory_count_have_distinct_categories(self):
        expected = catalog()
        actual = deepcopy(expected)
        actual["counts"] = {"cells": 2}
        actual["sheets"][0]["cells"]["B1"]["formula_attributes"] = {"t": "shared", "si": "1"}
        actual["sheets"][0]["cells"]["A1"]["source_value"] = "literal "
        result = compare_catalogs(expected, actual, sample_limit=1)
        self.assertEqual(result["category_counts"], {
            "workbook_metadata": 1, "formula_attributes": 2, "source_literal_values": 1})
        self.assertNotIn("formula_text", result["category_counts"])
        self.assertNotIn("literal_values", result["category_counts"])
        # A category gets representative paths even when it follows the global cap.
        self.assertIn("/sheets/0/cells/B1/formula_attributes/si", format_catalog_difference(result))

    def test_provenance_only_difference_still_fails_strict_verdict(self):
        expected = catalog()
        for field, replacement in (("sha256", "changed"), ("size", 101), ("filename", "renamed.xlsx")):
            with self.subTest(field=field):
                actual = deepcopy(expected)
                actual["source"][field] = replacement
                result = compare_catalogs(expected, actual)
                self.assertFalse(result["matches"])
                self.assertTrue(result["extracted_content_matches"])
                self.assertFalse(result["source_provenance_matches"])

    def test_impact_summary_separates_formula_encoding_from_logic_and_editable_defaults(self):
        expected = {"id": "ductwork", "sheets": [{"name": "CALCULATOR", "cells": {
            "B11": {"value": "old"}, "J11": {"value": "fixed"},
            "K11": {"formula": "SUM('SUMMARY'!A1)"},
            "L11": {"formula": "1+1"},
        }}]}
        actual = deepcopy(expected)
        actual["sheets"][0]["cells"]["B11"]["value"] = "new"
        actual["sheets"][0]["cells"]["J11"]["value"] = "changed"
        actual["sheets"][0]["cells"]["K11"]["formula"] = "SUM(SUMMARY!A1)"
        actual["sheets"][0]["cells"]["L11"]["formula"] = "2+2"
        result = compare_catalogs(expected, actual)
        self.assertEqual(result["impact_counts"], {
            "editable_default_value_differences": 1,
            "fixed_literal_differences": 1,
            "formula_logic_differences": 1,
            "formula_optional_sheet_quote_differences": 1,
        })

    def test_added_removed_cells_null_empty_and_order_are_not_suppressed(self):
        expected = {"sheets": [{"name": "S", "cells": {"A1": {"value": None}, "B1": {"value": ""}}}],
                    "pages": ["A", "B"], "empty": {}}
        actual = {"sheets": [{"name": "S", "cells": {"C1": {"value": None}}}],
                  "pages": ["B", "A"], "empty": []}
        result = compare_catalogs(expected, actual)
        self.assertEqual(result["difference_count"], 6)
        self.assertEqual(result["category_counts"]["literal_values"], 3)
        self.assertEqual([item["path"] for item in result["samples"]], [
            "/empty", "/pages/0", "/pages/1", "/sheets/0/cells/A1/value",
            "/sheets/0/cells/B1/value", "/sheets/0/cells/C1/value"])
        self.assertEqual(result["samples"][-1]["actual"], {"type": "NoneType", "value": None})

    def test_boolean_number_and_numeric_type_differences_are_detected(self):
        for actual in (True, 1.0, "1"):
            with self.subTest(actual=actual):
                self.assertFalse(compare_catalogs({"value": 1}, {"value": actual})["matches"])

    def test_full_counts_continue_beyond_preview_limit_without_large_repr(self):
        expected = {"sheets": [{"name": "S", "cells": {f"A{i}": {"value": "x" * 10000} for i in range(1000)}}]}
        actual = {"sheets": [{"name": "S", "cells": {f"A{i}": {"value": "y" * 10000} for i in range(1000)}}]}
        result = compare_catalogs(expected, actual, sample_limit=2, value_limit=24)
        self.assertEqual(result["difference_count"], 1000)
        self.assertEqual(result["category_counts"], {"literal_values": 1000})
        self.assertEqual(len(result["samples"]), 2)
        self.assertEqual(result["omitted_samples"], 998)
        self.assertLess(len(format_catalog_difference(result)), 1500)
        self.assertTrue(result["samples"][0]["actual"]["truncated"])
        self.assertEqual(result["samples"][0]["actual"]["length"], 10000)
        self.assertEqual(compare_catalogs(expected, actual, sample_limit=0)["difference_count"], 1000)

    def test_paths_escape_json_pointer_keys_and_container_change_is_bounded(self):
        result = compare_catalogs({"a/b~c": {"nested": [1] * 10000}}, {"a/b~c": None})
        self.assertEqual(result["samples"][0]["path"], "/a~1b~0c")
        self.assertEqual(result["samples"][0]["expected"], {"type": "dict", "length": 1})


class IntegrityAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / "source.xlsx"
        self.source.write_bytes(b"read-only source fixture")
        self.package = self.directory / "frozen.json.gz"
        self.expected = catalog()
        self.expected["source"] = {"sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                                   "filename": self.source.name, "size": self.source.stat().st_size}
        with gzip.open(self.package, "wt", encoding="utf-8") as target:
            json.dump(self.expected, target)

    def test_byte_identity_and_exact_content_match_are_separate_and_read_only(self):
        before = self.source.read_bytes(), self.package.read_bytes()
        with patch("scripts.check_calculator_integrity.extract_calculator", return_value=deepcopy(self.expected)):
            result = audit_calculator("steel_board", self.source, self.package)
        self.assertTrue(result["matches"])
        self.assertTrue(result["byte_identity"]["matches"])
        self.assertTrue(result["source_unchanged_during_audit"])
        self.assertTrue(result["catalog_unchanged_during_audit"])
        self.assertEqual(before, (self.source.read_bytes(), self.package.read_bytes()))
        self.source.write_bytes(b"different ZIP bytes, same extracted content")
        actual = deepcopy(self.expected)
        actual["source"]["sha256"] = hashlib.sha256(self.source.read_bytes()).hexdigest()
        actual["source"]["size"] = self.source.stat().st_size
        with patch("scripts.check_calculator_integrity.extract_calculator", return_value=actual):
            result = audit_calculator("steel_board", self.source, self.package)
        self.assertFalse(result["matches"])
        self.assertFalse(result["byte_identity"]["matches"])
        self.assertTrue(result["extracted_content_matches"])

    def test_source_or_catalog_change_during_extraction_is_failure(self):
        for target in (self.source, self.package):
            with self.subTest(target=target.name):
                original = target.read_bytes()
                def altered(*_):
                    target.write_bytes(original + b"changed by another process")
                    return deepcopy(self.expected)
                with patch("scripts.check_calculator_integrity.extract_calculator", side_effect=altered):
                    result = audit_calculator("steel_board", self.source, self.package)
                self.assertFalse(result["matches"])
                self.assertIn("changed while", result["errors"][0])
                target.write_bytes(original)

    def test_missing_or_broken_source_reports_error_instead_of_matching(self):
        result = audit_calculator("steel_board", self.directory / "absent.xlsx", self.package)
        self.assertFalse(result["matches"])
        self.assertIn("FileNotFoundError", result["errors"][0])
        with patch("scripts.check_calculator_integrity.extract_calculator", side_effect=ValueError("bad XML")):
            result = audit_calculator("steel_board", self.source, self.package)
        self.assertFalse(result["matches"])
        self.assertIn("ValueError: bad XML", result["errors"])
        self.assertTrue(result["source_unchanged_during_audit"])

    def test_cli_audits_all_three_json_report_and_nonzero_on_any_failure(self):
        for fail in (False, True):
            with self.subTest(fail=fail), patch("scripts.check_calculator_integrity.audit_calculator") as audit:
                audit.side_effect = [dict(id=identifier, matches=not (fail and index == 1), errors=[],
                                          difference_count=int(fail and index == 1), category_counts={})
                                     for index, identifier in enumerate(("steel_vermiculite", "ductwork", "steel_board"))]
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    status = main(["--source-directory", str(self.directory), "--source", f"steel_board={self.source}"])
                self.assertEqual(status, int(fail))
                report = json.loads(stdout.getvalue())
                self.assertEqual(len(report["calculators"]), 3)
                self.assertEqual(report["matches"], not fail)
                self.assertEqual(audit.call_args_list[-1].args[1], self.source)
                self.assertIn("Auditing steel_vermiculite", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
