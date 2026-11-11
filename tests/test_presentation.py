import unittest

from estimator.calculator import specification
from estimator.presentation import calculation_error_details, calculation_labels


class PresentationTests(unittest.TestCase):
    def test_all_calculated_outputs_have_plain_labels(self):
        labels = calculation_labels()
        self.assertFalse(set(specification()["formulas"]) - labels.keys())
        for cell in specification()["formulas"]:
            self.assertNotRegex(labels[cell], r"\b[A-Z]{1,3}[0-9]+\b")

    def test_duplicate_outputs_have_one_error_message(self):
        details = calculation_error_details({"errors": {"F7": "#N/A", "D28": "#N/A"}})
        self.assertEqual([note["label"] for note in details], ["Grand total"])
        self.assertNotIn("#N/A", details[0]["message"])

    def test_missing_yield_names_selected_product(self):
        from estimator.calculator import calculate
        from estimator.catalog import effective_catalog
        product = effective_catalog()['rate_groups']['mastic'][0]
        configuration = {'rates': {product['id']: {'yield': 0}}}
        result = calculate({'D23': product['name'], 'B23': 10, 'D10': '1 Team - 1x'}, configuration)
        self.assertEqual(result['errors']['B102'], '#DIV/0!')
        details = calculation_error_details(result, configuration)
        self.assertIn(product.get('display_name', product['name']), details[0]['message'])
        self.assertIn('missing or zero yield', details[0]['message'])
        self.assertIn('Pricing Library', details[0]['message'])
        self.assertEqual(len(details), 1)

    def test_missing_daily_output_has_specific_instruction(self):
        from estimator.catalog import effective_catalog
        product = effective_catalog()['rate_groups']['mastic'][0]
        details = calculation_error_details({'inputs': {'D23': product['name'], 'C23': 0},
                                            'cells': {'F23': 5}, 'errors': {'B43': '#DIV/0!'}})
        self.assertIn('daily output', details[0]['message'])
        self.assertIn('Mastic estimate row', details[0]['message'])

    def test_unavailable_product_names_selection(self):
        details = calculation_error_details({'inputs': {'D23': 'Missing sealant'}, 'errors': {'A102': '#N/A'}})
        self.assertIn('Missing sealant', details[0]['message'])
        self.assertIn('missing from the estimate pricing', details[0]['message'])

    def test_duplicate_missing_yield_names_its_own_product(self):
        from estimator.catalog import effective_catalog
        product = effective_catalog()['rate_groups']['mastic'][0]
        result = {'inputs': {'D23': 'Other product'}, 'errors': {'duplicate:extra:B102': '#DIV/0!'},
                  'work_items': [{'id': 'extra', 'source_row': 23, 'inputs': {'D': product['name']}, 'yield': 0}]}
        self.assertIn(product.get('display_name', product['name']), calculation_error_details(result)[0]['message'])

    def test_independent_missing_rates_and_yields_each_remain_visible(self):
        from estimator.estimate_composition import calculate
        from estimator.catalog import effective_catalog
        product = effective_catalog()['rate_groups']['mastic'][0]
        configuration = {'rates': {product['id']: {'yield': 0}}}
        result = calculate({'D23': product['name'], 'B23': 10, 'D10': 'Missing crew'}, configuration)
        messages = [detail['message'] for detail in result['error_details']]
        self.assertEqual(len(messages), 2)
        self.assertTrue(any('missing or zero yield' in message for message in messages))
        self.assertTrue(any('Missing crew' in message for message in messages))
        self.assertFalse(any('#' in message for message in messages))

    def test_inactive_rows_leave_other_totals_intact_and_retain_inputs(self):
        from estimator.estimate_composition import calculate
        active = {'B15': 200, 'D2': '1 Team - 1x', 'D3': 'N/A'}
        expected = calculate(active)
        for daily_output, material in [(None, 'Missing product'), (0, 'Missing product'),
                                       ('', 'Missing product'), (2, 'N/A'), (2, '')]:
            with self.subTest(daily_output=daily_output, material=material):
                values = dict(C=daily_output, D=material, B=10, E=0)
                result = calculate({**active, **{col+'16': value for col, value in values.items()}},
                                   work_items=[{'id':'extra', 'source_row':16, 'inputs': values}])
                self.assertFalse(result['errors'])
                self.assertEqual(result['summary'], expected['summary'])
                self.assertEqual(result['work_items'][0]['inputs'], values)
                self.assertEqual(result['inputs']['B16'], 10)
                self.assertEqual(result['materials'][1]['total'], 0)
                self.assertEqual(result['materials'][-1]['quantity'], 0)
