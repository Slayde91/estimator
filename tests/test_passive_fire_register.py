import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import unittest
import uuid

from PIL import Image
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.documentation_catalog import document_catalog, register_options
from estimator.native_dialogs import SaveSelection
from estimator.passive_fire_register import normalize_register, render_register_pdf
import test_certification_http as helpers


def photo():
    stream = BytesIO()
    Image.new('RGB', (320, 180), '#a44d47').save(stream, format='JPEG')
    return 'data:image/jpeg;base64,' + base64.b64encode(stream.getvalue()).decode('ascii')


def completed_entry():
    choices = register_options()
    entry = {key: choices[key][0] for key in ('seal_type', 'frl', 'substrate', 'orientation',
                                               'installation_type', 'manufacturer')}
    image = photo()
    side = {phase: [image] for phase in ('before', 'during', 'after', 'label')}
    return {**entry, 'service_types': choices['service_types'][:2], 'products': choices['products'][:2],
            'report': choices['reports'][entry['manufacturer']][0], 'location': 'Riser <01> & plant',
            'side1': {**side, 'id_number': 'SIDE-A'}, 'side2': {**side, 'id_number': 'SIDE-B'},
            'access': 'Yes', 'solution': choices['solution'][0], 'comments': 'Access blocked by wall',
            'photos': [image], 'signature': {'version': 1, 'ratio': 2, 'strokes': [[[0.1, 0.2], [0.8, 0.7]]]}}


class PassiveFireRegisterTests(unittest.TestCase):
    def test_incomplete_drafts_round_trip_and_only_complete_entries_export(self):
        draft = normalize_register({'entries': [{}, {'location': 'First floor'}]})
        self.assertEqual(normalize_register(draft), draft)
        self.assertIsNone(draft['entries'][0]['signature'])
        self.assertEqual(draft['entries'][0]['side2']['before'], [])
        with self.assertRaisesRegex(ValidationError, 'entry 1.*Location.*Signature'):
            render_register_pdf(draft, {}, company=DEFAULTS)
        with self.assertRaisesRegex(ValidationError, 'Add a register entry'):
            render_register_pdf({'entries': []}, {}, company=DEFAULTS)

    def test_all_access_branches_render_entered_evidence_and_project_identity(self):
        entry = completed_entry()
        for access, included, excluded in [
            ('Yes', 'SIDE-B', 'Access blocked by wall'),
            ('No', 'Access blocked by wall', 'SIDE-B'),
            ('NA', 'Topside only', 'SIDE-B'),
        ]:
            with self.subTest(access=access):
                current = {**entry, 'access': access}
                source = {'entries': [current, {**current, 'location': 'Basement west'}]}
                payload = render_register_pdf(source, {'project_no': 'PN-TEST'}, company=DEFAULTS)
                pages = PdfReader(BytesIO(payload)).pages
                content = '\n'.join(page.extract_text() for page in pages)
                self.assertGreaterEqual(len(pages), 2)
                for value in ('PN-TEST', 'Riser <01> & plant', 'Signature', 'Entry 2 of 2', 'Basement west',
                              'SIDE-A', 'Before', 'During', 'After', 'Label', included,
                              entry['report'], entry['products'][0]):
                    self.assertIn(value, content)
                self.assertNotIn(excluded, content)
                self.assertTrue(any(image.image.size == (320, 180) for page in pages for image in page.images))

    def test_conditional_requirements_and_closed_template_choices(self):
        entry = completed_entry()
        cases = [
            ({'side2': {'id_number': '1'}}, 'Side 2 before'),
            ({'access': 'No', 'photos': []}, 'Additional photos'),
            ({'access': 'NA', 'solution': ''}, 'Solution'),
            ({'manufacturer': 'HILTI'}, 'matching the manufacturer'),
            ({'report': ''}, 'Report'),
            ({'signature': None}, 'Signature'),
            ({'frl': 'UNLISTED'}, 'listed FRL'),
            ({'products': ['unlisted']}, 'listed Products'),
            ({'access': 'NA', 'solution': 'invalid'}, 'listed solution'),
        ]
        for changes, message in cases:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValidationError, message):
                render_register_pdf({'entries': [{**entry, **changes}]}, {}, company=DEFAULTS)
        choices = register_options()
        no_report = next(name for name in choices['manufacturer'] if name not in choices['reports'])
        verified = {**entry, 'manufacturer': no_report, 'report': ''}
        self.assertTrue(render_register_pdf({'entries': [verified]}, {}, company=DEFAULTS).startswith(b'%PDF'))

    def test_invalid_structure_and_photos_are_rejected_even_on_inactive_side(self):
        for entry in ({'extra': 1}, {'signature': 'Joe'}, {'side1': []},
                      {'side2': {'before': ['file:///photo.jpg']}},
                      {'side1': {'during': ['data:image/jpeg;base64,eA==']}},
                      {'photos': [photo()] * 21}, {'products': ['X', 'X']},
                      {'location': '\ud800'}):
            with self.subTest(keys=list(entry)), self.assertRaises(ValidationError):
                normalize_register({'entries': [entry]})
        with self.assertRaisesRegex(ValidationError, '200 entries'):
            normalize_register({'entries': [{}] * 201})


