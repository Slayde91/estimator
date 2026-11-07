"""Link ownership and PDF recovery across independent project workspaces."""
import json
import shutil
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
from estimator.commercial_sources import CommercialSources, source_id
from estimator.project_documentation import ProjectDocumentation
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.saved_commercial import SavedCommercial
from estimator.storage import Store
from test_certification import pdf


class SavedQuoteTests(unittest.TestCase):
    def test_existing_commercial_file_registry_moves_out_of_catalog(self):
        with tempfile.TemporaryDirectory() as folder:
            catalog = Store(Path(folder) / 'old.sqlite3')
            path = str(Path(folder) / 'original.cf.json')
            project = str(uuid.uuid4())
            identity = source_id(path)
            with catalog.connect() as db:
                db.execute('CREATE TABLE commercial_source_files(id,path,project,title,deleted)')
                db.execute('INSERT INTO commercial_source_files VALUES(?,?,?,?,0)', (identity, path, project, 'Original'))
                db.execute('CREATE TABLE commercial_source_aliases(alias,source_id)')
                db.execute('INSERT INTO commercial_source_aliases VALUES(?,?)', ('earlier-id', identity))
            registry = CommercialSources(catalog, None)
            self.assertEqual(registry.resolve('earlier-id'), (path, project))
            registry.delete(path)
            self.assertIsNone(CommercialSources(catalog, None).resolve(identity))
            with catalog.connect() as db:
                self.assertEqual(db.execute('SELECT deleted FROM commercial_source_files').fetchone(), (0,))

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
        result = self.library.commercial_register()
        while result['scan_pending']:
            result = self.library.commercial_register()
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

    def test_fresh_register_and_purchase_status_use_the_owning_file(self):
        original = self.path.read_bytes()
        snapshot = json.loads(original)
        purchase = {**self.document, 'id': str(uuid.uuid4()), 'kind':'purchase_order', 'status':'Requested',
                    'fields': default_fields('purchase_order')}
        purchase['fields']['order'].update(supplier='Fixture Materials', supplier_contact='Morgan')
        purchase['fields']['lines'] = [{'description':'Collars', 'quantity':'3', 'unit_price':'25.50',
                                        'estimate_id':'', 'size':'', 'comments':''}]
        snapshot['commercial_documents']['documents'].append(purchase)
        other = self.folder / 'other.cf.json'
        other.write_text(json.dumps(snapshot), encoding='utf8')
        self.library.commercial_register(refresh=True)
        card = next(c for c in self.register()['documents'] if c['kind']=='purchase_order')
        self.assertEqual((card['grand_total'], card['fields']['order']['supplier_contact']),('84.15','Morgan'))
        self.assertRegex(card['reference'],r'^PO-\d{2,}$')
        source = {'file_id':card['source_file'], 'revision':card['source_revision']}
        changed = self.saved.perform('status', {'source':source,'id':purchase['id'],'version':1,'status':'Sent'},self.http.execute)
        self.assertNotEqual(changed['revision'], source['revision'])
        self.assertEqual(self.path.read_bytes(), original)
        written = json.loads(other.read_bytes())['commercial_documents']['documents']
        self.assertEqual(next(d for d in written if d['id']==purchase['id'])['status'],'Sent')
        with self.assertRaises(CommercialConflict):
            self.saved.perform('open',{'source':source,'id':purchase['id']},self.http.execute)

    def test_file_conflict_keeps_external_edits_and_malformed_inputs_do_not_mutate(self):
        original = self.path.read_bytes()
        with self.assertRaises(ValidationError):
            self.perform('save', kind='quote', fields={'details': []})
        self.assertEqual(self.path.read_bytes(), original)
        self.path.write_bytes(original + b'\n')
        with self.assertRaises(CommercialConflict):
            self.perform('delete', id=self.document['id'], version=1)
        self.assertEqual(self.path.read_bytes(), original + b'\n')

    def test_native_open_registers_only_the_selected_source_across_restart(self):
        elsewhere = self.root / 'other-folder'
        elsewhere.mkdir()
        selected = elsewhere / 'opened.cf.json'
        unselected = elsewhere / 'private.cf.json'
        original = self.path.read_bytes()
        selected.write_bytes(original)
        unselected.write_bytes(original)
        shutil.copytree(self.folder / '.ceasefire-evidence', elsewhere / '.ceasefire-evidence')
        self.library.dialogs = type('NativePicker', (), {'choose_open': lambda _, folder: str(selected)})()
        self.library.open_file()
        restarted = ProjectLibrary(self.store, certifications=self.library.certifications, documentation=self.library.documentation)
        restarted.commercial = self.library.commercial
        self.addCleanup(restarted.close)
        register = restarted.commercial_register(refresh=True)
        while register['scan_pending']:
            register = restarted.commercial_register()
        self.assertEqual({row['source_path'] for row in register['documents']}, {str(self.path), str(selected)})
        card = next(row for row in register['documents'] if row['source_path'] == str(selected))
        self.assertNotEqual(card['source_file'], self.card['source_file'])
        selection = {'file_id': card['source_file'], 'revision': card['source_revision']}
        SavedCommercial(restarted).perform('status', {'source':selection,'id':card['id'],'version':1,'status':'Review'}, self.http.execute)
        self.assertEqual(json.loads(selected.read_bytes())['commercial_documents']['documents'][0]['status'],'Review')
        self.assertEqual(self.path.read_bytes(),original)
        self.assertEqual(unselected.read_bytes(),original)
        with self.assertRaises(ValidationError):
            SavedCommercial(restarted).perform('open',{'source':{**selection,'file_id':str(unselected)},'id':card['id']},self.http.execute)

    def test_relink_retains_owners_and_missing_files_never_recreate_drafts(self):
        empty = self.root / 'another-linked-folder'
        empty.mkdir()
        self.store.set_project_folder(empty)
        self.assertEqual([doc['source_path'] for doc in self.register()['documents']], [str(self.path)])
        renamed = self.root / 'moved.cf.json'
        self.path.rename(renamed)
        shutil.copytree(self.folder / '.ceasefire-evidence', self.root / '.ceasefire-evidence')
        missing = self.register()
        self.assertEqual(missing['documents'],[])
        self.assertEqual([item['path'] for item in missing['unavailable_sources']],[str(self.path)])
        self.library.dialogs = type('NativePicker', (), {'choose_open': lambda _, folder: str(renamed)})()
        self.library.open_file()
        restored = self.register()
        self.assertEqual([doc['source_path'] for doc in restored['documents']],[str(renamed)])
        self.assertEqual(restored['unavailable_sources'],[])

    def test_registered_path_replacement_is_not_granted_its_old_owner(self):
        outside = self.root/'empty'
        outside.mkdir()
        self.store.set_project_folder(outside)
        snapshot = json.loads(self.path.read_bytes())
        changed_id = str(uuid.uuid4())
        snapshot['certifications']['project_id'] = snapshot['commercial_documents']['project_id'] = changed_id
        self.path.write_text(json.dumps(snapshot),encoding='utf8')
        self.assertEqual(self.register()['documents'],[])
        from hashlib import sha256
        with self.assertRaises(CommercialConflict):
            self.saved.perform('open',{'source':{**self.source,'revision':sha256(self.path.read_bytes()).hexdigest()},'id':self.document['id']},self.http.execute)

    def test_stale_sqlite_drafts_do_not_become_board_cards_after_deletion(self):
        # The session still contains the earlier draft, but the authoritative
        # saved file now has an empty commercial manifest.
        snapshot = json.loads(self.path.read_bytes())
        snapshot['commercial_documents']['documents'] = []
        self.path.write_text(json.dumps(snapshot), encoding='utf8')
        result = self.library.commercial_register(refresh=True)
        while result['scan_pending']:
            result = self.library.commercial_register()
        self.assertEqual(result['documents'],[])
        self.assertEqual(result['unavailable_sources'],[])

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
