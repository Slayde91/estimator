"""New-entry requirements leave historical calculator drafts and prices intact."""

from copy import deepcopy
import unittest

from estimator.catalog import ValidationError
from estimator.penetration_calculator import calculate, definition, normalize_draft
from estimator.penetration_entry import REQUIRED_ITEM_FIELDS, validate_item_for_add


class PenetrationEntryTests(unittest.TestCase):
    def draft(self):
        return {'globals': {}, 'rows': [{'id': 'literal-row', 'inputs': {
            'J': 'Plumbing & Hydraulic', 'K': 'Copper Pipes', 'L': 'Core Hole',
            'M': 'Vertical', 'N': '-/120/120', 'P': 'Concrete/masonry wall',
            'O': 1.23456789012345, 'AI': 98.76543210987654, 'AH': .123456789012345}}]}

    def test_definition_exposes_exact_six_fields_and_complete_entry_keeps_precision(self):
        metadata = definition()
        self.assertEqual(metadata['required_item_fields'],
                         [{'column': column, 'label': label} for column, label in REQUIRED_ITEM_FIELDS])
        draft = self.draft()
        before = deepcopy(draft)
        original_result = calculate(draft)
        self.assertEqual(validate_item_for_add(draft), normalize_draft(draft))
        self.assertEqual(draft, before)
        self.assertEqual(calculate(draft), original_result)

    def test_each_missing_or_whitespace_field_is_named_without_mutating_legacy_draft(self):
        for column, label in REQUIRED_ITEM_FIELDS:
            for missing in (None, '', '   '):
                with self.subTest(column=column, missing=missing):
                    draft = self.draft()
                    draft['rows'][0]['inputs'][column] = missing
                    before = deepcopy(draft)
                    with self.assertRaisesRegex(ValidationError, 'Complete ' + label + ' before adding'):
                        validate_item_for_add(draft)
                    self.assertEqual(draft, before)
                    # Old incomplete drafts still use the original read/calculate paths.
                    self.assertEqual(normalize_draft(draft)['rows'][0]['id'], 'literal-row')
                    self.assertIn('summary', calculate(draft))

    def test_blank_seal_uses_the_same_six_fields_without_requiring_a_physical_service(self):
        draft = self.draft()
        draft['rows'][0]['inputs'].update(J='Blank Seal', K='Blank Seal', O=4.9876543210123)
        self.assertEqual(validate_item_for_add(draft)['rows'][0]['inputs']['O'], 4.9876543210123)

