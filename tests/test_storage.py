from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import baseline, effective_catalog, ValidationError
from estimator.storage import Store


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "quotes.sqlite3")

    def test_quote_pricing_is_frozen_across_settings_changes_and_restart(self):
        original = self.store.save_quote({"title": "Duct quote", "inputs": {"B15": 10}})
        rate = baseline()["rate_groups"]["sprays"][1]
        self.store.save_configuration({"rates": {rate["id"]: {"price": 999}}})
        reopened = Store(self.store.path)
        stored = reopened.quote(original["id"])
        self.assertEqual(stored, original)
        new = reopened.save_quote({"title": "New pricing", "inputs": {"B15": 10}})
        self.assertNotEqual(new["result"]["summary"]["total"], original["result"]["summary"]["total"])
        updated = reopened.save_quote({"title": "Original revision", "inputs": original["inputs"]}, original["id"])
        self.assertEqual(updated["result"]["summary"]["total"], original["result"]["summary"]["total"])
        self.assertEqual(len(reopened.list_quotes()), 2)

    def test_invalid_updates_are_atomic_and_unknown_quote_is_not_created(self):
        before = self.store.configuration()
        with self.assertRaises(ValidationError):
            self.store.save_configuration({"rates": {"missing": {"price": 10}}})
        self.assertEqual(self.store.configuration(), before)
        with self.assertRaises(KeyError):
            self.store.save_quote({"title": "Unknown"}, "missing")
        self.assertEqual(self.store.list_quotes(), [])

    def test_quote_also_freezes_imported_default_lookup_prices(self):
        from estimator.calculator import calculate
        quote = self.store.save_quote({"title": "Frozen workbook defaults", "inputs": {"B15": 10}})
        changed = baseline()
        for rate in changed["rate_groups"]["sprays"]:
            rate["price"] *= 2
        with patch("estimator.catalog.baseline", return_value=changed):
            reopened = calculate(quote["inputs"], quote["configuration"])
        self.assertEqual(reopened["summary"], quote["result"]["summary"])

    def test_catalogue_reordering_cannot_reinterpret_a_saved_rate_id(self):
        from estimator.calculator import calculate
        quote = self.store.save_quote({"title": "Stable identities", "inputs": {"B15": 10}})
        changed = baseline()
        changed["rate_groups"]["sprays"][1]["name"] = "A different product"
        with patch("estimator.catalog.baseline", return_value=changed):
            recalculated = calculate(quote["inputs"], quote["configuration"])
            self.assertEqual(recalculated, quote["result"])
            # Older records have no embedded catalog. Keep their original guard
            # rather than silently reinterpreting positional IDs after a change.
            legacy_configuration = deepcopy(quote["configuration"])
            del legacy_configuration["catalog"]
            with self.assertRaisesRegex(ValidationError, "catalogue structure"):
                calculate(quote["inputs"], legacy_configuration)
        self.assertEqual(self.store.quote(quote["id"])["result"], quote["result"])

    def test_resaving_with_original_pricing_retains_original_source_hashes(self):
        quote = self.store.save_quote({"title": "Source lineage", "inputs": {"B15": 10}})
        changed = baseline()
        changed["sources"]["quote"]["sha256"] = "later-source-hash"
        with patch("estimator.catalog.baseline", return_value=changed):
            revised = self.store.save_quote({"title": "Revised inputs", "inputs": {"B15": 12}}, quote["id"])
        self.assertEqual(revised["source_hashes"], quote["source_hashes"])

    def replacement(self):
        replacement = baseline()
        replacement["inventory"] = [r for r in replacement["inventory"] if r["id"] != "200"]
        for group, rows in replacement["rate_groups"].items():
            replacement["rate_groups"][group] = [r for r in rows if r["inventory_id"] != "200"]
        replacement["inventory"].append({"id": "replacement-spray", "name": "Replacement spray",
                                         "sales_description": "Replacement spray", "supplier_price": 60,
                                         "markup": 0.5, "sales_price": 90, "pricing_mode": "supplier_markup"})
        replacement["rate_groups"]["sprays"].append({"id": "sprays:replacement", "name": "Replacement spray",
                                                   "price": 90, "yield": None, "inventory_id": "replacement-spray"})
        replacement["sources"]["pricing_import"] = {"filename": "Updated prices.xlsx", "sha256": "1" * 64}
        return {"catalog": replacement, "inventory": {}, "rates": {}}

    def test_library_replacement_survives_restart_and_does_not_rewrite_saved_quotes(self):
        original = self.store.save_quote({"title": "Original products", "inputs": {"B15": 10}})
        replacement = self.replacement()
        self.assertEqual(len(self.store.configuration().get("catalog", {}).get("inventory", [])), 0)
        saved_configuration = self.store.save_configuration(replacement)
        restarted = Store(self.store.path)
        self.assertEqual(restarted.configuration(), saved_configuration)
        self.assertEqual(restarted.quote(original["id"]), original)
        updated = restarted.save_quote({"title": "Same quote", "inputs": original["inputs"]}, original["id"])
        self.assertEqual(updated["result"], original["result"])
        self.assertEqual(updated["source_hashes"], original["source_hashes"])
        self.assertIn("200", [r["id"] for r in updated["configuration"]["catalog"]["inventory"]])
        new = restarted.save_quote({"title": "Imported products", "inputs": {"B15": 10, "D15": "Replacement spray"}})
        self.assertEqual(new["result"]["cells"]["A63"], 90)
        self.assertEqual(new["source_hashes"], replacement["catalog"]["sources"])
        self.assertNotIn("200", [r["id"] for r in new["configuration"]["catalog"]["inventory"]])
        self.assertEqual(len(restarted.list_quotes()), 2)

    def test_explicit_repricing_uses_replacement_and_marks_removed_selections(self):
        original = self.store.save_quote({"title": "To reprice", "inputs": {"B15": 10}})
        current = self.store.save_configuration(self.replacement())
        removed = self.store.prepare_quote({"title": original["title"], "inputs": original["inputs"],
                                           "configuration": current}, original["id"])
        self.assertIsNone(removed["result"]["summary"]["total"])
        self.assertEqual(removed["result"]["errors"]["A63"], "#N/A")
        updated = self.store.save_quote({"title": original["title"], "inputs": {**original["inputs"], "D15": "Replacement spray"},
                                        "configuration": current}, original["id"])
        self.assertEqual(updated["result"]["cells"]["A63"], 90)
        self.assertEqual(updated["source_hashes"], current["catalog"]["sources"])

    def test_legacy_snapshot_uses_original_library_after_a_replacement(self):
        original = self.store.save_quote({"title": "Older saved quote", "inputs": {"B15": 10}})
        del original["configuration"]["catalog"]
        with self.store.connect() as db:
            db.execute("UPDATE quotes SET data=? WHERE id=?", (json.dumps(original), original["id"]))
        self.store.save_configuration(self.replacement())
        self.assertEqual(self.store.quote(original["id"]), original)
        revised = self.store.save_quote({"title": "Older quote revised", "inputs": original["inputs"]}, original["id"])
        self.assertEqual(revised["result"], original["result"])
        self.assertEqual(revised["source_hashes"], original["source_hashes"])
        self.assertIn("catalog", revised["configuration"])

    def test_imported_yields_and_explicit_rate_mode_are_frozen_in_saved_quote(self):
        replacement = self.replacement()
        rate = replacement["catalog"]["rate_groups"]["boards"][0]
        rate.update(source={}, price_mode="override", price=19, **{"yield": 2.5})
        self.store.save_configuration(replacement)
        quote = self.store.save_quote({"title": "Imported board", "inputs": {"D15": "Replacement spray", "D22": rate["name"], "B22": 5}})
        self.assertEqual(quote["configuration"]["rates"][rate["id"]], {"price": 19, "yield": 2.5})
        self.assertEqual(quote["result"]["cells"]["F22"], 2.5)
        replacement["catalog"]["rate_groups"]["boards"] = []
        self.store.save_configuration(replacement)
        updated = self.store.save_quote({"title": "Same board quote", "inputs": quote["inputs"]}, quote["id"])
        self.assertEqual(updated["result"], quote["result"])
        self.assertEqual(effective_catalog(updated["configuration"])["rate_groups"]["boards"][0]["price_mode"], "override")

    def test_invalid_replacement_is_atomic(self):
        valid = self.store.save_configuration(self.replacement())
        invalid = deepcopy(valid)
        invalid["catalog"]["inventory"] = []
        with self.assertRaises(ValidationError):
            self.store.save_configuration(invalid)
        self.assertEqual(self.store.configuration(), valid)

    def test_errors_can_be_saved_as_drafts_without_fabricated_totals(self):
        quote = self.store.save_quote({"title": "Needs quantities", "inputs": {"C15": 0}})
        self.assertIsNone(quote["result"]["summary"]["total"])
        self.assertEqual(self.store.quote(quote["id"])["result"]["errors"]["B35"], "#DIV/0!")


if __name__ == "__main__":
    unittest.main()
