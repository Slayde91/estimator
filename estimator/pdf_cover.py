"""Validated company cover pages, applied once at a PDF download boundary."""
import base64
import binascii
from io import BytesIO
from urllib.parse import urlsplit

from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError, PdfStreamError
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject

from .catalog import ValidationError

MAX_COVER_BYTES = 10 * 1024 * 1024
MAX_COVER_PAGES = 25
MAX_COVER_OBJECTS = 50_000
_MESSAGE = 'Choose a valid, unencrypted PDF cover sheet, up to 10 MB and 25 pages.'
_ACTIVE_KEYS = {'/OpenAction', '/AA', '/JavaScript', '/JS', '/EmbeddedFiles', '/EmbeddedFile', '/XFA'}
_ACTIVE_ACTIONS = {'/JavaScript', '/Launch', '/GoToR', '/GoToE', '/Rendition', '/RichMediaExecute',
                   '/ImportData', '/SubmitForm'}
_ACTIVE_ANNOTATIONS = {'/FileAttachment', '/RichMedia', '/Movie', '/Sound', '/Screen', '/3D'}


def _reader(payload, *, strict=True):
    if not isinstance(payload, bytes) or not payload.startswith(b'%PDF-'):
        raise ValueError('PDF header')
    reader = PdfReader(BytesIO(payload), strict=strict)
    if reader.is_encrypted:
        raise ValueError('encrypted PDF')
    return reader


def _check_passive_content(reader):
    """Check reachable objects without decompressing image/content streams.

    Page/resource references contain cycles. Bound the walk and dereference each
    source object once; links to ordinary web/email addresses remain usable.
    """
    pending = [reader.trailer]
    indirect, direct = set(), set()
    while pending:
        if len(indirect) + len(direct) > MAX_COVER_OBJECTS:
            raise ValueError('PDF object limit')
        value = pending.pop()
        if isinstance(value, IndirectObject):
            key = (value.idnum, value.generation)
            if key in indirect:
                continue
            indirect.add(key)
            pending.append(value.get_object())
        elif isinstance(value, (DictionaryObject, ArrayObject)):
            key = id(value)
            if key in direct:
                continue
            direct.add(key)
            if isinstance(value, DictionaryObject):
                if _ACTIVE_KEYS.intersection(value) or value.get('/S') in _ACTIVE_ACTIONS or value.get('/Subtype') in _ACTIVE_ANNOTATIONS:
                    raise ValueError('active PDF content')
                if '/URI' in value and urlsplit(str(value['/URI'])).scheme.lower() not in ('http', 'https', 'mailto'):
                    raise ValueError('unsafe PDF link')
                pending.extend(value.values())
            else:
                pending.extend(value)


def decode_cover_pdf(value):
    if not isinstance(value, str) or len(value) > MAX_COVER_BYTES * 4 // 3 + 100:
        raise ValidationError(_MESSAGE)
    prefix, separator, encoded = value.partition(',')
    if not separator or prefix != 'data:application/pdf;base64':
        raise ValidationError(_MESSAGE)
    try:
        payload = base64.b64decode(encoded, validate=True)
        if not payload or len(payload) > MAX_COVER_BYTES:
            raise ValueError('PDF size')
        reader = _reader(payload)
        _check_passive_content(reader)
        count = reader.trailer['/Root']['/Pages'].get('/Count')
        if not isinstance(count, int) or not 1 <= count <= MAX_COVER_PAGES:
            raise ValueError('declared PDF page count')
        if not 1 <= len(reader.pages) <= MAX_COVER_PAGES:
            raise ValueError('PDF page count')
        # Access each page's geometry now. An invalid page cannot become a
        # persistent failure in every later PDF download.
        for page in reader.pages:
            box = page.mediabox
            if not (0 < float(box.width) <= 14_400 and 0 < float(box.height) <= 14_400):
                raise ValueError('PDF page dimensions')
        return payload
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, NotImplementedError, RecursionError, OverflowError,
            binascii.Error, PdfReadError, PdfStreamError, OSError) as error:
        raise ValidationError(_MESSAGE + ' The cover must not contain scripts, automatic actions or attachments.') from error


def validate_cover_pdf(value, filename=''):
    if (not isinstance(filename, str) or len(filename) > 200
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in filename)
            or any(char in filename for char in '/\\')):
        raise ValidationError('The PDF cover-sheet filename is invalid.')
    if value is None:
        return None, ''
    decode_cover_pdf(value)
    return value, filename.strip() or 'Cover sheet.pdf'


def prepend_cover_pdf(payload, company=None, download_cover=None):
    """Return a covered copy; callers retain originals and freeze revisions.

    The function is intentionally not implicitly idempotent: identical cover
    artwork could occur inside a genuine report. Download routing owns the
    exactly-once policy and bypasses this for stored, already-covered revisions.
    """
    covers = [entry.get('cover_pdf') for entry in (company or {}, download_cover or {}) if entry.get('cover_pdf')]
    if not covers:
        return payload
    # These are two explicitly assigned positions, even when their bytes are
    # identical: company main first, download-specific second, content last.
    cover_bytes = [decode_cover_pdf(cover) for cover in covers]
    try:
        writer = PdfWriter()
        for data in cover_bytes:
            writer.append(_reader(data), import_outline=False)
        body = _reader(payload, strict=False)
        writer.append(body)
        if body.metadata:
            writer.add_metadata({key: value for key, value in body.metadata.items() if isinstance(value, str)})
        output = BytesIO()
        writer.write(output)
        return output.getvalue()
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, NotImplementedError, RecursionError, OverflowError,
            PdfReadError, PdfStreamError, OSError) as error:
        raise ValidationError('The PDF could not be combined with the saved cover sheet. The original report has not been changed.') from error
