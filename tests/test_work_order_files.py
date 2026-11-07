import base64
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.commercial_documents import CommercialDocuments, default_fields
from tests.test_commercial_documents import Projects


class WorkOrderFileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.projects = Projects(self.root)
        self.workspace = self.projects.add()
        self.project = self.projects.project_id(self.workspace)
        self.store = CommercialDocuments(self.projects)
        quote = self.save('quote', terms='')
        self.quote = self.issue(quote)['document']

    def save(self, kind, **fields):
        values = default_fields(kind)
        values.update(fields)
        values['details']['project_no'] = 'PN-00001'
        if kind == 'work_order':
            values['order']['quote_id'] = self.quote['id']
        return self.store.save(self.workspace, {
            'id': str(uuid4()), 'version': 0, 'kind': kind, 'status': 'Draft', 'fields': values,
        })

    def issue(self, document, request=None):
        return self.store.issue(self.workspace, document['id'], document['version'], request or str(uuid4()))

    def upload(self, name, payload):
        encoded = base64.b64encode(payload).decode('ascii')
        return self.store.files.add(self.project, name, encoded)

    def test_pdf_image_and_video_follow_order_and_remain_portable(self):
        drawing = BytesIO()
        canvas = Canvas(drawing)
        canvas.drawString(50, 60, 'Original drawing detail')
        canvas.save()
        image = BytesIO()
        Image.new('RGB', (32, 16), 'red').save(image, 'PNG')
        originals = [('drawing.pdf', drawing.getvalue()), ('Site photo.png', image.getvalue()),
                     ('walkthrough.mp4', b'video content')]
        files = [self.upload(name, payload) for name, payload in originals]
        order = self.save('work_order', files=files)
        request = str(uuid4())
        issued = self.issue(order, request)
        pdf = PdfReader(BytesIO(issued['pdf']))
        count = len(pdf.pages)
        self.assertIn(f'Page 1 of {count}', pdf.pages[0].extract_text())
        self.assertIn('Original drawing detail', pdf.pages[-3].extract_text())
        self.assertNotIn('Page ', pdf.pages[-3].extract_text())
        self.assertIn(f'Page {count} of {count}', pdf.pages[-1].extract_text())
        self.assertIn('Site photo.png', pdf.pages[-2].extract_text())
        self.assertTrue(pdf.pages[-2].images)
        self.assertIn('walkthrough.mp4', pdf.pages[-1].extract_text())
        self.assertEqual(pdf.attachments['walkthrough.mp4'], [b'video content'])

        snapshot = self.store.capture(self.workspace)
        path = self.root / 'portable' / 'project.cf.json'
        self.store.files.transfer(snapshot, path)
        other = Projects(self.root / 'fresh-install')
        workspace = other.add(self.project)
        restored = CommercialDocuments(other)
        restored.files.transfer(snapshot, path, restore=True)
        restored.restore(workspace, snapshot)
        for item, (_, original) in zip(files, originals):
            self.assertEqual(restored.read_attachment(workspace, order['id'], item['id'])[1], original)
        (self.store.files.folder(self.project) / files[0]['id']).write_bytes(b'changed')
        self.assertEqual(self.issue(order, request)['pdf'], issued['pdf'])
        with self.assertRaises(ValidationError):
            self.store.files.read(self.project, files[0])

    def test_enforces_owner_file_and_metadata_integrity(self):
        item = self.upload('plans.txt', b'abc')
        for bad in (dict(item, size=2), dict(item, id='a' * 64)):
            with self.assertRaises(ValidationError):
                self.save('work_order', files=[bad])
        with self.assertRaises(ValidationError):
            self.store.files.read(str(uuid4()), item)
        for name in ('../plans.txt', 'folder/plans.txt', 'bad\nname.txt'):
            with self.assertRaises(ValidationError):
                self.upload(name, b'abc')
        order = self.save('work_order', files=[item])
        with self.assertRaises(ValidationError):
            self.store.read_attachment(self.workspace, self.quote['id'], item['id'])
        self.assertEqual(self.store.read_attachment(self.workspace, order['id'], item['id']), (item, b'abc'))
