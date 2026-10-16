"""The browser PDF checker accepts serializer rounding, not misplaced geometry."""
from pathlib import Path
import runpy
import tempfile
import unittest

from reportlab.pdfgen.canvas import Canvas


CHECKER = runpy.run_path(str(Path(__file__).parent / 'browser' / 'graphics_export_content.py'))
SOURCE_Y = 1367.5741871161313


class GraphicsExportContentTests(unittest.TestCase):
    def test_serialized_matrix_keeps_exact_orientation_scale_and_translation(self):
        expected = [1, 0, 0, 1, 100, SOURCE_Y]
        emitted = [1, 0, 0, 1, 100, 1367.574]
        self.assertFalse(CHECKER['near'](emitted, expected), 'Old absolute tolerance rejects valid emitted tokens')
        self.assertTrue(CHECKER['serialized_geometry'](emitted, expected))
        for wrong in [
            [1, 0, 0, 1, 100, 1367.575],
            [1, 0, 0, 1, 100, 1367.57401],
            [1.001, 0, 0, 1, 100, 1367.574],
            [0, -1, 1, 0, 100, 1367.574],
            [1, 0, 0, 1, 100],
        ]:
            with self.subTest(actual=wrong):
                self.assertFalse(CHECKER['serialized_geometry'](wrong, expected))

    def textbox_pdf(self, directory, translation=0):
        path = Path(directory) / 'textbox.pdf'
        pdf = Canvas(str(path), pagesize=(2000, 2000), pageCompression=0)
        pdf.setStrokeColorRGB(1, 0, 0)
        pdf.setLineWidth(1)
        pdf.transform(1, 0, 0, 1, 100, SOURCE_Y + translation)
        pdf.rect(0, 0, 100, 20, stroke=1, fill=0)
        pdf.drawString(0, 0, 'Serialized textbox')
        pdf.showPage()
        pdf.save()
        return path

    def specification(self):
        return {
            'physical': False,
            'rotations': {},
            'document': {'pages': [{'page': 1, 'view': [0, 0, 2000, 2000], 'user_unit': 1, 'rotation': 0}]},
            'records': [{
                'id': 'serialization-fixture', 'kind': 'textbox', 'page': 1,
                'text': 'Serialized textbox',
                'appearance': {'stroke_color': '#FF0000', 'stroke_width': 1, 'font_size': 12},
                'geometry': {'quad_pdf': [[100, SOURCE_Y + 20], [200, SOURCE_Y + 20], [200, SOURCE_Y], [100, SOURCE_Y]]},
            }],
        }

    def test_actual_pdf_accepts_magnitude_dependent_serialization(self):
        with tempfile.TemporaryDirectory() as directory:
            proof = CHECKER['inspect'](self.textbox_pdf(directory), self.specification())
        self.assertEqual(proof['matches'], [{'id': 'serialization-fixture', 'kind': 'textbox', 'page': 1, 'vector_geometry': True}])

    def test_actual_pdf_still_rejects_a_moved_textbox(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(AssertionError, 'Actual PDF geometry does not match source coordinates for textbox'):
                CHECKER['inspect'](self.textbox_pdf(directory, translation=.001), self.specification())


if __name__ == '__main__':
    unittest.main()
