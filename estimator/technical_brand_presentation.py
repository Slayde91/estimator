"""Manufacturer-specific display cleanup after source-bound review validation.

Only projected fields change. Original rows, variant identities and reviews
remain in technical_basis and the installed supplier index is never rewritten.
"""

import re

from .technical_rating_summary import summarize_ratings
from .technical_table_navigation import field_tables, validate_table_navigation
from .technical_record_corrections import reviewed_boss_construction, reviewed_promat_table


_HIDDEN_COLUMNS = {'id', 'configuration', 'source configuration'}
_PARAGRAPHS = re.compile(r'\n\s*\n')


def _manufacturer(item):
    names = item.get('filter_values', {}).get('manufacturer', [])
    if not names:
        names = [f['value'] for f in item.get('fields', [])
                 if f['label'] == 'Manufacturer']
    return {name.strip().casefold() for name in names}


def boss_product_names(value):
    """Retain product names, hiding only the importer's two code labels."""
    return '\n'.join(line for line in value.splitlines() if not re.match(
        r'^\s*(?:Product code|Collar / wrap component code)\s*:', line, re.I)).strip()


def _service_size(value):
    value = re.sub(r'\b(?:Floor\s*-\s*Vertical|Wall\s*-\s*Horizontal)\b', '', value)
    value = re.sub(r'^[ \t]*-[ \t]*(?=Retrofit|Cast In)', '', value, flags=re.M)
    # "None Armaflex ..." is not an empty-insulation statement. Preserve it.
    value = re.sub(r'Existing insulation:\s*None\s*\.?\s*(?=$|[;\n])', '', value)
    value = re.sub(r',\s*,', ',', value)
    parts = [part.strip(' ,;\n') for part in _PARAGRAPHS.split(value)]
    return '\n\n'.join(part for part in parts if part)


def simplify_promat_wrap(value):
    parts = [part.strip() for part in value.strip().rstrip('.').split(';')]
    clean = []
    for part in parts:
        part = re.sub(r'^Configuration:\s*', '', part)
        location = re.fullmatch(r'(Wall|Floor)\s*-\s*(both sides|upperside|underside)(.*)', part, re.I)
        if location:
            preceding = '; '.join(clean)
            side, suffix = location[2].lower(), location[3].strip()
            redundant = (side == 'upperside' and re.search(r'Top Side Only|on top side', preceding, re.I)
                         or side == 'both sides' and re.search(r'Each Face|on both sides|Above and Below', preceding, re.I)
                         or preceding.casefold() in {'none', 'n/a'})
            if redundant:
                # A second length is removable only when explicitly identical.
                length = re.fullmatch(r'(\d+(?:\.\d+)?)\s*mm Long', suffix, re.I)
                measured = '; '.join(part for part in clean if re.search(
                    r'Each Face|on both sides|Above and Below|Top Side Only|on top side', part, re.I))
                if length and re.search(r'(?<![\d.])' + re.escape(length[1]) + r'\s*mm\b', measured, re.I):
                    suffix = ''
                part = suffix
            elif suffix and side == 'both sides' and re.search(r'\bboth faces\b', suffix, re.I):
                # The suffix itself must state the same placement. A length
                # alone cannot replace a conflicting side requirement.
                part = suffix
        if part:
            clean.append(part)
    result = '; '.join(clean)
    return result + ('.' if result and result.casefold() not in {'none', 'n/a'} else '')


def _installation(value):
    result = []
    for paragraph in _PARAGRAPHS.split(value):
        paragraph = paragraph.strip()
        if paragraph.startswith(('Service configuration:', 'Pass the ', 'The configuration table pairs ')):
            continue
        paragraph = re.sub(r'Fire exposure:[^.]*\.\s*', '', paragraph)
        # The selector's standard is one exact clause. Trailing prose may
        # contain distinct fixing/board requirements and must survive.
        paragraph = paragraph.replace('Test standard: AS1530.4.', '').strip()
        paragraph = re.sub(r'\bService wrap:\s*(.+?)(?=\s+(?:Local protection|Seal depth / fillet size|Annular gap|Collar|Location):|$)',
                           lambda match: 'Service wrap: ' + simplify_promat_wrap(match[1]).rstrip('.') + '.', paragraph)
        if paragraph:
            result.append(paragraph)
    return '\n\n'.join(result)


def _clean_value(label, value):
    if label == 'Service Size / Configuration':
        return _service_size(value)
    if label == 'Service Wrap':
        return simplify_promat_wrap(value)
    if label == 'Installation Details':
        return _installation(value)
    return value


def _seal_product_row(columns, row, barrier):
    cells = dict(zip(columns, row))
    if (not re.search(r'Aperture seal:\s*(?:PROMASEAL®\s+)?Bulkhead Batt,\s*Thickness:\s*2x50mm', barrier)
            or cells.get('Barrier Construction') != 'PROMASEAL® Bulkhead Batt (Double Layer), ≥100'
            or cells.get('Installation Details')):
        return False
    return not any(value for label, value in cells.items()
                   if label not in {'ID', 'Barrier Construction', 'FRL'})


