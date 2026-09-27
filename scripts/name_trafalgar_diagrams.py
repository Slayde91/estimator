"""Prepare a naming-only index from a complete, SHA-bound title-block review.

Source evidence, review fingerprints, asset IDs and image bytes stay unchanged.
Install the resulting bundle with the normal reference-library installer.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from estimator.library_diagram_names import drawing_source_names, validate_drawing_name


def apply_names(bundle, reviewed_names):
    result = deepcopy(bundle)
    assets = {a['id']: a for a in result['images'] if a['id'].startswith('trafalgar-image-')}
    reviews = {r['id']: r for r in reviewed_names}
    if not assets or len(reviews) != len(reviewed_names) or set(reviews) != set(assets):
        raise ValueError('Review must cover every Trafalgar image exactly once.')
    sources = {key: set() for key in assets}
    for document in result['trafalgar_selector_import']['source_documents'].values():
        for page in document.get('pages', []):
            key = page['registered_image_id']
            if key in assets:
                if page['image_sha256'] != assets[key]['sha256']:
                    raise ValueError('Source page fingerprint does not match image.')
                sources[key].add((document['source_filename'], page['page']))
    for key, asset in assets.items():
        review = reviews[key]
        if review['sha256'] != asset['sha256']:
            raise ValueError('Drawing review fingerprint is stale.')
        asset['filename'] = review['filename']
        asset['drawing_identity'] = {
            'basis': review['basis'], 'value': review['name'],
            'sources': [{'filename': filename, 'page': page}
                        for filename, page in sorted(sources[key])],
        }
        validate_drawing_name(asset)
    drawing_source_names(assets)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--review', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = apply_names(json.loads(args.index.read_text(encoding='utf-8')),
                         json.loads(args.review.read_text(encoding='utf-8')))
    # Exclusive creation prevents overwriting a live library or review input.
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, separators=(',', ':'))
        stream.write('\n')
    print(f"Prepared {sum('drawing_identity' in a for a in result['images'])} drawing names.")


if __name__ == '__main__':
    main()
