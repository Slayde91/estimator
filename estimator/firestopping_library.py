"""Editable library items with immutable pricing snapshots and revision checks.

The supplier bundle remains the original source. User saves are separate SQLite
records; neither the shared pricing library nor a project's draft is changed.
All prices are computed by the existing workbook calculator on the server.
"""

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import re

from .catalog import ValidationError, configuration_catalog, validate_configuration
from .penetration_calculator import calculate, definition, normalize_draft, source_model
from .reference_library import ReferenceLibrary, ReferenceNotFound, identifier
from .service_dimensions import FIELD_LABEL, service_size_field


class LibraryConflict(ValidationError):
    pass


FILTER_COLUMNS = {'manufacturer': ('Manufacturer', 'V'), 'service_type': ('Service type', 'K'),
                  'penetration_type': ('Penetration type', 'L'), 'orientation': ('Orientation', 'M'),
                  'frl': ('FRL', 'N'), 'substrate': ('Substrate', 'P')}
MANUAL_RELATIONSHIP = 'Manually linked.'
# Supplier aliases retain their existing numbers. User aliases have a separate
# durable range so a later supplier installation cannot renumber saved entries.
USER_ID_START = 100001
MAX_USER_ID = 999999999


def empty_library():
    return {'schema_version': 1, 'documents': [], 'images': [], 'links': [],
            'libraries': {kind: {'items': [], 'filters': []} for kind in ('penetration', 'technical')}}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def price(amount, label):
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount):
        raise ValidationError('The library item does not have a finite calculated price.')
    return {'amount': amount, 'currency': 'AUD', 'label': label}


