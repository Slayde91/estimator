from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import uuid

from pypdf import PdfReader

from estimator.company_settings import DEFAULTS
from estimator.documentation_catalog import document_catalog
from estimator.inspection_register_report import render_inspection_register
from estimator.reference_library import ReferenceLibrary
from technical_item_fixture_data import technical_library, REPORT_URL
import test_certification_http as helpers
from test_passive_fire_register import completed_entry


class InspectionRegisterReportTests(unittest.TestCase):
    def test_selected_system_source_reports_and_all_phase_photos(self):
        with TemporaryDirectory() as folder:
            root = Path(folder) / 'technical'
            data = technical_library(root)
            data['libraries']['technical']['items'][0]['fields'].extend([
                {'label':'Barrier Construction', 'value':'Concrete wall or plasterboard wall'},
                {'label':'Service', 'value':'Copper pipe'},
            ])
            (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
            library = ReferenceLibrary(root)
            entry = {**completed_entry(), 'technical_item_id': 'report-a-v1',
                     'technical_filters': {'type': 'Core hole', 'substrate': 'Concrete/masonry wall',
                                           'category': 'Plumbing & Hydraulic', 'manufacturer': 'Synthetic manufacturer'}}
            entry['side2']['label'] = entry['side2']['label'] * 3
            payload = render_inspection_register({'entries': [{'location': 'Unfinished draft'}, entry]},
                                                 {'project_no': 'PN-41'}, library=library, company=DEFAULTS)
            reader = PdfReader(BytesIO(payload))
            text = ' '.join(' '.join(p.extract_text() for p in reader.pages).split())
            for label in ['Project Details', 'PN-41', '002', '002-2', 'Concrete/masonry wall',
                          'Synthetic manufacturer', 'SYN-123', 'Unlinked source report', 'Plumbing & Hydraulic']:
                self.assertIn(label, text)
            self.assertNotIn('Unfinished draft', text)
            self.assertTrue(any(a.get_object().get('/A', {}).get('/URI') == REPORT_URL
                                for page in reader.pages for a in page.get('/Annots', [])))
            # Eight phase photos over two sides plus two extra Label photos.
            draws = [op for page in reader.pages for op in page.get_contents().operations if op[1] == b'Do']
            self.assertEqual(len(draws), 10 + len(reader.pages))  # Plus the header logo on each page.

    def test_multipage_register_repeats_columns_and_displays_project_details_once(self):
        entries = [{**completed_entry(), 'location': f'Lobby {i}', 'access': 'NA'} for i in range(16)]
        pages = PdfReader(BytesIO(render_inspection_register({'entries': entries}, {'site_address': 'Test Road'},
                                                             library=None, company=DEFAULTS))).pages
        self.assertGreater(len(pages), 1)
        self.assertEqual(sum(page.extract_text().count('Test Road') for page in pages), 1)
        for page in pages:
            self.assertGreater(float(page.mediabox.width), float(page.mediabox.height))
            words = ' '.join(page.extract_text().split())
            self.assertIn('Level/Location Penetration ID Substrate Orientation Category Services Manufacturer FRL Report Numbers Before During After Label', words)
        self.assertIn('Lobby 15', pages[-1].extract_text())


class InspectionRegisterHTTPTests(unittest.TestCase):
    setUp = helpers.CertificationHTTPTests.setUp
    tearDown = helpers.CertificationHTTPTests.tearDown
    request = helpers.CertificationHTTPTests.request
    json = helpers.CertificationHTTPTests.json
    created_workspace = helpers.CertificationHTTPTests.created_workspace

    def test_documentation_selection_revisions_and_incomplete_rows(self):
        for edition in ['standard', 'full']:
            rows = document_catalog(edition)
            index = next(i for i, r in enumerate(rows) if r['id'] == 'passive_fire_register.pdf')
            self.assertEqual(rows[index+1]['label'], 'Passive Fire Registers')
        workspace = self.created_workspace()['workspace_id']
        route = '/api/project/passive-fire-registers.pdf'
        headers = {'X-Estimator-Documentation-Workspace': workspace,
                   'X-Estimator-Documentation-Request': str(uuid.uuid4())}
        for rows in [[], [{'location':'Draft'}]]:
            status, _, body = self.request('POST', route, {'register': {'entries': rows}}, headers)
            self.assertEqual(status, 400)
            self.assertIn(b'There are no completed passive fire inspections.', body)
        self.assertEqual(self.json('GET', '/api/documentation?workspace=' + workspace)['items'], [])
        body = {'register': {'entries': [completed_entry(), {}]}, 'project_details': {'project_no': 'PN-HTTP'}}
        status, _, payload = self.request('POST', route, body, headers)
        self.assertEqual(status, 200, payload[:100])
        item, = self.json('GET', '/api/documentation?workspace=' + workspace)['items']
        self.assertEqual((item['kind'], item['revision']), ('passive_fire_registers.pdf', 1))
        self.assertEqual(self.request('GET', item['url'])[2], payload)
        self.assertIn('PN-HTTP', PdfReader(BytesIO(payload)).pages[0].extract_text())

        # Neither a new register nor an idempotent replay may be saved beside a different project.
        other = self.created_workspace()['workspace_id']
        self.chooser.opened = str(Path(self.temp.name) / 'created-fixtures' / other / 'Project.cf.json')
        token = self.json('POST', '/api/project/open', {})['file']['save_token']
        for request_id in [headers['X-Estimator-Documentation-Request'], str(uuid.uuid4())]:
            status, _, error = self.request('POST', route, {**body, 'download': {'project_token': token}},
                                            {**headers, 'X-Estimator-Documentation-Request': request_id})
            self.assertEqual(status, 400)
            self.assertIn(b'different project', error)
        self.assertEqual(len(self.json('GET', '/api/documentation?workspace=' + workspace)['items']), 1)
