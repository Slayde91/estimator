"""User-owned Technical Library records, outside supplier evidence and pricing.

Source and variant validation completes before these overlays are published.
Revisions prevent stale editors overwriting a newer save. Supplier files and
calculator inputs are never written by this module.
"""
from copy import deepcopy
import hashlib
import json
import re

from .catalog import ValidationError
from .firestopping_library import FirestoppingLibrary, LibraryConflict, encoded, timestamp, empty_library
from .firefly_reference_review import fingerprint
from .reference_library import ReferenceNotFound, identifier
from .library_report_links import valid_manual_report_url
from .library_facets import (MOVED_SERVICE_CATEGORIES, canonical_services,
                             SERVICE_DISCOVERY_GENERALIZATIONS)
from .library_classifications import FACETS, classification_filters

PENETRATION_KEYS = {'type': 'penetration_type', 'services': 'service_type'}
FIELD_FACETS = {'Manufacturer': 'manufacturer', 'Substrate': 'substrate',
                'Orientation': 'orientation', 'Type': 'type', 'Category': 'category',
                'Services': 'services', 'FRL': 'frl', 'Report Number': 'report'}
NEW_FIELDS = ('Manufacturer', 'System Products', 'Installation Type', 'Barrier Type',
              'Barrier Construction', 'Service', 'Service Size / Configuration',
              'Installation Details')


def text(value, maximum, *, blank=True):
    if not isinstance(value, str) or len(value) > maximum or '\x00' in value or (not blank and not value.strip()):
        raise ValidationError('Enter valid Technical Library text within the field limit.')
    return value


