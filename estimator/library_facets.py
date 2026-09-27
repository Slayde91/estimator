"""Deterministic discovery facets from reviewed service and rating fields.

Facets locate records, not design approvals. Conditions and source row pairings
remain in the detail. Installation prose and supporting-wall ratings are not
used as evidence of a penetrant or its performance.
"""
import re

from .technical_rating_summary import summarize_ratings
from .technical_table_navigation import field_tables

CATEGORIES = ('Electrical & Communications', 'Mechanical', 'HVAC',
              'Plumbing & Hydraulic', 'Structural Steel', 'Access Panel',
              'Blank Seal', 'Bulkheads')
SERVICES = ('Access Panel', 'Blank Seal', 'Busbar Trunking', 'Cable Bundles',
            'Cable Trays', 'Coaxial Cables', 'Conduits', 'D1 Power Cables',
            'D2 Comms Cables', 'Data Cable Bundles', 'Downlight Box',
            'Downlights', 'Fibre Optic', 'Fire Dampers', 'Fire Resistant Cables',
            'Flexible Ducts', 'Junction Box', 'Lagged Pipes', 'Linear Joints',
            'Mixed Service Bundle', 'Mixed Services', 'Movement Joints',
            'Multi-service Bundle', 'Pair Coil Bundle', 'Pair Coils',
            'Plastic Pipes', 'Power Cable Bundles', 'Power Cables',
            'Single Cables', 'TPS & Fire Alarm Cable Bundles', 'Unlagged Pipes')
FRLS = ('N/A', '-/60/60', '-/90/90', '-/120/120', '-/180/180', '-/240/240')
FACETS = {'category': ('Category', CATEGORIES), 'services': ('Services', SERVICES),
          'frl': ('FRL', FRLS)}


def _key(value):
    return re.sub(r'\s+', ' ', value).strip().casefold().translate(
        str.maketrans({c: '-' for c in '‐‑‒–—−'}))


def _rating_column(column):
    return bool(re.match(r'^(?:source |blank seal )?frl(?:\b|_)', _key(column)))


def scoped_rating_cells(field, fields):
    """Read only linked, applicable FRL columns/rows, including middle ratings.

Older diagram reviews preserve entire source tables even when only one row or
column applies. Their generated scope is authoritative for selecting cells;
an unresolved related table is never promoted to an entry's rating.
"""
    by_label = {f['label']: f for f in fields}
    value = field.get('value', '')
    scope = re.compile(
        r'(?:observed source service ratings|matched source barrier row|source substrate alternatives) '
        r'\((Service Size / Configuration|Barrier Construction) table ([1-9][0-9]*)(.*?)\)'
        r'(?=\.|:)', re.I)
    scopes = list(scope.finditer(value))
    cells = []
    for link in field.get('table_links', []):
        target = by_label.get(link['field'], {})
        tables = field_tables(target)
        index = link['table_index']
        if not 0 <= index < len(tables):
            continue
        table = tables[index]
        columns = [n for n, c in enumerate(table['columns']) if _rating_column(c)]
        matching = [s for s in scopes if s[1] == link['field'] and int(s[2]) == index + 1]
        # Source-review prose explicitly marks other tables as non-applicable.
        marker = f"{link['field']} table {index + 1}: related source ratings only"
        if marker in value:
            continue
        if not matching:
            # Generated attribution with an unrecognised scope is not permission
            # to consume every retained source alternative.
            if 'source' in value.casefold() and 'table ' in value.casefold():
                continue
            matching = [None]
        for match in matching:
            rows, selected = table['rows'], columns
            condition = match[3].strip() if match else ''
            if condition.startswith('(') and condition.endswith(')'):
                selected = [n for n in columns if _key(table['columns'][n]) == _key(condition[1:-1])]
            elif condition.startswith('; '):
                condition = condition[2:]
                if _rating_column(condition):
                    selected = [n for n in columns if _key(table['columns'][n]) == _key(condition)]
                else:
                    requirements = [part.partition(': ') for part in condition.split('; ')]
                    if any(not sep for _, sep, _ in requirements):
                        continue
                    indices = [next((n for n, c in enumerate(table['columns']) if _key(c) == _key(name)), -1)
                               for name, _, _ in requirements]
                    if -1 in indices:
                        continue
                    rows = [row for row in rows if all(_key(row[n]) == _key(req[2])
                                                       for n, req in zip(indices, requirements))]
            elif condition:
                continue
            cells.extend(row[n] for row in rows for n in selected)
    return cells


