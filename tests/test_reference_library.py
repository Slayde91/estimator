"""Synthetic library fixtures: no supplier documents or workbook content in Git."""

from copy import deepcopy
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceLibrary, ReferenceNotFound
from estimator.server import create_server
from scripts.install_reference_library import install


def sample_library(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'documents').mkdir(exist_ok=True)
    (root / 'images').mkdir(exist_ok=True)
    pdf = b'%PDF-1.4\nSynthetic reference bytes for transport checks.\n%%EOF'
    png = b'\x89PNG\r\n\x1a\nSynthetic image transport bytes'
    (root / 'documents/report-a.pdf').write_bytes(pdf)
    (root / 'images/diagram-a.png').write_bytes(png)
    data = {'schema_version': 1, 'notice': 'References retain their source conditions.',
            'documents': [{'id': 'report-a', 'filename': 'Sample report.pdf', 'sha256': hashlib.sha256(pdf).hexdigest(), 'pages': 2}],
            'images': [{'id': 'diagram-a', 'filename': 'image1.png', 'extension': '.png', 'sha256': hashlib.sha256(png).hexdigest()}],
            'libraries': {'penetration': {'filters': [{'key': 'manufacturer', 'label': 'Manufacturer'}], 'items': [
                {'id': 'pkb-001', 'title': 'PKB-001', 'subtitle': 'Copper service', 'summary': 'Example installation', 'source_label': 'Workbook · CALC row 4',
                 'fields': [{'label': 'Description', 'value': '<script>literal source text</script>'}, {'label': 'Installation', 'value': 'Apply sample sealant around copper pipe.'}],
                 'sources': [{'label': 'CALC row 4', 'filename': 'Example.xlsb', 'sheet': 'CALC', 'row': 4}],
                 'images': [{'id': 'diagram-a', 'caption': 'Original workbook diagram'}], 'filter_values': {'manufacturer': ['Sample manufacturer']}},
                {'id': 'pkb-002', 'title': 'PKB-002', 'summary': 'No supplied report', 'filter_values': {'manufacturer': ['Other manufacturer']}}]},
                'technical': {'filters': [{'key': 'report', 'label': 'Report'}], 'items': [
                    {'id': 'report-a-v1', 'title': 'V1 — Copper service', 'subtitle': 'Sample report · revision 2',
                     'sources': [{'label': 'Table 1, PDF page 2', 'filename': 'Sample report.pdf', 'document_id': 'report-a', 'page': 2}],
                     'fields': [{'label': 'System', 'value': 'V1'}], 'filter_values': {'report': ['Sample report']}}]}},
            'links': [{'penetration_id': 'pkb-001', 'technical_id': 'report-a-v1', 'relationship': 'Matching installation text; check report conditions.'}]}
    (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
    return data, pdf, png


class ReferenceLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'library'
        self.data, self.pdf, self.png = sample_library(self.root)
        self.library = ReferenceLibrary(self.root)

    def write(self, data):
        (self.root / 'library.json').write_text(json.dumps(data), encoding='utf-8')

    def test_missing_library_has_usable_empty_state(self):
        library = ReferenceLibrary(self.root / 'absent')
        self.assertFalse(library.overview()['libraries'][0]['available'])
        self.assertEqual(library.listing('technical')['items'], [])
        with self.assertRaises(ReferenceNotFound):
            library.detail('technical', 'missing')

    def test_unreadable_library_index_is_a_bounded_validation_error(self):
        with patch('estimator.reference_library.Path.stat', side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(ValidationError, 'could not be read'):
                self.library.overview()

    def test_search_filters_pagination_and_source_preservation(self):
        self.assertEqual(self.library.listing('penetration', search='COPPER sealant')['total'], 1)
        self.assertEqual(self.library.listing('penetration', manufacturer='Other manufacturer')['items'][0]['id'], 'pkb-002')
        self.assertEqual(self.library.listing('penetration', offset='1', limit='1')['items'][0]['id'], 'pkb-002')
        item = self.library.detail('penetration', 'pkb-001')
        self.assertEqual(item['fields'][0]['value'], '<script>literal source text</script>')
        self.assertEqual(item['sources'][0]['row'], 4)
        item['fields'].clear()
        self.assertEqual(len(self.library.detail('penetration', 'pkb-001')['fields']), 2)

    def test_one_edge_is_reciprocal_and_unmatched_rows_stay_unlinked(self):
        left = self.library.detail('penetration', 'pkb-001')['links'][0]
        right = self.library.detail('technical', left['id'])['links'][0]
        self.assertEqual((left['kind'], right['kind'], right['id']), ('technical', 'penetration', 'pkb-001'))
        self.assertEqual(left['relationship'], right['relationship'])
        self.assertEqual(self.library.detail('penetration', 'pkb-002')['links'], [])

    def test_invalid_edges_duplicate_ids_and_page_references_are_rejected(self):
        mutations = [
            lambda d: d['links'][0].update(technical_id='missing'),
            lambda d: d['links'].append(deepcopy(d['links'][0])),
            lambda d: d['libraries']['penetration']['items'].append(deepcopy(d['libraries']['penetration']['items'][0])),
            lambda d: d['libraries']['technical']['items'][0]['sources'][0].update(page=3),
            lambda d: d['libraries']['technical']['items'][0]['sources'][0].update(document_id='diagram-a'),
            lambda d: d['images'][0].update(extension='.svg'),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                invalid = deepcopy(self.data)
                mutate(invalid)
                self.write(invalid)
                with self.assertRaises(ValidationError):
                    ReferenceLibrary(self.root).overview()

    def test_bad_queries_and_path_references_cannot_escape_library(self):
        for query in ({'limit': '0'}, {'limit': '101'}, {'offset': '-1'}, {'limit': 'inf'}, {'unknown': 'x'}, {'search': 'a' * 501}):
            with self.subTest(query=query), self.assertRaises(ValidationError):
                self.library.listing('penetration', **query)
        for key in ('../private', 'C:/secret', 'x\\y', 'report-a.pdf', 'a\n'):
            with self.subTest(key=key), self.assertRaises(ValidationError):
                self.library.asset(key)
        with self.assertRaises(ReferenceNotFound):
            self.library.asset('diagram-a')

    def test_asset_fingerprints_fail_closed_and_local_index_refreshes(self):
        self.assertEqual(self.library.asset('report-a')[0], self.pdf)
        self.assertEqual(self.library.asset('diagram-a', False)[0], self.png)
        (self.root / 'documents/report-a.pdf').write_bytes(self.pdf.replace(b'Synthetic', b'Modified!'))
        with self.assertRaisesRegex(ValidationError, 'changed'):
            self.library.asset('report-a')
        self.data['libraries']['penetration']['items'][1]['title'] = 'Updated source title'
        self.write(self.data)
        self.assertEqual(self.library.detail('penetration', 'pkb-002')['title'], 'Updated source title')

    def test_diagrams_remain_attached_to_their_source_table_field(self):
        field = {'label': 'Installation concept', 'value': '',
                 'images': [{'id': 'diagram-a', 'caption': 'Table cell, page 2'}]}
        self.data['libraries']['technical']['items'][0]['fields'].append(field)
        self.write(self.data)
        actual = self.library.detail('technical', 'report-a-v1')['fields'][-1]
        self.assertEqual(actual, field)
        self.assertEqual(self.library.asset(actual['images'][0]['id'], False)[0], self.png)
        for invalid in ('missing', 'report-a'):
            self.data['libraries']['technical']['items'][0]['fields'][-1]['images'][0]['id'] = invalid
            self.write(self.data)
            with self.assertRaises(ValidationError):
                ReferenceLibrary(self.root).overview()

    def test_embedded_source_tables_preserve_row_pairings_and_search(self):
        field = {'label': 'Service', 'value': '', 'table': {
            'columns': ['Service', 'Wrap', 'FRL'],
            'rows': [['Small', '600 mm', '120'], ['Small', '750 mm', '180']]}}
        self.data['libraries']['technical']['items'][0]['fields'].append(field)
        self.write(self.data)
        self.assertEqual(self.library.detail('technical', 'report-a-v1')['fields'][-1], field)
        self.assertEqual(self.library.listing('technical', search='750')['total'], 1)
        field['table']['rows'][0].pop()
        self.write(self.data)
        with self.assertRaises(ValidationError):
            ReferenceLibrary(self.root).overview()

    def test_asset_symlinks_outside_the_library_are_not_served(self):
        target = Path(self.temp.name) / 'outside.pdf'
        target.write_bytes(self.pdf)
        link = self.root / 'documents/report-a.pdf'
        link.unlink()
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest('This account cannot create symbolic links.')
        with self.assertRaisesRegex(ValidationError, 'outside'):
            self.library.asset('report-a')

    def test_installation_copies_verified_assets_and_retains_previous_bundle(self):
        destination = Path(self.temp.name) / 'installed'
        receipt = install(self.root, destination)
        self.assertTrue(receipt['installed'])
        self.assertEqual(receipt['assets'], 2)
        self.assertEqual(ReferenceLibrary(destination).asset('report-a')[0], self.pdf)
        before = (destination / 'library.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'already installed'):
            install(self.root, destination)
        self.data['libraries']['penetration']['items'][0]['title'] = 'Reviewed update'
        self.write(self.data)
        receipt = install(self.root, destination, replace=True)
        self.assertEqual((Path(receipt['backup']) / 'library.json').read_bytes(), before)
        self.assertEqual(ReferenceLibrary(destination).detail('penetration', 'pkb-001')['title'], 'Reviewed update')
        self.assertFalse(list(destination.parent.glob('.reference-library-*')))

    def test_installation_does_not_expand_valid_index_past_reader_limit(self):
        compact = (json.dumps(self.data, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        (self.root / 'library.json').write_bytes(compact)
        limit = len(compact)
        self.assertGreater(len(json.dumps(self.data, ensure_ascii=False, indent=2).encode('utf-8')), limit)
        destination = Path(self.temp.name) / 'installed'
        with patch('estimator.reference_library.MAX_INDEX', limit):
            receipt = install(self.root, destination)
            self.assertTrue(receipt['installed'])
            self.assertEqual(ReferenceLibrary(destination).asset('report-a')[0], self.pdf)
        self.assertLessEqual((destination / 'library.json').stat().st_size, limit)
        self.assertEqual(json.loads((destination / 'library.json').read_bytes()), self.data)

    def test_installation_refuses_changed_assets_without_disturbing_destination(self):
        destination = Path(self.temp.name) / 'installed'
        install(self.root, destination)
        original = (destination / 'library.json').read_bytes()
        (self.root / 'documents/report-a.pdf').write_bytes(self.pdf + b'altered')
        with self.assertRaisesRegex(ValidationError, 'changed'):
            install(self.root, destination, replace=True)
        self.assertEqual((destination / 'library.json').read_bytes(), original)
        self.assertEqual(ReferenceLibrary(destination).asset('report-a')[0], self.pdf)
        self.assertFalse(list(destination.parent.glob('.reference-library-*')))
        with self.assertRaisesRegex(ValueError, 'separate'):
            install(self.root, self.root)


class ReferenceLibraryApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.data, cls.pdf, cls.png = sample_library(cls.root / 'library')
        cls.server = create_server(0, cls.root / 'test.sqlite3', library_directory=cls.root / 'library')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, path, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=15)
        try:
            connection.request('GET', path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_navigation_and_bidirectional_links(self):
        status, _, body = self.request('/api/libraries')
        self.assertEqual(status, 200)
        self.assertEqual([item['count'] for item in json.loads(body)['libraries']], [2, 1])
        status, _, body = self.request('/api/libraries/penetration?search=copper&limit=1')
        self.assertEqual(status, 200)
        item = json.loads(body)['items'][0]
        status, _, body = self.request('/api/libraries/penetration/' + item['id'])
        linked = json.loads(body)['links'][0]
        status, _, body = self.request('/api/libraries/' + linked['kind'] + '/' + linked['id'])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['links'][0]['id'], item['id'])

    def test_pdf_ranges_and_original_bytes(self):
        route = '/api/libraries/documents/report-a.pdf'
        status, headers, body = self.request(route)
        self.assertEqual((status, body), (200, self.pdf))
        self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertTrue(headers['Content-Disposition'].startswith('inline;'))
        for span, expected in [('bytes=0-4', self.pdf[:5]), ('bytes=-5', self.pdf[-5:]), ('bytes=5-', self.pdf[5:])]:
            with self.subTest(span=span):
                status, headers, body = self.request(route, {'Range': span})
                self.assertEqual((status, body), (206, expected))
                self.assertIn('Content-Range', headers)
        for span in ('bytes=9999-', 'bytes=10-1', 'bytes=0-1,4-5', 'bytes=-0', 'nonsense'):
            self.assertEqual(self.request(route, {'Range': span})[0], 416)
        self.assertEqual(self.request('/api/libraries/images/diagram-a')[2], self.png)

    def test_origin_queries_and_unknown_references_are_rejected(self):
        self.assertEqual(self.request('/api/libraries', {'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request('/api/libraries', {'Host': 'example.com'})[0], 403)
        for route in ('/api/libraries/penetration?search=a&search=b', '/api/libraries/technical?limit=999'):
            self.assertEqual(self.request(route)[0], 400)
        for route in ('/api/libraries/technical/missing', '/api/libraries/documents/missing.pdf', '/api/libraries/documents/../private.pdf', '/api/libraries/images/report-a'):
            self.assertEqual(self.request(route)[0], 404)


if __name__ == '__main__':
    unittest.main()
