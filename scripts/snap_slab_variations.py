"""Plan slab thickness variants from the SNAP reports and reviewed original records."""

from collections import defaultdict
import re


FAR3932 = 'https://docs.snapcollars.com.au/FAR3932-Iss-3.pdf'
FAR3933 = 'https://docs.snapcollars.com.au/FAR3933-Iss-4.pdf'
FCO3520 = 'https://docs.snapcollars.com.au/FCO3520-Rev-D-LF.pdf'
FCO3426 = 'https://docs.snapcollars.com.au/1779697060234_FCO-3426%20Rev%20H.pdf'

# FCO3426 Tables 5 and 25, pipes 7 and 8. Each retained parent has the same
# collar, pipe, fitting and support construction as its 120 mm variant.
PN12_PARENTS = {1082, 1083, 1084, 1085, 1853, 1854, 1855, 1856,
                2624, 2625, 2626, 2627}


def _pages(report, url, references):
    return [{'label': f'{report}, {label} (p{page})', 'url': f'{url}#page={page}'}
            for label, page in references]


def _cap(rating, limit):
    _, integrity, insulation = rating.split('/')
    return f'-/{min(int(integrity), limit)}/{min(int(insulation), limit)}'


def _fields(entry):
    record = entry.get('record', entry)
    return {field['label']: field['value'] for field in record['fields']}


def _group(row):
    return tuple(str(row[key]).strip() for key in (
        'report_name', 'product_generic_code', 'service_name', 'nominal_size',
        'application_name', 'fitting_allowed',
    ))


def _slab(mm):
    return f'Concrete Slab ({mm}mm)'


def _clean_paragraphs(text, report):
    retained = []
    for paragraph in (text or '').split('\n\n'):
        if report == 'FAR3932':
            if re.fullmatch(r'SNAP lists -/\d+/\d+ for this row and specifies an effective FRL of -/\d+/\d+\.', paragraph):
                continue
            if re.fullmatch(r'SNAP lists -/\d+/\d+\. The searchable rating for the specified assembly is -/\d+/\d+ under FAR3932 Issue 3\.', paragraph):
                continue
            if re.match(r'^FAR3932 Table \d+ p\d+ gives penetration-only ', paragraph):
                # Keep the actual installation conditions from this paragraph.
                sentences = re.split(r'(?<=\.) +', paragraph)
                paragraph = ' '.join(sentence for sentence in sentences if not sentence.startswith((
                    'FAR3932 Table ', 'For the stated ', 'Table 9 ', 'The 35 mm topping is ',
                    'The slab is between ',
                )))
        elif report == 'FAR3933' and re.fullmatch(
            r'SNAP lists -/\d+/\d+\. FAR3933 Table \d+ \(p\d+\) assesses the configuration\. '
            r'Table 15 \(p20\) limits the 150 mm slab to 180 minutes; 240 minutes requires at least 175 mm\. '
            r'The searchable assembly rating is -/180/180\.', paragraph,
        ):
            continue
        elif report == 'FCO3520' and re.fullmatch(
            r'SNAP lists -/240/240\. FCO3520 Rev D Table 10 supports -/180/180 at 150 mm slab thickness\. '
            r'The -/240/240 rating requires at least 175 mm\.', paragraph,
        ):
            continue
        if paragraph:
            retained.append(paragraph)
    return '\n\n'.join(retained)


def _far3932(row, sid):
    # The selector snapshot and withdrawn systems have already been authenticated by
    # prepare_snap_library. Select by the assessed pipe/collar, independent of the UI text.
    service = row['service_name'].strip()
    collar = row['product_generic_code']
    if service in ('PVC-DWV', 'PVC-DWV (SC)'):
        is_large_stack = collar == 'H150FWS' and row['nominal_size'] == '150 mm'
        table, page = (3, 10) if collar.endswith('FWS') and not is_large_stack else (4, 11)
    elif service in ('HDPE', 'HDPE Silent'):
        table, page = (5, 11) if collar.endswith('FWS') and collar != 'H150FWS' else (6, 12)
    elif service == 'PPR-80 SDR7.4 Faser Composite':
        table, page = 7, 13
    elif service in ('PE100 SDR 11', 'PE100 SDR 7.4'):
        table, page = 8, 14
    else:
        raise ValueError(f'SNAP {sid}: unsupported FAR3932 service {service}')
    penetration_rating = row['frl']
    floor_waste = row['application_name'].startswith('Floor Waste')
    refs = _pages('FAR3932 Issue 3', FAR3932, [(f'Table {table}', page), ('Table 9', 15)])
    if floor_waste:
        if table not in (3, 5) or row['element_name'] != 'Concrete Slab (150mm) + Screed (35mm)':
            raise ValueError(f'SNAP {sid}: unreviewed floor-waste construction')
        # The notes below Tables 3 and 5 name exactly these two complete floor assemblies.
        return [(_slab(185), _cap(penetration_rating, 240))], refs

    rules = []
    if table in (3, 5):
        # Only floor-waste/shower assemblies have a special minimum in these two tables.
        rules.append((120, 120))
    minimum = 150
    if table == 6 and row['product_generic_code'] == 'H150FWS':
        minimum = 180  # Table 6 (starred HDPE row).
    elif table == 7 and row['nominal_size'] in ('125 mm', '160 mm'):
        minimum = 175  # Table 7 (starred PPR rows).
    if minimum <= 150:
        rules.append((150, 180))
    if minimum == 175:
        rules.append((175, 180))
    rules.append((180, 240))
    result = []
    previous_rating = None
    for thickness, cap in rules:
        cell = penetration_rating
        if table == 4 and row['product_generic_code'] == 'H150FWS' and thickness < 170:
            cell = '-/180/180'  # The -/240/240 cell requires 170 mm minimum concrete.
        rating = _cap(cell, cap)
        if rating != previous_rating:
            result.append((_slab(thickness), rating))
        previous_rating = rating
    return result, refs


