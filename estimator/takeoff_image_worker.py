"""Disposable, non-authoritative PDF image evidence extraction.

Image XObject originals are their exact encoded stream payloads. Inline image
originals are exact decoded BI...EI spans plus every original encoded enclosing
content stream. pypdf's inline decoder payload can normalize whitespace and is
never described as the original. PNGs are explicit display derivatives, not page
composites. Occurrences are painting instructions, never physical quantities.
"""

from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import logging
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import warnings
from uuid import UUID, uuid4, uuid5

if __package__:
    from .takeoff_pdf_worker import MAX_DOCUMENT_SIZE, MAX_PAGES, restrict_process
else:
    # Support Python -I /trusted/package/takeoff_image_worker.py without adding
    # the current directory or a caller-controlled PYTHONPATH to import search.
    import importlib.util
    _spec = importlib.util.spec_from_file_location('_ceasefire_pdf_limits', Path(__file__).with_name('takeoff_pdf_worker.py'))
    _limits = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_limits)
    MAX_DOCUMENT_SIZE, MAX_PAGES, restrict_process = _limits.MAX_DOCUMENT_SIZE, _limits.MAX_PAGES, _limits.restrict_process

MAX_BATCH_PAGES = 25
MAX_OCCURRENCES = 512
MAX_OPERATORS = 50000
MAX_FORM_DEPTH = 32
MAX_METADATA_NODES = 10000
MAX_IMAGE_PIXELS = 16_000_000
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_CONTENT_BYTES = 32 * 1024 * 1024
NAMESPACE = UUID('556693a4-1814-58db-b45f-b692f3743143')
IDENTITY = [1, 0, 0, 1, 0, 0]
_HEX = re.compile(r'^[0-9a-f]{64}$')


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _id(value):
    return str(uuid5(NAMESPACE, sha256(_canonical(value)).hexdigest()))


def _issue(code, message):
    return {'code': code, 'message': message[:300]}


def _add_issue(issues, issue):
    if not any(existing['code'] == issue['code'] for existing in issues):
        if len(issues) >= 64:
            raise ValueError('The PDF appearance context exceeds its diagnostic limit.')
        issues.append(issue)


def _reference(value):
    ref = getattr(value, 'indirect_reference', None)
    if ref is None and hasattr(value, 'idnum'):
        ref = value
    return {'object': ref.idnum, 'generation': ref.generation} if ref is not None else None


def _resolved(value):
    return value.get_object() if hasattr(value, 'get_object') else value


def _matrix(value):
    if not isinstance(value, (list, tuple)) or len(value) != 6:
        raise ValueError('A painting transform requires six coordinates.')
    result = [float(entry) for entry in value]
    if not all(math.isfinite(entry) and abs(entry) <= 1e12 for entry in result):
        raise ValueError('A painting transform contains unsupported coordinates.')
    return result


def _compose(parent, local):
    a, b, c, d, e, f = parent
    g, h, i, j, k, l = local
    return _matrix([a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f])


