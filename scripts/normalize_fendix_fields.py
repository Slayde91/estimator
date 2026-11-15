"""Update the five assessed PVC-U entries for RTL FA 2981.03 and retire its HDPE test record.

Pass --photo fendix-supplied-photo.png to include the original 1446 x 1088
attachment from the Fendix record review. The checksum below identifies it
in the external reference-library evidence. Preview first; --apply writes.
"""
import argparse
import base64
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
from uuid import NAMESPACE_URL, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.storage import Store
from estimator.technical_library_edits import TechnicalEdits, prepare_diagrams

URL = 'https://fendix.com.au/wp-content/uploads/2026/09/RTL-FA-2981.03.pdf'
CONFIGURATIONS = [('PVC-U DWV', size, 150, '-/180/180') for size in (50, 65, 80, 100)] + [
    ('PVC-U DWV', 100, 170, '-/240/240'), ('HDPE', 56, 150, 'Not assessed')]
MERGE_FIELDS = {
    'Stack in core hole', 'Stack at existing cast-in collar', 'Floor waste in core hole or at existing cast-in collar',
    'Cast-in collar', 'Fixings', 'Assessment scope', 'Evidence', 'Test observations'}
PHOTO_SHA256 = 'f83b17f83978452838eb2b6b3cff45e2a55f7f92e98ab1cc6a6e08d601d53db2'
# Fingerprint of the original supplier text after the earlier field consolidation.
ORIGINAL_INSTALLATION_SHA256 = 'd3d7954107701f28a148c4f7f420986f3297fc3c847abce9210f8eaa5a185ff4'
INSTALLATION = (
    'Install the retrofit collar on the concrete soffit. Fire exposure is from below only. '
    'Use approved fire rated sealants only, as specified for this system in RTL FA 2981.03.\n\n'
    'Fixings: Secure all four tabs to concrete with at least four all-steel anchors of M6 or larger, '
    'with at least 42 mm effective embedment or 50 mm actual length. Use a washer of at least '
    '14 mm outside diameter unless the head is at least 14 mm.')


def consolidate(record):
    result = deepcopy(record)
    fields = result['fields']
    if not any(field['label'] in MERGE_FIELDS for field in fields):
        return result
    details = next((field for field in fields if field['label'] == 'Installation Details'), None)
    if details is None:
        details = {'label': 'Installation Details', 'value': ''}
        fields.insert(next(i for i, field in enumerate(fields) if field['label'] in MERGE_FIELDS), details)
    blocks = [details['value']] if details['value'] else []
    for field in fields:
        if field['label'] in MERGE_FIELDS:
            if set(field) != {'label', 'value'}:
                raise ValueError('Unexpected structured data in a Fendix field; review before updating.')
            blocks.append(f'{field["label"]}: {field["value"]}')
    details['value'] = '\n\n'.join(blocks)
    result['fields'] = [field for field in fields if field['label'] not in MERGE_FIELDS]
    return result


def revise_pvc(record, size):
    updated = consolidate(record)
    fields = {field['label']: field for field in updated['fields']}
    configuration = fields['Service Size / Configuration']
    original = (f'{size} mm nominal pipe. Stack or floor waste through a core hole, or with an existing '
                'cast-in collar. With or without a fitting within the limits of §8.2.')
    if configuration['value'] == original:
        configuration['value'] = (f'{size} mm nominal pipe. Stack or floor waste with or without an existing '
                                  'cast-in collar. Use a core hole where there is no existing collar.')
    details = fields['Installation Details']
    if hashlib.sha256(details['value'].encode()).hexdigest() == ORIGINAL_INSTALLATION_SHA256:
        details['value'] = INSTALLATION
    return updated


def normalize(database, apply=False, photo=None):
    if not database.is_file():
        raise ValueError('Choose an existing CLASSIFIRE database')
    upload = None
    if photo:
        content = photo.read_bytes()
        if hashlib.sha256(content).hexdigest() != PHOTO_SHA256:
            raise ValueError('Choose the original Fendix installation photo supplied with this update.')
        upload = {'filename': 'Fendix Slimline Retrofit Collar installation.png',
                  'content_base64': base64.b64encode(content).decode('ascii')}
    edits = TechnicalEdits(Store(database))
    changed = []
    with edits.store.connect() as db:
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        for material, size, slab, rating in CONFIGURATIONS:
            key = 'user-technical-' + uuid5(NAMESPACE_URL, f'{URL}#{material}/{size}/{slab}/{rating}').hex
            saved = db.execute('SELECT revision,source_sha256,created,deleted,data FROM technical_library_items WHERE id=?',
                               (key,)).fetchone()
            if saved is None or not saved[2]:
                raise ValueError(f'Missing original Fendix entry {key}')
            if saved[3]:
                continue
            record = json.loads(saved[4])
            facets = record['filter_values']
            if facets['manufacturer'] != ['Fendix'] or facets['frl'] != [rating] or facets['report'] != ['RTL FA 2981.03']:
                raise ValueError(f'Fendix record no longer matches the reviewed configuration: {key}')
            retired = material == 'HDPE'
            updated = record if retired else revise_pvc(record, size)
            diagrams = None
            if upload and not retired:
                diagrams = prepare_diagrams(key, updated, {'remove': [], 'uploads': [upload]})
            if retired or updated != record:
                if apply:
                    edits.save_transaction(db, key, saved[0], saved[1], updated, created=True,
                                           deleted=retired, diagrams=diagrams)
                changed.append(key)
    return {'changed' if apply else 'planned': changed, 'checked': len(CONFIGURATIONS)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--photo', type=Path, help='Original attached Fendix installation PNG.')
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(normalize(**vars(parser.parse_args())), indent=2))