class TechnicalEdits:
    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS technical_library_items (
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                    source_sha256 TEXT NOT NULL, created INTEGER NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS technical_library_links (
                    penetration_id TEXT NOT NULL, technical_id TEXT NOT NULL,
                    penetration_source TEXT NOT NULL, technical_source TEXT NOT NULL,
                    linked INTEGER NOT NULL, updated_at TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(penetration_id, technical_id)
                );
            ''')
            if 'revision' not in {row[1] for row in db.execute('PRAGMA table_info(technical_library_links)')}:
                db.execute('ALTER TABLE technical_library_links ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')

    def read(self):
        with self.store.connect() as db:
            rows = {key: {'revision': rev, 'source_sha256': source, 'created': bool(created),
                          'deleted': bool(deleted), 'record': json.loads(data)}
                    for key, rev, source, created, deleted, data in db.execute(
                        'SELECT id,revision,source_sha256,created,deleted,data FROM technical_library_items')}
            links = list(db.execute('SELECT penetration_id,technical_id,penetration_source,technical_source,linked '
                                    'FROM technical_library_links ORDER BY penetration_id,technical_id'))
        return rows, links

    def stamp(self):
        with self.store.connect() as db:
            return tuple(db.execute('SELECT count(*),COALESCE(sum(revision),0) FROM technical_library_items').fetchone()) + tuple(
                db.execute('SELECT count(*),COALESCE(sum(revision),0) FROM technical_library_links').fetchone())

    def save(self, key, revision, source, record, *, created=False, deleted=False):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT revision,source_sha256,created FROM technical_library_items WHERE id=?', (key,)).fetchone()
            if revision != (current[0] if current else 0) or (current and current[1] != source):
                raise LibraryConflict('This Technical Library item changed. Reopen it before saving.')
            if current:
                db.execute('UPDATE technical_library_items SET revision=?,deleted=?,data=?,updated_at=? WHERE id=?',
                           (revision + 1, int(deleted), encoded(record), timestamp(), key))
            else:
                db.execute('INSERT INTO technical_library_items VALUES (?,?,?,?,?,?,?)',
                           (key, 1, source, int(created), int(deleted), encoded(record), timestamp()))
        return revision + 1


class ManualTechnicalLibrary(FirestoppingLibrary):
    """Publish user overlays only after all installed source guards succeed."""
    def __init__(self, directory, store):
        super().__init__(directory, store)
        self.technical_edits = TechnicalEdits(store)
        self._manual_stamp = None
        self._manual_data = None
        self._manual_base = None

    @staticmethod
    def _canonical(data):
        return classification_filters(data['_filters']['technical'])

    @staticmethod
    def _technical_key(key, data):
        """Historical IDs address the one current editable record in a group."""
        identifier(key)
        if data is None:
            raise ReferenceNotFound()
        key = data['_aliases'].get(key, key)
        if key not in data['_technical_public_records']:
            raise ReferenceNotFound()
        return key

    def _identity(self, key, base, saved):
        if key in saved and saved[key]['created']:
            return saved[key]['source_sha256']
        item = base['_technical_public_records'].get(key)
        if item is None:
            raise ReferenceNotFound()
        return fingerprint({'source_record': self.technical_source_record(key, base), 'public_record': item})

    def _load(self):
        base = super()._load()
        stamp = id(base), self.technical_edits.stamp()
        if stamp == self._manual_stamp:
            return self._manual_data
        saved, edges = self.technical_edits.read()
        if base is None:
            base = empty_library()
            self._validate(base)
        data = dict(base)
        for name in ('_records', '_searches', '_filters', '_links', '_visible'):
            data[name] = {kind: deepcopy(value) if name in ('_links', '_filters', '_visible') else dict(value)
                          for kind, value in base[name].items()}
        for name in ('_technical_public_records', '_technical_discovery', '_aliases', '_groups', '_technical_related_records'):
            data[name] = dict(base[name])
        data['_technical_discovery'] = {key: {**values, 'report': list(dict.fromkeys([
            *values.get('report', []), *values.get('document', [])]))}
            for key, values in data['_technical_discovery'].items()}
        data['_manual_technical_sources'] = {}
        for key, edit in saved.items():
            if edit['created']:
                if key in base['_technical_public_records']:
                    raise LibraryConflict('A source item conflicts with a user-created Technical Library ID.')
            elif key not in base['_technical_public_records'] or self._identity(key, base, saved) != edit['source_sha256']:
                # Retain the edit in storage and expose the current supplier
                # record. An edit cannot silently acquire another source.
                continue
            if edit['deleted']:
                members = set(data['_groups'].get(key, [key]))
                for member in members:
                    data['_technical_public_records'].pop(member, None)
                data['_visible']['technical'] = [value for value in data['_visible']['technical'] if value not in members]
                continue
            record = deepcopy(edit['record'])
            data['_manual_technical_sources'][key] = edit['source_sha256']
            data['_technical_public_records'][key] = record
            data['_records']['technical'][key] = record
            data['_technical_discovery'][key] = deepcopy(record['filter_values'])
            data['_searches']['technical'][key] = '\n'.join([*data['_groups'].get(key, [key]), record['title'], *(f.get('value', '') for f in record.get('fields', []))]).casefold()
            # Preserve the source-reviewed group when its canonical record
            # is edited. Only a newly authored record starts its own group.
            if edit['created']:
                data['_aliases'][key] = key
                data['_groups'][key] = [key]
            data['_links']['technical'].setdefault(key, [])
            if key not in data['_visible']['technical']:
                data['_visible']['technical'].append(key)
        present = set(data['_technical_public_records'])
        data['_technical_related_records'] = {key: [target for target in values if target in present]
            for key, values in data['_technical_related_records'].items() if key in present}
        data['_links']['technical'] = {key: values for key, values in data['_links']['technical'].items() if key in present}
        for values in data['_links']['penetration'].values():
            values[:] = [link for link in values if link['id'] in present]
            for link in values:
                link['title'] = data['_technical_public_records'][link['id']]['title']
        created_penetrations = self.edits.created()
        for left, right, left_source, right_source, linked in edges:
            if left not in data['_records']['penetration'] or right not in present:
                continue
            own = created_penetrations.get(left)
            current_left = own['source_sha256'] if own else self._source_hash(base)
            if current_left != left_source or self._identity(right, base, saved) != right_source:
                continue
            for kind, source, target in (('penetration', left, right), ('technical', right, left)):
                values = data['_links'][kind].setdefault(source, [])
                values[:] = [entry for entry in values if entry['id'] != target]
                if linked:
                    target_kind = 'technical' if kind == 'penetration' else 'penetration'
                    target_record = data['_technical_public_records'][target] if target_kind == 'technical' else data['_records']['penetration'][target]
                    values.append({'kind': target_kind, 'id': target, 'title': target_record['title'], 'relationship': 'Manually linked.', 'origin': 'user'})
        canonical = self._canonical(data)
        # New reports/manufacturers are user-authored metadata, not new
        # passive-fire classifications. Classification values stay canonical.
        for definition in canonical:
            if definition['key'] in ('report', 'manufacturer'):
                known = {option['value'] for option in definition['options']}
                for key in data['_manual_technical_sources']:
                    for value in data['_technical_public_records'][key].get('filter_values', {}).get(definition['key'], []):
                        if value not in known:
                            definition['options'].append({'value': value, 'label': value}); known.add(value)
        data['_canonical_library_filters'] = canonical
        data['_filters']['technical'] = deepcopy(canonical)
        data['_filters']['penetration'] = [{**deepcopy(entry), 'key': PENETRATION_KEYS.get(entry['key'], entry['key'])} for entry in canonical]
        facet_spellings = {}
        for entry in canonical:
            matches = {}
            for option in entry['options']:
                matches.setdefault(option['value'].casefold(), set()).add(option['value'])
            # An ambiguous case-fold match cannot select a different label.
            facet_spellings[PENETRATION_KEYS.get(entry['key'], entry['key'])] = {
                folded: next(iter(values)) for folded, values in matches.items() if len(values) == 1}
        for key, record in list(data['_records']['penetration'].items()):
            record = deepcopy(record)
            values = record.setdefault('filter_values', {})
            source_services = values.get('service_type', [])
            if source_services:
                # Existing discovery aliases/generalizations also apply to
                # Firestopping search. Keep historical tokens for old queries;
                # never replace the source field or calculator K value.
                values['service_type'] = list(dict.fromkeys([
                    *source_services, *canonical_services(source_services),
                    *(SERVICE_DISCOVERY_GENERALIZATIONS[value.strip().casefold()]
                      for value in source_services if value.strip().casefold() in SERVICE_DISCOVERY_GENERALIZATIONS)]))
            values['report'] = list(dict.fromkeys(value for link in data['_links']['penetration'].get(key, [])
                for value in data['_technical_discovery'].get(link['id'], {}).get('report', data['_technical_discovery'].get(link['id'], {}).get('document', []))))
            # These are descriptive search facets, not workbook/pricing
            # inputs. Their spelling must match the shared dropdown values.
            for facet, spellings in facet_spellings.items():
                if facet in values:
                    values[facet] = list(dict.fromkeys(spellings.get(value.casefold(), value) for value in values[facet]))
            data['_records']['penetration'][key] = record
        self._manual_stamp, self._manual_data, self._manual_base = stamp, data, base
        return data

    def overview(self):
        result = super().overview()
        data = self._load()
        for library in result['libraries']:
            library['filters'] = deepcopy(data['_filters'][library['id']]) if data else []
            if data and not data.get('_index_sha256'):
                library['source_count'] = 0
        return result

    def listing(self, kind, **query):
        if kind == 'technical' and 'document' in query:
            if query.get('report') and query['report'] != query['document']:
                raise ValidationError('Choose one Report filter value.')
            query['report'] = query.pop('document')
        result = super().listing(kind, **query)
        if kind == 'technical':
            for record in result['items']:
                record['editable'] = True
        return result

    def detail(self, kind, key):
        with self._lock:
            if kind == 'technical':
                key = self._technical_key(key, self._load())
            result = super().detail(kind, key)
            if kind == 'technical':
                result['editable'] = True
                result['user_authored'] = key in self._load().get('_manual_technical_sources', {})
            return result

    def technical_edit(self, key=None):
        with self._lock:
            data = self._load()
            saved, _ = self.technical_edits.read()
            if key is None:
                record = {'title': '', 'fields': [{'label': label, 'value': ''} for label in NEW_FIELDS],
                          'filter_values': {key: [] for key, _ in FACETS}, 'sources': []}
                revision, source = 0, None
            else:
                key = self._technical_key(key, data)
                base = super()._load()
                source = self._identity(key, base, saved)
                if key in saved and saved[key]['source_sha256'] != source:
                    raise LibraryConflict('The supplier record changed. Review its source before editing the retained overlay.')
                record = deepcopy(data['_technical_public_records'][key])
                record['filter_values'] = deepcopy(data['_technical_discovery'][key])
                revision = saved.get(key, {}).get('revision', 0)
            return {'record': record, 'revision': revision, 'source_sha256': source,
                    'filters': deepcopy(data['_canonical_library_filters'])}

    def technical_save(self, key, body):
        with self._lock:
            if not isinstance(body, dict) or set(body) != {'revision', 'source_sha256', 'title', 'fields', 'facets', 'report', 'request_key'}:
                raise ValidationError('Save the complete current Technical Library form.')
            if key is None and (not isinstance(body['request_key'], str) or not re.fullmatch(r'[a-f0-9]{32}', body['request_key'])):
                raise ValidationError('Start a new Technical Library form before saving.')
            if key is not None and body['request_key'] is not None:
                raise ValidationError('Existing item saves must retain their item identity.')
            context = self.technical_edit(key)
            if isinstance(body['revision'], bool) or body['revision'] != context['revision'] or body['source_sha256'] != context['source_sha256']:
                raise LibraryConflict('This Technical Library item changed. Reopen it before saving.')
            title = text(body['title'], 1000, blank=False).strip()
            fields = body['fields']
            if not isinstance(fields, list) or len(fields) > 80:
                raise ValidationError('Include at most 80 Technical Library fields.')
            old_fields = {field['label']: field for field in context['record'].get('fields', [])}
            normalized, labels = [], set()
            for field in fields:
                if not isinstance(field, dict) or set(field) != {'label', 'value'}:
                    raise ValidationError('Technical fields accept a label and text value only.')
                label = text(field['label'], 120, blank=False).strip()
                if label in labels:
                    raise ValidationError('Use each Technical Library field label once.')
                labels.add(label)
                previous = deepcopy(old_fields.get(label, {'label': label}))
                previous['value'] = text(field['value'], 40000)
                normalized.append(previous)
            facets = body['facets']
            if not isinstance(facets, dict) or set(facets) != {key for key, _ in FACETS}:
                raise ValidationError('Choose all Technical Library classifications.')
            definitions = {entry['key']: entry for entry in context['filters']}
            chosen = {}
            for facet, _ in FACETS:
                values = facets[facet]
                if not isinstance(values, list) or len(values) > 100 or any(not isinstance(value, str) for value in values) or len(set(values)) != len(values):
                    raise ValidationError('Choose each classification once.')
                allowed = {option['value'] for option in definitions[facet]['options']}
                retained = context['record'].get('filter_values', {}).get(facet, [])
                for value in values:
                    text(value, 1000, blank=False)
                    if facet not in ('report', 'manufacturer') and value not in allowed and value not in retained:
                        raise ValidationError('Choose a listed Technical Library classification.')
                if facet not in ('report',) and not values:
                    raise ValidationError('Assign Manufacturer, Substrate, Orientation, Type, Category, Services and FRL before saving.')
                chosen[facet] = list(values)
            report = body['report']
            if not isinstance(report, dict) or set(report) != {'number', 'url'}:
                raise ValidationError('Enter the report number and its URL.')
            report_number = text(report['number'], 1000, blank=False).strip()
            report_url = text(report['url'], 4000).strip()
            if report_url and not valid_manual_report_url(report_url):
                raise ValidationError('Enter a complete http or https report URL.')
            old_report = next((field for field in context['record'].get('fields', []) if field['label'] == 'Report Number'), None)
            old_links = old_report.get('report_links', []) if old_report else []
            retain_reports = bool(old_report and report_number == old_report.get('value', '').strip()
                                  and (not report_url or old_links and report_url == old_links[0]['url']))
            if not retain_reports and ('\n' in report_number or '\r' in report_number):
                raise ValidationError('Enter one report number and URL, or retain the existing complete report set.')
            chosen['report'] = ([value.strip() for value in old_report['value'].splitlines() if value.strip()] if retain_reports else [report_number])
            if set(chosen['category']) & MOVED_SERVICE_CATEGORIES and chosen['services'] != ['N/A']:
                raise ValidationError('Choose N/A Services for this non-service Category.')
            normalized = [field for field in normalized if field['label'] not in FIELD_FACETS]
            for label, facet in FIELD_FACETS.items():
                field = {'label': label, 'value': '\n'.join(chosen[facet])}
                if facet == 'report':
                    field = deepcopy(old_report) if retain_reports else ({**field, 'report_links': [{'label': report_number, 'url': report_url}]} if report_url else field)
                normalized.append(field)
            record = deepcopy(context['record'])
            created = key is None
            if created:
                key = 'user-technical-' + body['request_key']
                source = hashlib.sha256(key.encode()).hexdigest()
                record.update(id=key, subtitle='', summary='', source_label='User-created Technical Library item')
            else:
                key = context['record']['id']
                source = context['source_sha256']
            record.update(title=title, fields=normalized, filter_values=chosen, editable=True)
            record['notice'] = ('User-created Technical Library item.' if created else
                                'User-edited Technical Library item. Original supplier evidence is retained separately.')
            if created:
                previous = self.technical_edits.read()[0].get(key)
                if previous:
                    if previous['created'] and not previous['deleted'] and previous['record'] == record:
                        return {'saved': True, 'id': key, 'revision': previous['revision']}
                    raise LibraryConflict('This new-item request was already used. Start a new form.')
            revision = self.technical_edits.save(key, context['revision'], source, record, created=created)
            return {'saved': True, 'id': key, 'revision': revision}

    def technical_delete(self, key, body):
        with self._lock:
            if not isinstance(body, dict) or set(body) != {'revision', 'source_sha256'}:
                raise ValidationError('Reopen the Technical Library item before removing it.')
            context = self.technical_edit(key)
            if isinstance(body['revision'], bool) or body['revision'] != context['revision'] or body['source_sha256'] != context['source_sha256']:
                raise LibraryConflict('This Technical Library item changed. Reopen it before removing it.')
            key = context['record']['id']
            self.technical_edits.save(key, context['revision'], context['source_sha256'], context['record'], deleted=True)
            return {'deleted': True, 'id': key}

    def technical_link(self, key, body):
        with self._lock:
            identifier(key)
            if not isinstance(body, dict) or set(body) != {'penetration_ids'} or not isinstance(body['penetration_ids'], list) or not 1 <= len(body['penetration_ids']) <= 100:
                raise ValidationError('Choose between 1 and 100 Firestopping Library items.')
            ids = [identifier(value) for value in body['penetration_ids']]
            if len(set(ids)) != len(ids):
                raise ValidationError('Choose each Firestopping Library item once.')
            data = self._load()
            key = self._technical_key(key, data)
            if not data or key not in data['_technical_public_records'] or any(value not in data['_records']['penetration'] for value in ids):
                raise ReferenceNotFound()
            saved, _ = self.technical_edits.read()
            right_source = self._identity(key, super()._load(), saved)
            created = self.edits.created()
            with self.technical_edits.store.connect() as db:
                for left in ids:
                    source = created[left]['source_sha256'] if left in created else self._source_hash(data)
                    db.execute('INSERT INTO technical_library_links VALUES (?,?,?,?,?,?,?) ON CONFLICT(penetration_id,technical_id) DO UPDATE SET penetration_source=excluded.penetration_source,technical_source=excluded.technical_source,linked=1,updated_at=excluded.updated_at,revision=technical_library_links.revision+1',
                               (left, key, source, right_source, 1, timestamp(), 1))
            return {'linked': True, 'technical_id': key, 'penetration_ids': ids}

    def add_link(self, key, body):
        values = ([body.get('technical_id')] if isinstance(body, dict) and set(body) == {'technical_id'} else
                  body.get('technical_ids') if isinstance(body, dict) and set(body) == {'technical_ids'} else None)
        if not isinstance(values, list):
            return super().add_link(key, body)
        with self._lock:
            identifier(key)
            if not 1 <= len(values) <= 100 or any(not isinstance(value, str) for value in values) or len(set(values)) != len(values):
                raise ValidationError('Choose each Technical Library item once.')
            data = self._load()
            rights = list(dict.fromkeys(self._technical_key(value, data) for value in values))
            canonical_body = {'technical_id': rights[0]} if 'technical_id' in body else {'technical_ids': rights}
            saved, edges = self.technical_edits.read()
            owned_edges = {right for left, right, *_ in edges if left == key}
            if not any(saved.get(value, {}).get('created') or value in owned_edges for value in rights):
                return super().add_link(key, canonical_body)
            if not data or key not in data['_records']['penetration'] or any(value not in data['_technical_public_records'] for value in rights):
                raise ReferenceNotFound()
            base = super()._load(); created = self.edits.created(); left_source = created[key]['source_sha256'] if key in created else self._source_hash(base)
            identities = [(right, self._identity(right, base, saved)) for right in rights]
            with self.technical_edits.store.connect() as db:
                for right, source in identities:
                    db.execute('INSERT INTO technical_library_links VALUES (?,?,?,?,?,?,?) ON CONFLICT(penetration_id,technical_id) DO UPDATE SET penetration_source=excluded.penetration_source,technical_source=excluded.technical_source,linked=1,updated_at=excluded.updated_at,revision=technical_library_links.revision+1',
                               (key, right, left_source, source, 1, timestamp(), 1))
            result = {'linked': True, 'penetration_id': key, 'technical_ids': rights, 'created_ids': rights, 'existing_ids': []}
            if 'technical_id' in body:
                result.update(technical_id=rights[0], created=True)
            return result

    def remove_link(self, key, body):
        if not isinstance(body, dict) or set(body) != {'technical_id'}:
            return super().remove_link(key, body)
        with self._lock:
            identifier(key)
            right = self._technical_key(body['technical_id'], self._load())
            _, links = self.technical_edits.read()
            if not any(left == key and target == right for left, target, *_ in links):
                return super().remove_link(key, {'technical_id': right})
            with self.technical_edits.store.connect() as db:
                db.execute('UPDATE technical_library_links SET linked=0,updated_at=?,revision=revision+1 WHERE penetration_id=? AND technical_id=?', (timestamp(), key, right))
            return {'unlinked': True, 'penetration_id': key, 'technical_id': right}

    def _response(self, *args, **kwargs):
        result = super()._response(*args, **kwargs)
        data = self._load()
        definitions = {entry['key']: entry for entry in data.get('_canonical_library_filters', [])} if data else {}
        columns = {'J': 'category', 'K': 'services', 'L': 'type', 'M': 'orientation', 'N': 'frl', 'P': 'substrate', 'V': 'manufacturer'}
        for field in result['definition']['row_fields']:
            key = columns.get(field['column'])
            if key in definitions and definitions[key]['options']:
                field['type'] = 'select'
                field['options'] = [option['value'] for option in definitions[key]['options']]
                field['library_option_groups'] = deepcopy(definitions[key]['options'])
                field['library_filter_key'] = key
        return result
