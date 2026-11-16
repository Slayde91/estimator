"""Map the reviewed SNAP Product Filter capture to existing Technical Library fields."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid5


EXCLUDED = {4110, 4112, 3767, 4033}  # Reviewed discrepancies with FAR3932, FSP2097 and FSP2289.
FILTER_URL = 'https://www.snapcollars.com.au/product-filter'
SOURCE_LABEL = 'Snap Fire Systems product filter'
RATING = r'-/\d+/\d+'
SERVICE_GROUPS = {
    'C-PVC': 'CPVC pipe', 'HDPE': 'HDPE pipe', 'HDPE Geberit SuperTube': 'HDPE pipe',
    'HDPE Silent': 'HDPE pipe', 'PE100 SDR 7.4': 'HDPE pipe', 'PE100 SDR 11': 'HDPE pipe',
    '+GF+ Cool-Fit 2.0': 'HDPE pipe', '+GF+ Progef PP-H': 'PP pipe',
    'PPR-80 SDR7.4 Faser Composite': 'PP pipe', 'Triplus': 'PP pipe', 'WAVIN Astolan': 'PP pipe',
    'Pex-A': 'PEX pipe', 'Pex-B': 'PEX pipe', 'dBlue': 'dBlue pipe',
    'Raupiano': 'Raupiano Plus pipe',
    'Beer Python': 'Beverage / Beer Lines', 'Fast Flow psPipe': 'uPVC pipe',
    'PVC-DWV': 'uPVC pipe', 'PVC-DWV (SC)': 'uPVC pipe',
    'PVC-PN12': 'uPVC pipe', 'PVC-PN18': 'uPVC pipe', 'PVC-Stormwater': 'uPVC pipe',
}
# Group search results by barrier material, preserving the full named assembly in each item.
SUBSTRATES = (
    ('PB Wall', 'Plasterboard wall'), ('Shaft Liner', 'Plasterboard wall'),
    ('PB Ceiling/Floor', 'Plasterboard ceiling'), ('Concrete Beam', 'Concrete beam'),
    ('Concrete Slab', 'Concrete/masonry floor'), ('Bondek Slab', 'Bondek floor'),
    ('Concrete or Masonry Wall', 'Concrete/masonry wall'), ('Concrete Wall', 'Concrete/masonry wall'),
    ('Hebel', 'Hebel wall'), ('Dincel Wall', 'Dincel wall'), ('AFS ', 'AFS wall'),
    ('Speedpanel Wall', 'Speedpanel wall'), ('AAC Block Wall', 'AAC block wall'),
    ('Walsc Inter-Tenancy Wall', 'Walsc inter-tenancy wall'), ('Firecrunch Wall', 'Firecrunch wall'),
    ('Multiboard Wall', 'Multiboard wall'), ('Maxilite Wall', 'Maxilite wall'),
    ('SlimDek 210 Slab', 'SlimDek floor'), ('Condeck Slab', 'Condeck floor'),
)


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def by_id(rows):
    indexed = {r['system_id']: r for r in rows}
    if len(indexed) != len(rows) or any(type(key) is not int or key <= 0 for key in indexed):
        raise ValueError('Missing or duplicate SNAP system identity.')
    return indexed


def build_entry(row, assoc, product, screenshots, guide, guide_titles):
    sid = row['system_id']
    code, service, size = row['product_generic_code'], row['service_name'].strip(), row['nominal_size']
    application, element, listed = row['application_name'], row['element_name'], row['frl']
    report, status = row['report_name'], row['report_publish_status']
    if ((code, report, status) != (assoc['product_code'], assoc['report_name'], assoc['report_status'])
            or product['product_url'] != assoc['product_url'] or assoc['source_url'] != FILTER_URL
            or (status == 'Public') != bool(assoc['report_url']) or status not in {'Public', 'On Request'}
            or not re.fullmatch(RATING, listed) or row['fitting_allowed'] not in {'Yes', 'No'}):
        raise ValueError(f'Inconsistent captured source metadata for system {sid}.')
    notes = [n['notes'].strip() for n in row['note'] or [] if n['notes'].strip()]
    effective = listed
    conditions = []
    for note in notes:
        if m := re.fullmatch(r'The effective FRL of this system is (' + RATING + r')\.?', note):
            effective = m[1]
        else:
            conditions.append(note)
    install = product.get('installation_by_system', {}).get(str(sid)) or product['installation_by_application'][application]
    issues = [*product.get('source_issues', []), *product.get('source_issues_by_system', {}).get(str(sid), [])]
    details = [install]
    if effective != listed:
        details.append(f'SNAP lists {listed} for this row and specifies an effective FRL of {effective}.')
    details.extend(conditions)
    details.extend(issues)
    if status == 'On Request':
        details.append(f'SNAP supplies report {report} on request.')
    is_wall = 'wall' in element.casefold()
    if is_wall != application.startswith('Wall'):
        raise ValueError(f'Review orientation for system {sid}.')
    substrate = next((value for prefix, value in SUBSTRATES if element.startswith(prefix)), None)
    if substrate is None:
        raise ValueError(f'Review new substrate for system {sid}: {element}')
    svc = SERVICE_GROUPS.get(service, service)
    if svc == 'uPVC pipe' and application.startswith('Floor Waste & Shower'):
        svc = 'uPVC floorwaste'
    categories = ['Plumbing & Hydraulic']
    if service == 'Beer Python':
        categories.append('HVAC & Mechanical')
    # Orientation describes the penetrated face. FCO3426 Figure 14 places the
    # collar in the vertical side of the beam, with its axis horizontal.
    orientation = 'Vertical' if is_wall or substrate == 'Concrete beam' else 'Horizontal'
    facets = {'manufacturer': ['Snap'], 'report': [report], 'orientation': [orientation],
              'substrate': [substrate], 'category': categories, 'services': [svc], 'frl': [effective]}
    if application in ('Stack - Cast-in', 'Floor Waste & Shower - Cast-in'):
        facets['type'] = ['Cast-in']
    elif 'Retrofit' in application or 'Gas' in application:
        added_patch = 'PB Patch' in element or 'MGO Board' in element
        facets['type'] = ['Oversized core hole' if added_patch else 'Core hole']

    product_name = product['product_desc']
    if code == 'UC90+' and issues:
        product_name = 'SNAP Utility Collar 90+'
    named_fields = {'ID': f'SNAP {sid}', 'Manufacturer': 'Snap', 'System Products': product_name,
                    'Installation Type': f'{application} ({row["product_type"]})',
                    'Barrier Construction': element, 'Orientation': orientation, 'Substrate': substrate,
                    'Service': service, 'Service Size / Configuration': f'{size}. Fitting allowed: {row["fitting_allowed"]}.',
                    'FRL': effective, 'Installation Details': '\n\n'.join(details)}
    sources = []

    def cite(label, url):
        # Some JSON links contain literal spaces in the original PDF filename.
        encoded = quote(url, safe=':/%+-_.#=')
        if all(s['url'] != encoded for s in sources):
            sources.append({'label': label, 'url': encoded})

    cite(f'SNAP product filter, system {sid}', FILTER_URL)
    cite(f'SNAP product {code}', assoc['product_url'])
    for url in product['guide_urls']:
        cite(guide_titles[url], url)
    if assoc['report_url']:
        cite(report, assoc['report_url'])
    for url in product.get('report_urls_by_system', {}).get(str(sid), []):
        cite(f'SNAP installation reference — {url.rsplit("/", 1)[-1]}', url)
    drawings = []
    if assoc['drawing_url']:
        refs = [(r, f'{code} — SNAP product drawing, page {r["page"]}')
                for r in screenshots[assoc['drawing_url']]]
    elif guide:
        refs = [(guide['render'], guide['caption'])]
    else:
        refs = []
        issues.append(f'SNAP has no verified matching Drawing PDF or installation-guide figure for {code} in this configuration.')
    for render, caption in refs:
        cite(caption, render['url'] + f'#page={render["page"]}')
        drawings.append({'path': render['path'], 'sha256': render['sha256'], 'caption': caption})
    if issues:
        named_fields['Source Issues'] = '\n\n'.join(issues)
    fields = [{'label': k, 'value': v} for k, v in named_fields.items()]
    field = {'label': 'Report Number', 'value': report}
    if assoc['report_url']:
        field['report_links'] = [{'label': report, 'url': quote(assoc['report_url'], safe=':/%+-_.')}]
    fields.append(field)
    title = f'SNAP {code} — {size} {service} — {element} — {effective}'
    subtitle = f'SNAP system {sid} · {application} · {report}'
    summary = f'Effective FRL {effective} (selector lists {listed}).' if effective != listed else ''
    key = 'user-technical-' + uuid5(NAMESPACE_URL, f'Snap Fire Systems AU/system/{sid}').hex
    record = {'id': key, 'title': title, 'subtitle': subtitle, 'summary': summary,
              'source_label': SOURCE_LABEL, 'sources': sources, 'fields': fields,
              'filter_values': facets, 'editable': True}
    return {'record': record, 'drawings': drawings}


def prepare(directory):
    source = directory / 'source'
    rows = by_id(read(source / 'FilterProduct.json')['data']['filterProduct'])
    associations = by_id(read(source / 'system-associations.json'))
    products = read(directory / 'product-research' / 'product-installation.json')
    guide_dir = directory / 'product-research'
    guide_titles = {}
    for path in [*guide_dir.glob('INS-*.json'), guide_dir / 'utility-guide.json']:
        descriptor = read(path)
        guide_titles[descriptor['reportURL']] = descriptor['reportName']
    if (len(rows) != 3568 or rows.keys() != associations.keys()
            or {k for k, r in rows.items() if r['product_generic_code'] == '125C'} != {4110, 4112}
            or (rows[3767]['product_generic_code'], rows[3767]['report_name'],
                rows[3767]['nominal_size']) != ('32R', 'FSP2097', '32 mm')
            or (rows[4033]['report_name'], rows[4033]['element_name']) !=
            ('FSP2289', 'Concrete Slab (150mm) + Ineterpod base (30mm)')):
        raise ValueError('Selector capture or excluded systems changed since review.')
    guide_index = read(source / 'guide-figures.json')
    guides = {int(k): {**g, **guide_index['guides'][g['guide']]} for k, g in guide_index['systems'].items()}
    if not guides.keys() <= rows.keys() - EXCLUDED or any(associations[i]['drawing_url'] for i in guides):
        raise ValueError('Installation guide selections conflict with the source capture.')
    screenshots = {}
    for folder in ('drawings', 'guide-drawings'):
        for render in read(directory / folder / 'renders.json'):
            render['path'] = folder + '/' + render['path']
            screenshots.setdefault(render['url'], []).append(render)
    for sid, g in guides.items():
        if (g['product_code'] != rows[sid]['product_generic_code'] or g['application_name'] != rows[sid]['application_name']
                or {r['pdf_sha256'] for r in screenshots[g['url']]} != {g['sha256']}):
            raise ValueError(f'Guide drawing no longer matches reviewed source for system {sid}.')
    figures = read(directory / 'guide-drawings' / 'figures.json')
    for g in guides.values():
        render = figures[g['image_key']]
        if (render['url'], render['page'], render['pdf_sha256']) != (g['url'], g['page'], g['sha256']):
            raise ValueError(f'Figure does not match the reviewed guide: {g["image_key"]}')
        g['render'] = {**render, 'path': 'guide-drawings/' + render['path']}
    systems = [build_entry(rows[k], associations[k], products[rows[k]['product_generic_code']],
                           screenshots, guides.get(k), guide_titles) for k in sorted(rows.keys() - EXCLUDED)]
    return {'systems': systems}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    manifest = prepare(args.directory)
    output = args.directory / 'manifest.json'
    output.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(len(manifest['systems']), 'systems;', dict(Counter(len(s['drawings']) for s in manifest['systems'])), 'drawings per item')
