"""Remove exact single-row display repetitions, never source evidence or rules."""
import re

from .technical_table_navigation import field_tables


def _key(value):
    return ' '.join(str(value).strip().casefold().replace('×', 'x').split())


def compact_repeated_fields(fields):
    """Mutate response-copy fields only; alternatives and unmatched cells survive."""
    by_label = {}
    for field in fields:
        by_label.setdefault(_key(field['label']), []).append(field)

    def repeated(labels, cell):
        candidates = [field for label in labels for field in by_label.get(label, [])]
        return (bool(_key(cell)) and len(candidates) == 1
                and not field_tables(candidates[0]) and _key(candidates[0]['value']) == _key(cell))

    removed = set()
    for field in fields:
        tables = field_tables(field)
        if len(tables) != 1:
            continue
        table = tables[0]
        if len(table['rows']) != 1 or len(table['rows'][0]) != len(table['columns']):
            continue
        cells = {_key(label): cell for label, cell in zip(table['columns'], table['rows'][0])
                 if _key(label) not in {'id', 'configuration', 'source configuration'}}
        if len(cells) != len([label for label in table['columns']
                              if _key(label) not in {'id', 'configuration', 'source configuration'}]):
            continue
        label = field['label']
        if label == 'Barrier Construction':
            barrier = cells.get('substrate', cells.get('separating element'))
            if barrier is None or not _key(barrier) or (_key(field['value']) and _key(field['value']) != _key(barrier)):
                continue
            other = {key: value for key, value in cells.items() if key not in {'substrate', 'separating element'}}
            aliases = {'frl': ['frl', 'blank seal frl'],
                       'max aperture size': ['maximum opening size', 'max. opening size', 'max opening size']}
            if not other or any(key not in aliases or not repeated(aliases[key], value) for key, value in other.items()):
                continue
            field['value'] = barrier
        elif label == 'Service Size / Configuration':
            detail = cells.get('service detail')
            aliases = {'service type': ['service type', 'service', 'services'], 'frl': ['frl', 'blank seal frl'],
                       'twrap length': ['twrap length', 'service wrap']}
            if not detail or set(cells) - {'service detail', *aliases}:
                continue
            if any(not repeated(aliases[key], value) for key, value in cells.items() if key != 'service detail'):
                continue
            # The only removable prose is the exact source-generated cell list.
            value = field['value']
            parts = [part.strip() for part in re.split(r';\s*', value)]
            expected = [f'{column}: {cell}'.strip() for column, cell in zip(table['columns'], table['rows'][0])
                        if _key(column) != 'frl' and _key(column) not in {'id', 'configuration', 'source configuration'}]
            if _key(value) != _key(detail) and [_key(part) for part in parts] != [_key(part) for part in expected]:
                continue
            field['value'] = detail
        else:
            continue
        for name in ('table', 'tables', 'table_captions', 'table_row_ids'):
            field.pop(name, None)
        removed.add(label)
    for field in fields:
        for label in removed:
            # A removed single table is now the named scalar field. Keep the
            # condition but retire its obsolete table locator in display prose.
            field['value'] = re.sub(re.escape(label) + r' table 1\b', label,
                                    field['value'], flags=re.I)
        if 'table_links' in field:
            links = [link for link in field['table_links'] if link['field'] not in removed]
            if links:
                field['table_links'] = links
            else:
                field.pop('table_links')
    return fields
