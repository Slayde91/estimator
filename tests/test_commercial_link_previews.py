"""Quote linking defers schedule rendering, never pricing or save validation."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.commercial_estimates import derive_estimates
from estimator.storage import Store


class CommercialLinkPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.store = Store(Path(cls.temporary.name) / 'preview.sqlite3')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def body(self):
        return {'estimates': [{'id': 'estimate-1', 'name': 'Selected estimate', 'workspace': {
            'estimate': {'title': 'Synthetic preview'},
            'calculators': {'steel_board': {'inputs': {'CALCULATOR': {'A9': 'Captured member'}}}},
        }}], 'selected_ids': ['estimate-1']}

    def test_fast_link_keeps_trusted_prices_hashes_and_scope_identity_without_evaluating_tables(self):
        body = self.body()
        before = deepcopy(body)
        full = derive_estimates(self.store, body)
        with patch('estimator.commercial_estimates.project_calculator_report', side_effect=AssertionError('Deferred schedule evaluated')):
            preview = derive_estimates(self.store, {**body, 'include_scope_tables': False})
        for key in ('lines', 'sources', 'scope', 'scope_groups'):
            self.assertEqual(preview[key], full[key])
        self.assertEqual(len(preview['scope_tables']), len(full['scope_tables']))
        self.assertEqual(preview['scope_tables'][0], {'title': full['scope_tables'][0]['title'],
            'headers': [], 'rows': [], 'pending': True, 'estimate_id': 'estimate-1'})
        self.assertEqual(body, before)
        self.assertNotIn('pending', str(full['scope_tables']))

    def test_fast_link_still_validates_each_selected_workspace_and_rejects_unknown_links(self):
        for change in ({'selected_ids': ['foreign']}, {'selected_ids': ['estimate-1', 'estimate-1']},
                       {'estimates': [{'id': 'estimate-1', 'name': 'Selected estimate', 'workspace': {'estimate': {'unknown': 5}}}]}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                derive_estimates(self.store, {**self.body(), **change, 'include_scope_tables': False})

    def test_preview_switch_is_strict_and_cannot_weaken_pdf_generation(self):
        for invalid in (None, 0, 1, 'false', [], {}):
            with self.subTest(value=invalid), self.assertRaises(ValidationError):
                derive_estimates(self.store, {**self.body(), 'include_scope_tables': invalid})
        with self.assertRaises(ValidationError):
            derive_estimates(self.store, {**self.body(), 'include_scope_tables': False}, include_pdfs=True)

    def test_empty_selection_never_evaluates_a_schedule(self):
        body = {**self.body(), 'selected_ids': [], 'include_scope_tables': False}
        with patch('estimator.commercial_estimates.project_calculator_report', side_effect=AssertionError('Empty selection evaluated')):
            result = derive_estimates(self.store, body)
        self.assertEqual(result['scope_tables'], [])
        self.assertEqual(result['lines'], [])