def _far3933(row):
    product = row['product_generic_code']
    if product in ('LP50R', 'LP100R', 'HP100R'):
        table, page = 6, 13
    elif row['service_name'].strip() == 'Triplus':
        table, page = 13, 19
    elif row['service_name'].strip() == 'HDPE':
        table, page = 11, 17
    else:
        table, page = 9, 16
    # The listed stack configurations are assessed cells. Tested-only floor-waste
    # cells and unassessed fittings have no thickness extension in this planner.
    if row['application_name'] != 'Stack - Retrofit' or row['element_name'] != _slab(150):
        raise ValueError('FAR3933 input outside reviewed stack configurations')
    rating = row['frl']
    variants = [(_slab(120), _cap(rating, 120)), (_slab(150), _cap(rating, 180))]
    if _cap(rating, 180) != _cap(rating, 240):
        variants.append((_slab(175), _cap(rating, 240)))
    refs = _pages('FAR3933 Issue 4', FAR3933, [(f'Table {table}', page), ('Tables 14 and 15', 20)])
    return variants, refs


def _pn12(row, sid):
    size = row['nominal_size']
    if (row['product_generic_code'] not in {'L40/50S', 'H50S'} or
            row['service_name'].strip() != 'PVC-PN12' or size not in {'40 mm', '50 mm'} or
            row['fitting_allowed'] != 'No' or row['application_name'] != 'Stack - Cast-in' or
            row['element_name'] not in {_slab(150), 'Bondek Slab (150mm)', 'Concrete Beam (under 150mm slab)'}):
        raise ValueError(f'SNAP {sid}: expected the verified FCO3426 PN12 configuration')
    pipe = 7 if size == '40 mm' else 8
    refs = [(f'Table 5, pipe {pipe}', 10), (f'Table 25, pipe {pipe}', 60)]
    if row['element_name'].startswith('Bondek'):
        refs.append(('Section 3.3, permanent steel formwork', 33))
    if row['element_name'].startswith('Concrete Beam'):
        refs.append(('Section 3.2(f) and Figure 14, beam-side installation', 25))
    return [(row['element_name'].replace('150mm', '120mm'), '-/120/120')], _pages('FCO3426 Rev H', FCO3426, refs)


def _monolithic_install(text):
    return (text.replace('Install the pipe and puddle flange, then place bedding on the concrete.',
                         'Install the pipe and puddle flange.')
            .replace('Install the pipe and puddle flange and place the bedding on the concrete.',
                     'Install the pipe and puddle flange.')
            .replace('Provide the floor waste grate and a 150 mm slab plus 35 mm topping as shown in the source assembly.',
                     'Provide the floor waste grate in the 185 mm concrete slab.'))


def plan_slab_variations(rows_by_sid, existing_by_sid):
    """Return amendments keyed by original integer ID and new, deduplicated slab variants.

    The inputs are the reviewed original snapshot and its raw SNAP selector rows.
    Geometry is compared within a report, product, pipe, fitting and application.
    Different report conditions may apply to nominally similar pipe installations.
    """
    occupied = defaultdict(set)
    for sid in existing_by_sid:
        if sid in rows_by_sid:
            row = rows_by_sid[sid]
            occupied[_group(row)].add((row['element_name'], _fields(existing_by_sid[sid])['FRL']))
    amendments = {}
    variants = []
    for sid in sorted(existing_by_sid):
        row = rows_by_sid.get(sid)
        if not row:
            continue
        report = row['report_name']
        fields = _fields(existing_by_sid[sid])
        if report == 'FAR3932':
            options, sources = _far3932(row, sid)
        elif report == 'FAR3933':
            options, sources = _far3933(row)
        elif report == 'FCO3520' and sid in (85, 221):
            # The 120, 150 and 175 mm rows already exist for each of these two substrates.
            options = []
            sources = _pages('FCO3520 Rev D', FCO3520, [('Table 10', 12)])
        elif report == 'FCO3426' and sid in PN12_PARENTS:
            options, sources = _pn12(row, sid)
        else:
            continue
        install = _clean_paragraphs(fields['Installation Details'], report)
        issues = _clean_paragraphs(fields.get('Source Issues', ''), report)
        if report != 'FCO3426':
            amendments[sid] = {'install': install, 'source_issues': issues, 'sources': sources}
        covered = occupied[_group(row)]
        for element, rating in options:
            if (element, rating) in covered:
                continue
            covered.add((element, rating))
            thickness = re.search(r'(\d+)mm', element)[1]
            new_install = install
            if report == 'FAR3932' and row['application_name'].startswith('Floor Waste'):
                new_install = _monolithic_install(install)
            variant = dict(parent_sid=sid, element=element, frl=rating, install=new_install,
                           source_issues=issues, sources=sources, variant_key=f'{report.lower()}-concrete-{thickness}mm')
            if sid in (4209, 4211) and element == _slab(185):
                # Full-page guide step 5(ii) illustrates screed. The component crop from
                # step 1 illustrates the shared reducer installation independently of the slab.
                ring = 65 if sid == 4209 else 80
                variant['drawing_parent_sid'] = 3432
                variant['drawing_caption'] = (f'SNAP INS-LT-V2, p. 1, step 1. Fit the {ring} mm reducer ring '
                                              f'to the L100FWS body to form L{ring}FWS.')
            variants.append(variant)
    return amendments, variants
