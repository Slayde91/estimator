"""FAR3929 Issue 5 rates the complete wall and limits each pipe/collar result to Table 14."""
from scripts.snap_assessed_variations import fields_by_label


REPORT = 'https://docs.snapcollars.com.au/FAR3929-Iss-5.pdf'
PLASTERBOARD = 'PB Wall - 2x16mm each side (128 mm)'
SOLID = 'Concrete or Masonry Wall (128mm)'
REFERENCE = 'Reference plasterboard wall (128 mm, two 16 mm layers each face, independently rated -/120/120)'

# Table 14, p19. Diameters are nominal mm except that 110 mm OD HDPE is
# identified as nominal 100 mm in the assessment summary (test data, Table 1).
# These entries cover the reviewed SNAP selector combinations only.
PVC = {
    ('110R', 100, 'Yes'): 120, ('110R', 100, 'No'): 180, ('110R', 90, 'Yes'): 120,
    ('65-80R', 90, 'No'): 120, ('65-80R', 80, 'Yes'): 120, ('65-80R', 65, 'Yes'): 120,
    ('63R', 65, 'No'): 120, ('63R', 50, 'Yes'): 120, ('50R', 50, 'Yes'): 180,
    ('50R', 50, 'No'): 120, ('50R', 40, 'Yes'): 180,
}
HDPE = {
    ('110R', 110): 120, ('65-80R', 90): 120, ('65-80R', 75): 120,
    ('63R', 63): 120, ('63R', 56): 120, ('63R', 50): 120, ('50R', 56): 120,
    ('50R', 50): 120, ('50R', 40): 180,
}
SDR74 = {'63R': (20, 25, 32, 40, 50, 63), '50R': (20, 25, 32, 40, 50), '32R': (20, 25, 32)}
OLD_HOSTS = ('Use at least 64 mm steel studs, 0.55 mm thick, and two layers of 16 mm fire-rated board per face.',
             'The assessment allows concrete or masonry at least 128 mm thick.')
OLD_FIXING = (' Fit a collar on each wall face using the assessed M6 threaded rod or wall anchor. '
              'Maintain the assessed nominal 1–2 mm pipe-to-opening clearance. ')
OLD_RATINGS = ('SNAP note 40 limits this item to -/120/120.',
               'The tested wall was rated -/120/120. Use -/180/180 only where the wall independently achieves that rating.')
SUPERSEDED = {host + OLD_FIXING + rating + ' See FAR3929 pp2 and 9.' for host in OLD_HOSTS for rating in OLD_RATINGS}
SUPERSEDED.update({
    'SNAP lists -/180/120 for this row and specifies an effective FRL of -/120/120.',
    'All Fire Resistance Levels (FRLs) achieved on framed plasterboard wall systems are applicable to concrete '
    'or masonry walls of equal or greater thickness (AS1530.4: 2014 Section 10.12.2 (c)).  '
    'Accordingly, the test report will reference the PB wall system.',
})


def table_14(row):
    size = int(row['nominal_size'].removesuffix(' mm'))
    code, service, fitting = row['product_generic_code'], row['service_name'], row['fitting_allowed']
    if service in ('PVC-DWV', 'PVC-DWV (SC)'):
        insulation = PVC.get((code, size, fitting))
        if insulation and (service == 'PVC-DWV (SC)') == (size == 100):
            return f'-/180/{insulation}', 19
    if fitting == 'No':
        if service == 'HDPE' and (code, size) in HDPE:
            return f'-/180/{HDPE[code, size]}', 19
        if service in ('PE100 SDR 7.4', 'PPR-80 SDR7.4 Faser Composite') and size in SDR74.get(code, ()):
            page = 20 if service == 'PE100 SDR 7.4' or (code == '32R' and size < 32) else 19
            return '-/180/180', page
    raise ValueError(f'SNAP {row["system_id"]}: no reviewed FAR3929 Table 14 cell matches this service and fitting.')


def wall_spec(fields, solid, wall_minutes, penetration, table_page):
    rating = penetration if wall_minutes == 180 else '-/120/120'
    if solid:
        element = f'Concrete or masonry wall (minimum 128 mm, independently rated -/{wall_minutes}/{wall_minutes})'
        host = (f'Use a concrete or masonry wall at least 128 mm thick with an independent -/{wall_minutes}/{wall_minutes} '
                'rating. FAR3929 section 4 extends the assessed pipe and collar system to these walls.')
    elif wall_minutes == 120:
        element = REFERENCE
        host = ('Use the 128 mm reference plasterboard wall rated -/120/120, with steel studs at least '
                '64 mm × 0.55 mm and two layers of 16 mm fire-rated plasterboard on each face.')
    else:
        element = 'Plasterboard wall (minimum 128 mm, independently rated -/180/180)'
        host = ('Use a plasterboard wall at least 128 mm thick with an independent -/180/180 rating. '
                'Maintain steel studs at least 64 mm × 0.55 mm and two layers of fire-rated plasterboard '
                'at least 16 mm thick per face. Section 4 permits deeper studs and thicker facings.')
    install = (host + ' Fit a collar on each face using the assessed M6 threaded rod or wall anchor. '
               'Maintain the nominal 1–2 mm clearance between the pipe and opening.')
    details = [p for p in fields['Installation Details'].split('\n\n') if p and p not in SUPERSEDED]
    return {'element': element, 'frl': rating, 'install': '\n\n'.join([*details, install]),
            'source_issues': fields.get('Source Issues', ''), 'sources': [
                {'label': 'FAR3929 Issue 5, section 4, wall scope, page 18', 'url': REPORT + '#page=18'},
                {'label': f'FAR3929 Issue 5, Table 14, page {table_page}', 'url': REPORT + f'#page={table_page}'}]}


def plan_rated_wall_variations(rows, entries):
    amendments, variants = {}, []
    for sid, entry in entries.items():
        row = rows[sid]
        if row['report_name'] != 'FAR3929':
            continue
        penetration, page = table_14(row)
        fields = fields_by_label(entry['record'])
        host = row['element_name']
        if (row['application_name'] != 'Wall - Retrofit' or host not in (PLASTERBOARD, SOLID)
                or row['frl'] != penetration or fields['Barrier Construction'] != host):
            raise ValueError(f'SNAP {sid}: FAR3929 source geometry or rated cell differs from the review.')
        high = penetration == '-/180/180'
        original = 180 if high else 120
        if fields['FRL'] != f'-/{original}/{original}':
            raise ValueError(f'SNAP {sid}: unexpected original FAR3929 effective rating.')
        solid = host == SOLID
        amendments[sid] = wall_spec(fields, solid, original, penetration, page)
        if high and solid:
            # No separately identified lower-rated solid-wall design in this report.
            continue
        other = 120 if high else 180
        spec = wall_spec(fields, solid, other, penetration, page)
        wall = 'solid' if solid else 'plasterboard'
        variants.append({**spec, 'parent_sid': sid, 'variant_key': f'far3929-{wall}-rated-{other}'})
    return amendments, variants
