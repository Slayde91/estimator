"""Company details are validated, persisted and projected into PDF headers only."""
import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS, company_logo, validate_company_settings
from estimator.storage import Store
from estimator.report import _company_header, _register_fonts
from estimator.penetration_calculator import definition, normalize_draft, WASTE_SETTINGS
from estimator.penetration_entry import validate_item_for_add


class CompanySettingsTests(unittest.TestCase):
    def test_every_authored_report_uses_the_company_header_and_ceasefire_rule(self):
        from estimator.calculator_report import build_calculator_report, build_calculator_summary_report
        from estimator.report import render_quote_pdf
        from estimator.penetration_calculator import calculate
        from estimator.penetration_report import render_penetration_pdf
        from estimator.penetration_item_exports import prepare_item_snapshot, render_item_pdf
        from estimator.technical_item_exports import prepare_technical_item, render_technical_item_pdf
        from estimator.reference_library import ReferenceLibrary
        from estimator.takeoff_physical import new_graph
        from estimator.takeoff_physical_exports import export_matrix_pdf
        from technical_item_fixture_data import technical_library
        from tests.test_penetration_item_exports import body, DiagramLibrary
        from tests.test_takeoff_physical import uid
        company = {**DEFAULTS, 'name': 'Report Fixture', 'email': 'shared@example.test'}
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'qa.sqlite3')
            quote = store.prepare_quote({'title': 'Branded report', 'inputs': {}})
            library_root = Path(directory) / 'library'; technical_library(library_root)
            technical = prepare_technical_item({'id': 'report-a-v1'}, library=ReferenceLibrary(library_root))
            draft = {'globals': {}, 'rows': []}
            item = prepare_item_snapshot(body(), library=DiagramLibrary(), default_configuration={})
            reports = {
                'quote': render_quote_pdf(quote, company=company),
                'schedule': build_calculator_report('steel_vermiculite', {}, company=company),
                'summary': build_calculator_summary_report('steel_board', {}, company=company),
                'firestopping': render_penetration_pdf(calculate(draft), definition(), {}, company=company),
                'item': render_item_pdf(item, company=company),
                'technical': render_technical_item_pdf(technical, company=company),
                'matrix': export_matrix_pdf(new_graph(uid(1000), uid(2000), version=2), company=company)[0],
            }
        for kind, payload in reports.items():
            painted_rectangles = []
            for page in PdfReader(BytesIO(payload)).pages:
                with self.subTest(report=kind):
                    self.assertIn(company['name'], page.extract_text())
                    self.assertIn(company['email'], page.extract_text())
                    self.assertNotIn(DEFAULTS['email'], page.extract_text())
                    self.assertIn(b'.741176 0 .094118 RG', page.get_contents().get_data())
                    self.assertNotIn(b'.019608 .388235 .756863 rg', page.get_contents().get_data())
                    # Inspect painted cells rather than style declarations. Source
                    # images remain their original colours and are not recoloured.
                    fill, stack, rectangle = (0., 0., 0.), [], False
                    for operands, operator in page.get_contents().operations:
                        if operator == b'q': stack.append(fill)
                        elif operator == b'Q': fill = stack.pop()
                        elif operator == b'rg': fill = tuple(round(float(v), 5) for v in operands)
                        elif operator == b'g': fill = (round(float(operands[0]), 5),) * 3
                        elif operator == b're': rectangle = True
                        elif operator in (b'f', b'f*', b'B', b'B*'):
                            if rectangle: painted_rectangles.append(fill)
                            rectangle = False
                        elif operator in (b'S', b's', b'n'): rectangle = False
            with self.subTest(report=kind, property='table palette'):
                self.assertIn((.74118, 0., .09412), painted_rectangles)
                self.assertTrue(set(painted_rectangles) <= {(1., 1., 1.), (0., 0., 0.), (.74118, 0., .09412)}, painted_rectangles)

    def test_save_reopen_valid_logo_and_contact_header(self):
        image = BytesIO(); Image.new('RGB', (20, 10), 'red').save(image, 'PNG')
        value = {**DEFAULTS, 'name': 'Fixture Company', 'abn': '12 345 678 901',
                 'email': 'pdf@example.test', 'phone': '12345678',
                 'logo': 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode()}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'company.sqlite3'
            store = Store(path); self.assertEqual(store.company_settings(), DEFAULTS)
            pricing = store.configuration()
            self.assertEqual(store.save_company_settings(value), value)
            self.assertEqual(Store(path).company_settings(), value)
            self.assertEqual(store.configuration(), pricing)
        _register_fonts(); output = BytesIO(); canvas = Canvas(output, pagesize=(600, 800))
        _company_header(canvas, company_logo(value), 600, 800, 30, 'TEST REPORT', company=value)
        canvas.save(); page = PdfReader(output).pages[0]; text = page.extract_text()
        for part in ('Fixture Company', '12 345 678 901', 'pdf@example.test', '12345678', 'TEST REPORT'):
            self.assertIn(part, text)
        self.assertNotIn(DEFAULTS['email'], text)
        self.assertIn(b'.741176 0 .094118 RG', page.get_contents().get_data())

    def test_invalid_upload_or_text_does_not_replace_saved_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'settings.sqlite3')
            for bad in ({**DEFAULTS, 'logo': 'data:image/svg+xml;base64,PHN2Zz4='},
                        {**DEFAULTS, 'logo': 'data:image/png;base64,YmFk'},
                        {**DEFAULTS, 'phone': 'x' * 121}, {**DEFAULTS, 'name': 'line\nbreak'},
                        {**DEFAULTS, 'extra': 'not allowed'}):
                with self.subTest(bad=bad), self.assertRaises(ValidationError):
                    store.save_company_settings(bad)
                self.assertEqual(store.company_settings(), DEFAULTS)

    def test_new_defaults_preserve_explicit_and_historical_waste(self):
        defaults = definition()['defaults']
        self.assertTrue(all(defaults['globals'][key] == .3 for key in WASTE_SETTINGS))
        retained = {'globals': {key: .123456789 for key in WASTE_SETTINGS}, 'rows': []}
        self.assertTrue(all(normalize_draft(retained)['globals'][key] == .123456789 for key in WASTE_SETTINGS))
        self.assertTrue(all(normalize_draft({'globals': {}, 'rows': []})['globals'][key] == 0 for key in WASTE_SETTINGS))

    def test_dropdown_settings_roundtrip_without_rewriting_saved_item_values(self):
        draft = {'globals': {'detail_options': {'L': ['Core hole', 'Oversized'], 'V': ['Custom manufacturer']}},
                 'rows': [{'id': 'old', 'inputs': {'L': 'Retired choice', 'V': 'Old manufacturer'}}]}
        normalized = normalize_draft(draft)
        self.assertEqual(normalized['globals']['detail_options'], draft['globals']['detail_options'])
        self.assertEqual(normalized['rows'], draft['rows'])
        for value in ({'X': ['Product']}, {'L': ['']}, {'L': ['a;b']}, {'L': ['x' * 121]}):
            with self.assertRaises(ValidationError): normalize_draft({'globals': {'detail_options': value}, 'rows': []})

    def test_mastic_entry_requires_both_fields(self):
        inputs = {'J': 'Mechanical HVAC', 'K': 'Unlagged Pipes', 'L': 'Core hole', 'M': 'Vertical', 'N': '-/120/120', 'P': 'Concrete/masonry wall'}
        for fields, phrase in (({'AB': 'Mastic'}, 'Mastic Qty'), ({'AC': 2}, 'Mastic Type'), ({'AB': 'Mastic', 'AC': 0}, 'Mastic Qty')):
            with self.subTest(fields=fields), self.assertRaisesRegex(ValidationError, phrase):
                validate_item_for_add({'globals': {}, 'rows': [{'id': 'new', 'inputs': {**inputs, **fields}}]})
        for fields in ({}, {'AB': 'Mastic', 'AC': .123456789}):
            draft = {'globals': {}, 'rows': [{'id': 'new', 'inputs': {**inputs, **fields}}]}
            original = deepcopy(draft); validate_item_for_add(draft); self.assertEqual(draft, original)
