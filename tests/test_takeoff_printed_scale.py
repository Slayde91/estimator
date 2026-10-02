"""Printed footer scales use exact source text and never replace user choices."""

from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader, PdfWriter
from pypdf.generic import FloatObject, NameObject, RectangleObject
from reportlab.pdfgen import canvas

from estimator.catalog import ValidationError
from estimator.storage import Store
from estimator.takeoff_documents import TakeoffDocuments
from estimator.takeoff_model import SCALE_DENOMINATORS, markup_appearance, validate_snapshot
from estimator.takeoff_pdf_worker import PRINTED_SCALES, parse_pdf_stream
from estimator.takeoff_workspace import TakeoffService


def pdf(*lines, size=(600, 800), rotation=0, user_unit=1, crop=None):
    stream = BytesIO()
    drawing = canvas.Canvas(stream, pagesize=size)
    drawing.setFont('Helvetica', 10)
    for text, x, y in lines:
        drawing.drawString(x, y, text)
    drawing.save()
    writer = PdfWriter()
    page = writer.add_page(PdfReader(BytesIO(stream.getvalue())).pages[0])
    if rotation:
        page.rotate(rotation)
    if user_unit != 1:
        page[NameObject('/UserUnit')] = FloatObject(user_unit)
    if crop:
        page.cropbox = RectangleObject(crop)
    output = BytesIO(); writer.write(output)
    return output.getvalue()


class PrintedScaleParserTests(unittest.TestCase):
    def scale(self, payload):
        return parse_pdf_stream(BytesIO(payload), 1)['printed_scale']

    def test_supported_ratios_match_preset_engine(self):
        self.assertEqual(PRINTED_SCALES, SCALE_DENOMINATORS)

    def test_unique_footer_beats_detail_caption_and_retains_text_position(self):
        result = self.scale(pdf(('SECTION SCALE 1:20', 50, 400), ('SCALE 1:100', 400, 35)))
        self.assertEqual(result, {'scale_denominator': 100, 'text': 'SCALE 1:100', 'points': [[400, 35], [400, 35]]})

    def test_separate_label_and_ratio_cells_same_or_next_line(self):
        for ratio in (('1:50', 455, 35), ('1:50', 400, 21)):
            with self.subTest(ratio=ratio):
                self.assertEqual(self.scale(pdf(('SCALE', 400, 35), ratio))['scale_denominator'], 50)

    def test_ambiguous_missing_unsupported_or_nonfooter_scale_is_not_guessed(self):
        for lines in ((('SCALE 1:100 / 1:50', 400, 35),),
                      (('SCALE 1:100', 400, 35), ('SCALE 1:50', 400, 70)),
                      (('SCALE AS SHOWN', 400, 35), ('SCALE 1:50', 400, 70)),
                      (('SCALE N.T.S.', 400, 35),), (('SCALE NOT TO SCALE', 400, 35),),
                      (('SCALE 1:500', 400, 35),), (('1:100', 400, 35),),
                      (('DETAIL SCALE 1:20', 400, 35),), (('SCALE 1/20 = 1 FOOT', 400, 35),),
                      (('SECTION A', 400, 65), ('SCALE 1:20', 400, 35)),
                      (('DETAIL 4', 345, 35), ('SCALE 1:20', 400, 35)),
                      (('ELEVATION B', 400, 85), ('SCALE', 400, 49), ('1:20', 400, 35)),
                      (('SCALE', 10, 35), ('1:100', 400, 35)),
                      (('SCALE 1:100', 50, 600),), ()):
            with self.subTest(lines=lines):
                self.assertIsNone(self.scale(pdf(*lines)))

    def test_declared_sheet_size_must_match_physical_pdf_user_unit(self):
        a3 = (420*72/25.4, 297*72/25.4)
        for unit in (1, 2):
            size = tuple(value/unit for value in a3)
            self.assertEqual(self.scale(pdf(('SCALE 1:100 @ A3', 100, 30), size=size, user_unit=unit))['scale_denominator'], 100)
        self.assertIsNone(self.scale(pdf(('SCALE 1:100 @ A1', 100, 30), size=a3)))
        self.assertIsNone(self.scale(pdf(('SCALE 1:100', 100, 35), ('SHEET SIZE A1', 800, 35), size=a3)))
        self.assertIsNone(self.scale(pdf(('SCALE 1:100', 100, 35), ('PAPER SIZE', 800, 49), ('A1', 800, 35), size=a3)))
        self.assertIsNone(self.scale(pdf(('SCALE 1:100 @ A6', 100, 30), size=a3)))
        self.assertIsNone(self.scale(pdf(('SCALE 1:100 @ A3', 100, 35), ('SHEET SIZE A1', 800, 35), size=a3)))
        accepted = self.scale(pdf(('SCALE 1:100', 100, 35), ('SHEET SIZE A3', 800, 35), size=a3))
        self.assertEqual(accepted['scale_denominator'], 100)
        self.assertEqual(accepted['text'], 'SCALE 1:100 | SHEET SIZE A3')

    def test_rotation_and_crop_use_visible_footer_coordinates(self):
        self.assertEqual(self.scale(pdf(('SCALE 1:75', 500, 200), rotation=90))['scale_denominator'], 75)
        self.assertIsNone(self.scale(pdf(('SCALE 1:75', 40, 35), crop=(0, 100, 600, 800))))

    def test_scale_detection_does_not_change_import_metadata(self):
        payload = pdf(('SCALE 1:100', 400, 35))
        before = parse_pdf_stream(BytesIO(payload))
        self.scale(payload)
        self.assertEqual(parse_pdf_stream(BytesIO(payload)), before)
        self.assertEqual(set(before['pages'][0]), {'page', 'width', 'height', 'view', 'media_box', 'crop_box', 'rotation', 'user_unit'})


class PrintedScaleWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.documents = TakeoffDocuments(root/'evidence')
        self.addCleanup(self.documents.close)
        self.service = TakeoffService(Store(root/'test.sqlite3'), self.documents)
        self.state = self.service.open(); self.sid = self.state['session_id']

    def upload(self, payload=None):
        payload = payload or pdf(('SCALE 1:100', 400, 35), user_unit=2)
        upload = self.documents.begin_upload(self.sid, 'source.pdf', len(payload))
        self.documents.write_chunk(self.sid, upload['upload_id'], 0, payload)
        self.document = self.documents.finish_upload(self.sid, upload['upload_id'])
        self.state = self.service.add_document(self.sid, self.document, self.state['revision'])
        return payload

    def request(self):
        return {'expected_revision': self.state['revision'], 'request_id': str(uuid4()), 'document_id': self.document['id'], 'page': 1}

    def command(self, op, **values):
        self.state = self.service.command(self.sid, {'op': op, 'request_id': str(uuid4()),
                                                   'expected_revision': self.state['revision'], **values})

    def test_scale_is_audited_exact_physical_distance_and_retry_is_idempotent(self):
        source = self.upload(); before = deepcopy(self.document)
        request = self.request()
        self.state = self.service.auto_calibrate(self.sid, request)
        calibration = self.state['snapshot']['calibrations'][0]
        self.assertEqual(self.state['auto_calibration'], {'status': 'applied', 'calibration_id': calibration['id']})
        self.assertAlmostEqual(calibration['distance_m'], 2*.0254*100)
        self.assertEqual(calibration['printed_scale_evidence'], {'source_sha256': self.document['sha256'],
            'text': 'SCALE 1:100', 'points': [[400, 35], [400, 35]], 'detector': 'pdf-footer-v1'})
        self.assertEqual(self.documents.get_blob(self.state['snapshot']['audit_head'])['op'], 'auto_calibrate')
        self.assertEqual(self.service.auto_calibrate(self.sid, request), self.state)
        self.assertEqual(self.state['snapshot']['documents'][0], before)
        self.assertEqual(self.documents.document_path(self.document).read_bytes(), source)
        validate_snapshot(self.state['snapshot'])

    def test_manual_revision_retains_original_evidence_but_uses_manual_basis(self):
        self.upload(); self.state = self.service.auto_calibrate(self.sid, self.request())
        original = deepcopy(self.state['snapshot']['calibrations'][0])
        self.command('update_calibration', calibration_id=original['id'], changes={'distance_m': 12, 'uniform_scale': True, 'scale_denominator': None})
        self.assertEqual(self.state['snapshot']['calibrations'][0], original)
        self.assertNotIn('printed_scale_evidence', self.state['snapshot']['calibrations'][-1])
        self.assertEqual(self.state['snapshot']['calibrations'][-1]['distance_m'], 12)

    def test_client_cannot_claim_extracted_provenance_in_manual_calibration(self):
        self.upload(); before = deepcopy(self.state['snapshot'])
        with self.assertRaisesRegex(ValidationError, 'created only by inspecting'):
            self.command('add_calibration', calibration={'id': str(uuid4()), 'document_id': self.document['id'], 'page': 1,
                'points': [[0, 0], [72, 0]], 'distance_m': 5.08, 'scale_denominator': 100, 'uniform_scale': True,
                'printed_scale_evidence': {'source_sha256': self.document['sha256'], 'text': 'SCALE 1:100',
                                           'points': [[400, 35], [400, 35]], 'detector': 'pdf-footer-v1'}})
        self.assertEqual(self.service.get(self.sid)['snapshot'], before)

    def test_existing_manual_or_viewport_scale_is_never_overridden(self):
        self.upload()
        for viewport in (False, True):
            with self.subTest(viewport=viewport):
                calibration = {'id': str(uuid4()), 'document_id': self.document['id'], 'page': 1,
                               'points': [[10, 20], [100, 20]], 'distance_m': 4, 'uniform_scale': True}
                if viewport:
                    calibration['region'] = [0, 0, 120, 120]
                self.command('add_calibration', calibration=calibration)
                before = deepcopy(self.state['snapshot'])
                with patch.object(self.documents, 'printed_scale') as parser:
                    result = self.service.auto_calibrate(self.sid, self.request())
                    parser.assert_not_called()
                self.assertEqual(result['auto_calibration'], {'status': 'existing'})
                self.assertEqual(result['snapshot'], before)

    def test_no_scale_returns_unchanged_snapshot_and_undo_removes_only_auto_scale(self):
        self.upload(pdf(('SCALE AS SHOWN', 400, 35)))
        before = deepcopy(self.state['snapshot'])
        result = self.service.auto_calibrate(self.sid, self.request())
        self.assertEqual(result['auto_calibration'], {'status': 'not_detected'})
        self.assertEqual(result['snapshot'], before)
        with patch.object(self.documents, 'printed_scale', return_value={'scale_denominator': 50, 'text': 'SCALE 1:50', 'points': [[400, 35], [400, 35]]}):
            self.state = self.service.auto_calibrate(self.sid, self.request())
        self.command('undo')
        self.assertEqual(self.state['snapshot']['calibrations'], [])
        self.assertEqual(self.state['snapshot']['documents'], before['documents'])

    def test_newer_user_choice_during_extraction_wins_and_stale_result_is_rejected(self):
        self.upload(); request = self.request()
        def extract(*args, **kwargs):
            self.command('add_calibration', calibration={'id': str(uuid4()), 'document_id': self.document['id'], 'page': 1,
                'points': [[0, 0], [72, 0]], 'distance_m': 7, 'uniform_scale': True})
            return {'scale_denominator': 100, 'text': 'SCALE 1:100', 'points': [[400, 35], [400, 35]]}
        with patch.object(self.documents, 'printed_scale', side_effect=extract), self.assertRaisesRegex(ValidationError, 'draft changed'):
            self.service.auto_calibrate(self.sid, request)
        current = self.service.get(self.sid)['snapshot']
        self.assertEqual(len(current['calibrations']), 1)
        self.assertEqual(current['calibrations'][0]['distance_m'], 7)

    def test_source_replacement_and_cross_session_page_are_rejected(self):
        self.upload(); other = self.service.open()
        request = {**self.request(), 'expected_revision': other['revision']}
        with self.assertRaisesRegex(ValidationError, 'does not exist'):
            self.service.auto_calibrate(other['session_id'], request)
        path = self.documents.document_path(self.document)
        path.write_bytes(pdf(('SCALE 1:50', 400, 35)))
        with self.assertRaises(ValidationError):
            self.service.auto_calibrate(self.sid, self.request())
        self.assertEqual(self.service.get(self.sid, verify_evidence=False)['snapshot']['calibrations'], [])

    def test_red_defaults_keep_explicit_saved_colours(self):
        original = {'mode': 'steel', 'appearance': {'stroke_color': '#123456', 'fill_color': '#654321'}}
        before = deepcopy(original)
        self.assertEqual(markup_appearance({'mode': 'steel'})['stroke_color'], '#FF0000')
        self.assertEqual(markup_appearance({'mode': 'steel'})['fill_color'], '#FF0000')
        self.assertEqual(markup_appearance(original)['stroke_color'], '#123456')
        self.assertEqual(markup_appearance(original)['fill_color'], '#654321')
        self.assertEqual(original, before)


if __name__ == '__main__':
    unittest.main()
