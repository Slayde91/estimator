"""Present existing option relationships without exposing import labels.

This runs after source-bound reviews. Numbered relationships come from explicit
source option identifiers, never from coincidental text order or rating size.
Original fields remain available in technical_basis for traceability.
"""
import re

from .technical_rating_summary import summarize_ratings
from .technical_table_navigation import field_tables, validate_table_navigation


_OPTION = re.compile(r'\bSource options?\s+(\d+(?:\s*(?:,|and)\s*\d+)*)\s*:\s*', re.I)


def _options(value):
    matches = list(_OPTION.finditer(value))
    if not matches:
        return value, {}
    common = value[:matches[0].start()].strip()
    rows = {}
    for n, match in enumerate(matches):
        end = matches[n + 1].start() if n + 1 < len(matches) else len(value)
        content = value[match.end():end].strip()
        for key in re.findall(r'\d+', match[1]):
            rows.setdefault(int(key), []).append(content)
    return common, {key: '\n\n'.join(parts) for key, parts in rows.items()}


def _clean(value):
    return _OPTION.sub('', value).strip()


def _clean_images(images):
    for image in images:
        if 'caption' in image:
            image['caption'] = _clean(image['caption'])
        if 'captions' in image:
            image['captions'] = [_clean(value) for value in image['captions']]


def present_options(item):
    """Mutate only the projected display, preserving all paired cell contents."""
    fields = item.get('fields', [])
    parsed = [(field, *_options(field['value'])) for field in fields]
    numbered = [(field, common, rows) for field, common, rows in parsed if rows]
    if numbered:
        labels = {field['label'] for field, _, _ in numbered}
        target = 'Barrier Construction' if 'Barrier Construction' in labels else 'Service Size / Configuration'
        owner = next((field for field in fields if field['label'] == target), None)
        if owner is None:
            owner = {'label': target, 'value': ''}
            fields.append(owner)
        columns = [field['label'] for field, _, _ in numbered]
        ids = sorted({key for _, _, rows in numbered for key in rows})
        table = {'columns': columns,
                 'rows': [[rows.get(key, '') for _, _, rows in numbered] for key in ids]}
        # A common rating applies to the explicit alternatives and stays visible
        # in the FRL field. Include it alongside each barrier for easy comparison.
        common_rating = next((f for f in fields if f['label'] == 'FRL' and f['value'].strip()
                              and 'FRL' not in labels and not field_tables(f)), None)
        if common_rating is not None:
            table['columns'].append('FRL')
            for row in table['rows']:
                row.append(common_rating['value'])
        index = len(field_tables(owner))
        if index:
            owner.setdefault('tables', []).append(table)
            if 'table_row_ids' in owner:
                owner['table_row_ids'].append([f'option-{key}' for key in ids])
            if 'table_captions' in owner:
                owner['table_captions'].append('Barrier alternatives' if target == 'Barrier Construction' else 'Configuration alternatives')
        else:
            owner['table'] = table
            owner['table_row_ids'] = [[f'option-{key}' for key in ids]]
        link = {'field': target, 'table_index': index}
        for field, common, rows in numbered:
            field['value'] = common
            if field['label'] in {'FRL', 'Blank Seal FRL'}:
                summary = summarize_ratings(list(rows.values()))['summary']
                field['value'] = '\n\n'.join(filter(None, [common, summary]))
            if field is not owner and link not in field.setdefault('table_links', []):
                field['table_links'].append(dict(link))
        if common_rating is not None and common_rating is not owner:
            if link not in common_rating.setdefault('table_links', []):
                common_rating['table_links'].append(dict(link))
    for field in fields:
        field['value'] = _clean(field['value'])
        for table in field_tables(field):
            table['columns'] = [_clean(value) for value in table['columns']]
            table['rows'] = [[_clean(value) for value in row] for row in table['rows']]
        if 'table_captions' in field:
            field['table_captions'] = [_clean(value) for value in field['table_captions']]
        _clean_images(field.get('images', []))
    _clean_images(item.get('images', []))
    for name in ('title', 'subtitle', 'summary', 'source_label'):
        if name in item:
            item[name] = _clean(item[name])
    validate_table_navigation(fields)


def technical_title(item):
    """Use the same projected service, rating facets and orientation as detail."""
    fields = {field['label']: field['value'] for field in item.get('fields', [])}
    facets = item.get('filter_values', {})
    manufacturer = ', '.join(facets.get('manufacturer', [])) or fields.get('Manufacturer') or 'Unknown manufacturer'
    identity = fields.get('ID') or item['id']
    identity = re.sub(r'^sys_var_(\d+)_au(?:\s+\(\+\d+ variants listed below\))?$', r'\1', identity.strip(), flags=re.I)
    service = fields.get('Service') or ', '.join(facets.get('services', [])) or fields.get('Installation Type') or 'Service not specified'
    ratings = facets.get('frl', [])
    rating = summarize_ratings(ratings)['summary'] or '; '.join(ratings) or 'FRL not specified'
    orientation = ', '.join(facets.get('orientation', [])) or fields.get('Orientation') or 'Orientation not specified'
    return ' — '.join(' '.join(value.split()) for value in
                      (f'{manufacturer}: {identity}', service, rating, orientation))
