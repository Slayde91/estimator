"""Stable public Technical Library identifiers, applied after supplier evidence validation."""
import re

from .technical_brand_presentation import manufacturer_names
from .technical_manufacturers import manufacturer_fields
from .technical_fields import is_hidden_technical_label
from .technical_prose import public_prose_fields
from .technical_relevance import primary_fields
from .technical_table_navigation import field_tables
from .technical_variant_presentation import variant_display


_CF_MANUFACTURERS = {'promat', 'promat australia', 'trafalgar', 'trafalgar fire', 'snap', 'snap fire systems', 'allproof', 'fendix'}
_BONDECK = re.compile(r'\bbondeck\b', re.I)
_SNAP_SYSTEM = re.compile(r'\bSNAP system \d+\b', re.I)
_SNAP_SOURCE = re.compile(r'\bSNAP product filter, system \d+\b', re.I)
_SELECTOR_HEADING = re.compile(r'^(Promat(?: Australia)?|Trafalgar(?: Fire)?)\s*(?::|\s)\s*(?:sys_var_\d+_au|\d+)(?:\s*\(\+\d+ variants listed below\))?\s*(?=[—–]|$)', re.I)
_HIDDEN_SEARCH_COLUMNS = {'id', 'configuration', 'source configuration'}


def bondek(value):
    return _BONDECK.sub('Bondek', value) if 'bondeck' in value.casefold() else value


def _allocated_ids(store, keys):
    # The table is append-only. Removing a library record reserves its number.
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('''CREATE TABLE IF NOT EXISTS technical_library_public_ids (
            number INTEGER PRIMARY KEY, item_id TEXT NOT NULL UNIQUE)''')
        numbers = {key: number for number, key in db.execute('SELECT number, item_id FROM technical_library_public_ids')}
        missing = sorted(keys - numbers.keys())
        if missing:
            db.executemany('INSERT INTO technical_library_public_ids(item_id) VALUES (?)',
                           [(key,) for key in missing])
            numbers = {key: number for number, key in db.execute('SELECT number, item_id FROM technical_library_public_ids')}
    return {key: f'CF-{number:02d}' for key, number in numbers.items()}


def _caption_text(text, key, code):
    value = bondek(text)
    if code.startswith('CF-'):
        if key in value:
            value = value.replace(key, code)
        value = _SNAP_SYSTEM.sub(code, value)
        value = _SNAP_SOURCE.sub('SNAP product filter', value)
    return value


def public_caption(data, key, record):
    """Use the existing source_code response value and preserve the opaque route ID."""
    public_id = data.get('_technical_public_ids', {}).get(key)
    if not public_id:
        return record
    result = dict(record)
    result['source_code'] = public_id
    for name in ('title', 'subtitle', 'summary', 'configuration'):
        if result.get(name):
            result[name] = _caption_text(result[name], key, public_id)
    old_code = record.get('source_code', '')
    if public_id.startswith('CF-') and old_code and old_code != public_id:
        for name in ('subtitle', 'configuration'):
            prefix = old_code + ' — '
            if result.get(name, '').startswith(prefix):
                result[name] = public_id + result[name][len(old_code):]
    if result.get('title'):
        title = result['title']
        if public_id.startswith('CF-'):
            title = _SELECTOR_HEADING.sub(lambda m: m[1] + ': ' + public_id + ' ', title).rstrip()
        result['title'] = title
    return result


def public_fields(fields, key, code):
    if not code:
        return fields
    projected = []
    found = False
    for field in fields:
        if field['label'] == 'ID':
            projected.append({**field, 'value': code})
            found = True
            continue
        updated = dict(field)
        updated['value'] = _caption_text(field.get('value', ''), key, code)
        for name in ('table', 'tables'):
            if name not in field:
                continue
            tables = [field[name]] if name == 'table' else field[name]
            cleaned = [_public_table(table, code) for table in tables]
            updated[name] = cleaned[0] if name == 'table' else cleaned
        if 'table_captions' in field:
            updated['table_captions'] = [_caption_text(c, key, code) for c in field['table_captions']]
        if 'images' in field:
            updated['images'] = [_image(image, key, code) for image in field['images']]
        projected.append(updated)
    if not found:
        projected.insert(0, {'label': 'ID', 'value': code})
    return projected


