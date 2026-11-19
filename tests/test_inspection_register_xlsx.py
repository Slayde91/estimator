"""Completed inspection workbook values, evidence, and project export history."""
from io import BytesIO
import json
from pathlib import Path
import unittest
from uuid import uuid4

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.assessment_references import _links
from estimator.catalog import ValidationError
from estimator.documentation_catalog import XLSX, PDF, document_catalog
from estimator.inspection_register_xlsx import render_calculator_register_xlsx, render_passive_register_xlsx
from estimator.native_dialogs import SaveSelection
import test_certification_http as helpers
from test_calculator_register_report import entry, register
from test_passive_fire_register import completed_entry


DETAILS = {'project_no': 'PN-09', 'client': '=Literal client', 'site_address': 'Example Street'}


class InspectionRegisterWorkbookTests(unittest.TestCase):
    def read_sheet(self, payload):
        workbook = load_workbook(BytesIO(payload))
        self.addCleanup(workbook.close)
        return workbook.active

    def test_detailed_passive_rows_embed_two_sides_and_additional_photos(self):
        item = completed_entry()
        item['location'] = '=Literal location'
        item['side1']['during'] = item['side1']['during'] * 2
        draft = completed_entry()
        draft['location'] = 'unfinished'
        draft['side1']['before'] = []
        sheet = self.read_sheet(render_passive_register_xlsx({'entries': [item, draft]}, DETAILS, library=None))
        self.assertEqual(sheet.title, 'Passive Fire Register')
        self.assertEqual(sheet['B3'].value, '=Literal client')
        self.assertEqual(sheet['B3'].data_type, 's')
        self.assertEqual(sheet['A8'].value, '=Literal location')
        self.assertEqual(sheet['A8'].data_type, 's')
        self.assertEqual([sheet[f'B{row}'].value for row in (8, 9, 10)], ['001', '001', '001-2'])
        self.assertIsNone(sheet['C9'].value)
        self.assertEqual(sheet.auto_filter.ref, 'A7:M10')
        self.assertEqual(len(sheet._images), 9)
        self.assertEqual(sheet.max_row, 10)

    def test_calculator_rows_preserve_numeric_values_layers_and_explicit_report_links(self):
        item = entry('duct', 1)
        item['after'] *= 2
        draft = entry('duct', 2)
        draft['before'] = []
        sheet = self.read_sheet(render_calculator_register_xlsx(register('duct', [item, draft]), DETAILS, 'duct'))
        self.assertEqual(sheet.title, 'Duct Register')
        self.assertEqual(sheet['B8'].value, '001')
        self.assertEqual(sheet['H8'].hyperlink.target, _links()['FC17299-01-1'])
        self.assertEqual(sheet['I8'].value, '2 x 38mm')
        self.assertEqual((sheet['F8'].value, sheet['J8'].value, sheet['K8'].value), (2, 77.25, 1))
        self.assertEqual(sheet['J8'].data_type, 'n')
        self.assertEqual(sheet['B9'].value, '001')
        self.assertIsNone(sheet['C9'].value)
        self.assertEqual(len(sheet._images), 5)
        self.assertEqual(sheet.max_row, 9)

    def test_manual_steel_values_are_literal_and_use_no_calculator_reference(self):
        item = entry('steel', 1)
        item['custom_item'] = dict(location='=Manual Riser B', section_id='250UC72', critical_temp=575,
                                   product='Entered material', frl='90 min', quantity=3, length=2.5,
                                   report=item['row']['report'], required_thickness='45')
        sheet = self.read_sheet(render_calculator_register_xlsx(register('steel', [item]), DETAILS, 'steel'))
        self.assertEqual(sheet.title, 'Structural Steel Register')
        self.assertEqual((sheet['A8'].value, sheet['A8'].data_type), ('=Manual Riser B', 's'))
        self.assertEqual((sheet['C8'].value, sheet['D8'].value, sheet['J8'].value), ('250UC72', 575, 45))
        self.assertEqual(sheet['I8'].value, 'FAS230021 RIR1.4')
        self.assertIsNone(sheet['I8'].hyperlink)
        self.assertEqual(sheet['K8'].value, 31.08)

    def test_no_completed_rows_and_unrepresentable_text_fail_cleanly(self):
        with self.assertRaisesRegex(ValidationError, 'no completed'):
            render_passive_register_xlsx({'entries': []}, DETAILS, library=None)
        for invalid in ('\ud800', '\ufffe', 'Riser\x01'):
            with self.subTest(value=repr(invalid)), self.assertRaises(ValidationError):
                render_calculator_register_xlsx(register('steel', [entry('steel', 1)]),
                                                {**DETAILS, 'client': invalid}, 'steel')


class InspectionRegisterWorkbookHTTPTests(unittest.TestCase):
    setUp = helpers.CertificationHTTPTests.setUp
    tearDown = helpers.CertificationHTTPTests.tearDown
    request = helpers.CertificationHTTPTests.request
    json = helpers.CertificationHTTPTests.json
    def test_native_xlsx_downloads_are_archived_separately_from_pdfs(self):
        workspace = self.json('POST', '/api/certifications/workspaces', {}, expected=201)['workspace_id']
        self.chooser.selection = SaveSelection(str(Path(self.temp.name) / 'Saved project.cf.json'), None)
        saved = self.json('POST', '/api/project/save-as', {'estimate': helpers.project_estimate(title='Saved project'),
                          'certifications': {'workspace_id': workspace, 'draft': None}})
        download = {'project_token': saved['file']['save_token']}
        catalog = {item['id']: item for item in document_catalog()}
        for key, stem, snapshot in (
            ('passive_fire_registers', 'PASSIVE_FIRE_REGISTER', {'entries': [completed_entry()]}),
            ('duct_register', 'DUCT_REGISTER', register('duct', [entry('duct', 1)])),
            ('structural_steel_register', 'STEEL_REGISTER', register('steel', [entry('steel', 1)])),
        ):
            with self.subTest(kind=key):
                base = '/api/project/' + key.replace('_', '-')
                body = {'register': snapshot, 'project_details': DETAILS, 'download': download}
                self.assertEqual(catalog[key + '.xlsx']['format'], 'xlsx')
                for extension, media_type in [('pdf', PDF), ('xlsx', XLSX)]:
                    headers = {'X-Estimator-Documentation-Workspace': workspace,
                               'X-Estimator-Documentation-Request': str(uuid4())}
                    status, _, response = self.request('POST', f'{base}.{extension}', body, headers)
                    self.assertEqual(status, 200, response)
                    receipt = json.loads(response)
                    item = receipt['documentation']['item']
                    self.assertEqual((item['kind'], item['revision'], item['media_type']), (f'{key}.{extension}', 1, media_type))
                    self.assertEqual(item['filename'], f'{stem}-1.{extension}')
                    self.assertEqual(Path(receipt['path']).name, item['filename'])
                    content = Path(receipt['path']).read_bytes()
                    self.assertEqual(self.request('GET', item['url'])[2], content)
                    if extension == 'xlsx':
                        workbook = load_workbook(BytesIO(content), read_only=True)
                        self.assertEqual(workbook.active['B2'].value, DETAILS['project_no'])
                        workbook.close()
                    else:
                        self.assertGreater(len(PdfReader(BytesIO(content)).pages), 0)
        history = self.json('GET', '/api/documentation?workspace=' + workspace)
        self.assertEqual(history['workspace_revision'], 6)
