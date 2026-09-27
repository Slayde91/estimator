"""Synthetic naming checks; no supplier content is distributed with the app."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceLibrary
from scripts.name_trafalgar_diagrams import apply_names
from scripts.install_reference_library import install
from tests.test_reference_library import sample_library


class DiagramNamesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle, _, _ = sample_library(self.root)
        self.jpeg = b'\xff\xd8\xffSynthetic JPEG transport bytes'
        self.key = 'trafalgar-image-test-p0001'
        self.asset = {'id': self.key, 'extension': '.jpg', 'filename': 'D-abc.jpg',
                      'sha256': hashlib.sha256(self.jpeg).hexdigest()}
        self.bundle['images'].append(self.asset)
        (self.root / 'images' / (self.key + '.jpg')).write_bytes(self.jpeg)
        self.bundle['trafalgar_selector_import'] = {'queries': {}, 'source_documents': {'example': {
            'source_filename': 'D-abc.jpg', 'pages': [
                {'registered_image_id': self.key, 'image_sha256': self.asset['sha256'], 'page': 1}]}}}
        self.item = self.bundle['libraries']['technical']['items'][0]
        self.item['fields'].append({'label': 'Installation concept', 'value': '',
                                    'images': [{'id': self.key, 'caption': 'D-abc.jpg — source page 1'}]})
        self.item['sources'] = [{'filename': 'D-abc.jpg', 'label': 'D-abc.jpg — source page 1',
                                 'sha256': self.asset['sha256']}]
        self.review = [{'id': self.key, 'sha256': self.asset['sha256'],
                        'basis': 'Drawing No.', 'name': 'AB 5', 'filename': 'AB 5.jpg'}]

    def library(self, bundle):
        (self.root / 'library.json').write_text(json.dumps(bundle), encoding='utf-8')
        return ReferenceLibrary(self.root)

    def test_names_project_without_changing_source_data_or_image_links(self):
        original = deepcopy(self.bundle)
        named = apply_names(self.bundle, self.review)
        self.assertEqual(self.bundle, original)
        self.assertEqual(named['libraries'], original['libraries'])
        self.assertEqual(named['links'], original['links'])
        library = self.library(named)
        item = library.detail('technical', self.item['id'])
        figures = next(f for f in item['fields'] if f['label'] == 'Diagrams & Figures')
        self.assertEqual(figures['images'][0]['id'], self.key)
        self.assertEqual(figures['images'][0]['caption'], 'AB 5.jpg')
        self.assertEqual(figures['images'][0]['captions'], ['AB 5.jpg'])
        self.assertEqual(item['sources'][0]['label'], 'AB 5.jpg')
        self.assertEqual(item['sources'][0]['sha256'], self.asset['sha256'])
        self.assertEqual(item['technical_basis']['source_fields'], self.item['fields'])
        self.assertEqual(library.asset(self.key, False), (self.jpeg, 'image/jpeg', 'AB 5.jpg'))
        self.assertEqual(library.asset('diagram-a', False)[2], 'diagram-a.png')
        self.assertEqual(library.listing('technical', search='AB 5.jpg')['total'], 1)

    def test_page_specific_names_do_not_rename_other_pages_or_pdf_downloads(self):
        named = apply_names(self.bundle, self.review)
        named['images'][-1]['drawing_identity']['sources'] = [{'filename': 'Sample report.pdf', 'page': 2}]
        named['libraries']['technical']['items'][0]['sources'] = [
            {'filename': 'Sample report.pdf', 'label': 'First page', 'document_id': 'report-a', 'page': 1},
            {'filename': 'Sample report.pdf', 'label': 'Second page', 'document_id': 'report-a', 'page': 2}]
        library = self.library(named)
        sources = library.detail('technical', self.item['id'])['sources']
        self.assertEqual([s['label'] for s in sources], ['First page', 'AB 5.jpg'])
        self.assertEqual([s['page'] for s in sources], [1, 2])
        self.assertEqual(library.asset('report-a')[2], 'report-a.pdf')

    def test_incomplete_duplicate_or_stale_reviews_fail_closed(self):
        for review in ([], self.review * 2, [{**self.review[0], 'sha256': '0' * 64}]):
            with self.subTest(review=review), self.assertRaises(ValueError):
                apply_names(self.bundle, review)

    def test_unsafe_download_names_are_rejected_on_import_and_runtime_load(self):
        for filename in ('../AB.jpg', 'AB/5.jpg', 'AB\\5.jpg', 'AB\r\nX: y.jpg',
                         'AB".jpg', 'CON.jpg', 'AB.svg', 'AB.jpg\n'):
            with self.subTest(filename=filename):
                with self.assertRaises(ValueError):
                    apply_names(self.bundle, [{**self.review[0], 'filename': filename}])
                named = apply_names(self.bundle, self.review)
                named['images'][-1]['filename'] = filename
                with self.assertRaises(ValidationError):
                    self.library(named).overview()

    def test_name_collisions_and_conflicting_page_aliases_fail_closed(self):
        for duplicate_filename in (True, False):
            named = apply_names(self.bundle, self.review)
            other = deepcopy(named['images'][-1])
            other['id'] += '-other'
            if duplicate_filename:
                other['filename'] = 'ab 5.jpg'
                other['drawing_identity']['sources'][0]['filename'] = 'other.jpg'
            else:
                other['filename'] = 'AB 6.jpg'
            named['images'].append(other)
            with self.subTest(duplicate_filename=duplicate_filename), self.assertRaises(ValidationError):
                self.library(named).overview()

    def test_named_image_still_requires_matching_asset_bytes(self):
        library = self.library(apply_names(self.bundle, self.review))
        (self.root / 'images' / (self.key + '.jpg')).write_bytes(self.jpeg + b'changed')
        with self.assertRaisesRegex(ValidationError, 'changed'):
            library.asset(self.key, False)

    def test_bundle_install_preserves_storage_ids_and_download_names(self):
        self.library(apply_names(self.bundle, self.review))
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'installed'
            install(self.root, target)
            self.assertTrue((target / 'images' / (self.key + '.jpg')).is_file())
            self.assertEqual(ReferenceLibrary(target).asset(self.key, False),
                             (self.jpeg, 'image/jpeg', 'AB 5.jpg'))


if __name__ == '__main__':
    unittest.main()
