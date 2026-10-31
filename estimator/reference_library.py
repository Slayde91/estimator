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
from .technical_configuration_review import validate_configuration_review
from .technical_duplicates import reviewed_groups, consolidate_links
from .technical_catalog_policy import public_records
from .technical_table_navigation import validate_table_navigation
from .technical_orientation import prepare_selector_orientation_context
from .library_substrates import canonical_substrate, classify_substrates, substrate_options
from .technical_record_corrections import correct_report_captions
from .library_opening_types import opening_type
from .library_display import display_subtitle, remove_resolved_source_notices
from .technical_brand_presentation import present_manufacturer_fields
from .library_diagram_names import validate_drawing_name, drawing_source_names, apply_drawing_names
from .library_report_links import FIREFLY_REPORTS_URL, validate_report_links, report_href
from .library_facets import FACETS, classify_facets, facet_options
from .library_filter_groups import grouped_filter_options
from .technical_service_options import options as technical_service_options
from .technical_presentation import present_options, technical_title
from .technical_discovery import (HIDDEN_FRL_CHOICES, canonical_frl, discovery_facets,
                                  present_frl_text, present_technical,
                                  project_smoke_sampling_services)
from .technical_fields import (FIELD_LABELS, LEGACY_LABELS,
                               is_hidden_technical_label, normalize_technical_item)
from .firefly_reference_review import plan_stamp, load_review
from .firefly_technical_review import (REVIEW_KEY, ValidatedReview,
    plan_stamp as technical_plan_stamp, load_review as load_technical_review,
    project as project_firefly_technical)
from .technical_service_review import (REVIEW_KEY as SERVICE_REVIEW_KEY,
    ValidatedReview as ValidatedServiceReview, plan_stamp as service_plan_stamp,
    load_review as load_service_review, project as project_service_review)
from .technical_variants import (REVIEW_KEY as VARIANT_REVIEW_KEY,
    ValidatedReview as ValidatedVariantReview, plan_stamp as variant_plan_stamp,
    load_review as load_variant_review, project as project_variants,
    present_reviewed_table_captions)

KINDS = {'penetration': 'Firestopping Library', 'technical': 'Technical Library'}
IDENTIFIER = re.compile(r'[a-z0-9][a-z0-9_-]{0,119}\Z')
# The BOSS matrix leaves the reviewed index within 3 KiB of the old 64 MiB limit.
# Keep a bounded file size and the existing record/field/asset limits.
MAX_INDEX = 96 * 1024 * 1024
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


def manufacturer_values(item, assets):
    """Resolve the facet from explicit metadata, then linked supplier reports.

    Legacy Firefly reports predate the manufacturer facet. Do not classify an
    entry from incidental product mentions in installation text or diagrams.
    """
    explicit = item.get('filter_values', {}).get('manufacturer', [])
    if explicit:
        return list(explicit)
    fields = [value.strip() for field in item.get('fields', [])
              if field['label'].casefold() == 'manufacturer'
              for value in field['value'].splitlines() if value.strip()]
    if fields:
        return list(dict.fromkeys(fields))
    for source in item.get('sources', []):
        document = assets.get(source.get('document_id'), {})
        if document.get('pdf') and re.search(r'\bFIREFLY(?:BATT)?\b', document['filename'], re.I):
            return ['Firefly']
    return []


