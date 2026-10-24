"""References are context candidates, never inferred installations/authority."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.catalog import ROOT
from estimator.reference_library import ReferenceLibrary
from estimator.takeoff_http import TakeoffHTTP
from estimator.register_references import ReferenceIndex, criteria_for, physical_contexts, report_text, system_text
from tests.test_reference_library import sample_library
from tests import test_takeoff_workspace as workspace
from tests import test_takeoff_physical_workspace as physical_workspace
from tests import test_takeoff_physical_v2_exports as graph_fixture
from tests.test_takeoff_physical import uid


URL = 'https://tfire.com.au/documents/test-revision-a.pdf'


def prepared():
    def item(key, manufacturer, service, substrate, rating, title='Same title'):
        return {'id': key, 'title': title, 'filter_values': {'manufacturer': [manufacturer],
            'category': ['Mechanical'], 'services': [service], 'substrate': [substrate],
            'orientation': ['Vertical'], 'type': ['Core hole'], 'frl': [rating]},
            'fields': [{'label': 'Report Number', 'value': 'FC-1 Rev A\nPrivate report',
                        'report_links': [{'label': 'FC-1 Rev A', 'url': URL}]},
                       {'label': 'Manual', 'value': 'Manual must not become a report'}]}
    records = {value['id']: value for value in (
        item('a-one', 'Alpha', 'Copper pipe', 'Concrete/masonry wall', '-/120/120'),
        item('a-two', 'Alpha', 'Steel pipe', 'Plasterboard wall', '120/120/120'),
        item('z-three', 'Zulu', 'Copper pipe', 'Plasterboard wall', '-/120/120'))}
    records['a-two']['fields'][0]['value'] = '  fc-1   rev a  \nFC-1 Rev B'
    records['a-two']['fields'][0]['report_links'] = []
    return {'_records': {'technical': records}, '_visible': {'technical': list(records)},
            '_aliases': {'verified-alias': 'a-one'},
            '_links': {'penetration': {'linked': [{'kind': 'technical', 'id': 'verified-alias'},
                                                 {'kind': 'technical', 'id': 'a-two'}], 'empty': []}}}


class ReferenceProjectionTests(unittest.TestCase):
    def setUp(self):
        self.data = prepared(); self.original = deepcopy(self.data)
        self.index = ReferenceIndex(self.data, 'e' * 64)

    def result(self, criteria=None, library_ids=None, **page):
        return self.index.project([{'criteria': criteria or {}, 'library_ids': library_ids or []}], **page)

    def ids(self, **kwargs):
        return [item['id'] for item in self.result(**kwargs)['systems']]

    def tearDown(self):
        self.assertEqual(self.data, self.original, 'Reference reads must retain the authoritative source object.')

    def test_and_known_facets_without_fabricating_configuration_or_dimensions(self):
        self.assertEqual(self.ids(criteria={'services': 'Copper pipe', 'substrate': 'Concrete/masonry wall'}), ['a-one'])
        self.assertEqual(self.ids(criteria={'services': 'Steel pipe', 'substrate': 'Concrete/masonry wall'}), [])
        self.assertEqual(self.ids(criteria={'services': 'Copper pipe'}), ['a-one', 'z-three'])
        self.assertEqual(self.ids(criteria={'substrate': 'Plasterboard wall'}), ['a-two', 'z-three'])
        self.assertEqual(self.ids(), [])
        self.assertEqual(self.ids(criteria={'frl': '120'}), [], 'A rating alone cannot choose an installation context.')
        for broad in ({'category': 'Mechanical'}, {'orientation': 'Vertical'}, {'type': 'Core hole'}):
            self.assertEqual(self.ids(criteria=broad), [])
        blank_seal = criteria_for({'service': 'Blank Seal', 'service_type': 'N/A'}, {}, {})
        self.assertEqual(blank_seal, {'category': 'Blank Seal'})
        self.assertEqual(self.ids(criteria=blank_seal), [])
        for placeholders in ({'services': 'Unknown'}, {'substrate': 'N/A'}, {'substrate': 'Not specified'}):
            self.assertEqual(self.ids(criteria=placeholders), [])
        criteria = criteria_for({'service_type': 'Junction Box', 'size': '12 mm'}, {'substrate': 'Concrete', 'thickness_mm': 120}, {})
        self.assertEqual(criteria['services'], 'Conduits')
        self.assertEqual(criteria_for({'service_type': 'Pair Coil Bundle'}, {}, {})['services'], 'Pair Coils')
        self.assertNotIn('size', criteria); self.assertNotIn('thickness_mm', criteria)

    def test_known_barrier_context_is_not_lost_to_unknown_or_na_placeholder_facets(self):
        criteria = criteria_for({'service_type': 'Unknown'}, {'substrate': 'Concrete/masonry wall', 'orientation': 'Not specified'}, {'frl': 'N/A'})
        self.assertEqual(criteria, {'substrate': 'Concrete/masonry wall'})
        self.assertEqual(self.ids(criteria=criteria), ['a-one'])
        data = deepcopy(self.data)
        data['_records']['technical']['a-one']['filter_values'].update(category=['Blank Seal'], services=['N/A'])
        index = ReferenceIndex(data, 'x')
        seal = criteria_for({'service': 'Blank Seal', 'service_type': 'N/A'}, {'substrate': 'Concrete/masonry wall'}, {})
        self.assertEqual(seal, {'category': 'Blank Seal', 'substrate': 'Concrete/masonry wall'})
        self.assertEqual(index.project([{'criteria': seal}])['total'], 1)

    def test_full_frl_keeps_all_criteria_and_scalar_only_matches_centre(self):
        self.assertEqual(self.ids(criteria={'substrate': 'Plasterboard wall', 'frl': '120/120/120'}), ['a-two'])
        self.assertEqual(self.ids(criteria={'substrate': 'Plasterboard wall', 'frl': '-/120/120'}), ['z-three'])
        self.assertEqual(self.ids(criteria={'substrate': 'Plasterboard wall', 'frl': '120'}), ['a-two', 'z-three'])
        self.assertEqual(criteria_for({}, {}, {'frl': '0 / 120 / 120'})['frl'], '-/120/120')
        self.assertEqual(self.ids(criteria={'substrate': 'Plasterboard wall', 'frl': '-/120/90'}), [])

    def test_explicit_assignment_wins_including_no_links_and_aliases_only(self):
        self.assertEqual(self.ids(criteria={'services': 'Copper pipe'}, library_ids=['empty']), [])
        self.assertEqual(self.ids(criteria={'services': 'Copper pipe'}, library_ids=['missing']), [])
        selected = self.result(library_ids=['linked'])
        self.assertEqual([item['id'] for item in selected['systems']], ['a-one', 'a-two'])
        self.assertEqual(selected['basis'], 'linked')
        self.assertEqual(len({item['title'] for item in selected['systems']}), 1, 'Equal titles are not duplicate identities.')

    def test_report_case_whitespace_dedup_preserves_revision_and_private_caption(self):
        result = self.result(library_ids=['linked'])
        self.assertEqual(result['reports'], [{'label': 'FC-1 Rev A', 'url': URL},
            {'label': 'FC-1 Rev B', 'url': None}, {'label': 'Private report', 'url': None}])
        self.assertNotIn('Manual', report_text(result['reports']))
        self.assertIn(URL, report_text(result['reports']))

    def test_different_verified_urls_are_not_discarded_by_caption_normalization(self):
        field = self.data['_records']['technical']['a-one']['fields'][0]
        field['report_links'].append({'label': 'fc-1 rev a', 'url': 'https://tfire.com.au/documents/other-source.pdf'})
        self.original = deepcopy(self.data)
        reports = self.result(library_ids=['linked'])['reports']
        self.assertEqual(len(reports), 3)
        self.assertEqual(reports[0], {'label': 'FC-1 Rev A', 'url': None})

    def test_manufacturer_order_numbers_and_all_report_refs_survive_pagination(self):
        contexts = [{'criteria': {'services': 'Copper pipe'}}, {'criteria': {'services': 'Steel pipe'}}]
        first, last = self.index.project(contexts, 0, 2), self.index.project(contexts, 2, 2)
        self.assertEqual([(row['manufacturer'], row['number']) for row in first['systems']], [('Alpha', 1), ('Alpha', 2)])
        self.assertEqual([(row['manufacturer'], row['number']) for row in last['systems']], [('Zulu', 1)])
        self.assertTrue(first['has_more']); self.assertFalse(last['has_more'])
        self.assertEqual(first['report_total'], 3)
        self.assertEqual(len(first['reports']), 2); self.assertTrue(first['report_has_more'])
        final_reports = self.index.project(contexts, report_offset=2, limit=2)
        self.assertEqual(first['reports'] + final_reports['reports'], self.index.project(contexts)['reports'])
        self.assertFalse(final_reports['report_has_more'])
        self.assertEqual(system_text(first), 'Alpha-1 (a-one), 2 (a-two)')
        self.assertEqual(len(self.index.matches), 1)

    def test_report_creation_cache_is_bounded_before_a_large_result_can_accumulate(self):
        data = deepcopy(self.data)
        for index in range(5):
            record = deepcopy(data['_records']['technical']['a-one'])
            record.update(id=f'large-{index}', fields=[{'label': 'Report Number', 'value': str(index) + 'x' * 300}])
            data['_records']['technical'][record['id']] = record
            data['_visible']['technical'].append(record['id'])
        before = deepcopy(data); index = ReferenceIndex(data, 'x')
        with patch('estimator.register_references.MAX_CACHE_BYTES', 1024), self.assertRaisesRegex(ValidationError, 'safe response limit'):
            index.project([{'criteria': {'services': 'Copper pipe'}}])
        self.assertEqual(data, before); self.assertEqual(len(index.reports), 0)

    def test_full_excel_export_fails_early_for_oversized_report_or_system_cells(self):
        for report_case in (True, False):
            with self.subTest(reports=report_case):
                data = deepcopy(self.data); records = {}
                for number in range(34 if report_case else 300):
                    key = f'system-{number:03d}' + ('x' * 100 if not report_case else '')
                    record = deepcopy(data['_records']['technical']['a-one'])
                    record.update(id=key, fields=[{'label': 'Report Number', 'value': str(number) + 'x' * 1000 if report_case else 'One report'}])
                    records[key] = record
                data['_records']['technical'] = records; data['_visible']['technical'] = list(records)
                before = deepcopy(data)
                with self.assertRaisesRegex(ValidationError, 'Excel cell limit'):
                    ReferenceIndex(data, 'x').project([{'criteria': {'services': 'Copper pipe'}}], limit=50000, excel=True)
                self.assertEqual(data, before)

    def test_discovery_services_are_used_but_discovery_frl_aliases_are_not(self):
        data = deepcopy(self.data)
        data['_technical_discovery'] = {'a-one': {'category': ['Electrical & Communications'], 'services': ['Conduits'], 'frl': ['120/120/120']}}
        index = ReferenceIndex(data, 'x')
        context = lambda rating: [{'criteria': {'services': 'Conduits', 'frl': rating}}]
        self.assertEqual(index.project(context('-/120/120'))['total'], 1)
        self.assertEqual(index.project(context('120/120/120'))['total'], 0)

    def test_parent_is_union_of_real_children_not_combined_service_barrier_fields(self):
        fixture = graph_fixture.PhysicalV2ExportTests(); fixture.setUp()
        graph = fixture.graph
        graph['barriers'][0]['fields'] = {'substrate': 'Concrete/masonry wall'}
        graph['barriers'][1]['fields'] = {'substrate': 'Plasterboard wall'}
        graph['services'][0]['fields'] = {'service_type': 'Copper pipe'}
        snapshot = {'physical': graph}
        contexts = physical_contexts(snapshot, 'defect_reports', [uid(1)])[uid(1)]
        self.assertEqual(len(contexts), 2)
        self.assertFalse(any(row['criteria'].get('services') == 'Copper pipe' and row['criteria'].get('substrate') == 'Plasterboard wall' for row in contexts))
        snapshot['library_assignments'] = {'records': [{'scope': 'defect_reports', 'library': {'id': 'empty'}, 'members': [{'id': uid(1)}]}]}
        linked = physical_contexts(snapshot, 'defect_reports', [uid(1)])[uid(1)]
        self.assertEqual(len(linked), 1); self.assertEqual(self.index.project(linked)['total'], 0)


class ReferenceLibraryEpochTests(unittest.TestCase):
    def test_effective_cache_is_reused_and_epoch_change_rejects_mixed_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); data, _, _ = sample_library(root)
            library = ReferenceLibrary(root)
            context = {'row': [{'library_ids': ['pkb-001'], 'criteria': {}}]}
            first = library.register_references(context)
            cached = library._register_reference_index[1]
            again = library.register_references(context, expected_revision=first['library_revision'])
            self.assertIs(cached, library._register_reference_index[1]); self.assertEqual(first, again)
            data['libraries']['technical']['items'][0]['title'] += ' Changed'
            (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaisesRegex(ValidationError, 'library changed'):
                library.register_references(context, expected_revision=first['library_revision'])

    def test_expanded_batch_json_budget_fails_explicitly_without_partial_source_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); sample_library(root); source = (root / 'library.json').read_bytes()
            library = ReferenceLibrary(root); context = [{'library_ids': ['pkb-001'], 'criteria': {}}]
            first = library.register_references({'one': context})
            one_size = len(json.dumps(first, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
            with patch('estimator.register_references.MAX_RESPONSE_BYTES', one_size * 2 + 512), self.assertRaisesRegex(ValidationError, 'safe response limit'):
                library.register_references({key: context for key in ('one', 'two', 'three')})
            self.assertEqual((root / 'library.json').read_bytes(), source)
            self.assertEqual(library.register_references({'one': context}), first)

    def test_budget_matches_actual_server_utf8_json_escaping_and_separator_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); data, _, _ = sample_library(root)
            data['libraries']['technical']['items'][0]['fields'].append({'label': 'Report Number', 'value': 'FC "λ" Rev A'})
            (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
            library = ReferenceLibrary(root); contexts = {'one': [{'library_ids': ['pkb-001']}]}
            result = library.register_references(contexts)
            wire_size = len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8'))
            with patch('estimator.register_references.MAX_RESPONSE_BYTES', wire_size + 512):
                self.assertEqual(library.register_references(contexts), result)
            with patch('estimator.register_references.MAX_RESPONSE_BYTES', wire_size + 511), self.assertRaisesRegex(ValidationError, 'safe response limit'):
                library.register_references(contexts)


class ReferenceWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = physical_workspace.PhysicalWorkspaceTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.apply([self.fixture.defect()])
        self.state = self.fixture.state()
        self.identifier = self.state['snapshot']['physical']['defects'][0]['id']

    def request(self, **changes):
        return {'expected_revision': self.state['revision'], 'scope': 'defect_reports', 'entity_ids': [self.identifier], **changes}

    def read(self, **changes):
        return self.fixture.service.register_references(self.fixture.sid, self.request(**changes))

    def test_read_is_exactly_nonmutating_and_missing_context_returns_no_unfiltered_items(self):
        store = self.fixture.case.store
        with store.connect() as connection:
            before_db = '\n'.join(connection.iterdump())
        before = self.fixture.state(); blobs = deepcopy(self.fixture.case.documents.blobs)
        result = self.read()
        self.assertEqual(result['revision'], before['revision'])
        self.assertEqual(result['project_id'], before['snapshot']['project_id'])
        self.assertEqual(result['row_references'][self.identifier]['total'], 0)
        self.assertEqual(self.fixture.state(), before); self.assertEqual(self.fixture.case.documents.blobs, blobs)
        with store.connect() as connection:
            self.assertEqual('\n'.join(connection.iterdump()), before_db)

    def test_revision_scope_id_and_pagination_are_fail_closed(self):
        for changes in ({'expected_revision': -1}, {'scope': 'steel'}, {'scope': []}, {'entity_ids': ['not-an-id']},
                        {'entity_ids': [self.identifier] * 2}, {'entity_ids': [str(uuid4())]}, {'limit': 101},
                        {'offset': True}, {'report_offset': -1}, {'report_offset': True}, {'report_offset': 1000001},
                        {'expected_library_revision': 'invented'}, {'criteria': {'services': 'Copper pipe'}}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.read(**changes)

    def test_http_route_is_read_only_and_rejects_query_override(self):
        request = self.request()
        adapter = TakeoffHTTP(self.fixture.service, ROOT, "default-src 'self'")
        class Handler:
            command = 'POST'
            path = f'/api/takeoffs/sessions/{self.fixture.sid}/register-references'
            def read_json(self): return request
            def send_payload(self, status, payload): self.status, self.result = status, payload
        handler = Handler()
        before = self.fixture.state()
        self.assertTrue(adapter.dispatch(handler, handler.path))
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.result['scope'], 'defect_reports')
        self.assertEqual(self.fixture.state(), before)
        route = handler.path; handler.path += '?scope=service_plans'
        with self.assertRaisesRegex(ValidationError, 'structured request'):
            adapter.dispatch(handler, route)


if __name__ == '__main__':
    unittest.main()
