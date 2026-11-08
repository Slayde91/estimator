"""Portable, content-addressed commercial files and their PDF appendices."""
import base64
import binascii
import hashlib
from io import BytesIO
import mimetypes
import os
from pathlib import Path
import re
import tempfile
from uuid import UUID
from xml.sax.saxutils import escape

from .catalog import ValidationError
from .evidence_files import _directory, _open_regular

MAX_FILE = 12 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_FILES = 16


def filename(value):
    if (not isinstance(value, str) or not value.strip() or len(value) > 200 or value in {'.', '..'}
            or any(ord(ch) < 32 or ch in '/\\' for ch in value)):
        raise ValidationError('Choose a file with a valid name.')
    return value


def validate_files(items):
    if not isinstance(items, list) or len(items) > MAX_FILES:
        raise ValidationError('A commercial document supports up to 16 attached files.')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {'id', 'name', 'size', 'mime'}:
            raise ValidationError('Invalid commercial document file metadata.')
        filename(item['name'])
        digest, size, mime = item['id'], item['size'], item['mime']
        if (not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest) or digest in seen
                or type(size) is not int or not 0 <= size <= MAX_FILE
                or not isinstance(mime, str) or len(mime) > 160
                or not re.fullmatch(r'[a-zA-Z0-9.+_-]+/[a-zA-Z0-9.+_-]+', mime)):
            raise ValidationError('Invalid or duplicate commercial document file.')
        seen.add(digest)
    if sum(item['size'] for item in items) > MAX_TOTAL:
        raise ValidationError('Document files exceed the 32 MiB total limit.')
    return [dict(item) for item in items]


def _owner(project):
    try:
        if str(UUID(project)) == project:
            return project
    except (ValueError, TypeError, AttributeError):
        pass
    raise ValidationError('Choose a valid project for this attachment.')


def _read(folder, digest):
    if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValidationError('Invalid attachment identifier.')
    with _open_regular(Path(folder) / digest, MAX_FILE, allow_empty=True) as source:
        payload = source.read(MAX_FILE + 1)
    if hashlib.sha256(payload).hexdigest() != digest:
        raise ValidationError('The document attachment has changed. Restore its original file.')
    return payload


def _put(folder, digest, payload):
    directory = _directory(folder, create=True)
    target = directory / digest
    if target.exists() or target.is_symlink():
        _read(directory, digest)
        return
    temporary = tempfile.NamedTemporaryFile(dir=directory, delete=False)
    try:
        with temporary:
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary.name, target)
    finally:
        Path(temporary.name).unlink(missing_ok=True)


class WorkOrderFiles:
    def __init__(self, root):
        self.root = Path(root)

    def folder(self, project):
        return self.root / _owner(project)

    def add(self, project, name, encoded):
        name = filename(name)
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_FILE + 2) // 3):
            raise ValidationError('Each document file must be 12 MiB or smaller.')
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValidationError('The attachment could not be decoded.') from error
        if len(payload) > MAX_FILE:
            raise ValidationError('Each document file must be 12 MiB or smaller.')
        digest = hashlib.sha256(payload).hexdigest()
        _put(self.folder(project), digest, payload)
        return {'id': digest, 'name': name, 'size': len(payload),
                'mime': mimetypes.guess_type(name)[0] or 'application/octet-stream'}

    def read(self, project, item):
        payload = _read(self.folder(project), item['id'])
        if len(payload) != item['size']:
            raise ValidationError('The saved attachment size does not match its file.')
        return payload

    def transfer(self, snapshot, project_path, *, restore=False):
        if not snapshot:
            return
        items = {item['id']: item for doc in snapshot['documents'] if doc['kind'] in {'quote', 'work_order', 'purchase_order'}
                 for item in doc['fields'].get('files', [])}
        if not items:
            return
        project = _owner(snapshot['project_id'])
        # Retain the existing companion directory for backward compatibility;
        # the shared file store now serves all three commercial document kinds.
        portable = Path(project_path).parent / '.ceasefire-evidence' / project / 'work-order-files'
        source, target = (portable, self.folder(project)) if restore else (self.folder(project), portable)
        for digest, item in items.items():
            if restore and (target / digest).exists():
                self.read(project, item)
                continue
            payload = _read(source, digest)
            if len(payload) != item['size']:
                raise ValidationError('The document companion file has the wrong size.')
            _put(target, digest, payload)

    def append_to(self, result, project, items):
        """Append printable pages and originals; return page indices belonging to source PDFs."""
        from pypdf import PdfReader
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.utils import ImageReader
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.platypus import Paragraph
        from reportlab.pdfgen.canvas import Canvas
        from PIL import Image, ImageOps
        from .pdf_cover import _check_passive_content
        from .pdf_fonts import FONT_REGULAR, FONT_BOLD, register_pdf_fonts
        register_pdf_fonts()
        original_pages = set()
        for item in items:
            payload = self.read(project, item)
            source = None
            if payload.startswith(b'%PDF-'):
                try:
                    reader = PdfReader(BytesIO(payload))
                    if not reader.is_encrypted and 0 < len(reader.pages) <= 100:
                        _check_passive_content(reader)
                        source = reader
                except Exception:
                    # Preserve an opaque PDF as an embedded original, without importing active elements.
                    source = None
            if source is not None:
                for page in source.pages:
                    original_pages.add(len(result.pages))
                    result.add_page(page)
                continue
            image = None
            if item['mime'].startswith('image/'):
                try:
                    with Image.open(BytesIO(payload)) as opened:
                        if opened.width * opened.height <= 24_000_000:
                            image = ImageOps.exif_transpose(opened).convert('RGBA')
                except (OSError, ValueError, Image.DecompressionBombError):
                    pass
            buffer = BytesIO()
            page = Canvas(buffer, pagesize=A4)
            page.setFont(FONT_BOLD, 14)
            page.drawString(40, A4[1] - 54, 'Work order attachment')
            label = Paragraph(escape(item['name']), ParagraphStyle('FileName', fontName=FONT_REGULAR, fontSize=11, leading=14))
            _, height = label.wrap(A4[0] - 80, 150)
            label.drawOn(page, 40, A4[1] - 72 - height)
            if image is None:
                page.setFont(FONT_REGULAR, 10)
                page.drawString(40, A4[1] - 108 - height, 'The original file is included in the PDF attachments.')
                result.add_attachment(item['name'], payload)
            else:
                page.drawImage(ImageReader(image), 40, 40, width=A4[0] - 80, height=A4[1] - 150 - height,
                               preserveAspectRatio=True, anchor='c', mask='auto')
                image.close()
            page.save()
            result.add_page(PdfReader(BytesIO(buffer.getvalue())).pages[0])
        return original_pages
