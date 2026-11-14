import json
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from estimator.active_pricing import active_configuration
from estimator.catalog import baseline
from estimator.pricing_workbook import export_pricing_workbook, import_pricing_workbook
from estimator.storage import Store


class ActivePricingTests(unittest.TestCase):
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
