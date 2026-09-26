"""Build a local Promat Selector import using the existing library vocabulary.

Supplier data never belongs in Git. This tool accepts an extracted, checksum-
verified public-selector export and an existing bundle, and writes a separate
candidate. Installing it is a separate, validated operation with a backup.
"""

from collections import defaultdict
from copy import deepcopy
import argparse
import gzip
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from estimator.reference_library import ReferenceLibrary, MAX_INDEX
from estimator.technical_fields import FIELD_ORDER, normalize_technical_item
from estimator.technical_field_reviewed import review_fingerprint

SECTIONS = ('product_details', 'specifications', 'installation_details')
LABELS = {'Fire protection product', 'Service part', 'PI number',
          'Fire rating performance', 'Diameter', 'Compartment type',
          'Service installation', 'Fire rating direction', 'Service type', '',
          'Service details', 'Insulation (in place)', 'Joint details',
          'Report number', 'Test standard', 'Annular gap',
          'Insulation (to be installed)', 'Aperture part', 'Minimum suspension'}
CONFIG = 'Service Size / Configuration'
BARRIER = 'Barrier Construction'


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def clean(value):
    """Whitespace and escaped title markup only; never invent technical symbols."""
    value = html.unescape(value)
    value = re.sub(r'</?a\b[^>]*>', '', value, flags=re.I)
    return re.sub(r'\s+', ' ', value).strip()


def unique(values):
    return list(dict.fromkeys(value for value in values if value))


def joined(values):
    return '\n\n'.join(unique(values))


def values(system, label, section=None):
    return unique(clean(f['value']) for f in system[section] if f['label'] == label) if section else unique(
        clean(f['value']) for f in system['fields'] if f['label'] == label)


def one(system, label, section=None):
    vals = values(system, label, section)
    if len(vals) > 1:
        raise ValueError(f"Conflicting {label} in {system['id']}: {vals}")
    return vals[0] if vals else ''


def relation_key(value):
    return re.sub(r'\s+', ' ', value.replace('Location: ', '')).strip().casefold()


def most_specific(values_):
    """Drop exact duplicates and complete comma-clause prefixes, not facts."""
    result = []
    for value in unique(values_):
        key = relation_key(value)
        if any(relation_key(other).startswith(key + ', ') for other in values_ if other != value):
            continue
        if key not in [relation_key(x) for x in result]:
            result.append(value)
    return result


def wrap_text(value):
    parts = [part.strip().lstrip(':').strip() for part in value.split(',')]
    product = next((p for p in parts if not p.startswith(('Configuration:', 'Class:', 'Thickness:'))), '')
    parts = [p for p in parts if not (p.startswith('Class:') and p[6:].strip() == product)]
    # Repeated trailing source descriptions (including a location prefix).
    result = []
    for part in parts:
        # Some location clauses repeat the product name after their scope.
        # Keep the location/length and the single product heading.
        if product and part != product and part.endswith(' ' + product):
            part = part[:-len(product)].strip()
        if part and not any(part == old or old.endswith(' ' + part) for old in result):
            result.append(part)
    return '; '.join(result)


def direction(system):
    # Service orientation after the dash is NOT the barrier orientation.
    text = one(system, 'Service details')
    match = re.search(r'\b(Wall|Floor|Ceiling)\s*-', text, re.I)
    if match:
        return match[1].title()
    text = one(system, 'Fire rating direction')
    match = re.match(r'(Wall|Floor|Ceiling)\b', text, re.I)
    if not match:
        raise ValueError(f"No explicit barrier direction for {system['id']}")
    return match[1].title()


def summarize_frl(vals):
    vals = unique(vals)
    parsed = [re.fullmatch(r'(-|\d+)/(-|\d+)/(-|\d+)', value) for value in vals]
    if not vals or not all(parsed):
        return joined(vals)
    tuples = [tuple(-1 if p == '-' else int(p) for p in match.groups()) for match in parsed]
    if len({tuple(p == -1 for p in row) for row in tuples}) != 1:
        return joined(vals)
    order = sorted(zip(tuples, vals))
    if not all(all(a <= b for a, b in zip(left[0], right[0])) for left, right in zip(order, order[1:])):
        return joined(vals)
    return order[0][1] if len(vals) == 1 else f'{order[0][1]} to {order[-1][1]}'


