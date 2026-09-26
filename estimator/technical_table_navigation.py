"""Validate local field-to-table references without accepting URLs or HTML."""

CONFIGURATION_FIELD = 'Service Size / Configuration'
TABLE_TARGET_FIELDS = {CONFIGURATION_FIELD, 'Barrier Construction'}


def field_tables(field):
    """Use the same zero-based table sequence as the source review and UI."""
    return ([field['table']] if 'table' in field else []) + field.get('tables', [])


def validate_table_navigation(fields):
    """Require unambiguous, in-record destinations for configuration links.

    Table shapes and cell text are validated separately by the library loader.
    Captions stay aligned with table positions, including equal table contents
    with different provenance. Older fields need no navigation metadata.
    """
    if not any(any(key in field for key in ('table_links', 'table_captions', 'table_row_ids'))
               for field in fields):
        return
    labels = [field['label'] for field in fields]
    if len(set(labels)) != len(labels):
        raise ValueError('Table navigation requires unique field labels')
    by_label = {field['label']: field for field in fields}
    for field in fields:
        if 'table_row_ids' in field:
            inventories, tables = field['table_row_ids'], field_tables(field)
            if (not isinstance(inventories, list) or not inventories
                    or len(inventories) != len(tables)):
                raise ValueError('Table row identifiers must match the table sequence')
            for row_ids, table in zip(inventories, tables):
                if (not isinstance(row_ids, list) or len(row_ids) != len(table['rows'])
                        or len(row_ids) > 2000
                        or any(not isinstance(value, str) or not value.strip()
                               or len(value) > 500 for value in row_ids)
                        or len(set(row_ids)) != len(row_ids)):
                    raise ValueError('Invalid table row identifiers')
        if 'table_captions' in field:
            captions = field['table_captions']
            if (not isinstance(captions, list) or not captions
                    or len(captions) != len(field_tables(field))
                    or any(not isinstance(caption, str) or not caption.strip()
                           or len(caption) > 2000 for caption in captions)):
                raise ValueError('Table captions must match the table sequence')
        if 'table_links' not in field:
            continue
        links = field['table_links']
        if not isinstance(links, list) or not 1 <= len(links) <= 100:
            raise ValueError('Invalid configuration table links')
        seen = set()
        for link in links:
            if (not isinstance(link, dict) or set(link) != {'field', 'table_index'}
                    or not isinstance(link['field'], str)
                    or link['field'] not in TABLE_TARGET_FIELDS
                    or type(link['table_index']) is not int
                    or field['label'] == link['field']):
                raise ValueError('Invalid configuration table link')
            target = by_label.get(link['field'])
            index = link['table_index']
            key = (link['field'], index)
            if target is None or not 0 <= index < len(field_tables(target)) or key in seen:
                raise ValueError('Missing or duplicate configuration table destination')
            seen.add(key)
