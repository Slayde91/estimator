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
from urllib.parse import urldefrag, urlsplit
from uuid import NAMESPACE_URL, uuid5

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.firefly_reference_review import fingerprint
from estimator.firestopping_library import MAX_DIAGRAM_BYTES, MAX_DIAGRAM_PIXELS, encoded, timestamp
from estimator.library_report_links import valid_manual_report_url, validate_report_links
from estimator.technical_discovery import SNAP_FILTER_SOURCE
from estimator.technical_fields import FIELD_ORDER
from estimator.technical_library_edits import (FIELD_FACETS, SOURCE_IMAGE_PREFIX, SOURCE_IMAGE_TABLE,
                                               TechnicalEdits, text)
from scripts.snap_variant_identity import variant_record_id


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


def read_manifest(manifest, expected_sha256):
    captured = manifest.read_bytes()
    if expected_sha256 and sha256(captured).hexdigest() != expected_sha256:
        raise ValueError('The manifest does not match the expected SNAP import.')
    return json.loads(captured)


def prepare_records(systems, drawing_root, library, *, verify_files=True, allow_variants=False):
    index_path = library / 'library.json'
    index_bytes = index_path.read_bytes()
    index_hash = sha256(index_bytes).hexdigest()
    items = json.loads(index_bytes)['libraries']['technical']['items']
    labels = set(FIELD_ORDER) | set(FIELD_FACETS)
    labels.update(field['label'] for item in items for field in item['fields'])
    reserved = {item['id'] for item in items}
    del items, index_bytes
    if not isinstance(systems, list) or not systems:
        raise ValueError('The manifest contains no systems.')
    records = []
    paths = {}
    checked = set()
    root = drawing_root.resolve()
    for system in systems:
        record = system['record']
        check_record(record, labels)
        if not allow_variants and any(field['label'] == 'ID' and
                re.fullmatch(r'SNAP [1-9][0-9]* / .+', field['value']) for field in record['fields']):
            raise ValueError('A variant manifest requires explicit variant reconciliation.')
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
            if verify_files and (path, digest) not in checked:
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


def prepare(manifest, drawing_root, library, expected_manifest_sha256=None, *, verify_files=True):
    snapshot = read_manifest(manifest, expected_manifest_sha256)
    if 'variant_review' in snapshot:
        raise ValueError('A variant manifest requires explicit variant reconciliation.')
    return prepare_records(snapshot['systems'], drawing_root, library, verify_files=verify_files)


def verified_images(db, drawings, *, require_existing=False):
    existing_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='technical_library_source_images'").fetchone()
    missing = {}
    for image_id, path in drawings.items():
        digest = image_id.removeprefix(SOURCE_IMAGE_PREFIX)
        prior = (db.execute('SELECT image_data FROM technical_library_source_images WHERE id=?', (image_id,)).fetchone()
                 if existing_table else None)
        if prior is None:
            if require_existing:
                raise ValueError(f'Missing existing source drawing: {image_id}')
            missing[image_id] = path
        elif sha256(prior[0]).hexdigest() != digest:
            raise ValueError(f'Existing source drawing differs from its registered fingerprint: {image_id}')
    return missing


def store_images(db, missing):
    db.execute(SOURCE_IMAGE_TABLE)
    for image_id, path in missing.items():
        payload = read_drawing(path, image_id.removeprefix(SOURCE_IMAGE_PREFIX))
        db.execute('INSERT INTO technical_library_source_images VALUES (?,?)', (image_id, payload))


def reviewed_ids(records):
    result = {}
    for record in records:
        field = next((f['value'] for f in record['fields'] if f['label'] == 'ID'), '')
        match = re.fullmatch(r'SNAP ([1-9][0-9]*)', field)
        if not match:
            raise ValueError(f'Missing SNAP system number: {record["id"]}')
        sid = int(match[1])
        key = 'user-technical-' + uuid5(NAMESPACE_URL, f'Snap Fire Systems AU/system/{sid}').hex
        if record['id'] != key or sid in result:
            raise ValueError(f'Invalid stable identity for SNAP {sid}')
        result[sid] = record
    return result


