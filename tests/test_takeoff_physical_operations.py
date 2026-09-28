"""Draft batches are atomic, source-bound and incapable of granting approval."""

from copy import deepcopy
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import new_snapshot
from estimator.takeoff_physical_operations import current_graph, prepare_changes


class PhysicalOperationTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = new_snapshot()
        self.document_id = str(uuid4())
        self.snapshot['documents'] = [{'id': self.document_id, 'name': 'synthetic.pdf',
            'sha256': '1' * 64, 'size': 100, 'pages': [{'page': 1, 'width': 200,
                'height': 200, 'view': [10, 10, 210, 210], 'rotation': 0, 'user_unit': 1}]}]

    def create(self, kind='barrier', parent=None):
        entity = {'id': str(uuid4()), 'fields': {'label': 'Synthetic'}, 'evidence': [],
                  'uncertainty': {'state': 'not_assessed', 'note': ''}}
        if kind != 'barrier':
            entity[{'defect': 'barrier_id', 'opening': 'defect_id', 'service': 'opening_id'}[kind]] = parent
        if kind == 'service':
            entity['quantity'] = 1
        return {'op': 'create', 'kind': kind, 'entity': entity}

    def test_new_graph_identity_is_stable_but_does_not_mutate_snapshot(self):
        original = deepcopy(self.snapshot)
        first = current_graph(self.snapshot)
        self.assertEqual(first, current_graph(self.snapshot))
        self.assertEqual(self.snapshot, original)
        other = new_snapshot()
        self.assertNotEqual(first['id'], current_graph(other)['id'])

    def test_one_batch_creates_explicit_topology_and_empty_opening(self):
        barrier = self.create()
        defect = self.create('defect', barrier['entity']['id'])
        opening = self.create('opening', defect['entity']['id'])
        result = prepare_changes(self.snapshot, [barrier, defect, opening])
        self.assertEqual(result['graph']['services'], [])
        self.assertEqual(result['summary']['command_count'], 3)
        self.assertEqual(result['summary']['authority'], 'none')
        self.assertEqual(result['summary']['state'], 'draft')
        self.assertEqual(result['summary']['result_revision'], 3)
        self.assertNotIn('physical', self.snapshot)

    def test_late_failure_preserves_original_and_earlier_batch_changes(self):
        before = deepcopy(self.snapshot)
        with self.assertRaises(ValidationError):
            prepare_changes(self.snapshot, [self.create(), self.create('service', str(uuid4()))])
        self.assertEqual(self.snapshot, before)
        commands = [self.create() for _ in range(101)]
        with self.assertRaisesRegex(ValidationError, '100'):
            prepare_changes(self.snapshot, commands)
        self.assertEqual(self.snapshot, before)

    def test_source_hash_page_and_region_are_checked(self):
        command = self.create()
        ref = {'document_id': self.document_id, 'document_sha256': '1' * 64, 'page': 1,
               'region': [[10, 10], [100, 10], [100, 100]]}
        command['entity']['evidence'] = [ref]
        prepare_changes(self.snapshot, [command])
        for changes in ({'document_sha256': '2' * 64}, {'page': 2},
                        {'region': [[0, 0], [100, 10], [100, 100]]}):
            invalid = deepcopy(command)
            invalid['entity']['evidence'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                prepare_changes(self.snapshot, [invalid])

    def test_image_links_require_exact_retained_resolver(self):
        command = self.create()
        ref = {'document_id': self.document_id, 'document_sha256': '1' * 64, 'page': 1,
               'image_id': str(uuid4()), 'image_sha256': '2' * 64, 'occurrence_id': str(uuid4())}
        command['entity']['evidence'] = [ref]
        with self.assertRaisesRegex(ValidationError, 'verified'):
            prepare_changes(self.snapshot, [command])
        seen = []
        result = prepare_changes(self.snapshot, [command], lambda value: seen.append(deepcopy(value)))
        self.assertEqual(seen, [ref])
        self.assertEqual(result['summary']['state'], 'draft')

    def test_preview_binds_command_order_and_final_relationships(self):
        first, second = self.create(), self.create()
        defect = self.create('defect', first['entity']['id'])
        initial = prepare_changes(self.snapshot, [first, second, defect])['graph']
        self.snapshot['physical'] = initial
        move = {'op': 'reparent', 'entity_id': defect['entity']['id'], 'parent_id': second['entity']['id']}
        result = prepare_changes(self.snapshot, [move])
        link = result['summary']['relationships'][0]
        self.assertEqual(link['parent_before'], first['entity']['id'])
        self.assertEqual(link['parent_after'], second['entity']['id'])
        self.assertEqual(self.snapshot['physical'], initial)
        repeated = prepare_changes(self.snapshot, [move])
        self.assertEqual(repeated['summary'], result['summary'])


if __name__ == '__main__':
    unittest.main()
