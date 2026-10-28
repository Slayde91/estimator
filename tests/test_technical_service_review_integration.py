"""Private Services decisions affect discovery, never source or saved identity."""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

from estimator.firefly_reference_review import fingerprint
from estimator.reference_library import ReferenceLibrary
from estimator.technical_duplicates import review_fingerprint
from estimator.technical_service_review import PLAN_NAME, REVIEW_KEY, projection_fingerprint
from tests import test_reference_library as fixtures


class ServicesReviewIntegrationTests(unittest.TestCase):
    setUp = fixtures.ReferenceLibraryTests.setUp
    write = fixtures.ReferenceLibraryTests.write

    def prepare(self):
        source = self.data['libraries']['technical']['items'][0]
        source['fields'] += [
            {'label': 'Service', 'value': 'Metal pipe'},
            {'label': 'Service Size / Configuration', 'value': 'DN 50'},
            {'label': 'Installation Details', 'value': 'The penetrant is a copper pipe.'},
        ]
        self.write(self.data)
        before = self.library._load()
        key = source['id']
        plan = {
            'schema_version': 1, 'review_id': 'synthetic-services-review',
            'reviewed_index_sha256': hashlib.sha256((self.root / 'library.json').read_bytes()).hexdigest(),
            'items': [{'id': key, 'item_sha256': fingerprint(source),
                       'projection_sha256': projection_fingerprint(before['_technical_public_records'][key]),
                       'services': ['Copper Pipes'], 'evidence': [
                           {'field': 'Installation Details', 'quote': 'copper pipe',
                            'source_reference': 'Synthetic sample report, page 1'}]}],
        }
        return source, before, plan

    def save_plan(self, plan):
        directory = self.root / 'reviews'
        directory.mkdir(exist_ok=True)
        (directory / PLAN_NAME).write_text(json.dumps(plan), encoding='utf-8')

    def test_review_changes_only_discovery_services_and_preserves_source_and_links(self):
        source, before, plan = self.prepare()
        key = source['id']
        original_bytes = (self.root / 'library.json').read_bytes()
        original_record = deepcopy(before['_records']['technical'][key])
        original_public = deepcopy(before['_technical_public_records'][key])
        original_facets = deepcopy(before['_technical_discovery'][key])
        original_links = deepcopy(before['_links'])
        original_fingerprint = review_fingerprint(source, original_record, before['_assets'])
        self.save_plan(plan)
        after = self.library._load()
        self.assertIsNot(after, before)
        self.assertEqual(after['_technical_discovery'][key], {**original_facets, 'services': ['Copper Pipes']})
        self.assertEqual(after['_records']['technical'][key], original_record)
        self.assertEqual(after['_technical_public_records'][key], original_public)
        self.assertEqual(after['_links'], original_links)
        self.assertEqual((self.root / 'library.json').read_bytes(), original_bytes)
        self.assertEqual(review_fingerprint(source, after['_records']['technical'][key], after['_assets']),
                         original_fingerprint)
        self.assertEqual(self.library.listing('technical', services='Copper Pipes')['total'], 1)
        self.assertEqual(self.library.listing('technical', services='Unlagged Pipes')['total'], 0)

    def test_changed_private_plan_invalidates_the_loaded_services_cache(self):
        source, _, plan = self.prepare()
        self.save_plan(plan)
        first = self.library._load()
        plan['items'][0]['services'] = ['Steel Pipes']
        self.save_plan(plan)
        second = self.library._load()
        self.assertIsNot(first, second)
        self.assertEqual(second['_technical_discovery'][source['id']]['services'], ['Steel Pipes'])

    def test_imported_json_cannot_forge_a_validated_review_marker(self):
        forged = deepcopy(self.data)
        forged[REVIEW_KEY] = {'payload': '{}', 'sha256': 'a' * 64}
        with self.assertRaises(ValueError):
            self.library._validate(forged)

    def test_saved_overlay_cannot_reuse_a_different_review_capability(self):
        _, _, plan = self.prepare()
        self.save_plan(plan)
        loaded = self.library._load()
        copied = dict(loaded)
        self.assertTrue(self.library._same_technical_source(copied, loaded))
        copied[REVIEW_KEY] = None
        self.assertFalse(self.library._same_technical_source(copied, loaded))

    def test_install_preserves_private_review_after_safe_index_reserialization(self):
        _, _, plan = self.prepare()
        self.save_plan(plan)
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'install_reference_library.py'
        spec = importlib.util.spec_from_file_location('services_review_install_fixture', script)
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        destination = self.root.parent / 'installed-services-review'
        result = installer.install(self.root, destination)
        self.assertTrue(result['installed'])
        self.assertTrue((destination / 'reviews' / PLAN_NAME).is_file())
        installed = ReferenceLibrary(destination)
        self.assertEqual(installed.listing('technical', services='Copper Pipes')['total'], 1)


if __name__ == '__main__':
    unittest.main()
