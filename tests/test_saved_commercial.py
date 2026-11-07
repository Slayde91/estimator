"""Link ownership and PDF recovery across independent project workspaces."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from estimator.catalog import ValidationError
from estimator.certification import CertificationService
from estimator.certification_projects import CertificationProjects
from estimator.commercial_documents import CommercialConflict, CommercialDocuments, default_fields
from estimator.commercial_http import CommercialHTTP
from estimator.project_documentation import ProjectDocumentation
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.saved_commercial import SavedCommercial
from estimator.storage import Store
from test_certification import pdf


class SavedQuoteTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.folder = self.root / 'projects'
        self.folder.mkdir()
        self.store = Store(self.root / 'runtime' / 'store.sqlite3')
        self.store.set_project_folder(self.folder)
        certs = CertificationProjects(CertificationService(self.store))
        docs = ProjectDocumentation(certs, kinds={'commercial.quote': 'Quote'})
        self.library = ProjectLibrary(self.store, certifications=certs, documentation=docs)
        self.addCleanup(self.library.close)
        self.library.commercial = CommercialDocuments(certs, renderer=lambda *args, **kwargs: pdf('Saved scope'))
        workspace = certs.new()['workspace_id']
        self.document = self.library.commercial.save(workspace, {'kind': 'quote', 'status': 'Draft', 'fields': default_fields('quote')})
        self.path = self.folder / 'saved.cf.json'
        certificates = certs.capture({'workspace_id': workspace, 'draft': None})
        certs.publish(certificates, self.path)
        self.path.write_bytes(export_project(self.store, {'estimate': {'title': 'Fixture', 'client': 'Fixture Company'},
            'certifications': certificates, 'commercial_documents': self.library.commercial.capture(workspace)}))
        self.saved = SavedCommercial(self.library)
        self.http = CommercialHTTP(self.library.commercial, derive=lambda *_args, **_kwargs: {'lines': [], 'sources': [], 'scope_tables': []})
        register = self.register()
        self.card = register['documents'][0]
        self.source = {'file_id': self.card['source_file'], 'revision': self.card['source_revision']}

    def register(self):
        result = self.library.quote_register()
        while result['scan_pending']:
            result = self.library.quote_register()
        return result

    def perform(self, action, **body):
        return self.saved.perform(action, {'source': self.source, **body}, self.http.execute)

    def test_malformed_project_cannot_break_other_cards(self):
        snapshot = json.loads(self.path.read_bytes())
        snapshot['commercial_documents']['documents'][0]['fields']['details'] = None
        (self.folder / 'broken.cf.json').write_text(json.dumps(snapshot), encoding='utf8')
        self.library.listing(refresh=True)
        result = self.register()
        self.assertEqual(result['error_count'], 1)
        self.assertEqual([card['id'] for card in result['documents']], [self.document['id']])

    def test_file_conflict_keeps_external_edits_and_malformed_inputs_do_not_mutate(self):
        original = self.path.read_bytes()
        with self.assertRaises(ValidationError):
            self.perform('save', kind='quote', fields={'details': []})
        self.assertEqual(self.path.read_bytes(), original)
        self.path.write_bytes(original + b'\n')
        with self.assertRaises(CommercialConflict):
            self.perform('delete', id=self.document['id'], version=1)
        self.assertEqual(self.path.read_bytes(), original + b'\n')

    def test_retry_after_each_file_boundary_reuses_the_number_and_pdf(self):
        args = {'id': self.document['id'], 'version': 1, 'kind': 'quote', 'request_id': str(uuid.uuid4())}
        original = self.path.read_bytes()
        with patch('estimator.project_library._atomic_write', side_effect=ValidationError('Disk full')):
            with self.assertRaisesRegex(ValidationError, 'Disk full'):
                self.perform('issue', **args)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.folder.glob('*.pdf')), [])
        # Retrying from the original file after a process restart restores the
        # committed SQLite issue receipt into a fresh certificate workspace.
        self.saved = SavedCommercial(self.library)
        with patch.object(self.library, 'write_download', side_effect=ValidationError('Destination locked')):
            with self.assertRaisesRegex(ValidationError, 'Destination locked'):
                self.perform('issue', **args)
        committed = json.loads(self.path.read_bytes())
        self.assertEqual(committed['commercial_documents']['documents'][0]['last_number'], 'Q-000001')
        self.assertEqual(committed['documentation']['revision_count'], 1)
        self.assertEqual(list(self.folder.glob('*.pdf')), [])
        self.saved = SavedCommercial(self.library)
        result = self.perform('issue', **args)
        self.assertEqual(result['result']['document']['last_number'], 'Q-000001')
        self.assertEqual(result['result']['document']['version'], 2)
        self.assertTrue(Path(result['result']['path']).read_bytes().startswith(b'%PDF-'))
        self.assertEqual(json.loads(self.path.read_bytes()), committed)
        opened = self.library.load(self.source['file_id'])
        restored = self.library.commercial.view(opened['certification_workspace_id'])
        self.assertEqual(restored['documents'], committed['commercial_documents']['documents'])
        with self.assertRaises(ValidationError):
            self.perform('issue', **{**args, 'version': 2})
