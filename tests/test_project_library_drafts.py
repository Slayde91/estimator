"""Project-local library inputs round-trip without shared library authority."""

import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary, LibraryConflict
from estimator.native_dialogs import SaveSelection
from estimator.penetration_calculator import calculate, source_model
from estimator.project_file import export_project, import_project, load_project_bytes
from estimator.project_library import ProjectLibrary, file_fingerprint
from estimator.project_library_drafts import normalize_library_drafts, prepare_library_drafts
from estimator.reference_library import ReferenceNotFound
from estimator.storage import Store
from test_firestopping_library import editable_library
from test_project_library import Chooser


class ProjectLibraryDraftTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        editable_library(self.root / 'library')
        self.store = Store(self.root / 'state.sqlite3')
        self.library = FirestoppingLibrary(self.root / 'library', self.store)
        self.edit = self.library.edit('pkb-001')
        self.body = {key: deepcopy(self.edit[key]) for key in ('draft', 'revision', 'pricing_token')}

    def snapshot(self, body=None):
        captured = self.library.project_draft('pkb-001', self.body if body is None else body)
        return {'version': 1, 'source_sha256': captured['source_sha256'], 'records': [captured['record']]}

    def database(self):
        with self.store.connect() as connection:
            return tuple(connection.iterdump())

    def sources(self):
        return {str(path.relative_to(self.root / 'library')): path.read_bytes()
                for path in (self.root / 'library').rglob('*') if path.is_file()}

    def request(self, snapshot):
        portable = json.loads(export_project(self.store, {'estimate': {'project_no': 'Project drafts'},
                                                         'library_drafts': snapshot}))
        return {'estimate': portable['estimate'], 'library_drafts': portable['library_drafts'],
                'calculators': {key: {'inputs': value['inputs'], 'schedule_rows': value['schedule_rows']}
                                for key, value in portable['calculators'].items()}}

    def test_capture_and_prepare_preserve_inputs_pricing_and_all_shared_storage(self):
        before, sources = self.database(), self.sources()
        body = deepcopy(self.body)
        body['draft']['rows'][0]['inputs']['AI'] = 75
        submitted = deepcopy(body)
        snapshot = self.snapshot(body)
        prepared = prepare_library_drafts(snapshot, service_types=['Copper service', 'Retained choice'])
        record, rendered = snapshot['records'][0], prepared['records'][0]
        self.assertEqual(body, submitted)
        self.assertEqual(record['draft']['rows'][0]['inputs']['AI'], 75)
        self.assertEqual(record['configuration'], self.edit['configuration'])
        self.assertEqual(record['source_sha256'], 'a' * 64)
        self.assertEqual(snapshot['source_sha256'], source_model()['source']['sha256'])
        self.assertEqual(rendered['price']['amount'], 175)
        self.assertEqual(rendered['result'], {**calculate(record['draft'], record['configuration']),
                                              'definition': rendered['definition']})
        self.assertTrue(rendered['project_local'])
        self.assertEqual(rendered['pricing_basis'], 'project')
        self.assertNotIn('pricing_token', record)
        self.assertNotIn('revision', record)
        self.assertNotIn('result', record)
        prepared['library_drafts']['records'][0]['draft']['rows'][0]['inputs']['AI'] = 999
        self.assertEqual(record['draft']['rows'][0]['inputs']['AI'], 75)
        self.assertEqual(self.library.edit('pkb-001')['draft']['rows'][0]['inputs']['AI'], 50)
        self.assertEqual(self.database(), before)
        self.assertEqual(self.sources(), sources)

    def test_export_import_and_repeated_image_roundtrips_are_lossless(self):
        snapshot = self.snapshot()
        original = deepcopy(snapshot)
        image = snapshot['records'][0]['diagram']
        self.assertEqual(base64.b64decode(image['content_base64']),
                         (self.root / 'library/images/diagram-a.png').read_bytes())
        before = self.database()
        for _ in range(3):
            payload = export_project(self.store, self.request(snapshot))
            loaded = import_project(self.store, 'Project.json', base64.b64encode(payload).decode('ascii'))
            prepared = prepare_library_drafts(loaded['library_drafts'])
            snapshot = prepared['library_drafts']
            self.assertEqual(snapshot, original)
            self.assertEqual(prepared['records'][0]['diagram']['url'],
                             'data:image/png;base64,' + image['content_base64'])
        self.assertEqual(self.database(), before)

    def test_uploaded_and_removed_images_remain_project_local(self):
        buffer = BytesIO()
        Image.new('RGBA', (90, 60), (255, 0, 0, 100)).save(buffer, 'PNG')
        body = {**deepcopy(self.body), 'diagram': {
            'filename': 'new.png', 'content_base64': base64.b64encode(buffer.getvalue()).decode('ascii')}}
        before, sources = self.database(), self.sources()
        snapshot = self.snapshot(body)
        self.assertEqual(snapshot['records'][0]['diagram']['filename'], 'pkb-001.jpg')
        expected = deepcopy(snapshot['records'][0]['diagram'])
        for _ in range(3):
            snapshot = prepare_library_drafts(snapshot)['library_drafts']
            self.assertEqual(snapshot['records'][0]['diagram'], expected)
        removed = self.snapshot({**deepcopy(self.body), 'diagram': None})
        self.assertIsNone(removed['records'][0]['diagram'])
        self.assertFalse(prepare_library_drafts(removed)['records'][0]['diagram']['available'])
        self.assertTrue(self.library.edit('pkb-001')['diagram']['available'])
        self.assertEqual(self.database(), before)
        self.assertEqual(self.sources(), sources)

    def test_capture_rejects_stale_revision_and_wrong_pricing_source(self):
        stale = deepcopy(self.body)
        self.library.action('pkb-001', 'save', deepcopy(self.body))
        before = self.database()
        with self.assertRaises(LibraryConflict):
            self.snapshot(stale)
        self.assertEqual(self.database(), before)
        fresh = self.library.edit('pkb-001')
        wrong = self.library.edits.capture({'basis': 'shared', 'label': 'Other source',
                                           'source_sha256': 'b' * 64,
                                           'configuration': fresh['configuration']})
        before = self.database()
        with self.assertRaises(LibraryConflict):
            self.snapshot({'draft': fresh['draft'], 'revision': fresh['revision'], 'pricing_token': wrong})
        self.assertEqual(self.database(), before)

    def test_exact_calculator_source_and_record_identity_are_required(self):
        snapshot = self.snapshot()
        invalid = []
        for key, value in [('source_sha256', 'b' * 64), ('version', True), ('version', 2)]:
            altered = deepcopy(snapshot)
            altered[key] = value
            invalid.append(altered)
        for key, value in [('id', '../pkb-001'), ('source_sha256', 'wrong'), ('library_id', 'bad\nlabel')]:
            altered = deepcopy(snapshot)
            altered['records'][0][key] = value
            invalid.append(altered)
        repeated = deepcopy(snapshot)
        repeated['records'].append(deepcopy(repeated['records'][0]))
        invalid.append(repeated)
        for altered in invalid:
            with self.subTest(value=altered.get('version'), record=altered['records'][0]['id']):
                with self.assertRaises(ValidationError):
                    normalize_library_drafts(altered)

    def test_project_rejects_injected_authority_outputs_configuration_and_images(self):
        snapshot = self.snapshot()
        mutations = {
            'token': lambda r: r.update(pricing_token='a' * 64),
            'result': lambda r: r.update(result={'price': 1}),
            'definition': lambda r: r.update(definition={'formula': 'malicious'}),
            'formula cell': lambda r: r['draft']['rows'][0]['inputs'].update(H='=1+1'),
            'extra row': lambda r: r['draft']['rows'].append({'id': 'extra', 'inputs': {}}),
            'no pricing snapshot': lambda r: r.update(configuration={}),
            'config authority': lambda r: r['configuration'].update(source_path='C:/private'),
            'catalog formula': lambda r: r['configuration']['catalog'].update(formulas={'H': '=1+1'}),
            'remote image': lambda r: r.update(diagram={'url': 'https://example.invalid/image.png'}),
            'traversal': lambda r: r['diagram'].update(filename='../private.png'),
            'absolute path': lambda r: r['diagram'].update(filename='C:\\private.png'),
            'invalid base64': lambda r: r['diagram'].update(content_base64='!invalid'),
            'HTML as image': lambda r: r['diagram'].update(content_base64=base64.b64encode(b'<script>alert(1)</script>').decode()),
            'SVG as image': lambda r: r['diagram'].update(filename='diagram.svg'),
        }
        before = self.database()
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                altered = deepcopy(snapshot)
                mutate(altered['records'][0])
                with self.assertRaises(ValidationError):
                    prepare_library_drafts(altered)
        self.assertEqual(self.database(), before)

    def test_library_deletion_does_not_remove_or_rebind_saved_project_record(self):
        snapshot = self.snapshot()
        request = self.request(snapshot)
        payload = export_project(self.store, request)
        self.library.action('pkb-001', 'delete', {})
        before, sources = self.database(), self.sources()
        with self.assertRaises(ReferenceNotFound):
            self.library.edit('pkb-001')
        loaded = load_project_bytes(self.store, payload)
        prepared = prepare_library_drafts(loaded['library_drafts'])
        self.assertEqual(prepared['library_drafts'], snapshot)
        self.assertEqual(prepared['records'][0]['price']['amount'], 150)
        self.assertEqual(prepared['records'][0]['library_id'], 'FL-ID-001')
        self.assertEqual(self.database(), before)
        self.assertEqual(self.sources(), sources)

    def test_save_and_overwrite_save_as_reject_old_browser_omission(self):
        chooser = Chooser()
        projects = ProjectLibrary(self.store, chooser)
        self.addCleanup(projects.close)
        target = self.root / 'Project.json'
        request = self.request(self.snapshot())
        chooser.selection = SaveSelection(str(target), None)
        saved = projects.save_as(request)
        protected = target.read_bytes()
        old_request = deepcopy(request)
        del old_request['library_drafts']
        before = self.database()
        with self.assertRaisesRegex(ValidationError, 'Refresh the application'):
            projects.save({**old_request, 'save_token': saved['file']['save_token']})
        self.assertEqual(target.read_bytes(), protected)
        self.assertEqual(self.database(), before)
        chooser.selection = SaveSelection(str(target), file_fingerprint(target))
        with self.assertRaisesRegex(ValidationError, 'Refresh the application'):
            projects.save_as(old_request)
        self.assertEqual(target.read_bytes(), protected)
        self.assertEqual(self.database(), before)
        # The failed overwrite must not consume the original save capability.
        complete = projects.save({**request, 'save_token': saved['file']['save_token']})
        self.assertEqual(complete['project']['library_drafts'], request['library_drafts'])
        self.assertEqual(json.loads(target.read_bytes())['library_drafts'], request['library_drafts'])

    def test_explicit_empty_snapshot_clears_only_project_records(self):
        chooser = Chooser()
        projects = ProjectLibrary(self.store, chooser)
        self.addCleanup(projects.close)
        target = self.root / 'Project.json'
        request = self.request(self.snapshot())
        chooser.selection = SaveSelection(str(target), None)
        saved = projects.save_as(request)
        request['library_drafts']['records'] = []
        before, sources = self.database(), self.sources()
        result = projects.save({**request, 'save_token': saved['file']['save_token']})
        self.assertEqual(result['project']['library_drafts']['records'], [])
        self.assertEqual(self.library.edit('pkb-001')['price']['amount'], 150)
        self.assertEqual(self.database(), before)
        self.assertEqual(self.sources(), sources)


if __name__ == '__main__':
    unittest.main()