def _public_table(table, code):
    columns = table['columns']
    indices = list(range(len(columns)))
    if code.startswith('CF-') and len(columns) > 1:
        public = [i for i in indices if columns[i].strip().casefold() != 'id']
        if public:
            indices = public
    return {**table, 'columns': [bondek(columns[i]) for i in indices],
            'rows': [[bondek(row[i]) for i in indices] for row in table['rows']]}


def _image(image, key, code):
    return {**image, 'caption': _caption_text(image['caption'], key, code)} if image.get('caption') else image


def public_item(data, key, record):
    result = public_caption(data, key, record)
    code = data.get('_technical_public_ids', {}).get(key)
    if not code:
        return result
    allocated = data.get('_technical_allocated_ids', {}).get(key)
    if allocated:
        result['classifire_system_id'] = allocated
    if 'fields' in record:
        fields = public_fields(record['fields'], key, code)
        result['fields'] = manufacturer_fields(fields, data.get('_technical_discovery', {}).get(key, {}).get('manufacturer', []))
    if 'images' in record:
        result['images'] = [_image(image, key, code) for image in record['images']]
    if 'sources' in record:
        result['sources'] = [{**s, 'label': _caption_text(s['label'], key, code)} if s.get('label') else s
                             for s in record['sources']]
    return result


def _search_evidence(data, key, item, display):
    code = data['_technical_public_ids'][key]
    names = ('title', 'subtitle', 'summary', 'configuration')
    caption = public_caption(data, key, {name: display.get(name, item.get(name, ''))
                                         for name in (*names, 'source_code')})
    text = [code, *(caption.get(name, '') for name in names)]
    fields = public_prose_fields(item)
    data['_technical_relevance_fields'][key] = tuple(_caption_text(value, key, code) for value in primary_fields(fields))
    for field in fields:
        if field['label'] == 'ID' or is_hidden_technical_label(field['label']):
            continue
        text.append(field.get('value', ''))
        text.extend(field.get('table_captions', ()))
        text.extend(image.get('caption', '') for image in field.get('images', ()))
        for table in field_tables(field):
            cols = [i for i, col in enumerate(table['columns']) if col.strip().casefold() not in _HIDDEN_SEARCH_COLUMNS]
            text.extend(table['columns'][i] for i in cols)
            text.extend(row[i] for row in table['rows'] for i in cols)
    text.extend(image.get('caption', '') for image in item.get('images', ()))
    text.extend(source.get('label', '') for source in item.get('sources', ()))
    text.extend(value for values in data['_technical_discovery'][key].values() for value in values)
    return _caption_text('\n'.join(text), key, code).casefold()


def install_public_ids(data, store):
    """Assign canonical items once from the whole reviewed snapshot, independent of browsing."""
    records = data['_technical_public_records']
    visible = data['_visible']['technical']
    managed = {key for key in visible if manufacturer_names(records[key]) & _CF_MANUFACTURERS}
    retained = _allocated_ids(store, managed)
    ids = {key: retained[key] for key in visible if key in retained}
    displays = {key: variant_display(data, key) for key in visible}
    for key in visible:
        if key not in ids:
            name = next((f.get('value', '').strip() for f in records[key].get('fields', []) if f['label'] == 'ID'), '')
            ids[key] = displays[key].get('source_code') or name or key
    ids.update({alias: ids[target] for alias, target in data['_aliases'].items() if target in ids})
    data['_technical_allocated_ids'] = {key: code for key, code in ids.items()
                                       if data['_aliases'].get(key, key) in retained}
    data['_technical_public_ids'] = ids
    data['_technical_relevance_fields'] = {}
    for facets in data['_technical_discovery'].values():
        for name, values in facets.items():
            if any('bondeck' in value.casefold() for value in values):
                facets[name] = list(dict.fromkeys(bondek(value) for value in values))
    for definitions in (data['_filters']['technical'], data['_canonical_library_filters']):
        for definition in definitions:
            seen = set()
            options = []
            for option in definition.get('options', ()):
                value = bondek(option['value'])
                if value not in seen:
                    options.append({**option, 'value': value, 'label': bondek(option['label'])})
                    seen.add(value)
            definition['options'] = options
    for key in visible:
        data['_searches']['technical'][key] = _search_evidence(data, key, records[key], displays[key])

