"""Install a reviewed Snap selector manifest and its drawing screenshots atomically."""
import argparse
from contextlib import closing
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import sqlite3
import sys

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.firefly_reference_review import fingerprint
from estimator.firestopping_library import MAX_DIAGRAM_BYTES, MAX_DIAGRAM_PIXELS
from estimator.library_report_links import valid_manual_report_url, validate_report_links
from estimator.technical_discovery import SNAP_FILTER_SOURCE
from estimator.technical_fields import FIELD_ORDER
from estimator.technical_library_edits import (FIELD_FACETS, SOURCE_IMAGE_PREFIX, SOURCE_IMAGE_TABLE,
                                               TechnicalEdits, text)


def read_drawing(path, expected):
    with path.open('rb') as stream:
        payload = stream.read(MAX_DIAGRAM_BYTES + 1)
    if not 0 < len(payload) <= MAX_DIAGRAM_BYTES or sha256(payload).hexdigest() != expected:
        raise ValueError(f'Drawing size or fingerprint differs: {path.name}')
    return payload


def verify_drawing(path, digest):
    payload = read_drawing(path, digest)
    with Image.open(BytesIO(payload)) as image:
        if image.format != 'PNG' or image.width * image.height > MAX_DIAGRAM_PIXELS or image.n_frames != 1:
            raise ValueError(f'Expected a bounded single-page PNG screenshot: {path.name}')
        image.verify()
    with Image.open(BytesIO(payload)) as image:
        image.load()


def check_record(record, labels):
    if set(record) != {'id', 'title', 'subtitle', 'summary', 'source_label', 'sources', 'fields', 'filter_values', 'editable'}:
        raise ValueError('Expected the existing Technical Library record format.')
    key = record['id']
    if (not re.fullmatch(r'user-technical-[0-9a-f]{32}', key) or record['editable'] is not True
            or record['source_label'] != SNAP_FILTER_SOURCE):
        raise ValueError(f'Invalid Snap record identity: {key}')
    text(record['title'], 1000, blank=False)
    for name in ('summary', 'subtitle'):
        text(record[name], 20000)
    facets = record['filter_values']
    if (not isinstance(facets, dict) or set(facets) - set(FIELD_FACETS.values())
            or facets.get('manufacturer') != ['Snap']):
        raise ValueError(f'Invalid filter selection: {key}')
    for name, values in facets.items():
        if not isinstance(values, list) or len(values) > 100 or len(set(values)) != len(values):
            raise ValueError(f'Invalid {name} filter values: {key}')
        for value in values:
            text(value, 1000, blank=False)
    fields = {}
    for field in record['fields']:
        label = field['label']
        if (label not in labels or label in fields or set(field) - {'label', 'value', 'report_links'}):
            raise ValueError(f'Unrecognised or duplicate library field {label}: {key}')
        fields[label] = text(field['value'], 40000, blank=False)
        validate_report_links(field, user_authored=True)
    if fields.get('Manufacturer') != 'Snap' or not fields.get('System Products') or not fields.get('Installation Details'):
        raise ValueError(f'Missing manufacturer, product, or installation details: {key}')
    sources = record['sources']
    if not isinstance(sources, list) or not sources:
        raise ValueError(f'Missing product or drawing source references: {key}')
    for source in sources:
        if set(source) != {'label', 'url'} or not valid_manual_report_url(source['url']) or not source['url'].startswith('https://'):
            raise ValueError(f'Invalid source reference: {key}')
        text(source['label'], 2000, blank=False)


