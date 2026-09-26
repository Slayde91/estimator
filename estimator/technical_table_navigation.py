"""Validate local field-to-table references without accepting URLs or HTML."""

CONFIGURATION_FIELD = 'Service Size / Configuration'


def field_tables(field):
    """Use the same zero-based table sequence as the source review and UI."""
    return ([field['table']] if 'table' in field else []) + field.get('tables', [])


def validate_table_navigation(fields):
    """Require unambiguous, in-record destinations for configuration links.

    Table shapes and cell text are validated separately by the library loader.
    Captions stay aligned with table positions, including equal table contents
    with different provenance. Older fields need no navigation metadata.
    """
    if not any('table_links' in field or 'table_captions' in field for field in fields):
        return
    labels = [field['label'] for field in fields]
    if len(set(labels)) != len(labels):
        raise ValueError('Table navigation requires unique field labels')
    by_label = {field['label']: field for field in fields}
    for field in fields:
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
                    or link['field'] != CONFIGURATION_FIELD
                    or type(link['table_index']) is not int
                    or field['label'] == CONFIGURATION_FIELD):
                raise ValueError('Invalid configuration table link')
            target = by_label.get(CONFIGURATION_FIELD)
            index = link['table_index']
            if target is None or not 0 <= index < len(field_tables(target)) or index in seen:
                raise ValueError('Missing or duplicate configuration table destination')
            seen.add(index)

