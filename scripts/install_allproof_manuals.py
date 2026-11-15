"""Install reviewed Allproof table rows and their original diagram crops in one transaction.

The manuals, extracted rows and drawings stay in the external library bundle.
Re-running a bundle verifies existing records. A modified or deleted record
requires reconciliation before a different version can be installed.
"""
import argparse
import base64
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.firestopping_library import diagram_upload
from estimator.library_report_links import validate_report_links
from estimator.storage import Store
from estimator.technical_library_edits import FIELD_FACETS, TechnicalEdits, uploaded_diagram_id

MANUALS = {
    'electrical': ('electrical.pdf', '0b3562ef2123d1fce6d531adefcbdce5f7fe9bb73c3ca8bc0f85e0aba6ba1b50'),
    'plumbing': ('manual.pdf', '1612953f82825fa011406d9dcdbb21a4493ff38ec70d86b985fa61b5a72c8b99'),
}
SOURCE = 'Allproof Australian fire technical manual'
# Hash of each reviewed UTF-8 manifest and the named original diagram crops.
REVIEWED_BUNDLES = {
    'electrical': 'd40c9015cb9a3b7b0af4dd9e585e5f298ca0b355663ff43f8cbf30f29eeb9eb0',
    'plumbing': '37aeb01e8129b679c2de5528214f21b961c0ae6d1949ca4526032c8dce913480',
}


@lru_cache(maxsize=256)
def prepare_crop(path):
    return diagram_upload({'filename': path.name,
                           'content_base64': base64.b64encode(path.read_bytes()).decode('ascii')})


def string_list(values, description):
    if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
        raise ValueError(f'Missing or invalid {description}: {values!r}')
    return list(dict.fromkeys(values))


def manual_link(url, page, locator):
    if urlsplit(url).scheme != 'https' or urlsplit(url).hostname not in {
            'allproofind.sharepoint.com', 'allproof.com.au', 'www.allproof.com.au'}:
        raise ValueError(f'Expected an Allproof source URL at {locator}')
    return url.split('#')[0] + f'#page={page}'


def build_record(row, family, directory, allowed_fields):
    locator = row['source_locator']
    page = row['page']
    url = row['source_url']
    if not isinstance(page, int) or not 1 <= page <= (62 if family == 'plumbing' else 28) or not locator:
        raise ValueError(f'Invalid source locator for {row["key"]}')
    primary_url = manual_link(url, page, locator)
    sources = [{'label': locator, 'url': primary_url}]
    for citation in row.get('additional_sources', []):
        sources.append({'label': citation['reference'],
                        'url': manual_link(citation['url'], citation['page'], citation['reference'])})
    if not row['key'] or not row['title'].strip():
        raise ValueError(f'Missing row identity at {locator}')
    key = 'user-technical-' + uuid5(NAMESPACE_URL, f'Allproof AU/{family}/{row["key"]}').hex
    authored = dict(row['fields'])
    unknown = set(authored) - allowed_fields
    if unknown:
        raise ValueError(f'Unrecognised Technical Library fields {unknown} at {locator}')
    facts = {label: value.strip() for label, value in authored.items() if label not in FIELD_FACETS and value.strip()}
    for label in ('System Products', 'Barrier Construction', 'Service Size / Configuration', 'Installation Details'):
        if not facts.get(label):
            raise ValueError(f'Missing {label} at {locator}')
    facets = {**row['facets'], 'manufacturer': ['Allproof'], 'report': string_list(row['reports'], locator)}
    if set(facets) != set(FIELD_FACETS.values()):
        raise ValueError(f'Incomplete filter metadata at {locator}')
    fields = [{'label': k, 'value': v} for k, v in facts.items()]
    # The inspections picker requires a choice in every filter. A generic
    # opening dimension does not establish whether a core drill was used.
    if not facets['type']:
        facets['type'] = ['Refer to installation details']
    for label, facet in FIELD_FACETS.items():
        facets[facet] = string_list(facets[facet], f'{locator} {facet}')
        field = {'label': label, 'value': '\n'.join(facets[facet])}
        if label in authored and field['value'] != authored[label]:
            raise ValueError(f'{label} filter disagrees with the reviewed value at {locator}')
        if facet == 'report':
            field['report_links'] = [{'label': number, 'url': primary_url}
                                     for number in facets[facet]]
            validate_report_links(field, user_authored=True)
        fields.append(field)
    images, blobs = [], {}
    for name in string_list(row['diagrams'], f'{locator} diagrams'):
        path = (directory / name).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError(f'Diagram outside the manual directory at {locator}')
        rendered = prepare_crop(path)
        image_id = uploaded_diagram_id(key, rendered['sha256'])
        if image_id not in blobs:
            images.append({'id': image_id, 'caption': f'Allproof {family} manual, {locator} — {path.stem}',
                           'user_uploaded': True})
            blobs[image_id] = rendered['image_data']
    record = {'id': key, 'title': row['title'], 'source_label': SOURCE, 'subtitle': locator,
              'summary': '', 'sources': sources,
              'fields': fields, 'filter_values': facets, 'images': images, 'editable': True}
    return record, blobs