def frl_values(item):
    values = []
    for field in item.get('fields', []):
        if field['label'] not in {'FRL', 'Blank Seal FRL'}:
            continue
        values.append(field.get('value', ''))
        values.extend(scoped_rating_cells(field, item['fields']))
        for table in field_tables(field):
            values.extend(row[n] for row in table['rows'] for n, c in enumerate(table['columns'])
                          if _rating_column(c))
    # Configuration tables without navigation are common in older imports.
    # Barrier tables require an explicit rating-field link and are never scanned
    # indiscriminately: they can state only the supporting element's capacity.
    for field in item.get('fields', []):
        if field['label'] != 'Service Size / Configuration':
            continue
        linked = any(link['field'] == field['label'] for f in item['fields']
                     if f['label'] in {'FRL', 'Blank Seal FRL'} for link in f.get('table_links', []))
        if not linked:
            for table in field_tables(field):
                values.extend(row[n] for row in table['rows'] for n, c in enumerate(table['columns'])
                              if _rating_column(c))
    # Two legacy selector spellings omit one separator, not a duration.
    # Preserve their displayed source strings; normalize only the facet token.
    normalized = [re.sub(r'^\s*-\s*(\d+)\s*/\s*(\d+)', r'-/\1/\2',
                         re.sub(r'^\s*/(?=\d+\s*/)', '-/', v)) for v in values]
    ratings = set(summarize_ratings(normalized)['ratings'])
    if any(_key(v) in {'n/a', 'not applicable'} for v in values):
        ratings.add('N/A')
    if not ratings:
        reserved = any(f['label'] == 'Service' and _key(f['value']) == 'blank for future use'
                       for f in item.get('fields', []))
        ratings.add('N/A' if reserved else 'Not specified')
    return sorted(ratings, key=lambda r: (r in {'N/A', 'Not specified'}, tuple(-1 if p == '-' else int(p)
                  for p in r.split('/')) if r not in {'N/A', 'Not specified'} else (), r))


def service_values(item):
    fields = {f['label']: f for f in item.get('fields', [])}
    service = fields.get('Service', {}).get('value', '')
    configuration = fields.get('Service Size / Configuration', {})
    # Service identity and size describe penetrants. Do not scan fixings, wraps,
    # installation instructions, captions or substrate names for service words.
    chunks = [service, configuration.get('value', '')]
    # A retained diagram can include services belonging to other selector rows.
    # Only enumerate its service columns for an explicitly multi-service entry.
    enumerate_services = bool(re.search(r'table of services|mixed service|multi.service', _key(service)))
    for table in field_tables(configuration) if enumerate_services else []:
        indices = [n for n, c in enumerate(table['columns']) if _key(c) in {
            'service type', 'service detail', 'service size / configuration',
            'service size / condition', 'service configuration', 'service (purlin size)'}]
        chunks.extend(row[n] for row in table['rows'] for n in indices)
    text = _key(' '.join(chunks))
    installation = _key(fields.get('Installation Type', {}).get('value', ''))
    products = _key(fields.get('System Products', {}).get('value', ''))
    result = set()
    def has(pattern):
        return bool(re.search(pattern, text))
    def add(name, pattern):
        if has(pattern): result.add(name)
    add('Access Panel', r'access panel')
    if 'fire rated access panels' in [_key(v) for v in item.get('filter_values', {}).get('trafalgar_category', [])]:
        result.add('Access Panel')
    if 'blank seal' in installation or 'aperture seal' in installation or has(r'blank (?:opening|hole|for future)|redundant penetrations|patch repair'):
        result.add('Blank Seal')
    if re.search(r'bulkhead|box.?out|vertical riser|floor/ceiling system|top of service shaft|batt barrier', installation):
        result.add('Blank Seal')
    if 'linear' in installation: result.add('Linear Joints')
    add('Linear Joints', r'linear (?:joint|gap)')
    add('Movement Joints', r'control joint|movement joint|expansion joint')
    add('Busbar Trunking', r'bus.?bar')
    add('Cable Trays', r'cable tray')
    add('Conduits', r'conduit')
    add('Coaxial Cables', r'coax|\brg\s?6\b')
    add('D1 Power Cables', r'\bd1\b')
    add('D2 Comms Cables', r'\bd2\b')
    add('Fibre Optic', r'fibre.?optic|optic(?:al)? fibre|optic fibre')
    add('Fire Resistant Cables', r'fire.?resistant|fire.?rated cable|cables - fire\b|fire cables')
    add('Downlight Box', r'downlight box')
    add('Downlights', r'downlights?\b')
    add('Junction Box', r'junction box')
    add('Fire Dampers', r'\bdamper')
    add('Flexible Ducts', r'flexible (?:aluminium )?duct|flexi.?duct')
    add('Mixed Services', r'mixed service|table of services|multi.service block')
    add('Mixed Service Bundle', r'mixed (?:service|cable and lagged copper pipe) bundle')
    add('Multi-service Bundle', r'multi(?:ple)?[ -]service bundle')
    pair = has(r'pair.?coil|air.?con|airco system|twin air-con')
    bundle = has(r'bundle|\b[2-9][0-9]*\s*[×x]\s*(?:cat|rg|optic)|\bbundles')
    if pair:
        result.add('Pair Coil Bundle' if bundle or has(r'air.?con.*bundle|\bcables?\b') else 'Pair Coils')
    data = has(r'\bcat\s?[5-7]|data|comm(?:unication)?s?\b')
    power = has(r'power|electri(?:c|cal)|aluminium cable|cables - aluminium|\btps\b|twin and earth|\b[234]c\s*\+\s*e')
    cable = has(r'\bcables?\b|\bcat\s?[5-7]|\brg6\b')
    if cable:
        if bundle:
            result.add('Cable Bundles')
            if data: result.add('Data Cable Bundles')
            if power: result.add('Power Cable Bundles')
        if power: result.add('Power Cables')
        if has(r'\btps\b|fire alarm|alarm / fire|alarm cable'):
            result.add('TPS & Fire Alarm Cable Bundles' if bundle or has(r'cables\b') else 'Single Cables')
        if has(r'\bsingle cable|\b1\s*[×x]\s.*cable|\b1 of,|\bone of,'):
            result.add('Single Cables')
        if not result.intersection({'Power Cables', 'Fibre Optic', 'Coaxial Cables', 'D1 Power Cables',
                                   'D2 Comms Cables', 'Fire Resistant Cables', 'Cable Bundles',
                                   'TPS & Fire Alarm Cable Bundles', 'Single Cables'}):
            result.add('Communications Cables' if data else 'Single Cables')
    plastic = has(r'plastic pipe|\b[uc]?pvc\b|pvc-u|\b[hc]dpe\b|\bpe[x-]|\bpp(?:-md)?\b|raupiano|dblue|polybutylene|pu air line')
    pipe = has(r'\bpipes?\b|metal, (?:copper|steel)|beverage python|drinks python|beer line|gas line|pu air line|floor waste|pe/al/pex')
    if plastic and pipe: result.add('Plastic Pipes')
    if pipe and not pair:
        # Cable insulation and fire-protection wrap do not mean a lagged pipe.
        lagged = has(r'lagged|lagging|pipes - insulated|insulated (?:beer|gas|pipe)|nitrile|rubber insulation|pipe insulation|insulation.*pipe')
        if lagged: result.add('Lagged Pipes')
        elif not plastic: result.add('Unlagged Pipes')
    add('Structural Steel', r'structural elements - steel|steel.*beam|\bub beam|\bpurlin|threaded rod|steel plate')
    add('Structural Timber', r'timber (?:joist|post)|glulam|structural elements - timber')
    if has(r'structural elements'):
        if has(r'\b(?:ub|uc|shs|rhs|chs|ea)\b|[0-9](?:ub|uc)[0-9]'):
            result.add('Structural Steel')
        if has(r'kiwlia|kwila|lvl|timber'):
            result.add('Structural Timber')
    add('Movement Joints', r'fireflyspan')
    add('Smoke Sampling Tubes', r'vesda|microduct')
    add('Air Transfer Grilles', r'air transfer grille')
    add('Floor/Deck Boxes', r'floor/deck box')
    add('Wall Sockets', r'wall socket')
    if not result and ('access' in products or 'fyreshield' in products or 'fyreframe' in products):
        result.add('Access Panel')
    return sorted(result)


