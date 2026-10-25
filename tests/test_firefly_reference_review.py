"""Synthetic reference reviews; no supplier diagrams or report tables in Git."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.firefly_reference_review import (PLAN_NAME, REPORTS, apply_review,
    diagram_identity, fingerprint)
from estimator.reference_library import ReferenceLibrary
from estimator.firestopping_library import FirestoppingLibrary
from estimator.storage import Store
from test_firestopping_library import editable_library


def fixture(root):
    data = editable_library(root)
    left = data['libraries']['penetration']['items'][0]
    left['filter_values']['manufacturer'] = ['FIREFLY']
    left['estimate']['draft']['rows'][0]['inputs'].update(
        X='Synthetic batt', T='D1 service through batt',
        U='Seal service through the batt aperture.')
    left['fields'].extend([
        {'label': 'Diagram captions (visually checked)', 'value': 'V11A-1'},
        {'label': 'References not established', 'value': 'Historical unmatched V11A-1'}])
    for report, (revision, sha) in REPORTS.items():
        data['documents'].append({'id': report, 'filename': revision + ' FIREFLY synthetic.pdf',
                                  'sha256': sha, 'pages': 20})
        system = 'V11A' if report == 'fas190235' else 'V1'
        data['libraries']['technical']['items'].append({
            'id': report + '-system-' + system.lower(), 'title': system + ' — synthetic system',
            'fields': [{'label': 'ID', 'value': system}, {'label': 'Service', 'value': 'Synthetic cables'}],
            'sources': [{'document_id': report, 'filename': revision + ' FIREFLY synthetic.pdf',
                         'sha256': sha, 'page': 12, 'label': revision + ', PDF page 12'}]})
    write_index(root, data)
    return data


def write_index(root, data):
    (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')


def plan_for(root, data, classification='batt-and-service', status='exact'):
    item = data['libraries']['penetration']['items'][0]
    reports = {'batt-only': ['fas190234'], 'batt-and-service': ['fas190234', 'fas190235'],
               'service-only': ['fas190236']}[classification]
    targets = []
    for report in reports:
        technical = next(i for i in data['libraries']['technical']['items']
                         if i['id'].startswith(report + '-system-'))
        targets.append({'id': technical['id'], 'item_sha256': fingerprint(technical),
                        'report_id': report, 'system_id': technical['fields'][0]['value'],
                        'page': 12, 'match': 'exact',
                        'reason': 'Synthetic footer and installation context agree.'})
    return {'schema_version': 1, 'review_id': 'synthetic-review-v1',
            'index_sha256': hashlib.sha256((root / 'library.json').read_bytes()).hexdigest(),
            'reports': [{'id': key, 'revision': revision, 'sha256': sha}
                        for key, (revision, sha) in sorted(REPORTS.items())],
            'items': [{'id': item['id'], 'item_sha256': fingerprint(item),
                       'diagrams': diagram_identity(item, {i['id']: i for i in data['images']}),
                       'classification': classification, 'status': status,
                       'basis': ['Physical batt usage and service context reviewed.'],
                       'targets': targets, 'unresolved': []}]}


def write_plan(root, plan):
    path = root / 'reviews' / PLAN_NAME
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(plan), encoding='utf-8')
    return path


class FireflyReferenceReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'library'
        self.data = fixture(self.root)

    def test_v11a_alias_is_review_bound_to_correct_report_and_page(self):
        original = deepcopy(self.data)
        plan = plan_for(self.root, self.data)
        write_plan(self.root, plan)
        item = ReferenceLibrary(self.root).detail('penetration', 'pkb-001')
        self.assertEqual([x['id'] for x in item['links']],
                         ['fas190234-system-v1', 'fas190235-system-v11a'])
        self.assertIn('PDF page 12', item['links'][1]['relationship'])
        self.assertIn('FAS190235 RIR1.29G', item['links'][1]['relationship'])
        self.assertNotIn('References not established', [f['label'] for f in item['fields']])
        self.assertEqual(json.loads((self.root / 'library.json').read_text()), original)
        self.assertEqual(item['images'], ReferenceLibrary(self.root).detail('penetration', 'pkb-001')['images'])

    def test_physical_batt_policy_and_conditional_gap_filler_are_explicit(self):
        for classification, reports in (
                ('batt-only', {'fas190234'}),
                ('batt-and-service', {'fas190234', 'fas190235'}),
                ('service-only', {'fas190236'})):
            with self.subTest(classification=classification):
                data = deepcopy(self.data)
                # A selected/default material or a conditional gap-filler phrase
                # cannot override the reviewed physical installation context.
                data['libraries']['penetration']['items'][0]['estimate']['draft']['rows'][0]['inputs']['U'] = (
                    'If the gap is larger, batt may be used as optional gap filler.')
                write_index(self.root, data)
                plan = plan_for(self.root, data, classification)
                apply_review(data, plan['index_sha256'], plan)
                self.assertEqual({l['technical_id'].split('-')[0] for l in data['links']
                                  if l['penetration_id'] == 'pkb-001'}, reports)

    def test_candidate_is_visibly_qualified_and_not_established(self):
        plan = plan_for(self.root, self.data, status='candidate')
        plan['items'][0]['targets'][1]['match'] = 'candidate'
        write_plan(self.root, plan)
        item = ReferenceLibrary(self.root).detail('penetration', 'pkb-001')
        self.assertIn('Candidate reference — review required', item['links'][1]['relationship'])
        self.assertNotIn('References not established', [f['label'] for f in item['fields']])
        qualification = next(f['value'] for f in item['fields'] if f['label'] == 'Reference qualification')
        self.assertIn('configuration equivalence is not established', qualification)
        self.assertIn(plan['items'][0]['targets'][1]['reason'], qualification)

    def test_incomplete_review_keeps_limitation_and_no_guessed_target(self):
        plan = plan_for(self.root, self.data, status='unresolved')
        plan['items'][0]['targets'].pop()
        plan['items'][0]['unresolved'] = ['No supported service target established.']
        write_plan(self.root, plan)
        item = ReferenceLibrary(self.root).detail('penetration', 'pkb-001')
        self.assertEqual([l['id'] for l in item['links']], ['fas190234-system-v1'])
        self.assertEqual(next(f['value'] for f in item['fields'] if f['label'] == 'References not established'),
                         'No supported service target established.')

    def test_other_manufacturer_original_draft_prices_and_assets_are_unchanged(self):
        original = deepcopy(self.data)
        plan = plan_for(self.root, self.data)
        apply_review(self.data, plan['index_sha256'], plan)
        self.assertEqual(self.data['libraries']['penetration']['items'][1],
                         original['libraries']['penetration']['items'][1])
        for key in ('estimate', 'price', 'images', 'sources', 'filter_values', 'title'):
            self.assertEqual(self.data['libraries']['penetration']['items'][0][key],
                             original['libraries']['penetration']['items'][0][key])
        for key in ('documents', 'images', 'firestopping'):
            self.assertEqual(self.data[key], original[key])
        self.assertEqual(self.data['libraries']['technical'], original['libraries']['technical'])

    def test_mismatched_evidence_rejects_entire_review_before_mutation(self):
        base_plan = plan_for(self.root, self.data)
        for name in ('index', 'item', 'diagram', 'target', 'report', 'page', 'coverage', 'policy', 'duplicate-report'):
            with self.subTest(name=name):
                plan, data = deepcopy(base_plan), deepcopy(self.data)
                entry = plan['items'][0]
                if name == 'index': plan['index_sha256'] = 'f' * 64
                if name == 'item': entry['item_sha256'] = 'f' * 64
                if name == 'diagram': entry['diagrams'][0]['sha256'] = 'f' * 64
                if name == 'target': entry['targets'][0]['item_sha256'] = 'f' * 64
                if name == 'report': plan['reports'][0]['revision'] = 'Different revision'
                if name == 'page': entry['targets'][1]['page'] = 13
                if name == 'coverage': plan['items'] = []
                if name == 'policy': entry['classification'] = 'service-only'
                if name == 'duplicate-report': entry['targets'].append(deepcopy(entry['targets'][0]))
                with self.assertRaises(ValueError):
                    apply_review(data, base_plan['index_sha256'], plan)
                self.assertEqual(data, self.data)

    def test_plan_cache_refresh_and_removal_restore_raw_supplier_links(self):
        library = ReferenceLibrary(self.root)
        self.assertEqual(library.detail('penetration', 'pkb-001')['links'][0]['id'], 'report-a-v1')
        path = write_plan(self.root, plan_for(self.root, self.data))
        self.assertEqual(len(library.detail('penetration', 'pkb-001')['links']), 2)
        path.unlink()
        self.assertEqual(library.detail('penetration', 'pkb-001')['links'][0]['id'], 'report-a-v1')

    def test_present_but_invalid_or_duplicate_key_plan_fails_closed(self):
        plan = plan_for(self.root, self.data)
        path = write_plan(self.root, plan)
        library = ReferenceLibrary(self.root)
        library.detail('penetration', 'pkb-001')
        path.write_text('{"schema_version":1,"schema_version":1}', encoding='utf-8')
        with self.assertRaises(ValidationError):
            library.detail('penetration', 'pkb-001')

    def test_manual_links_unlinks_and_saved_edit_are_applied_after_supplier_review(self):
        write_plan(self.root, plan_for(self.root, self.data))
        store = Store(Path(self.temp.name) / 'synthetic.sqlite3')
        library = FirestoppingLibrary(self.root, store)
        library.add_link('pkb-001', {'technical_id': 'report-a-v1'})
        library.remove_link('pkb-001', {'technical_id': 'fas190235-system-v11a'})
        opened = library.edit('pkb-001')
        draft = deepcopy(opened['draft'])
        draft['rows'][0]['inputs']['U'] = 'Saved user installation remains authoritative for the edit.'
        snapshot = library._context('pkb-001')[3]
        library.edits.save('pkb-001', 0, self.data['firestopping']['source_sha256'], {
            'draft': draft, 'pricing_token': opened['pricing_token'], 'amount': 150}, snapshot)
        item = library.detail('penetration', 'pkb-001')
        self.assertEqual({l['id'] for l in item['links']}, {'report-a-v1', 'fas190234-system-v1'})
        self.assertEqual(next(l for l in item['links'] if l['id'] == 'report-a-v1')['origin'], 'user')
        self.assertIn('saved edits', item['notice'])
        self.assertEqual(library.edit('pkb-001')['draft']['rows'][0]['inputs']['U'],
                         draft['rows'][0]['inputs']['U'])
        self.assertEqual(len(library.edits.links()), 1)
        self.assertEqual(len(library.edits.unlinks()), 1)

    def test_preexisting_manual_edge_saved_edit_and_pricing_identity_survive_plan_refresh(self):
        store = Store(Path(self.temp.name) / 'preexisting.sqlite3')
        library = FirestoppingLibrary(self.root, store)
        library.add_link('pkb-001', {'technical_id': 'fas190236-system-v1'})
        library.add_link('pkb-001', {'technical_id': 'fas190235-system-v11a'})
        opened = library.edit('pkb-001')
        draft = deepcopy(opened['draft'])
        draft['rows'][0]['inputs']['U'] = 'User-edited installation predating supplier review.'
        snapshot = library._context('pkb-001')[3]
        library.edits.save('pkb-001', 0, self.data['firestopping']['source_sha256'], {
            'draft': draft, 'pricing_token': opened['pricing_token'], 'amount': 151}, snapshot)
        before = library.edit('pkb-001')
        db_before = (deepcopy(library.edits.all()), list(library.edits.links()), list(library.edits.unlinks()))
        write_plan(self.root, plan_for(self.root, self.data))
        after = library.edit('pkb-001')
        for name in ('draft', 'pricing_token', 'revision', 'price', 'source_price', 'pricing_basis'):
            self.assertEqual(after[name], before[name], name)
        self.assertEqual((library.edits.all(), library.edits.links(), library.edits.unlinks()), db_before)
        item = library.detail('penetration', 'pkb-001')
        manual = next(link for link in item['links'] if link['id'] == 'fas190236-system-v1')
        self.assertEqual(manual['origin'], 'user')
        collision = next(link for link in item['links'] if link['id'] == 'fas190235-system-v11a')
        self.assertEqual(collision['origin'], 'user')
        self.assertEqual(collision['relationship'], 'Manually linked.')
        self.assertEqual(sum(link['id'] == 'fas190235-system-v11a' for link in item['links']), 1)
        self.assertIn('saved edits', item['notice'])
        self.assertEqual({link['id'] for link in item['links']},
                         {'fas190236-system-v1', 'fas190234-system-v1', 'fas190235-system-v11a'})


if __name__ == '__main__':
    unittest.main()
