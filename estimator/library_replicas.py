"""Optional reviewed illustration derivatives, separate from source evidence."""
import hashlib
import json
import re

from .catalog import ValidationError

LIMIT = 10 * 1_048_576
IMAGE_LIMIT = 16 * 1_048_576
HASH = re.compile(r'[a-f0-9]{64}\Z')
FILE = re.compile(r'[a-f0-9]{64}\.(?:png|jpg)\Z')


def registry(directory, assets):
    """An absent/invalid optional registry never prevents original retrieval."""
    root = directory / 'replicas'
    path = root / 'index.json'
    try:
        if (not root.resolve().is_relative_to(directory.resolve())
                or not path.resolve().is_relative_to(root.resolve()) or path.stat().st_size > LIMIT):
            return {}
        with path.open('rb') as stream:
            payload = stream.read(LIMIT + 1)
        if len(payload) > LIMIT:
            return {}
        data = json.loads(payload)
        if type(data.get('version')) is not int or data['version'] != 1 or not isinstance(data.get('images'), dict) or len(data['images']) > 20000:
            return {}
    except (OSError, ValueError, AttributeError, TypeError):
        return {}
    result = {}
    for key, entry in data['images'].items():
        asset = assets.get(key)
        if (not asset or asset['pdf'] or not isinstance(entry, dict)
                or set(entry) != {'source_sha256', 'file', 'sha256', 'review'}
                or entry['review'] != 'visual_review_passed'
                or not isinstance(entry['sha256'], str) or not HASH.fullmatch(entry['sha256'])
                or not isinstance(entry['file'], str) or not FILE.fullmatch(entry['file'])
                or entry['source_sha256'] != asset['sha256']):
            continue
        result[key] = entry
    return result


def asset(directory, entry):
    root = directory / 'replicas'
    path = root / entry['file']
    if not root.resolve().is_relative_to(directory.resolve()) or not path.resolve().is_relative_to(root.resolve()):
        raise ValidationError('The replica is outside its registered folder.')
    try:
        if not 0 < path.stat().st_size <= IMAGE_LIMIT:
            raise ValidationError('The replica has an invalid size.')
        with path.open('rb') as stream:
            payload = stream.read(IMAGE_LIMIT + 1)
    except OSError as exc:
        raise ValidationError('The reviewed replica is unavailable. Open its original source image.') from exc
    if len(payload) > IMAGE_LIMIT or hashlib.sha256(payload).hexdigest() != entry['sha256']:
        raise ValidationError('The replica changed after visual review. Open its original source image.')
    png = payload.startswith(b'\x89PNG\r\n\x1a\n')
    if not (png or payload.startswith(b'\xff\xd8\xff')):
        raise ValidationError('The reviewed replica is not a supported image.')
    return payload, 'image/png' if png else 'image/jpeg', entry['file']