def maximum_opening(vals):
    vals = unique(vals)
    if len(vals) <= 1:
        return joined(vals)
    # Only comparable circular openings. Do not invent maxima for rectangles,
    # area-limited strips, infinite widths or differently oriented openings.
    matches = [re.fullmatch(r'ø\s*(\d+(?:\.\d+)?)\s*mm', v, re.I) for v in vals]
    return max(zip(matches, vals), key=lambda x: float(x[0][1]))[1] if all(matches) else ''


def map_variant(system):
    unknown = {f['label'] for f in system['fields']} - LABELS
    if unknown or system.get('tables') or len(system['installation_groups']) != 1:
        raise ValueError(f"Unreviewed source structure {system['id']}: {unknown}")
    row = {}
    row['ID'] = system['id']
    row['System Products'] = one(system, 'Fire protection product')
    row['Service'] = one(system, 'Service installation')
    blank = row['Service'] == 'None, None'
    row['Service'] = 'None' if blank else row['Service']
    row['Installation Type'] = 'Blank seal' if blank else 'Service penetration'
    row['Barrier Type'] = direction(system)
    row[BARRIER] = one(system, 'Compartment type')
    if values(system, '') != [row[BARRIER]]:
        raise ValueError(f"Unlabelled source field changed in {system['id']}")
    row['Blank Seal FRL' if blank else 'FRL'] = one(system, 'Fire rating performance')

    service = one(system, 'Service type')
    general = row['Service'].split(',')[0]
    if service.startswith(general + ' '):
        service = service[len(general):].strip()
    materials = [x.strip() for x in row['Service'].split(',')[1:]]
    service = ', '.join(p.strip() for p in service.split(',') if p.strip() not in materials)
    detail = one(system, 'Service details')
    diam = one(system, 'Diameter')
    # Identical diameter repeated in service type and detail: keep it once.
    match = re.match(r'ø\s*([^,]+),\s*(.*)', detail)
    if match and (re.search(r'(?<![\w.])' + re.escape(match[1].strip()) + r'\s*mm\b', service) or match[1] == 'N/A'):
        detail = match[2]
    size = [service if service != 'None' else '', detail]
    if diam and diam not in {'N/A', 'Not applicable'} and not any(re.search(r'(?<![\w.])' + re.escape(diam) + r'(?![\w.])', v) for v in size):
        size.append('Diameter: ' + diam)
    insulation = one(system, 'Insulation (in place)')
    if insulation:
        size.append('Existing insulation: ' + ('None' if insulation == 'None None' else insulation))
    row[CONFIG] = joined(size) if not blank else ''

    install = []
    firing = one(system, 'Fire rating direction')
    if firing:
        install.append('Fire exposure: ' + firing + '.')
    standards = values(system, 'Test standard')
    if standards:
        install.append('Test standard: ' + ', '.join(standards) + '.')
    suspension = one(system, 'Minimum suspension')
    if suspension:
        install.append('Minimum suspension: ' + suspension + '.')
    report = one(system, 'Report number')
    issues = []
    if report.startswith('Test standard '):
        standard = report.removeprefix('Test standard ')
        if standard not in standards:
            install.append('Test standard: ' + standard + '.')
        report = ''
        issues.append('The publisher report field contains a test standard rather than a report number; no report number is stated.')
    row['Report Number'] = report
    collar = one(system, 'Service part', 'product_details')
    row['Collar'] = collar
    part_values = most_specific(values(system, 'Service part') + values(system, 'Joint details'))
    if collar:
        part_values = [value[len(collar):].lstrip(', ') if value == collar or value.startswith(collar + ', ') else value for value in part_values]
    # These are whole installation clauses; preserve the complete requirement.
    seals = [v for v in part_values if re.search(r'\b(?:depth|fillet|flush finish)', v, re.I)]
    row['Seal Depth / Fillet Size'] = joined(seals)
    install.extend(value for value in part_values if value not in seals)
    row['Installation Details'] = joined(install)
    aperture = most_specific(values(system, 'Aperture part'))
    barrier_additions, openings = [], []
    for part in aperture:
        pieces = part.split(', Max. opening: ', 1)
        barrier_additions.append(pieces[0])
        if len(pieces) == 2:
            openings.append(pieces[1])
    if barrier_additions:
        row[BARRIER] = joined([row[BARRIER], 'Aperture seal: ' + joined(barrier_additions)])
    gaps = values(system, 'Annular gap')
    gap_values = []
    for gap in gaps:
        # Keep sealing instructions with the annular gap unless explicitly split.
        gap = re.sub(r',?\s*Max Aperture\s*(ø:[^,]+)', lambda m: openings.append(m[1].replace('ø:', 'ø ')) or '', gap)
        if gap.strip():
            gap_values.append(gap.strip().rstrip(','))
    row['Annular Gap'] = joined(gap_values)
    row['Maximum Opening Size'] = joined(openings)
    wraps, protection = [], []
    for value in values(system, 'Insulation (to be installed)'):
        target = protection if ('FRPB' in value or 'PROMASHIELD' in value) else wraps
        target.append(wrap_text(value))
    row['Service Wrap'], row['Local Protection'] = joined(wraps), joined(protection)
    for flag in system.get('source_quality_flags', []):
        if flag['code'] == 'unrecognized_gt_element_in_publisher_html':
            issues.append('The publisher wrap text contains an unrecognised <gt/> element. The comparison symbol is unresolved; verify the wrap length against the approval.')
        elif flag['code'] == 'malformed_publisher_report_link':
            issues.append('The publisher report link is malformed; the captured link is retained in the source evidence.')
        elif flag['code'] not in {'no_published_source_diagram', 'html_markup_in_publisher_catalogue_title'}:
            raise ValueError('Unreviewed publisher source issue: ' + flag['code'])
    row['Source Issues'] = joined(issues)
    return {key: value for key, value in row.items() if value}


