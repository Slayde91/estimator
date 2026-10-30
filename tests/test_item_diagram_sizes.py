"""PDF diagram dimensions shrink without resampling retained evidence."""
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from estimator.reference_library import ReferenceLibrary
from estimator.technical_item_exports import prepare_technical_item, render_technical_item_pdf
from estimator.penetration_item_exports import prepare_item_snapshot, render_item_pdf
from technical_item_fixture_data import technical_library
from test_penetration_item_exports import body, png, DiagramLibrary
import base64


def drawn_sizes(payload, source_size):
    sizes = []
    for page in PdfReader(BytesIO(payload)).pages:
        objects = page["/Resources"].get("/XObject", {})
        def visit(operator, operands, cm, tm):
            if operator != b"Do":
                return
            image = objects[operands[0]].get_object()
            if (image.get("/Width"), image.get("/Height")) == source_size:
                sizes.append((abs(cm[0]), abs(cm[3])))
        page.extract_text(visitor_operand_before=visit)
    return sizes


class ItemDiagramSizeTests(unittest.TestCase):
    def test_technical_pdf_uses_two_thirds_of_previous_fit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "library"
            technical_library(root)
            snapshot = prepare_technical_item({"id": "report-a-v1"}, library=ReferenceLibrary(root))
            payload = render_technical_item_pdf(snapshot)
        sizes = drawn_sizes(payload, (640, 360))
        self.assertEqual(len(sizes), 1)
        previous_scale = min((A4[0] - 64) / 640, 330 / 360)
        self.assertAlmostEqual(sizes[0][0], 640 * previous_scale * 2 / 3, places=3)
        self.assertAlmostEqual(sizes[0][1], 360 * previous_scale * 2 / 3, places=3)

    def test_firestopping_pdf_uses_two_thirds_of_previous_fit(self):
        value = body()
        value["diagram"] = {"filename": "Source.png", "content_base64": base64.b64encode(png()).decode()}
        snapshot = prepare_item_snapshot(value, library=DiagramLibrary(), default_configuration={})
        sizes = drawn_sizes(render_item_pdf(snapshot), (320, 160))
        self.assertEqual(len(sizes), 1)
        previous_scale = min((A4[0] - 64) / 320, 230 / 160)
        self.assertAlmostEqual(sizes[0][0], 320 * previous_scale * 2 / 3, places=3)
        self.assertAlmostEqual(sizes[0][1], 160 * previous_scale * 2 / 3, places=3)
