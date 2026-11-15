"""Consolidate the six RTL FA 2981.03 entries into the existing Installation Details field."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys
from uuid import NAMESPACE_URL, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.storage import Store
from estimator.technical_library_edits import TechnicalEdits

URL = 'https://fendix.com.au/wp-content/uploads/2026/09/RTL-FA-2981.03.pdf'
CONFIGURATIONS = [('PVC-U DWV', size, 150, '-/180/180') for size in (50, 65, 80, 100)] + [
    ('PVC-U DWV', 100, 170, '-/240/240'), ('HDPE', 56, 150, 'Not assessed')]
MERGE_FIELDS = {
    'Stack in core hole', 'Stack at existing cast-in collar', 'Floor waste in core hole or at existing cast-in collar',
    'Cast-in collar', 'Fixings', 'Assessment scope', 'Evidence', 'Test observations'}


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


def normalize(database, apply=False):
    if not database.is_file():
        raise ValueError('Choose an existing CLASSIFIRE database')
    edits = TechnicalEdits(Store(database))
    changed = []
    with edits.store.connect() as db:
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        for material, size, slab, rating in CONFIGURATIONS:
            key = 'user-technical-' + uuid5(NAMESPACE_URL, f'{URL}#{material}/{size}/{slab}/{rating}').hex
            saved = db.execute('SELECT revision,source_sha256,created,deleted,data FROM technical_library_items WHERE id=?',
                               (key,)).fetchone()
            if saved is None or not saved[2] or saved[3]:
                raise ValueError(f'Missing or removed original Fendix entry {key}')
            record = json.loads(saved[4])
            facets = record['filter_values']
            if facets['manufacturer'] != ['Fendix'] or facets['frl'] != [rating] or facets['report'] != ['RTL FA 2981.03']:
                raise ValueError(f'Fendix record no longer matches the reviewed configuration: {key}')
            updated = consolidate(record)
            if updated != record:
                if apply:
                    edits.save_transaction(db, key, saved[0], saved[1], updated, created=True)
                changed.append(key)
    return {'changed' if apply else 'planned': changed, 'checked': len(CONFIGURATIONS)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    print(json.dumps(normalize(**vars(parser.parse_args())), indent=2))