def group_key(system, row):
    # No cross-report/revision, service family, exposure or diagram mixing.
    # Unknown report identity cannot establish a common approval.
    return (row.get('Report Number') or system['id'], row['System Products'], row['Service'],
            row['Barrier Type'], one(system, 'Fire rating direction'),
            tuple(sorted({i['sha256'] for i in system['source_diagrams']})))


def make_entry(members):
    systems, rows = zip(*members)
    key = group_key(systems[0], rows[0])
    item_id = 'promat-' + review_fingerprint(key)[:24]
    common, varying, shared_parts = {}, [], {}
    all_labels = [label for label in FIELD_ORDER if any(label in row for row in rows)]
    for label in all_labels:
        vals = {row.get(label, '') for row in rows}
        if len(vals) == 1:
            common[label] = next(iter(vals))
        else:
            varying.append(label)
            if label not in {'ID', 'FRL', 'Blank Seal FRL', 'Maximum Opening Size'}:
                parts = [row.get(label, '').split('\n\n') for row in rows]
                shared_parts[label] = [p for p in parts[0] if p and all(p in other for other in parts[1:])]
    table_field = BARRIER if rows[0]['Installation Type'] == 'Blank seal' else CONFIG
    fields = [{'label': 'Manufacturer', 'value': 'Promat'}]
    common.pop('ID', None)
    if len(rows) == 1:
        fields += [{'label': 'ID', 'value': rows[0]['ID']}]
    else:
        fields += [{'label': 'ID', 'value': rows[0]['ID'] + f' (+{len(rows)-1} variants listed below)'}]
    for label in all_labels:
        if label == 'ID':
            continue
        if label in common:
            fields.append({'label': label, 'value': common[label]})
        elif label != table_field:
            summary = summarize_frl([row.get(label, '') for row in rows]) if label in {'FRL', 'Blank Seal FRL'} else (
                maximum_opening([row.get(label, '') for row in rows]) if label == 'Maximum Opening Size' else joined(shared_parts.get(label, [])))
            fields.append({'label': label, 'value': summary, 'table_links': [{'field': table_field, 'table_index': 0}]})
    if len(rows) > 1:
        target = next((f for f in fields if f['label'] == table_field), None)
        if target is None:
            target = {'label': table_field, 'value': joined(shared_parts.get(table_field, []))}
            fields.append(target)
        columns = ['ID'] + [v for v in varying if v != 'ID']
        target['table'] = {'columns': columns, 'rows': [[
            '\n'.join(p for p in row.get(c, '').split('\n\n') if p not in shared_parts.get(c, []))
            for c in columns] for row in rows]}
        target['table_row_ids'] = [[s['id'] for s in systems]]
    image_refs = [{'id': 'promat-image-' + sha[:24], 'caption': ''} for sha in key[-1]]
    if image_refs:
        fields.append({'label': 'Diagrams & Figures', 'value': '', 'images': image_refs})
    report = rows[0].get('Report Number', '')
    sources = [{'label': f'Promat Australian Selector — {report or "report number not stated"} — captured 26 September 2026',
                'filename': 'promat_systems.json'}]
    service_title = 'Blank seal' if rows[0]['Installation Type'] == 'Blank seal' else rows[0]['Service']
    item = {'id': item_id, 'title': rows[0]['System Products'] + ' — ' + service_title,
            'subtitle': ' · '.join(x for x in [report, rows[0]['Barrier Type'], f'{len(rows)} selector variants'] if x),
            'summary': common.get(BARRIER, ''), 'source_label': 'Promat Australian Selector',
            'fields': fields, 'sources': sources,
            'filter_values': {'manufacturer': ['Promat'], 'document': [report] if report else [],
                              'orientation': ['Vertical' if rows[0]['Barrier Type'] == 'Wall' else 'Horizontal']},
            'promat_source': {'variant_ids': [s['id'] for s in systems],
                'pages': [{'id': s['id'], 'url': s['source_url'], 'sha256': s['source_sha256'],
                           'diagrams': [i['sha256'] for i in s['source_diagrams']],
                           'documents': [{'label': d['label'], 'url': d['source_url']} for d in s['documents']]} for s in systems]}}
    if not image_refs:
        item['diagram_status'] = 'The selector does not publish a source diagram for these variants.'
    return item


