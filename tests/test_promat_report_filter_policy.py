"""Missing Promat report facets use existing literal report evidence only."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.firestopping_library import FirestoppingLibrary
from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from estimator.technical_catalog_policy import public_records
from estimator.technical_duplicates import review_fingerprint
from test_firestopping_library import editable_library
from test_reference_overlay import FullyValidatedLibrary


REPORT = '148393'
URL = 'https://media.promat.com/synthetic-report-148393.pdf'


def source_record(identifier='synthetic-id', report=REPORT, manufacturer='Promat', values=None):
    return {'id': identifier, 'title': 'Synthetic item', 'fields': [
        {'label': 'Manufacturer', 'value': manufacturer},
        {'label': 'Report Number', 'value': report},
        {'label': 'Installation Details', 'value': 'Do not infer report 99999 from this installation text.'}],
        'filter_values': {'manufacturer': [manufacturer], **(values or {})}}


class PromatReportFacetPolicyTests(unittest.TestCase):
    def test_fills_report_and_document_keys_from_literal_lines_and_preserves_fields(self):
        for keys in (['report'], ['document'], ['report', 'document']):
            with self.subTest(keys=keys):
                item = source_record(report='148393\nReport ABC Rev 2\n148393', values={key: [] for key in keys})
                item['fields'][1]['report_links'] = [{'label': REPORT, 'url': URL}]
                before = deepcopy(item)
                projected = public_records({'synthetic-id': item}, {}, keys)['synthetic-id']
                self.assertEqual(projected['fields'], before['fields'])
                for key in keys:
                    self.assertEqual(projected['filter_values'][key], [REPORT, 'Report ABC Rev 2'])
                self.assertEqual(item, before)
                self.assertEqual(public_records({'synthetic-id': projected}, {}, keys)['synthetic-id'], projected)

    def test_ignores_missing_value_labels_and_never_reads_title_or_installation_text(self):
        for value in ('', ' ', '-', '—', '...', 'N/A', 'N.A.', 'Unknown', 'Not recorded',
                      'Not supplied', 'Report number: not provided', 'Report reference unavailable', 'TBC', 'No report', 'X' * 1001):
            with self.subTest(value=value):
                item = source_record(report=value)
                item['title'] = 'Promat report 148393'
                self.assertIs(public_records({'synthetic-id': item}, {}, ['document'])['synthetic-id'], item)

    def test_does_not_change_other_suppliers_or_existing_assignments(self):
        for manufacturer in ('Trafalgar', 'Other manufacturer', ''):
            item = source_record(manufacturer=manufacturer)
            self.assertIs(public_records({'synthetic-id': item}, {}, ['document'])['synthetic-id'], item)
        for values in ([REPORT], ['Existing different report'], [REPORT, 'Another report']):
            item = source_record(values={'document': values})
            self.assertIs(public_records({'synthetic-id': item}, {}, ['document'])['synthetic-id'], item)
        item = source_record(values={'report': ['Existing report'], 'document': [], 'substrate': ['Original wall']})
        projected = public_records({'synthetic-id': item}, {}, ['report', 'document'])['synthetic-id']
        self.assertEqual(projected['filter_values'], {**item['filter_values'], 'document': [REPORT]})

    def test_preserves_existing_placeholder_facet_and_adds_only_real_explicit_captions(self):
        item = source_record(report='N/A\n148393\nUnknown', values={'document': ['N/A']})
        projected = public_records({'synthetic-id': item}, {}, ['document'])['synthetic-id']
        self.assertEqual(projected['filter_values']['document'], ['N/A', REPORT])
        self.assertEqual(projected['fields'], item['fields'])


class PromatReportFacetLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'library'
        self.data = editable_library(self.directory)
        original = self.data['libraries']['technical']['items'][0]
        items = []
        for number in range(17):
            item = source_record(f'gap-{number}', values={'document': []})
            item['sources'] = deepcopy(original['sources'])
            item['fields'][1]['report_links'] = [{'label': REPORT, 'url': URL}]
            items.append(item)
        items.extend([source_record('already-assigned', values={'document': [REPORT]}),
                      source_record('other-supplier', manufacturer='Trafalgar', values={'document': []}),
                      source_record('unavailable-report', report='Not supplied', values={'document': []})])
        self.data['libraries']['technical']['items'] = items
        self.data['libraries']['technical']['filters'] = [{'key': 'document', 'label': 'Report'}, {'key': 'manufacturer', 'label': 'Manufacturer'}]
        self.data['links'] = []
        self.index = self.directory / 'library.json'
        self.write()
        self.store = Store(Path(self.temp.name) / 'qa.sqlite3')
        self.library = FirestoppingLibrary(self.directory, self.store)

    def write(self):
        self.index.write_text(json.dumps(self.data), encoding='utf-8')

    def test_public_report_filter_options_and_listing_cover_exact_seventeen_gaps(self):
        original_bytes = self.index.read_bytes()
        data = self.library._load()
        changed = {key for key, item in data['_technical_public_records'].items() if item != data['_records']['technical'][key]}
        self.assertEqual(changed, {f'gap-{number}' for number in range(17)})
        listing = self.library.listing('technical', document=REPORT)
        self.assertEqual(listing['total'], 18)
        self.assertEqual({item['id'] for item in listing['items']}, changed | {'already-assigned'})
        options = next(field['options'] for field in listing['filters'] if field['key'] == 'document')
        self.assertEqual(options, [{'value': REPORT, 'label': REPORT, 'group': 'Promat'}])
        for key in changed:
            original, public = data['_records']['technical'][key], data['_technical_public_records'][key]
            self.assertEqual(original['filter_values']['document'], [])
            self.assertEqual(public, {**original, 'filter_values': {**original['filter_values'], 'document': [REPORT]}})
            field = next(field for field in self.library.detail('technical', key)['fields'] if field['label'] == 'Report Number')
            self.assertEqual(field['value'], REPORT)
            self.assertEqual(field['report_links'], [{'label': REPORT, 'url': URL}])
        self.assertEqual(data['libraries']['technical']['items'], self.data['libraries']['technical']['items'])
        self.assertEqual(self.index.read_bytes(), original_bytes)

    def test_duplicate_review_manual_links_and_overlay_revalidation_remain_stable(self):
        loaded = ReferenceLibrary(self.directory)._load()
        sources = self.data['libraries']['technical']['items'][:2]
        self.data['technical_duplicate_reviews'] = [{'canonical_id': 'gap-0', 'members': [
            {'id': item['id'], 'sha256': review_fingerprint(item, loaded['_records']['technical'][item['id']], loaded['_assets'])}
            for item in sources]}]
        self.write()
        before = self.index.read_bytes()
        self.library._load()
        original = deepcopy(self.library._data)
        self.library.add_link('pkb-002', {'technical_id': 'gap-1'})
        self.assertEqual(self.library._load(), FullyValidatedLibrary(self.directory, self.store)._load())
        self.assertEqual(self.library._data, original)
        reopened = FirestoppingLibrary(self.directory, self.store)
        self.assertEqual(reopened._load()['_aliases']['gap-1'], 'gap-0')
        self.assertEqual([link['id'] for link in reopened.detail('penetration', 'pkb-002')['links']], ['gap-0'])
        self.assertEqual(reopened.edits.links()[0][3], reopened._original_technical_source('gap-0', reopened._load()))
        self.assertEqual(reopened.listing('technical', document=REPORT)['total'], 17)
        self.assertEqual(self.index.read_bytes(), before)

    def test_report_key_and_absent_report_filter_definition_use_existing_report_values(self):
        for declared in (True, False):
            with self.subTest(declared=declared):
                data = deepcopy(self.data)
                data['libraries']['technical']['filters'] = [{'key': 'manufacturer', 'label': 'Manufacturer'}]
                if declared:
                    data['libraries']['technical']['filters'].append({'key': 'report', 'label': 'Report'})
                for item in data['libraries']['technical']['items']:
                    existing = item['filter_values'].pop('document')
                    if declared:
                        item['filter_values']['report'] = existing
                self.index.write_text(json.dumps(data), encoding='utf-8')
                listing = ReferenceLibrary(self.directory).listing('technical', report=REPORT)
                self.assertEqual(listing['total'], 18)
                self.assertEqual(next(field['options'] for field in listing['filters'] if field['key'] == 'report'),
                                 [{'value': REPORT, 'label': REPORT, 'group': 'Promat'}])


if __name__ == '__main__':
    unittest.main()
