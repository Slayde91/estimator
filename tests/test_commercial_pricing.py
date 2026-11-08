"""Quote suggestions project exact effective prices without changing Settings."""
from copy import deepcopy
import math
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError, baseline, effective_catalog
from estimator.commercial_pricing import search_pricing


class CommercialPricingTests(unittest.TestCase):
    def test_saved_library_labels_prices_and_manual_sales_prices_are_canonical(self):
        configuration = {'inventory': {'200': {'supplier_price': 100, 'markup': .25, 'product_service': 'Selected product'}}, 'rates': {}}
        before = deepcopy(configuration)
        result = search_pricing(configuration, 'Selected product')['items']
        self.assertEqual(result, [{'id': 'inventory:200', 'name': 'Selected product', 'description': 'Selected product', 'unit_price': 125}])
        original = search_pricing({}, 'Promasil-1100 Super - 1250x600x60mm')['items']
        self.assertEqual(next(item for item in original if item['id'] == 'inventory:239')['unit_price'], 213.12199999999999)
        manual = next(item for item in search_pricing({}, '915')['items'] if item['id'] == 'inventory:915')
        self.assertEqual(manual['unit_price'], 2080)
        self.assertEqual(configuration, before)

    def test_custom_service_and_distinct_linked_rate_override_remain_selectable(self):
        catalog = baseline()
        service = deepcopy(catalog['rate_groups']['labour_rates'][1])
        service.update(id='service-custom', name='Custom field service', product_service='Custom field service', inventory_id=None,
                       price_mode='override', price=42.123456, supplier_price=30, markup=.1, source={})
        catalog['rate_groups']['labour_rates'].append(service)
        configuration = {'catalog': catalog, 'inventory': {}, 'rates': {service['id']: {'supplier_price': 100, 'markup': .4}}}
        self.assertEqual(search_pricing(configuration, 'Custom field service')['items'],
                         [{'id': 'rate:service-custom', 'name': 'Custom field service', 'description': 'Custom field service', 'unit_price': 140}])
        rate = next(row for rows in catalog['rate_groups'].values() for row in rows if row.get('inventory_id') == '200')
        configuration['inventory']['200'] = {'product_service': 'Shared product'}
        configuration['rates'][rate['id']] = {'price': 99.125}
        choices = search_pricing(configuration, 'Shared product')['items']
        self.assertEqual({item['id'] for item in choices}, {'inventory:200', 'rate:' + rate['id']})
        self.assertEqual({item['unit_price'] for item in choices}, {71.877, 99.125})

    def test_bounded_deterministic_results_keep_duplicate_names_and_reject_unavailable_prices(self):
        items = [{'id': str(index), 'name': 'Duplicate product', 'sales_price': index} for index in range(50)]
        items.extend({'id': 'invalid-' + str(index), 'name': 'Unavailable product', 'sales_price': price}
                     for index, price in enumerate((None, '', True, math.nan, math.inf, 1_000_000_001)))
        items.append({'id': 'zero', 'name': 'Free valid service', 'sales_price': 0})
        snapshot = {'inventory': items, 'rate_groups': {}}
        with patch('estimator.commercial_pricing.effective_catalog', return_value=snapshot):
            result = search_pricing({}, 'duplicate')['items']
            self.assertEqual(len(result), 30)
            self.assertEqual(len({item['id'] for item in result}), 30)
            self.assertEqual(result, search_pricing({}, 'DUPLICATE')['items'])
            self.assertEqual(search_pricing({}, 'Unavailable'), {'items': []})
            self.assertEqual(search_pricing({}, 'Free')['items'][0]['unit_price'], 0)
        for search in (None, False, ['product'], 'x' * 501):
            with self.subTest(search=type(search).__name__), self.assertRaises(ValidationError):
                search_pricing({}, search)

    def test_search_uses_aliases_codes_and_saved_effective_configuration_without_mutation(self):
        catalog = baseline()
        record = next(item for item in catalog['inventory'] if item['id'] == '200')
        record.update(product_service='A chosen display label', sales_description='Lookup alias', manufacturer='Exact manufacturer')
        configuration = {'catalog': catalog, 'inventory': {}, 'rates': {}}
        before = deepcopy(configuration)
        for query in ('lookup alias', '200', 'Exact manufacturer', 'a chosen display label'):
            self.assertTrue(any(item['id'] == 'inventory:200' for item in search_pricing(configuration, query)['items']))
        self.assertEqual(configuration, before)
        self.assertEqual(effective_catalog(configuration), effective_catalog(before))


if __name__ == '__main__':
    unittest.main()