def install(bundle, library, database, apply):
    source = json.loads((library / 'library.json').read_text(encoding='utf-8'))
    labels = {field['label'] for item in source['libraries']['technical']['items'] for field in item['fields']}
    del source
    batches = []
    keys = set()
    totals = {}
    for family, (filename, expected) in MANUALS.items():
        directory = bundle / family
        with (directory / filename).open('rb') as manual:
            if hashlib.file_digest(manual, 'sha256').hexdigest() != expected:
                raise ValueError(f'{family} manual does not match the reviewed edition')
        manifest = (directory / 'manifest.json').read_bytes()
        rows = json.loads(manifest)
        digest = hashlib.sha256(manifest)
        for name in sorted({name for row in rows for name in row['diagrams']}):
            path = (directory / name).resolve()
            if not path.is_relative_to(directory.resolve()):
                raise ValueError(f'Diagram outside the {family} manual directory')
            digest.update(name.encode('utf-8') + b'\0' + hashlib.sha256(path.read_bytes()).digest())
        if digest.hexdigest() != REVIEWED_BUNDLES[family]:
            raise ValueError(f'{family} entries or diagrams differ from the reviewed bundle')
        totals[family] = len(rows)
        if not rows:
            raise ValueError(f'The {family} review contains no systems')
        for row in rows:
            record, blobs = build_record(row, family, directory, labels | FIELD_FACETS.keys())
            if record['id'] in keys:
                raise ValueError(f'Duplicate row ID at {record["subtitle"]}')
            keys.add(record['id'])
            batches.append((record, blobs))
    if not database.is_file():
        raise ValueError('Choose an existing CLASSIFIRE database')
    edits = TechnicalEdits(Store(database))
    installed = 0
    with edits.store.connect() as db:
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        for record, blobs in batches:
            key = record['id']
            prior = db.execute('SELECT data, deleted FROM technical_library_items WHERE id=?', (key,)).fetchone()
            if prior:
                if prior[1] or json.loads(prior[0]) != record:
                    raise ValueError(f'Existing item differs from reviewed row {key}. Review before updating.')
                for image_id, expected in blobs.items():
                    image = db.execute('SELECT image_data FROM technical_library_diagrams WHERE item_id=? AND id=?',
                                       (key, image_id)).fetchone()
                    if not image or image[0] != expected:
                        raise ValueError(f'Existing diagram differs from the reviewed crop: {image_id}')
            else:
                if apply:
                    edits.save_transaction(db, key, 0, hashlib.sha256(key.encode()).hexdigest(),
                                           record, created=True, diagrams=blobs)
                installed += 1
    return {'systems': totals, 'unique_diagram_files': prepare_crop.cache_info().currsize,
            'new' if apply else 'planned': installed, 'already_verified': len(keys) - installed}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('bundle', 'library', 'database'):
        parser.add_argument('--' + argument, type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(install(**vars(parser.parse_args())), indent=2))