def field_text(fields, assets, *, projected=False):
    """Validate imported or reviewed fields before any presentation or search."""
    if not isinstance(fields, list) or len(fields) > 1000:
        raise ValueError('Field limits')
    text = []
    for field in fields:
        text += [string(field['label'], 500), string(field['value'])]
        validate_report_links(field)
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
    validate_table_navigation(fields)
    for field in fields:
        text.extend(field.get('table_captions', []))
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
            review_stamp = plan_stamp(self.directory)
            technical_stamp = technical_plan_stamp(self.directory)
            service_stamp = service_plan_stamp(self.directory)
            variant_stamp = variant_plan_stamp(self.directory)
        except FileNotFoundError:
            self._data = None
            self._stamp = None
            return None
        except (OSError, ValueError) as exc:
            raise ValidationError('The local reference library could not be read. Rebuild it from the source files.') from exc
        stamp = (info.st_mtime_ns, info.st_size, info.st_ctime_ns, review_stamp, technical_stamp, service_stamp, variant_stamp)
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
            if REVIEW_KEY in data or SERVICE_REVIEW_KEY in data or VARIANT_REVIEW_KEY in data or '_index_sha256' in data:
                raise ValueError('Imported technical runtime marker')
            index_sha256 = hashlib.sha256(payload).hexdigest()
            data['_index_sha256'] = index_sha256
            load_review(self.directory, data, index_sha256, review_stamp)
            data[REVIEW_KEY] = load_technical_review(
                self.directory, data, index_sha256, technical_stamp)
            data[SERVICE_REVIEW_KEY] = load_service_review(
                self.directory, data, index_sha256, service_stamp)
            data[VARIANT_REVIEW_KEY] = load_variant_review(
                self.directory, data, index_sha256, variant_stamp)
            self._validate(data)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise ValidationError('The local reference library could not be read. Rebuild it from the source files.') from exc
        self._data, self._stamp = data, stamp
        return data

    def _same_technical_source(self, data, source):
        # Saved Firestopping overlays only change penetration items and links.
        # Reuse technical projection only from this instance's validated source,
        # with the exact same raw records, assets and review dependencies. This
        # capability is passed by Python code, never read from an imported index.
        return (source is not None and source is self._data
                and data['libraries']['technical'] is source['libraries']['technical']
                and all(data.get(key) is source.get(key) for key in (
                    'documents', 'images', 'trafalgar_selector_import', 'technical_duplicate_reviews',
                    REVIEW_KEY, SERVICE_REVIEW_KEY, VARIANT_REVIEW_KEY)))

    def _validate(self, data, *, validated_source=None):
        if not isinstance(data, dict) or type(data['schema_version']) is not int or data['schema_version'] != 1:
            raise ValueError('Unsupported library schema')
        if data.get(REVIEW_KEY) is not None and not isinstance(data[REVIEW_KEY], ValidatedReview):
            raise ValueError('Imported Firefly technical review capability')
        if data.get(SERVICE_REVIEW_KEY) is not None and not isinstance(data[SERVICE_REVIEW_KEY], ValidatedServiceReview):
            raise ValueError('Imported technical Services review capability')
        if data.get(VARIANT_REVIEW_KEY) is not None and not isinstance(data[VARIANT_REVIEW_KEY], ValidatedVariantReview):
            raise ValueError('Imported technical variant review capability')
        reuse_technical = self._same_technical_source(data, validated_source)
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
            if is_pdf and 'drawing_identity' in asset:
                raise ValueError('Drawing image names cannot rename a PDF.')
            validate_drawing_name(assets[key])
        source_names = drawing_source_names(assets)
        records, searches, filters = {}, {}, {}
        selector_context = prepare_selector_orientation_context(data.get('trafalgar_selector_import'))
        if set(data['libraries']) != set(KINDS):
            raise ValueError('Missing library')
        for kind in KINDS:
            if kind == 'technical' and reuse_technical:
                records[kind] = validated_source['_records'][kind]
                searches[kind] = validated_source['_searches'][kind]
                filters[kind] = validated_source['_filters'][kind]
                continue
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
            imported_filter_keys = set(filter_labels)
            # Validate imported keys against their original schema, then replace
            # the source-table facet with the derived, multi-value substrate facet.
            # The source definition and records remain unchanged in the bundle.
            filter_labels = {
                ('substrate' if key == 'table' else key):
                ('Substrate' if key in {'table', 'substrate'} else label)
                for key, label in filter_labels.items()
            }
            filter_labels.setdefault('substrate', 'Substrate')
            if kind == 'technical':
                filter_labels.setdefault('manufacturer', 'Manufacturer')
                for key in FACETS:
                    filter_labels.pop(key, None)
                for key, (label, _) in FACETS.items():
                    filter_labels[key] = label
            records[kind], searches[kind] = {}, {}
            filter_values = {key: set() for key in filter_labels}
            for item in items:
                if kind == 'technical' and 'related_technical_records' in item:
                    raise ValueError('Related Technical records are computed runtime metadata')
                if kind == 'technical' and 'variant_source' in item:
                    raise ValueError('Technical variant sources are computed runtime metadata')
                if kind == 'technical' and 'user_authored' in item:
                    raise ValueError('Manual Technical identity is computed runtime metadata')
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
                    validate_configuration_review(item['technical_field_review'], item, assets)
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
                if set(values) - imported_filter_keys:
                    raise ValueError('Unknown filter')
                for field, selected in values.items():
                    if not isinstance(selected, list):
                        raise ValueError('Filter values must be lists')
                    for value in selected:
                        string(value, 1000)
                source_item = item
                if kind == 'technical':
                    # Validate the original evidence before projecting its display.
                    # Keep the imported record in libraries/items unchanged: source
                    # fingerprints and saved manual links depend on those bytes.
                    item = normalize_technical_item(item, selector_capture=selector_context)
                    apply_drawing_names(item, assets, source_names)
                    remove_resolved_source_notices(item)
                    present_options(item)
                    # Resolved notice columns can leave another FRL-only table.
                    # Finish the shared display after those columns are removed.
                    present_manufacturer_fields(item)
                    text = [item.get(name, '') for name in ('title', 'subtitle', 'summary', 'source_label')]
                    text += field_text(item.get('fields', []), assets, projected=True)
                    for source in item.get('sources', []):
                        text.extend((source.get('label', ''), source.get('filename', '')))
                else:
                    item = deepcopy(item)
                    apply_drawing_names(item, assets, source_names)
                values = item.setdefault('filter_values', {})
                item['subtitle'] = display_subtitle(item.get('subtitle', ''))
                values.pop('table', None)
                if kind == 'technical':
                    values['manufacturer'] = manufacturer_values(item, assets)
                    values.update(classify_facets(item))
                    values['type'] = [opening_type(item)]
                    item['title'] = technical_title(item)
                    text.append(item['title'])
                    if values['manufacturer'] == ['Firefly']:
                        for field in item.get('fields', []):
                            if field['label'] == 'Report Number':
                                field['report_links'] = [
                                    {'label': label.strip(), 'url': FIREFLY_REPORTS_URL}
                                    for label in field['value'].splitlines() if label.strip()]
                                validate_report_links(field)
                    for field in item.get('fields', []):
                        if field.get('label') == 'Report Number':
                            old_links = {link['label']: link['url'] for link in field.get('report_links', [])}
                            field['report_links'] = [
                                {'label': label.strip(), 'url': url}
                                for label in field.get('value', '').splitlines() if label.strip()
                                if (url := report_href(label.strip(), old_links.get(label.strip()),
                                                       user_authored=item.get('user_authored') is True))]
                            if not field['report_links']:
                                field.pop('report_links', None)
                values['substrate'] = classify_substrates(
                    source_item, item, selector_capture=selector_context,
                    source_documents=assets)
                values = item.get('filter_values', {})
                # Collect the same projected values used by listing/detail.
                # Substrate is declared above; orientation is the only other
                # derived key allowed beyond the imported filter schema.
                if kind == 'technical' and 'orientation' in values and 'orientation' not in filter_labels:
                    filter_labels['orientation'] = 'Orientation'
                    filter_values['orientation'] = set()
                if set(values) - set(filter_labels):
                    raise ValueError('Unknown projected filter')
                for field, selected in values.items():
                    if not isinstance(selected, list):
                        raise ValueError('Projected filter values must be lists')
                    for value in selected:
                        filter_values[field].add(string(value, 1000))
                records[kind][key] = item
                searches[kind][key] = '\n'.join(text).casefold()
            filters[kind] = [{'key': key, 'label': label, 'options': (substrate_options(filter_values[key]) if kind == 'technical' and key == 'substrate' else [{'value': value, 'label': value} for value in (facet_options(key, filter_values[key]) if kind == 'technical' else sorted(filter_values[key], key=str.casefold))])} for key, label in filter_labels.items()
                             if kind != 'technical' or key != 'trafalgar_category']
        aliases, groups = ((validated_source['_aliases'], validated_source['_groups']) if reuse_technical
                           else reviewed_groups(data, records['technical'], assets))
        visible = {kind: [key for key in records[kind]
                          if kind != 'technical' or aliases.get(key, key) == key] for kind in KINDS}
        if not reuse_technical:
            for canonical, members in groups.items():
                searches['technical'][canonical] += '\n' + '\n'.join(
                    key + '\n' + searches['technical'][key] for key in members)
                for key in members:
                    records['technical'][key]['consolidated_ids'] = list(members)
                    records['technical'][key]['canonical_id'] = canonical
        # Public product/report decisions must not change the records bound to
        # source reviews or the original records used by durable manual links.
        if reuse_technical:
            public_technical = validated_source['_technical_public_records']
            technical_related = validated_source['_technical_related_records']
            reviewed_substrates = validated_source['_technical_reviewed_substrates']
        else:
            report_keys = [entry['key'] for entry in filters['technical'] if entry['key'] in {'report', 'document'}]
            public_technical = public_records(records['technical'], aliases, report_keys or ['report'])
            public_technical = {key: correct_report_captions(item) for key, item in public_technical.items()}
            public_technical, technical_related, reviewed_substrates = project_firefly_technical(
                public_technical, records['technical'], aliases, data.get(REVIEW_KEY), report_keys or ['report'])
            if not report_keys and any('report' in item.get('filter_values', {}) for item in public_technical.values()):
                filters['technical'].append({'key': 'report', 'label': 'Report', 'options': []})
            searches['technical'] = {key: searches['technical'][key] + '\n' + '\n'.join(
                field.get('value', '') for field in item.get('fields', []) if field.get('label') == 'Report Number').casefold()
                + '\n' + '\n'.join(reviewed_substrates.get(key, [])).casefold()
                for key, item in public_technical.items()}
        visible['technical'] = [key for key in visible['technical'] if key in public_technical]
        # Discovery aliases are applied after source-bound duplicate review.
        # Keep _records and its reviewed fields/facets unchanged: manual-link
        # fingerprints and duplicate reviews still see their original inputs.
        if reuse_technical:
            discovery = validated_source['_technical_discovery']
        else:
            imported_services = {item['id']: item.get('filter_values', {}).get('services', [])
                                 for item in data['libraries']['technical']['items']}
            discovery = {key: {**item.get('filter_values', {}),
                               **discovery_facets(item, imported_services=imported_services[key])}
                         for key, item in public_technical.items()}
            discovery = project_service_review(public_technical, discovery, data.get(SERVICE_REVIEW_KEY))
            variant_projection = project_variants(public_technical, discovery, data.get(VARIANT_REVIEW_KEY),
                source_records={item['id']: item for item in data['libraries']['technical']['items']}, assets=assets)
            public_technical, discovery = variant_projection.records, variant_projection.discovery
            # Synthetic view records are lookup targets, never supplier items.
            # Existing source projections remain unchanged for old review and
            # durable manual-link identities.
            for key, item in public_technical.items():
                if key not in records['technical']:
                    records['technical'][key] = deepcopy(item)
                if key not in searches['technical'] or key in variant_projection.lineage:
                    searches['technical'][key] = ('\n'.join(str(item.get(name, '')) for name in ('id', 'title', 'subtitle', 'summary')) + '\n' + '\n'.join(
                        field.get('value', '') + '\n' + json.dumps([field.get('table'), field.get('tables')], ensure_ascii=False)
                        for field in item.get('fields', []))).casefold()
            if variant_projection.aliases:
                aliases = dict(aliases)
                aliases.update(variant_projection.aliases)
                # Collapse retained aliases through newly reviewed canonical IDs.
                for key in list(aliases):
                    target, visited = aliases[key], {key}
                    while target in aliases and aliases[target] != target:
                        if target in visited:
                            raise ValueError('Cyclic Technical variant alias')
                        visited.add(target); target = aliases[target]
                    aliases[key] = target
                groups = {}
                for key, canonical in aliases.items():
                    members = groups.setdefault(canonical, [canonical])
                    if key not in members:
                        members.append(key)
            for canonical, members in groups.items():
                if variant_projection.lineage and canonical in searches['technical']:
                    searches['technical'][canonical] += '\n' + '\n'.join(members).casefold()
                for key in members:
                    if key in public_technical:
                        public_technical[key] = {**public_technical[key], 'canonical_id': canonical, 'consolidated_ids': list(members)}
            visible['technical'] = [key for key in public_technical if aliases.get(key, key) == key]
            explicit_smoke_ids = {key for key, values in imported_services.items()
                                  if 'Smoke Sampling Tubes' in values}
            if data.get(SERVICE_REVIEW_KEY) is not None:
                explicit_smoke_ids.update(row['id'] for row in json.loads(data[SERVICE_REVIEW_KEY].payload)['items']
                                          if 'Smoke Sampling Tubes' in row['services'])
            discovery = project_smoke_sampling_services(public_technical, discovery,
                explicit_ids=explicit_smoke_ids, lineage=variant_projection.lineage)
            for entry in filters['technical']:
                observed = {value for values in discovery.values() for value in values.get(entry['key'], [])}
                if entry['key'] == 'frl':
                    observed -= HIDDEN_FRL_CHOICES
                entry['options'] = (substrate_options(observed) if entry['key'] == 'substrate' else
                                    [{'value': value, 'label': value}
                                     for value in (technical_service_options(observed) if entry['key'] == 'services'
                                                   else facet_options(entry['key'], observed))])
        # Group only filter metadata, after source-bound duplicate reviews and
        # discovery construction. Record fields/facets and link identities stay
        # unchanged, including when a saved Firestopping overlay is loaded.
        for kind in KINDS:
            if kind == 'technical' and reuse_technical:
                continue
            for entry in filters[kind]:
                entry['options'] = grouped_filter_options(
                    entry['key'], entry['options'], (public_technical if kind == 'technical' else records[kind]).values())
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
            # Validate both original endpoints even when a public catalog
            # exclusion hides this retained edge from the reciprocal lists.
            if left not in records['penetration'] or right not in records['technical']:
                raise ValueError('Missing link endpoint')
            if right not in public_technical:
                continue
            for kind, source, target_kind, target in [('penetration', left, 'technical', right), ('technical', right, 'penetration', left)]:
                title = (public_technical[target] if target_kind == 'technical' else records[target_kind][target])['title']
                links[kind][source].append({'kind': target_kind, 'id': target, 'title': title, 'relationship': relationship,
                                          **({'origin': 'user'} if link.get('origin') == 'user' else {})})
        consolidate_links(links, aliases, groups)
        for entries in links['penetration'].values():
            for entry in entries:
                entry['title'] = public_technical[entry['id']]['title']
        data['_aliases'], data['_groups'], data['_visible'] = aliases, groups, visible
        data['_technical_discovery'] = discovery
        data['_technical_public_records'] = public_technical
        data['_technical_related_records'] = technical_related
        data['_technical_reviewed_substrates'] = reviewed_substrates
        data['_technical_variant_lineage'] = (validated_source['_technical_variant_lineage'] if reuse_technical else variant_projection.lineage)
        data['_technical_variant_sources'] = (validated_source['_technical_variant_sources'] if reuse_technical else variant_projection.sources)
        data['_technical_variant_table_scopes'] = (validated_source.get('_technical_variant_table_scopes', {})
                                                   if reuse_technical else variant_projection.table_scopes)
        data['_records'], data['_searches'], data['_filters'], data['_links'], data['_assets'] = records, searches, filters, links, assets

    @staticmethod
    def technical_source_record(key, data):
        """Resolve an immutable original or its reviewed synthetic descriptor."""
        for source in data['libraries']['technical']['items']:
            if source['id'] == key:
                return source
        source = data.get('_technical_variant_sources', {}).get(key)
        if source is None:
            raise ReferenceNotFound()
        return source

    def overview(self):
        with self._lock:
            data = self._load()
            return {'libraries': [{'id': kind, 'title': title, 'available': data is not None,
                     'count': len(data['_visible'][kind]) if data else 0,
                     'linked_count': sum(bool(data['_links'][kind][key]) for key in data['_visible'][kind]) if data else 0,
                     'unlinked_count': sum(not data['_links'][kind][key] for key in data['_visible'][kind]) if data else 0,
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
            if kind == 'technical' and 'frl' in chosen:
                chosen['frl'] = canonical_frl(chosen['frl'])
            if kind == 'technical' and 'substrate' in chosen:
                chosen['substrate'] = canonical_substrate(chosen['substrate'])
            if kind == 'technical' and chosen.get('services') == 'Junction Box':
                chosen['services'] = 'Conduits'
            items = []
            if data:
                for key in data['_visible'][kind]:
                    item = data['_technical_public_records'][key] if kind == 'technical' else data['_records'][kind][key]
                    linked = bool(data['_links'][kind][key])
                    if (reference == 'linked' and not linked) or (reference == 'unlinked' and linked):
                        continue
                    values = data['_technical_discovery'][key] if kind == 'technical' else item.get('filter_values', {})
                    search_text = data['_searches'][kind][key]
                    if kind == 'technical':
                        search_text += '\n' + '\n'.join(values.get('frl', []))
                    if all(token in search_text for token in search.split()) and all(value in values.get(name, []) for name, value in chosen.items()):
                        items.append({**{name: item.get(name, '') for name in ('id', 'title', 'subtitle', 'summary', 'source_label')},
                                      **{name: deepcopy(item[name]) for name in ('library_id', 'price', 'editable') if name in item},
                                      'related_count': len(data['_links'][kind][key])})
            counts = {'total': len(data['_visible'][kind]) if data else 0,
                      'linked': sum(bool(data['_links'][kind][key]) for key in data['_visible'][kind]) if data else 0,
                      'unlinked': sum(not data['_links'][kind][key] for key in data['_visible'][kind]) if data else 0}
            manufacturers = {}
            if data:
                for key in data['_visible'][kind]:
                    names = data['_records'][kind][key].get('filter_values', {}).get('manufacturer', [])
                    for name in set(names or ['Manufacturer not recorded']):
                        manufacturers[name] = manufacturers.get(name, 0) + 1
            counts['manufacturers'] = [{'name': name, 'count': count} for name, count in sorted(manufacturers.items(), key=lambda item: item[0].casefold())]
            filters = deepcopy(data['_filters'][kind]) if data else []
            if kind == 'penetration':
                filters.append({'key': 'technical_reference', 'label': 'Technical reference', 'options': [
                    {'value': 'any', 'label': 'Any'}, {'value': 'linked', 'label': 'Linked'}, {'value': 'unlinked', 'label': 'No linked reference'}]})
            shown = items[offset:offset + limit]
            if kind == 'technical':
                shown = [present_technical(item, source_ratings=data['_records'][kind][item['id']]
                                           .get('filter_values', {}).get('frl', [])) for item in shown]
            return {'items': shown, 'total': len(items), 'offset': offset, 'limit': limit,
                    'counts': counts, 'filters': filters,
                    'notice': data['libraries'][kind].get('notice', '') if data else 'No local reference library has been installed.'}

    def register_references(self, contexts, *, offset=0, limit=100, report_offset=0, expected_revision=None, excel=False):
        """Project current reference candidates without pricing or record edits."""
        from .register_references import library_batch
        with self._lock:
            return library_batch(self, contexts, offset=offset, limit=limit,
                                 report_offset=report_offset, expected_revision=expected_revision, excel=excel)

    def detail(self, kind, key):
        with self._lock:
            identifier(key)
            data = self._load()
            if not data or kind not in KINDS or key not in data['_records'][kind]:
                raise ReferenceNotFound()
            if kind == 'technical' and key not in data['_technical_public_records']:
                raise ReferenceNotFound()
            item = deepcopy(data['_technical_public_records'][key] if kind == 'technical' else data['_records'][kind][key])
            if kind == 'technical':
                item = present_technical(item)
                if key not in data.get('_manual_technical_sources', {}):
                    item = present_reviewed_table_captions(item, data.get('_technical_variant_table_scopes', {}).get(key, {}))
            item.pop('filter_values', None)
            item['links'] = deepcopy(data['_links'][kind][key])
            if kind == 'technical' and key in data['_technical_related_records']:
                item['related_technical_records'] = [
                    {'kind': 'technical', 'id': target,
                     'title': present_frl_text(data['_technical_public_records'][target]['title'],
                         known_ratings=data['_records']['technical'][target].get('filter_values', {}).get('frl', []))}
                    for target in data['_technical_related_records'][key]]
            for link in item['links']:
                if link['kind'] == 'technical':
                    ratings = data['_records']['technical'][link['id']].get('filter_values', {}).get('frl', [])
                    link['title'] = present_frl_text(link['title'], known_ratings=ratings)
            return item

    def image_replicas(self):
        from .library_replicas import registry
        with self._lock:
            data = self._load()
            return registry(self.directory, data['_assets']) if data else {}

    def replica_asset(self, key):
        from .library_replicas import asset
        identifier(key)
        entry = self.image_replicas().get(key)
        if entry is None:
            raise ReferenceNotFound()
        # Validate the current source bytes as well as the derivative's bytes.
        # A replica can never bypass the original source integrity check.
        self.asset(key, False)
        return asset(self.directory, entry)

    def asset(self, key, pdf=True):
        with self._lock:
            identifier(key)
            data = self._load()
            if not data or key not in data['_assets'] or data['_assets'][key]['pdf'] != pdf:
                raise ReferenceNotFound()
            asset = data['_assets'][key]
            path = self.directory / ('documents' if pdf else 'images') / (key + asset['extension'])
            if not pdf:
                archived = self.directory / 'images_old' / (key + asset['extension'])
                if archived.is_file():
                    # Replacements are illustrations; retain fingerprinted source evidence.
                    path = archived
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
            filename = asset['filename'] if asset.get('drawing_identity') else key + asset['extension']
            return payload, mime, filename
