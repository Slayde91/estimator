"""Calculator register PDFs use completed inspections and independent revision histories."""
import base64
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

from PIL import Image
from pypdf import PdfReader

from estimator.assessment_references import UNAVAILABLE_RESULT, _links
from estimator.calculator_inspection_report import render_calculator_inspections, render_calculator_register
from estimator.calculator_inspections import PHOTOS
from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.documentation_catalog import CALCULATOR_REGISTERS, document_catalog, export_identity
import test_certification_http as helpers
import test_takeoff_http as takeoff_http
from test_takeoff_pdf_tools import drawing


def entry(kind, number):
    stream = BytesIO()
    Image.new('RGB', (80, 40), '#aa533c').save(stream, 'JPEG')
    photo = 'data:image/jpeg;base64,' + base64.b64encode(stream.getvalue()).decode('ascii')
    steel = kind == 'steel'
    return {
        'entry_id': str(uuid4()), 'number': number,
        'row': {
            'calculator_id': 'steel_board' if steel else 'ductwork', 'line': 10,
            'location': f'Inspection location {number}', 'duct_size': '' if steel else '250x250',
            'section_id': '200UC46' if steel else '', 'critical_temp': 550 if steel else None,
            'product': 'PROMATECT-XS' if steel else 'FyreWrap', 'frl': '120 min' if steel else '120/120/120',
            'quantity': 2, 'length': 10, 'report': 'FAS230021 RIR1.4' if steel else 'FC17299-01-1',
            'required_thickness': '30' if steel else '2 x 38mm',
        },
        'readings': [29, 30.25, 34] if steel else [77.25],
        **{phase: [photo] for phase in PHOTOS},
    }


def register(kind, entries):
    return {'calculator_id': 'steel_board' if kind == 'steel' else 'ductwork',
            'next_number': max((item['number'] for item in entries), default=0) + 1,
            'entries': entries}


def words(page):
    return ' '.join(page.extract_text().split())


def report_urls(pages):
    return {str(action['/URI']) for page in pages for reference in page.get('/Annots', [])
            if (annotation := reference.get_object()).get('/Subtype') == '/Link'
            and (action := annotation.get('/A', {})).get('/S') == '/URI'}


class CalculatorRegisterReportTests(unittest.TestCase):
    def test_saved_report_captions_link_only_to_exact_calculator_authorities(self):
        steel = entry('steel', 1)
        steel['row'].update(calculator_id='steel_vermiculite', product='CAFCO 300', report='FC13107-01-05')
        duct = entry('duct', 1)
        duct['row']['report'] = ('FC17299-01-1 | FCO3226 Rev F | FC15909-01-2 | FC13107-01-05 | '
                                 '<link href="https://example.org/private">Unverified</link>')
        cases = [('steel', steel, {'FC13107-01-05'}), ('duct', duct, {'FC17299-01-1', 'FCO3226 Rev F'})]
        for renderer in (render_calculator_inspections, render_calculator_register):
            for kind, item, labels in cases:
                with self.subTest(render=renderer.__name__, kind=kind):
                    snapshot = register(kind, [item])
                    snapshot['calculator_id'] = item['row']['calculator_id']
                    pdf = PdfReader(BytesIO(renderer(snapshot, {}, kind, company=DEFAULTS)))
                    self.assertEqual(report_urls(pdf.pages), {_links()[label] for label in labels})
                    if kind == 'steel':
                        self.assertIn('FC13107-01-05', words(pdf.pages[0]))
                    if kind == 'duct' and renderer is render_calculator_inspections:
                        self.assertIn('FC15909-01-2', words(pdf.pages[0]))
                        self.assertIn('>Unverified</link>', words(pdf.pages[0]))

    def test_landscape_register_repeats_columns_and_uses_all_evidence(self):
        entries = [entry('steel', index) for index in range(1, 18)]
        entries[0]['gauge'] *= 2
        entries[-1]['row']['required_thickness'] = UNAVAILABLE_RESULT
        pdf = PdfReader(BytesIO(render_calculator_register(register('steel', entries),
                            {'project_no': 'QA-Register'}, 'steel', company=DEFAULTS)))
        self.assertEqual(pdf.metadata.title, 'Structural Steel Register')
        self.assertGreater(len(pdf.pages), 1)
        for page_index, page in enumerate(pdf.pages):
            self.assertGreater(float(page.mediabox.width), float(page.mediabox.height))
            text = words(page)
            for phrase in ('Inspection ID', 'Section ID', 'Critical Temp (°C)', 'Required Thickness (mm)',
                           'Recorded Thickness (mm)', 'Number of Readings',
                           'Before Photos', 'During Photos', 'After Photos', 'Photo of Gauge'):
                self.assertIn(phrase, text)
            self.assertEqual(text.count('STRUCTURAL STEEL REGISTER'), int(page_index == 0))
        text = ' '.join(words(page) for page in pdf.pages)
        self.assertIn('QA-Register', text)
        self.assertNotIn('Calculator Register', text)
        self.assertNotIn('Steel (board) | line 10', text)
        self.assertIn('200UC46', text)
        self.assertIn('FAS230021 RIR1.4', text)
        self.assertIn('31.08', text)
        self.assertNotIn('Inspection location 17', text)
        self.assertEqual(sum(line.strip() == '001' for page in pdf.pages
                             for line in page.extract_text().splitlines()), 2)
        draws = [operation for page in pdf.pages for operation in page.get_contents().operations
                 if operation[1] == b'Do']
        self.assertEqual(len(draws), 16 * len(PHOTOS) + 1 + len(pdf.pages))

    def test_register_shows_sydney_download_date_and_accepts_optional_evidence(self):
        instant = datetime(2026, 11, 19, 13, 1, tzinfo=timezone.utc)
        for kind in ('duct', 'steel'):
            with self.subTest(kind=kind), patch('estimator.date_display.datetime') as clock:
                clock.now.side_effect = instant.astimezone
                complete = entry(kind, 1)
                complete['gauge'] = []
                payload = render_calculator_register(register(kind, [complete]), {'site_address': 'Test Road'},
                                                     kind, company=DEFAULTS)
                page, = PdfReader(BytesIO(payload)).pages
                summary = words(page)
                self.assertIn('Site Address Test Road Date 20/11/2026', summary)
                self.assertIn('Inspection location 1', summary)
                self.assertNotIn('Calculator Register', summary)

    def test_measured_thickness_does_not_make_an_unavailable_calculation_complete(self):
        incomplete = entry('duct', 1)
        incomplete['row']['required_thickness'] = UNAVAILABLE_RESULT
        with self.assertRaisesRegex(ValidationError, 'no completed duct inspections'):
            render_calculator_register(register('duct', [incomplete]), {}, 'duct', company=DEFAULTS)