def variant_configuration(record):
    labels = {'System Products', 'Installation Type', 'Barrier Construction', 'Service',
              'Service Size / Configuration', 'FRL', 'Installation Details', 'Orientation', 'Substrate'}
    return tuple(sorted((f['label'], ' '.join(f['value'].split()).casefold())
                        for f in record['fields'] if f['label'] in labels))


def check_variant_evidence(child, parent, evidence_urls):
    sources = {s['url'] for s in child['sources']}
    parent_sources = {s['url'] for s in parent['sources']}
    product_prefix = 'https://www.snapcollars.com.au/products/fire-collar/'
    if ('https://www.snapcollars.com.au/product-filter' not in sources
            or not any(url.startswith(product_prefix) for url in sources & parent_sources)):
        raise ValueError(f'The variant must cite its parent selector and product: {child["id"]}')
    reports = {urldefrag(link['url']).url for record in (parent, child) for field in record['fields']
               if field['label'] == 'Report Number' for link in field.get('report_links', [])}
    if not isinstance(evidence_urls, list) or not evidence_urls:
        raise ValueError('Each assessed variant must cite its supporting report pages.')
    seen = set()
    for url in evidence_urls:
        if not isinstance(url, str) or url not in sources or url in seen:
            raise ValueError('Variant evidence must list distinct report page URLs from the item sources.')
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or parsed.netloc != 'docs.snapcollars.com.au' or parsed.query
                or not parsed.path.lower().endswith('.pdf') or not re.fullmatch(r'page=[1-9][0-9]*', parsed.fragment)
                or urldefrag(url).url not in reports):
            raise ValueError(f'Variant evidence must identify a page in the cited SNAP assessment: {url}')
        seen.add(url)


def reviewed_variants(old, records, review):
    if not isinstance(review, dict) or set(review) != {'updated_record_ids', 'additions'}:
        raise ValueError('Supply the exact existing record updates and the assessed variant additions.')
    previous = reviewed_ids(old)
    proposed = {r['id']: r for r in records}
    parent_ids = {r['id'] for r in old}
    parents = [r for r in records if r['id'] in parent_ids]
    current = reviewed_ids(parents)
    if previous.keys() != current.keys():
        raise ValueError('Variant publication must preserve every previously reviewed SNAP selector ID.')
    changed = {record['id'] for sid, record in current.items() if record != previous[sid]}
    updates = review['updated_record_ids']
    if (not isinstance(updates, list) or not all(isinstance(k, str) for k in updates)
            or len(updates) != len(changed) or set(updates) != changed):
        raise ValueError('Existing record changes differ from the reviewed update IDs.')
    if not isinstance(review['additions'], list) or not review['additions']:
        raise ValueError('An assessed variant release requires explicit additions.')
    additions = {}
    configurations = {}
    for item in review['additions']:
        if not isinstance(item, dict) or set(item) != {'parent_system_id', 'variant_key', 'record_id', 'evidence_urls'}:
            raise ValueError('Invalid reviewed variant metadata.')
        sid, slug = item['parent_system_id'], item['variant_key']
        key = variant_record_id(sid, slug)
        if sid not in current or item['record_id'] != key or key not in proposed or key in parent_ids or key in additions:
            raise ValueError(f'Unmatched parent or stable assessed variant identity: {key}')
        child = proposed[key]
        field_id = next((f['value'] for f in child['fields'] if f['label'] == 'ID'), None)
        if field_id != f'SNAP {sid} / {slug}':
            raise ValueError(f'Variant ID field does not identify its parent and assessed variant: {key}')
        check_variant_evidence(child, previous[sid], item['evidence_urls'])
        if sid not in configurations:
            configurations[sid] = {variant_configuration(current[sid])}
        options = configurations[sid]
        configuration = variant_configuration(child)
        if configuration in options:
            raise ValueError(f'Duplicate assessed configuration for SNAP {sid}: {slug}')
        options.add(configuration)
        additions[key] = child
    if proposed.keys() - parent_ids != additions.keys():
        raise ValueError('New library IDs differ from the exact reviewed assessed variants.')
    return parents, additions, sorted(changed)