def category_values(item, services):
    result = set()
    for service in services:
        if service in {'Access Panel', 'Structural Steel', 'Structural Timber'}: result.add(service)
        elif service in {'Blank Seal', 'Linear Joints', 'Movement Joints'}: result.add('Blank Seal')
        elif service in {'Pair Coil Bundle', 'Pair Coils', 'Fire Dampers', 'Flexible Ducts', 'Air Transfer Grilles'}: result.add('HVAC')
        elif service in {'Lagged Pipes', 'Unlagged Pipes', 'Plastic Pipes'}: result.add('Plumbing & Hydraulic')
        elif service in {'Mixed Services', 'Mixed Service Bundle', 'Multi-service Bundle'}:
            result.update(('Electrical & Communications', 'Mechanical', 'Plumbing & Hydraulic'))
        else: result.add('Electrical & Communications')
    installation = _key(' '.join(f['value'] for f in item.get('fields', []) if f['label'] == 'Installation Type'))
    if re.search(r'bulkhead|box.?out|vertical riser|top of service shaft', installation):
        result.discard('Blank Seal')
        result.add('Bulkheads')
    return sorted(result)


def classify_facets(item):
    # Explicit imported selections cover source-reviewed continuation rows whose
    # service cell is merged across a page break. These are existing facet data,
    # not a guess based on neighbouring record identifiers.
    services = sorted(set(service_values(item)) | set(item.get('filter_values', {}).get('services', [])))
    return {'category': category_values(item, services), 'services': services, 'frl': frl_values(item)}


def facet_options(key, observed):
    preferred = FACETS.get(key, ('', ()))[1]
    return list(preferred) + sorted(set(observed) - set(preferred), key=str.casefold)
