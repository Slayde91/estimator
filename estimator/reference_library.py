"""Read-only, local reference libraries with one shared set of reciprocal links.

Source documents and extracted supplier content live outside the distribution.
Only registered, fingerprinted PDFs and raster images can be served.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
from threading import RLock

from .catalog import ROOT, ValidationError
from .technical_fields import (FIELD_LABELS, LEGACY_LABELS,
                               is_hidden_technical_label, normalize_technical_item)

KINDS = {'penetration': 'Firestopping Library', 'technical': 'Technical Library'}
IDENTIFIER = re.compile(r'[a-z0-9][a-z0-9_-]{0,119}\Z')
MAX_INDEX = 64 * 1024 * 1024
MAX_ASSET = 128 * 1024 * 1024


def _field_label_key(value):
    value = re.sub(r'\s*\((?:Source Reference|Selector Search)\)\s*$', '', value, flags=re.I)
    return re.sub(r'[^a-z0-9]', '', value.casefold())


_HIDDEN_REVIEW_LABELS = {
    _field_label_key(label)
    for label, destination in {**FIELD_LABELS, **LEGACY_LABELS}.items()
    if destination is None
} | {
    _field_label_key(label) for label in (
        'Technical Basis', 'Diagram captions (visually checked)',
        'Workbook report revision', 'Reference review',
    )
}


class ReferenceNotFound(Exception):
    pass


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValidationError('Invalid library reference.')
    return value


def string(value, maximum=100000):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValidationError('Invalid library text.')
    return value


def number(value, minimum=0, maximum=100000):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValidationError('Invalid library count.')
    return value


def field_text(fields, assets, *, projected=False):
    """Validate imported or reviewed fields before any presentation or search."""
    if not isinstance(fields, list) or len(fields) > 1000:
        raise ValueError('Field limits')
    text = []
    for field in fields:
        text += [string(field['label'], 500), string(field['value'])]
        tables = [field['table']] if 'table' in field else []
        if 'tables' in field:
            if not isinstance(field['tables'], list) or len(field['tables']) > 100:
                raise ValueError('Source table limits')
            tables += field['tables']
        for table in tables:
            if not isinstance(table, dict) or set(table) != {'columns', 'rows'}:
                raise ValueError('Invalid source table')
            columns, rows = table['columns'], table['rows']
            if not isinstance(columns, list) or not 1 <= len(columns) <= 20 or not isinstance(rows, list) or len(rows) > 2000:
                raise ValueError('Source table limits')
            text.extend(string(column, 500) for column in columns)
            for row in rows:
                if not isinstance(row, list) or len(row) != len(columns):
                    raise ValueError('Source table columns must remain aligned')
                text.extend(string(cell, 20000) for cell in row)
        for image in field.get('images', []):
            if assets[image['id']]['pdf']:
                raise ValueError('Field image is a PDF')
            string(image.get('caption', ''), 2000)
    return text


class ReferenceLibrary:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory is not None else ROOT / '.runtime' / 'reference-library'
        self._lock = RLock()
        self._stamp = None
        self._data = None

    def _load(self):
        index = self.directory / 'library.json'
        try:
            info = index.stat()
        except FileNotFoundError:
            self._data = None
            self._stamp = None
            return None
        except OSError as exc:
            raise ValidationError('The local reference library could not be read. Rebuild it from the source files.') from exc
        stamp = (info.st_mtime_ns, info.st_size, info.st_ctime_ns)
        if self._data is not None and stamp == self._stamp:
            return self._data
        if info.st_size > MAX_INDEX or not index.resolve().is_relative_to(self.directory.resolve()):
            raise ValidationError('The local reference library index is invalid.')
        try:
            with index.open('rb') as stream:
                payload = stream.read(MAX_INDEX + 1)
            if len(payload) > MAX_INDEX:
                raise ValueError('Index limit')
            data = json.loads(payload, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            self._validate(data)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise ValidationError('The local reference library could not be read. Rebuild it from the source files.') from exc
        self._data, self._stamp = data, stamp
        return data

    def _validate(self, data):
        if not isinstance(data, dict) or type(data['schema_version']) is not int or data['schema_version'] != 1:
            raise ValueError('Unsupported library schema')
        documents = data['documents']
        images = data.get('images', [])
        if not isinstance(documents, list) or len(documents) > 1000 or not isinstance(images, list) or len(images) > 50000:
            raise ValueError('Asset limits')
        assets = {}
        for asset, is_pdf in [(value, True) for value in documents] + [(value, False) for value in images]:
            key = identifier(asset['id'])
            if key in assets:
                raise ValueError('Duplicate asset')
            string(asset['filename'], 500)
            if not re.fullmatch('[a-f0-9]{64}', asset['sha256']):
                raise ValueError('Invalid fingerprint')
            if is_pdf:
                number(asset['pages'], 1, 10000)
                extension = '.pdf'
            else:
                extension = asset['extension']
                if extension not in {'.png', '.jpg', '.jpeg'}:
                    raise ValueError('Unsupported image')
            assets[key] = {**asset, 'extension': extension, 'pdf': is_pdf}
        records, searches, filters = {}, {}, {}
        if set(data['libraries']) != set(KINDS):
            raise ValueError('Missing library')
        for kind in KINDS:
            library = data['libraries'][kind]
            items = library['items']
            if not isinstance(items, list) or len(items) > 50000:
                raise ValueError('Item limits')
            definitions = library.get('filters', [])
            if not isinstance(definitions, list) or len(definitions) > 20:
                raise ValueError('Filter limits')
            filter_labels = {}
            for entry in definitions:
                key = identifier(entry['key'])
                if key in {'search', 'offset', 'limit', 'technical_reference'} or key in filter_labels:
                    raise ValueError('Reserved filter')
                filter_labels[key] = string(entry['label'], 100)
            records[kind], searches[kind] = {}, {}
            filter_values = {key: set() for key in filter_labels}
            for item in items:
                if kind == 'technical' and 'technical_basis' in item:
                    # Only the runtime creates this metadata. Trusting a marker
                    # imported from an index would bypass source projection and
                    # any review fingerprints via the idempotency shortcut.
                    raise ValueError('Technical basis is computed runtime metadata')
                key = identifier(item['id'])
                if key in records[kind]:
                    raise ValueError('Duplicate item')
                text = [string(item['title'], 2000)]
                for name in ('subtitle', 'summary', 'source_label'):
                    text.append(string(item.get(name, ''), 20000))
                text += field_text(item.get('fields', []), assets)
                if kind == 'technical' and 'technical_field_review' in item:
                    reviewed_fields = item['technical_field_review']['fields']
                    field_text(reviewed_fields, assets, projected=True)
                    if any(is_hidden_technical_label(field['label'])
                           or _field_label_key(field['label']) in _HIDDEN_REVIEW_LABELS
                           for field in reviewed_fields):
                        raise ValueError('Reviewed fields cannot expose hidden technical metadata')
                for source in item.get('sources', []):
                    text += [string(source.get('label', ''), 2000), string(source.get('filename', ''), 500)]
                    if 'document_id' in source:
                        document = assets[source['document_id']]
                        if not document['pdf']:
                            raise ValueError('Source is not a PDF')
                        number(source.get('page', 1), 1, document['pages'])
                    if 'row' in source:
                        number(source['row'], 1, 1048576)
                for image in item.get('images', []):
                    if assets[image['id']]['pdf']:
                        raise ValueError('Image is a PDF')
                    string(image.get('caption', ''), 2000)
                values = item.get('filter_values', {})
                if set(values) - set(filter_labels):
                    raise ValueError('Unknown filter')
                for field, selected in values.items():
                    if not isinstance(selected, list):
                        raise ValueError('Filter values must be lists')
                    for value in selected:
                        filter_values[field].add(string(value, 1000))
                if kind == 'technical':
                    # Validate the original evidence before projecting its display.
                    # Keep the imported record in libraries/items unchanged: source
                    # fingerprints and saved manual links depend on those bytes.
                    item = normalize_technical_item(item)
                    text = [item.get(name, '') for name in ('title', 'subtitle', 'summary', 'source_label')]
                    for field in item.get('fields', []):
                        text.extend((field['label'], field['value']))
                        tables = ([field['table']] if 'table' in field else []) + field.get('tables', [])
                        for table in tables:
                            text.extend(table['columns'])
                            text.extend(cell for row in table['rows'] for cell in row)
                    for source in item.get('sources', []):
                        text.extend((source.get('label', ''), source.get('filename', '')))
                records[kind][key] = item
                searches[kind][key] = '\n'.join(text).casefold()
            filters[kind] = [{'key': key, 'label': label, 'options': [{'value': value, 'label': value} for value in sorted(filter_values[key], key=str.casefold)]} for key, label in filter_labels.items()]
        links = {kind: {key: [] for key in records[kind]} for kind in KINDS}
        seen = set()
        if not isinstance(data['links'], list) or len(data['links']) > 500000:
            raise ValueError('Link limits')
        for link in data['links']:
            left, right = link['penetration_id'], link['technical_id']
            pair = (left, right)
            if pair in seen:
                raise ValueError('Duplicate link')
            seen.add(pair)
            relationship = string(link['relationship'], 4000)
            for kind, source, target_kind, target in [('penetration', left, 'technical', right), ('technical', right, 'penetration', left)]:
                title = records[target_kind][target]['title']
                links[kind][source].append({'kind': target_kind, 'id': target, 'title': title, 'relationship': relationship,
                                          **({'origin': 'user'} if link.get('origin') == 'user' else {})})
        data['_records'], data['_searches'], data['_filters'], data['_links'], data['_assets'] = records, searches, filters, links, assets

    def overview(self):
        with self._lock:
            data = self._load()
            return {'libraries': [{'id': kind, 'title': title, 'available': data is not None,
                     'count': len(data['_records'][kind]) if data else 0,
                     'linked_count': sum(bool(value) for value in data['_links'][kind].values()) if data else 0,
                     'unlinked_count': sum(not value for value in data['_links'][kind].values()) if data else 0,
                     'source_count': len(data['documents']) if data and kind == 'technical' else 1 if data else 0,
                     'notice': data['libraries'][kind].get('notice', '') if data else 'No local reference library has been installed.'} for kind, title in KINDS.items()],
                    'notice': data.get('notice', '') if data else ''}

    def listing(self, kind, **query):
        with self._lock:
            if kind not in KINDS:
                raise ReferenceNotFound()
            data = self._load()
            filter_keys = {entry['key'] for entry in data['_filters'][kind]} if data else set()
            if set(query) - {'search', 'offset', 'limit', *({'technical_reference'} if kind == 'penetration' else set())} - filter_keys:
                raise ValidationError('Unknown library search option.')
            reference = query.get('technical_reference', 'any')
            if reference not in ('any', 'linked', 'unlinked'):
                raise ValidationError('Choose any, linked or unlinked technical references.')
            search = string(query.get('search', ''), 500).strip().casefold()
            def page_value(key, default, minimum, maximum):
                raw = query.get(key, str(default))
                if not isinstance(raw, str) or not re.fullmatch(r'\d{1,7}', raw):
                    raise ValidationError('Invalid library page option.')
                return number(int(raw), minimum, maximum)
            offset, limit = page_value('offset', 0, 0, 1000000), page_value('limit', 50, 1, 100)
            chosen = {key: string(query[key], 1000) for key in filter_keys if query.get(key)}
            items = []
            if data:
                for key, item in data['_records'][kind].items():
                    linked = bool(data['_links'][kind][key])
                    if (reference == 'linked' and not linked) or (reference == 'unlinked' and linked):
                        continue
                    if all(token in data['_searches'][kind][key] for token in search.split()) and all(value in item.get('filter_values', {}).get(name, []) for name, value in chosen.items()):
                        items.append({**{name: item.get(name, '') for name in ('id', 'title', 'subtitle', 'summary', 'source_label')},
                                      **{name: deepcopy(item[name]) for name in ('library_id', 'price', 'editable') if name in item},
                                      'related_count': len(data['_links'][kind][key])})
            counts = {'total': len(data['_records'][kind]) if data else 0,
                      'linked': sum(bool(value) for value in data['_links'][kind].values()) if data else 0,
                      'unlinked': sum(not value for value in data['_links'][kind].values()) if data else 0}
            filters = deepcopy(data['_filters'][kind]) if data else []
            if kind == 'penetration':
                filters.append({'key': 'technical_reference', 'label': 'Technical reference', 'options': [
                    {'value': 'any', 'label': 'Any'}, {'value': 'linked', 'label': 'Linked'}, {'value': 'unlinked', 'label': 'No linked reference'}]})
            return {'items': items[offset:offset + limit], 'total': len(items), 'offset': offset, 'limit': limit,
                    'counts': counts, 'filters': filters,
                    'notice': data['libraries'][kind].get('notice', '') if data else 'No local reference library has been installed.'}

    def detail(self, kind, key):
        with self._lock:
            identifier(key)
            data = self._load()
            if not data or kind not in KINDS or key not in data['_records'][kind]:
                raise ReferenceNotFound()
            item = deepcopy(data['_records'][kind][key])
            item.pop('filter_values', None)
            item['links'] = deepcopy(data['_links'][kind][key])
            return item

    def asset(self, key, pdf=True):
        with self._lock:
            identifier(key)
            data = self._load()
            if not data or key not in data['_assets'] or data['_assets'][key]['pdf'] != pdf:
                raise ReferenceNotFound()
            asset = data['_assets'][key]
            path = self.directory / ('documents' if pdf else 'images') / (key + asset['extension'])
            if not path.resolve().is_relative_to(self.directory.resolve()):
                raise ValidationError('The library asset is outside its registered folder.')
            try:
                stat = path.stat()
                if not 0 < stat.st_size <= MAX_ASSET:
                    raise ValidationError('The library asset has an invalid size.')
                # Verify the bytes returned, not a separate path read that could change.
                with path.open('rb') as stream:
                    payload = stream.read(MAX_ASSET + 1)
                if len(payload) > MAX_ASSET:
                    raise ValidationError('The library asset has an invalid size.')
                if hashlib.sha256(payload).hexdigest() != asset['sha256']:
                    raise ValidationError('The library source has changed. Rebuild its index before opening it.')
                if pdf and not payload.startswith(b'%PDF-'):
                    raise ValidationError('The registered source is not a PDF.')
                if not pdf and not (payload.startswith(b'\x89PNG\r\n\x1a\n') or payload.startswith(b'\xff\xd8\xff')):
                    raise ValidationError('The registered image is invalid.')
            except OSError as exc:
                raise ReferenceNotFound() from exc
            mime = 'application/pdf' if pdf else 'image/png' if asset['extension'] == '.png' else 'image/jpeg'
            return payload, mime, key + asset['extension']
