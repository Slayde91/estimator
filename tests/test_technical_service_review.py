"""Synthetic source-bound Services review receipts; no supplier text in Git."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from estimator.firefly_reference_review import fingerprint
from estimator.library_facets import MOVED_SERVICE_CATEGORIES
from estimator.technical_service_review import (PLAN_NAME, ValidatedReview,
    load_review, plan_stamp, project, projection_fingerprint, validate_plan)


def fixture():
    original = {'id': 'synthetic-service-1', 'title': 'Synthetic system',
                'fields': [{'label': 'Service', 'value': 'Synthetic copper pipe'},
                           {'label': 'Report Number', 'value': 'SYN-01'}],
                'sources': [{'document_id': 'synthetic-report', 'page': 3, 'sha256': 'c' * 64}],
                'filter_values': {'report': ['SYN-01']}}
    public = deepcopy(original)
    public['filter_values']['services'] = ['Unlagged Pipes']
    public['technical_basis'] = {'source_fields': deepcopy(original['fields'])}
    data = {'libraries': {'technical': {'items': [original]}},
            'documents': [{'id': 'synthetic-report', 'sha256': 'c' * 64, 'pages': 4}]}
    discovery = {original['id']: {'services': ['Unlagged Pipes'], 'category': ['Plumbing & Hydraulic'],
                                 'type': ['Core hole'], 'frl': ['-/120/120']}}
    row = {'id': original['id'], 'item_sha256': fingerprint(original),
           'projection_sha256': projection_fingerprint(public), 'services': ['Copper Pipes'],
           'evidence': [{'field': 'Service', 'quote': 'copper pipe', 'source_reference': 'SYN-01 p.3'}]}
    plan = {'schema_version': 1, 'review_id': 'synthetic-services-review',
            'reviewed_index_sha256': 'a' * 64, 'items': [row]}
    return data, {original['id']: public}, discovery, plan


class TechnicalServiceReviewTests(unittest.TestCase):
    def setUp(self):
        self.data, self.public, self.discovery, self.plan = fixture()

    def validated(self, plan=None, data=None):
        return validate_plan(self.data if data is None else data, 'b' * 64,
                             self.plan if plan is None else plan)

    def test_existing_option_changes_only_copied_services_and_preserves_sources(self):
        before = deepcopy((self.data, self.public, self.discovery, self.plan))
        result = project(self.public, self.discovery, self.validated())
        self.assertEqual(result['synthetic-service-1']['services'], ['Copper Pipes'])
        for key in ('category', 'type', 'frl'):
            self.assertEqual(result['synthetic-service-1'][key], self.discovery['synthetic-service-1'][key])
        self.assertEqual((self.data, self.public, self.discovery, self.plan), before)
        result['synthetic-service-1']['category'].append('Synthetic change')
        self.assertEqual(self.discovery, before[2])

    def test_new_index_serialization_and_unrelated_item_preserve_exact_reviews(self):
        data = deepcopy(self.data)
        data['libraries']['technical']['items'].append({'id': 'unrelated-new-item', 'fields': []})
        review = validate_plan(data, 'd' * 64, self.plan)
        self.assertEqual(project(self.public, self.discovery, review)['synthetic-service-1']['services'], ['Copper Pipes'])
        self.assertEqual(json.loads(review.payload)['reviewed_index_sha256'], 'a' * 64)

    def test_changed_raw_item_or_missing_item_fails_closed(self):
        for change in ('text', 'source', 'missing'):
            data = deepcopy(self.data)
            item = data['libraries']['technical']['items'][0]
            if change == 'text':
                item['fields'][0]['value'] = 'Synthetic steel pipe'
            elif change == 'source':
                item['sources'][0]['sha256'] = 'd' * 64
            else:
                data['libraries']['technical']['items'] = []
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.validated(data=data)

    def test_public_fields_sources_reports_and_service_basis_are_fingerprinted(self):
        review = self.validated()
        for change in ('field', 'source', 'report', 'service', 'basis', 'title'):
            public = deepcopy(self.public)
            item = public['synthetic-service-1']
            if change == 'field': item['fields'][0]['value'] += ' changed'
            elif change == 'source': item['sources'][0]['page'] = 4
            elif change == 'report': item['filter_values']['report'] = ['SYN-02']
            elif change == 'service': item['filter_values']['services'] = ['Lagged Pipes']
            elif change == 'basis': item['technical_basis']['source_fields'][0]['value'] += ' changed'
            else: item['title'] += ' changed'
            with self.subTest(change=change), self.assertRaises(ValueError):
                project(public, self.discovery, review)

    def test_new_option_na_empty_or_duplicate_services_are_rejected(self):
        for services in (['Unlagged Pipes'], ['Unapproved specialist99'], ['N/A'], [],
                         ['Copper Pipes', 'Copper Pipes'], [' Copper Pipes'], [None]):
            plan = deepcopy(self.plan); plan['items'][0]['services'] = services
            with self.subTest(services=services), self.assertRaises(ValueError):
                self.validated(plan)

    def test_six_category_na_policy_takes_priority_over_reviewed_service(self):
        for category in MOVED_SERVICE_CATEGORIES:
            discovery = deepcopy(self.discovery)
            discovery['synthetic-service-1']['category'].append(category)
            result = project(self.public, discovery, self.validated())
            with self.subTest(category=category):
                self.assertEqual(result['synthetic-service-1']['services'], ['N/A'])
                self.assertEqual(result['synthetic-service-1']['category'], discovery['synthetic-service-1']['category'])

    def test_duplicate_items_or_unknown_plan_keys_are_rejected(self):
        for change in ('duplicate', 'extra-plan', 'extra-item', 'bool-version'):
            plan = deepcopy(self.plan)
            if change == 'duplicate': plan['items'].append(deepcopy(plan['items'][0]))
            elif change == 'extra-plan': plan['unapproved'] = True
            elif change == 'extra-item': plan['items'][0]['unapproved'] = True
            else: plan['schema_version'] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.validated(plan)

    def test_duplicate_raw_ids_do_not_silently_select_a_source(self):
        data = deepcopy(self.data)
        data['libraries']['technical']['items'] *= 2
        with self.assertRaises(ValueError): self.validated(data=data)

    def test_quote_must_occur_in_exact_named_public_field(self):
        for field, quote in (('Report Number', 'copper pipe'), ('Service', 'absent steel'),
                             ('Installation Details', 'copper pipe')):
            plan = deepcopy(self.plan)
            plan['items'][0]['evidence'][0].update(field=field, quote=quote)
            with self.subTest(field=field, quote=quote), self.assertRaises(ValueError):
                project(self.public, self.discovery, self.validated(plan))

    def test_quote_can_match_table_data_of_named_field(self):
        public = deepcopy(self.public)
        public['synthetic-service-1']['fields'][0]['table'] = {'columns': ['Material'], 'rows': [['Synthetic copper']]}
        plan = deepcopy(self.plan)
        plan['items'][0]['projection_sha256'] = projection_fingerprint(public['synthetic-service-1'])
        plan['items'][0]['evidence'][0]['quote'] = 'Synthetic copper'
        result = project(public, self.discovery, self.validated(plan))
        self.assertEqual(result['synthetic-service-1']['services'], ['Copper Pipes'])

    def test_empty_or_duplicate_evidence_is_rejected(self):
        for evidence in ([], [dict(self.plan['items'][0]['evidence'][0])] * 2,
                         [{'field': 'Service', 'quote': 'copper pipe', 'source_reference': ''}],
                         [{'field': 'Service', 'quote': 'copper pipe', 'source_reference': 'SYN-01', 'other': True}]):
            plan = deepcopy(self.plan); plan['items'][0]['evidence'] = evidence
            with self.subTest(evidence=evidence), self.assertRaises(ValueError): self.validated(plan)

    def document_plan(self, page=2):
        plan = deepcopy(self.plan)
        plan['items'][0]['evidence'] = [{'document_id': 'synthetic-report', 'document_sha256': 'c' * 64,
                                      'page': page, 'quote': 'Synthetic merged copper service cell',
                                      'source_reference': 'SYN-01 preceding continuation page'}]
        return plan

    def test_registered_pdf_own_or_preceding_continuation_page_is_accepted(self):
        for page in (2, 3):
            with self.subTest(page=page):
                result = project(self.public, self.discovery, self.validated(self.document_plan(page)))
                self.assertEqual(result['synthetic-service-1']['services'], ['Copper Pipes'])

    def test_pdf_evidence_rejects_changed_hash_unlinked_and_unrelated_pages(self):
        for change in ('hash', 'missing-document', 'unlinked-document', 'out-of-range', 'unrelated-page', 'bool-page'):
            data, plan = deepcopy(self.data), self.document_plan()
            evidence = plan['items'][0]['evidence'][0]
            if change == 'hash': evidence['document_sha256'] = 'd' * 64
            elif change == 'missing-document': data['documents'] = []
            elif change == 'unlinked-document':
                data['documents'].append({'id': 'other-report', 'sha256': 'c' * 64, 'pages': 4})
                evidence['document_id'] = 'other-report'
            elif change == 'out-of-range': evidence['page'] = 5
            elif change == 'unrelated-page': evidence['page'] = 1
            else: evidence['page'] = True
            with self.subTest(change=change), self.assertRaises(ValueError): self.validated(plan, data)

    def test_imported_or_tampered_capability_is_rejected(self):
        review = self.validated()
        for invalid in (json.loads(review.payload), {'payload': review.payload, 'sha256': review.sha256},
                        ValidatedReview(review.payload, 'f' * 64)):
            with self.subTest(invalid=type(invalid)), self.assertRaises(ValueError):
                project(self.public, self.discovery, invalid)
        with self.assertRaises(FrozenInstanceError): review.payload = '{}'

    def test_all_targets_are_preflighted_before_copying_or_applying(self):
        plan = deepcopy(self.plan)
        second = deepcopy(self.data['libraries']['technical']['items'][0]); second['id'] = 'synthetic-service-2'
        data = deepcopy(self.data); data['libraries']['technical']['items'].append(second)
        row = deepcopy(plan['items'][0]); row.update(id=second['id'], item_sha256=fingerprint(second))
        plan['items'].append(row)
        public = deepcopy(self.public); public[second['id']] = deepcopy(public['synthetic-service-1'])
        public[second['id']]['id'] = second['id']
        row['projection_sha256'] = projection_fingerprint(public[second['id']])
        discovery = deepcopy(self.discovery); discovery[second['id']] = deepcopy(discovery['synthetic-service-1'])
        before = deepcopy(discovery)
        public[second['id']]['fields'][0]['value'] += ' changed after review'
        with self.assertRaises(ValueError): project(public, discovery, self.validated(plan, data))
        self.assertEqual(discovery, before)

    def test_absent_or_empty_plan_is_no_op(self):
        self.assertIsNone(load_review('unused-directory', self.data, 'b' * 64, None))
        self.assertIs(project(self.public, self.discovery, None), self.discovery)
        plan = deepcopy(self.plan); plan['items'] = []
        self.assertIs(project(self.public, self.discovery, self.validated(plan)), self.discovery)

    def test_both_historical_and_current_index_fingerprints_are_validated(self):
        plan = deepcopy(self.plan); plan['reviewed_index_sha256'] = 'bad'
        with self.assertRaises(ValueError): self.validated(plan)
        with self.assertRaises(ValueError): validate_plan(self.data, 'bad', self.plan)

    def write_plan(self, directory, text=None):
        path = Path(directory) / 'reviews' / PLAN_NAME
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(self.plan) if text is None else text, encoding='utf-8')
        return path

    def test_saved_plan_load_and_cache_stamp_detect_change(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(plan_stamp(directory))
            path = self.write_plan(directory)
            stamp = plan_stamp(directory)
            self.assertIsInstance(load_review(directory, self.data, 'b' * 64, stamp), ValidatedReview)
            path.write_text(path.read_text(encoding='utf-8') + ' ', encoding='utf-8')
            self.assertNotEqual(plan_stamp(directory), stamp)
            with self.assertRaises(ValueError): load_review(directory, self.data, 'b' * 64, stamp)

    def test_duplicate_json_keys_and_nonfinite_numbers_are_rejected_on_load(self):
        for text in ('{"schema_version":1,"schema_version":1}',
                     json.dumps(self.plan).replace('"schema_version": 1', '"schema_version": NaN'),
                     json.dumps(self.plan).replace('"quote": "copper pipe"', '"quote": Infinity')):
            with self.subTest(text=text[:40]), tempfile.TemporaryDirectory() as directory:
                self.write_plan(directory, text)
                with self.assertRaises(ValueError): load_review(directory, self.data, 'b' * 64, plan_stamp(directory))

    def test_changed_during_read_and_oversized_read_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_plan(directory)
            stamp = plan_stamp(directory)
            with patch('estimator.technical_service_review.plan_stamp', side_effect=[stamp, ('changed',)]):
                with self.assertRaises(ValueError): load_review(directory, self.data, 'b' * 64, stamp)
            with patch('estimator.technical_service_review.plan_stamp', return_value=stamp), \
                    patch('estimator.technical_service_review.MAX_PLAN_BYTES', 10):
                with self.assertRaises(ValueError): load_review(directory, self.data, 'b' * 64, stamp)

    def test_plan_size_nonfile_and_path_escape_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_plan(directory)
            with patch('estimator.technical_service_review.MAX_PLAN_BYTES', 10):
                with self.assertRaises(ValueError): plan_stamp(directory)
                with self.assertRaises(ValueError): self.validated()
            path.unlink(); path.mkdir()
            with self.assertRaises(ValueError): plan_stamp(directory)
            with patch('estimator.technical_service_review.PLAN_NAME', '../../outside.json'):
                with self.assertRaises(ValueError): plan_stamp(directory)


if __name__ == '__main__':
    unittest.main()
