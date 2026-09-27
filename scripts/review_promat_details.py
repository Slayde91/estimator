"""Apply source-bound editorial details to existing Promat library fields.

Review JSON and supplier content remain private. This tool preserves original
fields, source IDs, other reviews, all configuration rows and technical ratings.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from estimator.reference_library import ReferenceLibrary, field_text
from estimator.technical_field_reviewed import review_fingerprint
from estimator.promat_service_text import clean_service_size
from estimator.technical_table_navigation import field_tables


def evidence(item):
    return {'source_fields': item['fields'],
            'reviewed_fields': item['technical_field_review']['fields'],
            'promat_source': item['promat_source']}


def apply_reviews(bundle, decisions):
    candidate = deepcopy(bundle)
    items = {i['id']: i for i in candidate['libraries']['technical']['items']}
    seen = set()
    for decision in decisions:
        key = decision['id']
        if key in seen:
            raise ValueError('Duplicate details review')
        seen.add(key)
        item = items[key]
        if not item.get('promat_source') or not item.get('technical_field_review'):
            raise ValueError('Expected a reviewed Promat entry')
        if decision['expected_sha256'] != review_fingerprint(evidence(item)):
            raise ValueError('Promat evidence changed; update the details review')
        if decision['variant_ids'] != item['promat_source']['variant_ids']:
            raise ValueError('Details review must cover every variant in source order')
        source_diagrams = sorted({sha for p in item['promat_source']['pages'] for sha in p['diagrams']})
        if decision['diagram_sha256'] != source_diagrams:
            raise ValueError('Review must identify the exact source diagrams')
        summary = decision['installation_details']
        if not isinstance(summary, str) or not summary.strip():
            raise ValueError('Installation summary is required')
        fields = item['technical_field_review']['fields']
        target = next(f for f in fields if f['label'] == 'Installation Details')
        target['value'] = summary.strip()
        # Existing varying instructions stay paired with their configurations.
        for field in fields:
            if field['label'] == 'Service Size / Configuration':
                field['value'] = clean_service_size(field['value'])
            for table in field_tables(field):
                if 'Service Size / Configuration' in table['columns']:
                    col = table['columns'].index('Service Size / Configuration')
                    for row in table['rows']:
                        row[col] = clean_service_size(row[col])
        if decision.get('report'):
            report = decision['report']
            field = next((f for f in fields if f['label'] == 'Report Number'), None)
            if field is None:
                field = {'label': 'Report Number', 'value': report['label']}
                fields.append(field)
            elif field['value'] != report['label']:
                raise ValueError('Report identity cannot be replaced by a details review')
            field['report_links'] = [deepcopy(report)]
            field_text([field], {})
        item['technical_field_review'].setdefault('details_reviews', []).append(deepcopy(decision))
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('bundle', 'reviews', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    original = json.loads(args.bundle.read_text(encoding='utf-8'))
    library = ReferenceLibrary(args.bundle.parent)
    library._validate(deepcopy(original))
    candidate = apply_reviews(original, json.loads(args.reviews.read_text(encoding='utf-8')))
    library._validate(deepcopy(candidate))
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(candidate, stream, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    print('Validated candidate written; original bundle unchanged.')


if __name__ == '__main__':
    main()
