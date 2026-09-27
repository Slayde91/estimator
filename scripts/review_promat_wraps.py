"""Apply explicit, fingerprint-bound wrap reviews to a private library candidate.

This is an editorial tool, not a rule that infers no-wrap from empty selector
data. A review covers every variant of the named group. Original fields and
source pages remain intact; only the existing reviewed fields are updated.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from estimator.reference_library import ReferenceLibrary
from estimator.technical_field_reviewed import review_fingerprint
from estimator.technical_fields import FIELD_ORDER
from estimator.technical_table_navigation import field_tables, validate_table_navigation

WRAP = 'Service Wrap'


def apply_reviews(bundle, reviews):
    """Return a separate candidate, refusing stale or partially scoped reviews."""
    candidate = deepcopy(bundle)
    items = {i['id']: i for i in candidate['libraries']['technical']['items']}
    seen = set()
    for decision in reviews:
        key = decision['id']
        if key in seen:
            raise ValueError('Duplicate wrap review')
        seen.add(key)
        item = items[key]
        source = item.get('promat_source')
        review = item.get('technical_field_review')
        if not source or not review or review.get('configuration_sources'):
            raise ValueError('Expected a selector-backed Promat field review')
        expected = {'source_fields': item['fields'], 'reviewed_fields': review['fields'],
                    'promat_source': source}
        if decision['expected_sha256'] != review_fingerprint(expected):
            raise ValueError('Promat wrap evidence changed; review must be updated')
        if decision['variant_ids'] != source['variant_ids']:
            raise ValueError('Wrap review must cover every variant in source order')
        value, reason = decision['value'], decision['reason']
        if not isinstance(value, str) or not value.strip() or not isinstance(reason, str) or not reason.strip():
            raise ValueError('Wrap review requires an explicit value and reason')
        fields = review['fields']
        # Keep every table, row, row identity and unrelated column. The normal
        # importer includes ID even when wrap was the only varying attribute.
        for field in fields:
            for table in field_tables(field):
                if WRAP in table['columns']:
                    if len(table['columns']) == 1:
                        raise ValueError('Cannot remove the only table column')
                    index = table['columns'].index(WRAP)
                    table['columns'].pop(index)
                    for row in table['rows']:
                        row.pop(index)
        fields[:] = [f for f in fields if f['label'] != WRAP]
        position = next((n for n, f in enumerate(fields)
                         if f['label'] in FIELD_ORDER and FIELD_ORDER.index(f['label']) > FIELD_ORDER.index(WRAP)), len(fields))
        fields.insert(position, {'label': WRAP, 'value': value.strip()})
        validate_table_navigation(fields)
        review.setdefault('wrap_reviews', []).append(deepcopy(decision))
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--reviews', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    original = json.loads(args.bundle.read_text(encoding='utf-8'))
    # Check fingerprints and navigation before and after editing. Validation
    # mutates its argument with runtime metadata, so validate separate copies.
    library = ReferenceLibrary(args.bundle.parent)
    library._validate(deepcopy(original))
    candidate = apply_reviews(original, json.loads(args.reviews.read_text(encoding='utf-8')))
    library._validate(deepcopy(candidate))
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(candidate, stream, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    print('Validated candidate written; original bundle unchanged.')


if __name__ == '__main__':
    main()
