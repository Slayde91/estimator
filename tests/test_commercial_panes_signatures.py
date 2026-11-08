"""Optional signer metadata and Quote panes retain portable ownership boundaries."""
import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialConflict, CommercialDocuments, default_fields, validate_fields
from tests.test_commercial_documents import Projects
import tests.test_saved_commercial as saved_helpers


class CommercialPaneSignerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.projects = Projects(self.root)
        self.workspace = self.projects.add()
        self.project = self.projects.project_id(self.workspace)
        self.store = CommercialDocuments(self.projects)

    def save(self, kind, fields, prior=None):
        fields = deepcopy(fields)
        fields['details']['project_no'] = 'PN-01'
        return self.store.save(self.workspace, {'id':prior['id'] if prior else str(uuid4()),
            'version':prior['version'] if prior else 0,'kind':kind,'status':'Draft','fields':fields})

    def test_old_signer_fields_gain_only_empty_optional_date_without_mutating_input(self):
        fields = default_fields('work_order')
        del fields['order']['prepared_date']
        fields['order']['prepared_by'] = 'Historical signer'
        before = deepcopy(fields)
        restored = validate_fields(fields, kind='work_order')
        self.assertEqual(fields, before)
        self.assertEqual(restored['order']['prepared_by'], 'Historical signer')
        self.assertEqual(restored['order']['prepared_date'], '')
        self.assertNotIn('signatures', restored)

    def test_three_signer_names_dates_and_vector_ink_persist_in_pdf_without_global_defaults(self):
        fields = default_fields('work_order')
        quote_fields = default_fields('quote'); quote_fields['terms'] = ''
        quote = self.save('quote', quote_fields)
        issued_quote = self.store.issue(self.workspace, quote['id'], quote['version'], str(uuid4()))
        fields['order']['quote_id'] = issued_quote['document']['id']
        names = {'reviewed_by':'Review Person','prepared_by':'Prepare Person','client_approved_by':'Approve Person'}
        dates = {'review_date':'2026-11-09','prepared_date':'2026-11-10','client_approval_date':'2026-11-11'}
        fields['order'].update(names | dates)
        ink = {'version':1,'ratio':3,'strokes':[[[0,0],[.5,1],[1,0]]]}
        fields['signatures'] = dict.fromkeys(names, ink)
        document = self.save('work_order', fields)
        operation = str(uuid4())
        issued = self.store.issue(self.workspace, document['id'], document['version'], operation)
        content = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(issued['pdf'])).pages)
        for text in (*names.values(), *dates.values()):
            self.assertIn(text, content)
        self.assertEqual(document['fields']['signatures'], fields['signatures'])
        portable = self.store.capture(self.workspace)
        target = self.projects.add(self.project)
        self.store.restore(target, portable)
        restored = self.store.view(target)['documents'][0]
        self.assertEqual(restored['fields']['order'], document['fields']['order'])
        self.assertEqual(default_fields('work_order')['order']['prepared_date'], '')
        # A legacy portable record may omit the newly optional date. Restore
        # normalizes its live view without rewriting the captured source/ink or
        # rendering/replacing any already issued PDF.
        legacy = deepcopy(portable)
        next(row for row in legacy['documents'] if row['kind'] == 'work_order')['fields']['order'].pop('prepared_date')
        before = deepcopy(legacy)
        target = self.projects.add(self.project)
        self.store.restore(target, legacy)
        self.assertEqual(legacy, before)
        self.assertEqual(next(row for row in self.store.view(target)['documents'] if row['kind']=='work_order')['fields']['order']['prepared_date'], '')
        self.assertEqual(self.store.read_pdf(target, issued['id'])[1], issued['pdf'])
        self.assertEqual(self.store.issue(self.workspace, document['id'], document['version'], operation)['pdf'], issued['pdf'])

    def test_quote_notes_and_files_use_existing_cas_owner_and_frozen_revision_rules(self):
        data = BytesIO(); canvas = Canvas(data); canvas.drawString(25, 50, 'Original Quote attachment'); canvas.save()
        attachment = self.store.files.add(self.project, 'quote-source.pdf', base64.b64encode(data.getvalue()).decode())
        fields = default_fields('quote'); fields['terms'] = ''; fields['files'] = [attachment]
        fields['notes'] = [{'id':str(uuid4()),'title':'Quote note','body':'<p>Saved note</p>',
                           'author':'Fixture user','updated_at':'2026-11-08T01:00:00Z'}]
        quote = self.save('quote', fields)
        self.assertEqual(self.store.read_attachment(self.workspace, quote['id'], attachment['id'])[1], data.getvalue())
        updated = deepcopy(quote['fields']); updated['notes'][0]['title'] = 'Updated note'
        changed = self.save('quote', updated, quote)
        with self.assertRaises(CommercialConflict): self.save('quote', updated, quote)
        operation = str(uuid4())
        issued = self.store.issue(self.workspace, changed['id'], changed['version'], operation)
        self.assertIn('Original Quote attachment', PdfReader(BytesIO(issued['pdf'])).pages[-1].extract_text())
        (self.store.files.folder(self.project) / attachment['id']).write_bytes(b'changed')
        self.assertEqual(self.store.issue(self.workspace, changed['id'], changed['version'], operation)['pdf'], issued['pdf'])
        with self.assertRaises(ValidationError):
            self.store.files.read(str(uuid4()), attachment)
        for key in ('notes','files'):
            invalid = default_fields('purchase_order'); invalid[key] = fields[key]
            with self.assertRaises(ValidationError): validate_fields(invalid, kind='purchase_order')


class SavedQuotePaneTests(unittest.TestCase):
    setUp = saved_helpers.SavedQuoteTests.setUp
    register = saved_helpers.SavedQuoteTests.register
    perform = saved_helpers.SavedQuoteTests.perform

    def test_native_saved_quote_notes_and_files_keep_versions_and_original_bytes(self):
        original = self.path.read_bytes()
        attachment = self.perform('attachment', name='quote-evidence.txt', content=base64.b64encode(b'Quote evidence original').decode())
        self.assertEqual(self.path.read_bytes(), original, 'Staging an attachment does not publish document changes.')
        note = {'id':str(uuid4()),'title':'Saved Quote note','body':'<p>Original body</p>',
                'author':'Fixture user','updated_at':'2026-11-08T01:00:00Z'}
        saved = self.perform('notes', id=self.document['id'], version=self.document['version'], notes=[note])
        prior_source = dict(self.source)
        self.source['revision'] = saved['revision']
        document = saved['result']
        fields = deepcopy(document['fields']); fields['files'] = [attachment]
        written = self.perform('save', id=document['id'],version=document['version'],kind='quote',status='Draft',fields=fields)
        self.source['revision'] = written['revision']
        read = self.perform('read-attachment', id=document['id'], file_id=attachment['id'])
        self.assertEqual(base64.b64decode(read['content']), b'Quote evidence original')
        captured = json.loads(self.path.read_bytes())['commercial_documents']['documents'][0]
        self.assertEqual(captured['fields']['notes'], [note])
        self.assertEqual(captured['fields']['files'], [attachment])
        with self.assertRaises(CommercialConflict):
            self.saved.perform('notes', {'source':prior_source,'id':document['id'],'version':1,'notes':[]},self.http.execute)
        self.assertEqual(json.loads(self.path.read_bytes())['commercial_documents']['documents'][0], captured)


if __name__ == '__main__': unittest.main()
