from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import baseline, ValidationError
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
        with patch("estimator.catalog.baseline", return_value=changed), self.assertRaisesRegex(ValidationError, "catalogue structure"):
            calculate(quote["inputs"], quote["configuration"])
        self.assertEqual(self.store.quote(quote["id"])["result"], quote["result"])

    def test_resaving_with_original_pricing_retains_original_source_hashes(self):
        quote = self.store.save_quote({"title": "Source lineage", "inputs": {"B15": 10}})
        changed = baseline()
        changed["sources"]["quote"]["sha256"] = "later-source-hash"
        with patch("estimator.storage.baseline", return_value=changed):
            revised = self.store.save_quote({"title": "Revised inputs", "inputs": {"B15": 12}}, quote["id"])
        self.assertEqual(revised["source_hashes"], quote["source_hashes"])

    def test_errors_can_be_saved_as_drafts_without_fabricated_totals(self):
        quote = self.store.save_quote({"title": "Needs quantities", "inputs": {"C15": 0}})
        self.assertIsNone(quote["result"]["summary"]["total"])
        self.assertEqual(self.store.quote(quote["id"])["result"]["errors"]["B35"], "#DIV/0!")


if __name__ == "__main__":
    unittest.main()
