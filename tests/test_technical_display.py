"""Display abbreviations preserve product identity, conditions and raw evidence."""
import json
from pathlib import Path
import re
import unittest

from estimator.technical_display import compact_technical_text


class TechnicalDisplayTests(unittest.TestCase):
    def test_authorized_display_vectors_preserve_every_numeric_token(self):
        vectors = json.loads((Path(__file__).parent / 'fixtures/technical-compact-display.json').read_text(encoding='utf-8'))
        for entry in vectors:
            with self.subTest(source=entry['source']):
                self.assertEqual(compact_technical_text(entry['source']), entry['display'])
                self.assertEqual(re.findall(r'-?\d+(?:\.\d+)?', entry['source']),
                                 re.findall(r'-?\d+(?:\.\d+)?', entry['display']))
                self.assertEqual(compact_technical_text(entry['display']), entry['display'])

    def test_nontext_source_values_are_not_coerced_or_modified(self):
        for value in (None, 0, 2.125, True, ['minimum 50 mm'], {'with': 2}):
            self.assertIs(compact_technical_text(value), value)

    def test_requested_cross_reference_cleanup_retains_actual_installation_conditions(self):
        vectors = json.loads((Path(__file__).parent / 'fixtures/technical-reference-display.json').read_text(encoding='utf-8'))
        for entry in vectors:
            with self.subTest(source=entry['source']):
                self.assertEqual(compact_technical_text(entry['source']), entry['display'])
                self.assertEqual(compact_technical_text(entry['display']), entry['display'])

    def test_equal_diameter_display_requires_exact_values_units_and_complete_lines(self):
        vectors = json.loads((Path(__file__).parent / 'fixtures/technical-diameter-display.json').read_text(encoding='utf-8'))
        for entry in vectors:
            with self.subTest(source=entry['source']):
                self.assertEqual(compact_technical_text(entry['source']), entry['display'])
                self.assertEqual(compact_technical_text(entry['display']), entry['display'])
