"""Publish assessment-backed barrier alternatives using the Technical Library's existing fields."""
from copy import deepcopy

from scripts.snap_variant_identity import variant_record_id


TABLE_32 = {
    'label': 'FCO3520 Rev D, Table 32, PVC pipe with coupling, page 25',
    'url': 'https://docs.snapcollars.com.au/FCO3520-Rev-D-LF.pdf#page=25',
}
WALL_SIZES = (40, 50, 65, 80, 90, 100)


def fields_by_label(record):
    return {f['label']: f['value'] for f in record['fields']}


def wall_amendments(rows, entries):
    """Table 32 has independent thresholds for concrete, masonry and AAC."""
    updates = {}
    for offset, size in enumerate(WALL_SIZES):
        masonry_id, concrete_id = 821 + offset, 755 + offset
        for sid, masonry in ((masonry_id, True), (concrete_id, False)):
            row = rows[sid]
            service = 'PVC-DWV (SC)' if size == 100 else 'PVC-DWV'
            initial_element = 'Concrete or Masonry Wall (130mm)' if masonry else 'Concrete Wall (120mm)'
            if (row['report_name'], row['nominal_size'], row['service_name'], row['fitting_allowed'],
                    row['element_name'], row['product_generic_code']) != (
                    'FCO3520', f'{size} mm', service, 'Yes', initial_element, f'UC{size}+'):
                raise ValueError(f'SNAP {sid} no longer matches the reviewed Table 32 configuration.')
            record = entries[sid]['record']
            fields = fields_by_label(record)
            details = fields['Installation Details'].split('\n\n')
            issues = fields.get('Source Issues', '').split('\n\n')
            if masonry:
                # Remove the exact comparison for the combined selector row.
                comparison = (record['summary'] if sid == 821 else
                              f'SNAP lists {row["frl"]} for this row and specifies an effective FRL of -/120/120.')
                if (not comparison.startswith('SNAP lists ') or comparison not in details
                        or (sid == 821 and comparison not in issues)):
                    raise ValueError(f'Unexpected historical rating text for SNAP {sid}.')
                details.remove(comparison)
                if comparison in issues:
                    issues.remove(comparison)
            updates[sid] = {
                'element': 'Masonry Wall (minimum 130 mm)' if masonry else 'Concrete Wall (minimum 120 mm)',
                'frl': ('-/180/180' if size == 40 else '-/180/120') if masonry else '-/120/120',
                'install': '\n\n'.join(details), 'source_issues': '\n\n'.join(issues),
                'sources': [TABLE_32],
            }
    return updates


def apply_configuration(record, spec):
    fields = {f['label']: f for f in record['fields']}
    old_element = fields['Barrier Construction']['value']
    old_frl = fields['FRL']['value']
    suffix = f' — {old_element} — {old_frl}'
    if not record['title'].endswith(suffix):
        raise ValueError(f'Unexpected configuration in title for {record["id"]}.')
    element = spec.get('element', old_element)
    rating = spec.get('frl', old_frl)
    record['title'] = record['title'].removesuffix(suffix) + f' — {element} — {rating}'
    record['filter_values']['frl'] = [rating]
    fields['Barrier Construction']['value'] = element
    fields['FRL']['value'] = rating
    fields['Installation Details']['value'] = spec['install']
    if spec['source_issues']:
        if 'Source Issues' in fields:
            fields['Source Issues']['value'] = spec['source_issues']
        else:
            record['fields'].append({'label': 'Source Issues', 'value': spec['source_issues']})
    elif 'Source Issues' in fields:
        record['fields'].remove(fields['Source Issues'])
    for ref in spec['sources']:
        if all(s['url'] != ref['url'] for s in record['sources']):
            record['sources'].append(dict(ref))
    if record['summary'].startswith(('Effective FRL ', 'SNAP lists ')):
        record['summary'] = ''


def replace_guide_figure(child, donor, caption):
    # Use the component crop on the product's own guide page, with the ring size
    # for this assembly. The full page also depicts an inapplicable screed detail.
    if len(child['drawings']) != 1 or len(donor['drawings']) != 1 or not caption:
        raise ValueError('Expected a single reviewed guide figure and caption.')
    old, crop = child['drawings'][0], donor['drawings'][0]
    source = next(s for s in child['record']['sources'] if s['label'] == old['caption'])
    crop_source = next(s for s in donor['record']['sources'] if s['label'] == crop['caption'])
    if (source['url'] != crop_source['url'] or not crop['path'].startswith('guide-drawings/')
            or not old['path'].startswith('guide-drawings/')):
        raise ValueError('Replacement crop must come from the same product guide and page.')
    child['drawings'] = [{**crop, 'caption': caption}]
    source['label'] = caption


def assessed_manifest(rows, entries, amendments, variants):
    """Leave parent identities and illustrations stable; distinguish children from selector rows."""
    changed, additions, children = [], [], []
    for sid, spec in sorted(amendments.items()):
        record = entries[sid]['record']
        before = deepcopy(record)
        apply_configuration(record, spec)
        if before != record:
            changed.append(record['id'])
    for spec in sorted(variants, key=lambda s: (s['parent_sid'], s['variant_key'])):
        sid, slug = spec['parent_sid'], spec['variant_key']
        child = deepcopy(entries[sid])
        if donor := spec.get('drawing_parent_sid'):
            replace_guide_figure(child, entries[donor], spec['drawing_caption'])
        record = child['record']
        apply_configuration(record, spec)
        record['id'] = variant_record_id(sid, slug)
        next(f for f in record['fields'] if f['label'] == 'ID')['value'] = f'SNAP {sid} / {slug}'
        record['subtitle'] = f'Assessed variation of SNAP system {sid} · {rows[sid]["application_name"]} · {rows[sid]["report_name"]}'
        additions.append({'parent_system_id': sid, 'variant_key': slug, 'record_id': record['id'],
                          'evidence_urls': [ref['url'] for ref in spec['sources']]})
        children.append(child)
    return {'systems': [*entries.values(), *children],
            'variant_review': {'updated_record_ids': changed, 'additions': additions}}