def reconcile(db, old, new, old_images, new_images, before_sha, after_sha, withdrawn_ids, apply):
    old, new = reviewed_ids(old), reviewed_ids(new)
    withdrawals = set(withdrawn_ids)
    if (len(withdrawals) != len(withdrawn_ids) or any(type(n) is not int or n <= 0 for n in withdrawals)
            or new.keys() - old.keys() or old.keys() - new.keys() != withdrawals):
        raise ValueError('The reviewed manifests and approved withdrawal IDs do not match. Corrections cannot add systems.')
    receipts = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snap_library_corrections'").fetchone()
    replay = bool(receipts and db.execute(
        'SELECT 1 FROM snap_library_corrections WHERE before_sha256=? AND after_sha256=?', (before_sha, after_sha)).fetchone())
    verified_images(db, old_images, require_existing=True)
    missing = verified_images(db, new_images, require_existing=replay)
    active_links = {}
    for key, source in db.execute('SELECT technical_id,technical_source FROM technical_library_links WHERE linked=1'):
        active_links.setdefault(key, set()).add(source)
    changes = []
    verified = 0
    for sid, previous in old.items():
        key = previous['id']
        replacement = new.get(sid)
        withdrawing = replacement is None
        expected = replacement if replay and not withdrawing else previous
        expected_hash = fingerprint(expected)
        state = db.execute('SELECT created,deleted,source_sha256,data,revision FROM technical_library_items WHERE id=?', (key,)).fetchone()
        if (not state or state[:3] != (1, int(replay and withdrawing), expected_hash)
                or json.loads(state[3]) != expected):
            raise ValueError(f'SNAP {sid} is missing, edited, deleted, or has an unexpected source. No correction applied.')
        links = active_links.get(key, set())
        if links and (withdrawing or links != {expected_hash}):
            raise ValueError(f'SNAP {sid} has an active link that cannot be preserved.')
        if replay or previous == replacement:
            verified += 1
            continue
        changes.append((key, state[4], expected_hash, replacement))

    if apply and not replay:
        store_images(db, missing)
        now = timestamp()
        for key, revision, before, replacement in changes:
            if replacement is None:
                # Keep the record, its original source hash and screenshots for audit.
                db.execute('UPDATE technical_library_items SET deleted=1,revision=?,updated_at=? WHERE id=?',
                           (revision + 1, now, key))
            else:
                after = fingerprint(replacement)
                db.execute('UPDATE technical_library_items SET source_sha256=?,data=?,revision=?,updated_at=? WHERE id=?',
                           (after, encoded(replacement), revision + 1, now, key))
                db.execute('UPDATE technical_library_links SET technical_source=?,revision=revision+1,updated_at=? '
                           'WHERE technical_id=? AND technical_source=?', (after, now, key, before))
        # Distinguish our tombstones on a verified replay from a user's previous deletion.
        db.execute('CREATE TABLE IF NOT EXISTS snap_library_corrections (before_sha256 TEXT NOT NULL, '
                   'after_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(before_sha256,after_sha256))')
        db.execute('INSERT INTO snap_library_corrections VALUES (?,?,?)', (before_sha, after_sha, now))
    withdrawn = sum(replacement is None for _, _, _, replacement in changes)
    return {'systems': len(new), 'previous_systems': len(old), 'already_verified': verified,
            'updated' if apply else 'planned_updates': len(changes) - withdrawn,
            'withdrawn' if apply else 'planned_withdrawals': withdrawn,
            'new_drawings' if apply else 'planned_drawings': len(missing), 'replay': replay,
            'previous_manifest_sha256': before_sha, 'manifest_sha256': after_sha}


def install_variants(db, old, new, old_images, new_images, before_sha, after_sha, review, apply):
    parents, additions, updated_ids = reviewed_variants(old, new, review)
    # The same transaction verifies every old image/record, preserves parent links,
    # and records the signed manifest pair. A child failure rolls it all back.
    result = reconcile(db, old, parents, old_images, new_images, before_sha, after_sha, (), apply)
    replay = result['replay']
    for key, child in additions.items():
        digest = fingerprint(child)
        state = db.execute('SELECT created,deleted,source_sha256,data FROM technical_library_items WHERE id=?',
                           (key,)).fetchone()
        links = db.execute('SELECT linked,technical_source FROM technical_library_links WHERE technical_id=?',
                           (key,)).fetchall()
        if replay:
            if not state or state[:3] != (1, 0, digest) or json.loads(state[3]) != child:
                raise ValueError(f'Published variant is missing, edited, deleted, or has an unexpected source: {key}')
            if any(active and source != digest for active, source in links):
                raise ValueError(f'Published variant has a stale active link: {key}')
        elif state or links:
            raise ValueError(f'An existing item or link already owns the proposed assessed variant ID: {key}')
        elif apply:
            TechnicalEdits.save_transaction(db, key, 0, digest, child, created=True)
    return {**result, 'systems': len(new), 'already_verified': result['already_verified'] + (len(additions) if replay else 0),
            'added' if apply else 'planned_additions': 0 if replay else len(additions),
            'reviewed_added_ids': sorted(additions), 'reviewed_updated_ids': updated_ids}


