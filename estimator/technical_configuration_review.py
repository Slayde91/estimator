"""Validate diagram-backed configuration transcriptions in private bundles.

The row inventory is supplied by a source review, not inferred from selector
prose. Paired tables must retain every reviewed source row in source order.
"""

from .technical_field_reviewed import review_fingerprint


def _invalid():
    raise ValueError('Invalid diagram configuration review')


def validate_configuration_review(review, item, assets):
    """Bind reviewed table contents and row coverage to registered source pages.

    Older editorial reviews need no diagram claim. A configuration review carries
    an explicit inventory so dropping a row, changing a cell or mixing tables
    from different source pages cannot silently reuse its review.
    """
    if 'configuration_sources' not in review:
        return
    sources = review['configuration_sources']
    if not isinstance(sources, list) or not 1 <= len(sources) <= 100:
        _invalid()
    fields = review['fields']
    used_tables, used_sources = set(), set()
    image_ids = {image['id'] for field in item.get('fields', [])
                 for image in field.get('images', [])}
    image_ids.update(image['id'] for image in item.get('images', []))
    for source in sources:
        if not isinstance(source, dict) or set(source) != {'asset_id', 'sha256', 'page', 'groups'}:
            _invalid()
        asset_id, page = source['asset_id'], source['page']
        if not isinstance(asset_id, str) or asset_id not in assets or type(page) is not int:
            _invalid()
        asset = assets[asset_id]
        if source['sha256'] != asset['sha256']:
            raise ValueError('Configuration source changed; review must be updated')
        if asset['pdf']:
            linked = any(s.get('document_id') == asset_id and s.get('page', 1) == page
                         for s in item.get('sources', []))
            if not linked or not 1 <= page <= asset['pages']:
                _invalid()
        elif page != 1 or asset_id not in image_ids:
            _invalid()
        if (asset_id, page) in used_sources:
            _invalid()
        used_sources.add((asset_id, page))
        groups = source['groups']
        if not isinstance(groups, list) or not 1 <= len(groups) <= 100:
            _invalid()
        for group in groups:
            if not isinstance(group, dict) or set(group) != {'row_ids', 'tables'}:
                _invalid()
            row_ids, references = group['row_ids'], group['tables']
            if (not isinstance(row_ids, list) or not 1 <= len(row_ids) <= 2000
                    or any(not isinstance(value, str) or not value.strip() or len(value) > 500
                           for value in row_ids) or len(set(row_ids)) != len(row_ids)
                    or not isinstance(references, list) or not 1 <= len(references) <= 20):
                _invalid()
            for reference in references:
                if not isinstance(reference, dict) or set(reference) != {'label', 'table_index', 'sha256'}:
                    _invalid()
                label, index = reference['label'], reference['table_index']
                if not isinstance(label, str) or type(index) is not int or index < 0:
                    _invalid()
                matching = [field for field in fields if field['label'] == label]
                if len(matching) != 1 or (label, index) in used_tables:
                    _invalid()
                used_tables.add((label, index))
                field = matching[0]
                tables = ([field['table']] if 'table' in field else []) + field.get('tables', [])
                if index >= len(tables):
                    _invalid()
                table = tables[index]
                if [row[0] for row in table['rows']] != row_ids:
                    raise ValueError('Configuration rows changed; review must be updated')
                if reference['sha256'] != review_fingerprint(table):
                    raise ValueError('Configuration table changed; review must be updated')
