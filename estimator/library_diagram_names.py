"""Source-bound drawing filenames without changing asset IDs or source evidence."""

import re


def validate_drawing_name(asset):
    identity = asset.get('drawing_identity')
    if identity is None:
        return
    if asset.get('extension') != '.jpg' or not isinstance(identity, dict):
        raise ValueError('Drawing names require a registered JPEG image.')
    if identity.get('basis') not in {'Drawing No.', 'T-card No.', 'Drawing Name'}:
        raise ValueError('Unknown drawing name basis.')
    name = identity.get('value')
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise ValueError('Invalid drawing identity.')
    filename = asset.get('filename', '')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 _().,&+-]{0,220}\.jpg', filename):
        raise ValueError('Unsafe drawing filename.')
    if filename.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *('COM'+str(n) for n in range(1, 10)), *('LPT'+str(n) for n in range(1, 10))}:
        raise ValueError('Reserved drawing filename.')
    sources = identity.get('sources')
    if not isinstance(sources, list) or not sources:
        raise ValueError('Drawing name needs a source page.')
    for source in sources:
        if (not isinstance(source, dict) or not isinstance(source.get('filename'), str)
                or not 0 < len(source['filename']) <= 500
                or type(source.get('page')) is not int or not 1 <= source['page'] <= 10000):
            raise ValueError('Invalid drawing name source page.')


def drawing_source_names(assets):
    names = {}
    filenames = set()
    for asset in assets.values():
        identity = asset.get('drawing_identity')
        if identity is None:
            continue
        filename = asset['filename'].casefold()
        if filename in filenames:
            raise ValueError('Duplicate drawing filename.')
        filenames.add(filename)
        for source in identity['sources']:
            key = (source['filename'], source['page'])
            if key in names and names[key] != asset['filename']:
                raise ValueError('Conflicting names for one source diagram page.')
            names[key] = asset['filename']
    return names


def apply_drawing_names(item, assets, source_names):
    """Update only the already-copied display projection, after review validation."""
    images = list(item.get('images', []))
    for field in item.get('fields', []):
        images.extend(field.get('images', []))
    for image in images:
        asset = assets[image['id']]
        if asset.get('drawing_identity') is not None:
            image['caption'] = asset['filename']
            if 'captions' in image:
                image['captions'] = [asset['filename']]
    for source in item.get('sources', []):
        page = source.get('page')
        if page is None:
            match = re.search(r'\bsource page (\d+)\s*$', source.get('label', ''), re.I)
            page = int(match[1]) if match else 1
        name = source_names.get((source.get('filename'), page))
        if name:
            source['filename'] = name
            source['label'] = name
