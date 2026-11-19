"""Calculator inspection evidence survives native project and PDF export."""
import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from openpyxl import Workbook, load_workbook
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.calculator_inspection_report import render_calculator_inspections
from estimator.calculator_inspections import (PHOTOS, inspection_calculator_rows, normalize_calculator_inspections,
                                               preserve_inspection_numbers, recorded_thickness)
from estimator.calculator_register import build_calculator_register
from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.documentation_catalog import document_catalog, export_identity
from estimator.project_file import export_project, load_project_bytes
from estimator.schedule_workbook import export_schedule_template, import_schedule_workbook
from estimator.storage import Store
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_workspace import TakeoffService
from estimator.workbook_catalog import load_workbook_catalog
from estimator.workbook_calculators import calculator_definition


DUCT = {'B11': '250x250', 'C11': 'FyreWrap', 'D11': 10, 'E11': '120/120/120',
        'F11': 0, 'G11': 0, 'H11': 'Stair pressurisation', 'I11': 'Both',
        'CM11': 2, 'DA11': 'Ground plant room'}
BOARD = {'A9': 'Beam A', 'B9': 'Level 1', 'C9': 'PROMATECT-XS', 'D9': '200UC46',
         'F9': 10, 'G9': 4, 'H9': 120, 'I9': 'Column', 'J9': 550,
         'M9': 'Standard', 'O9': 'Auto', 'P9': 'Published first', 'Q9': 'Standard box', 'CJ9': 1}


def _photo():
    output = BytesIO()
    Image.new('RGB', (120, 60), '#aa533c').save(output, 'JPEG')
    return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')


def _register(row, readings, pins=()):
    evidence = _photo()
    return {'calculator_id': row['calculator_id'], 'next_number': 2,
            'entries': [{'number': 1, 'entry_id': str(uuid4()), 'row': row, 'readings': readings,
                         'plan_pins': list(pins), **{key: [evidence] for key in PHOTOS}}]}


class CalculatorInspectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.duct = inspection_calculator_rows('ductwork', {'CALCULATOR': DUCT}, [11])['rows'][0]
        cls.board = inspection_calculator_rows('steel_board', {'CALCULATOR': BOARD}, [9])['rows'][0]

    def test_calculator_rows_use_assessed_spray_and_wrap_outputs(self):
        self.assertEqual(self.duct, {
            'calculator_id': 'ductwork', 'line': 1, 'location': 'Ground plant room',
            'duct_size': '250x250', 'section_id': '', 'critical_temp': None,
            'product': 'FyreWrap', 'frl': '120/120/120', 'quantity': 2, 'length': 10,
            'report': 'FC17299-01-1', 'required_thickness': '2 x 38mm',
        })
        spray = {key: value for key, value in DUCT.items() if key != 'DA11'}
        spray.update(C11='CAFCO 300', H11='External', I11='Horizontal')
        data = inspection_calculator_rows('ductwork', {'CALCULATOR': spray})['rows'][0]
        self.assertEqual((data['location'], data['report'], data['required_thickness']),
                         ('', 'FAS230196 RIR3.2', '60'))
        spray['C11'] = 'FyreWrap'
        result = inspection_calculator_rows('ductwork', {'CALCULATOR': spray, 'PRODUCT SETTINGS': {'B96': .04}})
        self.assertEqual(result['rows'][0]['required_thickness'], 'N / A')
        self.assertEqual(inspection_calculator_rows('ductwork', {})['rows'], [])
        with self.assertRaisesRegex(ValidationError, 'ordered list'):
            inspection_calculator_rows('ductwork', {'CALCULATOR': DUCT}, [12, 11])

    def test_supported_steel_selection_and_final_line(self):
        self.assertEqual((self.board['location'], self.board['section_id'], self.board['critical_temp'],
                          self.board['frl'], self.board['required_thickness'], self.board['report']),
                         ('Level 1', '200UC46', 550, '120 min', '30', 'FAS230021 RIR1.4'))
        final = {f'{key[:-1]}1008': value for key, value in BOARD.items()}
        row = inspection_calculator_rows('steel_board', {'CALCULATOR': final}, [1008])['rows'][0]
        self.assertEqual(row['line'], 1000)
        data = normalize_calculator_inspections({'steel': _register(row, [20, 40])})
        self.assertEqual(data['steel']['entries'][0]['row']['line'], 1000)
        self.assertEqual(recorded_thickness([1, 1.01]), '1.01')

    def test_corex_column_reports_missing_calculator_thickness_separately_from_readings(self):
        inputs = {**BOARD, 'C9': 'TRAFALGAR COREX', 'D9': '100UC15', 'G9': 4, 'H9': 30, 'I9': 'Column', 'J9': 620}
        blocked = inspection_calculator_rows('steel_board', {'CALCULATOR': inputs}, [9])
        row = blocked['rows'][0]
        self.assertEqual((row['critical_temp'], row['frl'], row['required_thickness'], row['report']),
                         (620, '30 min', 'N / A', ''))
        self.assertEqual(blocked['notes'], {
            '1': 'The calculator has no reviewed thickness table for this member type, critical temperature and fire period.',
        })
        self.assertNotIn('notes', row)
        with self.assertRaisesRegex(ValidationError, 'Steel \\(board\\), line 1, has no calculated required thickness'):
            render_calculator_inspections(_register(row, [35]), {}, 'steel', company=DEFAULTS)
        beam = inspection_calculator_rows('steel_board', {'CALCULATOR': {**inputs, 'I9':'Beam'}}, [9])
        self.assertEqual(beam['rows'][0]['report'], 'FAS200445 R2.0')
        self.assertNotEqual(beam['rows'][0]['required_thickness'], 'N / A')
        self.assertNotIn('notes', beam)

    def test_location_uses_application_metadata_and_legacy_templates_still_import(self):
        raw = load_workbook_catalog('ductwork')
        definition = calculator_definition('ductwork', {'CALCULATOR': DUCT})
        self.assertEqual(definition['source']['sha256'], raw['source']['sha256'])
        self.assertEqual(definition['schedule']['location_column'], 'DA')
        self.assertNotIn('DA', {column['column'] for column in raw['schedule']['columns']})
        template = load_workbook(BytesIO(export_schedule_template('ductwork')))
        self.addCleanup(template.close)
        sheet = template['CALCULATOR']
        labels = [cell.value for cell in sheet[1]]
        column = labels.index('Location') + 1
        sheet.cell(2, column, 'Basement east')
        output = BytesIO()
        template.save(output)
        imported = import_schedule_workbook('ductwork', output.getvalue(), 'Duct.xlsx')
        self.assertEqual(imported['inputs']['CALCULATOR']['DA11'], 'Basement east')
        workbook = Workbook()
        self.addCleanup(workbook.close)
        legacy = workbook.active
        legacy.title = 'CALCULATOR'
        legacy.append([label for label in labels if label != 'Location'])
        legacy.append(['250x250', 'FyreWrap', 10, 4])
        output = BytesIO()
        workbook.save(output)
        old = import_schedule_workbook('ductwork', output.getvalue(), 'Prior-Duct.xlsx')
        self.assertIsNone(old['inputs']['CALCULATOR']['DA11'])
        self.assertEqual(old['inputs']['CALCULATOR']['CM11'], 4)
        exported = load_workbook(BytesIO(build_calculator_register('ductwork', {'CALCULATOR': DUCT})), read_only=True)
        self.addCleanup(exported.close)
        headings = [cell.value for cell in exported['Schedule'][5]]
        self.assertEqual(exported['Schedule'].cell(6, headings.index('Location') + 1).value, 'Ground plant room')

    def test_open_and_save_keep_selected_rows_readings_and_identifiers(self):
        registers = {'duct': _register(self.duct, [74]), 'steel': _register(self.board, [29.5, 32.25])}
        registers['steel']['entries'][0]['source_estimate_id'] = 'estimate-' + 'a' * 32
        with tempfile.TemporaryDirectory() as path:
            store = Store(Path(path) / 'disposable.sqlite3')
            previous = load_project_bytes(store, export_project(store, {'estimate': {}}))
            self.assertNotIn('calculator_inspections', previous)
            data = export_project(store, {'estimate': {}, 'calculator_inspections': registers})
            self.assertEqual(load_project_bytes(store, data)['calculator_inspections'], registers)
        updated = deepcopy(registers)
        updated['steel']['calculator_id'] = 'steel_intumescent'
        preserve_inspection_numbers(registers, updated)
        updated['steel']['next_number'] = 3
        updated['steel']['entries'][0]['number'] = 2
        with self.assertRaisesRegex(ValidationError, 'cannot be reassigned'):
            preserve_inspection_numbers(registers, updated)
        with self.assertRaisesRegex(ValidationError, 'all calculator inspections'):
            preserve_inspection_numbers(registers, {'steel': registers['steel']})
        with self.assertRaisesRegex(ValidationError, 'different type'):
            normalize_calculator_inspections({'duct': {**registers['duct'], 'entries': registers['steel']['entries']}})
        updated = deepcopy(registers)
        updated['steel']['entries'][0]['source_estimate_id'] = 'Other estimate'
        with self.assertRaisesRegex(ValidationError, 'valid source estimate'):
            normalize_calculator_inspections(updated)

    def test_reports_include_photos_reading_count_and_exact_plan_pin(self):
        with tempfile.TemporaryDirectory() as path:
            folder = Path(path)
            documents = TakeoffDocuments(folder / 'evidence')
            self.addCleanup(documents.close)
            service = TakeoffService(Store(folder / 'takeoff.sqlite3'), documents)
            state = service.open()
            session, project = state['session_id'], state['snapshot']['project_id']
            stream = BytesIO()
            canvas = Canvas(stream)
            for label in ('Synthetic ignored drawing', 'Synthetic pinned drawing'):
                canvas.drawString(100, 100, label)
                canvas.showPage()
            canvas.save()
            original = stream.getvalue()
            upload = documents.begin_upload(session, 'Training drawing.pdf', len(original))['upload_id']
            documents.write_chunk(session, upload, 0, original)
            retained = documents.finish_upload(session, upload)
            service.add_document(session, retained, 0)
            pin = {'project_id': project, 'document_id': retained['id'], 'sha256': retained['sha256'],
                   'page': 2, 'x': .3, 'y': .4}
            register = _register(self.board, [29.5, 32.25, 30.45], [pin])
            output = render_calculator_inspections(register, {'project_no': 'QA-101'}, 'steel',
                                                   company=DEFAULTS, plan_sessions={project: session}, takeoffs=service)
            pages = PdfReader(BytesIO(output)).pages
            summary = ' '.join(page.extract_text() for page in pages[:-1])
            for phrase in ('Structural Steel Inspections', 'QA-101', 'FAS230021 RIR1.4', 'Number of Readings',
                           '30.73', 'Before Photos', 'During Photos', 'After Photos', 'Photo of Gauge'):
                self.assertIn(phrase, summary)
            self.assertIn('3', [line.strip() for line in summary.splitlines()])
            self.assertIn('Synthetic pinned drawing', pages[-1].extract_text())
            self.assertIn('001', pages[-1].extract_text())
            self.assertTrue(all('Synthetic ignored drawing' not in page.extract_text() for page in pages))
            with self.assertRaisesRegex(ValidationError, 'pinned plan is unavailable'):
                render_calculator_inspections(register, {}, 'steel', company=DEFAULTS, plan_sessions={}, takeoffs=service)
            self.assertEqual(documents.document_path(retained).read_bytes(), original)
        duct = _register(self.duct, [75])
        pdf = PdfReader(BytesIO(render_calculator_inspections(duct, {}, 'duct', company=DEFAULTS)))
        self.assertIn('2 x 38mm', ' '.join(page.extract_text() for page in pdf.pages))
        duct['entries'][0]['gauge'].clear()
        with self.assertRaisesRegex(ValidationError, 'Photo of Gauge'):
            render_calculator_inspections(duct, {}, 'duct', company=DEFAULTS)

    def test_documentation_routes_identify_each_download(self):
        available = {row['id']: row for row in document_catalog()}
        for key in ('duct_inspections', 'structural_steel_inspections'):
            source = '/api/project/' + key.replace('_', '-') + '.pdf'
            self.assertEqual(export_identity(source, {}), (key + '.pdf', ''))
            self.assertEqual(available[key + '.pdf']['adapter'], 'calculator_inspections')