def _highest(values):
    summary = summarize_ratings(values)
    return summary['ratings'][-1] if summary['kind'] in {'single', 'range'} else None


def _promat_fields(fields):
    by_label = {field['label']: field for field in fields}
    barrier = by_label.get('Barrier Construction', {}).get('value', '')
    destinations = {}
    for field in fields:
        label = field['label']
        field['value'] = _clean_value(label, field['value'])
        original_tables = field_tables(field)
        kept, inventories, captions = [], [], []
        for ordinal, table in enumerate(original_tables):
            table = reviewed_promat_table(table)
            columns = table['columns']
            rows = [[_clean_value(name, cell) for name, cell in zip(columns, row)] for row in table['rows']]
            row_ids = field.get('table_row_ids', [[]] * len(original_tables))[ordinal]
            supported = {dict(zip(columns, row)).get('FRL') for row in rows
                         if not _seal_product_row(columns, row, barrier)}
            selected = [i for i, row in enumerate(rows)
                        if not (_seal_product_row(columns, row, barrier)
                                and dict(zip(columns, row)).get('FRL') in supported)]
            # Empty display-only columns otherwise turn into "Not recorded".
            visible = [i for i, name in enumerate(columns) if name.casefold() not in _HIDDEN_COLUMNS
                       and not (name in {'Service Size / Configuration', 'Installation Details'}
                                and all(not rows[n][i].strip() for n in selected))]
            rating_label = columns[visible[0]] if len(visible) == 1 else None
            rating_values = [rows[n][visible[0]] for n in selected] if rating_label in {'FRL', 'Blank Seal FRL'} else []
            highest = _highest(rating_values) if rating_values else None
            rating_field = by_label.get(rating_label)
            existing = summarize_ratings([rating_field['value']]) if rating_field else None
            if highest and (not rating_field or existing['kind'] in {'empty', 'single', 'range'}
                            and set(existing['ratings']).issubset(summarize_ratings(rating_values)['ratings'])):
                if rating_field is None:
                    rating_field = {'label': rating_label, 'value': highest}
                    fields.append(rating_field)
                    by_label[rating_label] = rating_field
                else:
                    rating_field['value'] = highest
                continue
            if not visible or not selected:
                continue
            # IDs are not displayed. Distinct source IDs alone must not create
            # repeated rows; every differing visible requirement still does.
            seen, unique = set(), []
            for n in selected:
                key = tuple(rows[n][i] for i in visible)
                if key not in seen:
                    seen.add(key)
                    unique.append(n)
            retained = [i for i in range(len(columns)) if i in visible or columns[i].casefold() in _HIDDEN_COLUMNS]
            destinations[label, ordinal] = len(kept)
            kept.append({'columns': [columns[i] for i in retained],
                         'rows': [[rows[n][i] if rows[n][i] or columns[i] != 'Installation Details' else '—'
                                   for i in retained] for n in unique]})
            if 'table_row_ids' in field:
                inventories.append([row_ids[n] for n in unique])
            if 'table_captions' in field:
                captions.append(field['table_captions'][ordinal])
        for key in ('table', 'tables', 'table_row_ids', 'table_captions'):
            field.pop(key, None)
        if kept:
            field['table' if len(kept) == 1 else 'tables'] = kept[0] if len(kept) == 1 else kept
            if inventories:
                field['table_row_ids'] = inventories
            if captions:
                field['table_captions'] = captions
    for field in fields:
        links = [{'field': link['field'], 'table_index': destinations[link['field'], link['table_index']]}
                 for link in field.get('table_links', [])
                 if (link['field'], link['table_index']) in destinations]
        if links:
            field['table_links'] = links
        else:
            field.pop('table_links', None)
    fields[:] = [field for field in fields if field.get('value') or any(
        field.get(key) for key in ('images', 'table', 'tables', 'table_links', 'report_links'))]
    validate_table_navigation(fields)


def present_manufacturer_fields(item):
    """Mutate an already-copied display item, never its retained source basis."""
    manufacturer = _manufacturer(item)
    if manufacturer == {'boss'}:
        construction = reviewed_boss_construction(item)
        for field in item.get('fields', []):
            if field['label'] == 'System Products':
                field['value'] = boss_product_names(field['value'])
            elif construction and field['label'] == 'Barrier Construction':
                field['value'] = construction
            elif construction and field['label'] == 'Source Issues':
                field['value'] = field['value'].replace(
                    'No approved substrate is marked in matrix columns K–AQ. '
                    'The originally tested construction has not been substituted as an approved alternative.\n', '')
    elif manufacturer == {'promat'}:
        _promat_fields(item.get('fields', []))
    return item
