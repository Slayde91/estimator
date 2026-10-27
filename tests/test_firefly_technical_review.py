"""Synthetic private review inventories; no supplier transcriptions in Git."""
from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.firefly_reference_review import REPORTS, fingerprint
from estimator.firefly_technical_review import (
    PLAN_NAME, REVIEW_KEY, load_review, plan_stamp, project,
    projection_fingerprint, validate_plan,
)
from estimator.firestopping_library import FirestoppingLibrary
from estimator.library_report_links import FIREFLY_REPORTS_URL
from estimator.reference_library import ReferenceLibrary
from estimator.register_references import ReferenceIndex
from estimator.storage import Store
from estimator.technical_item_exports import (prepare_technical_item,
    build_technical_item_xlsx, render_technical_item_pdf)
from test_firestopping_library import editable_library


def fixture(folder, target_count=1, report_key='report'):
    data = editable_library(folder)
    for report, (revision, digest) in REPORTS.items():
        data['documents'].append({'id': report, 'filename': revision + ' FIREFLY synthetic.pdf',
                                  'sha256': digest, 'pages': 400})
    def item(report, system, page, barrier):
        return {'id': report + '-system-' + system.lower(), 'title': system + ' synthetic system',
                'fields': [{'label': 'ID', 'value': system},
                           {'label': 'Manufacturer', 'value': 'Firefly'},
                           {'label': 'Service', 'value': 'Copper Pipes'},
                           {'label': 'Separating Element', 'value': barrier},
                           {'label': 'Orientation', 'value': 'Vertical'},
                           {'label': 'FRL', 'value': '-/120/120'},
                           {'label': 'Installation Details', 'value': 'Synthetic retained installation conditions.'},
                           {'label': 'Report Number', 'value': report.upper()}],
                'sources': [{'document_id': report, 'sha256': REPORTS[report][1], 'page': page}],
                'filter_values': {'manufacturer': ['Firefly'], report_key: [report.upper()]}}
    target = item('fas190234', 'V1', 5, 'Plasterboard wall')
    other_targets = [item('fas190234', f'V{number}', 5, 'Plasterboard wall') for number in range(2, target_count + 1)]
    source235 = [item('fas190235', f'V{number:03d}', number % 20 + 1, 'FIREFLYBatt wall') for number in range(1, 322)]
    source236 = [item('fas190236', f'H{number:03d}', number + 1, '') for number in range(1, 17)]
    data['libraries']['technical']['items'] = [target, *other_targets, *source235, *source236]
    data['libraries']['technical']['filters'] = [
        {'key': report_key, 'label': 'Report'}, {'key': 'manufacturer', 'label': 'Manufacturer'}]
    data['links'] = [{'penetration_id': 'pkb-001', 'technical_id': source235[0]['id'],
                      'relationship': 'Synthetic retained Firestopping relationship.'}]
    index = folder / 'library.json'
    index.write_text(json.dumps(data), encoding='utf-8')
    baseline = ReferenceLibrary(folder)._load()
    selected = source236[:15]
    entries = []
    for original in [*source235, *selected]:
        report = original['sources'][0]['document_id']
        page = original['sources'][0]['page']
        evidence = [{'report_id': report, 'page': page, 'reference': 'PRIVATE-REVIEW-ONLY synthetic exact row'}]
        value = 'Plasterboard wall' if report == 'fas190235' else 'INEX floor'
        entries.append({'id': original['id'], 'item_sha256': fingerprint(original),
            'projection_sha256': projection_fingerprint(baseline['_records']['technical'][original['id']]),
            'report_id': report, 'system_id': original['fields'][0]['value'], 'pages': [page],
            'substrates': [{'value': value, 'evidence': deepcopy(evidence)}],
            'related_technical': [target['id']] if report == 'fas190235' else [],
            'evidence': evidence})
    plan = {'schema_version': 1, 'review_id': 'synthetic-complete-review',
            'index_sha256': hashlib.sha256(index.read_bytes()).hexdigest(),
            'reports': [{'id': key, 'revision': revision, 'sha256': digest}
                        for key, (revision, digest) in sorted(REPORTS.items())],
            'scope': {'fas190235_count': 321, 'fas190236_ids': [item['id'] for item in selected]},
            'targets': [{'id': target['id'], 'item_sha256': fingerprint(target), 'system_id': 'V1', 'pages': [5]}],
            'items': entries}
    return data, baseline, plan


