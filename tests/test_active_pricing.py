import json
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from estimator.active_pricing import active_configuration
from estimator.catalog import baseline, catalog_signature, effective_catalog
from estimator.pricing_workbook import export_pricing_workbook, import_pricing_workbook
from estimator.storage import Store


class ActivePricingTests(unittest.TestCase):
    def test_shared_linked_uses_follow_sell_price_and_keep_nonpricing_metadata(self):
        catalog = baseline()
        primer = catalog["rate_groups"]["primers"][0]
        topcoat = catalog["rate_groups"]["topcoats"][0]
        self.assertEqual(primer["inventory_id"], topcoat["inventory_id"])
        product_id = primer["inventory_id"]
        product = next(row for row in catalog["inventory"] if row["id"] == product_id)
        primer.update(price_mode="override", price=400, supplier_price=200, markup=1)
        topcoat["price"] = 97  # Old inventory-mode uses can also carry stale cached rates.
        standalone = dict(primer, id="standalone-price-test", name="Independent primer", inventory_id=None)
        catalog["rate_groups"]["primers"].append(standalone)
        legacy = {
            "catalog": catalog,
            "catalog_signature": catalog_signature(catalog),
            "inventory": {product_id: {"supplier_price": 100, "markup": 0.3}},
            "rates": {
                primer["id"]: {"price": 42, "yield": 7, "product_service": "Retained label"},
                topcoat["id"]: {"supplier_price": 70, "markup": 0.5},
                standalone["id"]: {"markup": 0.5, "yield": 9},
            },
        }
        before = deepcopy(legacy)
        active = active_configuration(legacy)
        self.assertEqual(legacy, before)
        self.assertEqual(active_configuration(active), active)
        self.assertEqual(active["catalog_signature"], catalog_signature(active["catalog"]))
        self.assertEqual(active["rates"], {
            primer["id"]: {"yield": 7, "product_service": "Retained label"},
            standalone["id"]: {"markup": 0.5, "yield": 9},
        })
        uses = {rate["id"]: rate for rates in active["catalog"]["rate_groups"].values() for rate in rates}
        for original in (primer, topcoat):
            rate = uses[original["id"]]
            self.assertEqual(rate["price"], product["sales_price"])
            self.assertEqual(rate["price_mode"], "inventory")
            self.assertNotIn("supplier_price", rate)
            self.assertNotIn("markup", rate)
            for field in ("id", "name", "inventory_id", "source", "yield"):
                self.assertEqual(rate[field], original[field])
        installed = effective_catalog(active)["rate_groups"]
        self.assertEqual((installed["primers"][0]["price"], installed["topcoats"][0]["price"]), (130, 130))
        self.assertEqual((installed["primers"][-1]["price"], installed["primers"][-1]["yield"]), (300, 9))

    def test_legacy_linked_price_is_frozen_when_shared_prices_are_reconciled(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "db.sqlite3")
            catalog = baseline()
            primer = catalog["rate_groups"]["primers"][0]
            product = next(item for item in catalog["inventory"] if item["id"] == primer["inventory_id"])
            primer.update(price_mode="override", price=413)
            legacy = {"catalog": catalog, "rates": {primer["id"]: {"price": 510, "yield": 8}}}
            inputs = {"D20": primer["name"], "B20": 16, "D4": "1 Team - 1x"}
            original = store.save_quote({"configuration": legacy, "inputs": inputs})
            with store.connect() as db:
                db.execute("INSERT INTO settings VALUES (1,?)", (json.dumps(legacy),))
            reopened = Store(store.path)
            shared = reopened.configuration()
            shared_primer = effective_catalog(shared)["rate_groups"]["primers"][0]
            self.assertEqual((shared_primer["price"], shared_primer["yield"]), (product["sales_price"], 8))
            self.assertEqual(reopened.quote(original["id"]), original)
            revision = reopened.prepare_quote({}, original["id"])
            self.assertEqual(revision["result"], original["result"])
            self.assertEqual(revision["configuration"]["rates"][primer["id"]]["price"], 510)
            new = reopened.save_quote({"inputs": original["inputs"]})
            self.assertEqual(new["configuration"]["rates"][primer["id"]]["price"], product["sales_price"])
            self.assertEqual(original["result"]["cells"]["A87"], 510)
            self.assertEqual(new["result"]["cells"]["A87"], product["sales_price"])
            self.assertEqual(reopened.save_configuration(legacy), shared)

    def test_old_shared_settings_migrate_but_saved_sheeting_estimate_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'db.sqlite3')
            legacy = {'catalog': baseline(), 'inventory': {'100': {'markup': 0.7}}, 'rates': {}}
            original = store.save_quote({'inputs': {'D6': '1 Team (sheeting) - 1x '}, 'configuration': legacy})
            with store.connect() as db:
                db.execute('INSERT INTO settings VALUES (1,?)', (json.dumps(legacy),))
            reopened = Store(store.path)
            shared = reopened.configuration()
            self.assertEqual(len(shared['catalog']['inventory']), 393)
            self.assertEqual(len(shared['catalog']['rate_groups']['labour_rates']), 15)
            self.assertNotIn('100', shared['inventory'])
            self.assertEqual(reopened.quote(original['id']), original)
            self.assertEqual(reopened.prepare_quote({}, original['id'])['result'], original['result'])
            self.assertEqual(reopened.save_configuration(legacy), shared)
            self.assertEqual(Store(store.path).configuration(), shared)

    def test_import_and_reset_keep_weekly_hire_and_non_labour_sheeting_products(self):
        original = baseline()
        product = deepcopy(original['inventory'][0])
        product.update(id='sheet-material', name='Steel (Sheeting)', sales_description='Steel (Sheeting)')
        original['inventory'].append(product)
        original['inventory'].append({**product, 'id':'generator', 'name':'Generator hire',
                                      'sales_description':'Backup generator - daily hire'})
        old = {'catalog': original, 'inventory': {}, 'rates': {}}
        reset = active_configuration({})
        imported = import_pricing_workbook(export_pricing_workbook(old), 'old.xlsx', reset, active_library=True)
        self.assertEqual(imported['summary']['inventory']['added'], 2)
        inventory = imported['configuration']['catalog']['inventory']
        self.assertIn('sheet-material', {row['id'] for row in inventory})
        self.assertTrue(any(row['sales_description'].strip().lower().endswith('weekly hire') for row in inventory))
        self.assertEqual([row['id'] for row in inventory if row['sales_description'].strip().lower().endswith('daily hire')], ['generator'])
