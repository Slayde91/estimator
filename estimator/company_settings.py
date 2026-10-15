"""Validated company details shared by authored PDF exports, independent of UI theme."""
import base64
import binascii
from io import BytesIO

from PIL import Image
from reportlab.lib.utils import ImageReader

from .catalog import ROOT, ValidationError

DEFAULTS = {'name': 'CEASEFIRE', 'abn': '50 612 231 562',
            'phone': '1300 92 62 88', 'email': 'sales@ceasefire.com.au', 'logo': None}
MAX_LOGO_BYTES = 2 * 1024 * 1024


def validate_company_settings(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ValidationError('Enter the company name, ABN, phone, email and logo settings.')
    result = {}
    for key in ('name', 'abn', 'phone', 'email'):
        text = value[key]
        if not isinstance(text, str) or len(text) > 120 or any(ord(char) < 32 for char in text):
            raise ValidationError(f'Company {key} must be one line of text, at most 120 characters.')
        result[key] = text.strip()
    logo = value['logo']
    if logo is not None:
        if not isinstance(logo, str) or len(logo) > MAX_LOGO_BYTES * 4 // 3 + 100:
            raise ValidationError('Choose a PNG or JPEG company logo smaller than 2 MB.')
        prefix, separator, encoded = logo.partition(',')
        if not separator or prefix not in ('data:image/png;base64', 'data:image/jpeg;base64'):
            raise ValidationError('Choose a PNG or JPEG company logo.')
        try:
            payload = base64.b64decode(encoded, validate=True)
            if len(payload) > MAX_LOGO_BYTES:
                raise ValueError('size')
            with Image.open(BytesIO(payload)) as image:
                if image.format not in ('PNG', 'JPEG') or image.width * image.height > 4_000_000 or getattr(image, 'n_frames', 1) != 1:
                    raise ValueError('dimensions')
                image.verify()
            # Fully decode before storing: malformed/truncated files cannot
            # become a persistent failure in every future report.
            with Image.open(BytesIO(payload)) as image:
                image.load()
        except (ValueError, OSError, binascii.Error, Image.DecompressionBombError) as error:
            raise ValidationError('The logo must be a valid PNG or JPEG, up to 2 MB and 4 million pixels.') from error
    result['logo'] = logo
    return result


def company_logo(company=None):
    logo = (company or DEFAULTS).get('logo')
    return ImageReader(BytesIO(base64.b64decode(logo.split(',', 1)[1]))) if logo else ImageReader(str(ROOT / 'static/classifire-logo.png'))


def contact_lines(company=None):
    value = company or DEFAULTS
    return [f'{label}: {value[key]}' for key, label in (('abn', 'ABN'), ('phone', 'Phone'), ('email', 'Email')) if value.get(key)]
