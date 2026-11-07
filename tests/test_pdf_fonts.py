"""Actual drawn text uses the bundled faces; source PDF artwork stays intact."""
import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph, SimpleDocTemplate

from estimator.calculator_report import build_calculator_report, build_calculator_summary_report
from estimator.catalog import ROOT
from estimator.certification import FIELDS
from estimator.certification_report import render_certificate_pdf
from estimator.company_settings import DEFAULTS
from estimator.pdf_cover import prepend_cover_pdf
from estimator.pdf_fonts import (FONT_REGULAR, FONT_BOLD, FONT_ITALIC, FONT_BOLD_ITALIC,
                                 PdfParagraphStyle, font_path, register_pdf_fonts)
from estimator.penetration_calculator import calculate, definition
from estimator.penetration_item_exports import prepare_item_snapshot, render_item_pdf
from estimator.penetration_report import render_penetration_pdf, render_penetration_summary_pdf
from estimator.project_reports import build_project_report
from estimator.reference_library import ReferenceLibrary
from estimator.report import render_quote_pdf
from estimator.storage import Store
from estimator.technical_item_exports import prepare_technical_item, render_technical_item_pdf
from tests.technical_item_fixture_data import technical_library


def text_spans(payload):
    spans = []
    for page in PdfReader(BytesIO(payload)).pages:
        def collect(text, cm, tm, font, size):
            if text.strip():
                name = str((font or {}).get('/BaseFont', '')).lstrip('/').split('+')[-1]
                spans.append({'text': text.strip(), 'font': name})
        page.extract_text(visitor_text=collect)
    return spans


def authored_reports():
    """Real exporters include their headers, paragraphs, numeric cells and footers."""
    with tempfile.TemporaryDirectory() as folder:
        oracle = json.loads((ROOT / 'tests/fixtures/excel-calculator-oracle.json').read_text(encoding='utf-8-sig'))
        inputs = next(item['inputs'] for item in oracle['scenarios'] if item['id'] == 'combined-adjustments')
        quote = Store(Path(folder) / 'font.sqlite3').prepare_quote({'title': 'Font verification', 'inputs': inputs})
        yield 'estimate-breakdown', render_quote_pdf(quote)
        calculators = {
            'steel_vermiculite': {'SCHEDULE': {'A10': 'Spray member', 'B10': 'CAFCO 300', 'C10': 'Re-entrant - 3 sides',
                'D10': 620, 'E10': 'Section', 'F10': '410UB54', 'H10': 120, 'I10': 2, 'J10': 3}},
            'steel_board': {'CALCULATOR': {'A9': 'Board member', 'C9': 'PROMATECT-XS', 'D9': '200UC46',
                'F9': 10, 'G9': 4, 'H9': 120, 'I9': 'Column', 'J9': 550}},
            'ductwork': {'CALCULATOR': {'B11': '250x250', 'C11': 'CAFCO 300', 'D11': 10,
                'E11': '120/120/120', 'F11': 1, 'G11': 0, 'H11': 'External', 'I11': 'Horizontal'}},
            'steel_intumescent': {'SCHEDULE': {'A10': 'Paint member', 'B10': 'Nullifire SC902', 'C10': 'I/H beam - 3 sides',
                'D10': 550, 'E10': 'A/V', 'G10': 200, 'H10': 120, 'I10': 2, 'J10': 3, 'K10': .4}},
        }
        for identity, data in calculators.items():
            yield identity + '-schedule', build_calculator_report(identity, data, project_details={'project_no': 'PN-00001'})
            yield identity + '-summary', build_calculator_summary_report(identity, data)
        fire = {'globals': {}, 'rows': [{'id': 'service', 'inputs': {
            'K': 'Plastic Pipes', 'O': 3, 'AW': 123.456789012345, 'AX': 234.567890123456,
            'T': 'Current item', 'U': 'Recorded system details', 'AI': 7.12345678901234, 'AJ': 4.23456789012345}}]}
        result, metadata = calculate(fire), definition({})
        yield 'firestopping-schedule', render_penetration_pdf(result, metadata, {'project_no': 'PN-00001'})
        yield 'firestopping-summary', render_penetration_summary_pdf(result, metadata, {})
        current = prepare_item_snapshot({'item': fire['rows'][0], 'globals': {}, 'configuration': {}},
                                        library=None, default_configuration={})
        yield 'firestopping-item', render_item_pdf(current)
        yield 'project-schedule', build_project_report({key: {'inputs': value} for key, value in calculators.items()}, fire, {}, {})
        yield 'project-summary', build_project_report({key: {'inputs': value} for key, value in calculators.items()}, fire, {}, {}, materials=True)
        library_root = Path(folder) / 'library'
        technical_library(library_root)
        technical = prepare_technical_item({'id': 'report-a-v1'}, library=ReferenceLibrary(library_root))
        yield 'technical-item', render_technical_item_pdf(technical)
        fields = {**dict.fromkeys(FIELDS, ''), 'client': 'Example Client', 'project': 'PN-00001',
                  'address': 'Sydney', 'statement_of_compliance': 'Recorded statement', 'name': 'Example Signer'}
        yield 'certificate', render_certificate_pdf(fields, company=DEFAULTS, certificate_id='font-fixture',
                                                    revision=1, created_at='2026-11-07T01:00:00Z')


