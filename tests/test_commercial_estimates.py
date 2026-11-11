"""Linked Quote amounts and original schedules use captured estimate values."""

from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.commercial_estimates import derive_estimates
from estimator.commercial_documents import default_fields
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from estimator.project_file import CALCULATOR_IDS, export_project, load_project_bytes
from estimator.schedule_rows import empty_schedule_inputs
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

    def test_out_of_range_linked_total_names_estimate_and_respects_cent_rounding(self):
        request = self.request()
        estimate = request['estimates'][0]['workspace']['estimate']
        estimate['inputs'] = {'B15': 1, 'C15': 1e-28, 'D2': '1 Team - 1x'}
        with self.assertRaisesRegex(ValidationError, 'Fire protection.*Quote line range.*daily outputs'):
            derive_estimates(self.store, request)
        base = self.store.prepare_quote({})['result']['summary']['total']
        for sign in (-1, 1):
            with self.subTest(sign=sign):
                estimate['inputs'] = {'B28': sign * 1_000_000_000.004 - base}
                result = derive_estimates(self.store, request)
                self.assertEqual(result['lines'][0]['unit_price'], f'{sign * 1_000_000_000}.00')
                estimate['inputs'] = {'B28': sign * 1_000_000_000.005 - base}
                with self.assertRaisesRegex(ValidationError, 'Fire protection.*Quote line range'):
                    derive_estimates(self.store, request)

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
        text = ' '.join('\n'.join(page.extract_text() for page in reader.pages).split())
        self.assertIn('Captured member', text)
        self.assertNotIn('1 Test Street', text)
        self.assertNotIn('Fire Protection Schedule', text)
        self.assertNotIn('Page 1', text)
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

    def test_linked_source_matches_portable_file_and_reopened_total(self):
        request = self.request()
        item = request['estimates'][0]
        workspace = deepcopy(item['workspace'])
        for calculator in CALCULATOR_IDS:
            workspace['calculators'].setdefault(calculator, {'inputs': empty_schedule_inputs(calculator)})
        payload = export_project(self.store, workspace)
        reopened = load_project_bytes(self.store, payload)
        canonical = json.dumps({'name': item['name'], 'workspace': json.loads(payload)}, sort_keys=True,
                               ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        result = derive_estimates(self.store, request)
        self.assertEqual(result['sources'], [{'estimate_id': item['id'], 'sha256': sha256(canonical).hexdigest()}])
        self.assertEqual(float(result['lines'][0]['unit_price']), reopened['estimate']['result']['summary']['total'])

    def test_custom_legacy_scope_is_preserved_once_with_first_schedule_across_estimates(self):
        request = self.request()
        request['estimates'][1]['workspace']['calculators'] = {
            'steel_board': {'inputs': {'CALCULATOR': {'A9': 'Second captured member'}}}}
        request['selected_ids'] = ['estimate-1', 'estimate-2']
        custom = '<p><b>EXCLUDED-ACCESS</b>: scaffold by client.</p><ul><li>Retain existing ceiling.</li></ul>'
        request['fields'] = {'scope': custom}
        before = deepcopy(request)
        derived = derive_estimates(self.store, request, include_pdfs=True, company=DEFAULTS)
        fields = default_fields('quote', {}, DEFAULTS)
        fields.update(scope=custom, lines=derived['lines'], sources=derived['sources'], scope_tables=derived['scope_tables'])
        fields['terms'] = '<p>Agreed terms.</p>'
        payload = render_commercial_pdf({'kind': 'quote', 'fields': fields}, 'Q-CUSTOM', company=DEFAULTS,
            scope_documents=[item['pdf'] for item in derived['scope_documents']])
        pages = [' '.join(page.extract_text().split()) for page in PdfReader(BytesIO(payload)).pages]
        combined = '\n'.join(pages)
        self.assertEqual(combined.count('EXCLUDED-ACCESS'), 1)
        self.assertEqual(combined.count('Retain existing ceiling.'), 1)
        first_scope = next(page for page in pages if 'SCOPE OF WORKS' in page)
        for retained in ('EXCLUDED-ACCESS', 'scaffold by client.', 'Line', 'Report', 'Captured member'):
            self.assertIn(retained, first_scope)
        self.assertIn('Second captured member', combined)
        self.assertEqual(len(derived['scope_documents']), 2)
        self.assertEqual(request, before)

    def test_generated_name_only_scope_does_not_repeat_estimate_heading(self):
        for name in ('Fire protection', "O'Brien & Sons"):
            with self.subTest(name=name):
                request = self.request()
                request['estimates'][0]['name'] = name
                request['fields'] = {'scope': derive_estimates(self.store, request)['scope']}
                result = derive_estimates(self.store, request, include_pdfs=True)
                text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(result['scope_documents'][0]['pdf'])).pages)
                self.assertEqual(text.count(name), 1)

    def test_scope_preamble_rejects_untrusted_rich_markup_before_pdf_generation(self):
        request = self.request()
        request['fields'] = {'scope': '<p onclick="alert(1)">Unsafe</p>'}
        with self.assertRaises(ValidationError):
            derive_estimates(self.store, request, include_pdfs=True)

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
