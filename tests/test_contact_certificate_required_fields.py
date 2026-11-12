"""Explicit creation/issuance minima do not rewrite legacy directory or drafts."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import Mock

from reportlab.pdfgen.canvas import Canvas

from test_pdf_download_covers import signed_options
from estimator.catalog import ValidationError
from estimator.certification import CertificationService, FIELDS, REQUIRED_GENERATION_FIELDS
from estimator.company_settings import DEFAULTS
from estimator.contacts import ContactsStore, CONTACT_CREATION_REQUIRED_FIELDS
from estimator.storage import Store


class ContactCreationRequirementsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = ContactsStore(Path(self.directory.name) / 'contacts.sqlite3')
        self.fields = dict(name='New Person', phone='0400', company='New Company', email='new@example.test')

    def test_each_missing_field_rejects_before_any_contact_company_or_revision_write(self):
        before = self.store.list()
        for field in CONTACT_CREATION_REQUIRED_FIELDS:
            for blank in ('', ' \n\t', '\u200b\u2066\ufeff'):
                with self.subTest(field=field, blank=repr(blank)):
                    with self.assertRaises(ValidationError):
                        self.store.save('contacts', {'version': before['version'], 'fields': {**self.fields, field: blank}})
                    self.assertEqual(self.store.list(), before)
        saved = self.store.save('contacts', {'version': before['version'], 'fields': self.fields})
        self.assertEqual(saved['contact']['title'], '')
        self.assertEqual(len(self.store.list()['accounts']), 1)

    def test_sparse_import_reads_and_existing_edit_remain_compatible(self):
        self.store.import_rows('contacts', [(2, {'name': 'Legacy orphan'})], 0)
        before = self.store.list()
        person = before['contacts'][0]
        self.assertIsNone(person['account_id'])
        result = self.store.save('contacts', {'version': before['version'], 'id': person['id'],
            'fields': {'name': 'Edited legacy orphan'}})
        self.assertEqual(result['contact']['name'], 'Edited legacy orphan')
        self.assertEqual(result['contact']['phone'], '')
        self.assertEqual(self.store.list()['accounts'], [])


class CertificateGenerationRequirementsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / 'certificates.sqlite3')
        output = BytesIO(); canvas = Canvas(output); canvas.drawString(20, 20, 'Certificate'); canvas.save()
        self.renderer = Mock(return_value=output.getvalue())
        self.precommit = Mock()
        self.service = CertificationService(self.store, renderer=self.renderer, precommit=self.precommit)
        self.fields = {**dict.fromkeys(FIELDS, ''), **dict.fromkeys(REQUIRED_GENERATION_FIELDS, 'N/A')}

    def generate(self, document, fields, request_id=None):
        return self.service.generate(document['id'], fields, document['version'],
            request_id or str(uuid.uuid4()), deepcopy(DEFAULTS), options=signed_options())

    def test_generation_requires_signature_and_excludes_qualification_and_accreditation(self):
        document = self.service.create({})
        draft = self.service.save(document['id'], {**document['fields'], 'client': 'Draft'}, document['version'])
        self.assertEqual(draft['revisions'], [])
        self.precommit.reset_mock()
        for field in REQUIRED_GENERATION_FIELDS:
            for blank in ('', ' \n\t', '\u200b\u2066\ufeff'):
                with self.subTest(field=field, blank=repr(blank)):
                    with self.assertRaises(ValidationError):
                        self.generate(draft, {**self.fields, field: blank})
                    self.assertEqual(self.service.get(draft['id']), draft)
        self.renderer.assert_not_called(); self.precommit.assert_not_called()
        with self.assertRaisesRegex(ValidationError, 'signature'):
            self.service.generate(draft['id'], self.fields, draft['version'], str(uuid.uuid4()), DEFAULTS)
        result = self.generate(draft, self.fields)
        self.assertEqual(result['revision']['revision'], 1)
        self.assertEqual(result['document']['fields']['qualification'], '')
        self.assertEqual(result['document']['fields']['accreditation'], '')
        self.assertTrue(result['document']['options'].get('signature_image'))

    def test_zero_text_and_na_are_meaningful(self):
        document = self.service.create({})
        result = self.generate(document, {**self.fields, 'fire_resistance_level': '0'})
        self.assertEqual(result['document']['fields']['fire_resistance_level'], '0')


if __name__ == '__main__':
    unittest.main()
