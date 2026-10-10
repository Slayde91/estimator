"""A real saved PDF companion, local review receipts and calculator transfers."""

from copy import deepcopy
from contextlib import ExitStack
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from reportlab.pdfgen import canvas

from estimator.catalog import ValidationError
from estimator.native_dialogs import SaveSelection
from estimator.project_file import export_project
from estimator.project_library import ProjectLibrary
from estimator.storage import Store
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_workspace import TakeoffService


class Dialogs:
    selection = None
    opened = None
    def choose_save(self, directory, filename):
        return self.selection
    def choose_open(self, directory):
        return self.opened


class TakeoffReceiptIntegrationTests(unittest.TestCase):
    def test_native_save_reopen_restores_receipts_but_changed_companion_cannot_use_cache(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            root = Path(directory)
            store = Store(root / 'state.sqlite3')
            documents = TakeoffDocuments(root / 'staging')
            service = TakeoffService(store, documents)
            dialogs = Dialogs()
            library = ProjectLibrary(store, dialogs, takeoffs=service)
            resources.callback(documents.close); resources.callback(library.close)
            state = service.open(); session_id = state['session_id']
            output = BytesIO(); pdf = canvas.Canvas(output, pagesize=(500, 500), invariant=True)
            pdf.drawString(40, 450, 'Synthetic member B17, 10 metres. No project information.')
            pdf.line(40, 300, 440, 300); pdf.showPage(); pdf.save()
            payload = output.getvalue()
            upload = documents.begin_upload(session_id, 'synthetic-plan.pdf', len(payload))
            documents.write_chunk(session_id, upload['upload_id'], 0, payload)
            document = documents.finish_upload(session_id, upload['upload_id'])
            state = service.add_document(session_id, document, state['revision'])
            requests = {}

            def command(op, **values):
                nonlocal state
                request = {'expected_revision': state['revision'], 'request_id': str(uuid4()), 'op': op, **values}
                requests[op] = request
                state = service.command(session_id, request)

            command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
            command('create_item', item={'mode': 'steel', 'quantity': 2,
                'geometry': {'document_id': document['id'], 'page': 1, 'points': [[40, 300], [440, 300]]},
                'measurement': {'method': 'cited', 'length_m': 10.0, 'citation': 'B17 dimension, page 1'},
                'fields': {'mark': 'B17', 'section': '100UC15', 'member_type': 'Beam', 'product': 'CAFCO 300',
                           'exposure': 'Re-entrant - 3 sides', 'critical_temperature': 550, 'fire_period_min': 120},
                'evidence': [{'document_id': document['id'], 'page': 1, 'note': 'Retained synthetic drawing'}]})
            item_id = state['snapshot']['items'][0]['id']
            command('review_items', item_ids=[item_id]); command('confirm_items', item_ids=[item_id])
            baseline = json.loads(export_project(store, {'estimate': {'title': 'Synthetic takeoff receipt test'}}))
            calculators = {key: {field: deepcopy(value[field]) for field in ('inputs', 'schedule_rows')}
                           for key, value in baseline['calculators'].items()}
            original = calculators['steel_vermiculite']
            preview = service.preview_transfer(session_id, {'expected_revision': state['revision'], 'calculator_id': 'steel_vermiculite',
                **deepcopy(original), 'item_ids': [item_id], 'update_linked': False})
            apply_request = {'expected_revision': state['revision'], 'request_id': str(uuid4()),
                             'preview_id': preview['preview_id'], **deepcopy(original)}
            state = service.apply_transfer(session_id, apply_request)
            calculators['steel_vermiculite'] = {key: state['calculator'][key] for key in ('inputs', 'schedule_rows')}
            target = root / 'project.cf.json'; dialogs.selection = SaveSelection(str(target), None)
            library.save_as({'estimate': baseline['estimate'], 'calculators': calculators,
                             'takeoffs': state['snapshot'], 'takeoffs_session_id': session_id})
            saved = json.loads(target.read_bytes())
            companion = root / saved['takeoffs']['companion_folder']
            source_path = companion / 'documents' / (document['sha256'] + '.pdf')
            audit_path = companion / 'audit' / (state['snapshot']['audit_head'] + '.json')
            original_audit = audit_path.read_bytes()
            before_retry = deepcopy(state['snapshot'])

            def counts():
                with store.connect() as db:
                    return tuple(db.execute('SELECT count(*) FROM '+table).fetchone()[0]
                                 for table in ('takeoff_approvals', 'takeoff_transfer_receipts'))

            original_counts = counts()
            for changed_path, original_bytes in ((source_path, payload), (audit_path, original_audit)):
                changed_path.write_bytes(original_bytes + b' changed-evidence')
                with self.subTest(changed=changed_path.suffix):
                    with self.assertRaises(ValidationError):
                        service.apply_transfer(session_id, apply_request)
                    for op in ('review_items', 'confirm_items'):
                        with self.assertRaises(ValidationError):
                            service.command(session_id, requests[op])
                changed_path.write_bytes(original_bytes)
                self.assertEqual(service.apply_transfer(session_id, apply_request)['calculator'], state['calculator'])
                for op in ('review_items', 'confirm_items'):
                    self.assertEqual(service.command(session_id, requests[op])['snapshot'], before_retry)
                self.assertEqual(service.get(session_id)['snapshot'], before_retry)
                self.assertEqual(counts(), original_counts)
            dialogs.opened = str(target)
            reopened = library.open_file()
            self.assertEqual(reopened['takeoffs_issues'], [])
            snapshot, session_id = reopened['takeoffs'], reopened['takeoffs_session_id']
            self.assertEqual(snapshot['items'][0]['state'], 'confirmed')
            self.assertEqual(snapshot['items'][0]['confirmation'], state['snapshot']['items'][0]['confirmation'])
            self.assertEqual(snapshot['transfers'][0]['status'], 'current')
            current_calculator = {key: reopened['calculators']['steel_vermiculite'][key] for key in ('inputs', 'schedule_rows')}
            repeated = service.preview_transfer(session_id, {'expected_revision': snapshot['revision'], 'calculator_id': 'steel_vermiculite',
                **current_calculator, 'item_ids': [item_id], 'update_linked': False})
            self.assertEqual(repeated['changes'], [])
            self.assertEqual(repeated['skipped'][0]['item_id'], item_id)
            source_path = root / saved['takeoffs']['companion_folder'] / 'documents' / (document['sha256'] + '.pdf')
            source_path.write_bytes(payload + b' changed-original')
            self.assertTrue(service.get(session_id)['issues'])
            with self.assertRaises(ValidationError):
                service.export(session_id, 'csv', [item_id])
            with self.assertRaises(ValidationError):
                service.capture(session_id, snapshot)
            with self.assertRaises(ValidationError):
                service.preview_transfer(session_id, {'expected_revision': snapshot['revision'], 'calculator_id': 'steel_vermiculite',
                    **current_calculator, 'item_ids': [item_id], 'update_linked': True})
            # The current immutable staging copy cannot hide altered originals.
            self.assertEqual((root / 'staging' / 'documents' / (document['sha256'] + '.pdf')).read_bytes(), payload)
            source_path.write_bytes(payload)
            self.assertEqual(service.get(session_id)['issues'], [])
            exported, _, _ = service.export(session_id, 'csv', [item_id])
            self.assertIn(item_id.encode(), exported)
            # Removing the portable audit head must also fail despite a valid cache.
            head = snapshot['audit_head']
            audit_path = root / saved['takeoffs']['companion_folder'] / 'audit' / (head+'.json')
            audit_path.rename(audit_path.with_suffix('.moved'))
            with self.assertRaises(ValidationError):
                service.export(session_id, 'csv', [item_id])


if __name__ == '__main__':
    unittest.main()
