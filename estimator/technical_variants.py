"""Private, reviewed table variants; immutable supplier records stay intact.

No combinations are inferred. A review names the applicable rows, scalar facts,
and discovery assignments for every variant. All source/projection dependencies
are checked before any public record changes.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re

from .firefly_reference_review import fingerprint as source_fingerprint
from .library_facets import CATEGORIES, MOVED_SERVICE_CATEGORIES
from .technical_discovery import canonical_frl, present_technical
from .technical_presentation import technical_title
from .technical_service_options import TECHNICAL_SERVICES
from .technical_table_navigation import field_tables, validate_table_navigation

PLAN_NAME = 'technical-variants-plan-v1.json'
REVIEW_KEY = '_technical_variants_review'
MAX_PLAN_BYTES = 32 * 1024 * 1024
MAX_VARIANTS = 50000
_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,119}\Z')
_SHA = re.compile(r'[a-f0-9]{64}\Z')
_FRL = re.compile(r'(?:-|\d+)/(?:-|\d+)/(?:-|\d+)\Z')
_BINDING = {'id', 'item_sha256', 'projection_sha256', 'discovery_sha256', 'assets_sha256'}
_FAMILY = {'source_id', 'item_sha256', 'projection_sha256', 'discovery_sha256',
           'assets_sha256', 'tables', 'reviewed_tables', 'variants'}
_FACETS = {'frl', 'substrate', 'orientation', 'category', 'services'}
_FORBIDDEN_FIELDS = {'Manufacturer', 'Report Number', 'Diagrams & Figures', 'Technical Basis'}


@dataclass(frozen=True)
class ValidatedReview:
    payload: str
    sha256: str


@dataclass(frozen=True)
class Projection:
    records: dict
    discovery: dict
    lineage: dict
    sources: dict
    aliases: dict
    groups: dict


def projection_fingerprint(record):
    """Bind the same explicit display stage as a captured public record."""
    return source_fingerprint(present_technical(record))


def discovery_fingerprint(facets):
    return source_fingerprint(facets)


def assets_fingerprint(record, assets):
    referenced = set()

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ('id', 'document_id', 'asset_id') and isinstance(child, str) and child in assets:
                    referenced.add(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(record)
    return source_fingerprint({key: assets[key] for key in sorted(referenced)})


def variant_id(parent_id, key):
    _identity(parent_id); _text(key, 200)
    return 'tv-' + source_fingerprint([parent_id, key])[:40]


def _identity(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError('Invalid table variant identity')
    return value


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError('Invalid table variant fingerprint')


def _text(value, maximum=100000, *, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValueError('Invalid table variant text')
    return value


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate table variant JSON key')
        result[key] = value
    return result


def _decode(payload):
    return json.loads(payload, object_pairs_hook=_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite table variant number')))


def _path(directory):
    directory = Path(directory)
    path = directory / 'reviews' / PLAN_NAME
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError('Table variant review must remain inside the library')
    return path


def plan_stamp(directory):
    path = _path(directory)
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    if not path.is_file() or not 0 < stat.st_size <= MAX_PLAN_BYTES:
        raise ValueError('Table variant review size or file type')
    return stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns


def _table(value):
    if not isinstance(value, dict) or set(value) != {'columns', 'rows'}:
        raise ValueError('Invalid reviewed variant table')
    columns, rows = value['columns'], value['rows']
    if not isinstance(columns, list) or not 1 <= len(columns) <= 20 or not isinstance(rows, list) or not 1 <= len(rows) <= 2000:
        raise ValueError('Reviewed variant table limit')
    for column in columns:
        _text(column, 500)
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            raise ValueError('Reviewed variant table columns differ')
        for cell in row:
            _text(cell, 20000, empty=True)


def _reference(row):
    if not isinstance(row, dict) or set(row) != {'field', 'table_index', 'sha256'}:
        raise ValueError('Invalid variant table binding')
    _text(row['field'], 500); _sha(row['sha256'])
    if type(row['table_index']) is not int or not 0 <= row['table_index'] < 100:
        raise ValueError('Invalid variant table index')


def _binding(row, key='id'):
    _identity(row[key])
    for field in ('item_sha256', 'projection_sha256', 'discovery_sha256', 'assets_sha256'):
        _sha(row[field])


def _shape(plan):
    required = {'schema_version', 'review_id', 'reviewed_index_sha256', 'families', 'aliases'}
    if not isinstance(plan, dict) or not required <= set(plan) <= required | {'existing_bindings'}:
        raise ValueError('Invalid table variant review schema')
    if type(plan['schema_version']) is not int or plan['schema_version'] != 1:
        raise ValueError('Unsupported table variant schema')
    _identity(plan['review_id']); _sha(plan['reviewed_index_sha256'])
    families, bindings, aliases = plan['families'], plan.get('existing_bindings', []), plan['aliases']
    if any(not isinstance(value, list) or len(value) > MAX_VARIANTS for value in (families, bindings, aliases)):
        raise ValueError('Table variant review inventory limit')
    seen = set(); total = 0
    for row in bindings:
        if not isinstance(row, dict) or set(row) != _BINDING:
            raise ValueError('Invalid existing variant binding')
        _binding(row)
        if row['id'] in seen:
            raise ValueError('Repeated table variant source')
        seen.add(row['id'])
    for family in families:
        if not isinstance(family, dict) or set(family) != _FAMILY:
            raise ValueError('Invalid table variant family')
        _binding(family, 'source_id')
        parent = family['source_id']
        if parent in seen:
            raise ValueError('Repeated table variant source')
        seen.add(parent)
        tables, replacements, variants = family['tables'], family['reviewed_tables'], family['variants']
        if (not isinstance(tables, list) or not 1 <= len(tables) <= 100
                or not isinstance(replacements, list) or len(replacements) > 100
                or not isinstance(variants, list) or not 1 <= len(variants) <= 2000):
            raise ValueError('Table variant family limits')
        table_keys = set()
        for table in tables:
            _reference(table)
            key = (table['field'], table['table_index'])
            if key in table_keys:
                raise ValueError('Repeated variant table')
            table_keys.add(key)
        replacement_keys = set()
        for replacement in replacements:
            if not isinstance(replacement, dict) or set(replacement) != {'field', 'table_index', 'source_table_sha256', 'table', 'row_ids', 'evidence'}:
                raise ValueError('Invalid reviewed replacement table')
            _reference({'field': replacement['field'], 'table_index': replacement['table_index'], 'sha256': replacement['source_table_sha256']})
            key = (replacement['field'], replacement['table_index'])
            if key not in table_keys or key in replacement_keys:
                raise ValueError('Unbound or repeated replacement table')
            replacement_keys.add(key); _table(replacement['table'])
            row_ids = replacement['row_ids']
            if (not isinstance(row_ids, list) or len(row_ids) != len(replacement['table']['rows'])
                    or len(set(row_ids)) != len(row_ids)):
                raise ValueError('Invalid replacement row inventory')
            for value in row_ids:
                _text(value, 500)
            evidence = replacement['evidence']
            if not isinstance(evidence, list) or not 1 <= len(evidence) <= 100:
                raise ValueError('Replacement table needs source evidence')
            for item in evidence:
                if not isinstance(item, dict) or set(item) != {'asset_id', 'sha256', 'page', 'quote', 'source_reference'}:
                    raise ValueError('Invalid replacement table evidence')
                _identity(item['asset_id']); _sha(item['sha256']); _text(item['quote'], 10000); _text(item['source_reference'], 2000)
                if type(item['page']) is not int or not 1 <= item['page'] <= 10000:
                    raise ValueError('Invalid replacement evidence page')
        variant_keys = set(); retained = 0
        for variant in variants:
            if not isinstance(variant, dict) or set(variant) != {'key', 'existing_id', 'selections', 'fields', 'facets'}:
                raise ValueError('Invalid table variant')
            key = _text(variant['key'], 200)
            if key in variant_keys:
                raise ValueError('Repeated table variant key')
            variant_keys.add(key)
            if variant['existing_id'] is not None:
                _identity(variant['existing_id'])
            retained += variant['existing_id'] == parent
            fields, facets, selections = variant['fields'], variant['facets'], variant['selections']
            if not isinstance(fields, dict) or not 1 <= len(fields) <= 50:
                raise ValueError('Invalid variant scalar fields')
            for label, value in fields.items():
                _text(label, 500); _text(value, empty=True)
                if label in _FORBIDDEN_FIELDS:
                    raise ValueError('Variants cannot replace source identity or images')
            if not isinstance(facets, dict) or set(facets) != _FACETS:
                raise ValueError('Invalid variant discovery assignments')
            for name, values in facets.items():
                if not isinstance(values, list) or not 1 <= len(values) <= 100 or len(set(values)) != len(values):
                    raise ValueError('Variant assignments must be distinct nonempty lists')
                for value in values:
                    _text(value, 1000)
            frls = facets['frl']
            if len(frls) != 1 or (not _FRL.fullmatch(frls[0]) and frls[0] not in ('N/A', 'Not specified')) or canonical_frl(frls[0]) != frls[0]:
                raise ValueError('A table variant requires exactly one canonical FRL')
            if set(facets['orientation']) - {'Horizontal', 'Vertical'}:
                raise ValueError('Invalid variant orientation')
            if not isinstance(selections, list) or len(selections) != len(tables):
                raise ValueError('Every bound variant table needs an explicit selection')
            selected = set()
            for selection in selections:
                required_selection = {'field', 'table_index', 'columns'}
                if (not isinstance(selection, dict) or not required_selection <= set(selection)
                        or set(selection) - required_selection not in ({'row_index'}, {'row_indices'})):
                    raise ValueError('Invalid variant row selection')
                key = (selection['field'], selection['table_index'])
                if key not in table_keys or key in selected:
                    raise ValueError('Repeated or unbound variant row selection')
                selected.add(key)
                rows = [selection['row_index']] if 'row_index' in selection else selection['row_indices']
                if (not isinstance(rows, list) or len(rows) > 2000 or len(set(rows)) != len(rows)
                        or any(type(index) is not int or index < 0 for index in rows)):
                    raise ValueError('Invalid selected variant rows')
                columns = selection['columns']
                if columns is not None and (not isinstance(columns, list) or not columns
                        or any(type(index) is not int or index < 0 for index in columns)
                        or columns != sorted(set(columns))):
                    raise ValueError('Invalid selected variant columns')
        if retained != 1:
            raise ValueError('Exactly one variant must retain its original ID')
        total += len(variants)
    if total > MAX_VARIANTS:
        raise ValueError('Too many projected table variants')
    for alias in aliases:
        if not isinstance(alias, dict) or set(alias) != {'alias_id', 'canonical_id'}:
            raise ValueError('Invalid reviewed variant alias')
        _identity(alias['alias_id']); _identity(alias['canonical_id'])
        if alias['alias_id'] == alias['canonical_id']:
            raise ValueError('A variant alias must have a different canonical ID')


def registered_assets(data):
    return {asset['id']: {**asset, 'extension': '.pdf' if pdf else asset['extension'], 'pdf': pdf}
            for pdf, values in ((True, data['documents']), (False, data.get('images', []))) for asset in values}


def validate_plan(data, index_sha256, plan):
    _sha(index_sha256); _shape(plan)
    originals = {row['id']: row for row in data['libraries']['technical']['items']}
    assets = registered_assets(data)
    bindings = [{'id': row['source_id'], **{key: value for key, value in row.items() if key in _BINDING - {'id'}}}
                for row in plan['families']] + plan.get('existing_bindings', [])
    for row in bindings:
        original = originals.get(row['id'])
        if (original is None or source_fingerprint(original) != row['item_sha256']
                or assets_fingerprint(original, assets) != row['assets_sha256']):
            raise ValueError('Variant source or referenced asset changed; review must be updated')
    for family in plan['families']:
        original = originals[family['source_id']]
        for replacement in family['reviewed_tables']:
            for evidence in replacement['evidence']:
                asset = assets.get(evidence['asset_id'])
                if asset is None or asset['sha256'] != evidence['sha256'] or not 1 <= evidence['page'] <= (asset['pages'] if asset['pdf'] else 1):
                    raise ValueError('Reviewed replacement asset evidence changed')
                if assets_fingerprint(original, {evidence['asset_id']: asset}) == source_fingerprint({}):
                    raise ValueError('Replacement evidence is not linked to this source item')
    payload = json.dumps(plan, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    if len(payload.encode()) > MAX_PLAN_BYTES:
        raise ValueError('Table variant review size limit')
    return ValidatedReview(payload, hashlib.sha256(payload.encode()).hexdigest())


def load_review(directory, data, index_sha256, expected_stamp):
    if expected_stamp is None:
        return None
    if plan_stamp(directory) != expected_stamp:
        raise ValueError('Table variant review changed before reading')
    with _path(directory).open('rb') as stream:
        payload = stream.read(MAX_PLAN_BYTES + 1)
    if len(payload) > MAX_PLAN_BYTES or plan_stamp(directory) != expected_stamp:
        raise ValueError('Table variant review changed while reading')
    return validate_plan(data, index_sha256, _decode(payload))


def technical_signature(record, facets, assets):
    """Exact substantive fields/images/facets; source labels and IDs are not facts."""
    def images(values):
        return [{'sha256': assets[value['id']]['sha256'], **{key: child for key, child in value.items() if key != 'id'}}
                for value in values]

    fields = []
    for field in record.get('fields', []):
        if field['label'] == 'ID':
            continue
        value = {'label': field['label'], 'value': field['value']}
        tables = []
        for table in field_tables(field):
            columns = [index for index, label in enumerate(table['columns']) if label.casefold() not in {'id', 'configuration'}]
            tables.append({'columns': [table['columns'][index] for index in columns],
                           'rows': [[row[index] for index in columns] for row in table['rows']]})
        if tables:
            value['tables'] = tables
        if field.get('images'):
            value['images'] = images(field['images'])
        fields.append(value)
    return source_fingerprint({'fields': sorted(fields, key=lambda field: field['label']),
                               'images': images(record.get('images', [])),
                               'facets': {key: sorted(set(values)) for key, values in facets.items()}})


def _field(record, label):
    matches = [field for field in record.get('fields', []) if field['label'] == label]
    if len(matches) != 1:
        raise ValueError('Variant table field is missing or ambiguous')
    return matches[0]


def _bound_table(record, label, index):
    matching = [field for field in record.get('fields', []) if field['label'] == label]
    if len(matching) > 1:
        raise ValueError('Variant table field is ambiguous')
    tables = field_tables(matching[0]) if matching else []
    if index > len(tables):
        raise ValueError('Variant table append position is not contiguous')
    return tables[index] if index < len(tables) else None


def _scope(record, selections):
    by_field = {}
    for selection in selections:
        by_field.setdefault(selection['field'], {})[selection['table_index']] = selection
    remaps = {}
    for label, selected in by_field.items():
        field = _field(record, label); tables = field_tables(field)
        if any(index >= len(tables) for index in selected):
            raise ValueError('Variant table index is unavailable')
        original_ids = field.get('table_row_ids', [[source_fingerprint([index, row]) for index, row in enumerate(table['rows'])] for table in tables])
        kept, row_ids, captions, remap = [], [], [], {}
        for index, table in enumerate(tables):
            selection = selected.get(index)
            rows = ([selection['row_index']] if 'row_index' in selection else selection['row_indices']) if selection else list(range(len(table['rows'])))
            columns = (selection['columns'] if selection and selection['columns'] is not None else list(range(len(table['columns']))))
            if any(row >= len(table['rows']) for row in rows) or any(column >= len(table['columns']) for column in columns):
                raise ValueError('Selected variant row or column is unavailable')
            rating_columns = {column for column, name in enumerate(table['columns']) if re.search(r'\bfrl\b', name, re.I)}
            if selection and rows and (len(rating_columns & set(columns)) > 1 or (rating_columns & set(columns) and len(rows) > 1)):
                raise ValueError('A variant rating table must retain one row and one FRL column')
            if selection and any(column not in columns for column in range(len(table['columns'])) if column not in rating_columns):
                raise ValueError('Variant selection cannot omit substantive non-rating columns')
            if not rows:
                continue
            remap[index] = len(kept)
            kept.append({'columns': [table['columns'][column] for column in columns],
                         'rows': [[table['rows'][row][column] for column in columns] for row in rows]})
            row_ids.append([original_ids[index][row] for row in rows])
            if 'table_captions' in field:
                captions.append(field['table_captions'][index])
        for key in ('table', 'tables', 'table_row_ids', 'table_captions'):
            field.pop(key, None)
        if kept:
            field['table'] = kept[0]
            if len(kept) > 1:
                field['tables'] = kept[1:]
            field['table_row_ids'] = row_ids
            if captions:
                field['table_captions'] = captions
        remaps[label] = remap
    for field in record.get('fields', []):
        if 'table_links' in field:
            links = []
            for link in field['table_links']:
                remap = remaps.get(link['field'])
                if remap is None:
                    links.append(link)
                elif link['table_index'] in remap:
                    links.append({**link, 'table_index': remap[link['table_index']]})
            if links:
                field['table_links'] = links
            else:
                field.pop('table_links')
    validate_table_navigation(record.get('fields', []))


def project(public_records, discovery, review, *, source_records, assets):
    if review is None:
        return Projection(public_records, discovery, {}, {}, {}, {})
    if not isinstance(review, ValidatedReview) or hashlib.sha256(review.payload.encode()).hexdigest() != review.sha256:
        raise ValueError('Imported or changed variant review capability')
    plan = _decode(review.payload); _shape(plan)
    binding_ids = set()
    for binding in [*plan.get('existing_bindings', []), *[{**row, 'id': row['source_id']} for row in plan['families']]]:
        key = binding['id']; binding_ids.add(key)
        if (key not in public_records or key not in discovery
                or projection_fingerprint(public_records[key]) != binding['projection_sha256']
                or discovery_fingerprint(discovery[key]) != binding['discovery_sha256']):
            raise ValueError('Variant public projection or discovery changed; review must be updated')
    records, facets = dict(public_records), deepcopy(discovery)
    lineage, sources, assigned = {}, {}, set()
    for family in plan['families']:
        parent = family['source_id']; base = present_technical(public_records[parent])
        for reference in family['tables']:
            table = _bound_table(base, reference['field'], reference['table_index'])
            if source_fingerprint(table) != reference['sha256']:
                raise ValueError('Bound variant table changed')
        for replacement in sorted(family['reviewed_tables'], key=lambda row: (row['field'], row['table_index'])):
            matching = [field for field in base.get('fields', []) if field['label'] == replacement['field']]
            if not matching:
                base.setdefault('fields', []).append({'label': replacement['field'], 'value': ''})
            field = _field(base, replacement['field']); tables = field_tables(field)
            index = replacement['table_index']
            if source_fingerprint(_bound_table(base, replacement['field'], index)) != replacement['source_table_sha256']:
                raise ValueError('Reviewed replacement has another source table')
            inventories = field.get('table_row_ids', [[source_fingerprint([index, row]) for index, row in enumerate(table['rows'])] for table in tables])
            if index == len(tables):
                tables.append(deepcopy(replacement['table'])); inventories.append(list(replacement['row_ids']))
                if 'table_captions' in field:
                    field['table_captions'].append('Reviewed source configuration')
            else:
                tables[index] = deepcopy(replacement['table']); inventories[index] = list(replacement['row_ids'])
            field.pop('table', None); field.pop('tables', None)
            field['table'] = tables[0]
            if len(tables) > 1:
                field['tables'] = tables[1:]
            field['table_row_ids'] = inventories
        for variant in family['variants']:
            key = variant['existing_id'] or variant_id(parent, variant['key'])
            if variant['existing_id'] is not None and (key not in binding_ids or key not in public_records):
                raise ValueError('Existing variant target must be a bound current record')
            if key in assigned or (key in public_records and key not in binding_ids):
                raise ValueError('Variant ID collision or unbound existing target')
            assigned.add(key)
            item = deepcopy(base); _scope(item, variant['selections'])
            selected_ratings = set()
            for selection in variant['selections']:
                table = field_tables(_field(base, selection['field']))[selection['table_index']]
                columns = selection['columns'] if selection['columns'] is not None else list(range(len(table['columns'])))
                rows = [selection['row_index']] if 'row_index' in selection else selection['row_indices']
                for column in columns:
                    if re.search(r'\bfrl\b', table['columns'][column], re.I):
                        for row in rows:
                            if row >= len(table['rows']):
                                raise ValueError('Selected variant row is unavailable')
                            selected_ratings.update(canonical_frl(value) for value in re.findall(r'(?:-|\d+)\s*/\s*(?:-|\d+)\s*/\s*(?:-|\d+)', table['rows'][row][column]))
            if not selected_ratings:
                for field in base.get('fields', []):
                    if field['label'] in ('FRL', 'Blank Seal FRL'):
                        selected_ratings.update(canonical_frl(value) for value in re.findall(r'(?:-|\d+)\s*/\s*(?:-|\d+)\s*/\s*(?:-|\d+)', field['value']))
                        if field['value'] in ('N/A', 'Not specified'):
                            selected_ratings.add(field['value'])
            if variant['facets']['frl'][0] not in selected_ratings:
                raise ValueError('Assigned variant FRL is absent from the selected source configuration')
            for label, value in variant['fields'].items():
                matching = [field for field in item.get('fields', []) if field['label'] == label]
                if len(matching) > 1:
                    raise ValueError('Variant scalar field is ambiguous')
                if matching:
                    matching[0]['value'] = value
                else:
                    item.setdefault('fields', []).append({'label': label, 'value': value})
            own_facets = {**deepcopy(discovery[parent]), **deepcopy(variant['facets'])}
            if set(own_facets['category']) - (set(CATEGORIES) | set(discovery[parent].get('category', []))):
                raise ValueError('Unapproved variant Category')
            if set(own_facets['services']) - (set(TECHNICAL_SERVICES) | set(discovery[parent].get('services', []))):
                raise ValueError('Unapproved variant Services')
            if set(own_facets['category']) & MOVED_SERVICE_CATEGORIES and own_facets['services'] != ['N/A']:
                raise ValueError('Non-service categories require N/A')
            if not any(field['label'] in ('FRL', 'Blank Seal FRL') and field['value'] == own_facets['frl'][0] for field in item['fields']):
                raise ValueError('Variant scalar FRL must equal its one assigned FRL')
            item['filter_values'] = {**item.get('filter_values', {}), **deepcopy(own_facets)}
            if key not in source_records:
                identity_fields = [field for field in item['fields'] if field['label'] == 'ID']
                if identity_fields:
                    identity_fields[0]['value'] = key
                else:
                    item['fields'].insert(0, {'label': 'ID', 'value': key})
            item['title'] = technical_title(item)
            details = {field['label']: field['value'] for field in item['fields']}
            selected_summary = []
            for label in ('Barrier Construction', 'Service Size / Configuration'):
                value = details.get(label, '').strip().split('\n', 1)[0]
                if value:
                    selected_summary.append(value if len(value) <= 140 else value[:137] + '…')
            item['subtitle'] = ' · '.join([*selected_summary, own_facets['frl'][0]])
            if key in public_records and key != parent and technical_signature(item, own_facets, assets) != technical_signature(public_records[key], discovery[key], assets):
                raise ValueError('Existing target does not match the complete variant facts')
            if key in public_records and key != parent:
                # An already-matching record keeps its own documents/images and
                # source identity instead of receiving another parent's copy.
                item = deepcopy(public_records[key])
                own_facets = deepcopy(discovery[key])
            item['id'] = key
            record_hash = source_fingerprint([item, own_facets])
            lineage[key] = {'parent_id': parent, 'parent_sha256': family['item_sha256'],
                            'variant_key': variant['key'], 'variant_sha256': record_hash}
            if key not in source_records:
                sources[key] = {'id': key, 'sources': deepcopy(source_records[parent].get('sources', [])),
                                'variant_source': deepcopy(lineage[key])}
            records[key], facets[key] = item, own_facets
    aliases, groups = {}, {}
    allowed = binding_ids | assigned
    for alias in plan['aliases']:
        left, right = alias['alias_id'], alias['canonical_id']
        if left not in allowed or right not in allowed or left in aliases:
            raise ValueError('Unbound or repeated variant alias')
        if technical_signature(records[left], facets[left], assets) != technical_signature(records[right], facets[right], assets):
            raise ValueError('Variant aliases have different technical facts or assignments')
        aliases[left] = right
    if any(value in aliases for value in aliases.values()):
        raise ValueError('Variant aliases must resolve directly without cycles or chains')
    for alias, canonical in aliases.items():
        members = groups.setdefault(canonical, [canonical]); members.append(alias)
    return Projection(records, facets, lineage, sources, aliases, groups)
