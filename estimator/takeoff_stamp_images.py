"""Bounded local raster payloads for PDF-only image stamps; no URLs or paths."""
import base64
import binascii
from hashlib import sha256
from io import BytesIO
import warnings
import struct

from PIL import Image, ImageOps, UnidentifiedImageError

from .catalog import ValidationError
from .takeoff_model import object_fields

MAX_STAMP_IMAGE_BYTES = 2 * 1024 * 1024
MAX_STAMP_IMAGE_SIDE = 4096
MAX_STAMP_IMAGE_PIXELS = 4_000_000
MAX_STAMP_PROJECT_IMAGE_BYTES = 8 * 1024 * 1024
MAX_STAMP_PROJECT_IMAGE_PIXELS = 16_000_000
UPLOAD_FIELDS = {'mime_type', 'content_base64'}
IMAGE_FIELDS = UPLOAD_FIELDS | {'version', 'width', 'height', 'sha256'}


def _payload(value):
    content = value['content_base64']
    if not isinstance(content, str) or not 0 < len(content) <= ((MAX_STAMP_IMAGE_BYTES + 2) // 3) * 4:
        raise ValidationError('A Stamp image must contain at most 2 MiB of local PNG or JPEG bytes.')
    try:
        data = base64.b64decode(content, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValidationError('The Stamp image contains invalid base64 bytes.') from error
    if not 0 < len(data) <= MAX_STAMP_IMAGE_BYTES or base64.b64encode(data).decode('ascii') != content:
        raise ValidationError('The Stamp image requires bounded canonical base64 bytes.')
    return data


def _decode(data, mime):
    if mime not in ('image/png', 'image/jpeg'):
        raise ValidationError('Choose a local PNG or JPEG Stamp image.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data), formats=('PNG', 'JPEG')) as opened:
                if opened.format != {'image/png': 'PNG', 'image/jpeg': 'JPEG'}[mime]:
                    raise ValidationError('The Stamp image MIME type must match its actual PNG or JPEG bytes.')
                width, height = opened.size
                if (not 1 <= width <= MAX_STAMP_IMAGE_SIDE or not 1 <= height <= MAX_STAMP_IMAGE_SIDE
                        or width * height > MAX_STAMP_IMAGE_PIXELS or getattr(opened, 'n_frames', 1) != 1):
                    raise ValidationError('A Stamp image requires one frame, at most 4096 pixels per side and 4 million pixels.')
                image = ImageOps.exif_transpose(opened)
                image.load()
                return image.convert('RGBA' if image.mode in ('RGBA', 'LA') or 'transparency' in image.info else 'RGB')
    except ValidationError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
        raise ValidationError('The Stamp image is not a valid bounded PNG or JPEG image.') from error


def normalize_stamp_image(value):
    # A reusable template can supply its previously normalized canonical record.
    if isinstance(value, dict) and set(value) == IMAGE_FIELDS:
        validate_stamp_image(value)
        return dict(value)
    object_fields(value, UPLOAD_FIELDS, 'Stamp image upload', UPLOAD_FIELDS)
    image = _decode(_payload(value), value['mime_type'])
    output = BytesIO()
    # New image has no source EXIF, ICC profile, comments or auxiliary chunks.
    clean = Image.new(image.mode, image.size)
    clean.paste(image)
    clean.save(output, format='PNG', compress_level=6)
    data = output.getvalue()
    if len(data) > MAX_STAMP_IMAGE_BYTES:
        raise ValidationError('The normalized Stamp image exceeds 2 MiB. Choose a smaller image.')
    return {'version': 1, 'mime_type': 'image/png', 'content_base64': base64.b64encode(data).decode('ascii'),
            'width': clean.width, 'height': clean.height, 'sha256': sha256(data).hexdigest()}


def validate_stamp_image(value):
    object_fields(value, IMAGE_FIELDS, 'Stored Stamp image', IMAGE_FIELDS)
    if type(value['version']) is not int or value['version'] != 1 or value['mime_type'] != 'image/png':
        raise ValidationError('A stored Stamp image requires normalized PNG version one.')
    data = _payload(value)
    # Canonical records contain only pixels, never source metadata/auxiliary data.
    position, chunks = 8, []
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValidationError('A stored Stamp image requires normalized PNG bytes.')
    while position < len(data):
        if position+12 > len(data):
            raise ValidationError('The stored Stamp PNG has a truncated chunk.')
        length = struct.unpack('>I', data[position:position+4])[0]
        kind = data[position+4:position+8]
        if kind not in (b'IHDR', b'IDAT', b'IEND') or position+12+length > len(data):
            raise ValidationError('Stored Stamp PNGs must contain only bounded normalized pixel chunks.')
        chunks.append(kind); position += 12+length
    if not chunks or chunks[0] != b'IHDR' or chunks[-1] != b'IEND' or chunks.count(b'IHDR') != 1 or chunks.count(b'IEND') != 1:
        raise ValidationError('The stored Stamp PNG has invalid normalized chunk order.')
    image = _decode(data, value['mime_type'])
    if (type(value['width']) is not int or type(value['height']) is not int
            or (value['width'], value['height']) != image.size or value['sha256'] != sha256(data).hexdigest()):
        raise ValidationError('The Stamp image dimensions and SHA must match its exact retained bytes.')
    return value


def validate_stamp_image_budget(records):
    # Inline records repeat their bytes in portable snapshots and audit states.
    total_bytes, total_pixels = 0, 0
    for record in records:
        if not isinstance(record, dict) or 'stamp_image' not in record:
            continue
        image = object_fields(record['stamp_image'], IMAGE_FIELDS, 'Stored Stamp image', IMAGE_FIELDS)
        width, height = image['width'], image['height']
        if (type(width) is not int or type(height) is not int or not 1 <= width <= MAX_STAMP_IMAGE_SIDE
                or not 1 <= height <= MAX_STAMP_IMAGE_SIDE or width*height > MAX_STAMP_IMAGE_PIXELS):
            raise ValidationError('A stored Stamp image requires bounded integer pixel dimensions.')
        total_pixels += width*height
        if total_pixels > MAX_STAMP_PROJECT_IMAGE_PIXELS:
            raise ValidationError('A project supports at most 16 million Stamp image pixels across all placements.')
        total_bytes += len(_payload(image))
        if total_bytes > MAX_STAMP_PROJECT_IMAGE_BYTES:
            raise ValidationError('A project supports at most 8 MiB of normalized Stamp image bytes across all placements.')
