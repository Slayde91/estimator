"""Required SWMS exports and transactional, portable review initials."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.certification import CertificationService, SIGNER_FIELDS
from estimator.storage import Store
from estimator.swms_http import SwmsHTTP
from estimator.swms import (SwmsDocuments, SwmsConflict, default_fields, issue_requirements,
                            missing_issue_fields, review_initials, validate_swms_snapshot)
from test_swms import Handler, Projects
from swms_ready_fixtures import complete_swms


def uid():
    return str(uuid.uuid4())


class SwmsReadinessTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.projects = Projects(Path(temp.name))
        self.workspace = self.projects.add()
        self.profile = {'name': 'Slayde Tana'}
        self.projects.legacy = SimpleNamespace(get_defaults=lambda: {'fields': deepcopy(self.profile)})
        self.service = SwmsDocuments(self.projects)

    def save(self, fields=None):
        return self.service.save(self.workspace, {'id': uid(), 'version': 0,
                                                'fields': fields if fields is not None else complete_swms(default_fields())})

    def document(self, identity):
        return next(row for row in self.service.view(self.workspace)['documents'] if row['id'] == identity)

    def issue(self, document, request=None):
        return self.service.issue(self.workspace, document['id'], document['version'], request or uid())

    def test_each_required_text_blocks_issue_but_draft_is_preserved_without_side_effects(self):
        for spec in issue_requirements():
            if spec['type'] != 'text':
                continue
            for blank in ('', ' \n\t', '\u200b\u2060'):
                fields = complete_swms(default_fields())
                parts = spec['path'].split('.')
                target = fields['details'] if parts[0] == 'details' else fields
                target[parts[-1]] = blank if parts[-1] != 'date' else ''
                saved = self.save(fields)
                before = self.service.capture(self.workspace)
                with self.subTest(path=spec['path'], blank=repr(blank)), self.assertRaisesRegex(ValidationError, spec['label'].replace('(', '\\(').replace(')', '\\)')):
                    self.issue(saved)
                self.assertEqual(self.service.capture(self.workspace), before)
                self.service.delete(self.workspace, saved['id'], saved['version'])
        with self.service._connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM swms_issued').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM swms_audit WHERE action='issue'").fetchone()[0], 0)

    def test_people_work_choices_and_acknowledgement_are_required_without_extra_manager_fields(self):
        base = complete_swms(default_fields())
        self.assertFalse(missing_issue_fields(base))
        for key in ('reviewers', 'consultation'):
            for value in ([], [{'name': '', 'position': 'Supervisor', 'signature': base[key][0]['signature']}],
                          [{'name': 'Reviewer', 'position': '', 'signature': base[key][0]['signature']}],
                          [{'name': 'Reviewer', 'position': 'Supervisor', 'signature': None}],
                          [{'name': 'Reviewer', 'position': 'Supervisor', 'signature': {'version': 1, 'ratio': 1, 'strokes': [[[.5, .5]]]}}]):
                with self.subTest(key=key, value=value):
                    self.assertIn(key, [item['path'] for item in missing_issue_fields({**base, key: value})])
        for risk in ('', 'Unrecognised risk', 'NA\nRisk of falls from greater than 2 metres'):
            self.assertIn('high_risk_work', [item['path'] for item in missing_issue_fields({**base, 'high_risk_work': risk})])
        empty = {**base, 'work_types': [], 'additional_steps': True, 'additional_rows': []}
        self.assertIn('work_types', [item['path'] for item in missing_issue_fields(empty)])
        extra = deepcopy(base['steps']['Passive Firestopping'][0])
        self.assertFalse(missing_issue_fields({**empty, 'additional_rows': [extra]}))
        self.assertEqual(base['details']['project_manager'], '')
        self.assertIsNone(base['manager_signature'])
        self.assertFalse(missing_issue_fields({**base, 'contact_signature': None}))

    def test_new_notify_default_is_exact_without_rewriting_legacy_content(self):
        expected = 'Person discovering an incident to immediately alert the appropriate Field Supervisor'
        self.assertEqual(default_fields()['emergency_notify'], expected)
        fields = default_fields()
        fields['emergency_notify'] = 'Existing site emergency instruction and/or:'
        saved = self.save(fields)
        snapshot = self.service.capture(self.workspace)
        self.assertEqual(validate_swms_snapshot(snapshot), snapshot)
        self.assertEqual(self.document(saved['id'])['fields']['emergency_notify'], fields['emergency_notify'])

    def test_real_pdf_issues_append_current_initials_and_frozen_retries_never_advance(self):
        document = self.save()
        first_request = uid()
        first = self.issue(document, first_request)
        first_pdf = first['pdf']
        after_first = self.document(document['id'])
        self.assertEqual(after_first['fields']['reviews'][:3], ['ST', '', ''])
        self.assertEqual(after_first['review_count'], 1)
        self.assertIn('ST', '\n'.join(page.extract_text() for page in PdfReader(BytesIO(first_pdf)).pages))
        second = self.issue(after_first)
        after_second = self.document(document['id'])
        self.assertEqual(after_second['fields']['reviews'][:3], ['ST', 'ST', ''])
        # Editing advances the save version, but does not consume a review slot.
        edited = self.service.save(self.workspace, {key: after_second[key] for key in ('id', 'version', 'fields')})
        self.profile['name'] = 'Anna Kim'
        third = self.issue(edited)
        final = self.document(document['id'])
        self.assertEqual(final['fields']['reviews'][:4], ['ST', 'ST', 'AK', ''])
        self.assertEqual(final['review_count'], 3)
        self.assertIn('AK', '\n'.join(page.extract_text() for page in PdfReader(BytesIO(third['pdf'])).pages))
        repeated = self.issue(document, first_request)
        self.assertEqual(repeated['pdf'], first_pdf)
        self.assertEqual(self.service.read_pdf(self.workspace, first['id'])[1], first_pdf)
        self.assertEqual(self.document(document['id']), final)
        self.assertNotEqual(first['id'], second['id'])
        with self.assertRaises(SwmsConflict):
            self.service.save(self.workspace, {key: document[key] for key in ('id', 'version', 'fields')})
        self.assertEqual(validate_swms_snapshot(self.service.capture(self.workspace)), self.service.capture(self.workspace))
        restored_workspace = self.projects.add(self.projects.project_id(self.workspace))
        self.service.restore(restored_workspace, self.service.capture(self.workspace))
        self.profile['name'] = 'New Reviewer'
        self.service.issue(restored_workspace, final['id'], final['version'], uid())
        restored = self.service.view(restored_workspace)['documents'][0]
        self.assertEqual(restored['fields']['reviews'][:5], ['ST', 'ST', 'AK', 'NR', ''])
        self.assertEqual(restored['review_count'], 4)
        self.assertEqual(self.service.read_pdf(self.workspace, first['id'])[1], first_pdf)

    def test_blank_profile_consumes_its_slot_and_manual_corrections_remain_editable(self):
        self.service.renderer = lambda document, **kwargs: b'%PDF-1.4 synthetic'
        self.profile['name'] = ''
        fields = complete_swms(default_fields())
        fields['reviews'][0] = 'Future placeholder'
        saved = self.save(fields)
        self.issue(saved)
        saved = self.document(saved['id'])
        self.assertEqual(saved['review_count'], 1)
        self.assertEqual(saved['fields']['reviews'], [''] * 10)
        self.profile['name'] = 'Slayde Tana'
        saved['fields']['reviews'][0] = 'Manual correction'
        saved['fields']['reviews'][1] = 'Future placeholder'
        saved = self.service.save(self.workspace, {key: saved[key] for key in ('id', 'version', 'fields')})
        self.issue(saved)
        result = self.document(saved['id'])
        self.assertEqual(result['fields']['reviews'][:3], ['Manual correction', 'ST', ''])
        self.assertEqual(review_initials('  Anna-Marie O’Neill  '), 'AMO')

    def test_named_http_issues_use_only_current_profile_and_keep_frozen_pdfs(self):
        signers = self.projects.legacy = CertificationService(Store(self.projects.root.parent/'main.sqlite3'))
        first, second = uid(), uid()
        fields = dict.fromkeys(SIGNER_FIELDS, '')
        signers.save_defaults({**fields, 'name':'Previous global'}, 1)
        signers.save_defaults({**fields, 'name':'First signer'}, 1, owner_id=first)
        document = self.save()
        request = uid()
        def issue(member, version, operation):
            handler = Handler({'workspace_id':self.workspace, 'id':document['id'], 'version':version, 'request_id':operation})
            handler.crm_actor = {'id':member, 'name':'Never used as the signer'}
            SwmsHTTP(self.service).dispatch(handler, '/api/swms/issue')
            return handler.result
        status, issued = issue(first, document['version'], request)
        self.assertEqual(status,200)
        pdf = issued['pdf']
        self.assertIn('FS', '\n'.join(page.extract_text() for page in PdfReader(BytesIO(pdf)).pages))
        self.assertEqual(self.document(document['id'])['fields']['reviews'][0], 'FS')
        self.assertEqual(issue(second, document['version'], request)[0],409)
        latest = self.document(document['id'])
        self.assertEqual(issue(second, latest['version'], uid())[0],200)
        self.assertEqual(self.document(document['id'])['fields']['reviews'][:2], ['FS',''])
        signers.save_defaults({**fields, 'name':'Now updated'}, 2, owner_id=first)
        self.assertEqual(issue(first, document['version'], request)[1]['pdf'], pdf)
        self.assertEqual(self.document(document['id'])['review_count'], 2)
        with self.service._connect() as db:
            frozen = db.execute('SELECT pdf FROM swms_issued WHERE request_id=?', (request,)).fetchone()
        self.assertEqual(bytes(frozen['pdf']), pdf)

    def test_legacy_review_register_and_full_ten_slots_keep_their_existing_values(self):
        self.service.renderer = lambda document, **kwargs: b'%PDF-1.4 synthetic'
        saved = self.save()
        snapshot = self.service.capture(self.workspace)
        snapshot['documents'][0].pop('review_count')
        snapshot['documents'][0]['fields']['reviews'] = ['Legacy ' + str(index) for index in range(10)]
        restored = self.projects.add(snapshot['project_id'])
        self.service.restore(restored, snapshot)
        self.service.issue(restored, saved['id'], saved['version'], uid())
        current = self.service.view(restored)['documents'][0]
        self.assertEqual(current['fields']['reviews'], snapshot['documents'][0]['fields']['reviews'])
        self.assertEqual(current['review_count'], 10)
        self.service.issue(restored, saved['id'], current['version'], uid())
        self.assertEqual(self.service.view(restored)['documents'][0]['fields']['reviews'], current['fields']['reviews'])

    def test_concurrent_issue_only_one_version_can_succeed_and_failed_render_rolls_back(self):
        self.service.renderer = lambda document, **kwargs: b'%PDF-1.4 synthetic'
        saved = self.save()
        def issue(_):
            try:
                return self.issue(saved)
            except SwmsConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(issue, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        current = self.document(saved['id'])
        self.assertEqual(current['review_count'], 1)
        self.service.renderer = lambda document, **kwargs: b'not a PDF'
        with self.assertRaises(ValidationError):
            self.issue(current)
        self.assertEqual(self.document(saved['id']), current)
        with self.service._connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM swms_issued').fetchone()[0], 1)

    def test_concurrent_identical_receipt_retries_render_once(self):
        calls = []
        self.service.renderer = lambda document, **kwargs: calls.append(deepcopy(document)) or b'%PDF-1.4 synthetic'
        saved = self.save()
        request = uid()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.issue(saved, request), range(2)))
        self.assertEqual(results[0]['id'], results[1]['id'])
        self.assertEqual(results[0]['pdf'], results[1]['pdf'])
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.document(saved['id'])['review_count'], 1)


if __name__ == '__main__':
    unittest.main()
