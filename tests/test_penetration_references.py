"""Reference navigation is portable metadata, never a calculation input."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from openpyxl import load_workbook
from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.penetration_calculator import normalize_draft, calculate
from estimator.penetration_references import resolve_schedule_references, capture_transfer_references, validate_reference_ids
from estimator.penetration_report import render_penetration_pdf, build_penetration_register
from estimator.project_file import export_project, load_project_bytes
from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from estimator.takeoff_library_links import _physical_context
from estimator.takeoff_manual_transfer import compile_rows
from estimator.takeoff_model import new_snapshot, upgrade_snapshot, validate_snapshot
from estimator.takeoff_physical import apply_change, new_graph, preview_change
from tests.test_reference_library import sample_library

URL = 'https://tfire.com.au/documents/test-revision-a.pdf'


class PenetrationReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data, _, _ = sample_library(self.root / 'library')
        technical = self.data['libraries']['technical']
        technical['filters'].extend([{'key': 'orientation', 'label': 'Orientation'}, {'key': 'services', 'label': 'Services'}])
        first = technical['items'][0]
        first['fields'].append({'label': 'Report Number', 'value': 'TEST-100 Rev A', 'report_links': [{'label': 'TEST-100 Rev A', 'url': URL}]})
        first['filter_values'].update(orientation=['Vertical'], services=['Copper Pipes'])
        second = deepcopy(first)
        second.update(id='report-a-v2', title='V2 system')
        second['fields'][-1] = {'label': 'Report Number', 'value': 'TEST-200 Rev B'}
        technical['items'].append(second)
        self.library = ReferenceLibrary(self.root / 'library')
        self.write()
        self.draft = {'globals': {}, 'rows': [{'id': 'line-1', 'inputs': {'K': 'Copper Pipes', 'M': 'Vertical', 'O': 2}}]}

    def write(self):
        (self.root / 'library/library.json').write_text(json.dumps(self.data), encoding='utf-8')

    def resolve(self, **metadata):
        draft = deepcopy(self.draft)
        draft['rows'][0].update(metadata)
        return resolve_schedule_references(draft, self.library)['row_references']['line-1']

    def legacy_takeoff(self, scope):
        """Compile a real manual row that predates portable reference IDs."""
        snapshot = upgrade_snapshot(new_snapshot())
        graph = new_graph(snapshot['project_id'], version=2 if scope == 'defect_reports' else 3)

        def change(command):
            nonlocal graph
            preview = preview_change(graph, command)
            graph = apply_change(graph, command, expected_revision=graph['revision'],
                                 preview_digest=preview['preview_digest'])['graph']

        def create(kind, fields, **extra):
            identifier = str(uuid4())
            change({'op': 'create', 'kind': kind, 'entity': {
                'id': identifier, 'fields': fields, 'evidence': [],
                'uncertainty': {'state': 'not_assessed', 'note': ''}, **extra}})
            return identifier

        owner = create('defect', {}) if scope == 'defect_reports' else None
        barrier = create('barrier', {'orientation': 'Vertical'},
                         **({'defect_id': owner} if owner else {}))
        create('service', {'service_type': 'Copper Pipes', 'size': '25'}, barrier_id=barrier, quantity=2)
        change({'op': 'update', 'entity_id': owner or barrier, 'changes': {'confirmation': 'confirmed'}})
        snapshot['physical' if scope == 'defect_reports' else 'service_plans'] = graph
        snapshot = validate_snapshot(snapshot)
        blank = {'globals': {}, 'rows': []}
        compiled = compile_rows(snapshot, scope, blank, set(), _physical_context(snapshot, scope))
        self.assertEqual(len(compiled['rows']), 1)
        draft = normalize_draft({'globals': {}, 'rows': compiled['rows']})
        self.assertNotIn('takeoff_reference_ids', draft['rows'][0])
        return draft, snapshot

    def test_manual_context_only_prefilters_without_assigning_candidates(self):
        value = self.resolve()
        self.assertEqual(value['reports'], [])
        self.assertEqual(value['systems'], [])
        self.assertEqual(value['initial_filters']['orientation'], 'Vertical')

    def test_library_links_are_inherited(self):
        value = self.resolve(library_item_id='pkb-001')
        self.assertEqual(value['basis'], 'library')
        self.assertEqual(value['reports'], [{'label': 'TEST-100 Rev A', 'url': URL}])
        self.assertEqual(value['systems'][0]['id'], 'report-a-v1')

    def test_takeoff_reference_precedes_library_and_selection_precedes_both(self):
        value = self.resolve(library_item_id='pkb-001', takeoff_reference_ids=['report-a-v2'])
        self.assertEqual(value['systems'][0]['id'], 'report-a-v2')
        self.assertEqual(value['basis'], 'takeoff')
        self.assertEqual(value['reports'][0]['url'], '/api/libraries/documents/report-a.pdf')
        value = self.resolve(library_item_id='pkb-001', takeoff_reference_ids=['report-a-v2'], technical_reference_ids=['report-a-v1'])
        self.assertEqual(value['systems'][0]['id'], 'report-a-v1')
        self.assertEqual(value['basis'], 'selected')

    def test_explicit_clear_and_missing_selection_do_not_fall_back(self):
        self.assertEqual(self.resolve(library_item_id='pkb-001', technical_reference_ids=[])['systems'], [])
        value = self.resolve(library_item_id='pkb-001', technical_reference_ids=['removed-system'])
        self.assertEqual(value['missing_ids'], ['removed-system'])
        self.assertEqual(value['reports'], [])

    def test_selection_order_and_sequential_numbers_are_stable(self):
        value = self.resolve(technical_reference_ids=['report-a-v2', 'report-a-v1'])
        self.assertEqual([(item['id'], item['number']) for item in value['systems']], [('report-a-v2', 1), ('report-a-v1', 2)])
        self.assertEqual(len(value['reports']), 2)

    def test_reference_reads_do_not_modify_library_or_draft(self):
        before = (self.root / 'library/library.json').read_bytes()
        draft = deepcopy(self.draft)
        self.resolve(library_item_id='pkb-001')
        self.assertEqual(before, (self.root / 'library/library.json').read_bytes())
        self.assertEqual(draft, self.draft)

    def test_invalid_values_and_duplicates_are_rejected(self):
        for value in ('report-a-v1', [None], [True], ['../report-a'], ['https://evil.invalid'], ['a', 'a'], ['a'] * 129):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                validate_reference_ids(value)
        self.assertEqual(validate_reference_ids([]), [])

    def test_metadata_roundtrips_with_unchanged_calculation(self):
        base = calculate(self.draft)
        selected = deepcopy(self.draft)
        selected['rows'][0].update(technical_reference_ids=['report-a-v2', 'report-a-v1'], takeoff_reference_ids=['report-a-v1'])
        result = calculate(selected)
        for key in ('rows', 'summary', 'summary_cells', 'material_breakdown'):
            self.assertEqual(base[key], result[key])
        store = Store(self.root / 'test.sqlite3')
        payload = export_project(store, {'estimate': {}, 'penetration': {'draft': selected}})
        restored = load_project_bytes(store, payload)['penetration']['draft']
        self.assertEqual(restored['rows'][0]['technical_reference_ids'], ['report-a-v2', 'report-a-v1'])
        self.assertEqual(restored['rows'][0]['takeoff_reference_ids'], ['report-a-v1'])

    def test_missing_library_retains_unresolved_identity(self):
        draft = deepcopy(self.draft)
        draft['rows'][0]['technical_reference_ids'] = ['report-a-v1']
        value = resolve_schedule_references(draft)['row_references']['line-1']
        self.assertEqual(value['missing_ids'], ['report-a-v1'])
        self.assertEqual(normalize_draft(draft)['rows'][0]['technical_reference_ids'], ['report-a-v1'])

    def test_legacy_manual_takeoff_uses_exact_source_context_in_both_workspaces(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                draft, snapshot = self.legacy_takeoff(scope)
                # The row remains editable; its retained Takeoffs reference context
                # must not be silently replaced by the current calculator inputs.
                draft['rows'][0]['inputs']['K'] = 'Conduits'
                before_draft, before_snapshot = deepcopy(draft), deepcopy(snapshot)
                row_id = draft['rows'][0]['id']
                value = resolve_schedule_references(draft, self.library, snapshot=snapshot)['row_references'][row_id]
                self.assertEqual(value['basis'], 'takeoff')
                self.assertEqual([entry['id'] for entry in value['systems']], ['report-a-v1', 'report-a-v2'])
                self.assertEqual(draft, before_draft)
                self.assertEqual(snapshot, before_snapshot)

    def test_legacy_source_cannot_read_another_project_graph_scope_or_deleted_service(self):
        for scope in ('defect_reports', 'service_plans'):
            draft, snapshot = self.legacy_takeoff(scope)
            graph_key = 'physical' if scope == 'defect_reports' else 'service_plans'
            for mismatch in ('project_id', 'graph_id', 'service_id', 'scope', 'deleted', 'missing_graph'):
                with self.subTest(scope=scope, mismatch=mismatch):
                    changed, source = deepcopy(snapshot), deepcopy(draft)
                    row = source['rows'][0]
                    if mismatch in ('project_id', 'graph_id', 'service_id'):
                        row['takeoff_source'][mismatch] = str(uuid4())
                    elif mismatch == 'scope':
                        row['takeoff_source']['scope'] = 'service_plans' if scope == 'defect_reports' else 'defect_reports'
                    elif mismatch == 'deleted':
                        command = {'op': 'delete', 'entity_id': row['takeoff_source']['service_id'], 'cascade': False}
                        graph = changed[graph_key]
                        preview = preview_change(graph, command)
                        changed[graph_key] = apply_change(graph, command, expected_revision=graph['revision'],
                                                         preview_digest=preview['preview_digest'])['graph']
                    else:
                        changed[graph_key] = None
                    before_source, before_snapshot = deepcopy(source), deepcopy(changed)
                    value = resolve_schedule_references(source, self.library, snapshot=changed)['row_references'][row['id']]
                    self.assertEqual(value['basis'], 'none')
                    self.assertEqual(value['systems'], [])
                    self.assertEqual(value['reports'], [])
                    self.assertEqual(source, before_source)
                    self.assertEqual(changed, before_snapshot)
                    # An unrelated source cannot override this row's own library.
                    row['library_item_id'] = 'pkb-001'
                    value = resolve_schedule_references(source, self.library, snapshot=changed)['row_references'][row['id']]
                    self.assertEqual(value['basis'], 'library')
                    self.assertEqual([entry['id'] for entry in value['systems']], ['report-a-v1'])

    def test_real_transfer_capture_retains_reports_without_an_open_takeoff_session(self):
        for scope in ('defect_reports', 'service_plans'):
            with self.subTest(scope=scope):
                draft, snapshot = self.legacy_takeoff(scope)
                existing = {'id': 'already-selected', 'inputs': {}, 'technical_reference_ids': ['report-a-v2']}
                previous = {'globals': {}, 'rows': [existing]}
                draft['rows'].insert(0, deepcopy(existing))
                before_draft, before_snapshot = deepcopy(draft), deepcopy(snapshot)
                result = capture_transfer_references(draft, previous, snapshot, self.library)
                self.assertEqual(result['rows'][0], existing)
                self.assertEqual(result['rows'][1]['takeoff_reference_ids'], ['report-a-v1', 'report-a-v2'])
                portable = resolve_schedule_references(result, self.library)['row_references'][result['rows'][1]['id']]
                self.assertEqual([entry['label'] for entry in portable['reports']], ['TEST-100 Rev A', 'TEST-200 Rev B'])
                self.assertEqual(draft, before_draft)
                self.assertEqual(snapshot, before_snapshot)
                self.assertEqual(previous, {'globals': {}, 'rows': [existing]})

    def test_transfer_captures_only_new_manual_rows_and_preserves_previous(self):
        existing = {'id': 'old', 'inputs': {}, 'technical_reference_ids': ['retained']}
        draft = {'globals': {}, 'rows': [existing, {'id': 'new', 'inputs': {}, 'takeoff_source': {'retained': 'source'}}]}
        projected = {'row_references': {'new': {'systems': [{'id': 'report-a-v1'}]}}}
        with patch('estimator.penetration_references.resolve_schedule_references', return_value=projected):
            result = capture_transfer_references(draft, {'rows': [existing]}, {}, self.library)
        self.assertEqual(result['rows'][0], existing)
        self.assertEqual(result['rows'][1]['takeoff_reference_ids'], ['report-a-v1'])
        self.assertNotIn('takeoff_reference_ids', draft['rows'][1])

    def test_downloads_show_reports_without_source_coordinates_or_reference_ids(self):
        draft = deepcopy(self.draft)
        draft['rows'][0]['technical_reference_ids'] = ['report-a-v1', 'report-a-v2']
        result = calculate(draft)
        pdf = render_penetration_pdf(result, result['definition'], {}, library=self.library)
        reader = PdfReader(BytesIO(pdf))
        text = ' '.join(' '.join(page.extract_text() for page in reader.pages).split())
        self.assertIn('TEST-100 Rev A', text)
        self.assertIn('TEST-200 Rev B', text)
        self.assertNotIn('report-a-v1', text)
        self.assertNotIn('Table 1, PDF page 2', text)
        workbook = load_workbook(BytesIO(build_penetration_register(result, result['definition'], {}, library=self.library)))
        cells = [str(cell.value) for sheet in workbook for row in sheet for cell in row if cell.value is not None]
        self.assertIn('TEST-100 Rev A | TEST-200 Rev B', cells)
        self.assertNotIn('Basis', cells)
        self.assertNotIn('Cell', cells)
        self.assertFalse(any('report-a-v1' in value for value in cells))

    def test_excel_rejects_report_lists_that_would_be_silently_truncated(self):
        records = self.data['libraries']['technical']['items']
        template = deepcopy(records[0])
        records.clear()
        for index in range(34):
            item = deepcopy(template)
            item['id'] = f'large-{index:02d}'
            item['fields'] = [{'label': 'Report Number', 'value': f'REPORT-{index:02d}-' + 'x' * 1000}]
            records.append(item)
        self.data['links'] = []
        self.write()
        draft = deepcopy(self.draft)
        draft['rows'][0]['technical_reference_ids'] = [item['id'] for item in records]
        result = calculate(draft)
        before = deepcopy(result)
        with self.assertRaisesRegex(ValidationError, 'Excel cell'):
            build_penetration_register(result, result['definition'], {}, library=self.library)
        self.assertEqual(result, before)


if __name__ == '__main__':
    unittest.main()