def _quad(matrix, box=(0, 0, 1, 1)):
    a, b, c, d, e, f = matrix
    x0, y0, x1, y1 = box
    return [[a*x+c*y+e, b*x+d*y+f] for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


def _contained(points, boundary):
    for point in points:
        signs = []
        for a, b in zip(boundary, boundary[1:]+boundary[:1]):
            cross = (b[0]-a[0])*(point[1]-a[1]) - (b[1]-a[1])*(point[0]-a[0])
            if cross:
                signs.append(cross > 0)
        if signs and any(sign != signs[0] for sign in signs):
            return False
    return True


def _safe_parent(path):
    for component in (path, *path.parents):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400 or not stat.S_ISDIR(info.st_mode):
            raise ValueError('The private output parent must contain regular directories only.')


class _LogCapture(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.messages = []
        self.count = 0

    def emit(self, record):
        self.count += 1
        if len(self.messages) < 100:
            self.messages.append(_issue('PDF_PARSER_WARNING', record.getMessage()))
        elif len(self.messages) == 100:
            self.messages.append(_issue('WARNING_LIMIT', 'Additional parser warnings exceeded the diagnostic limit.'))


class _Extraction:
    def __init__(self, source_hash, output):
        self.source_hash, self.output = source_hash, output
        self.written, self.files, self.assets = 0, {}, {}
        self.occurrences = []
        self.nodes = 0
        self.operators = 0
        self.page_issues = []

    def blob(self, data, kind='originals', extension='bin'):
        if not isinstance(data, bytes):
            raise ValueError('Retained stream data must contain exact bytes.')
        digest = sha256(data).hexdigest()
        relative = f'{kind}/{digest}.{extension}'
        if relative not in self.files:
            if self.written + len(data) > MAX_OUTPUT_BYTES:
                raise ValueError('The image evidence output exceeds the bounded batch byte limit.')
            path = self.output / relative
            with path.open('xb') as target:
                target.write(data)
            self.files[relative] = len(data)
            self.written += len(data)
        return {'sha256': digest, 'size': len(data), 'relative_path': relative}

    def metadata(self, value, depth=0, ancestors=()):
        from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DictionaryObject,
                                    IndirectObject, NameObject, NullObject, StreamObject, TextStringObject)
        self.nodes += 1
        if self.nodes > MAX_METADATA_NODES or depth > 32:
            raise ValueError('Image metadata exceeds the bounded node/depth limit.')
        if isinstance(value, IndirectObject):
            ref = _reference(value)
            key = (value.idnum, value.generation)
            if key in ancestors:
                return {'type': 'reference', 'value': ref, 'cycle': True}
            return {'type': 'reference', 'value': ref, 'target': self.metadata(value.get_object(), depth+1, (*ancestors, key))}
        if isinstance(value, NullObject) or value is None:
            return {'type': 'null'}
        if isinstance(value, BooleanObject):
            return {'type': 'boolean', 'value': bool(value.value)}
        if isinstance(value, NameObject):
            return {'type': 'name', 'value': str(value)}
        if isinstance(value, ByteStringObject):
            return {'type': 'bytes', **self.blob(bytes(value))}
        if isinstance(value, TextStringObject):
            return {'type': 'text', 'value': str(value), 'original': self.blob(value.original_bytes)}
        if isinstance(value, (StreamObject, DictionaryObject)):
            result = {'type': 'stream' if isinstance(value, StreamObject) else 'dictionary',
                      'entries': {str(key): self.metadata(child, depth+1, ancestors) for key, child in sorted(value.items())}}
            if isinstance(value, StreamObject):
                result['encoded_stream'] = self.blob(value._data)
            return result
        if isinstance(value, (ArrayObject, list, tuple)):
            return {'type': 'array', 'items': [self.metadata(entry, depth+1, ancestors) for entry in value]}
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if not math.isfinite(value) or abs(value) > 1e12:
                raise ValueError('Image metadata contains unsupported numeric values.')
            return {'type': 'number', 'value': value}
        raise ValueError('An image has unsupported PDF metadata types.')

    def rendition(self, image, issues):
        from PIL import Image
        width, height = _resolved(image.get('/Width')), _resolved(image.get('/Height'))
        if (not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0
                or width * height > MAX_IMAGE_PIXELS):
            issues.append(_issue('IMAGE_PIXEL_LIMIT', 'The image has invalid dimensions or exceeds 16 megapixels; no resized substitute was created.'))
            return None
        from pypdf.generic import NullObject
        masks = [_resolved(image.get(key)) for key in ('/SMask', '/Mask')]
        image_mask = _resolved(image.get('/ImageMask', False))
        if (any(value is not None and not isinstance(value, NullObject) for value in masks)
                or getattr(image_mask, 'value', image_mask) or _resolved(image.get('/SMaskInData', 0))):
            issues.append(_issue('UNSUPPORTED_IMAGE_MASK', 'Image masks require independent compositing support. Original streams and mask metadata are retained.'))
            return None
        colors = _resolved(image.get('/ColorSpace'))
        if colors is None or str(colors) not in ('/DeviceGray', '/DeviceRGB'):
            issues.append(_issue('UNSUPPORTED_COLOR_SPACE', 'Only explicit DeviceGray and DeviceRGB display renditions are supported; original color metadata is retained.'))
            return None
        filters = _resolved(image.get('/Filter', []))
        filters = filters if isinstance(filters, list) else [filters]
        allowed = {'/FlateDecode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode',
                   '/DCTDecode', '/JPXDecode', '/CCITTFaxDecode'}
        if any(str(value) not in allowed for value in filters):
            issues.append(_issue('UNSUPPORTED_IMAGE_FILTER', 'The image filter has no approved in-process decoder; its original stream is retained.'))
            return None
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error')
                previous = Image.MAX_IMAGE_PIXELS
                Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
                try:
                    decoded = image.decode_as_image()
                    if decoded is None:
                        raise ValueError('No decoded image was returned.')
                    with decoded:
                        decoded.load()
                        if decoded.size != (width, height) or decoded.width * decoded.height > MAX_IMAGE_PIXELS:
                            raise ValueError('The decoded image dimensions do not match its retained source dictionary.')
                        if decoded.mode not in ('1', 'L', 'RGB', 'RGBA'):
                            raise ValueError('The decoder returned an unsupported display color mode.')
                        stream = BytesIO(); decoded.save(stream, format='PNG')
                        return {**self.blob(stream.getvalue(), 'renditions', 'png'), 'mime': 'image/png',
                                'width': width, 'height': height, 'derivative': True, 'page_composite': False}
                finally:
                    Image.MAX_IMAGE_PIXELS = previous
        except Exception:
            issues.append(_issue('IMAGE_DECODE_FAILED', 'The retained image could not be decoded faithfully within supported limits.'))
            return None

    def image(self, image, original, locator, page, path, matrix, clips, context_issues, name=None):
        if len(self.occurrences) >= MAX_OCCURRENCES:
            raise ValueError('The batch exceeds 512 image occurrences. Reduce the requested page range.')
        metadata = self.metadata(image)
        asset_id = _id([self.source_hash, original, locator, metadata])
        if asset_id not in self.assets:
            issues = []
            rendition = self.rendition(image, issues)
            if any(key in image for key in ('/OC', '/Alternates', '/OPI')):
                issues.append(_issue('UNSUPPORTED_IMAGE_APPEARANCE', 'Image optional visibility, alternate images or OPI replacement require independent appearance validation.'))
            self.assets[asset_id] = {'id': asset_id, 'original': original, 'source_locator': locator,
                                     'metadata': metadata, 'rendition': rendition, 'issues': issues}
        asset = self.assets[asset_id]
        quad = _quad(matrix)
        issues = [*context_issues, *asset['issues']]
        if any(not _contained(quad, clip['quad_pdf']) for clip in clips):
            issues.append(_issue('CLIPPED_IMAGE', 'The image extends outside a page/form clip. Its PNG is the full image, not a page composite.'))
        if matrix[0]*matrix[3]-matrix[1]*matrix[2] == 0:
            issues.append(_issue('DEGENERATE_PLACEMENT', 'The image painting transform has zero area.'))
        occurrence = {'id': _id([self.source_hash, page['page'], path]), 'asset_id': asset_id,
                      'page': page['page'], 'operator_path': path, 'resource_name': name,
                      'object_ref': _reference(image), 'ctm': matrix, 'quad_pdf': quad,
                      'page_boxes': {key: page[key] for key in ('media_box', 'crop_box', 'view')},
                      'rotation': page['rotation'], 'user_unit': page['user_unit'], 'clip_context': clips,
                      'appearance_status': 'unverified' if issues else 'decoded-asset', 'issues': issues}
        self.occurrences.append(occurrence)

    def content(self, contents, reader):
        from pypdf.generic import ArrayObject, ContentStream, DecodedStreamObject

        class ExactInlineContent(ContentStream):
            def _read_inline_image(self, stream):
                start = stream.tell()-2  # The parser has just read the BI token.
                value = super()._read_inline_image(stream)
                end = stream.tell()
                stream.seek(start); original = stream.read(end-start); stream.seek(end)
                if not original.startswith(b'BI') or not original.endswith(b'EI'):
                    raise ValueError('The inline image exact source span could not be established.')
                value['exact_span'] = original
                value['span_start'], value['span_end'] = start, end
                return value

        contents = contents.get_object() if hasattr(contents, 'get_object') else contents
        entries = list(contents) if isinstance(contents, (list, ArrayObject)) else [contents]
        chunks, sources, offset = [], [], 0
        for entry in entries:
            obj = entry.get_object()
            if '/F' in obj:
                raise ValueError('External-file PDF content streams are not supported.')
            encoded = self.blob(obj._data)
            decoded = obj.get_data()
            if len(decoded) + offset > MAX_CONTENT_BYTES:
                raise ValueError('Decoded page/form content exceeds the 32 MiB limit.')
            sources.append({'object_ref': _reference(entry), 'encoded_stream': encoded, 'metadata': self.metadata(obj),
                            'decoded_start': offset, 'decoded_end': offset+len(decoded)})
            chunks.append(decoded); offset += len(decoded)+1
        stream = DecodedStreamObject(); stream.set_data(b'\n'.join(chunks))
        return ExactInlineContent(stream, reader).operations, sources

    def walk(self, contents, resources, reader, page, path=(), matrix=None, clips=None, inherited=(), ancestors=()):
        from pypdf.generic import EncodedStreamObject, NameObject
        if len(ancestors) > MAX_FORM_DEPTH:
            raise ValueError('Nested PDF forms exceed the supported depth.')
        resources = _resolved(resources)
        fonts = _resolved(resources.get('/Font', {}))
        if any(_resolved(font).get('/Subtype') == '/Type3' for font in fonts.values()):
            _add_issue(self.page_issues, _issue('TYPE3_GLYPHS_UNINSPECTED', 'Page/form Type 3 glyph programs may paint additional images and require separate extraction.'))
        operations, sources = self.content(contents, reader)
        if self.operators + len(operations) > MAX_OPERATORS:
            raise ValueError('The page exceeds 50,000 content operators.')
        self.operators += len(operations)
        current = list(matrix or IDENTITY); current_clips = list(clips or []); contexts = list(inherited)
        color_spaces = _resolved(resources.get('/ColorSpace', {}))
        if any(name in color_spaces for name in ('/DefaultRGB', '/DefaultGray', '/DefaultCMYK')):
            issue = _issue('UNSUPPORTED_DEFAULT_COLOR_SPACE', 'Resource default color-space replacements require color-managed page validation; this derivative does not apply them.')
            _add_issue(contexts, issue); _add_issue(self.page_issues, issue)
        stack = []
        aliases = {'/W': '/Width', '/H': '/Height', '/BPC': '/BitsPerComponent', '/CS': '/ColorSpace',
                   '/F': '/Filter', '/DP': '/DecodeParms', '/D': '/Decode', '/IM': '/ImageMask', '/I': '/Interpolate'}
        names = {'/G': '/DeviceGray', '/RGB': '/DeviceRGB', '/CMYK': '/DeviceCMYK', '/AHx': '/ASCIIHexDecode',
                 '/A85': '/ASCII85Decode', '/LZW': '/LZWDecode', '/Fl': '/FlateDecode', '/RL': '/RunLengthDecode',
                 '/CCF': '/CCITTFaxDecode', '/DCT': '/DCTDecode'}
        def translated(value):
            from pypdf.generic import ArrayObject
            if isinstance(value, list):
                return ArrayObject([translated(entry) for entry in value])
            return NameObject(names.get(str(value), str(value))) if isinstance(value, NameObject) else value
        for index, (operands, operator) in enumerate(operations):
            occurrence_path = [*path, index]
            if operator == b'q':
                if len(stack) >= 128:
                    raise ValueError('The PDF graphics-state stack exceeds its limit.')
                stack.append((list(current), list(current_clips), list(contexts)))
            elif operator == b'Q':
                if not stack:
                    raise ValueError('The PDF graphics-state stack is unbalanced.')
                current, current_clips, contexts = stack.pop()
            elif operator == b'cm':
                current = _compose(current, _matrix(operands))
            elif operator == b'Tr':
                if len(operands) != 1 or operands[0] not in range(8):
                    raise ValueError('The PDF text rendering mode is unsupported.')
                if operands[0] >= 4:
                    issue = _issue('UNSUPPORTED_TEXT_CLIPPING', 'Text rendering modes that clip by glyph outlines require page-composite validation.')
                    _add_issue(contexts, issue); _add_issue(self.page_issues, issue)
            elif operator in (b'W', b'W*', b'gs', b'BDC', b'scn', b'SCN', b'sh'):
                code = 'UNSUPPORTED_CLIPPING' if operator in (b'W', b'W*') else 'UNSUPPORTED_APPEARANCE_CONTEXT'
                issue = _issue(code, 'Clipping, optional content, graphics effects or pattern painting requires page-composite validation.')
                _add_issue(contexts, issue)
                _add_issue(self.page_issues, issue)
            elif operator == b'INLINE IMAGE':
                image = EncodedStreamObject(); image._data = operands['data']
                image[NameObject('/Subtype')] = NameObject('/Image')
                for key, value in operands['settings'].items():
                    image[NameObject(aliases.get(str(key), str(key)))] = translated(value)
                colors = image.get('/ColorSpace')
                if colors is not None and str(colors) not in ('/DeviceRGB', '/DeviceGray', '/DeviceCMYK'):
                    resolved = _resolved(resources.get('/ColorSpace', {})).get(str(colors))
                    if resolved is not None:
                        image[NameObject('/ColorSpace')] = resolved.get_object()
                original = {**self.blob(operands['exact_span']), 'kind': 'inline-decoded-content-span',
                            'enclosing_streams': sources, 'decoded_start': operands['span_start'], 'decoded_end': operands['span_end'],
                            'decoder_payload': {**self.blob(operands['data'], 'decoder', 'bin'), 'may_be_normalized': True}}
                locator = {'kind': 'inline', 'page': page['page'], 'operator_path': occurrence_path,
                           'original_settings': self.metadata(operands['settings'])}
                self.image(image, original, locator, page, occurrence_path, current, current_clips, contexts)
            elif operator == b'Do':
                if len(operands) != 1:
                    raise ValueError('A PDF XObject painting instruction is malformed.')
                name = str(operands[0]); xobjects = _resolved(resources.get('/XObject', {}))
                if name not in xobjects:
                    raise ValueError('A painted PDF XObject is missing.')
                ref = xobjects.raw_get(name) if hasattr(xobjects, 'raw_get') else xobjects[name]
                obj = ref.get_object()
                if '/F' in obj:
                    raise ValueError('External-file PDF image/form streams are not supported.')
                if obj.get('/Subtype') == '/Image':
                    original = {**self.blob(obj._data), 'kind': 'encoded-image-stream'}
                    self.image(obj, original, {'kind': 'xobject', 'object_ref': _reference(ref)}, page,
                               occurrence_path, current, current_clips, contexts, name)
                elif obj.get('/Subtype') == '/Form':
                    identity = _reference(ref)
                    key = tuple(identity.values()) if identity else id(obj)
                    if key in ancestors:
                        raise ValueError('A PDF form recursively paints itself.')
                    transform = _compose(current, _matrix(obj.get('/Matrix', IDENTITY)))
                    box = [float(value) for value in obj.get('/BBox', [])]
                    if len(box) != 4 or not all(math.isfinite(value) and abs(value) <= 1e12 for value in box) or box[2] <= box[0] or box[3] <= box[1]:
                        raise ValueError('A PDF form has an invalid bounding box.')
                    child_clips = [*current_clips, {'kind': 'form-bbox', 'object_ref': identity, 'quad_pdf': _quad(transform, box)}]
                    child_context = list(contexts)
                    if '/Group' in obj or '/OC' in obj:
                        _add_issue(child_context, _issue('UNSUPPORTED_FORM_APPEARANCE', 'Transparency or optional-content form appearance needs page-composite validation.'))
                    self.walk(obj, obj.get('/Resources', resources), reader, page, [*occurrence_path, name], transform,
                              child_clips, child_context, (*ancestors, key))
                else:
                    raise ValueError('The PDF paints an unsupported XObject subtype.')
        if stack:
            raise ValueError('The PDF graphics-state stack is unbalanced.')


def extract_images(source_path, output_path, expected_sha256, first_page=1, page_count=1):
    """Call only in a bounded disposable child for untrusted input.

Tests may call this directly with synthetic fixtures. Every integration caller
must independently verify returned hashes/paths and treat any issue as blocked.
"""
    if not isinstance(expected_sha256, str) or not _HEX.fullmatch(expected_sha256):
        raise ValueError('An exact expected PDF SHA-256 is required.')
    if type(first_page) is not int or first_page < 1 or type(page_count) is not int or not 1 <= page_count <= MAX_BATCH_PAGES:
        raise ValueError('Choose a positive page range of at most 25 pages.')
    output = Path(output_path).absolute()
    _safe_parent(output.parent)
    if output.exists() or output.is_symlink():
        raise ValueError('Image extraction requires a new private output directory.')
    with tempfile.TemporaryFile(mode='w+b') as snapshot:
        checksum, size = sha256(), 0
        with Path(source_path).open('rb') as source:
            while chunk := source.read(1024*1024):
                size += len(chunk)
                if size > MAX_DOCUMENT_SIZE:
                    raise ValueError('The PDF exceeds 250 MiB.')
                checksum.update(chunk); snapshot.write(chunk)
        if checksum.hexdigest() != expected_sha256:
            raise ValueError('The PDF source does not match its expected SHA-256.')
        snapshot.seek(0)
        if snapshot.read(5) != b'%PDF-':
            raise ValueError('The source must be a PDF.')
        snapshot.seek(0)
        from pypdf import PdfReader, __version__ as pypdf_version
        from PIL import __version__ as pillow_version
        logger = logging.getLogger('pypdf'); capture = _LogCapture(); logger.addHandler(capture)
        try:
            reader = PdfReader(snapshot, strict=True)
            if reader.is_encrypted:
                raise ValueError('Encrypted image evidence is not supported.')
            total = len(reader.pages)
            if not 1 <= total <= MAX_PAGES or first_page > total or first_page+page_count-1 > total:
                raise ValueError('The requested source pages are unavailable or exceed 2,000 pages.')
            requested = list(range(first_page, first_page+page_count))
            output.mkdir()
            for name in ('originals', 'renditions', 'decoder'):
                (output/name).mkdir()
            extraction = _Extraction(expected_sha256, output)
            manifest = {'version': 1, 'source': {'sha256': expected_sha256, 'size': size, 'page_count': total},
                        'extraction': {'id': str(uuid4()), 'at': datetime.now(timezone.utc).isoformat(), 'engine': 'takeoffs-image-evidence-v1',
                                       'pypdf_version': pypdf_version, 'pillow_version': pillow_version}, 'pages': [], 'issues': []}
            for number in requested:
                page = reader.pages[number-1]
                start = len(extraction.occurrences); warning_start = len(capture.messages); warning_count = capture.count
                entry = {'page': number, 'status': 'complete', 'occurrence_ids': [], 'issues': []}
                extraction.operators = 0
                extraction.page_issues = []
                try:
                    media, crop = [float(v) for v in page.mediabox], [float(v) for v in page.cropbox]
                    view = [max(media[0], crop[0]), max(media[1], crop[1]), min(media[2], crop[2]), min(media[3], crop[3])]
                    rotation, unit = float(page.get('/Rotate', 0)), float(page.get('/UserUnit', 1))
                    if not all(math.isfinite(v) and abs(v) <= 1e9 for v in (*media, *crop, rotation, unit)) or rotation % 90 or not 0 < unit <= 75000 or view[2] <= view[0] or view[3] <= view[1]:
                        raise ValueError('The source page geometry is unsupported.')
                    metadata = {'page': number, 'media_box': media, 'crop_box': crop, 'view': view, 'rotation': int(rotation)%360, 'user_unit': unit}
                    if page.get('/Annots'):
                        entry['issues'].append(_issue('ANNOTATION_APPEARANCES_UNINSPECTED', 'Annotation/stamp appearances may contain additional images and require separate extraction.'))
                    resources = _resolved(page.get('/Resources', {}))
                    if '/Group' in page or '/OC' in page:
                        entry['issues'].append(_issue('UNSUPPORTED_PAGE_APPEARANCE', 'Page transparency or optional-content groups require page-composite validation.'))
                    if '/Contents' in page:
                        extraction.walk(page.raw_get('/Contents'), page.get('/Resources', {}), reader, metadata,
                                        clips=[{'kind': 'page-crop', 'quad_pdf': _quad(IDENTITY, view)}])
                except Exception as error:
                    entry['status'] = 'failed'
                    entry['issues'].append(_issue('PAGE_EXTRACTION_FAILED', str(error) if isinstance(error, ValueError) else 'The source page could not be extracted safely.'))
                occurrences = extraction.occurrences[start:]
                entry['occurrence_ids'] = [value['id'] for value in occurrences]
                entry['issues'].extend(capture.messages[warning_start:])
                if capture.count > warning_count and len(capture.messages) == warning_start:
                    entry['issues'].append(_issue('WARNING_LIMIT', 'This page emitted parser warnings after the diagnostic detail limit.'))
                entry['issues'].extend(extraction.page_issues)
                if any(value['issues'] for value in occurrences):
                    entry['issues'].append(_issue('UNVERIFIED_IMAGE_APPEARANCE', 'One or more image appearances or renditions are unresolved.'))
                if entry['issues'] and entry['status'] == 'complete':
                    entry['status'] = 'partial'
                manifest['pages'].append(entry)
            manifest['assets'] = list(extraction.assets.values()); manifest['occurrences'] = extraction.occurrences
            manifest['files'] = [{'relative_path': name, 'sha256': Path(name).stem, 'size': size}
                                 for name, size in sorted(extraction.files.items())]
            manifest['issues'].extend(capture.messages)
            manifest['coverage'] = {'requested_pages': requested, 'processed_pages': [page['page'] for page in manifest['pages']],
                                    'complete_pages': [page['page'] for page in manifest['pages'] if page['status'] == 'complete'],
                                    'failed_pages': [page['page'] for page in manifest['pages'] if page['status'] != 'complete'],
                                    'unrequested_pages': [number for number in range(1, total+1) if number not in requested]}
            if manifest['coverage']['failed_pages']:
                manifest['issues'].append(_issue('INCOMPLETE_IMAGE_COVERAGE', 'At least one requested page has incomplete or unverified image evidence.'))
            if manifest['coverage']['unrequested_pages']:
                manifest['issues'].append(_issue('PARTIAL_DOCUMENT_RANGE', 'This batch does not cover every page of the source PDF.'))
            if len(_canonical(manifest)) > MAX_MANIFEST_BYTES:
                raise ValueError('The image evidence manifest exceeds 16 MiB.')
            return manifest
        finally:
            logger.removeHandler(capture)


def main():
    try:
        restrict_process()
        if len(sys.argv) != 6:
            raise ValueError('Supply source, new output directory, expected SHA-256, first page and page count.')
        result = extract_images(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]))
    except Exception as error:
        result = {'error': str(error)[:300] if isinstance(error, (ValueError, RuntimeError)) else 'Image evidence could not be extracted safely.'}
    sys.stdout.buffer.write(_canonical(result))


if __name__ == '__main__':
    main()
