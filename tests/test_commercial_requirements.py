"""Explicit commercial stages enforce readiness without rewriting old drafts/history."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, CommercialDocuments, STATUSES, default_fields, validate_rate_schedule
from estimator.commercial_requirements import entries, missing, require_ready, requirements
from tests.test_commercial_documents import Projects

INK = {'version': 1, 'ratio': 3, 'strokes': [[[.1, .2], [.7, .8]]]}
DETAILS = {'date': '2026-11-09', 'project_no': 'PN-01', 'client': 'Example Client',
           'contact': 'Example Contact', 'site_address': '10 Example Road',
           'phone': '0400 000 000', 'email': 'contact@example.test'}


class CommercialReadinessTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.projects = Projects(Path(folder.name))
        self.workspace = self.projects.add()
        self.renderer = Mock(return_value=b'%PDF-1.4\nFROZEN TEST RECEIPT\n%%EOF')
        self.store = CommercialDocuments(self.projects, renderer=self.renderer)

    def save(self, kind, fields, prior=None, status='Draft'):
        return self.store.save(self.workspace, {'id': prior['id'] if prior else str(uuid4()),
            'version': prior['version'] if prior else 0, 'kind': kind, 'status': status, 'fields': fields})

    def quote_fields(self):
        fields = default_fields('quote', DETAILS)
        fields.update(allowances='<p>N / A</p>', terms='<p>Entered terms.</p>')
        fields['lines'] = [{'estimate_id': '', 'description': 'An included item', 'quantity': '1',
                            'unit_price': '25', 'size': '', 'comments': ''},
                           {'estimate_id': '', 'description': 'A free item', 'quantity': '1',
                            'unit_price': '0', 'size': '', 'comments': ''}]
        return fields

    def work_fields(self):
        quote = self.save('quote', self.quote_fields())
        issued = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))
        quote = issued['document']
        fields = default_fields('work_order', DETAILS)
        fields['order'].update(quote_id=quote['id'], quote_reference=quote['last_number'], start_date='2026-11-10', urgency='High Priority',
                               description='Supply and install the quoted works.', estimated_cost='0')
        return fields, quote

    @staticmethod
    def sign(fields, key, date_key):
        fields.setdefault('signatures', {})[key] = deepcopy(INK)
        fields['order'].update({key: key + ' Person', date_key: '2026-11-09'})

    def test_incomplete_quote_draft_saves_but_failed_status_and_pdf_do_not_mutate_or_render(self):
        saved = self.save('quote', default_fields('quote'))
        before = self.store.capture(self.workspace)
        for action in (lambda: self.store.status(self.workspace, saved['id'], saved['version'], 'Review'),
                       lambda: self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))):
            with self.assertRaisesRegex(ValidationError, 'Complete required Quote fields:'):
                action()
            self.assertEqual(self.store.capture(self.workspace), before)
            self.renderer.assert_not_called()
        with self.assertRaises(ValidationError):
            self.save('quote', default_fields('quote'), status='Accepted')
        self.assertEqual(self.store.capture(self.workspace), before)

    def test_quote_required_values_reject_whitespace_markup_and_missing_rates_but_accept_zero(self):
        fields = self.quote_fields()
        fields['rate_schedule']['rates'] = dict.fromkeys(fields['rate_schedule']['rates'], '0')
        require_ready('quote', 'Draft', fields, 'issue')
        for entry in entries('quote', 'Accepted'):
            changed = deepcopy(fields)
            target = changed
            parts = entry['path'].split('.')
            for part in parts[:-1]:
                target = target[part]
            target[parts[-1]] = '<p>&nbsp;<br>\u200b</p>' if entry['type'] == 'rich' else ' \t\u200b\n'
            with self.subTest(path=entry['path']), self.assertRaisesRegex(ValidationError, entry['label'].replace('&', r'\&')):
                require_ready('quote', 'Accepted', changed)
        self.assertNotIn('rate_schedule.rates.access_equipment_transport', [item['path'] for item in entries('quote', 'Review')])

    def test_blank_document_rate_can_be_saved_in_draft_but_global_defaults_and_issue_reject_it(self):
        fields = self.quote_fields()
        fields['rate_schedule']['rates']['ordinary_time'] = ''
        saved = self.save('quote', fields)
        self.assertEqual(saved['fields']['rate_schedule']['rates']['ordinary_time'], '')
        target = self.projects.add(self.projects.project_id(self.workspace))
        self.store.restore(target, self.store.capture(self.workspace))
        self.assertEqual(self.store.view(target)['documents'][0]['fields']['rate_schedule']['rates']['ordinary_time'], '')
        with self.assertRaisesRegex(ValidationError, 'Ordinary time'):
            self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))
        with self.assertRaises(ValidationError):
            validate_rate_schedule(fields['rate_schedule'])

    def test_work_order_stage_requirements_are_cumulative_and_board_cannot_bypass_them(self):
        fields, _ = self.work_fields()
        saved = self.save('work_order', fields)
        before = self.store.capture(self.workspace)
        with self.assertRaisesRegex(ValidationError, 'Work order details reviewed by'):
            self.store.status(self.workspace, saved['id'], saved['version'], 'Review')
        self.assertEqual(self.store.capture(self.workspace), before)
        fields = deepcopy(saved['fields'])
        self.sign(fields, 'details_by', 'details_date')
        saved = self.save('work_order', fields, saved)
        saved = self.store.status(self.workspace, saved['id'], saved['version'], 'Review')
        self.assertEqual(saved['status'], 'Review')
        for status, key, date in (('OHS Docs', 'reviewed_by', 'review_date'),
                                  ('Client Approval', 'prepared_by', 'prepared_date'),
                                  ('In progress', 'client_approved_by', 'client_approval_date')):
            before = self.store.capture(self.workspace)
            with self.subTest(status=status), self.assertRaises(ValidationError):
                self.store.status(self.workspace, saved['id'], saved['version'], status)
            self.assertEqual(self.store.capture(self.workspace), before)
            fields = deepcopy(saved['fields'])
            fields['order']['approval'] = 'Approved'
            self.sign(fields, key, date)
            saved = self.save('work_order', fields, saved, saved['status'])
            saved = self.store.status(self.workspace, saved['id'], saved['version'], status)
        # Existing stage evidence is still required when jumping ahead.
        fields = deepcopy(saved['fields'])
        fields['order']['reviewed_by'] = ''
        with self.assertRaisesRegex(ValidationError, 'signing details'):
            self.save('work_order', fields, saved, 'Client Approval')

    def test_progress_claim_and_completion_need_their_rows_and_signers(self):
        fields, quote = self.work_fields()
        fields['order']['approval'] = 'Approved'
        for key, date in (('details_by','details_date'), ('reviewed_by', 'review_date'), ('prepared_by', 'prepared_date'),
                          ('client_approved_by', 'client_approval_date')):
            self.sign(fields, key, date)
        fields['work_tracking'] = self.store.view(self.workspace, include_quote_totals=True)['quote_rows'][quote['id']][quote['last_number']]
        # A free Quote row remains eligible for progress and claims.
        fields['work_tracking']['rows'][1]['completed_percent'] = '1'
        self.sign(fields, 'progress_by', 'progress_date')
        saved = self.save('work_order', fields, status='Claim')
        with self.assertRaisesRegex(ValidationError, '% claimed'):
            self.store.status(self.workspace, saved['id'], saved['version'], 'Certify')
        fields = deepcopy(saved['fields'])
        fields['work_tracking']['rows'][1]['claimed_percent'] = '1'
        self.sign(fields, 'claimed_by', 'claim_date')
        saved = self.save('work_order', fields, saved, 'Certify')
        with self.assertRaisesRegex(ValidationError, 'Certification details'):
            self.store.status(self.workspace, saved['id'], saved['version'], 'Completed')
        fields = deepcopy(saved['fields'])
        fields['order'].update(certification='Certification issued', completion='Completed')
        self.sign(fields, 'closed_by', 'closed_date')
        saved = self.save('work_order', fields, saved, 'Completed')
        self.assertEqual(saved['status'], 'Completed')
        issued = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))
        self.assertEqual(issued['pdf'], self.renderer.return_value)

    def test_draft_work_order_pdf_and_pause_cancel_require_base_only(self):
        fields, _ = self.work_fields()
        saved = self.save('work_order', fields)
        issued = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))
        self.assertEqual(issued['document']['status'], 'Draft')
        for status in ('On Hold', 'Canceled'):
            saved = self.store.status(self.workspace, issued['document']['id'], issued['document']['version'], status)
            issued = self.store.issue(self.workspace, saved['id'], saved['version'], str(uuid4()))
        self.assertNotIn('signatures', issued['document']['fields'])

    def test_blank_or_identical_signature_points_and_empty_tracking_do_not_meet_stage_readiness(self):
        fields, _ = self.work_fields()
        self.sign(fields, 'details_by','details_date')
        fields['order']['approval'] = 'Approved'
        self.sign(fields, 'reviewed_by', 'review_date')
        for ink in (None, {}, {'version': 1, 'ratio': 3, 'strokes': []},
                    {'version': 1, 'ratio': 3, 'strokes': [[[.5, .5], [.5, .5]]]},
                    {'version': 1, 'ratio': 3, 'strokes': [[[.1, .2]], [[.7, .8]]]}):
            fields['signatures']['reviewed_by'] = ink
            with self.subTest(ink=ink), self.assertRaisesRegex(ValidationError, 'Reviewed by'):
                require_ready('work_order', 'OHS Docs', fields)
        fields['signatures']['reviewed_by'] = deepcopy(INK)
        require_ready('work_order', 'OHS Docs', fields)
        self.assertIn('work_tracking.completed_percent', [entry['path'] for entry in missing('work_order', 'Claim', fields)])

    def test_legacy_snapshot_load_and_exact_issued_receipt_replay_skip_new_readiness(self):
        saved = self.save('quote', default_fields('quote'))
        request = str(uuid4())
        with patch('estimator.commercial_documents.require_ready'):
            issued = self.store.issue(self.workspace, saved['id'], saved['version'], request)
        snapshot = self.store.capture(self.workspace)
        snapshot['documents'][0]['status'] = 'Accepted'
        target = self.projects.add(snapshot['project_id'])
        self.store.restore(target, snapshot)
        self.assertEqual(self.store.capture(target)['documents'][0]['status'], 'Accepted')
        self.assertEqual(self.store.read_pdf(target, issued['id'])[1], issued['pdf'])
        count = self.renderer.call_count
        replay = self.store.issue(self.workspace, saved['id'], saved['version'], request)
        self.assertEqual(replay['pdf'], issued['pdf'])
        self.assertEqual(self.store.replay(self.workspace, request, saved['id'], saved['version'])['pdf'], issued['pdf'])
        self.assertEqual(self.renderer.call_count, count)
        with self.assertRaises(CommercialConflict):
            self.store.issue(self.workspace, saved['id'], saved['version'] + 1, request)

    def test_requirements_metadata_matches_enforcement_and_purchase_order_is_unchanged(self):
        metadata = self.store.view(self.workspace)['requirements']
        self.assertEqual(metadata, requirements(STATUSES))
        for action in ('save', 'issue'):
            for kind, statuses in STATUSES.items():
                for status in statuses:
                    self.assertEqual(metadata[action][kind][status], entries(kind, status, action))
        for status in STATUSES['purchase_order']:
            require_ready('purchase_order', status, default_fields('purchase_order'), 'issue')
            self.assertEqual(metadata['save']['purchase_order'][status], [])
        metadata['save']['quote']['Review'].clear()
        self.assertTrue(self.store.view(self.workspace)['requirements']['save']['quote']['Review'])


if __name__ == '__main__':
    unittest.main()
