"""Illustration derivatives cannot replace or bypass verified source evidence."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.reference_library import ReferenceLibrary, ReferenceNotFound
from test_reference_library import sample_library


class ReplicaTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name) / 'library'
        self.data, _, self.source = sample_library(self.root)
        self.library = ReferenceLibrary(self.root)
        self.replica = b'\x89PNG\r\n\x1a\nSynthetic reviewed derivative'
        self.folder = self.root / 'replicas'
        self.folder.mkdir()
        self.hash = hashlib.sha256(self.replica).hexdigest()
        self.file = self.folder / (self.hash + '.png')
        self.file.write_bytes(self.replica)
        self.entry = {'source_sha256': hashlib.sha256(self.source).hexdigest(),
            'file': self.file.name, 'sha256': self.hash, 'review': 'visual_review_passed'}
        self.write()

    def write(self):
        (self.folder / 'index.json').write_text(json.dumps({'version': 1, 'images': {'diagram-a': self.entry}}), encoding='utf-8')

    def test_reviewed_replica_and_original_have_separate_verified_endpoints(self):
        before = (self.root / 'library.json').read_bytes()
        detail = deepcopy(self.library.detail('penetration', 'pkb-001'))
        self.assertEqual(self.library.image_replicas(), {'diagram-a': self.entry})
        self.assertEqual(self.library.replica_asset('diagram-a')[:2], (self.replica, 'image/png'))
        self.assertEqual(self.library.display_asset('diagram-a')[0], self.replica)
        self.assertEqual(self.library.asset('diagram-a', False)[0], self.source)
        self.assertEqual(self.library.detail('penetration', 'pkb-001'), detail)
        self.assertEqual((self.root / 'library.json').read_bytes(), before)

    def test_unreviewed_stale_source_and_unsafe_entries_are_not_published(self):
        for change in ({'review': 'generated'}, {'source_sha256': '0' * 64},
                       {'file': '../source.png'}, {'sha256': 'bad'}):
            with self.subTest(change=change):
                original = deepcopy(self.entry)
                self.entry.update(change); self.write()
                self.assertEqual(self.library.image_replicas(), {})
                self.assertEqual(self.library.display_asset('diagram-a')[0], self.source)
                with self.assertRaises(ReferenceNotFound):
                    self.library.replica_asset('diagram-a')
                self.entry = original

    def test_changed_original_or_derivative_bytes_are_rejected(self):
        self.file.write_bytes(self.replica + b'changed')
        with self.assertRaisesRegex(ValidationError, 'changed after visual review'):
            self.library.replica_asset('diagram-a')
        self.file.write_bytes(self.replica)
        (self.root / 'images/diagram-a.png').write_bytes(self.source + b'changed')
        with self.assertRaisesRegex(ValidationError, 'source has changed'):
            self.library.replica_asset('diagram-a')

    def test_optional_missing_or_broken_registry_keeps_original_available(self):
        (self.folder / 'index.json').write_text('{invalid', encoding='utf-8')
        self.assertEqual(self.library.image_replicas(), {})
        self.assertEqual(self.library.asset('diagram-a', False)[0], self.source)
        self.assertEqual(self.library.display_asset('diagram-a')[0], self.source)
        (self.folder / 'index.json').unlink()
        self.assertEqual(self.library.image_replicas(), {})

    def test_archived_source_remains_verified_when_images_contains_sketch(self):
        archive = self.root / 'images_old'
        archive.mkdir()
        original = self.root / 'images/diagram-a.png'
        original.rename(archive / original.name)
        original.write_bytes(self.replica)
        self.assertEqual(self.library.asset('diagram-a', False)[0], self.source)
        self.assertEqual(self.library.replica_asset('diagram-a')[0], self.replica)
        (archive / original.name).write_bytes(self.source + b'changed')
        with self.assertRaisesRegex(ValidationError, 'source has changed'):
            self.library.replica_asset('diagram-a')

    def test_batch_installer_reuses_outputs_and_rejects_changed_sources_before_writing(self):
        from scripts.install_library_replicas import install
        manifest = self.root.parent / 'batch.json'
        job = {'status': 'generated_visual_review_passed', 'source_sha256': self.entry['source_sha256'],
            'aliases': ['diagram-a'], 'output': {'path': str(self.file), 'sha256': self.hash},
            'review': {'result': 'visual_review_passed', 'technical_approval': False,
                       'no_text': True, 'no_branding': True}}
        manifest.write_text(json.dumps({'jobs': [job]}), encoding='utf-8')
        before = (self.root / 'library.json').read_bytes()
        first = install(manifest, self.root)
        self.assertEqual(install(manifest, self.root), first)
        self.assertEqual(first, {'registered_source_ids': 1, 'unique_replica_files': 1})
        self.assertEqual((self.root / 'library.json').read_bytes(), before)
        registry_before = (self.folder / 'index.json').read_bytes()
        for field in ('no_text', 'no_branding'):
            for value in (None, False, 'true', 1):
                with self.subTest(field=field, value=value):
                    job['review'][field] = value
                    manifest.write_text(json.dumps({'jobs': [job]}), encoding='utf-8')
                    with self.assertRaisesRegex(ValidationError, 'no text and no branding'):
                        install(manifest, self.root)
                    self.assertEqual((self.folder / 'index.json').read_bytes(), registry_before)
            job['review'][field] = True
        job['source_sha256'] = '0' * 64
        manifest.write_text(json.dumps({'jobs': [job]}), encoding='utf-8')
        with self.assertRaisesRegex(ValidationError, 'source changed'):
            install(manifest, self.root)
        self.assertEqual((self.folder / 'index.json').read_bytes(), registry_before)
