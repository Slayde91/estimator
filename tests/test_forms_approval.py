"""Account-backed approval evidence and sequential field locks."""
from base64 import b64encode
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest

from PIL import Image
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.forms import Forms
from estimator.forms_pdf import render_form_pdf
from test_forms import entry, field, template


class FormApprovalTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'forms.sqlite3'
        self.user = {'id': 'worker', 'name': 'Login name', 'role': 'editor'}
        ink = BytesIO()
        Image.new('RGB', (10, 10), 'black').save(ink, 'PNG')
        self.image = 'data:image/png;base64,' + b64encode(ink.getvalue()).decode('ascii')
        self.profile = {'fields': {'name': 'Settings full name'}, 'signature_image': self.image,
                        'signature_name': 'Approval.png'}
        self.store = Forms(self.path, lambda: [self.user], lambda: {}, lambda **kwargs: self.profile)

    def save(self, t, values, record=None, **kwargs):
        payload = entry(t, values, **kwargs)
        if record:
            payload.update(id=record['id'], version=record['version'])
        return self.store.save_entry(self.user, payload)

    def test_authenticated_snapshot_unlocks_only_following_approved_sections(self):
        t = self.store.save_template(self.user, template(fields=[
            field('before'), field('first', 'approval'), field('detail'), field('second', 'approval'), field('final')]))
        for values in ({'detail': 'bypass'}, {'first': False, 'detail': 'bypass'},
                       {'first': True, 'second': False, 'final': 'bypass'}):
            with self.assertRaisesRegex(ValidationError, 'Approve'):
                self.save(t, values)
        draft = self.save(t, {'before': 'Initial'})
        saved = self.save(t, {'before': 'Initial', 'first': True, 'detail': 'Signed section'}, draft)
        signed = saved['values']['first']
        self.assertEqual(signed['member_id'], self.user['id'])
        self.assertEqual(signed['member_name'], 'Settings full name')
        self.assertEqual(signed['signature_image'], self.image)
        self.assertEqual(signed['at'], saved['updated_at'])
        self.assertNotIn('second', saved['values'])
        self.profile['fields']['name'] = 'Updated Settings'
        self.profile['signature_image'] = None
        again = self.save(t, {**saved['values'], 'detail': 'Updated answer'}, saved)
        self.assertEqual(again['values']['first'], signed)
        for replacement in (False, None, {**signed, 'member_name': 'Someone else'}):
            with self.assertRaises(ValidationError):
                self.save(t, {**again['values'], 'first': replacement}, again)
        complete = self.save(t, {**again['values'], 'second': True, 'final': 'Ready'}, again, status='submitted')
        self.assertEqual(complete['values']['first'], signed)
        self.assertEqual(complete['values']['second']['member_name'], 'Updated Settings')
        self.assertNotIn('signature_image', complete['values']['second'])

    def test_historical_booleans_and_locked_answers_survive_without_new_evidence(self):
        t = self.store.save_template(self.user, template(fields=[
            field('note'), field('approval', 'approval'), field('later')]))
        draft = self.save(t, {'note': 'old'})
        legacy = {'note': 'old', 'approval': False, 'later': 'Previously recorded'}
        with self.store.connect(True) as db:
            db.execute('UPDATE form_entries SET answers=? WHERE id=?', (json.dumps(legacy), draft['id']))
        saved = self.save(t, {**legacy, 'note': 'new'}, draft)
        self.assertEqual(saved['values']['later'], 'Previously recorded')
        with self.assertRaisesRegex(ValidationError, 'Approve'):
            self.save(t, {**saved['values'], 'later': 'Changed'}, saved)
        with self.store.connect(True) as db:
            db.execute('UPDATE form_entries SET answers=? WHERE id=?',
                       (json.dumps({**saved['values'], 'approval': True}), saved['id']))
        opened = self.store.entry(self.user, saved['id'])
        retained = self.save(t, {**opened['values'], 'later': 'Available'}, opened)
        self.assertIs(retained['values']['approval'], True)

    def test_conditional_approval_and_groups_obey_the_same_gate(self):
        t = self.store.save_template(self.user, template(fields=[
            field('choice', 'choice', options=['Yes', 'No']),
            field('approval', 'approval', condition={'field_id': 'choice', 'value': 'Yes'}),
            field('note'),
            field('rows', 'group', children=[field('sign', 'approval'), field('answer')])]))
        saved = self.save(t, {'choice': 'No', 'note': 'Open'})
        with self.assertRaisesRegex(ValidationError, 'Approve'):
            self.save(t, {'choice': 'Yes', 'note': 'Changed'}, saved)
        with self.assertRaisesRegex(ValidationError, 'Approve'):
            self.save(t, {'choice': 'No', 'note': 'Open', 'rows': [{'answer': 'bypass'}]}, saved)
        signed = self.save(t, {'choice': 'Yes', 'approval': True, 'note': 'Now open',
                               'rows': [{'sign': True, 'answer': 'Approved row'}]}, saved)
        self.assertEqual(signed['values']['rows'][0]['sign']['member_name'], 'Settings full name')
        hidden = self.save(t, {**signed['values'], 'choice': 'No'}, signed)
        self.assertEqual(hidden['values']['approval'], signed['values']['approval'])

    def test_workflow_transition_cannot_bypass_gate_and_snapshots_signature(self):
        t = self.store.save_template(self.user, template(mode='workflow',
            settings={'stages': [{'id': 'first', 'name': 'Preparation', 'roles': ['editor']},
                                 {'id': 'last', 'name': 'Review', 'roles': ['editor']}]},
            fields=[field('approve', 'approval'), field('after'), field('review', stage_id='last')]))
        draft = self.save(t, {})
        with self.assertRaisesRegex(ValidationError, 'Approve'):
            self.store.approve(self.user, {'id': draft['id'], 'version': draft['version']})
        saved = self.save(t, {'approve': True, 'after': 'Checked'}, draft)
        body = {'id': saved['id'], 'version': saved['version']}
        signed = self.store.approve(self.user, body)
        self.assertEqual(self.store.approve(self.user, body), signed)
        evidence = signed['approvals'][0]
        self.assertEqual(evidence['member_name'], 'Settings full name')
        self.assertEqual(evidence['signature_image'], self.image)
        self.assertEqual(signed['stage_id'], 'last')
        with self.assertRaisesRegex(ValidationError, 'another workflow'):
            self.save(t, {**signed['values'], 'after': 'Changed'}, signed)
        reviewed = self.save(t, {**signed['values'], 'review': 'Verified'}, signed)
        pdf = PdfReader(BytesIO(render_form_pdf(reviewed, 'ceasefire', {}, [], lambda _: {})))
        text = ' '.join(page.extract_text() for page in pdf.pages)
        self.assertIn('Settings full name', text)
        self.assertIn('Approved by', text)
        self.assertTrue(any(page.images for page in pdf.pages))
        reopened = self.store.reopen(self.user, {'id': reviewed['id'], 'version': reviewed['version']})
        self.assertEqual(reopened['reversals'][0]['original_approval'], evidence)
        again = Forms(self.path, lambda: [self.user], lambda: {}, lambda **kwargs: self.profile)
        self.assertEqual(again.entry(self.user, reopened['id'])['values']['approve'], saved['values']['approve'])

    def test_approval_rows_keep_their_identity_when_removed_or_reordered(self):
        t = self.store.save_template(self.user, template(fields=[
            field('rows', 'group', children=[field('sign', 'approval'), field('note')])]))
        saved = self.save(t, {'rows': [{'sign': True, 'note': 'Signed first row'}, {}]})
        first, second = saved['values']['rows']
        self.assertNotEqual(first['_row_id'], second['_row_id'])
        removed = self.save(t, {'rows': [second]}, saved)
        self.assertEqual(removed['values']['rows'], [second])
        signed = self.save(t, {'rows': [{**second, 'sign': True, 'note': 'Signed second row'},
                                      {'sign': True, 'note': 'Signed third row'}]}, removed)
        rows = signed['values']['rows']
        moved = self.save(t, {'rows': list(reversed(rows))}, signed)
        self.assertEqual(moved['values']['rows'], list(reversed(rows)))
        with self.assertRaisesRegex(ValidationError, 'existing form row once'):
            self.save(t, {'rows': [rows[0], rows[0]]}, moved)
        with self.assertRaisesRegex(ValidationError, 'cannot be overwritten'):
            self.save(t, {'rows': [{**rows[0], 'sign': {**rows[0]['sign'], 'member_name': 'Forged'}}]}, moved)

    def test_legacy_approval_rows_get_repeatable_ids_without_changing_stored_history(self):
        t = self.store.save_template(self.user, template(fields=[
            field('rows', 'group', children=[field('sign', 'approval'), field('note')])]))
        draft = self.save(t, {})
        signature = {'member_id': 'original', 'member_name': 'Original signer',
                     'at': '2026-01-01T00:00:00Z', 'signature_image': self.image}
        legacy = {'rows': [{'sign': True, 'note': 'Old boolean'},
                           {'sign': signature, 'note': 'Old signature'}, {}]}
        encoded = json.dumps(legacy)
        with self.store.connect(True) as db:
            db.execute('UPDATE form_entries SET answers=? WHERE id=?', (encoded, draft['id']))
        opened = self.store.entry(self.user, draft['id'])
        restarted = Forms(self.path, lambda: [self.user], lambda: {}, lambda **kwargs: self.profile)
        self.assertEqual(restarted.entry(self.user, draft['id'])['values'], opened['values'])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT answers FROM form_entries WHERE id=?',
                                       (draft['id'],)).fetchone()['answers'], encoded)
        rows = opened['values']['rows']
        self.assertEqual(len({row['_row_id'] for row in rows}), 3)
        reordered = self.save(t, {'rows': [rows[2], rows[1], rows[0]]}, opened)
        self.assertEqual(reordered['values']['rows'][1]['sign'], signature)
        self.assertIs(reordered['values']['rows'][2]['sign'], True)
        removed = self.save(t, {'rows': [rows[2]]}, reordered)
        self.assertEqual(removed['values']['rows'], [rows[2]])
