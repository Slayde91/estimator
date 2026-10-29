"""Validated signer artwork; no inferred identity or electronic-signing claim."""
import base64
import binascii
from io import BytesIO

from PIL import Image, ImageOps
from reportlab.lib.utils import ImageReader

from .catalog import ValidationError

MAX_SIGNATURE_BYTES = 2 * 1024 * 1024
MAX_SIGNATURE_PIXELS = 4_000_000


def validate_signature(value, name=''):
    if (not isinstance(name, str) or len(name) > 200
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in name)
            or any(char in name for char in '/\\')):
        raise ValidationError('The signature filename is invalid.')
    if value is None:
        return None, ''
    if not isinstance(value, str) or len(value) > MAX_SIGNATURE_BYTES * 4 // 3 + 100:
        raise ValidationError('Choose a PNG or JPEG signature smaller than 2 MB.')
    prefix, separator, encoded = value.partition(',')
    formats = {'data:image/png;base64': 'PNG', 'data:image/jpeg;base64': 'JPEG'}
    if not separator or prefix not in formats:
        raise ValidationError('Choose a PNG or JPEG signature smaller than 2 MB.')
    try:
        payload = base64.b64decode(encoded, validate=True)
        if not payload or len(payload) > MAX_SIGNATURE_BYTES:
            raise ValueError('Signature size')
        with Image.open(BytesIO(payload)) as image:
            if (image.format != formats[prefix] or not 0 < image.width * image.height <= MAX_SIGNATURE_PIXELS
                    or getattr(image, 'n_frames', 1) != 1):
                raise ValueError('Signature dimensions or format')
            image.verify()
        with Image.open(BytesIO(payload)) as image:
            image.load()
    except (ValueError, OSError, binascii.Error, Image.DecompressionBombError) as error:
        raise ValidationError('The signature must be a valid PNG or JPEG, up to 2 MB and 4 million pixels.') from error
    return value, name.strip() or ('Signature.png' if formats[prefix] == 'PNG' else 'Signature.jpg')


def signature_reader(value):
    """A fully decoded, orientation-correct image for the PDF renderer."""
    payload = base64.b64decode(value.split(',', 1)[1], validate=True)
    with Image.open(BytesIO(payload)) as original:
        image = ImageOps.exif_transpose(original)
        image.load()
        has_alpha = 'A' in image.getbands() or 'transparency' in image.info
        return ImageReader(image.convert('RGBA' if has_alpha else 'RGB'))
