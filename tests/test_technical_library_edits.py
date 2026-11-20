"""Technical CRUD is persistent metadata, with no supplier/pricing authority."""
from copy import deepcopy
import base64
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
import threading
from uuid import uuid4
from unittest.mock import patch

from PIL import Image
from openpyxl import load_workbook
from pypdf import PdfReader

from feature_client import StaffConnection
from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary, LibraryConflict
from estimator.reference_library import ReferenceLibrary, ReferenceNotFound
from estimator.storage import Store
from estimator.technical_library_edits import ManualTechnicalLibrary, FACETS
from estimator.technical_item_exports import prepare_technical_item, build_technical_item_xlsx, render_technical_item_pdf
from estimator.technical_discovery import ALLPROOF_MANUAL_SOURCE, SNAP_FILTER_SOURCE
from estimator.technical_prose import public_prose_fields
from estimator.server import create_server
from estimator.library_classifications import classification_filters
from estimator.technical_service_options import TECHNICAL_SERVICES
from estimator.technical_duplicates import review_fingerprint
from estimator.penetration_references import resolve_schedule_references
from test_firestopping_library import editable_library


class TechnicalLibraryEditTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        data = editable_library(self.root / 'library', complete_entries=True)
        technical = data['libraries']['technical']
        technical['filters'] = [{'key': key, 'label': label} for key, label in FACETS]
        technical['items'][0]['filter_values'].update(manufacturer=['Sample manufacturer'],
            substrate=['Concrete/masonry wall'], orientation=['Vertical'], type=['Core hole'],
            category=['Plumbing & Hydraulic'], services=['Copper Pipes'], frl=['-/120/120'])
        technical['items'][0]['fields'].extend([
            {'label': 'Manufacturer', 'value': 'Sample manufacturer'},
            {'label': 'Barrier Construction', 'value': 'Concrete wall'},
            {'label': 'Orientation', 'value': 'Vertical'},
            {'label': 'FRL', 'value': '-/120/120'},
            {'label': 'Report Number', 'value': 'Sample report', 'report_links': [{'label': 'Sample report', 'url': 'https://media.promat.com/sample.pdf'}]}])
        self.source = self.root / 'library/library.json'
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.original_source = self.source.read_bytes()
        self.store = Store(self.root / 'state.sqlite3')
        self.library = ManualTechnicalLibrary(self.root / 'library', self.store)
        self.configuration = deepcopy(self.store.configuration())

    def body(self, key=None):
        edit = self.library.technical_edit(key)
        facets = deepcopy(edit['record']['filter_values'])
        for definition in edit['filters']:
            if not facets.get(definition['key']):
                self.assertTrue(definition['options'], definition['key'])
                facets[definition['key']] = [definition['options'][0]['value']]
        facets = {key: facets[key] for key, _ in FACETS}
        return {'revision': edit['revision'], 'source_sha256': edit['source_sha256'],
                'request_key': None if key else uuid4().hex,
                'title': edit['record']['title'] or 'A new technical system',
                'fields': [{'label': field['label'], 'value': field.get('value', '')} for field in edit['record']['fields']],
                'facets': facets, 'report': {'number': 'Sample report', 'url': 'https://example.test/report.pdf'}}

    def test_unassessed_reference_is_searchable_without_claiming_a_rating(self):
        body = self.body()
        body['facets']['frl'] = ['Not assessed']
        key = self.library.technical_save(None, body)['id']
        self.assertEqual(self.library.technical_edit(key)['record']['filter_values']['frl'], ['Not assessed'])
        self.assertEqual(self.library.listing('technical', search=body['title'])['total'], 1)
        self.assertEqual(self.library.listing('technical', search=body['title'], frl='-/120/120')['total'], 0)
        overview = next(row for row in self.library.overview()['libraries'] if row['id'] == 'technical')
        options = next(row['options'] for row in overview['filters'] if row['key'] == 'frl')
        self.assertNotIn('Not assessed', [option['value'] for option in options])
        change = self.body(key)
        change['facets']['frl'].append('-/120/120')
        with self.assertRaisesRegex(ValidationError, 'unassessed'):
            self.library.technical_save(key, change)

    def test_allproof_services_added_after_catalogue_load_receive_filter_groups(self):
        key = 'allproof-reviewed-pipe'
        record = {'id': key, 'title': 'Reviewed pipe', 'source_label': ALLPROOF_MANUAL_SOURCE,
                  'filter_values': {'manufacturer': ['Allproof'], 'services': ['PE-RT/AL/PE-RT']},
                  'sources': [], 'fields': [], 'images': []}
        self.library.technical_edits.save(key, 0, 'b' * 64, record, created=True)
        technical = next(row for row in self.library.overview()['libraries'] if row['id'] == 'technical')
        options = next(row['options'] for row in technical['filters'] if row['key'] == 'services')
        self.assertEqual(next(row['group'] for row in options if row['value'] == 'PE-RT/AL/PE-RT'), 'Plastic pipes')

    def test_assessed_manual_ratings_match_and_export_the_exact_table_row(self):
        choices = {'substrate': 'Concrete/masonry wall', 'orientation': 'Vertical', 'manufacturer': 'Allproof',
                   'type': 'Core hole', 'category': 'Electrical & Communications', 'services': 'D1 Power Cables'}
        for minutes in (30, 45):
            rating = f'-/60/{minutes}'
            key = f'allproof-exact-{minutes}'
            record = {'id': key, 'title': f'ALLFC25 1 × TPS {rating}', 'source_label': ALLPROOF_MANUAL_SOURCE,
                      'fields': [{'label': 'FRL', 'value': rating},
                                 {'label': 'Installation Details', 'value': f'Assessed to FRL {rating}.'}],
                      'filter_values': {**{k: [v] for k, v in choices.items()}, 'report': ['Manual'], 'frl': [rating]},
                      'sources': [], 'images': []}
            self.library.technical_edits.save(key, 0, 'a' * 64, record, created=True)
        for inspection in ('', '1'):
            for minutes in (30, 45):
                with self.subTest(inspection=inspection, minutes=minutes):
                    result = self.library.listing('technical', inspection=inspection, **choices, frl=f'-/60/{minutes}')
                    self.assertEqual([item['id'] for item in result['items']], [f'allproof-exact-{minutes}'])
                    self.assertIn(f'-/60/{minutes}', result['items'][0]['title'])
        key = 'allproof-exact-45'
        self.assertEqual(self.library.inspection_labels([key])[key]['frl'], '-/60/45')
        self.assertEqual(self.library.detail('technical', key)['inspection_options']['frl'], ['-/60/45'])
        self.assertEqual(self.library.technical_edit(key)['record']['filter_values']['frl'], ['-/60/45'])
        filters = {**choices, 'frl': '-/60/45'}
        legacy = prepare_technical_item({'id': key}, library=self.library,
                                        inspection_filters={**filters, 'type': 'Refer to installation details'})
        self.assertEqual(next(f['value'] for f in legacy['fields'] if f['label'] == 'Type'), 'Core hole')
        snapshot = prepare_technical_item({'id': key}, library=self.library, inspection_filters=filters)
        self.assertEqual(next(f['value'] for f in snapshot['fields'] if f['label'] == 'FRL'), '-/60/45')
        pdf_text = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(render_technical_item_pdf(snapshot))).pages)
        self.assertIn('-/60/45', pdf_text)
        self.assertNotIn('-/60/30', pdf_text)
        workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)), read_only=True)
        try:
            self.assertIn(('FRL', '-/60/45'), list(workbook['Item Details'].values))
        finally:
            workbook.close()

    def protected(self):
        self.assertEqual(self.source.read_bytes(), self.original_source)
        self.assertEqual(self.store.configuration(), self.configuration)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM calculator_states').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM quotes').fetchone()[0], 0)

    def test_snap_prose_is_shared_by_search_editor_and_exports_and_retains_source_on_save(self):
        key = 'snap-utility-test'
        raw = self.library.technical_edit('report-a-v1', for_display=False)['record']
        raw.update(id=key, title='SNAP utility collar', source_label=SNAP_FILTER_SOURCE)
        coupling = 'The permitted fitting is a pipe coupling within the collar with the same wall thickness as the assessed pipe.'
        wall = 'Support the pipe on each side within 300 mm of the wall under section 3.2(b).'
        install = ('Fit the collar to the slab soffit. '
                   'Apply the specified annular seal at the top of the slab in accordance with FCO3520.\n\n'
                   'Refer to Table 4 of FCO3520 for the general fixing requirements (excl. HDPE pipes).\n\n'
                   'Seal the annular gap in accordance with Table 3 of FCO3520.\n\n'
                   'Keep the stack straight below the floor. Support the pipe above it within 500 mm along the service, '
                   'with a second support about 1,000 mm from the first where required. ' + coupling
                   + ' See FCO3520 Rev D, Table 7.\n\n' + wall)
        size = ('50 mm. Fitting allowed: Yes. Confirm pipe wall thickness against FCO3520 Table 7; '
                'the printed 50 mm PVC range is unclear.')
        report = {'label': 'Report Number', 'value': 'FCO3520', 'report_links': [
            {'label': 'FCO3520', 'url': 'https://docs.snapcollars.com.au/FCO3520.pdf'}]}
        raw['fields'] = [{'label': 'Installation Details', 'value': install},
                         {'label': 'Service Size / Configuration', 'value': size}, report]
        raw['filter_values']['report'] = ['FCO3520']
        self.library.technical_edits.save(key, 0, 'a' * 64, raw, created=True)
        expected = ('Fit the collar to the slab soffit.\n\n'
                    'Seal the annular gap in accordance with FCO3520.\n\n' + coupling + ' See FCO3520 Rev D, Table 7.\n\n' + wall)
        detail = self.library.detail('technical', key)
        editor = self.library.technical_edit(key)['record']
        snapshot = prepare_technical_item({'id': key}, library=self.library)
        for item in (detail, editor, snapshot):
            fields = {f['label']: f for f in item['fields']}
            self.assertEqual(fields['Installation Details']['value'], expected)
            self.assertEqual(fields['Service Size / Configuration']['value'], '50 mm. Fitting allowed: Yes.')
            self.assertEqual(fields['Report Number']['report_links'], report['report_links'])
        self.assertEqual(self.library.listing('technical', search='unclear')['total'], 0)
        self.assertEqual(self.library.listing('technical', search='specified annular seal')['total'], 0)
        self.assertEqual(self.library.listing('technical', search='FCO3520 coupling')['total'], 1)
        pdf = ' '.join(page.extract_text() for page in PdfReader(BytesIO(render_technical_item_pdf(snapshot))).pages)
        self.assertIn('FCO3520', pdf)
        self.assertNotIn('unclear', pdf)
        workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)), read_only=True)
        try:
            self.assertIn(('Installation Details', expected), list(workbook['Item Details'].values))
        finally:
            workbook.close()
        change = self.body(key)
        change.update(title='Edited collar title', report={'number': 'FCO3520', 'url': report['report_links'][0]['url']})
        self.library.technical_save(key, change)
        stored = self.library.technical_edits.read()[0][key]['record']
        stored_fields = {f['label']: f for f in stored['fields']}
        self.assertEqual(stored_fields['Installation Details']['value'], install)
        self.assertEqual(stored_fields['Service Size / Configuration']['value'], size)
        self.assertEqual(stored_fields['Report Number'], report)
        self.assertEqual(self.library.technical_edit(key)['record']['title'], change['title'])
        self.assertEqual(next(field['value'] for field in self.library.detail('technical', key)['fields']
                              if field['label'] == 'Installation Details'), expected)
        self.protected()

    def test_allproof_patch_type_is_consistent_in_detail_editor_and_saved_inspection_exports(self):
        key = 'allproof-patch-test'
        record = self.library.technical_edit('report-a-v1', for_display=False)['record']
        record.update(id=key, source_label=ALLPROOF_MANUAL_SOURCE)
        record['filter_values'].update(manufacturer=['Allproof'], type=['Oversized core hole'])
        record['fields'] = [field for field in record['fields']
                            if field['label'] not in {'Manufacturer', 'Barrier Construction', 'Type'}]
        record['fields'].extend([
            {'label': 'Manufacturer', 'value': 'Allproof'},
            {'label': 'Barrier Construction', 'value': '75 mm Hebel wall with a 13 mm fire-rated plasterboard patch'},
            {'label': 'Type', 'value': 'Oversized core hole'},
        ])
        self.library.technical_edits.save(key, 0, 'a' * 64, record, created=True)
        self.assertEqual(self.library.detail('technical', key)['inspection_options']['type'], ['Core hole'])
        for result in (self.library.detail('technical', key), self.library.technical_edit(key)['record'],
                       prepare_technical_item({'id': key}, library=self.library,
                                              inspection_filters={'type': 'Oversized core hole'})):
            self.assertEqual(next(field['value'] for field in result['fields'] if field['label'] == 'Type'), 'Core hole')
        change = self.body(key)
        change['title'] = 'Edited patch title'
        self.library.technical_save(key, change)
        stored = self.library.technical_edits.read()[0][key]['record']
        self.assertEqual(next(field['value'] for field in stored['fields'] if field['label'] == 'Type'), 'Core hole')
        self.assertEqual(stored['filter_values']['type'], ['Core hole'])
        self.protected()

    def test_prose_rules_preserve_other_manufacturers_and_conditional_table_references(self):
        fitting = 'Use a P-trap, 4-way gully or gully trap on the exposed side'
        tested = 'Support the stack 500 mm and 1500 mm above the floor as tested.'
        report = {'label': 'Report Number', 'value': 'FCO3520'}
        for source, manufacturer, snap in (
                (SNAP_FILTER_SOURCE, '', True), ('User-created Technical Library item', 'Snap', True),
                ('Another supplier', 'Another manufacturer', False)):
            raw = (fitting + ', with the pipe supported above the slab. Support the stack above the slab. '
                   'Apply the specified annular seal at both wall faces in accordance with FCO3520. '
                   'Refer to Table 5 of FCO3520 for the general fixing requirements with HDPE pipes. '
                   'Seal in accordance with Table 3 of FCO3520. Follow the types listed within Table 3 of this report. ' + tested)
            original = {'label': 'Installation Details', 'value': raw}
            result = public_prose_fields({'source_label': source, 'fields': [
                original, report, {'label': 'Manufacturer', 'value': manufacturer},
                {'label': 'System Products', 'value': 'SNAP utility collar'}]})
            expected = raw.replace('Table 3 of FCO3520', 'FCO3520')
            if snap:
                expected = fitting + '. Seal in accordance with FCO3520. Follow the types listed within Table 3 of this report. ' + tested
            self.assertEqual(result[0]['value'], expected)
            self.assertEqual(result[1], report)
            self.assertEqual(original['value'], raw)

        installation = ('Keep the stack straight below the floor. Support the pipe above it within 500 mm along the service, '
                        'with a second support about 1,000 mm from the first where required. See FCO3520 Rev D, Table 10.')
        assessed_size = 'Assessed pipe wall thickness 3.5 mm.'
        record = {'filter_values': {'manufacturer': ['Snap']}, 'fields': [
            {'label': 'Installation Details', 'value': 'Seal the floor.\n\n' + installation},
            {'label': 'Service Size / Configuration', 'value': assessed_size + ' '
             'Confirm pipe wall thickness against FCO3520 Table 38; the printed 50 mm PVC range is unclear.'}]}
        self.assertEqual([field['value'] for field in public_prose_fields(record)], ['Seal the floor.', assessed_size])

    def test_public_source_options_hide_only_selected_report_page_index(self):
        report_pages = 'Selected configuration: FC10266-01-5 pp. 2,3,13,18,19,20.'
        source = {'label': 'Source Options', 'value': report_pages}
        report = {'label': 'Report Number', 'value': 'FC10266-01-5'}
        self.assertEqual(public_prose_fields({'fields': [source, report]}), [report])
        self.assertEqual(source['value'], report_pages)
        condition = 'Use this assembly only for the configurations identified in the assessment.'
        scoped = {**source, 'value': report_pages + ' ' + condition}
        self.assertEqual(public_prose_fields({'fields': [scoped, report]}),
                         [{**scoped, 'value': condition}, report])

    def install_alias(self):
        """A real source-bound group retains different descriptive wording."""
        data = json.loads(self.source.read_text(encoding='utf-8'))
        duplicate = deepcopy(data['libraries']['technical']['items'][0])
        duplicate['id'] = 'report-a-alias'
        duplicate['fields'].append({'label': 'Configuration', 'value': 'Historical wording'})
        data['libraries']['technical']['items'].append(duplicate)
        self.source.write_text(json.dumps(data), encoding='utf-8')
        loaded = ReferenceLibrary(self.root / 'library')._load()
        members = [{'id': item['id'], 'sha256': review_fingerprint(
            item, loaded['_records']['technical'][item['id']], loaded['_assets'])}
            for item in data['libraries']['technical']['items']]
        data['technical_duplicate_reviews'] = [{'canonical_id': 'report-a-v1', 'members': members}]
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.original_source = self.source.read_bytes()
        self.library = ManualTechnicalLibrary(self.root / 'library', self.store)
        self.assertEqual(self.library._load()['_aliases']['report-a-alias'], 'report-a-v1')

    def test_alias_edit_export_links_schedule_and_delete_share_one_record(self):
        self.install_alias()
        alias, canonical = 'report-a-alias', 'report-a-v1'
        self.assertEqual(self.library.detail('technical', alias), self.library.detail('technical', canonical))
        original_images = self.library.detail('technical', canonical).get('images')
        original_source = self.library._original_technical_source(canonical, self.library._load())
        stale = self.body(canonical)
        body = self.body(alias)
        body['title'] = 'One reviewed system'
        body['facets']['services'] = ['Steel Pipes']
        saved = self.library.technical_save(alias, body)
        self.assertEqual(saved['id'], canonical)
        self.assertEqual(set(self.library.technical_edits.read()[0]), {canonical})
        reopened = ManualTechnicalLibrary(self.root / 'library', self.store)
        detail = reopened.detail('technical', alias)
        self.assertEqual(detail, reopened.detail('technical', canonical))
        self.assertEqual(detail['title'], body['title'])
        self.assertEqual(next(field['value'] for field in detail['fields'] if field['label'] == 'Services'), 'Steel Pipes')
        self.assertEqual(detail.get('images'), original_images)
        self.assertEqual(reopened._original_technical_source(canonical, reopened._load()), original_source)
        self.assertEqual(reopened.technical_edit(alias)['record']['filter_values']['services'], ['Steel Pipes'])
        with self.assertRaises(LibraryConflict):
            reopened.technical_save(alias, stale)
        self.assertEqual(prepare_technical_item({'id': alias}, library=reopened),
                         prepare_technical_item({'id': canonical}, library=reopened))
        reopened.technical_link(alias, {'penetration_ids': ['pkb-002']})
        self.assertEqual([link['id'] for link in reopened.detail('penetration', 'pkb-002')['links']], [canonical])
        reopened.remove_link('pkb-002', {'technical_id': alias})
        reopened.add_link('pkb-002', {'technical_ids': [alias]})
        self.assertEqual([link['id'] for link in reopened.detail('penetration', 'pkb-002')['links']], [canonical])
        draft = {'globals': {}, 'rows': [{'id': 'row-1', 'inputs': {}, 'technical_reference_ids': [alias]}]}
        references = resolve_schedule_references(draft, reopened)['row_references']['row-1']
        self.assertEqual(references['systems'], [{'id': canonical, 'title': body['title'], 'number': 1}])
        self.assertEqual(reopened.listing('technical', search=alias)['total'], 0)
        self.assertEqual(reopened.detail('technical', alias)['id'], canonical)
        edit = reopened.technical_edit(alias)
        self.assertEqual(reopened.technical_delete(alias, {key: edit[key] for key in ('revision', 'source_sha256')})['id'], canonical)
        final = ManualTechnicalLibrary(self.root / 'library', self.store)
        for key in (alias, canonical):
            with self.assertRaises(ReferenceNotFound):
                final.detail('technical', key)
            with self.assertRaises(ReferenceNotFound):
                final.technical_edit(key)
            with self.assertRaises(ReferenceNotFound):
                final.add_link('pkb-002', {'technical_id': key})
        self.assertEqual(final.listing('technical')['total'], 0)
        self.assertFalse(final.detail('penetration', 'pkb-001')['links'])
        self.assertFalse(final.detail('penetration', 'pkb-002')['links'])
        references = resolve_schedule_references(draft, final)['row_references']['row-1']
        self.assertEqual(references['systems'], [])
        self.assertEqual(references['missing_ids'], [alias])
        self.protected()

    def test_shared_filter_values_match_canonical_case_without_changing_source_inputs(self):
        data = json.loads(self.source.read_text(encoding='utf-8'))
        data['libraries']['technical']['items'][0]['filter_values']['manufacturer'] = ['Firefly']
        data['libraries']['technical']['items'][0]['fields'][1] = {'label': 'Manufacturer', 'value': 'Firefly'}
        second = deepcopy(data['libraries']['technical']['items'][0])
        second['id'] = 'report-b'; second['filter_values']['manufacturer'] = ['Trafalgar']
        second['fields'][1] = {'label': 'Manufacturer', 'value': 'Trafalgar'}
        data['libraries']['technical']['items'].append(second)
        for item, manufacturer in zip(data['libraries']['penetration']['items'], ('FIREFLY', 'TRAFALGAR')):
            item['filter_values']['manufacturer'] = [manufacturer]
            item['estimate']['draft']['rows'][0]['inputs']['V'] = manufacturer
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.original_source = self.source.read_bytes()
        library = ManualTechnicalLibrary(self.root / 'library', self.store)
        for value, key in [('Firefly', 'pkb-001'), ('Trafalgar', 'pkb-002')]:
            self.assertEqual([item['id'] for item in library.listing('penetration', manufacturer=value)['items']], [key])
            self.assertEqual([item['id'] for item in library.listing('penetration', manufacturer=value.upper())['items']], [key])
            self.assertEqual([item['id'] for item in library.listing('penetration', manufacturer=value.lower())['items']], [key])
            self.assertEqual(library._load()['_records']['penetration'][key]['filter_values']['manufacturer'], [value])
            self.assertEqual(library.edit(key)['draft']['rows'][0]['inputs']['V'], value.upper())
        self.protected()

    def test_deleting_canonical_removes_related_navigation_from_remaining_detail(self):
        data = json.loads(self.source.read_text(encoding='utf-8'))
        remaining = deepcopy(data['libraries']['technical']['items'][0])
        remaining['id'] = 'remaining-system'
        data['libraries']['technical']['items'].append(remaining)
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.original_source = self.source.read_bytes()
        base = FirestoppingLibrary(self.root / 'library', self.store)._load()
        # The source projector supplies this navigation map independently of
        # CRUD. Exercise a surviving record pointing to a removed target.
        base['_technical_related_records']['remaining-system'] = ['report-a-v1']
        self.library = ManualTechnicalLibrary(self.root / 'library', self.store)
        with patch.object(FirestoppingLibrary, '_load', return_value=base):
            self.assertEqual(self.library.detail('technical', 'remaining-system')['related_technical_records'][0]['id'], 'report-a-v1')
            edit = self.library.technical_edit('report-a-v1')
            self.library.technical_delete('report-a-v1', {key: edit[key] for key in ('revision', 'source_sha256')})
            detail = self.library.detail('technical', 'remaining-system')
            self.assertEqual(detail['id'], 'remaining-system')
            self.assertEqual(detail['related_technical_records'], [])
        self.protected()

    def test_hvac_aliases_and_plumbing_service_groups_work_across_both_libraries(self):
        data = json.loads(self.original_source)
        records = data['libraries']['penetration']['items']
        for record, category, service in zip(records, ('Mechanical', 'Electrical & Communications'),
                                             ('Lagged Copper Pipes', 'Cable Trays')):
            record['estimate']['draft']['rows'][0]['inputs'].update(J=category, K=service)
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.original_source = self.source.read_bytes()
        library = self.library
        for category in ('HVAC & Mechanical', 'HVAC', 'Mechanical', 'Plumbing & Hydraulic'):
            with self.subTest(kind='penetration', category=category):
                self.assertEqual([item['id'] for item in library.listing('penetration', category=category)['items']],
                                 [records[0]['id']])
        self.assertEqual(library.edit(records[0]['id'])['draft']['rows'][0]['inputs']['J'], 'Mechanical')

        services = ('Pair Coils', 'uPVC pipe', 'Lagged Copper Pipes', 'Copper Pipes', 'Cable Trays')
        ids = {}
        for service in services:
            body = self.body()
            body['title'] = 'Taxonomy fixture ' + service
            body['facets'].update(category=['Electrical & Communications'], services=[service])
            ids[service] = library.technical_save(None, body)['id']
        for category in ('HVAC & Mechanical', 'HVAC', 'Mechanical', 'Plumbing & Hydraulic'):
            with self.subTest(kind='technical', category=category):
                listed = library.listing('technical', category=category, search='Taxonomy fixture')
                expected = [ids[service] for service in services[:4]] if category == 'Plumbing & Hydraulic' else [ids['Pair Coils']]
                self.assertCountEqual([item['id'] for item in listed['items']], expected)
        for key in ('technical', 'penetration'):
            options = next(field['options'] for field in library.listing(key)['filters'] if field['key'] == 'category')
            displayed = [o['value'] for o in options]
            self.assertEqual(displayed.count('HVAC & Mechanical'), 1)
            self.assertNotIn('HVAC', displayed)
            self.assertNotIn('Mechanical', displayed)
        self.protected()

    def test_shared_service_aliases_find_historical_and_current_rows_once(self):
        data = json.loads(self.source.read_text(encoding='utf-8'))
        prototype = data['libraries']['penetration']['items'][0]
        services = ['Pair Coil Bundle', 'Pair Coils', 'Multi-service Bundle', 'Mixed Service Bundle',
                    'Data Cable Bundles', 'Power Cable Bundles', 'TPS & Fire Alarm Cable Bundles',
                    'Lagged Pipes', 'Unlagged Pipes', 'Plastic Pipes', 'Downlight Box']
        rows = []
        for index, service in enumerate(services, 1):
            item = deepcopy(prototype)
            item['id'] = 'service-' + str(index)
            item['library_id'] = f'FL-ID-{index:03d}'
            item['estimate']['draft']['rows'][0]['inputs'].update(J='Mechanical', K=service)
            rows.append(item)
        data['libraries']['penetration']['items'] = rows
        data['links'] = []
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.original_source = self.source.read_bytes()
        library = ManualTechnicalLibrary(self.root / 'library', self.store)
        expected = {'Pair Coils': ['service-1', 'service-2'],
                    'Mixed Services': ['service-3', 'service-4'],
                    'Data Cables': ['service-5'], 'Power Cables': ['service-6'],
                    'TPS & Fire Alarm Cables': ['service-7']}
        for choice, ids in expected.items():
            result = library.listing('penetration', service_type=choice)
            self.assertEqual(result['total'], len(ids))
            self.assertCountEqual([item['id'] for item in result['items']], ids)
        for index, service in enumerate(services, 1):
            key = 'service-' + str(index)
            self.assertIn(key, [item['id'] for item in library.listing('penetration', service_type=service)['items']])
            self.assertEqual(library.edit(key)['draft']['rows'][0]['inputs']['K'], service)
        for key in ['service-8', 'service-9', 'service-10', 'service-11']:
            self.assertEqual(library._load()['_records']['penetration'][key]['filter_values']['service_type'],
                             [services[int(key.split('-')[-1])-1]])
        plumbing = library.listing('penetration', category='Plumbing & Hydraulic')
        self.assertCountEqual([item['id'] for item in plumbing['items']],
                              ['service-1', 'service-2', 'service-8', 'service-9', 'service-10'])
        edit = library.edit('service-10')
        before = deepcopy(edit['result']['rows'][0]['outputs'])
        body = {key: deepcopy(edit[key]) for key in ('draft', 'revision', 'pricing_token')}
        body['draft']['rows'][0]['inputs']['T'] = 'Unrelated description edit'
        library.action('service-10', 'save', body)
        reopened = ManualTechnicalLibrary(self.root / 'library', self.store).edit('service-10')
        self.assertEqual(reopened['draft']['rows'][0]['inputs']['K'], 'Plastic Pipes')
        self.assertEqual(reopened['draft']['rows'][0]['inputs']['T'], 'Unrelated description edit')
        self.assertEqual(reopened['result']['rows'][0]['outputs'], before)
        self.assertEqual(reopened['pricing_token'], edit['pricing_token'])
        self.protected()

    def test_create_is_durable_searchable_and_retry_is_idempotent(self):
        body = self.body()
        result = self.library.technical_save(None, body)
        self.assertEqual(self.library.technical_save(None, body), result)
        reopened = ManualTechnicalLibrary(self.root / 'library', self.store)
        self.assertEqual(reopened.detail('technical', result['id'])['title'], body['title'])
        self.assertIn(result['id'], [row['id'] for row in reopened.listing('technical', search='new technical')['items']])
        self.assertEqual(len(reopened.technical_edits.read()[0]), 1)
        altered = deepcopy(body); altered['title'] = 'Another item'
        with self.assertRaises(LibraryConflict):
            reopened.technical_save(None, altered)
        self.protected()

    def test_supplier_edit_preserves_raw_source_and_rejects_stale_editor(self):
        body = self.body('report-a-v1'); stale = deepcopy(body)
        body['title'] = 'Reviewed user title'
        self.library.technical_save('report-a-v1', body)
        self.assertEqual(self.library.detail('technical', 'report-a-v1')['title'], body['title'])
        with self.assertRaises(LibraryConflict):
            self.library.technical_save('report-a-v1', stale)
        raw = self.library._load()['libraries']['technical']['items'][0]
        self.assertEqual(raw['title'], 'V1 — Copper service')
        self.protected()

    def test_delete_hides_item_and_reciprocal_links_without_deleting_evidence(self):
        edit = self.library.technical_edit('report-a-v1')
        self.library.technical_delete('report-a-v1', {key: edit[key] for key in ('revision', 'source_sha256')})
        with self.assertRaises(ReferenceNotFound):
            self.library.detail('technical', 'report-a-v1')
        self.assertFalse(self.library.detail('penetration', 'pkb-001')['links'])
        reopened = ManualTechnicalLibrary(self.root / 'library', self.store)
        self.assertEqual(reopened.listing('technical')['total'], 0)
        self.protected()

    def test_link_new_item_both_directions_and_unlink_survives_reopen(self):
        result = self.library.technical_save(None, self.body()); key = result['id']
        self.library.technical_link(key, {'penetration_ids': ['pkb-001', 'pkb-002']})
        self.assertEqual({row['id'] for row in self.library.detail('technical', key)['links']}, {'pkb-001', 'pkb-002'})
        self.library.remove_link('pkb-002', {'technical_id': key})
        self.assertEqual([row['id'] for row in self.library.detail('technical', key)['links']], ['pkb-001'])
        self.library.add_link('pkb-002', {'technical_ids': [key]})
        reopened = ManualTechnicalLibrary(self.root / 'library', self.store)
        self.assertIn(key, [row['id'] for row in reopened.detail('penetration', 'pkb-002')['links']])
        self.protected()

    def test_library_filters_and_editor_use_exact_canonical_options_and_groups(self):
        overview = self.library.overview()['libraries']
        technical, penetration = [next(row for row in overview if row['id'] == kind)['filters'] for kind in ('technical', 'penetration')]
        rename = {'penetration_type': 'type', 'service_type': 'services'}
        self.assertEqual(technical, [{**row, 'key': rename.get(row['key'], row['key'])} for row in penetration])
        edit = self.library.edit('pkb-001')
        columns = {'J':'category','K':'services','L':'type','M':'orientation','N':'frl','P':'substrate','V':'manufacturer'}
        options = {row['key']:row['options'] for row in technical}
        for field in edit['definition']['row_fields']:
            if field['column'] in columns:
                self.assertEqual(field['library_option_groups'], options[columns[field['column']]])
        self.protected()

    def test_unknown_classifications_unsafe_urls_and_forged_source_fields_are_rejected(self):
        for mutate in (lambda body: body['facets']['services'].append('Invented unapproved pipe'),
                       lambda body: body['facets']['services'].append({}),
                       lambda body: body['report'].update(url='javascript:alert(1)'),
                       lambda body: body.update(technical_basis={'source_fields': []})):
            body = self.body(); mutate(body)
            with self.assertRaises(ValidationError):
                self.library.technical_save(None, body)
        self.assertFalse(self.library.technical_edits.read()[0])
        self.protected()

    def test_changed_supplier_source_withholds_old_overlay(self):
        body = self.body('report-a-v1'); body['title'] = 'Old edited title'
        self.library.technical_save('report-a-v1', body)
        data = json.loads(self.source.read_bytes()); data['libraries']['technical']['items'][0]['title'] = 'New supplier source'
        self.source.write_text(json.dumps(data), encoding='utf-8')
        current = ReferenceLibrary(self.root / 'library').detail('technical', 'report-a-v1')['title']
        self.assertEqual(self.library.detail('technical', 'report-a-v1')['title'], current)
        self.assertNotEqual(current, 'Old edited title')
        with self.assertRaises(LibraryConflict):
            self.library.technical_edit('report-a-v1')

    def test_manual_report_url_exports_but_imported_authority_marker_is_rejected(self):
        result = self.library.technical_save(None, self.body())
        detail = self.library.detail('technical', result['id'])
        self.assertTrue(detail['user_authored'])
        snapshot = prepare_technical_item({'id': result['id']}, library=self.library)
        report = next(field for field in snapshot['fields'] if field['label'] == 'Report Number')
        self.assertEqual(report['report_links'][0]['url'], 'https://example.test/report.pdf')
        self.protected()
        data = json.loads(self.source.read_bytes()); data['libraries']['technical']['items'][0]['user_authored'] = True
        self.source.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaises(ValidationError):
            ReferenceLibrary(self.root / 'library').listing('technical')

    def test_http_crud_routes_validate_revision_and_persist_across_library_reopen(self):
        server = create_server(0, database=self.store.path, library_directory=self.root / 'library')
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def close():
            server.shutdown(); server.server_close(); thread.join(timeout=5)
        self.addCleanup(close)
        def request(method, path, body=None):
            connection = StaffConnection(server)
            connection.request(method, path, body=json.dumps(body) if body is not None else None,
                               headers={'Content-Type': 'application/json'} if body is not None else {})
            response = connection.getresponse(); result = response.status, json.loads(response.read()); connection.close(); return result
        status, context = request('GET', '/api/libraries/technical/new')
        self.assertEqual(status, 200); self.assertEqual(len(context['filters']), 8)
        body = self.body(); status, receipt = request('POST', '/api/libraries/technical', body)
        self.assertEqual(status, 200); key = receipt['id']
        self.assertEqual(ManualTechnicalLibrary(self.root / 'library', self.store).detail('technical', key)['title'], body['title'])
        stale = self.body(key); fresh = deepcopy(stale); fresh['title'] = 'HTTP updated title'
        self.assertEqual(request('POST', f'/api/libraries/technical/{key}/save', fresh)[0], 200)
        self.assertEqual(request('POST', f'/api/libraries/technical/{key}/save', stale)[0], 409)
        status, current = request('GET', f'/api/libraries/technical/{key}/edit')
        self.assertEqual(status, 200)
        self.assertEqual(request('POST', f'/api/libraries/technical/{key}/delete', {name:current[name] for name in ('revision','source_sha256')})[0], 200)
        self.assertEqual(request('GET', f'/api/libraries/technical/{key}')[0], 404)
        self.protected()

    def test_uploaded_diagrams_persist_render_and_export_without_changing_source(self):
        upload = {'filename': 'Section.png', 'content_base64': base64.b64encode(
            (self.root / 'library/images/diagram-a.png').read_bytes()).decode('ascii')}
        body = self.body()
        body['diagrams'] = {'remove': [], 'uploads': [upload]}
        receipt = self.library.technical_save(None, body)
        self.assertEqual(self.library.technical_save(None, body), receipt)
        key = receipt['id']
        reopened = ManualTechnicalLibrary(self.root / 'library', self.store)
        detail = reopened.detail('technical', key)
        image, = detail['images']
        self.assertTrue(image['user_uploaded'])
        image_id = image['id']
        self.assertEqual(detail['thumbnail_url'], f'/api/libraries/images/{image_id}/thumbnail')
        self.assertEqual(reopened.asset(image_id, pdf=False)[1], 'image/jpeg')
        with Image.open(BytesIO(reopened.image_thumbnail(image_id))) as thumb:
            self.assertLessEqual(thumb.width, 240)
        snapshot = prepare_technical_item({'id': key}, library=reopened)
        self.assertEqual([(item['id'], item['caption']) for item in snapshot['images']], [(image_id, 'Section.png')])
        change = self.body(key)
        change['diagrams'] = {'remove': [image_id], 'uploads': [{'filename': 'bad.png', 'content_base64': 'YWJj'}]}
        with self.assertRaises(ValidationError):
            reopened.technical_save(key, change)
        self.assertEqual(reopened.technical_edit(key)['revision'], receipt['revision'])
        self.assertTrue(reopened.asset(image_id, pdf=False)[0])
        change['diagrams']['uploads'] = []
        reopened.technical_save(key, change)
        self.assertFalse(reopened.detail('technical', key)['images'])
        with self.assertRaises(ReferenceNotFound):
            reopened.asset(image_id, pdf=False)
        self.protected()

    def test_initialization_adds_only_library_tables_and_crud_preserves_every_existing_row(self):
        store = Store(self.root / 'existing.sqlite3')
        FirestoppingLibrary(self.root / 'library', store)
        with store.connect() as db:
            db.execute("INSERT INTO quotes VALUES ('retained','Existing quote','original-time','{}')")
            db.execute("INSERT INTO calculator_states VALUES ('retained-calculator','{}','original-time')")
        def snapshot():
            with store.connect() as db:
                schema = dict(db.execute("SELECT name,sql FROM sqlite_master WHERE type='table'"))
                rows = {name: db.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall() for name in schema}
                return schema, rows
        old_schema, old_rows = snapshot()
        library = ManualTechnicalLibrary(self.root / 'library', store)
        result = library.technical_save(None, self.body())
        library.technical_link(result['id'], {'penetration_ids': ['pkb-002']})
        context = library.technical_edit(result['id'])
        library.technical_delete(result['id'], {key:context[key] for key in ('revision','source_sha256')})
        schema, rows = snapshot()
        self.assertEqual(set(schema) - set(old_schema), {'technical_library_items', 'technical_library_links',
                                                          'technical_library_diagrams', 'technical_library_source_images',
                                                          'technical_library_public_ids'})
        for name in old_schema:
            self.assertEqual(schema[name], old_schema[name]); self.assertEqual(rows[name], old_rows[name])
        self.protected()

    def test_report_filters_preserve_document_alias_and_linked_firestopping_membership(self):
        data = json.loads(self.source.read_bytes())
        technical = data['libraries']['technical']
        next(entry for entry in technical['filters'] if entry['key'] == 'report')['key'] = 'document'
        item = technical['items'][0]; item['filter_values']['document'] = item['filter_values'].pop('report')
        self.source.write_text(json.dumps(data), encoding='utf-8')
        self.assertEqual(self.library.listing('technical', report='Sample report')['total'], 1)
        self.assertEqual(self.library.listing('technical', document='Sample report')['total'], 1)
        self.assertEqual([row['id'] for row in self.library.listing('penetration', report='Sample report')['items']], ['pkb-001'])

    def test_blank_report_url_saves_and_exports_as_plaintext_but_number_is_required(self):
        body = self.body(); body['report']['url'] = ''
        result = self.library.technical_save(None, body)
        snapshot = prepare_technical_item({'id': result['id']}, library=self.library)
        report = next(field for field in snapshot['fields'] if field['label'] == 'Report Number')
        self.assertEqual(report['value'], 'Sample report'); self.assertEqual(report['report_links'], [])
        invalid = self.body(); invalid['report'] = {'number': '', 'url': ''}
        with self.assertRaises(ValidationError):
            self.library.technical_save(None, invalid)
        self.protected()

    def test_unchanged_multiple_report_links_survive_an_unrelated_edit(self):
        data = json.loads(self.source.read_bytes())
        report = next(field for field in data['libraries']['technical']['items'][0]['fields'] if field['label'] == 'Report Number')
        report['value'] = 'Sample report\nOther report'; report['report_links'].append({'label': 'Other report', 'url': 'https://media.promat.com/other.pdf'})
        self.source.write_text(json.dumps(data), encoding='utf-8'); self.original_source = self.source.read_bytes()
        body = self.body('report-a-v1'); body['title'] = 'Only the title changes'; body['report'] = {'number': report['value'], 'url': ''}
        self.library.technical_save('report-a-v1', body)
        saved = next(field for field in self.library.detail('technical', 'report-a-v1')['fields'] if field['label'] == 'Report Number')
        self.assertEqual(saved['value'], report['value']); self.assertEqual(saved['report_links'], report['report_links'])
        self.protected()

    def test_link_cache_refreshes_for_same_key_changes_at_an_identical_timestamp(self):
        key = self.library.technical_save(None, self.body())['id']
        with patch('estimator.technical_library_edits.timestamp', return_value='fixed-clock-value'):
            self.library.technical_link(key, {'penetration_ids': ['pkb-002']})
            self.assertIn(key, [item['id'] for item in self.library.detail('penetration', 'pkb-002')['links']])
            self.library.remove_link('pkb-002', {'technical_id': key})
            self.assertNotIn(key, [item['id'] for item in self.library.detail('penetration', 'pkb-002')['links']])
            self.library.technical_link(key, {'penetration_ids': ['pkb-002']})
            self.assertIn(key, [item['id'] for item in self.library.detail('penetration', 'pkb-002')['links']])
        self.protected()

    def test_no_installed_bundle_still_has_shared_choices_and_durable_manual_authoring(self):
        absent = self.root / 'no-installed-bundle'; store = Store(self.root / 'no-bundle.sqlite3')
        library = ManualTechnicalLibrary(absent, store)
        metadata = library.overview()['libraries']
        technical = next(item for item in metadata if item['id'] == 'technical')
        firestopping = next(item for item in metadata if item['id'] == 'penetration')
        self.assertTrue(technical['available']); self.assertTrue(firestopping['available'])
        self.assertEqual(technical['count'], 0); self.assertEqual(technical['source_count'], 0)
        self.assertEqual(technical['filters'], classification_filters())
        rename = {'service_type':'services','penetration_type':'type'}
        self.assertEqual(technical['filters'], [{**entry,'key':rename.get(entry['key'],entry['key'])} for entry in firestopping['filters']])
        options = {entry['key']:entry['options'] for entry in technical['filters']}
        self.assertTrue(options['substrate']); self.assertIn('HVAC & Mechanical', [entry['value'] for entry in options['category']])
        self.assertCountEqual([entry['value'] for entry in options['services']], TECHNICAL_SERVICES)
        expected_editor_filters = deepcopy(technical['filters'])
        frl = next(row for row in expected_editor_filters if row['key'] == 'frl')
        frl['options'].append({'value': 'Not assessed', 'label': 'Not assessed'})
        self.assertEqual(library.technical_edit()['filters'], expected_editor_filters)
        body = self.body(); created = library.technical_save(None, body)
        reopened = ManualTechnicalLibrary(absent, store)
        self.assertEqual(reopened.detail('technical', created['id'])['title'], body['title'])
        self.assertFalse(absent.exists(), 'Manual authoring must not fabricate or install a supplier bundle.')