class LibraryEdits:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS firestopping_prices (
                    token TEXT PRIMARY KEY, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS firestopping_items (
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                    source_sha256 TEXT NOT NULL, updated_at TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS firestopping_created (
                    id TEXT PRIMARY KEY, library_number INTEGER NOT NULL UNIQUE,
                    request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS firestopping_links (
                    penetration_id TEXT NOT NULL, technical_id TEXT NOT NULL,
                    penetration_source TEXT NOT NULL, technical_source TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(penetration_id, technical_id)
                );
            ''')

    def stamp(self):
        with self.store.connect() as db:
            return db.execute('SELECT count(*),COALESCE(sum(revision),0) FROM firestopping_items').fetchone()

    def all(self):
        with self.store.connect() as db:
            return {key: {'revision': rev, 'source_sha256': source, 'updated_at': updated, **json.loads(data)}
                    for key, rev, source, updated, data in db.execute('SELECT id,revision,source_sha256,updated_at,data FROM firestopping_items')}

    def created(self):
        with self.store.connect() as db:
            return {key: json.loads(data) for key, data in db.execute('SELECT id,data FROM firestopping_created ORDER BY library_number')}

    def links(self):
        with self.store.connect() as db:
            return list(db.execute('SELECT penetration_id,technical_id,penetration_source,technical_source FROM firestopping_links ORDER BY rowid'))

    def overlay_stamp(self):
        with self.store.connect() as db:
            return tuple(db.execute('SELECT count(*),COALESCE(sum(revision),0) FROM firestopping_items').fetchone()) + tuple(
                db.execute('SELECT (SELECT count(*) FROM firestopping_created),(SELECT count(*) FROM firestopping_links)').fetchone())

    def create(self, request_key, request_hash, minimum, build, snapshot):
        """Allocate and insert in one write transaction, including retry identity."""
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT id,request_hash FROM firestopping_created WHERE request_key=?', (request_key,)).fetchone()
            if previous:
                if previous[1] != request_hash:
                    raise LibraryConflict('This Add to Library request was already used for different inputs. Start a new request to add another item.')
                return previous[0], False
            count, maximum = db.execute('SELECT count(*),COALESCE(max(library_number),0) FROM firestopping_created').fetchone()
            if count >= 50000:
                raise ValidationError('The Firestopping Library has reached its item capacity.')
            number = max(minimum, maximum) + 1
            if number > MAX_USER_ID:
                raise ValidationError('The user-created library identifier range is exhausted.')
            key, data = build(number, count)
            content = encoded(snapshot)
            token = hashlib.sha256(content.encode()).hexdigest()
            db.execute('INSERT OR IGNORE INTO firestopping_prices VALUES(?,?)', (token, content))
            db.execute('INSERT INTO firestopping_created VALUES(?,?,?,?,?,?)',
                       (key, number, request_key, request_hash, timestamp(), encoded(data)))
            return key, True

    def link(self, left, right, left_source, right_source):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT penetration_source,technical_source FROM firestopping_links WHERE penetration_id=? AND technical_id=?', (left, right)).fetchone()
            if previous:
                if previous != (left_source, right_source):
                    raise LibraryConflict('This manual reference belongs to another source version. Its original provenance has been retained for review.')
                return False
            if db.execute('SELECT count(*) FROM firestopping_links').fetchone()[0] >= 500000:
                raise ValidationError('The library has reached its reference capacity.')
            db.execute('INSERT INTO firestopping_links VALUES(?,?,?,?,?)', (left, right, left_source, right_source, timestamp()))
            return True

    def snapshot(self, token):
        with self.store.connect() as db:
            row = db.execute('SELECT data FROM firestopping_prices WHERE token=?', (token,)).fetchone()
        if row is None:
            raise LibraryConflict('This pricing snapshot is unavailable. Reopen the item or refresh its prices; your inputs have not been saved.')
        return json.loads(row[0])

    def capture(self, snapshot):
        content = encoded(snapshot)
        token = hashlib.sha256(content.encode()).hexdigest()
        with self.store.connect() as db:
            db.execute('INSERT OR IGNORE INTO firestopping_prices VALUES(?,?)', (token, content))
        return token

    def save(self, key, revision, source, data, snapshot):
        content = encoded(snapshot)
        token = hashlib.sha256(content.encode()).hexdigest()
        assert token == data['pricing_token']
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT revision,source_sha256 FROM firestopping_items WHERE id=?', (key,)).fetchone()
            if (previous[0] if previous else 0) != revision or (previous and previous[1] != source):
                raise LibraryConflict('This library item changed in another window. Your edits are retained; reopen the saved item before replacing it.')
            db.execute('INSERT OR IGNORE INTO firestopping_prices VALUES(?,?)', (token, content))
            db.execute('INSERT INTO firestopping_items VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                       'revision=excluded.revision,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at,data=excluded.data',
                       (key, revision + 1, source, timestamp(), encoded(data)))


class FirestoppingLibrary(ReferenceLibrary):
    def __init__(self, directory, store):
        super().__init__(directory)
        self.edits = LibraryEdits(store)
        self._effective_stamp = None
        self._effective = None

    def _load(self):
        base = super()._load()
        stamp = id(base), self.edits.overlay_stamp()
        if stamp == self._effective_stamp:
            return self._effective
        created = self.edits.created()
        if base is None and not created:
            return None
        data = deepcopy({key: value for key, value in (base or empty_library()).items() if not key.startswith('_')})
        saved = self.edits.all()
        library = data['libraries']['penetration']
        existing = {item['id'] for item in library['items']}
        if existing.intersection(created):
            raise ValidationError('A supplier item conflicts with a saved user-created library identifier.')
        library['items'].extend(deepcopy(value['item']) for value in created.values())
        filter_keys = {entry['key'] for entry in library.get('filters', [])}
        library.setdefault('filters', []).extend({'key': key, 'label': label} for key, (label, _) in FILTER_COLUMNS.items() if key not in filter_keys)
        aliases = set()
        for index, item in enumerate(data['libraries']['penetration']['items'], 1):
            alias = item.setdefault('library_id', f'FL-ID-{index:03d}')
            if not re.fullmatch(r'FL-ID-[0-9]{3,}', alias) or alias in aliases:
                raise ValidationError('Firestopping Library IDs must be unique stable identifiers.')
            if item['id'] not in created and int(alias[6:]) >= USER_ID_START:
                raise ValidationError('Supplier Firestopping Library IDs must be below FL-ID-100001; that range is reserved for user-created items. Correct the source bundle without renumbering saved items.')
            aliases.add(alias)
            old_title = item['title']
            item['title'] = alias + (' — ' + old_title.split(' — ', 1)[1] if ' — ' in old_title else ' — ' + old_title)
            item['fields'] = [field for field in item.get('fields', []) if field['label'] not in ('PKB Entry ID', 'Firestopping Library ID')]
            item['fields'].insert(0, {'label': 'Firestopping Library ID', 'value': alias})
            own = created.get(item['id'])
            source_hash = own['source_sha256'] if own else self._source_hash(base or {})
            item['editable'] = bool(item.get('estimate') and (own or data.get('firestopping')))
            if own and own['calculator_source_sha256'] != source_model()['source']['sha256']:
                item['editable'] = False
                item['notice'] = 'This saved item uses another calculator source version. Its original inputs and price are retained.'
            draft_rows = item.get('estimate', {}).get('draft', {}).get('rows', [])
            self._service_size(item, draft_rows[0].get('inputs', {}) if draft_rows else {})
            edit = saved.get(item['id'])
            if edit:
                if edit['source_sha256'] != source_hash:
                    item['notice'] = 'A saved edit uses a different source workbook version. Its values are retained; review that version before editing this item.'
                    item['editable'] = False
                else:
                    self._apply_edit(item, edit)
        items = {item['id']: item for item in library['items']}
        technical = {item['id']: item for item in data['libraries']['technical']['items']}
        pairs = {(link['penetration_id'], link['technical_id']) for link in data['links']}
        for left, right, left_source, right_source in self.edits.links():
            if left not in items or right not in technical:
                continue
            current_left = created[left]['source_sha256'] if left in created else self._source_hash(base or {})
            if left_source != current_left or right_source != self._technical_source(technical[right], data):
                items[left]['notice'] = 'A saved manual reference uses another source version and is withheld. Its original provenance is retained for review.'
                continue
            if (left, right) not in pairs:
                data['links'].append({'penetration_id': left, 'technical_id': right,
                                      'relationship': MANUAL_RELATIONSHIP, 'origin': 'user'})
                pairs.add((left, right))
        self._validate(data)
        for related in data['_links']['technical'].values():
            for link in related:
                key = link['id']
                source_hash = created[key]['source_sha256'] if key in created else self._source_hash(base or {})
                if key in saved and saved[key]['source_sha256'] == source_hash:
                    link['notice'] = ('This library item has saved edits. Review its current inputs against this technical reference.' if link.get('origin') == 'user' else
                                      'The library item has saved edits. This reference describes its original workbook entry.')
        self._effective_stamp, self._effective = stamp, data
        return data

    @staticmethod
    def _service_size(item, inputs):
        item['fields'] = [field for field in item['fields'] if field['label'] != FIELD_LABEL]
        position = next((i+1 for i, field in enumerate(item['fields']) if field.get('column') == 'K'), 1)
        item['fields'].insert(position, service_size_field(inputs))

    @staticmethod
    def _apply_edit(item, edit):
        inputs = edit['draft']['rows'][0]['inputs']
        for field in item['fields']:
            # Source workbook W is its former ID, while the estimator W begins
            # calculation inputs. Only the common description columns map here.
            column = field.get('column')
            if column in {'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'T', 'U', 'V'}:
                value = inputs.get(column)
                field['value'] = '' if value is None else str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)
        item['title'] = item['library_id'] + ' — ' + str(inputs.get('K') or inputs.get('T') or 'Firestopping item')
        item['subtitle'] = ' · '.join(str(inputs[col]) for col in ('V', 'N', 'P') if inputs.get(col))
        item['summary'] = str(inputs.get('U') or inputs.get('T') or '')
        item['price'] = price(edit['amount'], 'Saved item price')
        item['fields'].insert(1, {'label': 'Saved library edit', 'value': edit['updated_at']})
        item['notice'] = ('This user-created item has saved edits. Review linked technical details against the current inputs.' if item.get('user_created') else
                          'This item has saved edits. Source diagrams describe the original workbook item; review technical references against the current inputs.')
        FirestoppingLibrary._service_size(item, inputs)
        for key, col in {'manufacturer': 'V', 'service_type': 'K', 'penetration_type': 'L', 'orientation': 'M', 'frl': 'N', 'substrate': 'P'}.items():
            if key in item.get('filter_values', {}):
                item['filter_values'][key] = [str(inputs[col])] if inputs.get(col) else []

    @staticmethod
    def _source_hash(data):
        return data.get('firestopping', {}).get('source_sha256')

    def _context(self, key):
        identifier(key)
        own = self.edits.created().get(key)
        if own:
            if own['calculator_source_sha256'] != source_model()['source']['sha256']:
                raise LibraryConflict('This saved item uses another calculator source version. Its inputs and captured price are retained for review.')
            snapshot = self.edits.snapshot(own['pricing_token'])
            source = {'source_sha256': own['source_sha256'], 'configuration': snapshot['configuration']}
            return own['item'], source, self.edits.all().get(key), snapshot, own['pricing_token']
        base = super()._load()
        if base is None or key not in base['_records']['penetration']:
            raise ReferenceNotFound()
        source = base.get('firestopping')
        item = base['_records']['penetration'][key]
        if not source or not item.get('estimate'):
            raise ValidationError('This item does not contain its source calculation inputs. Install the complete Firestopping Library bundle.')
        if source.get('calculator_source_sha256') != source_model()['source']['sha256']:
            raise LibraryConflict('The library calculation source differs from this estimator version. Its inputs have been retained for review.')
        source_hash = source.get('source_sha256')
        if not isinstance(source_hash, str) or not re.fullmatch('[a-f0-9]{64}', source_hash):
            raise ValidationError('The library workbook fingerprint is missing.')
        saved = self.edits.all().get(key)
        if saved and saved['source_sha256'] != source_hash:
            raise LibraryConflict('This saved item belongs to another source workbook version. Its saved values have been retained.')
        snapshot = {'basis': 'workbook', 'label': 'Workbook rates', 'source_sha256': source_hash,
                    'configuration': validate_configuration(source['configuration'])}
        token = hashlib.sha256(encoded(snapshot).encode()).hexdigest()
        return item, source, saved, snapshot, token

    def detail(self, kind, key):
        result = super().detail(kind, key)
        result.pop('estimate', None)
        return result

    def _response(self, key, draft, revision, snapshot, token, result=None):
        draft = normalize_draft(draft)
        if len(draft['rows']) != 1:
            raise ValidationError('A Firestopping Library item must contain exactly one calculation row.')
        result = result if result is not None else calculate(draft, snapshot['configuration'])
        detail = self.detail('penetration', key)
        original = self._context(key)[0]
        result['definition'] = definition(snapshot['configuration'], service_types=self.service_types())
        amount = result['rows'][0]['outputs'].get('H')
        current_price = price(amount, 'Calculated item price') if isinstance(amount, (int, float)) and not isinstance(amount, bool) and math.isfinite(amount) else None
        return {'id': key, 'library_id': detail['library_id'], 'title': detail['title'], 'revision': revision,
                'source_price': deepcopy(original['price']), 'price': current_price, 'draft': draft,
                'definition': result['definition'], 'result': result, 'pricing_token': token,
                'pricing_basis': snapshot['basis'], 'pricing_label': snapshot['label'],
                'configuration': deepcopy(snapshot['configuration'])}

    def service_types(self):
        with self._lock:
            try:
                data = self._load()
            except ValidationError:
                # Optional descriptions must not disable the independent
                # estimator. Library endpoints still report the source error.
                return []
            if not data:
                return []
            values = set()
            for item in data['_records']['penetration'].values():
                selected = [field['value'] for field in item.get('fields', []) if field.get('column') == 'K']
                if not selected:
                    selected = item.get('filter_values', {}).get('service_type', [])
                values.update(value for value in selected if value.strip())
            return sorted(values, key=str.casefold)

    @staticmethod
    def _technical_source(item, data):
        documents = {value['id']: value['sha256'] for value in data['documents']}
        return hashlib.sha256(encoded({'id': item['id'], 'sources': item.get('sources', []),
                'documents': {s['document_id']: documents[s['document_id']] for s in item.get('sources', []) if 'document_id' in s}}).encode()).hexdigest()

    def add_link(self, key, body):
        with self._lock:
            identifier(key)
            if not isinstance(body, dict) or set(body) != {'technical_id'}:
                raise ValidationError('Choose one Technical Library item to link.')
            right = identifier(body['technical_id'])
            data = self._load()
            if not data or key not in data['_records']['penetration'] or right not in data['_records']['technical']:
                raise ReferenceNotFound()
            if any(link['id'] == right for link in data['_links']['penetration'][key]):
                added = False
            else:
                own = self.edits.created().get(key)
                left_source = own['source_sha256'] if own else self._source_hash(data)
                if not left_source:
                    raise ValidationError('This item has no source identity for a durable manual reference.')
                added = self.edits.link(key, right, left_source, self._technical_source(data['_records']['technical'][right], data))
            return {'linked': True, 'created': added, 'penetration_id': key, 'technical_id': right}

    def create(self, body):
        with self._lock:
            if not isinstance(body, dict) or set(body) != {'draft', 'configuration', 'idempotency_key'}:
                raise ValidationError('Include one item draft, its pricing configuration and an idempotency key only.')
            request_key = body['idempotency_key']
            if not isinstance(request_key, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{15,127}', request_key):
                raise ValidationError('Use a unique idempotency key of 16 to 128 letters, digits, underscores or hyphens.')
            draft = normalize_draft(body['draft'])
            if len(draft['rows']) != 1:
                raise ValidationError('Select exactly one calculation row to add to the library.')
            inputs = draft['rows'][0]['inputs']
            if not any(isinstance(inputs.get(col), str) and inputs[col].strip() for col in ('K', 'T', 'U')):
                raise ValidationError('Enter a service name, items/services description or installation description before adding this item.')
            if not isinstance(inputs.get('O'), (int, float)) or inputs['O'] <= 0:
                raise ValidationError('The item quantity must be greater than zero before adding it to the library.')
            configuration = validate_configuration(body['configuration'])
            configuration['catalog'] = configuration_catalog(configuration)
            source = source_model()['source']['sha256']
            snapshot = {'basis': 'captured', 'label': 'Captured estimator pricing', 'source_sha256': source, 'configuration': configuration}
            token = hashlib.sha256(encoded(snapshot).encode()).hexdigest()
            request_hash = hashlib.sha256(encoded({'draft': draft, 'configuration': configuration}).encode()).hexdigest()
            result = calculate(draft, configuration)
            if result['errors']:
                raise ValidationError('Resolve the calculation errors before adding this item to the library.')
            amount = price(result['rows'][0]['outputs'].get('H'), 'Library price')
            current = self._load()
            items = current['_records']['penetration'].values() if current else []
            maximum = max(USER_ID_START - 1, max((int(item['library_id'][6:]) for item in items), default=0))
            base = super()._load()
            bundle_ids = set(base['_records']['penetration']) if base else set()

            def build(number, count):
                if len(bundle_ids) + count >= 50000:
                    raise ValidationError('The Firestopping Library has reached its item capacity.')
                alias, key = f'FL-ID-{number:03d}', f'fl-user-{number:03d}'
                if key in bundle_ids:
                    raise LibraryConflict('The generated identifier conflicts with a supplier item. Nothing has been saved.')
                labels = {'J': 'Type', 'K': 'Service Type', 'L': 'Penetration Type', 'M': 'Substrate Orientation',
                          'N': 'FRL', 'O': 'Item QTY', 'P': 'Substrate', 'Q': 'Access', 'R': 'Complexity',
                          'T': 'Items/Services', 'U': 'System/Install Details', 'V': 'Manufacturer'}
                item = {'id': key, 'library_id': alias, 'title': alias, 'subtitle': '', 'summary': '',
                        'source_label': 'User-created library item', 'sources': [], 'images': [], 'user_created': True,
                        'fields': [{'label': 'Firestopping Library ID', 'value': alias}] + [
                            {'label': label, 'value': '', 'column': col} for col, label in labels.items()],
                        'filter_values': {key: [] for key in FILTER_COLUMNS}, 'price': amount,
                        'estimate': {'draft': draft}}
                self._apply_edit(item, {'draft': draft, 'amount': amount['amount'], 'updated_at': timestamp()})
                item['fields'] = [field for field in item['fields'] if field['label'] != 'Saved library edit']
                item['price'] = amount
                item['notice'] = 'User-created item with captured estimator inputs and pricing.'
                probe = empty_library()
                probe['libraries']['penetration'] = {'items': [item], 'filters': [{'key': key, 'label': label} for key, (label, _) in FILTER_COLUMNS.items()]}
                try:
                    self._validate(probe)
                except (ValueError, KeyError, TypeError) as exc:
                    raise ValidationError('This item cannot be displayed in the library. Shorten its description or selection text; nothing has been saved.') from exc
                return key, {'item': item, 'pricing_token': token, 'source_sha256': source, 'calculator_source_sha256': source}

            key, added = self.edits.create(request_key, request_hash, maximum, build, snapshot)
            return {**self.edit(key), 'created': added}

    def edit(self, key):
        with self._lock:
            item, source, saved, snapshot, token = self._context(key)
            if saved:
                token = saved['pricing_token']
                snapshot = self.edits.snapshot(token)
            return self._response(key, saved['draft'] if saved else item['estimate']['draft'],
                                  saved['revision'] if saved else 0, snapshot, token)

    def _validate_save(self, key, edit):
        # Validate the complete prospective index before any database write.
        # Calculator text limits are wider than searchable library text limits.
        data = deepcopy({name: value for name, value in self._load().items() if not name.startswith('_')})
        item = next(item for item in data['libraries']['penetration']['items'] if item['id'] == key)
        item['fields'] = [field for field in item['fields'] if field['label'] != 'Saved library edit']
        self._apply_edit(item, {**edit, 'updated_at': timestamp()})
        try:
            self._validate(data)
        except (ValueError, KeyError, TypeError) as exc:
            raise ValidationError('This item cannot be displayed in the library. Shorten its description or selection text before saving; nothing has been saved.') from exc

    def action(self, key, action, body):
        with self._lock:
            if action not in {'calculate', 'refresh-pricing', 'save'}:
                raise ReferenceNotFound()
            if not isinstance(body, dict) or set(body) != {'draft', 'revision', 'pricing_token'}:
                raise ValidationError('Include the item draft, revision and captured pricing token only.')
            revision = body['revision']
            if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
                raise ValidationError('Invalid library item revision.')
            item, source, saved, workbook, workbook_token = self._context(key)
            if revision != (saved['revision'] if saved else 0):
                raise LibraryConflict('This library item changed in another window. Your edits are retained; reopen the saved item before replacing it.')
            token = body['pricing_token']
            if not isinstance(token, str) or not re.fullmatch('[a-f0-9]{64}', token):
                raise ValidationError('Invalid captured pricing token.')
            snapshot = workbook if token == workbook_token else self.edits.snapshot(token)
            if snapshot['source_sha256'] != source['source_sha256']:
                raise LibraryConflict('The captured pricing belongs to another library version. Reopen the item before saving.')
            draft = normalize_draft(body['draft'])
            if len(draft['rows']) != 1:
                raise ValidationError('A Firestopping Library item must contain exactly one calculation row.')
            if action == 'refresh-pricing':
                config = self.edits.store.configuration()
                config['catalog'] = configuration_catalog(config)
                snapshot = {'basis': 'shared', 'label': 'Shared Pricing Library',
                            'source_sha256': source['source_sha256'], 'configuration': validate_configuration(config)}
                token = self.edits.capture(snapshot)
            result = calculate(draft, snapshot['configuration'])
            if action == 'save':
                if result['errors']:
                    raise ValidationError('Resolve the calculation errors before saving this library item.')
                amount = price(result['rows'][0]['outputs'].get('H'), 'Saved item price')['amount']
                edit = {'draft': draft, 'pricing_token': token, 'amount': amount}
                self._validate_save(key, edit)
                self.edits.save(key, revision, source['source_sha256'], edit, snapshot)
                revision += 1
            return self._response(key, draft, revision, snapshot, token, result)
