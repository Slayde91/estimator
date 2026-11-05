"""Linked Quote amounts and original schedules use captured estimate values."""

from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_estimates import derive_estimates
from estimator.storage import Store


class CommercialEstimateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.store = Store(Path(cls.temporary.name) / 'quotes.sqlite3')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def request(self):
        return {'estimates': [
            {'id': 'estimate-1', 'name': 'Fire protection', 'workspace': {
                'estimate': {'title': 'Project', 'site_address': '1 Test Street'},
                'calculators': {'steel_board': {'inputs': {'CALCULATOR': {'A9': 'Captured member'}}}},
            }},
            {'id': 'estimate-2', 'name': 'Additional work', 'workspace': {
                'estimate': {'title': 'Additional work', 'inputs': {'B28': 75}},
            }},
        ], 'selected_ids': ['estimate-1']}

    def test_selected_price_and_original_full_schedule_pdf(self):
        request = self.request()
        before = deepcopy(request)
        result = derive_estimates(self.store, request, include_pdfs=True)
        expected = self.store.prepare_quote(request['estimates'][0]['workspace']['estimate'])
        self.assertEqual(float(result['lines'][0]['unit_price']), expected['result']['summary']['total'])
        self.assertEqual([row['estimate_id'] for row in result['lines']], ['estimate-1'])
        self.assertTrue(any('Captured member' in str(table) for table in result['scope_tables']))
        self.assertEqual(len(result['scope_documents']), 1)
        reader = PdfReader(BytesIO(result['scope_documents'][0]['pdf']))
        self.assertTrue(all(float(page.mediabox.width) < float(page.mediabox.height) for page in reader.pages))
        text = '\n'.join(page.extract_text() for page in reader.pages)
        self.assertIn('Captured member', text)
        self.assertIn('1 Test Street', text)
        self.assertEqual(request, before)

    def test_supplied_line_prices_are_ignored_and_hashes_are_stable(self):
        request = self.request()
        request.pop('selected_ids')
        request['fields'] = {'lines': [{'estimate_id': 'estimate-2', 'unit_price': 0.01}]}
        first = derive_estimates(self.store, request)
        second = derive_estimates(self.store, request)
        self.assertEqual(first, second)
        self.assertNotEqual(first['lines'][0]['unit_price'], '0.01')
        request['estimates'][1]['workspace']['estimate']['inputs']['B28'] = 150
        changed = derive_estimates(self.store, request)
        self.assertNotEqual(first['sources'], changed['sources'])
        self.assertNotEqual(first['lines'], changed['lines'])
        request['estimates'][1]['name'] = 'Renamed scope'
        renamed = derive_estimates(self.store, request)
        self.assertNotEqual(changed['sources'], renamed['sources'])

    def test_missing_and_duplicate_estimate_links_are_rejected(self):
        for selected in (['missing'], ['estimate-1', 'estimate-1'], [None]):
            request = self.request()
            request['selected_ids'] = selected
            with self.subTest(selected=selected), self.assertRaises(ValidationError):
                derive_estimates(self.store, request)

    def test_scope_names_are_escaped_and_empty_selection_is_supported(self):
        request = self.request()
        request['estimates'][1]['name'] = '<script>example</script>'
        request['selected_ids'] = ['estimate-2']
        result = derive_estimates(self.store, request)
        self.assertNotIn('<script>', result['scope'])
        self.assertIn('&lt;script&gt;', result['scope'])
        request['selected_ids'] = []
        self.assertEqual(derive_estimates(self.store, request)['lines'], [])

    def test_standard_edition_rejects_selected_takeoff_workspace(self):
        request = self.request()
        request['estimates'][0]['workspace']['takeoffs_session_id'] = 'capability'
        with self.assertRaisesRegex(ValidationError, 'TAKEOFFS'):
            derive_estimates(self.store, request, edition='standard')


if __name__ == '__main__':
    unittest.main()