class CalculatorRegisterHTTPTests(unittest.TestCase):
    setUp = helpers.CertificationHTTPTests.setUp
    tearDown = helpers.CertificationHTTPTests.tearDown
    request = takeoff_http.TakeoffHTTPTests.request
    json = helpers.CertificationHTTPTests.json
    created_workspace = helpers.CertificationHTTPTests.created_workspace

    def test_independent_register_revisions_covers_and_completed_pins(self):
        workspace = self.created_workspace()['workspace_id']
        other = self.created_workspace()['workspace_id']
        state = self.json('POST', '/api/takeoffs/sessions', {})
        session, project = state['session_id'], state['snapshot']['project_id']
        source = drawing('Calculator plan', pages=2)
        uploads = f'/api/takeoffs/sessions/{session}/uploads'
        upload = self.json('POST', uploads, {'filename': 'Calculator plan.pdf', 'size': len(source)})['upload_id']
        endpoint = f'{uploads}/{upload}'
        self.assertEqual(self.request('PUT', endpoint + '?offset=0', source,
                                      {'Content-Type': 'application/octet-stream'})[0], 200)
        document, = self.json('POST', endpoint + '/complete', {'expected_revision': 0})['snapshot']['documents']
        pin = {'project_id': project, 'document_id': document['id'], 'sha256': document['sha256'],
               'page': 2, 'x': .2, 'y': .3}
        catalogue = {row['id']: row for row in document_catalog()}
        for kind, (title, key) in CALCULATOR_REGISTERS.items():
            with self.subTest(kind=kind):
                route = '/api/project/' + key.replace('_', '-') + '.pdf'
                self.assertEqual(export_identity(route, {}), (key + '.pdf', ''))
                self.assertEqual(catalogue[key + '.pdf']['spec'], {'kind': kind, 'action': 'register'})
                self.json('POST', f'/api/pdf-covers/{key}',
                          {'cover_pdf': helpers.cover(title + ' cover'), 'cover_pdf_name': 'Cover.pdf',
                           'expected_version': 1})
                complete, draft = entry(kind, 1), entry(kind, 2)
                complete['plan_pins'] = [pin]
                draft['after'] = []
                draft_project = str(uuid4())
                draft['plan_pins'] = [{**pin, 'project_id': draft_project, 'page': 1}]
                request = {'register': register(kind, [complete, draft]),
                           'project_details': {'project_no': 'REGISTER-QA'},
                           'plan_sessions': {project: session, draft_project: str(uuid4())}}
                headers = {'X-Estimator-Documentation-Workspace': workspace,
                           'X-Estimator-Documentation-Request': str(uuid4())}
                status, _, payload = self.request('POST', route, request, headers)
                self.assertEqual(status, 200, payload[:200])
                pages = PdfReader(BytesIO(payload)).pages
                self.assertEqual(words(pages[0]), title + ' cover')
                self.assertIn(title, words(pages[1]))
                self.assertIn('REGISTER-QA', words(pages[1]))
                self.assertIn('120 min' if kind == 'steel' else '120/120/120', words(pages[1]))
                self.assertEqual(report_urls(pages), {_links()[complete['row']['report']]})
                self.assertIn('Calculator plan page 2', words(pages[-1]))
                self.assertIn('001', words(pages[-1]))
                self.assertFalse(any('Inspection location 2' in words(page) for page in pages))
                self.assertEqual(self.request('POST', route, request, headers)[2], payload)

                reported = self.json('GET', '/api/documentation?workspace=' + workspace)['items']
                item, = [row for row in reported if row['kind'] == key + '.pdf']
                self.assertEqual(item['revision'], 1)
                self.assertEqual(self.request('GET', item['url'])[2], payload)
                self.assertEqual(self.request('GET', item['url'].replace(workspace, other))[0], 404)
                self.chooser.opened = str(Path(self.temp.name) / 'created-fixtures' / other / 'Project.cf.json')
                token = self.json('POST', '/api/project/open', {})['file']['save_token']
                status, _, error = self.request('POST', route,
                                                {**request, 'download': {'project_token': token}}, headers)
                self.assertEqual(status, 400, error)
                self.assertIn(b'different project', error)
