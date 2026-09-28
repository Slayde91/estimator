"""Standalone physical topology tests; no evidence service or live data."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from uuid import UUID

from estimator.catalog import ValidationError
from estimator import takeoff_physical as physical


def uid(value):
    return str(UUID(int=value))


def proposal(kind, identifier, parent=None, *, fields=None, evidence=None, quantity=None):
    entity = {'id': uid(identifier), 'fields': fields or {}, 'evidence': evidence or [],
              'uncertainty': {'state': 'unresolved', 'note': 'Source interpretation pending'}}
    if kind in physical.PARENTS:
        entity[physical.PARENTS[kind][1]] = uid(parent)
    if kind == 'service':
        entity['quantity'] = quantity
    return {'op': 'create', 'kind': kind, 'entity': entity}


def evidence(*, occurrence=101, image=102, page=1, region=None):
    value = {'document_id': uid(100), 'document_sha256': 'a' * 64, 'page': page,
             'image_id': uid(image), 'image_sha256': 'b' * 64, 'occurrence_id': uid(occurrence),
             'note': 'Unverified original source association'}
    if region is not None:
        value['region'] = region
    return value


class PhysicalGraphTests(unittest.TestCase):
    def setUp(self):
        self.graph = physical.new_graph(uid(1000), uid(2000))

    def apply(self, command):
        preview = physical.preview_change(self.graph, command)
        before = deepcopy(self.graph)
        result = physical.apply_change(self.graph, command, expected_revision=self.graph['revision'],
                                       preview_digest=preview['preview_digest'])
        self.assertEqual(self.graph, before)
        self.assertEqual(result['change'], preview)
        self.assertEqual(physical.graph_digest(result['graph']), preview['result_digest'])
        self.graph = result['graph']
        return preview

    def add(self, kind, identifier, parent=None, **kwargs):
        return self.apply(proposal(kind, identifier, parent, **kwargs))

    def hierarchy(self, *, service=True):
        self.add('barrier', 1, fields={'substrate': 'Concrete', 'orientation': 'Horizontal'})
        self.add('defect', 2, 1, fields={'location': 'Level 1 grid A', 'frl': '120/120/120'})
        self.add('opening', 3, 2, fields={'opening_type': 'Corehole', 'size': 'Observed 100 mm'})
        if service:
            self.add('service', 4, 3, fields={'label': 'P-01', 'service': 'Pipe',
                     'service_type': 'Copper', 'size': '25 mm'}, quantity=2)

    def entity(self, identifier):
        return next(entity for name in physical.COLLECTIONS.values()
                    for entity in self.graph[name] if entity['id'] == uid(identifier))

    def assert_invalid(self, command, message=None):
        original = deepcopy(self.graph)
        with self.assertRaises(ValidationError) as error:
            physical.preview_change(self.graph, command)
        if message:
            self.assertIn(message, str(error.exception))
        self.assertEqual(self.graph, original)

    def test_empty_graph_is_explicit_draft_and_serializable(self):
        self.assertEqual(self.graph['state'], 'draft')
        self.assertEqual(self.graph['revision'], 0)
        self.assertEqual(physical.validate_graph(json.loads(json.dumps(self.graph))), self.graph)
        self.assertNotEqual(physical.new_graph(uid(1000))['id'], physical.new_graph(uid(1000))['id'])
        for identifier in ('', 'not-a-uuid', None, 2):
            with self.subTest(identifier=identifier), self.assertRaises(ValidationError):
                physical.new_graph(identifier, uid(2000))
        with self.assertRaises(ValidationError):
            physical.new_graph(uid(1000), '')

    def test_zero_service_opening_and_distinct_typed_fields_do_not_inherit(self):
        self.hierarchy(service=False)
        self.assertEqual(self.graph['services'], [])
        opening = self.entity(3)
        self.assertNotIn('quantity', opening)
        self.assertEqual(opening['fields'], {'opening_type': 'Corehole', 'size': 'Observed 100 mm'})
        self.assertNotIn('substrate', self.entity(2)['fields'])
        self.assertNotIn('frl', opening['fields'])
        self.assertEqual(physical.validate_graph(self.graph), self.graph)

    def test_unlike_services_share_opening_and_multiple_openings_share_defect(self):
        self.hierarchy()
        self.add('service', 5, 3, fields={'service': 'Cable', 'service_type': 'Cable bundle',
                 'size': '40 mm bundle'}, quantity=1)
        self.add('opening', 6, 2, fields={'opening_type': 'Oversized Opening', 'size': 'Unknown'})
        self.assertEqual([entry['opening_id'] for entry in self.graph['services']], [uid(3), uid(3)])
        self.assertEqual([entry['quantity'] for entry in self.graph['services']], [2, 1])
        self.assertEqual([entry['defect_id'] for entry in self.graph['openings']], [uid(2), uid(2)])

    def test_service_quantity_is_required_positive_integer_never_defaulted(self):
        self.hierarchy(service=False)
        for quantity in (None, 0, -1, True, 1.5, 1.0, '2', float('inf'), 10**400):
            with self.subTest(quantity=quantity):
                self.assert_invalid(proposal('service', 4, 3, quantity=quantity))
        missing = proposal('service', 4, 3, quantity=1)
        del missing['entity']['quantity']
        self.assert_invalid(missing)
        opening = proposal('opening', 5, 2)
        opening['entity']['quantity'] = 0
        self.assert_invalid(opening)

    def test_orphan_wrong_level_and_cycles_fail_exact_referential_integrity(self):
        self.hierarchy()
        for command in (proposal('defect', 5, 999), proposal('opening', 5, 1),
                        proposal('service', 5, 2, quantity=1),
                        {'op': 'reparent', 'entity_id': uid(2), 'parent_id': uid(2)},
                        {'op': 'reparent', 'entity_id': uid(2), 'parent_id': uid(4)},
                        {'op': 'reparent', 'entity_id': uid(1), 'parent_id': uid(3)}):
            with self.subTest(command=command):
                self.assert_invalid(command)
        bad = deepcopy(self.graph)
        bad['openings'][0]['defect_id'] = uid(999)
        with self.assertRaises(ValidationError):
            physical.validate_graph(bad)

    def test_ids_are_globally_unique_and_tombstone_ids_cannot_be_reused(self):
        self.hierarchy()
        self.assert_invalid(proposal('opening', 4, 2))
        self.apply({'op': 'delete', 'entity_id': uid(4), 'cascade': False})
        self.assert_invalid(proposal('service', 4, 3, quantity=1), 'cannot be reused')
        self.assert_invalid({'op': 'update', 'entity_id': uid(4), 'changes': {'quantity': 3}}, 'Restore')

    def test_preview_and_apply_are_deterministic_atomic_and_revision_guarded(self):
        command = proposal('barrier', 1, fields={'thickness_mm': 100.0})
        first = physical.preview_change(self.graph, command)
        self.assertEqual(first, physical.preview_change(self.graph, deepcopy(command)))
        self.assertEqual(first['changed_ids'], [uid(1)])
        self.assertEqual(first['preserved_ids'], [])
        self.assertEqual(first['authority'], 'none')
        before = deepcopy(self.graph)
        for revision, digest in ((1, first['preview_digest']), (False, first['preview_digest']),
                                 (0, '0' * 64), (0, [])):
            with self.subTest(revision=revision, digest=digest), self.assertRaises(ValidationError):
                physical.apply_change(self.graph, command, expected_revision=revision, preview_digest=digest)
            self.assertEqual(self.graph, before)
        changed = deepcopy(command); changed['entity']['fields']['thickness_mm'] = 101
        with self.assertRaises(ValidationError):
            physical.apply_change(self.graph, changed, expected_revision=0, preview_digest=first['preview_digest'])
        self.apply(command)
        self.assertEqual(self.entity(1)['revision'], 1)
        with self.assertRaises(ValidationError):
            physical.apply_change(self.graph, command, expected_revision=0, preview_digest=first['preview_digest'])

    def test_delete_preview_lists_descendants_and_preserves_all_tombstone_data(self):
        self.hierarchy()
        self.assert_invalid({'op': 'delete', 'entity_id': uid(2), 'cascade': False}, 'active descendants')
        before = deepcopy(self.graph)
        preview = self.apply({'op': 'delete', 'entity_id': uid(2), 'cascade': True})
        self.assertEqual(preview['changed_ids'], [uid(2), uid(3), uid(4)])
        self.assertEqual(preview['descendant_ids'], [uid(3), uid(4)])
        self.assertEqual(preview['preserved_ids'], [uid(2), uid(3), uid(4)])
        for identifier in (2, 3, 4):
            self.assertTrue(self.entity(identifier)['deleted'])
            self.assertEqual(self.entity(identifier)['deleted_at_revision'], self.graph['revision'])
        self.assertFalse(self.entity(1)['deleted'])
        for old, new in zip(before['services'], self.graph['services']):
            self.assertEqual(old['fields'], new['fields'])
            self.assertEqual(old['quantity'], new['quantity'])
            self.assertEqual(old['opening_id'], new['opening_id'])
        self.assertEqual(preview['relationships'][1]['parent_before'], uid(2))
        self.assertEqual(preview['relationships'][1]['parent_after'], uid(2))

    def test_restore_same_deletion_never_revives_previously_deleted_children(self):
        self.hierarchy()
        self.add('service', 5, 3, quantity=1)
        self.apply({'op': 'delete', 'entity_id': uid(4), 'cascade': False})
        earlier = deepcopy(self.entity(4))
        self.apply({'op': 'delete', 'entity_id': uid(2), 'cascade': True})
        preview = self.apply({'op': 'restore', 'entity_id': uid(2), 'mode': 'same_deletion'})
        self.assertEqual(preview['changed_ids'], [uid(2), uid(3), uid(5)])
        self.assertEqual(self.entity(4), earlier)
        for identifier in (2, 3, 5):
            self.assertFalse(self.entity(identifier)['deleted'])
            self.assertIsNone(self.entity(identifier)['deleted_at_revision'])
        self.assertEqual([entry['id'] for entry in self.graph['services']], [uid(4), uid(5)])

    def test_restore_leaf_and_explicit_selected_subset_require_active_parents(self):
        self.hierarchy()
        self.apply({'op': 'delete', 'entity_id': uid(2), 'cascade': True})
        self.assert_invalid({'op': 'restore', 'entity_id': uid(4), 'mode': 'leaf'}, 'deleted parent')
        self.assert_invalid({'op': 'restore', 'entity_id': uid(2), 'mode': 'selected',
                             'entity_ids': [uid(2), uid(4)]}, 'deleted parent')
        self.assert_invalid({'op': 'restore', 'entity_id': uid(2), 'mode': 'selected',
                             'entity_ids': [uid(2), uid(1)]})
        preview = self.apply({'op': 'restore', 'entity_id': uid(2), 'mode': 'selected',
                              'entity_ids': [uid(2), uid(3)]})
        self.assertEqual(preview['changed_ids'], [uid(2), uid(3)])
        self.assertTrue(self.entity(4)['deleted'])
        self.apply({'op': 'restore', 'entity_id': uid(4), 'mode': 'leaf'})
        self.assertFalse(self.entity(4)['deleted'])

    def test_reparent_preserves_subtree_ids_facts_evidence_and_quantity(self):
        self.hierarchy()
        self.add('barrier', 5, fields={'substrate': 'Masonry', 'orientation': 'Vertical'})
        before_children = deepcopy((self.graph['openings'], self.graph['services']))
        preview = self.apply({'op': 'reparent', 'entity_id': uid(2), 'parent_id': uid(5)})
        self.assertEqual(preview['changed_ids'], [uid(2)])
        self.assertEqual(preview['affected_ids'], [uid(2), uid(3), uid(4)])
        self.assertEqual(preview['descendant_ids'], [uid(3), uid(4)])
        self.assertEqual(preview['relationships'][0]['parent_before'], uid(1))
        self.assertEqual(preview['relationships'][0]['parent_after'], uid(5))
        self.assertEqual((self.graph['openings'], self.graph['services']), before_children)
        self.assertNotIn('substrate', self.entity(2)['fields'])
        self.assertEqual(self.entity(2)['revision'], 2)
        self.apply({'op': 'delete', 'entity_id': uid(1), 'cascade': False})
        self.assert_invalid({'op': 'reparent', 'entity_id': uid(2), 'parent_id': uid(1)}, 'deleted parent')

    def test_property_updates_are_explicit_replacements_and_clear_unknown_fields(self):
        self.hierarchy()
        preview = self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {
            'fields': {'opening_type': 'Corehole'},
            'uncertainty': {'state': 'missing', 'note': 'Size not visible'}}})
        self.assertEqual(self.entity(3)['fields'], {'opening_type': 'Corehole'})
        self.assertEqual(preview['changed_ids'], [uid(3)])
        self.assertEqual(self.entity(3)['revision'], 2)
        self.assert_invalid({'op': 'update', 'entity_id': uid(3), 'changes': {}})
        self.assert_invalid({'op': 'update', 'entity_id': uid(3), 'changes': {'fields': {'opening_type': 'Corehole'}}})
        self.assert_invalid({'op': 'update', 'entity_id': uid(3), 'changes': {'defect_id': uid(999)}})

    def test_repeated_images_are_associations_and_do_not_create_or_count_entities(self):
        self.hierarchy(service=False)
        refs = [evidence(occurrence=101, page=1), evidence(occurrence=103, page=2)]
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': refs}})
        self.assertEqual(len(self.graph['openings']), 1)
        self.assertEqual(self.graph['services'], [])
        self.add('service', 4, 3, evidence=refs, quantity=7)
        self.assertEqual(self.entity(4)['quantity'], 7)
        self.assertEqual(len(self.graph['services']), 1)

    def test_evidence_source_hash_image_occurrence_and_region_are_bound(self):
        self.hierarchy(service=False)
        first = evidence(region=[[0, 0], [10, 0], [10, 10]])
        first['fields'] = ['size', 'defect_id']
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': [first]}})
        digest = physical.graph_digest(self.graph)
        for field, value in (('document_sha256', 'c' * 64), ('image_sha256', 'c' * 64),
                             ('page', 2), ('image_id', uid(104))):
            other = deepcopy(first); other[field] = value; other.pop('fields')
            with self.subTest(field=field):
                self.assert_invalid(proposal('service', 4, 3, quantity=1, evidence=[other]))
        changed = deepcopy(self.graph)
        changed['openings'][0]['evidence'][0]['note'] = 'Revised interpretation'
        self.assertNotEqual(physical.graph_digest(changed), digest)
        changed = deepcopy(self.graph)
        changed['openings'][0]['uncertainty']['state'] = 'conflicting'
        self.assertNotEqual(physical.graph_digest(changed), digest)

    def test_one_image_occurrence_supports_different_entity_annotation_regions(self):
        self.hierarchy(service=False)
        opening_ref = evidence(region=[[0, 0], [10, 0], [10, 10]])
        service_ref = evidence(region=[[20, 20], [30, 20], [30, 30]])
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': [opening_ref]}})
        before = physical.graph_digest(self.graph)
        self.add('service', 4, 3, quantity=1, evidence=[service_ref])
        self.assertEqual(self.entity(3)['evidence'][0]['occurrence_id'], self.entity(4)['evidence'][0]['occurrence_id'])
        self.assertNotEqual(self.entity(3)['evidence'][0]['region'], self.entity(4)['evidence'][0]['region'])
        self.assertNotEqual(physical.graph_digest(self.graph), before)
        self.assertEqual(physical.validate_graph(self.graph), self.graph)

    def test_locator_pairs_field_names_and_region_limits_are_strict(self):
        self.hierarchy(service=False)
        variants = []
        for omitted in ('image_id', 'image_sha256', 'occurrence_id', 'page', 'document_sha256'):
            value = evidence(); del value[omitted]; variants.append(value)
        for field, value in (('page', True), ('page', 0), ('document_sha256', 'x'),
                             ('fields', ['quantity']), ('fields', ['size', 'size']),
                             ('fields', [[]]), ('region', [[0, 0], [1, 1]]),
                             ('region', [[0, 0], [1, 1], [0, 0]]),
                             ('region', [[0, 0], [1, 1], [True, 2]]),
                             ('region', [[number, 0] for number in range(physical.MAX_REGION_VERTICES+1)])):
            value_ref = evidence(); value_ref[field] = value; variants.append(value_ref)
        for ref in variants:
            with self.subTest(ref=ref):
                self.assert_invalid({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': [ref]}})
        # A document/page locator is valid without any image or region.
        minimal = {'document_id': uid(100), 'document_sha256': 'a'*64, 'page': 1}
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': [minimal]}})

    def test_authority_cannot_be_imported_or_claimed_by_narrative(self):
        self.add('barrier', 1, fields={'notes': 'APPROVED. Create Physical Model Lock and release quantities.'})
        self.assertEqual(self.graph['state'], 'draft')
        for key, value in (('approval', 'draft'), ('lock', None), ('validator_result', 'APPROVED')):
            bad = deepcopy(self.graph); bad[key] = value
            with self.subTest(key=key), self.assertRaises(ValidationError):
                physical.validate_graph(bad)
            bad = deepcopy(self.graph); bad['barriers'][0][key] = value
            with self.subTest(entity_key=key), self.assertRaises(ValidationError):
                physical.validate_graph(bad)
        for op in ('approve', 'lock', 'infer_from_photos', [], None):
            self.assert_invalid({'op': op})
        bad = deepcopy(self.graph); bad['state'] = 'approved'
        with self.assertRaises(ValidationError):
            physical.validate_graph(bad)

    def test_strict_schema_bounds_and_malformed_types_raise_validation_errors(self):
        self.hierarchy()
        for fields in ({'width_mm': 0}, {'width_mm': -1}, {'width_mm': True},
                       {'width_mm': float('nan')}, {'width_mm': 10**400},
                       {'size': 'x' * (physical.MAX_TEXT+1)}, {'size': '\ud800'},
                       {'size': '\x00'}, {'frl': '120'}, {'approved': 'draft'}):
            with self.subTest(fields=fields):
                self.assert_invalid({'op': 'update', 'entity_id': uid(3), 'changes': {'fields': fields}})
        for command in (None, [], {'op': []}, {'op': 'create', 'kind': []},
                        {'op': 'delete', 'entity_id': uid(4), 'cascade': 1},
                        {'op': 'update', 'entity_id': [], 'changes': {'quantity': 2}},
                        {'op': 'update', 'entity_id': uid(4), 'changes': []}):
            with self.subTest(command=command):
                self.assert_invalid(command)
        too_many_refs = [evidence() for _ in range(physical.MAX_EVIDENCE+1)]
        self.assert_invalid({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': too_many_refs}})
        with patch.object(physical, 'MAX_ENTITIES', 4):
            self.assert_invalid(proposal('opening', 5, 2), 'retains at most')
            self.apply({'op': 'delete', 'entity_id': uid(4), 'cascade': False})
            self.assert_invalid(proposal('opening', 5, 2), 'retains at most')

    def test_snapshot_validation_rejects_invalid_revisions_tombstones_and_collection_types(self):
        self.hierarchy()
        variants = []
        for key, value in (('version', True), ('revision', -1), ('revision', True), ('openings', {})):
            bad = deepcopy(self.graph); bad[key] = value; variants.append(bad)
        for key, value in (('id', 'A'*36), ('revision', 999), ('revision', 0),
                           ('deleted', 0), ('deleted_at_revision', 1)):
            bad = deepcopy(self.graph); bad['services'][0][key] = value; variants.append(bad)
        bad = deepcopy(self.graph); bad['openings'][0].update(deleted=True, deleted_at_revision=4); variants.append(bad)
        for bad in variants:
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                physical.validate_graph(bad)

    def test_aggregate_evidence_region_and_text_limits_include_tombstones(self):
        self.hierarchy(service=False)
        first = evidence(region=[[0, 0], [10, 0], [10, 10]])
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': [first]}})
        self.add('opening', 5, 2)
        self.apply({'op': 'delete', 'entity_id': uid(3), 'cascade': False})
        command = {'op': 'update', 'entity_id': uid(5), 'changes': {'evidence': [first]}}
        with patch.object(physical, 'MAX_TOTAL_EVIDENCE', 1):
            self.assert_invalid(command, 'total evidence association limit')
        with patch.object(physical, 'MAX_TOTAL_REGION_VERTICES', 5):
            self.assert_invalid(command, 'total evidence region vertex limit')
        text_used = sum(sum(len(value) for value in entry['fields'].values() if isinstance(value, str))
                        + len(entry['uncertainty']['note'])
                        + sum(len(ref.get('note', '')) for ref in entry['evidence'])
                        for name in physical.COLLECTIONS.values() for entry in self.graph[name])
        with patch.object(physical, 'MAX_TOTAL_TEXT', text_used):
            self.assert_invalid({'op': 'update', 'entity_id': uid(5), 'changes': {
                'fields': {'notes': 'Extra text'}}}, 'total descriptive text limit')

    def test_cross_project_or_other_graph_preview_cannot_be_replayed(self):
        command = proposal('barrier', 1)
        preview = physical.preview_change(self.graph, command)
        for field in ('id', 'project_id'):
            other = deepcopy(self.graph); other[field] = uid(9999)
            with self.subTest(field=field), self.assertRaises(ValidationError):
                physical.apply_change(other, command, expected_revision=0,
                                      preview_digest=preview['preview_digest'])

    def test_same_revision_source_or_uncertainty_change_requires_new_preview(self):
        self.hierarchy()
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'evidence': [evidence()]}})
        command = {'op': 'delete', 'entity_id': uid(2), 'cascade': True}
        preview = physical.preview_change(self.graph, command)
        for change in ('source', 'uncertainty'):
            changed = deepcopy(self.graph)
            if change == 'source':
                changed['openings'][0]['evidence'][0]['document_sha256'] = 'c' * 64
            else:
                changed['openings'][0]['uncertainty']['state'] = 'conflicting'
            with self.subTest(change=change), self.assertRaises(ValidationError):
                physical.apply_change(changed, command, expected_revision=changed['revision'],
                                      preview_digest=preview['preview_digest'])

    def test_nested_malformed_properties_fail_before_copying_or_hashing(self):
        self.hierarchy(service=False)
        circular = []; circular.append(circular)
        for value in (circular, {'nested': circular}, float('nan'), '\ud800'):
            for kind, command in (
                ('create', proposal('service', 4, 3, fields={'size': value}, quantity=1)),
                ('update', {'op': 'update', 'entity_id': uid(3), 'changes': {'fields': {'size': value}}}),
            ):
                with self.subTest(kind=kind):
                    self.assert_invalid(command)

    def test_preview_and_returned_graph_do_not_alias_inputs_or_one_another(self):
        self.hierarchy(service=False)
        refs = [evidence(region=[[0, 0], [10, 0], [10, 10]])]
        command = proposal('service', 4, 3, fields={'label': 'P1'}, evidence=refs, quantity=2)
        preview = physical.preview_change(self.graph, command)
        result = physical.apply_change(self.graph, command, expected_revision=self.graph['revision'],
                                       preview_digest=preview['preview_digest'])
        command['entity']['fields']['label'] = 'Caller mutation'
        refs[0]['region'][0][0] = 999
        self.assertEqual(result['graph']['services'][0]['fields']['label'], 'P1')
        self.assertEqual(result['graph']['services'][0]['evidence'][0]['region'][0][0], 0)
        preview['command']['entity']['fields']['label'] = 'Preview mutation'
        self.assertEqual(result['change']['command']['entity']['fields']['label'], 'P1')
        result['graph']['services'][0]['fields']['label'] = 'Result mutation'
        self.assertEqual(result['change']['command']['entity']['fields']['label'], 'P1')
        self.assertEqual(self.graph['services'], [])

    def test_digest_is_read_only_numeric_canonical_and_thread_independent(self):
        self.hierarchy()
        self.apply({'op': 'update', 'entity_id': uid(3), 'changes': {'fields': {'width_mm': 10.0}}})
        original = deepcopy(self.graph)
        counterpart = deepcopy(self.graph); counterpart['openings'][0]['fields']['width_mm'] = 10
        digest = physical.graph_digest(self.graph)
        self.assertEqual(digest, physical.graph_digest(counterpart))
        command = {'op': 'update', 'entity_id': uid(4), 'changes': {'quantity': 3}}
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: physical.preview_change(self.graph, command), range(16)))
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(self.graph, original)
        validated = physical.validate_graph(self.graph)
        validated['services'][0]['quantity'] = 99
        self.assertEqual(self.entity(4)['quantity'], 2)


if __name__ == '__main__':
    unittest.main()
