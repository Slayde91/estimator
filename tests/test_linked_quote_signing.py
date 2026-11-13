"""The Work Order details signature and its linked Quote commit together."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, default_fields
from estimator.commercial_http import CommercialHTTP
from tests import test_saved_commercial, test_work_order_tracking
from tests.commercial_ready_fixtures import complete_work_order, INK


def details_signature(fields, document=None):
    fields = deepcopy(fields)
    fields.setdefault('signatures', {})['details_by'] = INK
    fields['order'].update(details_by='Details Signer', details_date='2026-11-14')
    return dict(kind='work_order', id=document['id'] if document else str(uuid4()),
                version=document['version'] if document else 0, status=document['status'] if document else 'Draft',
                fields=fields, signature_actions=[dict(key='details_by', name='Details Signer',
                                                       date='2026-11-14', signature=INK)])


def clear_details(document):
    return {**{key: document[key] for key in ('kind', 'id', 'version', 'status', 'fields')},
            'signature_actions': [{'key': 'details_by', 'clear': True}]}


class LinkedQuoteSigningTests(unittest.TestCase):
    def setUp(self):
        fixture = test_work_order_tracking.WorkOrderTrackingTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture = fixture
        self.store, self.workspace, self.quote = fixture.store, fixture.workspace, fixture.quote

    def linked_quote(self):
        return self.store.document_context(self.workspace, self.quote['id'])[1]

    def test_explicit_first_signature_retry_audit_legacy_save_and_clear(self):
        fields = self.fixture.fields()
        payload = details_signature(fields)
        receipt = {}
        doc = self.store.save(self.workspace, payload, linked_quote_transition=receipt)
        accepted = self.linked_quote()
        self.assertEqual((accepted['version'], accepted['status']), (self.quote['version'] + 1, 'Accepted'))
        self.assertEqual(doc['status'], 'Review')
        self.assertEqual(self.store.capture_project(self.workspace)[1], 'Won')
        self.assertEqual(receipt, dict(id=accepted['id'], previous_status=self.quote['status'], status='Accepted'))
        receipt = {}
        self.assertEqual(self.store.save(self.workspace, payload, linked_quote_transition=receipt), doc)
        self.assertEqual(receipt, {})
        doc = self.store.save(self.workspace, details_signature(doc['fields'], doc), linked_quote_transition=receipt)
        self.assertEqual(receipt, {})
        self.assertEqual(self.linked_quote(), accepted)
        with self.assertRaises(CommercialConflict):
            self.store.status(self.workspace, self.quote['id'], self.quote['version'], 'Lost')

        # An older client sending identical ink without a signing action cannot
        # reinstate acceptance after an independent board move.
        lost = self.store.status(self.workspace, accepted['id'], accepted['version'], 'Lost')
        doc = self.store.save(self.workspace, {key: doc[key] for key in ('id', 'kind', 'fields', 'version', 'status')})
        self.assertEqual(self.linked_quote(), lost)
        clearing = clear_details(doc)
        doc = self.store.save(self.workspace, clearing, linked_quote_transition=receipt)
        self.assertEqual(receipt, dict(id=accepted['id'], previous_status='Lost', status='Presented'))
        presented = self.linked_quote()
        self.assertEqual((doc['status'], presented['status'], presented['version']), ('Draft', 'Presented', lost['version'] + 1))
        self.assertEqual(self.store.capture_project(self.workspace)[1], 'Engage')
        with self.assertRaises(CommercialConflict):
            self.store.save(self.workspace, clearing)
        self.assertEqual(self.linked_quote(), presented)
        events = self.store.activity(self.workspace, self.quote['id'])['events']
        self.assertEqual([(e['previous_status'], e['status']) for e in events if 'previous_status' in e],
                         [('Lost', 'Presented'), ('Accepted', 'Lost'), (self.quote['status'], 'Accepted')])
        self.assertEqual(self.store.read_pdf(self.workspace, self.fixture.receipt['id'])[1], self.fixture.receipt['pdf'])

    def test_failure_rolls_back_both_documents_and_pending_project_stage(self):
        proposal = details_signature(self.fixture.fields())
        original = self.store.capture_project(self.workspace)
        receipt = {}
        with patch.object(self.store, '_validate_draft_save', side_effect=ValidationError('Synthetic write failure')):
            with self.assertRaisesRegex(ValidationError, 'Synthetic write'):
                self.store.save(self.workspace, proposal, linked_quote_transition=receipt)
        self.assertEqual(receipt, {})
        self.assertEqual(self.store.capture_project(self.workspace), original)
        self.assertFalse(any(e.get('status') == 'Accepted' for e in self.store.activity(self.workspace, self.quote['id'])['events']))
        self.assertEqual(self.store.save(self.workspace, proposal)['status'], 'Review')

    def test_blank_clear_and_deleted_link_leave_other_quotes_alone(self):
        order = self.fixture.save('work_order', self.fixture.fields())
        self.store.save(self.workspace, clear_details(order))
        self.assertEqual(self.linked_quote(), self.quote)
        order = self.store.document_context(self.workspace, order['id'])[1]
        other = self.fixture.save('quote', self.quote['fields'])
        self.store.delete(self.workspace, self.quote['id'], self.quote['version'])
        fields = deepcopy(order['fields'])
        fields['order'].update(start_date='2026-11-14', urgency='Medium Priority', description='Fixture work', estimated_cost='23')
        document = self.store.save(self.workspace, details_signature(fields, order))
        self.assertEqual(document['status'], 'Review')
        self.assertEqual(self.store.document_context(self.workspace, other['id'])[1], other)
        self.assertIsNone(self.store.capture_project(self.workspace)[1])

    def test_incomplete_quote_cannot_be_accepted_but_evidence_can_be_withdrawn(self):
        proposal = details_signature(self.fixture.fields())
        work = self.store.save(self.workspace, proposal)
        quote = self.linked_quote()
        incomplete = deepcopy(quote['fields'])
        incomplete['allowances'] = ''
        # A historical draft can remain editable after losing required fields.
        self.fixture.save('quote', incomplete, quote)
        cleared = self.store.save(self.workspace, clear_details(work))
        self.assertEqual(self.linked_quote()['status'], 'Presented')
        before = self.store.capture_project(self.workspace)
        with self.assertRaisesRegex(ValidationError, 'required Quote fields'):
            self.store.save(self.workspace, details_signature(work['fields'], cleared))
        self.assertEqual(self.store.capture_project(self.workspace), before)

    def test_recovered_work_order_may_update_only_enrolled_quote(self):
        fields = self.fixture.fields()
        draft = self.store.save(self.workspace, dict(id=str(uuid4()), kind='work_order', version=0,
                                status='Draft', fields=fields), unfiled_context={})
        http = CommercialHTTP(self.store)

        def save_recovered(body):
            card = next(c for c in self.store.unfiled.cards(None) if c['id'] == draft['id'])
            source = {'file_id':card['source_file'], 'revision':card['source_revision']}
            return self.store.unfiled.perform('save', source, body, http.execute)['result']

        signed = save_recovered(details_signature(draft['fields'], draft))
        self.assertEqual((signed['status'], self.linked_quote()), ('Review', self.quote))
        self.assertNotIn('linked_quote_transition', signed)
        quote_payload = {key:self.quote[key] for key in ('id', 'kind', 'version', 'status', 'fields')}
        self.store.save(self.workspace, quote_payload, unfiled_context={})
        updated = save_recovered(details_signature(signed['fields'], signed))
        self.assertEqual(updated['linked_quote_transition'], dict(id=self.quote['id'], previous_status=self.quote['status'], status='Accepted'))
        self.assertEqual(self.linked_quote()['status'], 'Accepted')
        self.assertNotIn('linked_quote_transition', self.store.document_context(self.workspace, signed['id'])[1])
        repeated = save_recovered(details_signature(updated['fields'], updated))
        self.assertNotIn('linked_quote_transition', repeated)


class SavedLinkedQuoteSigningTests(unittest.TestCase):
    def test_saved_copy_publishes_both_stages_and_ignores_identical_ids_in_another_file(self):
        fixture = test_saved_commercial.SavedQuoteTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        opened = fixture.perform('issue', kind='quote', id=fixture.document['id'], version=fixture.document['version'], request_id=str(uuid4()))
        quote = opened['result']['document']
        original = fixture.path.read_bytes()
        copy_path = fixture.folder / 'signed-copy.cf.json'
        copy_path.write_bytes(original)
        fixture.library.commercial_register(refresh=True)
        card = next(card for card in fixture.register()['documents'] if card['source_path'] == str(copy_path))
        source = dict(file_id=card['source_file'], revision=card['source_revision'])
        fields = complete_work_order(default_fields('work_order', quote['fields']['details']))
        fields['order']['quote_id'] = quote['id']
        body = details_signature(fields)
        signed = fixture.saved.perform('save', {**body, 'source':source}, fixture.http.execute)

        self.assertEqual(signed['result']['linked_quote_transition'],
                         dict(id=quote['id'], previous_status=quote['status'], status='Accepted'))

        def assert_stages(quote_stage, work_stage, project_stage):
            project = json.loads(copy_path.read_bytes())
            self.assertEqual({doc['kind']:doc['status'] for doc in project['commercial_documents']['documents']},
                             {'quote':quote_stage, 'work_order':work_stage})
            self.assertEqual(project['project_status'], project_stage)
            self.assertNotIn(b'linked_quote_transition', copy_path.read_bytes())
            self.assertEqual(fixture.path.read_bytes(), original)

        assert_stages('Accepted', 'Review', 'Won')
        with self.assertRaises(CommercialConflict):
            fixture.saved.perform('save', {**body, 'source':source}, fixture.http.execute)
        cleared = fixture.saved.perform('save', {**clear_details(signed['result']), 'source':{**source, 'revision':signed['revision']}}, fixture.http.execute)
        self.assertEqual(cleared['result']['linked_quote_transition'],
                         dict(id=quote['id'], previous_status='Accepted', status='Presented'))
        assert_stages('Presented', 'Draft', 'Engage')
