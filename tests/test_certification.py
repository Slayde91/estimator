"""Durable certification revisions never alter estimates or saved PDF history."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
from threading import Barrier
import unittest
import uuid

from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.certification import (CertificationService, CertificationConflict,
    CertificationNotFound, FIELDS, validate_fields)
from estimator.company_settings import DEFAULTS
from estimator.storage import Store


def fields(**values):
    return {**dict.fromkeys(FIELDS, ''), **dict.fromkeys(FIELDS[:13], 'N/A'), **values}


def pdf(text='CERTIFICATE', **kwargs):
    output = BytesIO(); canvas = Canvas(output)
    canvas.drawString(30, 500, text); canvas.save()
    return output.getvalue()


class CertificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)/'test.sqlite3'
        self.store = Store(self.path)
        self.service = CertificationService(self.store)
        self.company = {**DEFAULTS, 'name': 'Example Contractor'}

    def create(self, **values):
        return self.service.create(fields(client='Client', project='Project', **values))

    def generate(self, document, **values):
        return self.service.generate(document['id'], fields(**{**document['fields'], **values}),
            document['version'], str(uuid.uuid4()), self.company)

    def test_create_save_reopen_and_required_field_inventory(self):
        document = self.service.create({'client': 'Original client'})
        self.assertEqual(set(document['fields']), set(FIELDS))
        self.assertEqual(document['version'], 1)
        self.assertEqual(document['revisions'], [])
        updated = self.service.save(document['id'], {**document['fields'], 'project':'New project'}, 1)
        self.assertEqual(updated['version'], 2)
        self.assertEqual(self.service.save(document['id'],updated['fields'],1),updated)
        reopened = CertificationService(Store(self.path)).get(document['id'])
        self.assertEqual(updated, reopened)
        self.assertEqual(self.service.list_documents()['items'][0]['project'], 'New project')
        self.assertEqual(self.service.list_documents()['items'][0]['revision_count'], 0)

    def test_legacy_project_and_calculator_tables_not_modified(self):
        self.store.save_configuration({'inventory':{},'rates':{}})
        self.store.save_company_settings(self.company)
        with self.store.connect() as db:
            before = {name: db.execute('SELECT * FROM '+name).fetchall() for name in
                ('settings','quotes','calculator_states','app_preferences')}
        document = self.create()
        self.generate(document, statement_of_compliance='Entered statement')
        with self.store.connect() as db:
            after = {name: db.execute('SELECT * FROM '+name).fetchall() for name in before}
        self.assertEqual(before, after)

    def test_generated_revision_captures_text_company_and_final_cover_forever(self):
        from estimator.pdf_cover import prepend_cover_pdf
        import base64
        self.company.update(cover_pdf='data:application/pdf;base64,'+base64.b64encode(pdf('FIRST COVER')).decode(),
                            cover_pdf_name='first.pdf')
        document = self.create()
        original = self.generate(document, statement_of_compliance='FIRST STATEMENT')
        payload = self.service.revision_pdf(document['id'], 1)
        pages = PdfReader(BytesIO(payload)).pages
        self.assertGreaterEqual(len(pages), 2)
        self.assertIn('FIRST COVER', pages[0].extract_text())
        text = '\n'.join(p.extract_text() for p in pages)
        self.assertEqual(text.count('FIRST COVER'), 1)
        self.assertIn('FIRST STATEMENT', text)
        self.assertIn('Example Contractor are approved', text)
        self.company.update(name='Changed company', cover_pdf=None, cover_pdf_name='')
        document = original['document']
        next_revision = self.generate(document, statement_of_compliance='SECOND STATEMENT')
        self.assertEqual(next_revision['revision']['revision'], 2)
        self.assertEqual(self.service.revision_pdf(document['id'], 1), payload)
        reopened = CertificationService(Store(self.path))
        self.assertEqual(reopened.revision_pdf(document['id'],1), payload)
        self.assertEqual([r['revision'] for r in reopened.get(document['id'])['revisions']], [2,1])
        with self.store.connect() as db:
            company, data = db.execute('SELECT company,fields FROM certification_revisions '
                                      'WHERE document_id=? AND revision=1',(document['id'],)).fetchone()
        self.assertEqual(json.loads(company)['name'], 'Example Contractor')
        self.assertEqual(json.loads(data)['statement_of_compliance'], 'FIRST STATEMENT')

    def test_create_and_generate_replays_are_idempotent_even_after_version_changes(self):
        request = str(uuid.uuid4())
        document = self.service.create(fields(project='Retry'), request)
        self.assertEqual(self.service.create(fields(project='Retry'), request), document)
        with self.assertRaises(CertificationConflict): self.service.create({'project':'Different'},request)
        operation = str(uuid.uuid4())
        generated = self.service.generate(document['id'],document['fields'],1,operation,self.company)
        self.assertEqual(self.service.generate(document['id'],document['fields'],1,operation,self.company),generated)
        self.assertEqual(len(self.service.get(document['id'])['revisions']),1)
        with self.assertRaises(CertificationConflict):
            self.service.generate(document['id'],{**document['fields'],'client':'Different'},1,operation,self.company)

    def test_stale_version_is_rejected_without_revision_or_draft_change(self):
        document = self.create()
        changed = self.service.save(document['id'],{**document['fields'],'address':'Changed'},1)
        with self.assertRaises(CertificationConflict): self.generate(document)
        with self.assertRaises(CertificationConflict): self.service.save(document['id'],document['fields'],1)
        self.assertEqual(self.service.get(document['id']),changed)

    def test_lost_creation_response_cannot_upgrade_original_fields_over_a_newer_draft(self):
        request = str(uuid.uuid4())
        original = fields(project='Original generation attempt')
        document = self.service.create(original, request)
        changed = self.service.save(document['id'], {**original, 'project':'Newer window draft'}, 1)
        # The creation receipt remains byte-for-byte the first response. GET
        # still returns current state. Retrying Generate with the known ID and
        # original captured fields/version must reject the newer draft.
        replayed = self.service.create(original, request)
        self.assertEqual(json.dumps(replayed),json.dumps(document))
        self.assertEqual(replayed['id'], changed['id'])
        with self.assertRaises(CertificationConflict):
            self.service.generate(replayed['id'], original, replayed['version'], str(uuid.uuid4()), self.company)
        self.assertEqual(self.service.get(document['id']), changed)
        self.assertEqual(self.service.list_documents()['items'][0]['revision_count'], 0)
        # Even if the current fields later return to their original values,
        # creation replay is still exactly the original receipt/version.
        self.service.save(document['id'], original, changed['version'])
        recovered = self.service.create(original, request)
        self.assertEqual(recovered['fields'], original)
        self.assertEqual(recovered['version'], 1)

    def test_render_cover_and_invalid_pdf_failures_do_not_save_any_revision(self):
        document = self.create()
        def broken(*args,**kwargs): raise ValueError('render failed')
        for renderer,coverer in [(broken,None),(lambda *a,**k:b'bad',lambda payload,company:payload),(lambda *a,**k:pdf(),broken)]:
            service = CertificationService(self.store,renderer=renderer,coverer=coverer)
            with self.assertRaises((ValidationError,ValueError)):
                service.generate(document['id'],{**document['fields'],'address':'Not saved'},1,str(uuid.uuid4()),self.company)
            self.assertEqual(self.service.get(document['id']),document)

    def test_parallel_retry_only_commits_one_revision(self):
        document = self.create(); barrier=Barrier(2)
        def render(*args,**kwargs):
            barrier.wait(timeout=10)
            return pdf('PARALLEL')
        service = CertificationService(self.store,renderer=render)
        request=str(uuid.uuid4())
        def action(_): return service.generate(document['id'],document['fields'],1,request,self.company)
        with ThreadPoolExecutor(max_workers=2) as pool: outcomes=list(pool.map(action,range(2)))
        self.assertEqual(outcomes[0]['revision'],outcomes[1]['revision'])
        self.assertEqual(self.service.get(document['id'])['version'],2)
        self.assertEqual(len(self.service.get(document['id'])['revisions']),1)

    def test_saved_pdf_integrity_is_verified_before_returning_bytes(self):
        document=self.create(); self.generate(document)
        with self.store.connect() as db:
            db.execute('UPDATE certification_revisions SET pdf=? WHERE document_id=?',(pdf('CORRUPTED'),document['id']))
        with self.assertRaisesRegex(ValidationError,'integrity'): self.service.revision_pdf(document['id'],1)

    def test_field_identity_version_and_size_limits(self):
        for bad in ({'extra':'x'},[],{'name':None},{'name':'\x00'},{'name':'x'*8001},{'name':'\ud800'}):
            with self.subTest(bad=repr(bad)),self.assertRaises(ValidationError): validate_fields(bad,partial=True)
        with self.assertRaises(ValidationError): validate_fields({})
        with self.assertRaises(ValidationError): validate_fields(fields(**dict.fromkeys(FIELDS,'x'*3000)))
        with self.assertRaises(ValidationError): self.service.get('../../outside')
        with self.assertRaises(CertificationNotFound): self.service.get(str(uuid.uuid4()))
        document=self.create()
        with self.assertRaises(ValidationError): self.service.save(document['id'],document['fields'],True)
        with self.assertRaises(CertificationNotFound): self.service.revision_pdf(document['id'],1)

    def test_report_escapes_user_markup_and_long_entries_paginate(self):
        from estimator.certification_report import render_certificate_pdf
        value=fields(client='<b>Client & Co</b>',project='Example project',
            statement_of_compliance='Entered <tag> statement & conditions',
            other_references='Long user entry. '*500,qualification='Entered qualification. '*100)
        payload=render_certificate_pdf(value,company=self.company,certificate_id=str(uuid.uuid4()),
                                      revision=7,created_at='2026-10-29T00:00:00+00:00')
        pages=PdfReader(BytesIO(payload)).pages
        text='\n'.join(p.extract_text() for p in pages)
        self.assertGreater(len(pages),2)
        self.assertIn('<b>Client & Co</b>',text)
        self.assertIn('Entered <tag> statement & conditions',text)
        # The indented detail column wraps some sentences between words.
        # Every word/end token must still survive, including page boundaries.
        self.assertEqual(text.count('Long'),500)
        self.assertEqual(text.count('user'),500)
        self.assertEqual(text.count('entry.'),500)
        # A long cell can span pages, with the repeating table/page header
        # between two words. Count its intact terminal token across all pages.
        self.assertEqual(text.count('qualification.'),100)
        self.assertIn('Revision 7',text)
        self.assertNotIn('F043571A',text)


if __name__=='__main__': unittest.main()
