"""Synthetic supplier ingestion fixtures; no real supplier content belongs in Git."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.reference_library import ReferenceLibrary
from scripts.import_trafalgar_library import IMPORT_KEY, build_bundle, digest, json_bytes


class TrafalgarImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = self.root / 'base'
        self.prepared = self.root / 'prepared'
        self.output = self.root / 'output'
        for root in (self.base, self.prepared):
            (root / 'documents').mkdir(parents=True)
            (root / 'images').mkdir()
        self.pdf = b'%PDF-1.4\nSynthetic source document\n%%EOF'
        self.image = b'\x89PNG\r\n\x1a\nSynthetic source image'
        (self.base / 'documents/foreign-report.pdf').write_bytes(self.pdf)
        (self.base / 'images/foreign-image.png').write_bytes(self.image)
        self.base_data = {
            'schema_version': 1,
            'documents': [{'id': 'foreign-report', 'filename': 'Prior report.pdf',
                           'pages': 1, 'sha256': digest(self.pdf)}],
            'images': [{'id': 'foreign-image', 'filename': 'Original.png',
                        'extension': '.png', 'sha256': digest(self.image)}],
            'libraries': {
                'penetration': {'items': [{'id': 'original-item', 'title': 'Original Firestopping item',
                                           'estimate': {'preserve': 'exact'}, 'fields': []}], 'filters': []},
                'technical': {'items': [{'id': 'foreign-system', 'title': 'Original technical system',
                                         'fields': [{'label': 'Original', 'value': 'Must remain identical'}],
                                         'images': [{'id': 'foreign-image', 'caption': 'Original image'}],
                                         'sources': [{'document_id': 'foreign-report', 'page': 1,
                                                      'label': 'Exact source fingerprint metadata'}]}],
                              'filters': [{'key': 'document', 'label': 'Report'}]}},
            'links': [{'penetration_id': 'original-item', 'technical_id': 'foreign-system',
                       'relationship': 'Existing relationship, retained exactly.'}],
            'firestopping': {'source_sha256': 'original-calculator-source', 'configuration': {'rate': 123.456}},
            'coverage': [{'document_id': 'foreign-report', 'status': 'original'}],
        }
        self.url = 'https://supplier.example/source'
        self.missing_url = 'https://supplier.example/missing'
        fields = [{'name': 'Services', 'value': 'Copper pipe', 'links': []},
                  {'name': 'Report Number', 'value': 'Report A (Table 12)', 'links': []},
                  {'name': 'TWrap Length', 'value': '300 mm', 'links': []},
                  {'name': 'FRL', 'value': '-/60/60', 'links': []},
                  {'name': 'Fill Depth / Fillet Size', 'value': '20 mm / No fillet', 'links': []}]
        records = [{'source_product_id': number, 'record_id': f'R-{number}',
                    'recommendation': 'Synthetic seal', 'result_fields': deepcopy(fields),
                    'query_ids': ['Q-1', 'Q-2'],
                    'technical_diagram_urls': [self.url] if number == 11 else [] if number == 12 else [self.missing_url]}
                   for number in (11, 12, 13)]
        self.capture = {'sections': [{'category': 'fire-protection', 'label': 'Service Penetrations',
                         'records': records, 'queries': [
                             {'query_id': 'Q-1', 'record_ids': [record['record_id'] for record in records],
                              'selected_options': {'barrier': {'label': 'Wall'}, 'frl': {'label': 'All', 'is_all': True}},
                              'parameters': {'barrier': '1'}, 'response_html': '<p>Synthetic response one</p>'},
                             {'query_id': 'Q-2', 'record_ids': [record['record_id'] for record in records],
                              'selected_options': {'barrier': {'label': 'Floor'}, 'frl': {'label': '120', 'is_all': False}},
                              'parameters': {'barrier': '2'}, 'response_html': '<p>Synthetic response two</p>'}]}]}
        self.manifest = {'metadata': {}, 'documents': [
            {'document_id': 'D-ONE', 'source_url': self.url},
            {'document_id': 'D-MISSING', 'source_url': self.missing_url}]}
        pdf_name = 'trafalgar-doc-' + digest(self.pdf)[:24]
        image_name = 'trafalgar-image-' + digest(self.pdf)[:24] + '-p0001'
        (self.prepared / f'documents/{pdf_name}.pdf').write_bytes(self.pdf)
        (self.prepared / f'images/{image_name}.png').write_bytes(self.image)
        self.document = {'document_id': 'D-ONE', 'source_url': self.url, 'source_filename': 'Source.pdf',
                         'sha256': digest(self.pdf), 'pdf_filename': f'documents/{pdf_name}.pdf',
                         'status': 'prepared', 'pages': [{'page': 1, 'text': 'Full diagram notes remain available.',
                         'image_filename': f'images/{image_name}.png', 'image_sha256': digest(self.image),
                         'width': 100, 'height': 200}], 'fields': [{'label': 'Protection', 'value': 'Source-only condition'}]}
        self.document_index = {'documents': [self.document, {'document_id': 'D-MISSING', 'status': 'missing'}]}

    def tearDown(self):
        self.temp.cleanup()

    def write_sources(self):
        (self.base / 'library.json').write_bytes(json_bytes(self.base_data))
        self.capture_path = self.root / 'capture.json'
        self.capture_path.write_bytes(json_bytes(self.capture))
        self.manifest['metadata']['source_capture_sha256'] = digest(self.capture_path.read_bytes())
        self.manifest_path = self.root / 'manifest.json'
        self.manifest_path.write_bytes(json_bytes(self.manifest))
        (self.prepared / 'documents-index.json').write_bytes(json_bytes(self.document_index))

    def build(self, base=None, output=None):
        self.write_sources()
        return build_bundle(self.capture_path, self.manifest_path, self.prepared,
                            base or self.base, output or self.output)

    def data(self, output=None):
        return json.loads(((output or self.output) / 'library.json').read_text(encoding='utf-8'))

    def item(self, number=11):
        return next(item for item in self.data()['libraries']['technical']['items']
                    if item['id'] == f'trafalgar-selector-{number}')

    def test_distinct_ids_keep_identical_displayed_rows_and_missing_documents(self):
        receipt = self.build()
        self.assertEqual(receipt['counts']['records'], 3)
        self.assertEqual(receipt['counts']['records_without_diagram_link'], 1)
        self.assertEqual(receipt['counts']['records_with_missing_documents'], 1)
        self.assertEqual(receipt['counts']['records_with_images'], 1)
        self.assertEqual(receipt['missing_documents'], 1)
        self.assertFalse(any(field.get('images') for field in self.item(12)['fields']))
        self.assertEqual(self.item(13)['selector_provenance']['unavailable_source_urls'], [self.missing_url])
        fields = {field['label']: field['value'] for field in self.item()['fields']}
        self.assertEqual(fields['Service'], 'Copper pipe')
        self.assertEqual(fields['Service Wrap'], '300 mm')
        self.assertEqual(fields['FRL'], '-/60/60')
        self.assertEqual(fields['Fill Depth / Fillet Size'], '20 mm / No fillet')
        self.assertEqual(fields['Source Diagram Details'], 'Full diagram notes remain available.')
        self.assertEqual(self.item()['selector_provenance']['record'], self.capture['sections'][0]['records'][0])
        self.assertEqual(self.item()['filter_values']['document'], ['Report A (Table 12)'])
        self.assertNotIn('images', self.item())
        labels = [field['label'] for field in self.item()['fields']]
        self.assertLess(labels.index('Refer Figure'), labels.index('Source Diagram Details'))
        self.assertLess(labels.index('Service'), labels.index('Refer Figure'))
        self.assertEqual(labels[-1], 'Selector Search Context')

    def test_query_combinations_are_paired_and_never_overwrite_record_frl(self):
        self.build()
        field = next(field for field in self.item()['fields'] if field['label'] == 'Selector Search Context')
        self.assertEqual(field['table']['columns'], ['Search ID', 'Barrier', 'Frl'])
        self.assertEqual(field['table']['rows'], [['Q-1', 'Wall', 'All'], ['Q-2', 'Floor', '120']])
        self.assertEqual([field['value'] for field in self.item()['fields'] if field['label'] == 'FRL'], ['-/60/60'])
        queries = self.data()[IMPORT_KEY]['queries']['fire-protection']
        self.assertEqual(queries['Q-1']['parameters'], {'barrier': '1'})
        self.assertNotIn('response_html', queries['Q-1'])
        self.assertEqual(queries['Q-1']['response_html_sha256'], digest(b'<p>Synthetic response one</p>'))

    def test_common_substrate_is_explicit_search_context_and_mixed_substrates_stay_paired(self):
        section = self.capture['sections'][0]
        section['field_definitions'] = [{'field_name': 'pa_fire-barrier', 'label': 'Fire Barrier'}]
        for query in section['queries']:
            query['selected_options']['pa_fire-barrier'] = {'label': '100 mm concrete', 'is_all': False}
        self.build()
        fields = self.item()['fields']
        self.assertEqual([field['value'] for field in fields if field['label'] == 'Substrate (Selector Search)'],
                         ['100 mm concrete'])
        table = next(field['table'] for field in fields if field['label'] == 'Selector Search Context')
        self.assertIn('Fire Barrier', table['columns'])
        section['queries'][1]['selected_options']['pa_fire-barrier']['label'] = '200 mm concrete'
        different = self.root / 'different'
        self.build(output=different)
        item = next(item for item in self.data(different)['libraries']['technical']['items']
                    if item['id'] == 'trafalgar-selector-11')
        self.assertNotIn('Substrate (Selector Search)', [field['label'] for field in item['fields']])

    def test_existing_data_and_source_assets_remain_exact(self):
        self.build()
        actual = self.data()
        for name in ('links', 'coverage', 'firestopping'):
            self.assertEqual(actual[name], self.base_data[name])
        self.assertEqual(actual['libraries']['penetration'], self.base_data['libraries']['penetration'])
        self.assertEqual(actual['libraries']['technical']['items'][0], self.base_data['libraries']['technical']['items'][0])
        self.assertEqual(actual['documents'][0], self.base_data['documents'][0])
        self.assertEqual(actual['images'][0], self.base_data['images'][0])
        self.assertEqual((self.output / 'documents/foreign-report.pdf').read_bytes(), self.pdf)
        self.assertEqual((self.output / 'images/foreign-image.png').read_bytes(), self.image)
        self.assertEqual(ReferenceLibrary(self.output).overview()['libraries'][1]['count'], 4)

    def test_rerun_is_idempotent_and_imported_base_replaces_only_owned_records(self):
        first = self.build()
        before = (self.output / 'library.json').read_bytes()
        second = self.build()
        self.assertFalse(first['unchanged'])
        self.assertTrue(second['unchanged'])
        self.assertEqual(second['index_sha256'], first['index_sha256'])
        self.assertEqual((self.output / 'library.json').read_bytes(), before)
        next_output = self.root / 'next-output'
        third = self.build(base=self.output, output=next_output)
        self.assertEqual(third['index_sha256'], first['index_sha256'])
        self.assertEqual((next_output / 'library.json').read_bytes(), before)

    def test_multiple_pages_keep_all_images_and_do_not_propagate_unscoped_variants(self):
        second = deepcopy(self.document['pages'][0])
        second.update(page=2, image_filename=second['image_filename'].replace('p0001', 'p0002'),
                      text='A different service variant and FRL.')
        (self.prepared / second['image_filename']).write_bytes(self.image)
        self.document['pages'].append(second)
        self.document['fields'].extend([
            {'label': 'Scoped protection', 'value': 'Exact record condition', 'source_product_ids': [11]},
            {'label': 'Other variant', 'value': 'Must not propagate', 'source_product_ids': [999]},
            {'label': 'Variant table', 'value': 'Use the matching source option.', 'scope': 'reference'}])
        self.build()
        item = self.item()
        self.assertEqual(len(next(field['images'] for field in item['fields'] if field['label'] == 'Refer Figure')), 2)
        self.assertEqual([source['page'] for source in item['sources']], [1, 2])
        labels = [field['label'] for field in item['fields']]
        self.assertIn('Scoped protection', labels)
        self.assertIn('Variant table (Source Reference)', labels)
        for omitted in ('Protection', 'Other variant', 'Source Diagram Details'):
            self.assertNotIn(omitted, labels)
        source = self.data()[IMPORT_KEY]['source_documents']['d-one']
        self.assertEqual(source['pages'][1]['text'], 'A different service variant and FRL.')
        self.assertTrue(any('Page 2 (contains source alternatives' in field['label']
                            and field['value'] == 'A different service variant and FRL.' for field in item['fields']))

    def test_ocr_text_and_reviewed_enrichment_retain_source_scope(self):
        ocr = {'images': [{'image_sha256': digest(self.image), 'status': 'ocr_complete',
                          'text': 'Unverified OCR suggests -/999/999.', 'confidence': 72}]}
        (self.prepared / 'ocr-index.json').write_bytes(json_bytes(ocr))
        enrichment = {'documents': [{'document_id': 'D-ONE', 'fields': [
            {'label': 'Drawing callout', 'value': 'Check the drawing callout.', 'scope': 'reference'}],
            'review_notes': ['Review remains incomplete.']}]}
        (self.prepared / 'document-enrichment.json').write_bytes(json_bytes(enrichment))
        self.build()
        fields = self.item()['fields']
        transcript = next(field for field in fields if '(OCR; check diagram)' in field['label'])
        self.assertIn('Unverified OCR suggests -/999/999.', transcript['value'])
        self.assertIn('confidence: 72', transcript['value'])
        self.assertEqual([field['value'] for field in fields if field['label'] == 'FRL'], ['-/60/60'])
        self.assertIn('Drawing callout (Source Reference)', [field['label'] for field in fields])
        self.assertEqual(self.data()[IMPORT_KEY]['ocr_evidence'], ocr)

    def test_duplicate_product_ids_fail_without_output(self):
        self.capture['sections'][0]['records'].append(deepcopy(self.capture['sections'][0]['records'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate source product ID'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_foreign_namespace_collision_is_not_overwritten(self):
        self.base_data['libraries']['technical']['items'][0]['id'] = 'trafalgar-selector-11'
        self.base_data['links'][0]['technical_id'] = 'trafalgar-selector-11'
        with self.assertRaisesRegex(ValueError, 'foreign record'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_missing_prepared_bytes_and_altered_bytes_fail_without_output(self):
        path = self.prepared / self.document['pages'][0]['image_filename']
        path.write_bytes(self.image + b'changed')
        with self.assertRaisesRegex(ValueError, 'fingerprint mismatch'):
            self.build()
        self.assertFalse(self.output.exists())
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_missing_query_association_and_manifest_capture_mismatch_fail(self):
        self.capture['sections'][0]['queries'][0]['record_ids'].remove('R-11')
        with self.assertRaisesRegex(ValueError, 'does not contain source record'):
            self.build()
        self.write_sources()
        manifest = deepcopy(self.manifest)
        manifest['metadata']['source_capture_sha256'] = '0' * 64
        self.manifest_path.write_bytes(json_bytes(manifest))
        with self.assertRaisesRegex(ValueError, 'different selector capture'):
            build_bundle(self.capture_path, self.manifest_path, self.prepared, self.base, self.output)

    def test_wrong_prepared_capture_manifest_or_source_hash_are_rejected(self):
        self.document_index['source_capture_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'prepared document index.*different selector capture'):
            self.build()
        del self.document_index['source_capture_sha256']
        self.document_index['manifest_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'different source manifest'):
            self.build()
        del self.document_index['manifest_sha256']
        self.manifest['documents'][0]['file_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'source hash disagrees'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_unsupported_category_is_rejected(self):
        self.capture['sections'][0]['category'] = 'unrelated-products'
        with self.assertRaisesRegex(ValueError, 'unsupported selector category'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_output_is_not_replaced_when_content_has_changed(self):
        self.build()
        before = (self.output / 'library.json').read_bytes()
        self.capture['sections'][0]['records'][0]['recommendation'] = 'Changed source'
        with self.assertRaisesRegex(ValueError, 'different content'):
            self.build()
        self.assertEqual((self.output / 'library.json').read_bytes(), before)
        self.assertFalse(list(self.root.glob('.trafalgar-build-*')))


if __name__ == '__main__':
    unittest.main()