def prepare(manifest, drawing_root, library):
    index_path = library / 'library.json'
    index_bytes = index_path.read_bytes()
    index_hash = sha256(index_bytes).hexdigest()
    items = json.loads(index_bytes)['libraries']['technical']['items']
    labels = set(FIELD_ORDER) | set(FIELD_FACETS)
    labels.update(field['label'] for item in items for field in item['fields'])
    reserved = {item['id'] for item in items}
    del items, index_bytes
    systems = json.loads(manifest.read_bytes())['systems']
    if not isinstance(systems, list) or not systems:
        raise ValueError('The manifest contains no systems.')
    records = []
    paths = {}
    checked = set()
    root = drawing_root.resolve()
    for system in systems:
        record = system['record']
        check_record(record, labels)
        key = record['id']
        if key in reserved:
            raise ValueError(f'Duplicate or existing supplier record identity: {key}')
        reserved.add(key)
        drawings = system['drawings']
        if not isinstance(drawings, list):
            raise ValueError(f'Invalid drawing list: {key}')
        if not drawings and not any(field['label'] == 'Source Issues' for field in record['fields']):
            raise ValueError(f'Missing drawing screenshot without a source issue: {key}')
        images = []
        for drawing in drawings:
            digest = drawing['sha256']
            path = (root / drawing['path']).resolve()
            if not path.is_relative_to(root) or not re.fullmatch('[a-f0-9]{64}', digest):
                raise ValueError(f'Invalid drawing path or fingerprint: {key}')
            if (path, digest) not in checked:
                verify_drawing(path, digest)
                checked.add((path, digest))
            image_id = SOURCE_IMAGE_PREFIX + digest
            caption = text(drawing['caption'], 2000, blank=False)
            images.append({'id': image_id, 'caption': caption})
            paths.setdefault(image_id, path)
        if len({ref['id'] for ref in images}) != len(images):
            raise ValueError(f'Duplicate screenshot in one system: {key}')
        records.append({**record, 'images': images})
    return records, paths, index_hash


def install(manifest, library, database, apply=False, drawing_root=None):
    manifest, library, database = map(Path, (manifest, library, database))
    records, drawings, index_hash = prepare(manifest, Path(drawing_root or manifest.parent), library)
    # Open an existing database without initializing the commercial/application store.
    mode = 'rw' if apply else 'ro'
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=' + mode, uri=True, timeout=30)) as db, db:
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        if apply:
            db.execute(SOURCE_IMAGE_TABLE)
        image_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='technical_library_source_images'").fetchone()
        new_images = 0
        for image_id, path in drawings.items():
            digest = image_id.removeprefix(SOURCE_IMAGE_PREFIX)
            prior = (db.execute('SELECT image_data FROM technical_library_source_images WHERE id=?', (image_id,)).fetchone()
                     if image_table else None)
            if prior:
                if sha256(prior[0]).hexdigest() != digest:
                    raise ValueError(f'Existing source drawing differs from its registered fingerprint: {image_id}')
            else:
                new_images += 1
                if apply:
                    db.execute('INSERT INTO technical_library_source_images VALUES (?,?)', (image_id, read_drawing(path, digest)))
        new_items = 0
        for record in records:
            key = record['id']
            source_hash = fingerprint(record)
            prior = db.execute('SELECT created,deleted,source_sha256,data FROM technical_library_items WHERE id=?', (key,)).fetchone()
            if prior:
                if prior[:3] != (1, 0, source_hash) or json.loads(prior[3]) != record:
                    raise ValueError(f'Existing record differs from this import: {key}')
            else:
                new_items += 1
                if apply:
                    TechnicalEdits.save_transaction(db, key, 0, source_hash, record, created=True)
        if sha256((library / 'library.json').read_bytes()).hexdigest() != index_hash:
            raise ValueError('The base library changed during the import.')
    return {'systems': len(records), 'new' if apply else 'planned': new_items,
            'already_verified': len(records) - new_items, 'unique_drawings': len(drawings),
            'new_drawings' if apply else 'planned_drawings': new_images,
            'drawing_references': sum(len(record['images']) for record in records),
            'supplier_index_sha256': index_hash}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('manifest', 'library', 'database'):
        parser.add_argument('--' + argument, required=True, type=Path)
    parser.add_argument('--drawing-root', type=Path, help='Base for relative screenshot paths (default: manifest directory).')
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(install(**vars(parser.parse_args())), indent=2))