class PdfFontTests(unittest.TestCase):
    def test_concurrent_registration_and_all_four_faces_preserve_builtin_defaults(self):
        builtin = pdfmetrics.getFont('Helvetica')
        default = ParagraphStyle.defaults.copy()
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda _: register_pdf_fonts(), range(32)))
        self.assertIs(pdfmetrics.getFont('Helvetica'), builtin)
        self.assertEqual(ParagraphStyle.defaults, default)
        for face, name in (('regular', FONT_REGULAR), ('bold', FONT_BOLD),
                           ('italic', FONT_ITALIC), ('boldItalic', FONT_BOLD_ITALIC)):
            self.assertTrue(font_path(face).is_file())
            self.assertIn('Montserrat', pdfmetrics.getFont(name).face.name.decode())
        output = BytesIO()
        style = PdfParagraphStyle('FontProof', fontSize=11, leading=15)
        SimpleDocTemplate(output).build([
            Paragraph('Regular <b>Bold</b> <i>Italic</i> <b><i>BoldItalic</i></b>', style),
            Paragraph('Bullet text', style, bulletText='\u2022'),
        ])
        spans = text_spans(output.getvalue())
        self.assertTrue(all('Montserrat' in span['font'] for span in spans), spans)
        for token, face in (('Regular', 'Montserrat-Regular'), ('Bold', 'Montserrat-Bold'),
                            ('Italic', 'Montserrat-Italic'), ('BoldItalic', 'Montserrat-BoldItalic')):
            self.assertTrue(any(span['text'].strip() == token and span['font'] == face for span in spans), (token, spans))
        self.assertTrue(any('\u2022' in span['text'] for span in spans))

    def test_report_exporters_draw_only_montserrat_text(self):
        for name, payload in authored_reports():
            with self.subTest(exporter=name):
                spans = text_spans(payload)
                self.assertGreater(len(spans), 10)
                self.assertEqual([(span['text'], span['font']) for span in spans if 'Montserrat' not in span['font']], [])
                self.assertIn('Page', ' '.join(span['text'] for span in spans))

    def test_uploaded_cover_retains_its_original_font_and_content_stream(self):
        register_pdf_fonts()
        source, authored = BytesIO(), BytesIO()
        canvas = Canvas(source)
        canvas.setFont('Courier', 14)
        canvas.drawString(50, 700, 'ORIGINAL SOURCE PAGE')
        canvas.save()
        SimpleDocTemplate(authored).build([Paragraph('Authored content', PdfParagraphStyle('Body'))])
        cover = 'data:application/pdf;base64,' + base64.b64encode(source.getvalue()).decode()
        combined = prepend_cover_pdf(authored.getvalue(), {'cover_pdf': cover})
        original_page = PdfReader(BytesIO(source.getvalue())).pages[0]
        first_page = PdfReader(BytesIO(combined)).pages[0]
        self.assertEqual(first_page.get_contents().get_data(), original_page.get_contents().get_data())
        spans = text_spans(combined)
        self.assertTrue(any(span['text'] == 'ORIGINAL SOURCE PAGE' and span['font'] == 'Courier' for span in spans))
        self.assertTrue(any(span['text'] == 'Authored content' and 'Montserrat' in span['font'] for span in spans))


if __name__ == '__main__':
    unittest.main()