def verify_export(root):
    root = Path(root).resolve()
    checked = 0
    for line in (root / 'checksums.sha256').read_text(encoding='utf-8').splitlines():
        expected, name = line.split('  ', 1)
        path = (root / name).resolve()
        if not path.is_relative_to(root) or digest(path) != expected:
            raise ValueError('Export checksum mismatch: ' + name)
        checked += 1
    return checked


def build(export, base, output, audit):
    export, base, output, audit = map(Path, (export, base, output, audit))
    export, base, output, audit = (p.resolve() for p in (export, base, output, audit))
    if any(output == p or output.is_relative_to(p) or p.is_relative_to(output) for p in (export, base)):
        raise ValueError('Candidate must be separate from the export and installed bundle.')
    if output.exists():
        raise ValueError('Choose a new candidate directory.')
    verified = verify_export(export)
    data = json.loads((export / 'promat_systems.json').read_text(encoding='utf-8'))
    if data.get('schema_version') != 'promat.public-selector.export.v1':
        raise ValueError('Unsupported Promat export schema.')
    systems = data['systems']
    if len(systems) != data['system_count'] or len({s['id'] for s in systems}) != len(systems):
        raise ValueError('Incomplete or duplicate source systems.')
    bundle = json.loads((base / 'library.json').read_text(encoding='utf-8'))
    if any(i['id'].startswith('promat-') for i in bundle['libraries']['technical']['items']):
        raise ValueError('Promat already imported; review update identities before replacement.')
    groups = defaultdict(list)
    mapped = []
    raw_field_count = 0
    for s in systems:
        if s.get('schema_version') != 'promat.public-selector.detail.v1' or s.get('language') != 'en-AU':
            raise ValueError('Unsupported Promat system schema or market.')
        if one(s, 'PI number') != s['id']:
            raise ValueError('Source variant identity disagrees with PI number.')
        path = (export / s['source_html_file']).resolve()
        if not path.is_relative_to(export.resolve()):
            raise ValueError('Invalid source path.')
        with gzip.open(path, 'rb') as stream:
            if hashlib.sha256(stream.read()).hexdigest() != s['source_sha256']:
                raise ValueError('Source HTML changed: ' + s['id'])
        if s['fields'] != [f for section in SECTIONS for f in s[section]]:
            raise ValueError('Source fields do not match sections.')
        row = map_variant(s)
        groups[group_key(s, row)].append((s, row))
        mapped.append({'id': s['id'], 'source_fields': [
            {'section': f['section_path'], 'label': f['label'], 'value': f['value']} for f in s['fields']], 'mapped': row})
        raw_field_count += len(s['fields'])
    entries = [make_entry(members) for members in groups.values()]
    # Bind reviewed canonical fields to the existing projection contract. It
    # prevents legacy Firefly content heuristics from splitting Promat rows.
    from unittest.mock import patch
    for item in entries:
        fields = deepcopy(item['fields'])
        captured = []
        def capture(pre, review=None, source_fields=None):
            captured.append(deepcopy(pre))
            return pre
        with patch('estimator.technical_fields.normalize_reviewed_content', capture):
            normalize_technical_item(item)
        item['technical_field_review'] = {'source_fields_sha256': review_fingerprint(fields),
            'pre_review_fields_sha256': review_fingerprint(captured[0]), 'fields': fields}
    bundle['libraries']['technical']['items'].extend(entries)
    # Keep full source capture outside the served index; preserve its identity
    # and every source URL / association in the private provenance manifest.
    bundle['promat_selector_import'] = {'schema_version': 1, 'source_sha256': digest(export / 'promat_systems.json'),
        'source_url': data['source_url'], 'captured_at': data['extracted_at_utc'],
        'variants': len(systems), 'entries': len(entries), 'source_field_count': raw_field_count,
        'publisher_notice': systems[0]['notice']}
    output.mkdir(parents=True)
    for directory in ('documents', 'images'):
        shutil.copytree(base / directory, output / directory)
    seen = set()
    for s in systems:
        for image in s['source_diagrams']:
            sha = image['sha256']
            if sha in seen:
                continue
            seen.add(sha)
            path = (export / image['local_file']).resolve()
            if not path.is_relative_to(export.resolve()) or digest(path) != sha:
                raise ValueError('Diagram changed.')
            asset_id = 'promat-image-' + sha[:24]
            extension = path.suffix
            bundle['images'].append({'id': asset_id, 'filename': path.name, 'sha256': sha, 'extension': extension})
            shutil.copyfile(path, output / 'images' / (asset_id + extension))
    payload = compact(bundle).encode('utf-8')
    if len(payload) >= MAX_INDEX:
        raise ValueError('Candidate exceeds the existing library index size limit.')
    (output / 'library.json').write_bytes(payload)
    library = ReferenceLibrary(output)
    summary = library.overview()
    # Projection must preserve every table cell and link; compare full fields
    # ignoring only the runtime-added source_labels metadata and field ordering.
    for item in entries:
        actual = {f['label']: {k: v for k, v in f.items() if k != 'source_labels'} for f in library.detail('technical', item['id'])['fields']}
        expected = {f['label']: f for f in item['technical_field_review']['fields']}
        # Image roles/captions may be added by presentation, so verify tables
        # and text independently from the attached source-image inventory.
        for label, field in expected.items():
            for key in ('value', 'table', 'table_links', 'table_row_ids'):
                if field.get(key) != actual.get(label, {}).get(key):
                    raise ValueError(f'Projection altered {item["id"]} {label} {key}')
    audit.mkdir(parents=True, exist_ok=True)
    (audit / 'field-mapping.json').write_text(compact(mapped), encoding='utf-8')
    (audit / 'variant-entry-map.json').write_text(compact({v: i['id'] for i in entries for v in i['promat_source']['variant_ids']}), encoding='utf-8')
    receipt = {'verified_export_files': verified, 'variants': len(systems), 'entries': len(entries),
               'source_fields': raw_field_count, 'images': len(seen), 'index_bytes': len(payload),
               'base_sha256': digest(base / 'library.json'), 'candidate_sha256': digest(output / 'library.json'),
               'library_summary': summary}
    (audit / 'build-receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', type=Path)
    parser.add_argument('base', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--audit', type=Path, required=True)
    args = parser.parse_args()
    build(args.export, args.base, args.output, args.audit)


if __name__ == '__main__':
    main()
