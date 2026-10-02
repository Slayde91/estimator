"""Portable physical drafts retain typed history without importing authority."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_model import (audit_affected, audit_state_digest, new_snapshot,
                                    upgrade_snapshot, validate_snapshot)
from estimator.takeoff_physical_operations import prepare_changes
from estimator.takeoff_physical import new_graph


class PhysicalPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.documents = TakeoffDocuments(Path(self.temp.name) / 'evidence')
        self.addCleanup(self.documents.close)
        self.initial = new_snapshot()
        self.document = {'id': str(uuid4()), 'name': 'synthetic.pdf', 'sha256': '1' * 64,
                         'size': 100, 'pages': [{'page': 1, 'width': 200, 'height': 200,
                         'view': [10, 10, 210, 210], 'media_box': [10, 10, 210, 210],
                         'crop_box': [10, 10, 210, 210], 'rotation': 0, 'user_unit': 1}]}
        self.base = deepcopy(self.initial)
        self.base['documents'] = [self.document]
        self.base = self.record(self.initial, self.base, 'add_document')
        self.command = {'op': 'create', 'kind': 'barrier', 'entity': {
            'id': str(uuid4()), 'fields': {'label': 'Barrier A', 'substrate': 'Concrete'},
            'evidence': [{'document_id': self.document['id'], 'document_sha256': '1' * 64,
                          'page': 1, 'region': [[10, 10], [100, 10], [100, 100]]}],
            'uncertainty': {'state': 'not_assessed', 'note': ''}}}

    def record(self, before, after, op):
        after = deepcopy(after)
        after['revision'] = before['revision'] + 1
        strip = lambda state: {key: value for key, value in state.items() if key != 'audit_head'}
        event = {'version': after['version'], 'project_id': before['project_id'],
                 'revision': after['revision'], 'previous': before['audit_head'],
                 'request_id': str(uuid4()), 'op': op, 'at': '2026-09-29T00:00:00Z',
                 'actor': {'kind': 'local-session', 'session_id': str(uuid4())},
                 'before': strip(before), 'after': strip(after),
                 'affected_ids': audit_affected(before, after)}
        after['audit_head'] = self.documents.put_blob(event)
        return after

    def physical(self):
        upgraded = upgrade_snapshot(self.base)
        legacy = {**upgraded, 'physical': new_graph(self.base['project_id'], version=1)}
        upgraded['physical'] = prepare_changes(legacy, [self.command])['graph']
        return self.record(self.base, upgraded, 'apply_physical')

    def descriptor(self):
        return {'id': str(uuid4()), 'document_id': self.document['id'], 'source_sha256': '1' * 64,
                'manifest_sha256': '2' * 64, 'manifest_size': 100, 'total_bytes': 150, 'pages': [1]}

    def test_explicit_upgrade_preserves_original_schema_and_audit_bytes(self):
        legacy = deepcopy(self.base)
        original = (self.documents.root / 'audit' / (legacy['audit_head'] + '.json')).read_bytes()
        current = self.physical()
        validate_snapshot(current)
        self.documents.validate_audit(current)
        self.assertEqual(self.base, legacy)
        self.assertEqual(self.base['version'], 1)
        self.assertNotIn('physical', self.base)
        self.assertEqual(current['version'], 2)
        self.assertEqual(current['physical']['state'], 'draft')
        self.assertEqual(current['physical']['services'], [])
        self.assertEqual((self.documents.root / 'audit' / (legacy['audit_head'] + '.json')).read_bytes(), original)
        event = self.documents.get_blob(current['audit_head'])
        self.assertEqual(event['affected_ids']['physical'], [self.command['entity']['id']])
        self.assertEqual(event['affected_ids']['image_extractions'], [])
        self.assertEqual(audit_state_digest(event['after']), audit_state_digest(current))

    def test_portable_graph_cannot_claim_approval_or_rewrite_source_identity(self):
        current = self.physical()
        for path, value in ((('physical', 'state'), 'approved'),
                            (('physical', 'project_id'), str(uuid4())),
                            (('physical', 'lock'), {'status': 'approved'})):
            invalid = deepcopy(current)
            invalid[path[0]][path[1]] = value
            with self.subTest(path=path), self.assertRaises(ValidationError):
                validate_snapshot(invalid)
        for change in ({'document_sha256': '3' * 64}, {'page': 2},
                       {'region': [[0, 0], [100, 10], [100, 100]]}):
            invalid = deepcopy(current)
            invalid['physical']['barriers'][0]['evidence'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValidationError):
                validate_snapshot(invalid)

    def test_schema_fields_and_extraction_budget_require_exact_types(self):
        current = self.physical()
        current['image_extractions'] = [self.descriptor()]
        validate_snapshot(current)
        for change in ({'source_sha256': '3' * 64}, {'pages': [True]}, {'pages': [2]},
                       {'total_bytes': True}, {'manifest_size': 0}, {'approved': True}):
            invalid = deepcopy(current)
            invalid['image_extractions'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValidationError):
                validate_snapshot(invalid)
        invalid = deepcopy(current)
        invalid['image_extractions'].append(deepcopy(invalid['image_extractions'][0]))
        with self.assertRaisesRegex(ValidationError, 'unique'):
            validate_snapshot(invalid)
        for removed in ('physical', 'image_extractions'):
            invalid = deepcopy(current); del invalid[removed]
            with self.assertRaises(ValidationError):
                validate_snapshot(invalid)
        invalid = deepcopy(current); invalid['version'] = 1
        with self.assertRaises(ValidationError):
            validate_snapshot(invalid)

    def test_upgrade_and_downgrade_cannot_hide_in_unrelated_audit_operations(self):
        current = self.physical()
        original = self.documents.get_blob(current['audit_head'])
        for changes in ({'op': 'record_render'}, {'version': 1}):
            event = {**deepcopy(original), **changes}
            invalid = {**current, 'audit_head': self.documents.put_blob(event)}
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.documents.validate_audit(invalid)
        event = deepcopy(original); del event['actor']; del event['affected_ids']
        with self.assertRaisesRegex(ValidationError, 'attribution'):
            self.documents.validate_audit({**current, 'audit_head': self.documents.put_blob(event)})
        downgraded = deepcopy(self.base)
        event_state = self.record(current, downgraded, 'undo')
        with self.assertRaises(ValidationError):
            self.documents.validate_audit(event_state)

    def test_audit_retains_all_extraction_descriptors_and_detects_rewritten_ids(self):
        current = self.physical()
        with_image = deepcopy(current); with_image['image_extractions'] = [self.descriptor()]
        with_image = self.record(current, with_image, 'extract_images')
        current_only = deepcopy(with_image); current_only['image_extractions'] = []
        current_only = self.record(with_image, current_only, 'diagnostic_history_test')
        documents, audit, images = self.documents._graph(current_only, self.documents._audit_record)
        self.assertEqual(documents, [self.document])
        self.assertEqual(len(audit), 4)
        self.assertEqual(images, with_image['image_extractions'])
        rewritten = deepcopy(with_image)
        rewritten['image_extractions'][0]['manifest_sha256'] = '4' * 64
        rewritten = self.record(with_image, rewritten, 'extract_images')
        with self.assertRaisesRegex(ValidationError, 'rewritten'):
            self.documents.validate_audit(rewritten)

    def test_tampered_old_version_one_segment_blocks_version_two_chain(self):
        current = self.physical()
        self.documents.validate_audit(current)
        (self.documents.root / 'audit' / (self.base['audit_head'] + '.json')).write_bytes(b'{}')
        with self.assertRaisesRegex(ValidationError, 'hash has changed'):
            self.documents.validate_audit(current)


if __name__ == '__main__':
    unittest.main()
