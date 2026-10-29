"""Certificate options and signer defaults preserve old source snapshots/retries."""
import base64
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
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
    DEFAULT_OPTIONS, FIELDS, SIGNER_FIELDS, validate_options)
from estimator.company_settings import DEFAULTS
from estimator.storage import Store


def fields(**patch):
    return {**dict.fromkeys(FIELDS, ''), **patch}


def pdf(text):
    output = BytesIO(); canvas = Canvas(output)
    canvas.drawString(30, 500, text); canvas.save()
    return output.getvalue()


def options(text=None, scopes=()):
    return {'cover_pdf': 'data:application/pdf;base64,'+base64.b64encode(pdf(text)).decode() if text else None,
            'cover_pdf_name': text+'.pdf' if text else '', 'scopes': list(scopes)}


def text_pages(payload):
    return [p.extract_text() for p in PdfReader(BytesIO(payload)).pages]


class CertificationOptionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name)/'test.sqlite3')
        self.service = CertificationService(self.store, renderer=lambda *a, **k: pdf('CERTIFICATE BODY'))
        self.company = {**DEFAULTS, 'name': 'Original Company', **{k: v for k, v in options('GLOBAL').items() if k != 'scopes'}}

    def test_validated_options_persist_without_mutating_user_payload(self):
        selected = options('LOCAL', ['service_penetrations', 'structural_steel'])
        before = deepcopy(selected)
        document = self.service.create({'project': 'Entered project'}, options=selected)
        self.assertEqual(selected, before)
        self.assertEqual(document['options'], before)
        document['options']['scopes'].clear()
        reopened = CertificationService(Store(self.store.path)).get(document['id'])
        self.assertEqual(reopened['options'], before)
        self.assertEqual(reopened['fields']['australian_standards'], '')
        self.assertEqual(reopened['fields']['ncc_clauses'], '')
        bad_values = [None, {}, {**before, 'extra': True}, {**before, 'scopes': ['unknown']},
                      {**before, 'scopes': ['ductwork', 'ductwork']}, {**before, 'scopes': [1]},
                      {**before, 'cover_pdf': 'data:application/pdf;base64,bm90IGEgcGRm'},
                      {**before, 'cover_pdf_name': '../cover.pdf'},
                      {**before, 'cover_pdf': None, 'cover_pdf_name': 1}]
        for value in bad_values:
            with self.subTest(value=repr(value)[:80]), self.assertRaises(ValidationError):
                validate_options(value)
        self.assertEqual(self.service.get(document['id']), reopened)

    def test_options_only_changes_obey_cas_and_legacy_save_preserves_them(self):
        document = self.service.create(fields(project='Original'), options=options(scopes=['ductwork']))
        changed = self.service.save(document['id'], document['fields'], 1,
                                    options=options(scopes=['structural_steel']))
        self.assertEqual(changed['version'], 2)
        self.assertEqual(changed['revisions'], [])
        self.assertEqual(self.service.save(document['id'], document['fields'], 1,
                         options=changed['options']), changed)
        with self.assertRaises(CertificationConflict):
            self.service.save(document['id'], document['fields'], 1, options=document['options'])
        saved = self.service.save(document['id'], {**document['fields'], 'address': 'Entered address'}, 2)
        self.assertEqual(saved['options'], changed['options'])
        self.assertEqual(saved['version'], 3)

    def test_global_specific_cover_follows_main_and_frozen_options_keep_legacy_data(self):
        first_options = options('FIRST LOCAL', ['structural_steel_columns'])
        chosen = options('SETTINGS COVER')
        self.service.covers.save('certification', chosen['cover_pdf'], chosen['cover_pdf_name'], 1)
        document = self.service.create(fields(project='Original'), options=first_options)
        company_before = deepcopy(self.company)
        # A fields-only legacy generation keeps this document's saved options.
        generated = self.service.generate(document['id'], document['fields'], 1, str(uuid.uuid4()), self.company)
        first = self.service.revision_pdf(document['id'], 1)
        self.assertEqual(text_pages(first), ['GLOBAL\n', 'SETTINGS COVER\n', 'CERTIFICATE BODY\n'])
        self.assertEqual(self.company, company_before)
        with self.store.connect() as db:
            frozen_company, frozen_options = db.execute('SELECT company,options FROM certification_revisions '
                'WHERE document_id=? AND revision=1', (document['id'],)).fetchone()
        self.assertEqual(json.loads(frozen_options), first_options)
        self.assertEqual(json.loads(frozen_company)['cover_pdf'], self.company['cover_pdf'])
        # Clearing Settings is authoritative; legacy document covers stay data.
        self.service.covers.save('certification', None, '', 2)
        next_options = options(scopes=['ductwork'])
        self.company.update(cover_pdf=options('NEW GLOBAL')['cover_pdf'], cover_pdf_name='New global.pdf')
        second = self.service.generate(document['id'], generated['document']['fields'], 2,
            str(uuid.uuid4()), self.company, options=next_options)
        self.assertEqual(text_pages(self.service.revision_pdf(document['id'], 2)),
                         ['NEW GLOBAL\n', 'CERTIFICATE BODY\n'])
        self.assertEqual(second['document']['options'], next_options)
        self.assertEqual(CertificationService(Store(self.store.path)).revision_pdf(document['id'], 1), first)

    def test_lost_creation_receipt_keeps_original_options_and_cannot_upgrade_version(self):
        create_request = str(uuid.uuid4()); original = options(scopes=['ductwork'])
        document = self.service.create(fields(project='Original'), create_request, options=original)
        changed = self.service.save(document['id'], document['fields'], 1,
                                    options=options(scopes=['service_penetrations']))
        self.assertEqual(self.service.create(document['fields'], create_request, options=original), document)
        with self.assertRaises(CertificationConflict):
            self.service.generate(document['id'], document['fields'], 1, str(uuid.uuid4()), self.company, options=original)
        with self.assertRaises(CertificationConflict):
            self.service.create(document['fields'], create_request, options=changed['options'])
        self.assertEqual(self.service.get(document['id']), changed)

    def test_parallel_generation_replay_freezes_one_options_snapshot(self):
        document = self.service.create(fields(project='Parallel')); gate = Barrier(2)
        selected = options('PARALLEL COVER', ['service_penetrations'])
        self.service.covers.save('certification', selected['cover_pdf'], selected['cover_pdf_name'], 1)
        def render(*args, **kwargs):
            gate.wait(timeout=10); return pdf('PARALLEL BODY')
        service = CertificationService(self.store, renderer=render); request = str(uuid.uuid4())
        def action(_):
            return service.generate(document['id'], document['fields'], 1, request, self.company, options=selected)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(action, range(2)))
        self.assertEqual(results[0]['revision'], results[1]['revision'])
        self.assertEqual(self.service.get(document['id'])['version'], 2)
        self.assertEqual(len(self.service.get(document['id'])['revisions']), 1)
        with self.assertRaises(CertificationConflict):
            self.service.generate(document['id'], document['fields'], 1, request, self.company,
                                  options=options(scopes=['ductwork']))
        self.assertEqual(text_pages(self.service.revision_pdf(document['id'], 1)),
                         ['GLOBAL\n', 'PARALLEL COVER\n', 'PARALLEL BODY\n'])

    def test_options_change_during_render_cannot_be_overwritten_or_publish_a_revision(self):
        document = self.service.create(fields(project='Race'), options=options(scopes=['ductwork']))
        newer = options(scopes=['service_penetrations'])
        def render(*args, **kwargs):
            self.service.save(document['id'], document['fields'], 1, options=newer)
            return pdf('MUST NOT BE SAVED')
        service = CertificationService(self.store, renderer=render)
        with self.assertRaises(CertificationConflict):
            service.generate(document['id'], document['fields'], 1, str(uuid.uuid4()), self.company,
                              options=document['options'])
        after = self.service.get(document['id'])
        self.assertEqual(after['options'], newer)
        self.assertEqual(after['version'], 2)
        self.assertEqual(after['revisions'], [])

    def test_signer_defaults_persist_with_cas_but_never_rewrite_documents_or_revisions(self):
        document = self.service.create(fields(name='Document signer'))
        self.service.generate(document['id'], document['fields'], 1, str(uuid.uuid4()), self.company)
        before = self.service.get(document['id']); frozen = self.service.revision_pdf(document['id'], 1)
        initial = self.service.get_defaults()
        self.assertEqual(initial, {'fields': dict.fromkeys(SIGNER_FIELDS, ''), 'version': 1, 'signature_image': None, 'signature_name': ''})
        entered = {'name': 'New signer', 'position': 'Installer', 'qualification': 'Entered qualification', 'accreditation': 'Entered accreditation'}
        saved = self.service.save_defaults(entered, 1)
        self.assertEqual(saved, {'fields': entered, 'version': 2, 'signature_image': None, 'signature_name': ''})
        self.assertEqual(self.service.save_defaults(entered, 1), saved)
        with self.assertRaises(CertificationConflict):
            self.service.save_defaults({**entered, 'name': 'Other window'}, 1)
        self.assertEqual(CertificationService(Store(self.store.path)).get_defaults(), saved)
        self.assertEqual(self.service.get(document['id']), before)
        self.assertEqual(self.service.revision_pdf(document['id'], 1), frozen)
        for bad in ({}, {**entered, 'client': 'Wrong field'}, {**entered, 'name': None}):
            with self.assertRaises(ValidationError): self.service.save_defaults(bad, 2)
        with self.assertRaises(ValidationError): self.service.save_defaults(entered, True)

    def test_parallel_default_edits_have_one_winner_and_do_not_change_document_versions(self):
        document = self.service.create(fields()); gate = Barrier(2)
        def save(name):
            gate.wait(timeout=10)
            try:
                return self.service.save_defaults({**dict.fromkeys(SIGNER_FIELDS, ''), 'name': name}, 1)
            except CertificationConflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(save, ['First', 'Second']))
        self.assertEqual(results.count('conflict'), 1)
        self.assertEqual(self.service.get_defaults()['version'], 2)
        self.assertEqual(self.service.get(document['id']), document)

    def test_additive_legacy_migration_preserves_old_pdfs_rows_and_idempotency_receipts(self):
        legacy = Store(Path(self.temp.name)/'legacy.sqlite3')
        document_id, create_id, generate_id = (str(uuid.uuid4()) for _ in range(3))
        original = fields(project='Legacy', name='Legacy signer', position='Entered position',
                          qualification='Entered qualification', accreditation='Entered accreditation')
        payload = pdf('LEGACY FROZEN PDF'); timestamp = '2026-10-29T00:00:00+00:00'
        encode = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        fingerprint = lambda value: sha256(encode(value).encode()).hexdigest()
        with legacy.connect() as db:
            db.executescript('''
              CREATE TABLE certification_documents(id TEXT PRIMARY KEY,fields TEXT NOT NULL,version INTEGER NOT NULL,
                created_at TEXT NOT NULL,updated_at TEXT NOT NULL,create_request_id TEXT UNIQUE,create_request_fingerprint TEXT);
              CREATE TABLE certification_revisions(document_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,
                fields TEXT NOT NULL,company TEXT NOT NULL,pdf BLOB NOT NULL,sha256 TEXT NOT NULL,
                request_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,PRIMARY KEY(document_id,revision),UNIQUE(document_id,request_id));
            ''')
            db.execute('INSERT INTO certification_documents VALUES(?,?,?,?,?,?,?)',
                       (document_id, encode(original), 2, timestamp, timestamp, create_id, fingerprint(original)))
            db.execute('INSERT INTO certification_documents VALUES(?,?,?,?,?,?,?)',
                       (str(uuid.uuid4()), encode(fields(name='Older signer')), 1,
                        '2026-10-28T00:00:00+00:00', '2026-10-28T00:00:00+00:00', None, None))
            db.execute('INSERT INTO certification_revisions VALUES(?,?,?,?,?,?,?,?,?)',
                       (document_id, 1, timestamp, encode(original), encode(DEFAULTS), payload,
                        sha256(payload).hexdigest(), generate_id, fingerprint({'fields': original, 'expected_version': 1})))
            before = db.execute('SELECT * FROM certification_revisions').fetchone()
        migrated = CertificationService(legacy)
        self.assertEqual(migrated.get_defaults(), {'fields': {key: original[key] for key in SIGNER_FIELDS}, 'version': 1, 'signature_image': None, 'signature_name': ''})
        self.assertEqual(migrated.get(document_id)['options'], DEFAULT_OPTIONS)
        self.assertEqual(migrated.revision_pdf(document_id, 1), payload)
        replay = migrated.generate(document_id, original, 1, generate_id, self.company)
        self.assertEqual(replay['revision']['revision'], 1)
        self.assertEqual(len(replay['document']['revisions']), 1)
        self.assertEqual(migrated.create(original, create_id)['version'], 1)
        with legacy.connect() as db:
            after = db.execute('SELECT document_id,revision,created_at,fields,company,pdf,sha256,request_id,request_fingerprint '
                               'FROM certification_revisions').fetchone()
            self.assertEqual(json.loads(db.execute('SELECT options FROM certification_revisions').fetchone()[0]), DEFAULT_OPTIONS)
        self.assertEqual(after, before)
        self.assertEqual(CertificationService(legacy).revision_pdf(document_id, 1), payload)
        # An intentional clear remains the defaults even after newer document
        # text is saved and the service is restarted.
        cleared = migrated.save_defaults(dict.fromkeys(SIGNER_FIELDS, ''), 1)
        migrated.save(document_id, {**original, 'name': 'Later document signer'}, 2)
        self.assertEqual(CertificationService(legacy).get_defaults(), cleared)


if __name__ == '__main__': unittest.main()
