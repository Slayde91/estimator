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
from tests.commercial_ready_fixtures import complete_quote, complete_work_order, INK
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
        self.document = self.library.commercial.save(workspace, {'kind': 'quote', 'status': 'Draft', 'fields': complete_quote(default_fields('quote'))})
        self.path = self.folder / 'saved.cf.json'
        certificates = certs.capture({'workspace_id': workspace, 'draft': None})
        certs.publish(certificates, self.path)
        self.path.write_bytes(export_project(self.store, {'estimate': {'title': 'Fixture', 'project_no':'PN-01', 'client': 'Fixture Company',
            'site_address':'Fixture site','contact_name':'Fixture Contact','contact_phone':'0400 000 000','contact_email':'fixture@example.test'},
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

    def test_account_links_follow_saved_file_identity_without_rewriting_documents(self):
        from estimator.account_relations import AccountRelations
        from estimator.contacts import ContactsStore, LINK_KINDS
        contacts = ContactsStore(self.root / 'contacts.sqlite3')
        account = contacts.save('accounts', {'version': 0, 'fields': {'company': 'Fixture Company'}})
        relations = AccountRelations(contacts, self.library)
        catalog = relations.view(account['id'])
        self.assertEqual(len(catalog['linked']['projects']), 1)
        self.assertEqual(len(catalog['linked']['quotes']), 1)
        self.assertTrue(catalog['linked']['projects'][0]['automatic'])
        self.assertTrue(catalog['linked']['quotes'][0]['automatic'])
        self.assertNotEqual(catalog['linked']['projects'][0]['id'], self.card['project_id'])
        self.assertEqual(catalog['linked']['quotes'][0]['id'], self.card['project_id'] + ':' + self.card['id'])
        before = self.path.read_bytes()
        contacts.save('accounts', {'id': account['id'], 'version': 1, 'fields': {'company': 'Fixture Company', 'abn_acn': 'ABN 123'},
                                  'links': {kind: [entry['id'] for entry in catalog['linked'][kind]] for kind in LINK_KINDS}},
                      link_catalog=catalog)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(contacts.saved_links(account['id']))

    def test_fresh_register_and_purchase_status_use_the_owning_file(self):
        original = self.path.read_bytes()
        snapshot = json.loads(original)
        purchase = {**self.document, 'id': str(uuid.uuid4()), 'kind':'purchase_order', 'status':'Requested',
                    'fields': default_fields('purchase_order')}
        purchase.pop('reference')  # An old unnumbered PO has no Quote reference.
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

    def test_signing_saved_purchase_order_updates_the_owner_file_and_rejects_stale_source(self):
        snapshot = json.loads(self.path.read_bytes())
        purchase = {**self.document, 'id': str(uuid.uuid4()), 'kind': 'purchase_order',
                    'status': 'Draft', 'fields': default_fields('purchase_order')}
        purchase.pop('reference')
        snapshot['commercial_documents']['documents'].append(purchase)
        self.path.write_text(json.dumps(snapshot), encoding='utf8')
        self.library.commercial_register(refresh=True)
        card = next(row for row in self.register()['documents'] if row['id'] == purchase['id'])
        source = {'file_id': card['source_file'], 'revision': card['source_revision']}
        fields = self.saved.perform('open', {'source': source, 'id': purchase['id']}, self.http.execute)['document']['fields']
        fields['order'].update(requested_by='Purchaser', requested_date='2026-11-12')
        fields['signatures'] = {'requested_by': INK}
        body = {'source': source, 'id': purchase['id'], 'version': 1, 'kind': 'purchase_order', 'status': 'Draft',
                'fields': fields, 'signature_actions': [{'key': 'requested_by', 'name': 'Purchaser',
                                                       'date': '2026-11-12', 'signature': INK}]}
        result = self.saved.perform('save', dict(body), self.http.execute)
        contents = self.path.read_bytes()
        stored = next(row for row in json.loads(contents)['commercial_documents']['documents'] if row['id'] == purchase['id'])
        self.assertEqual((stored['status'], stored['version'], stored['fields']['signatures']), ('Requested', 2, {'requested_by': INK}))
        self.assertEqual(result['result']['status'], stored['status'])
        activity = self.saved.activity(source['file_id'], result['revision'], purchase['id'])['events']
        self.assertEqual([item['label'] for item in activity], ['Signatures updated','Stage changed','Created'])
        self.assertEqual((activity[1]['previous_status'],activity[1]['status']), ('Draft','Requested'))
        with self.assertRaises(CommercialConflict):
            self.saved.activity(source['file_id'], source['revision'], purchase['id'])
        with self.assertRaises(CommercialConflict):
            self.saved.perform('save', dict(body), self.http.execute)
        self.assertEqual(self.path.read_bytes(), contents)

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

    def test_ignored_sources_are_persistent_and_never_read_again(self):
        self.perform('issue', id=self.document['id'], version=1, kind='quote', request_id=str(uuid.uuid4()))
        with self.library.commercial._connect() as db:
            issued_history = [tuple(row) for row in db.execute('SELECT * FROM commercial_issued ORDER BY id')]
        self.assertTrue(issued_history)
        empty = self.root / 'empty-linked-folder'
        empty.mkdir()
        self.store.set_project_folder(empty)
        self.path.unlink()
        # Metadata and ignoring must work without probing the source path.
        with patch.object(self.library, '_other_commercial_file', side_effect=AssertionError('Source must not be read')):
            metadata = self.library.commercial_source_metadata()['sources']
            self.assertEqual(len(metadata), 1)
            token = metadata[0]['id']
            self.assertFalse(metadata[0]['ignored'])
            self.library.ignore_commercial_source(token)
            self.assertEqual(self.register()['unavailable_sources'], [])
            self.assertEqual(self.register()['documents'], [])
            from estimator.account_relations import AccountRelations
            from estimator.contacts import ContactsStore
            links = AccountRelations(ContactsStore(self.root / 'contacts.sqlite3'), self.library).view()
            self.assertFalse(links['choices']['projects'])
            self.assertFalse(links['choices']['quotes'])
            self.assertEqual(links['error_count'], 0)
        self.assertTrue(self.library.commercial_source_metadata()['sources'][0]['ignored'])
        owner = self.library._commercial_sources.records()[0][2]
        self.assertIn(owner, CommercialSources(self.store, None).ignored_owners())
        # An older unfiled workspace can share an ignored saved owner's ID.
        # Keep its cards out of both the boards and the directory register.
        local = self.library.certifications.new()['workspace_id']
        pending = self.library.commercial.save(local, {'kind':'purchase_order', 'status':'Draft',
            'fields':default_fields('purchase_order')}, unfiled_context={})
        visible, = self.library.commercial.unfiled.cards(None)
        ignored_copy = {**visible, 'project_id':owner, 'id':str(uuid.uuid4())}
        with patch.object(self.library.commercial.unfiled, 'cards', return_value=[ignored_copy, visible]):
            self.assertEqual([card['id'] for card in self.register()['documents']], [pending['id']])
        with self.library.commercial._connect() as db:
            self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM commercial_issued ORDER BY id')], issued_history)
        callbacks = []
        with patch.object(self.library.commercial.unfiled, 'recover_publications', side_effect=lambda verify: callbacks.append(verify({'project_id': owner}))), \
             patch('estimator.project_library._read_file', side_effect=AssertionError('Ignored recovery must not read')):
            self.library.recover_commercial_publications()
        self.assertEqual(callbacks, [False])
        with self.assertRaises(ValidationError):
            self.library.ignore_commercial_source('unknown')
        self.library.ignore_commercial_source(token, ignored=False)
        self.assertNotIn(owner, CommercialSources(self.store, None).ignored_owners())

    def test_source_ignore_http_requires_current_workspace_and_exact_payload(self):
        adapter = CommercialHTTP(self.library.commercial, saved=self.saved)
        workspace = self.library.certifications.new()['workspace_id']
        token = self.library.commercial_source_metadata()['sources'][0]['id']

        class Handler:
            headers = {}
            command = 'POST'
            path = '/api/commercial/ignore-source'
            def read_json(self): return self.body
            def send_payload(self, status, value): self.result = status, value

        handler = Handler()
        handler.body = {'workspace_id': workspace, 'id': token}
        with patch.object(self.library, '_other_commercial_file', side_effect=AssertionError('No project reads')):
            adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result, (200, {'ignored': True, 'id': token}))
        handler.body = {'workspace_id': str(uuid.uuid4()), 'id': token}
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 400)
        handler.body = {'workspace_id': workspace, 'id': token, 'path': str(self.path)}
        adapter.dispatch(handler, handler.path)
        self.assertEqual(handler.result[0], 400)

    def test_restart_keeps_saved_board_readable_and_expired_project_private(self):
        old = self.library.certifications.new()['workspace_id']
        before = self.path.read_bytes()
        certs = CertificationProjects(CertificationService(self.store))
        restarted = ProjectLibrary(self.store, certifications=certs)
        self.addCleanup(restarted.close)
        restarted.commercial = CommercialDocuments(certs)
        adapter = CommercialHTTP(restarted.commercial, saved=SavedCommercial(restarted))

        class Handler:
            command = 'GET'
            headers = {}
            def send_payload(self, status, value): self.result = status, value

        handler = Handler()
        def get(route, query=''):
            handler.path = '/api/commercial/' + route + query
            self.assertTrue(adapter.dispatch(handler, '/api/commercial/' + route))
            return handler.result

        for route in ('state', 'snapshot', 'register'):
            status, error = get(route, '?workspace=' + old)
            self.assertEqual(status, 400)
            self.assertEqual(error['code'], 'project_workspace_unavailable')
            self.assertNotIn('certificate', error['error'].lower())
        for route, query in [('state', ''), ('register', '?workspace=invalid'), ('register', '?refresh=0')]:
            status, error = get(route, query)
            self.assertEqual(status, 400)
            self.assertNotIn('code', error)

        status, register = get('register', '?refresh=1')
        while status == 200 and register['scan_pending']:
            status, register = get('register')
        self.assertEqual(status, 200)
        self.assertEqual(set(register['statuses']), {'quote', 'work_order', 'purchase_order'})
        card, = register['documents']
        self.assertEqual((card['id'], card['source_file'], card['source_revision']),
                         (self.document['id'], self.source['file_id'], self.source['revision']))
        self.assertNotIn('snapshot', register)
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaisesRegex(ValidationError, 'certificate workspace is unavailable'):
            certs.view(old)

    def test_ignoring_one_source_keeps_other_missing_sources_visible(self):
        empty = self.root / 'empty-linked-folder'
        empty.mkdir()
        self.store.set_project_folder(empty)
        missing = str(self.root / 'another.cf.json')
        other_owner = str(uuid.uuid4())
        self.library._commercial_sources.remember([{'path': missing, 'source_project_id': other_owner, 'title': 'Another project'}])
        self.path.unlink()
        owner = next(row[2] for row in self.library._commercial_sources.records() if row[1] == str(self.path))
        token = self.library._commercial_source_token(owner)
        self.library.ignore_commercial_source(token)
        notices = self.register()['unavailable_sources']
        self.assertEqual([item['title'] for item in notices], ['Another project'])

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

    def test_legacy_explicitly_saved_unfiled_documents_survive_restart_with_their_estimates(self):
        original = self.library.commercial
        workspace = original.certifications.new()['workspace_id']
        held = {'id':'steel', 'name':'Steel allowance', 'workspace':{'estimate':{'project_no':'T-1',
                'client':'Held client', 'site_address':'Held site','contact_name':'Held Contact',
                'contact_phone':'0400 000 000','contact_email':'held@example.test'}, 'takeoffs_session_id':'never expose'}}
        # These records predate the Project creation requirement. Seed their
        # historical service representation; new HTTP creation is now rejected.
        from estimator.unfiled_commercial import quote_context
        quote = original.save(workspace, {'kind':'quote', 'status':'Draft',
            'fields':complete_quote(default_fields('quote', held['workspace']['estimate']))},
            unfiled_context=quote_context({'estimates':[held], 'active_estimate_id':'steel'}))
        transient = original.save(workspace, {'kind':'purchase_order','status':'Draft','fields':default_fields('purchase_order')})
        purchase = original.save(workspace, {'kind':'purchase_order','status':'Draft',
                                            'fields':default_fields('purchase_order')}, unfiled_context={})
        with original._connect() as db:
            db.execute("UPDATE commercial_drafts SET data=json_set(data,'$.status','Verified') WHERE workspace=? AND id=?",
                       (workspace, purchase['id']))
        original.certifications.discard(workspace)
        certs = CertificationProjects(CertificationService(self.store))
        service = CommercialDocuments(certs, renderer=lambda *args, **kwargs: pdf('Local'))
        restarted = ProjectLibrary(self.store, certifications=certs)
        self.addCleanup(restarted.close)
        restarted.commercial = service
        from estimator.document_numbers import migrate_saved_orders
        migration = migrate_saved_orders(restarted)
        self.assertEqual((migration['errors'], migration['updated_files']), ([], 0))
        saved = SavedCommercial(restarted)
        seen = []
        def derive(body, **_):
            seen.append(body['estimates'])
            return {'lines':[], 'sources':[], 'scope_tables':[]}
        execute = CommercialHTTP(service, derive=derive).execute
        result = restarted.commercial_register(active_workspace=certs.new()['workspace_id'])
        cards = {c['id']:c for c in result['documents'] if c['source_path'] is None}
        self.assertEqual(set(cards), {quote['id'], purchase['id']})
        self.assertFalse(any(c['current_workspace'] for c in cards.values()))
        source = {'file_id':cards[quote['id']]['source_file'], 'revision':cards[quote['id']]['source_revision']}
        def act(action, **fields):
            return saved.perform(action, {'source':source, **fields}, execute)
        self.assertEqual(cards[purchase['id']]['status'], 'Completed')
        self.assertEqual(act('open', id=purchase['id'])['document']['status'], 'Completed')
        opened = act('open', id=quote['id'])
        self.assertEqual(opened['estimates'], [{'id':'steel','name':'Steel allowance'}])
        self.assertEqual(opened['details']['client'], 'Held client')
        with self.assertRaises(CommercialConflict):
            act('open', id=transient['id'])
        with self.assertRaises(ValidationError):
            act('issue', id=quote['id'])
        fields = opened['document']['fields']
        fields.update(title='Edited elsewhere')
        fields['details']['client'] = 'Other active project'
        updated = act('save', kind='quote', version=1, id=quote['id'], status='Review', fields=fields)
        self.assertEqual(updated['result']['fields']['details']['client'], 'Held client')
        self.assertEqual(seen[-1][0]['workspace'], {'estimate':held['workspace']['estimate']})
        with self.assertRaises(CommercialConflict):
            act('status', id=quote['id'], version=1, status='Lost')
        source['revision'] = updated['revision']
        moved = act('status', id=purchase['id'], version=1, status='Requested')
        source['revision'] = moved['revision']
        act('delete', id=purchase['id'], version=2)
        cards = restarted.commercial_register()['documents']
        self.assertNotIn(purchase['id'], {c['id'] for c in cards})
        self.assertEqual([c['fields']['title'] for c in cards if c['id']==quote['id']], ['Edited elsewhere'])

    def test_first_file_write_rechecks_unfiled_versions_and_closes_old_capabilities(self):
        from estimator.native_dialogs import SaveSelection
        service = self.library.commercial
        workspace = service.certifications.new()['workspace_id']
        # A portable, issued Quote may be present before this workspace's first native Save.
        quote = service.save(workspace, {'kind':'quote','status':'Draft','fields':complete_quote(default_fields('quote', {'project_no':'PN-00007'}))}, unfiled_context={})
        quote = service.issue(workspace,quote['id'],quote['version'],str(uuid.uuid4()))['document']
        fields = complete_work_order(default_fields('work_order', {'project_no':'PN-00007'}), 'Review')
        fields['order']['quote_id'] = quote['id']
        work = service.save(workspace, {'kind':'work_order','status':'Draft','fields':fields}, unfiled_context={})
        captured = service.capture(workspace)
        card = next(c for c in self.register()['documents'] if c['id']==work['id'])
        source = {'file_id':card['source_file'],'revision':card['source_revision']}
        moved = self.saved.perform('status',{'source':source,'id':work['id'],'version':1,'status':'Review'},self.http.execute)
        source['revision'] = moved['revision']
        with self.assertRaises(CommercialConflict), service.publishing(workspace,captured):
            self.fail('The stale file image was published')
        selected = self.folder / 'first-save.cf.json'
        self.library.dialogs = type('SavePicker', (), {'choose_save':lambda *_:SaveSelection(str(selected),None)})()
        request = {'estimate':{'project_no':'PN-00007','client':'Local owner','site_address':'Local owner site',
                   'contact_name':'Local Contact','contact_phone':'0400 000 000','contact_email':'local@example.test'}, 'certifications':{'workspace_id':workspace,'draft':None},
                   'commercial_documents':service.capture(workspace)}
        with patch('estimator.project_library._atomic_write', side_effect=ValidationError('Disk full')):
            with self.assertRaisesRegex(ValidationError, 'Disk full'):
                self.library.save_as(request)
        self.assertEqual(self.saved.perform('open', {'source':source,'id':work['id']}, self.http.execute)['document']['status'],'Review')
        self.library.save_as(request)
        self.assertEqual([c['source_path'] for c in self.register()['documents'] if c['id']==work['id']],[str(selected)])
        with self.assertRaises(CommercialConflict):
            self.saved.perform('delete',{'source':source,'id':work['id'],'version':2},self.http.execute)
        with self.assertRaises(CommercialConflict):
            service.save(workspace, {'kind':'purchase_order','status':'Draft','fields':default_fields('purchase_order')}, unfiled_context={})

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
        self.assertEqual(committed['commercial_documents']['documents'][0]['last_number'], 'Q-01')
        self.assertEqual(committed['documentation']['revision_count'], 1)
        self.assertEqual(list(self.folder.glob('*.pdf')), [])
        self.saved = SavedCommercial(self.library)
        result = self.perform('issue', **args)
        self.assertEqual(result['result']['document']['last_number'], 'Q-01')
        self.assertEqual(result['result']['document']['version'], 2)
        self.assertTrue(Path(result['result']['path']).read_bytes().startswith(b'%PDF-'))
        self.assertEqual(json.loads(self.path.read_bytes()), committed)
        opened = self.library.load(self.source['file_id'])
        restored = self.library.commercial.view(opened['certification_workspace_id'])
        self.assertEqual(restored['documents'], committed['commercial_documents']['documents'])
        with self.assertRaises(ValidationError):
            self.perform('issue', **{**args, 'version': 2})