class PassiveFireRegisterHTTPTests(unittest.TestCase):
    setUp = helpers.CertificationHTTPTests.setUp
    tearDown = helpers.CertificationHTTPTests.tearDown
    request = helpers.CertificationHTTPTests.request
    json = helpers.CertificationHTTPTests.json
    created_workspace = helpers.CertificationHTTPTests.created_workspace

    def test_pdf_route_freezes_new_revision_and_replays_exact_bytes(self):
        route = '/api/project/passive-fire-register.pdf'
        workspace = self.created_workspace()['workspace_id']
        headers = {'X-Estimator-Documentation-Workspace': workspace,
                   'X-Estimator-Documentation-Request': str(uuid.uuid4())}
        entry = completed_entry()
        body = {'register': {'entries': [entry]}, 'project_details': {'project_no': 'AC-123'}}
        status, response, pdf = self.request('POST', route, body, headers)
        self.assertEqual(status, 200, pdf[:200])
        self.assertEqual(response['Content-Type'], 'application/pdf')
        self.assertEqual(self.request('POST', route, body, headers)[2], pdf)
        retained = self.json('GET', '/api/documentation?workspace=' + workspace)
        self.assertEqual([row['kind'] for row in retained['items']], ['passive_fire_register.pdf'])
        self.assertEqual(self.request('GET', retained['items'][0]['url'])[2], pdf)
        changed = deepcopy(body)
        changed['register']['entries'][0]['location'] = 'Another floor'
        self.assertEqual(self.request('POST', route, changed, headers)[0], 409)
        status, _, error = self.request('POST', route, {'register': {'entries': [{}]}})
        self.assertEqual(status, 400)
        self.assertIn('Complete register entry', json.loads(error)['error'])

    def test_catalog_order_and_template_options_are_identical_for_both_editions(self):
        for edition in ('full', 'standard'):
            catalog = document_catalog(edition)
            ids = [row['id'] for row in catalog]
            row = catalog[ids.index('firestopping.schedule.pdf') + 1]
            self.assertEqual(row['id'], 'passive_fire_register.pdf')
            self.assertEqual(row['spec']['options'], register_options())

    def test_native_save_and_reopen_preserve_incomplete_evidence_and_older_client_cannot_erase_it(self):
        target = Path(self.temp.name) / 'Register project.cf.json'
        self.chooser.selection = SaveSelection(str(target), None)
        draft = {'entries': [{'location': 'Level 3', 'side2': {'after': [photo()]}}]}
        estimate = helpers.project_estimate(title='Portable register')
        self.json('POST', '/api/project/save-as', {'estimate': estimate, 'passive_fire_register': draft})
        source = target.read_bytes()
        self.chooser.opened = str(target)
        loaded = self.json('POST', '/api/project/open', {})
        self.assertEqual(loaded['passive_fire_register'], normalize_register(draft))
        previous_client = {'save_token': loaded['file']['save_token'], 'estimate': json.loads(source)['estimate'],
                           'calculators': {key: {'inputs': row['inputs']} for key, row in loaded['calculators'].items()}}
        result = self.json('POST', '/api/project/save', previous_client, expected=400)
        self.assertIn('register', result['error'])
        self.assertEqual(target.read_bytes(), source)