def write_plan(folder, plan):
    path = folder / 'reviews' / PLAN_NAME
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(plan), encoding='utf-8')
    return path


class FireflyTechnicalReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.directory = cls.root / 'library'
        cls.data, cls.baseline, cls.plan = fixture(cls.directory)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def capability(self, plan=None, data=None):
        return validate_plan(data or self.data, self.plan['index_sha256'], plan or self.plan)

    def projected(self, capability=None, baseline=None):
        base = baseline or self.baseline
        return project(base['_technical_public_records'], base['_records']['technical'],
                       base['_aliases'], capability or self.capability(), ['report'])

    def test_absent_plan_retains_the_current_classification(self):
        self.assertIsNone(load_review(self.directory, self.data, self.plan['index_sha256'], None))
        records = self.baseline['_technical_public_records']
        result, related, additions = project(records, records, {}, None, ['report'])
        self.assertIs(result, records)
        self.assertEqual((related, additions), ({}, {}))

    def test_complete_projection_is_additive_one_way_and_preserves_source_and_conditions(self):
        before = deepcopy(self.baseline)
        result, related, additions = self.projected()
        self.assertEqual(len(additions), 336)
        self.assertEqual(len(related), 321)
        row = self.plan['items'][0]
        item = result[row['id']]
        self.assertEqual(set(item['filter_values']['substrate']), {'FIREFLYBatt wall', 'Plasterboard wall'})
        fields = {field['label']: field for field in item['fields']}
        original = {field['label']: field for field in before['_records']['technical'][row['id']]['fields']}
        self.assertEqual({key: value for key, value in fields.items() if key != 'Report Number'},
                         {key: value for key, value in original.items() if key != 'Report Number'})
        captions = ['FAS190234', 'FAS190235']
        self.assertEqual(fields['Report Number']['value'], '\n'.join(captions))
        self.assertEqual(fields['Report Number']['report_links'], [{'label': label, 'url': FIREFLY_REPORTS_URL} for label in captions])
        self.assertEqual(fields['Report Number']['report_separator'], ' | ')
        self.assertEqual(related[row['id']], ['fas190234-system-v1'])
        self.assertNotIn('fas190234-system-v1', related)
        self.assertEqual(item['technical_basis'], original_basis := before['_records']['technical'][row['id']]['technical_basis'])
        self.assertEqual(original_basis['source_fields'], self.data['libraries']['technical']['items'][1]['fields'])
        self.assertEqual(self.baseline, before)
        selected236 = self.plan['scope']['fas190236_ids'][0]
        self.assertEqual(result[selected236]['filter_values']['substrate'], ['INEX floor'])
        self.assertEqual(result['fas190236-system-h016'], before['_technical_public_records']['fas190236-system-h016'])

    def test_inventory_report_and_scope_changes_fail_closed(self):
        mutations = [
            lambda plan: plan['items'].pop(),
            lambda plan: plan['items'].__setitem__(1, deepcopy(plan['items'][0])),
            lambda plan: plan['scope'].__setitem__('fas190235_count', 320),
            lambda plan: plan['scope']['fas190236_ids'].pop(),
            lambda plan: plan.__setitem__('index_sha256', 'b' * 64),
            lambda plan: plan['reports'][0].__setitem__('revision', 'another revision'),
            lambda plan: plan['reports'][1].__setitem__('sha256', 'b' * 64),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                plan = deepcopy(self.plan); mutate(plan)
                with self.assertRaises(ValueError): self.capability(plan)

    def test_raw_item_system_pages_target_and_citation_are_bound(self):
        mutations = [
            lambda row: row.__setitem__('item_sha256', 'a' * 64),
            lambda row: row.__setitem__('system_id', 'another system'),
            lambda row: row.__setitem__('pages', [True]),
            lambda row: row.__setitem__('pages', [399]),
            lambda row: row['related_technical'].__setitem__(0, 'missing'),
            lambda row: row.__setitem__('related_technical', []),
            lambda row: row['evidence'][0].__setitem__('page', 399),
            lambda row: row['substrates'][0]['evidence'][0].__setitem__('report_id', 'fas190236'),
            lambda row: row['substrates'][0].__setitem__('value', 'Invented arbitrary material'),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                plan = deepcopy(self.plan); mutate(plan['items'][0])
                with self.assertRaises(ValueError): self.capability(plan)
        for field, value in [('item_sha256', 'a' * 64), ('system_id', 'another system'), ('pages', [4])]:
            plan = deepcopy(self.plan); plan['targets'][0][field] = value
            with self.assertRaises(ValueError): self.capability(plan)
        changed = deepcopy(self.data); changed['documents'][-1]['sha256'] = 'f' * 64
        with self.assertRaises(ValueError): self.capability(data=changed)

    def test_changed_late_projection_cannot_partially_publish_or_mutate_inputs(self):
        base = deepcopy(self.baseline)
        base['_records']['technical'][self.plan['items'][-1]['id']]['fields'].append({'label': 'FRL', 'value': '-/60/60'})
        before = deepcopy(base)
        with self.assertRaisesRegex(ValueError, 'projection changed'):
            self.projected(baseline=base)
        self.assertEqual(base, before)
        with self.assertRaises(ValueError): project({}, {}, {}, {'payload': 'forged'}, ['report'])

    def test_reviewed_aliases_cannot_merge_different_site_applicability(self):
        first, second = self.plan['items'][0]['id'], self.plan['items'][1]['id']
        arguments = (self.baseline['_technical_public_records'], self.baseline['_records']['technical'], {second: first})
        _, related, _ = project(*arguments, self.capability(), ['report'])
        self.assertEqual(related[first], related[second])
        changed = deepcopy(self.plan); changed['items'][1]['substrates'][0]['value'] = 'Concrete/masonry wall'
        with self.assertRaisesRegex(ValueError, 'different site applicability'):
            project(*arguments, self.capability(changed), ['report'])

    def test_sidecar_loader_rejects_duplicate_json_and_changed_read_stamp(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); path = folder / 'reviews' / PLAN_NAME; path.parent.mkdir()
            path.write_text('{"schema_version":1,"schema_version":1}')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                load_review(folder, self.data, self.plan['index_sha256'], plan_stamp(folder))
            path.write_text(json.dumps(self.plan))
            with self.assertRaisesRegex(ValueError, 'changed while reading'):
                load_review(folder, self.data, self.plan['index_sha256'], (0, 0, 0))
            with patch('estimator.firefly_technical_review.MAX_PLAN_BYTES', 1):
                with self.assertRaises(ValueError): plan_stamp(folder)

    def test_cached_library_refresh_and_overlay_preserve_manual_identities(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'library'; data, baseline, plan = fixture(directory)
            library = FirestoppingLibrary(directory, Store(Path(temporary) / 'private.sqlite3'))
            original = library._load(); raw = (directory / 'library.json').read_bytes()
            key = plan['items'][0]['id']
            self.assertNotIn('Plasterboard wall', original['_technical_discovery'][key]['substrate'])
            write_plan(directory, plan)
            current = library._load()
            self.assertIsNot(current, original)
            self.assertIn('Plasterboard wall', current['_technical_discovery'][key]['substrate'])
            self.assertEqual(current['_records']['technical'], baseline['_records']['technical'])
            self.assertEqual(current['_links']['technical'], original['_links']['technical'])
            public = library.detail('technical', key)
            target_title = library.detail('technical', 'fas190234-system-v1')['title']
            self.assertEqual(public['related_technical_records'], [{'kind': 'technical', 'id': 'fas190234-system-v1', 'title': target_title}])
            self.assertNotIn('related_technical_records', library.detail('technical', 'fas190234-system-v1'))
            public['related_technical_records'].clear()
            self.assertEqual(len(library.detail('technical', key)['related_technical_records']), 1)
            library.add_link('pkb-002', {'technical_id': key})
            self.assertTrue(any(link['id'] == key for link in library.detail('penetration', 'pkb-002')['links']))
            class FullValidation(FirestoppingLibrary):
                def _same_technical_source(self, data, source):
                    return False
            complete = FullValidation(directory, library.edits.store)._load()
            self.assertEqual(library._load(), complete, 'Overlay cache reuse must equal complete validation with the same private review')
            self.assertEqual((directory / 'library.json').read_bytes(), raw)
            with self.assertRaises(ValueError): library._validate({**data, REVIEW_KEY: {'payload': 'forged'}})

    def test_references_and_downloads_share_two_reports_but_exclude_private_navigation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'library'; _, _, plan = fixture(directory)
            write_plan(directory, plan)
            library = ReferenceLibrary(directory); data = library._load(); key = plan['items'][0]['id']
            index = ReferenceIndex(data, 'synthetic-revision')
            reports, _ = index._reports([key])
            self.assertEqual([report['label'] for report in reports], ['FAS190234', 'FAS190235'])
            self.assertTrue(all(report['url'] == FIREFLY_REPORTS_URL for report in reports))
            option = next(field for field in library.listing('technical')['filters'] if field['key'] == 'report')
            self.assertTrue(all(name in [row['value'] for row in option['options']] for name in ('FAS190234', 'FAS190235')))
            snapshot = prepare_technical_item({'id': key}, library=library)
            self.assertNotIn('related_technical_records', snapshot)
            pdf = PdfReader(BytesIO(render_technical_item_pdf(snapshot)))
            text = '\n'.join(page.extract_text() for page in pdf.pages) + str(pdf.metadata)
            payload = build_technical_item_xlsx(snapshot)
            with ZipFile(BytesIO(payload)) as archive:
                xml = '\n'.join(archive.read(name).decode('utf-8') for name in archive.namelist() if name.endswith(('.xml', '.rels')))
            for report in ('fas190234', 'fas190235'):
                self.assertIn(report.upper(), text)
                self.assertIn(report.upper(), xml)
            for value in ('PRIVATE-REVIEW-ONLY', 'Related Technical records', 'fas190234-system-v1', PLAN_NAME):
                self.assertNotIn(value, text + xml)
            workbook = load_workbook(BytesIO(payload))
            links = [(cell.value, cell.hyperlink.target) for sheet in workbook for row in sheet for cell in row if cell.hyperlink]
            self.assertEqual(links, [(name, FIREFLY_REPORTS_URL) for name in ('FAS190234', 'FAS190235')])

    def test_existing_plain_report_filter_includes_all_service_records_without_revision_options(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'library'; _, _, plan = fixture(directory, target_count=323, report_key='document')
            before = ReferenceLibrary(directory).listing('technical', document='FAS190234', limit='100')
            self.assertEqual(before['total'], 323)
            write_plan(directory, plan)
            library = ReferenceLibrary(directory)
            after = library.listing('technical', document='FAS190234', limit='100')
            self.assertEqual(after['total'], 644)
            options = next(field['options'] for field in after['filters'] if field['key'] == 'document')
            self.assertEqual([row['value'] for row in options], ['FAS190234', 'FAS190235', 'FAS190236'])
            report = next(field for field in library.detail('technical', plan['items'][0]['id'])['fields'] if field['label'] == 'Report Number')
            self.assertEqual(report['value'], 'FAS190234\nFAS190235')

    def test_factory_seed_copies_both_private_plans_and_original_index_exactly(self):
        from estimator.desktop_seed import initialize_data, verified_manifest
        from estimator.firefly_reference_review import PLAN_NAME as REFERENCE_PLAN_NAME
        from scripts.prepare_desktop_seed import prepare
        pdf = b'%PDF-1.4\nSynthetic Firefly factory content only.\n%%EOF'
        reports = {key: (revision, hashlib.sha256(pdf).hexdigest())
                   for key, (revision, _) in REPORTS.items()}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(REPORTS, reports):
            root = Path(temporary); directory = root / 'source-library'
            _, _, plan = fixture(directory)
            for report in REPORTS:
                (directory / 'documents' / (report + '.pdf')).write_bytes(pdf)
            review_path = write_plan(directory, plan)
            reference = {key: deepcopy(value) for key, value in plan.items()
                         if key in {'schema_version', 'review_id', 'index_sha256', 'reports'}}
            reference['items'] = []
            (directory / 'reviews' / REFERENCE_PLAN_NAME).write_text(json.dumps(reference), encoding='utf-8')
            original_index = (directory / 'library.json').read_bytes()
            original_plan = review_path.read_bytes()
            database = root / 'source.sqlite3'; store = Store(database)
            FirestoppingLibrary(directory, store)
            seed = root / 'seed'; prepare(seed, directory, database)
            expected = 'reference-library/reviews/' + PLAN_NAME
            self.assertIn(expected, [row['path'] for row in verified_manifest(seed)['files']])
            self.assertEqual((seed / 'reference-library' / 'library.json').read_bytes(), original_index)
            self.assertEqual((seed / expected).read_bytes(), original_plan)
            destination = root / 'installed'
            self.assertTrue(initialize_data(seed, destination)['initialized'])
            installed = destination / 'reference-library'
            self.assertEqual((installed / 'library.json').read_bytes(), original_index)
            self.assertEqual((installed / 'reviews' / PLAN_NAME).read_bytes(), original_plan)
            detail = ReferenceLibrary(installed).detail('technical', plan['items'][0]['id'])
            self.assertEqual(len(detail['related_technical_records']), 1)
            self.assertEqual((directory / 'library.json').read_bytes(), original_index)

    def test_imported_runtime_capability_and_stale_sidecar_reject_library_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'library'; data, _, plan = fixture(directory)
            index = directory / 'library.json'; original = index.read_bytes()
            write_plan(directory, plan)
            library = ReferenceLibrary(directory); library._load()
            changed = deepcopy(plan); changed['items'][0]['pages'] = [399]
            write_plan(directory, changed)
            with self.assertRaises(ValidationError): library._load()
            (directory / 'reviews' / PLAN_NAME).unlink()
            data[REVIEW_KEY] = {'payload': 'forged'}
            index.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValidationError): library._load()
            data.pop(REVIEW_KEY)
            data['libraries']['technical']['items'][0]['related_technical_records'] = [{'kind': 'technical', 'id': plan['items'][0]['id'], 'title': 'Forged'}]
            index.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValidationError): library._load()
            index.write_bytes(original)
            self.assertNotIn('Plasterboard wall', library._load()['_technical_discovery'][plan['items'][0]['id']]['substrate'])

    def test_shared_target_table_bounds_a_two_hundred_host_review_without_losing_edges(self):
        data, plan = deepcopy(self.data), deepcopy(self.plan)
        target = data['libraries']['technical']['items'][0]
        for number in range(2, 201):
            item = deepcopy(target); item['id'] = f'fas190234-system-v{number}'
            item['title'] = f'Synthetic supporting system V{number}'
            item['fields'][0]['value'] = f'V{number}'
            data['libraries']['technical']['items'].append(item)
            plan['targets'].append({'id': item['id'], 'item_sha256': fingerprint(item),
                                    'system_id': f'V{number}', 'pages': [5]})
        targets = [row['id'] for row in plan['targets']]
        for row in plan['items'][:321]: row['related_technical'] = list(targets)
        plan['index_sha256'] = hashlib.sha256(json.dumps(data).encode()).hexdigest()
        ReferenceLibrary(self.directory)._validate(data)
        started = time.perf_counter()
        capability = validate_plan(data, plan['index_sha256'], plan)
        _, related, _ = project(data['_technical_public_records'], data['_records']['technical'], {}, capability, ['report'])
        elapsed = time.perf_counter() - started
        self.assertEqual(sum(map(len, related.values())), 321 * 200)
        self.assertLess(len(capability.payload.encode()), 4 * 1024 * 1024)
        print(f'Firefly synthetic 200-host review: {len(capability.payload.encode())} bytes, {elapsed:.3f}s validation/projection')


if __name__ == '__main__':
    unittest.main()
