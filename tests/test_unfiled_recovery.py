"""First filing of a locally saved document survives process loss around rename."""
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from estimator.certification import CertificationService
from estimator.certification_projects import CertificationProjects
from estimator.commercial_documents import CommercialConflict, CommercialDocuments, default_fields
from estimator.commercial_http import CommercialHTTP
from estimator.native_dialogs import SaveSelection
from estimator.project_details import ProjectDetails
from estimator.project_library import ProjectLibrary, _atomic_write
from estimator.saved_commercial import SavedCommercial
from estimator.storage import Store


def library_at(root):
    store = Store(root / 'state' / 'store.sqlite3')
    certs = CertificationProjects(CertificationService(store))
    numbers = ProjectDetails(root / 'state' / 'numbers.sqlite3')
    lib = ProjectLibrary(store, certifications=certs, project_details=numbers)
    lib.commercial = CommercialDocuments(certs)
    return lib


def register(lib):
    result = lib.commercial_register(refresh=True)
    for _ in range(10):
        if not result['scan_pending']:
            return result['documents']
        result = lib.commercial_register()
    raise AssertionError('Small fixture register never finished scanning')


def interrupt_first_save(root, after_replace, ready, proceed):
    root = Path(root)
    linked = root / 'linked'
    linked.mkdir()
    target = root / 'outside.cf.json'
    lib = library_at(root)
    lib.store.set_project_folder(linked)
    lib.dialogs = type('Picker', (), {'choose_save': lambda *_: SaveSelection(str(target), None)})()
    workspace = lib.certifications.new()['workspace_id']
    doc = lib.commercial.save(workspace, {'kind': 'quote', 'status': 'Draft',
                              'fields': default_fields('quote')}, unfiled_context={})
    card, = register(lib)
    (root / 'original-card.json').write_text(json.dumps({
        'source': {'file_id': card['source_file'], 'revision': card['source_revision']},
        'id': doc['id'], 'version': doc['version'], 'status': 'Review',
    }), encoding='utf-8')

    ready.set()
    if not proceed.wait(60):
        raise RuntimeError('Fixture did not release first save')

    def interrupted_write(selection, payload):
        if after_replace:
            _atomic_write(selection, payload)
        os._exit(73)  # Power loss: no application finally blocks or cleanup callbacks.

    with patch('estimator.project_library._atomic_write', interrupted_write):
        lib.save_as({'project_save_request': str(uuid.uuid4()), 'estimate': {'client': 'Fixture'},
                     'certifications': {'workspace_id': workspace, 'draft': None},
                     'commercial_documents': lib.commercial.capture(workspace)})


class UnfiledRecoveryTests(unittest.TestCase):
    def staged(self, after_replace):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        context = multiprocessing.get_context('spawn')
        ready, proceed = context.Event(), context.Event()
        child = context.Process(target=interrupt_first_save, args=(str(root), after_replace, ready, proceed))
        child.start()
        def clean_child():
            if child.is_alive():
                child.kill()
                child.join()
            child.close()
        self.addCleanup(clean_child)
        self.assertTrue(ready.wait(60), 'Fixture failed to create the unfiled document')
        def publish():
            proceed.set()
            child.join(60)
            self.assertEqual(child.exitcode, 73, 'Fixture must reach the intended publication boundary')
        return root, publish

    def reopen(self, root):
        lib = library_at(root)
        self.addCleanup(lib.project_details.close)
        self.addCleanup(lib.close)
        card = json.loads((root / 'original-card.json').read_text(encoding='utf-8'))
        return lib, card, root / 'outside.cf.json'

    def interrupted(self, after_replace):
        root, publish = self.staged(after_replace)
        publish()
        return self.reopen(root)

    def test_exit_after_replace_files_once_and_rejects_old_card_before_first_board_read(self):
        lib, card, path = self.interrupted(True)
        digest = hashlib.sha256(path.read_bytes()).digest()
        with self.assertRaises(CommercialConflict):
            SavedCommercial(lib).perform('status', card, CommercialHTTP(lib.commercial).execute)
        filed, = register(lib)
        self.assertEqual((filed['id'], filed['source_path'], filed['status']),
                         (card['id'], str(path), 'Draft'))
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), digest)

    def test_local_edit_checked_before_rename_cannot_succeed_after_interrupted_takeover(self):
        root, publish = self.staged(True)
        lib, card, path = self.reopen(root)
        def resume_edit(action, body):
            # The board checked this capability; the owner now files in a
            # different process, which exits before closing the local owner.
            publish()
            return CommercialHTTP(lib.commercial).execute(action, body)
        with self.assertRaises(CommercialConflict):
            SavedCommercial(lib).perform('status', card, resume_edit)
        filed, = register(lib)
        self.assertEqual((filed['source_path'], filed['status']), (str(path), 'Draft'))

    def test_transient_read_failure_after_replace_cannot_drop_an_acknowledged_edit(self):
        lib, card, path = self.interrupted(True)
        native_open = os.open
        def locked(name, *args, **kwargs):
            if Path(name) == path:
                raise PermissionError('File is temporarily unavailable')
            return native_open(name, *args, **kwargs)
        with patch('estimator.project_library.os.open', side_effect=locked):
            with self.assertRaises(CommercialConflict):
                SavedCommercial(lib).perform('status', card, CommercialHTTP(lib.commercial).execute)
        filed, = register(lib)
        self.assertEqual((filed['source_path'], filed['status']), (str(path), 'Draft'))

    def test_exit_before_replace_retains_original_local_card_and_edits(self):
        lib, card, path = self.interrupted(False)
        self.assertFalse(path.exists())
        edited = SavedCommercial(lib).perform('status', card, CommercialHTTP(lib.commercial).execute)
        self.assertEqual(edited['result']['status'], 'Review')
        local, = register(lib)
        self.assertEqual((local['id'], local['source_path'], local['status']),
                         (card['id'], None, 'Review'))