def install(manifest, library, database, apply=False, drawing_root=None, expected_manifest_sha256=None,
            previous_manifest=None, expected_previous_manifest_sha256=None, withdraw_system_ids=None, *, variants=False):
    manifest, library, database = map(Path, (manifest, library, database))
    correction = previous_manifest is not None
    if variants and (not correction or withdraw_system_ids is not None):
        raise ValueError('Variant reconciliation requires a previous manifest and cannot withdraw selector records.')
    if correction:
        if (not all(isinstance(d, str) and re.fullmatch(r'[a-f0-9]{64}', d)
                    for d in (expected_manifest_sha256, expected_previous_manifest_sha256))
                or (not variants and withdraw_system_ids is None)):
            raise ValueError('A correction requires both reviewed SHA-256 digests and explicit withdrawal IDs.')
        previous = Path(previous_manifest)
        old, old_images, old_index = prepare(previous, previous.parent, library, expected_previous_manifest_sha256, verify_files=False)
    elif expected_previous_manifest_sha256 is not None or withdraw_system_ids is not None:
        raise ValueError('Withdrawal IDs and a previous digest require a previous manifest.')
    root = Path(drawing_root or manifest.parent)
    if variants:
        snapshot = read_manifest(manifest, expected_manifest_sha256)
        review = snapshot.get('variant_review')
        records, drawings, index_hash = prepare_records(snapshot['systems'], root, library, allow_variants=True)
    else:
        records, drawings, index_hash = prepare(manifest, root, library, expected_manifest_sha256)
    # Open an existing database without initializing the commercial/application store.
    mode = 'rw' if apply else 'ro'
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=' + mode, uri=True, timeout=30)) as db, db:
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        if correction:
            if old_index != index_hash:
                raise ValueError('The base library changed between manifest reviews.')
            if variants:
                result = install_variants(db, old, records, old_images, drawings, expected_previous_manifest_sha256,
                                          expected_manifest_sha256, review, apply)
            else:
                result = reconcile(db, old, records, old_images, drawings, expected_previous_manifest_sha256,
                                   expected_manifest_sha256, withdraw_system_ids, apply)
            if sha256((library / 'library.json').read_bytes()).hexdigest() != index_hash:
                raise ValueError('The base library changed during the correction.')
            return {**result, 'supplier_index_sha256': index_hash}
        missing = verified_images(db, drawings)
        if apply:
            store_images(db, missing)
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
            'new_drawings' if apply else 'planned_drawings': len(missing),
            'drawing_references': sum(len(record['images']) for record in records),
            'supplier_index_sha256': index_hash}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('manifest', 'library', 'database'):
        parser.add_argument('--' + argument, required=True, type=Path)
    parser.add_argument('--drawing-root', type=Path, help='Base for relative screenshot paths (default: manifest directory).')
    parser.add_argument('--expected-manifest-sha256', help='Verify the reviewed manifest digest before reading any records.')
    parser.add_argument('--previous-manifest', type=Path, help='Previously installed SNAP manifest for correction-only reconciliation.')
    parser.add_argument('--expected-previous-manifest-sha256', help='Required reviewed previous manifest digest when correcting.')
    parser.add_argument('--withdraw-system-ids', type=int, nargs='*', help='Explicit approved SNAP system numbers to withdraw; pass with no numbers for zero withdrawals.')
    parser.add_argument('--variants', action='store_true', help='Reconcile a reviewed variant release against its previously published selector manifest.')
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(install(**vars(parser.parse_args())), indent=2))
