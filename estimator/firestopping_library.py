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
from .penetration_calculator import calculate, normalize_draft, source_model
from .reference_library import ReferenceLibrary, ReferenceNotFound, identifier


class LibraryConflict(ValidationError):
    pass


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
            ''')

    def stamp(self):
        with self.store.connect() as db:
            return db.execute('SELECT count(*),COALESCE(sum(revision),0) FROM firestopping_items').fetchone()

    def all(self):
        with self.store.connect() as db:
            return {key: {'revision': rev, 'source_sha256': source, 'updated_at': updated, **json.loads(data)}
                    for key, rev, source, updated, data in db.execute('SELECT id,revision,source_sha256,updated_at,data FROM firestopping_items')}

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
        if base is None:
            return None
        stamp = id(base), self.edits.stamp()
        if stamp == self._effective_stamp:
            return self._effective
        data = deepcopy({key: value for key, value in base.items() if not key.startswith('_')})
        saved = self.edits.all()
        aliases = set()
        for index, item in enumerate(data['libraries']['penetration']['items'], 1):
            alias = item.setdefault('library_id', f'FL-ID-{index:03d}')
            if not re.fullmatch(r'FL-ID-[0-9]{3,}', alias) or alias in aliases:
                raise ValidationError('Firestopping Library IDs must be unique stable identifiers.')
            aliases.add(alias)
            old_title = item['title']
            item['title'] = alias + (' — ' + old_title.split(' — ', 1)[1] if ' — ' in old_title else ' — ' + old_title)
            item['fields'] = [field for field in item.get('fields', []) if field['label'] not in ('PKB Entry ID', 'Firestopping Library ID')]
            item['fields'].insert(0, {'label': 'Firestopping Library ID', 'value': alias})
            item['editable'] = bool(item.get('estimate') and data.get('firestopping'))
            edit = saved.get(item['id'])
            if edit:
                if edit['source_sha256'] != self._source_hash(base):
                    item['notice'] = 'A saved edit uses a different source workbook version. Its values are retained; review that version before editing this item.'
                    item['editable'] = False
                else:
                    self._apply_edit(item, edit)
        self._validate(data)
        for related in data['_links']['technical'].values():
            for link in related:
                if link['id'] in saved and saved[link['id']]['source_sha256'] == self._source_hash(base):
                    link['notice'] = 'The library item has saved edits. This reference describes its original workbook entry.'
        self._effective_stamp, self._effective = stamp, data
        return data

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
        item['notice'] = 'This item has saved edits. Technical references and source diagrams describe the original workbook item.'
        for key, col in {'manufacturer': 'V', 'service_type': 'K', 'penetration_type': 'L', 'orientation': 'M', 'frl': 'N', 'substrate': 'P'}.items():
            if key in item.get('filter_values', {}):
                item['filter_values'][key] = [str(inputs[col])] if inputs.get(col) else []

    @staticmethod
    def _source_hash(data):
        return data.get('firestopping', {}).get('source_sha256')

    def _context(self, key):
        identifier(key)
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
        original = super()._load()['_records']['penetration'][key]
        amount = result['rows'][0]['outputs'].get('H')
        current_price = price(amount, 'Calculated item price') if isinstance(amount, (int, float)) and not isinstance(amount, bool) and math.isfinite(amount) else None
        return {'id': key, 'library_id': detail['library_id'], 'title': detail['title'], 'revision': revision,
                'source_price': deepcopy(original['price']), 'price': current_price, 'draft': draft,
                'definition': result['definition'], 'result': result, 'pricing_token': token,
                'pricing_basis': snapshot['basis'], 'pricing_label': snapshot['label']}

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
