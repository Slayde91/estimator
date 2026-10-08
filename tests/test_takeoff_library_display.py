"""Literal Takeoff presentation fields without source or calculation mutation."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.firestopping_library import FirestoppingLibrary, LibraryConflict
from estimator.service_dimensions import FIELD_LABEL, UNKNOWN
from estimator.storage import Store
from estimator.takeoff_model import digest
from test_firestopping_library import editable_library


class TakeoffLibraryDisplayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = editable_library(self.root / 'library')
        self.inputs = self.data['libraries']['penetration']['items'][0]['estimate']['draft']['rows'][0]['inputs']
        self.inputs.update(L='Core Hole', M='Vertical', N='-/120/120', P='Concrete',
                           T='Unrelated title 900 mm <script>', AL=25.123456789012,
                           AQ=100.234567890123, AR=50.345678901234)
        item = self.data['libraries']['penetration']['items'][0]
        item['fields'].extend({'label': label, 'column': column, 'value': self.inputs[column]}
                             for column, label in [('L', 'Penetration Type'), ('M', 'Orientation'),
                                                   ('N', 'FRL'), ('P', 'Substrate')])
        self.path = self.root / 'library/library.json'
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        self.source_bytes = self.path.read_bytes()
        self.diagram_bytes = (self.root / 'library/images/diagram-a.png').read_bytes()
        self.store = Store(self.root / 'test.sqlite3')
        self.library = FirestoppingLibrary(self.root / 'library', self.store)

    def protected(self):
        with self.store.connect() as db:
            return {table: db.execute(f'SELECT * FROM {table} ORDER BY 1').fetchall()
                    for table in ('settings', 'quotes', 'calculator_states', 'app_preferences')}

    def assert_source_unchanged(self):
        self.assertEqual(self.path.read_bytes(), self.source_bytes)
        self.assertEqual((self.root / 'library/images/diagram-a.png').read_bytes(), self.diagram_bytes)

    def test_helper_uses_literal_columns_and_exact_entered_dimensions_without_calculation(self):
        inputs = deepcopy(self.inputs)
        inputs.update(K='Literal <script> service', L='Literal opening', P='Literal substrate', N='Literal FRL')
        before = deepcopy(inputs)
        with patch('estimator.firestopping_library.calculate', side_effect=AssertionError('No calculation for display')):
            result = self.library._takeoff_display_fields({'title': 'Wrong title 100 mm'}, inputs)
        self.assertEqual(result, {
            'service_type': inputs['K'], 'penetration_type': inputs['L'], 'substrate': inputs['P'],
            'orientation': inputs['M'], 'frl': inputs['N'],
            'service_size': '25.123456789012 mm\n100.234567890123 mm wide × 50.345678901234 mm deep'})
        self.assertEqual(inputs, before)

    def test_field_projection_never_parses_title_or_missing_dimensions(self):
        item = {'title': 'Concrete core hole 900 mm diameter', 'fields': [
            {'column': 'K', 'value': 'Entered service'}, {'column': 'P', 'value': None},
            {'label': FIELD_LABEL, 'value': 'Entered size <script>'}]}
        before = deepcopy(item)
        result = self.library._takeoff_display_fields(item)
        self.assertEqual(result, {'service_type': 'Entered service', 'penetration_type': '',
                                 'substrate': '', 'orientation': '', 'frl': '',
                                 'service_size': 'Entered size <script>'})
        self.assertEqual(self.library._takeoff_display_fields(item, {})['service_size'], UNKNOWN)
        self.assertEqual(item, before)

    def test_search_listing_and_record_return_current_fields_without_protected_writes(self):
        before = self.protected()
        stamp = self.library.edits.stamp()
        selected = self.library.takeoff_record('pkb-001')
        inputs = deepcopy(selected['inputs'])
        metadata = {key: selected[key] for key in ('id', 'library_id', 'title', 'source_sha256', 'revision', 'inputs')}
        self.assertEqual(selected['metadata_sha256'], digest(metadata))
        listing = self.library.listing('penetration')
        item = next(value for value in listing['items'] if value['id'] == 'pkb-001')
        self.assertEqual(item['display_fields'], selected['display_fields'])
        self.assertEqual(set(item['display_fields']), {'service_type', 'penetration_type', 'substrate', 'orientation', 'frl', 'service_size'})
        self.assertEqual(self.library.takeoff_record('pkb-001')['inputs'], inputs)
        self.assertEqual(self.library.edits.stamp(), stamp)
        self.assertEqual(self.protected(), before)
        self.assert_source_unchanged()

    def test_saved_current_fields_change_fingerprint_while_source_and_captured_inputs_survive(self):
        selected = self.library.takeoff_record('pkb-001')
        opened = self.library.edit('pkb-001')
        draft = deepcopy(opened['draft'])
        draft['rows'][0]['inputs'].update(L='Saved opening', M='Horizontal', P='CLT wall',
                                          K='Saved service <script>', N='-/90/90', AL=99.123456789012)
        snapshot = self.library._context('pkb-001')[3]
        self.library.edits.save('pkb-001', 0, self.data['firestopping']['source_sha256'], {
            'draft': draft, 'pricing_token': opened['pricing_token'], 'amount': 150}, snapshot)
        protected = self.protected()
        stamp = self.library.edits.stamp()
        reopened = FirestoppingLibrary(self.root / 'library', self.store)
        current = reopened.takeoff_record('pkb-001')
        listing = reopened.listing('penetration')
        shown = next(value for value in listing['items'] if value['id'] == 'pkb-001')
        self.assertEqual(shown['display_fields'], current['display_fields'])
        self.assertEqual(current['display_fields']['service_type'], 'Saved service <script>')
        self.assertEqual(current['display_fields']['service_size'].splitlines()[0], '99.123456789012 mm')
        self.assertEqual(current['inputs'], draft['rows'][0]['inputs'])
        self.assertEqual(selected['inputs']['AL'], 25.123456789012)
        self.assertNotEqual(current['metadata_sha256'], selected['metadata_sha256'])
        self.assertEqual(current['source_sha256'], selected['source_sha256'])
        self.assertEqual(reopened.edit('pkb-001')['pricing_token'], opened['pricing_token'])
        self.assertEqual(reopened.edit('pkb-001')['source_price'], opened['source_price'])
        self.assertEqual(self.library.edits.stamp(), stamp)
        self.assertEqual(self.protected(), protected)
        self.assert_source_unchanged()

    def test_search_uses_literal_inputs_when_human_display_columns_are_missing_or_different(self):
        item = self.data['libraries']['penetration']['items'][0]
        item['fields'] = [{'label': 'Wrong display service', 'column': 'K', 'value': 'Wrong display value'}]
        self.inputs.update(K='Copper pipe', N='120/120/120', P='Concrete literal')
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        original = self.path.read_bytes()
        library = FirestoppingLibrary(self.root / 'library', self.store)
        selected = library.takeoff_record('pkb-001')
        shown = next(item for item in library.listing('penetration')['items'] if item['id'] == 'pkb-001')
        self.assertEqual(shown['display_fields'], selected['display_fields'])
        self.assertEqual(shown['display_fields']['frl'], '120/120/120')
        self.assertEqual(shown['display_fields']['substrate'], 'Concrete literal')
        self.assertEqual(shown['display_fields']['penetration_type'], 'Core Hole')
        self.assertEqual(self.path.read_bytes(), original)

    def test_stale_saved_source_is_withheld_from_literal_search_projection(self):
        opened = self.library.edit('pkb-001')
        draft = deepcopy(opened['draft'])
        draft['rows'][0]['inputs'].update(L='Stale saved opening')
        self.library.edits.save('pkb-001', 0, self.data['firestopping']['source_sha256'], {
            'draft': draft, 'pricing_token': opened['pricing_token'], 'amount': 150},
            self.library._context('pkb-001')[3])
        self.data['firestopping']['source_sha256'] = 'b' * 64
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        original = self.path.read_bytes()
        library = FirestoppingLibrary(self.root / 'library', self.store)
        with self.assertRaises(LibraryConflict):
            library.takeoff_record('pkb-001')
        shown = next(item for item in library.listing('penetration')['items'] if item['id'] == 'pkb-001')
        self.assertEqual(shown['display_fields']['penetration_type'], 'Core Hole')
        self.assertFalse(shown['editable'])
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
