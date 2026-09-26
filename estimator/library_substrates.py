"""Source-bound substrate facets; never reinterpret a service as its barrier.

The returned labels are search categories, not an approval or substitution rule.
Source fields, selector membership and reviewed tables are never modified.
"""

import hashlib
import json
import re

from .technical_orientation import prepare_selector_orientation_context, trafalgar_orientations


# Reviewed merged cells and explicit supporting-table references. Only IDs and
# fingerprints are retained here; source text stays in the private source bundle.
_REVIEWED_DOCUMENTS = {'fas190234': '36c8e16b04e1d6394f15db1d4e4a7944f5f42c692f396e0d629c279b11443fe4',
 'fas190236': '8591513cd147a765901a9676e2b115e8ab9f52508c94096f886c4f0d4fcc4f08'}
_REVIEWED_RECORDS = {'fas190234-system-h36': ('fas190234',
                          'ec008b0a3c84b86ba81673ef5bbcedc3057096ddee27139919bcf33cbf22d1ea',
                          (120,),
                          ('FIREFLYBatt floor',)),
 'fas190234-system-h37': ('fas190234',
                          'ec008b0a3c84b86ba81673ef5bbcedc3057096ddee27139919bcf33cbf22d1ea',
                          (121,),
                          ('FIREFLYBatt floor',)),
 'fas190234-system-h71b': ('fas190234', 'e3b6bc6537365ecf17f2d0f01eeae1500d6e9530e3c3b099949a332de28800f5', (132,), ('CLT floor',)),
 'fas190234-system-h71c': ('fas190234', '0ccc2674bbb835c2644eae3ffd82aa088fb6455f475d596d282346aaf62ed9ae', (132,), ('CLT floor',)),
 'fas190234-system-h72b': ('fas190234', 'e3b6bc6537365ecf17f2d0f01eeae1500d6e9530e3c3b099949a332de28800f5', (133,), ('CLT floor',)),
 'fas190234-system-h72c': ('fas190234', '0ccc2674bbb835c2644eae3ffd82aa088fb6455f475d596d282346aaf62ed9ae', (133,), ('CLT floor',)),
 'fas190234-system-h73b': ('fas190234', 'e3b6bc6537365ecf17f2d0f01eeae1500d6e9530e3c3b099949a332de28800f5', (134,), ('CLT floor',)),
 'fas190234-system-h73c': ('fas190234', '0ccc2674bbb835c2644eae3ffd82aa088fb6455f475d596d282346aaf62ed9ae', (134,), ('CLT floor',)),
 'fas190234-system-h75': ('fas190234', '96fc155fb225b46a5c54b8b648890d5d177b6429d472ff9b0a009b1c9527bb5d', (135,), ('INEX floor',)),
 'fas190234-system-h76': ('fas190234', '96fc155fb225b46a5c54b8b648890d5d177b6429d472ff9b0a009b1c9527bb5d', (136,), ('INEX floor',)),
 'fas190234-system-v168b': ('fas190234', '57a2f790919d1b49c9afc8d876fdf86ea3f8d90ce9de533c5a52dda4d2d21f62', (93,), ('CLT wall',)),
 'fas190234-system-v168c': ('fas190234', '0ccc2674bbb835c2644eae3ffd82aa088fb6455f475d596d282346aaf62ed9ae', (93,), ('CLT wall',)),
 'fas190234-system-v169b': ('fas190234', '57a2f790919d1b49c9afc8d876fdf86ea3f8d90ce9de533c5a52dda4d2d21f62', (94,), ('CLT wall',)),
 'fas190234-system-v169c': ('fas190234', '0ccc2674bbb835c2644eae3ffd82aa088fb6455f475d596d282346aaf62ed9ae', (94,), ('CLT wall',)),
 'fas190234-system-v170b': ('fas190234', '57a2f790919d1b49c9afc8d876fdf86ea3f8d90ce9de533c5a52dda4d2d21f62', (94,), ('CLT wall',)),
 'fas190234-system-v170c': ('fas190234', '0ccc2674bbb835c2644eae3ffd82aa088fb6455f475d596d282346aaf62ed9ae', (94,), ('CLT wall',)),
 'fas190236-system-h109b': ('fas190236',
                            '40e63e3a2afdbde42b819ac4a96ce9983f2ed4ae9ec956914d6e641cf9abb508',
                            (262,),
                            ('Concrete/masonry floor', 'Hebel floor')),
 'fas190236-system-h109c': ('fas190236',
                            '6c89997e3366b57204316c8614de16c6b5647601923763889605255f9f22c90a',
                            (262,),
                            ('Concrete/masonry floor', 'Hebel floor')),
 'fas190236-system-h181b': ('fas190236',
                            'c74dfca227866b4dfe711191afd9e67e59bb380526e76f9f3cf6ad76be5e38b0',
                            (286,),
                            ('Concrete/masonry floor', 'Hebel floor')),
 'fas190236-system-h181c': ('fas190236',
                            'a3cc1c36d6157ef25b1991469ec006498112c5b798defee21792a8c267cc111f',
                            (286,),
                            ('Concrete/masonry floor', 'Hebel floor')),
 'fas190236-system-h288': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (317,), ('INEX floor',)),
 'fas190236-system-h289': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (317,), ('INEX floor',)),
 'fas190236-system-h290': ('fas190236',
                           'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520',
                           (317, 318),
                           ('INEX floor',)),
 'fas190236-system-h291': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (318,), ('INEX floor',)),
 'fas190236-system-h292': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (318,), ('INEX floor',)),
 'fas190236-system-h293': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (319,), ('INEX floor',)),
 'fas190236-system-h294': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (319,), ('INEX floor',)),
 'fas190236-system-h295': ('fas190236', 'f6bd0736b93e0ed79fea4e05ac3f179468ae1ef6ab45e8b28eef55a6a79b4520', (319,), ('INEX floor',)),
 'fas190236-system-h296': ('fas190236', '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516', (320,), ('INEX floor',)),
 'fas190236-system-h297': ('fas190236',
                           '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516',
                           (320, 321),
                           ('INEX floor',)),
 'fas190236-system-h298': ('fas190236', '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516', (321,), ('INEX floor',)),
 'fas190236-system-h299': ('fas190236', '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516', (322,), ('INEX floor',)),
 'fas190236-system-h300': ('fas190236', 'b06c1e5c5e14c9ef4f9549f0364ee8d08159eeab1d26201dfe67988fe9967bb8', (322,), ('INEX floor',)),
 'fas190236-system-h301': ('fas190236', '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516', (323,), ('INEX floor',)),
 'fas190236-system-h302': ('fas190236',
                           '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516',
                           (323, 324),
                           ('INEX floor',)),
 'fas190236-system-h303': ('fas190236', '4d13934e3b93c4e0dd7a124d9d7f15096ec27fee5ccf17b99946a34616bdb516', (324,), ('INEX floor',)),
 'fas190236-system-v225b': ('fas190236',
                            'e5d89ca69a6884b061ffb9107c6e4f8a779641544873bd61bb81c1d61961048e',
                            (93,),
                            ('Concrete/masonry wall', 'Hebel wall')),
 'fas190236-system-v225c': ('fas190236',
                            '580762915988b7d53f43cdc837e79ccdf14b356e52e913821195c91531a0df05',
                            (93,),
                            ('Concrete/masonry wall', 'Hebel wall')),
 'fas190236-system-v498b': ('fas190236',
                            '2f77ab1934dc210e60108df2fd0b0f8d9b73528046e1f00caf7f80e052a0b589',
                            (175,),
                            ('Concrete/masonry wall', 'Solid gypsum block wall')),
 'fas190236-system-v498c': ('fas190236',
                            'da1e33f3f804261063d54908f0bb6ac1751618d0ac99eb40a4b1af8776e7c864',
                            (175,),
                            ('Concrete/masonry wall', 'Solid gypsum block wall')),
 'fas190236-system-v499b': ('fas190236',
                            '89f71dfab2354a8dd09633a7fddf94a060b43d1c0cc4c8b95f6958c39ccb71ba',
                            (176,),
                            ('Concrete/masonry wall', 'Solid gypsum block wall')),
 'fas190236-system-v502b': ('fas190236',
                            'da5883c166831128caae8e5cdaf9e9b85655621053e09e47039dfe935de22dc1',
                            (177,),
                            ('Concrete/masonry wall', 'Solid gypsum block wall'))}
_REVIEWED_TABLE = {'document_id': 'trafalgar-doc-e53c788e37788dcdb5fa6703',
 'document_sha256': 'e53c788e37788dcdb5fa670323d95783f27e16175dec1710c32df3ca3b249bde',
 'rows': {3: ('wall',), 4: ('wall',), 5: ('wall', 'floor'), 6: ('wall',)},
 'sha256': 'b983f62abf4f3986e8d151e544a17bcd634dde92314c3603d5df1d3fbc11a605'}


_LABELS = ('Plasterboard wall', 'Concrete/masonry wall', 'Hebel wall',
           'Speedpanel wall', 'Dincel wall', 'AFS wall', 'CLT wall',
           'Insulated panel wall', 'Plasterboard ceiling',
           'Concrete/masonry floor', 'Bondek floor', 'Hebel floor', 'CLT floor')
_MATERIALS = (
    ('COREX', r'\bcorex\b'),
    ('CLT', r'\bclt\b|cross[ -]?laminated\s+timber|\bnextimber\b'),
    ('Hebel', r'\bhebel\b|\baac\b|(?:autoclaved\s+)?aerated\s+concrete|\bwalsc\b|\bwalc\s*75\s*mm\b'),
    ('Speedpanel', r'\bspeed\s*panel\b'),
    ('Dincel', r'\bdincel\b'),
    ('AFS', r'\bafs\b'),
    ('KOROK', r'\bkorok\b'),
    ('Insulated panel', r'\bkingspan\b|\bk\s*-?\s*roc\b|\binsulated\s+(?:sandwich\s+)?panels?\b|\baskin\b'),
    ('Pronto panel', r'\bpronto\s*panels?\b'),
    ('AlphaPanel', r'\balpha\s*panels?\b'),
    ('Stonewall', r'\bstonewall\b'),
    ('Ritek X-Plus', r'\britek\s+x[ -]?plus\b'),
    ('Solid gypsum block', r'\b(?:solid\s+)?gypsum\s+blocks?\b'),
    ('Bondek', r'\bbondek\b'),
    ('Steel deck', r'\bsteel\s+deck\b|\bcomposite\s+floor\s+slabs?\b'),
    ('Airdeck', r'\bairdeck\b'),
    ('FIREFLYBatt', r'\bfirefly\s*batt\b'),
    ('FyreBATT', r'\bfyre\s*batt\b|\bryan\s*batt\b'),
    ('FyreBOARD Maxilite', r'\b(?:fyreboard\s+)?maxilite\b'),
    ('FyreSET mortar', r'\bfyre\s*set\s+mortar\b'),
    ('FyrePLUG pillows', r'\bfyre\s*plug\s+pillows?\b'),
    ('Plasterboard', r'\bplaster\s*board\b|\bshaft\s*liner\b|\bintrwall\b|\blaminated\s+shaft\s*wall\b'),
    ('Concrete/masonry', r'\bconcrete\b|\bmasonry\b|\bhollow\s+block\b|\bsolid\s+block\b|\bbrick(?:work)?\b|\bblockwork\b'),
    ('Framed', r'\bframed\s+(?:wall|floor)\b'),
    ('Rigid', r'\brigid\s+walls?\b'),
    ('Lightweight', r'\blightweight\b'),
    ('Fire-rated', r'\bany\s+fire\s+resistant\s+wall\b'),
)
_DIRECTION = re.compile(r'\b(walls?|floors?|ceilings?|soffits?|slabs?|firewalls?)\b', re.I)
_BARRIER_FIELDS = {'Barrier Construction', 'Substrate', 'Substrate (Selector Search)',
                   'Separating Element', 'Support Construction'}
_TYPE_FIELDS = {'Barrier Type', 'Fire Barrier Type (Selector Search)'}


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _document_matches(source, document_id, expected_hash, documents=None):
    if documents is not None and documents.get(document_id, {}).get('sha256') != expected_hash:
        return False
    return any(reference.get('document_id') == document_id and reference.get('sha256') == expected_hash
               for reference in source.get('sources', []))


def _reviewed_evidence(source, documents=None):
    fact = _REVIEWED_RECORDS.get(source.get('id'))
    if fact is None:
        return []
    document, fingerprint, pages, labels = fact
    fields = [{'label': field['label'], 'value': field.get('value', '')}
              for field in source.get('fields', []) if field.get('label') in _BARRIER_FIELDS]
    if _fingerprint(fields) != fingerprint or not _document_matches(source, document, _REVIEWED_DOCUMENTS[document], documents):
        return []
    actual_pages = tuple(reference.get('page') for reference in source.get('sources', []) if reference.get('document_id') == document)
    if actual_pages != pages:
        return []
    return [{'substrate': label, 'source': f'Reviewed {document} source construction', 'text': ''} for label in labels]


def _text(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _types(value):
    return {('wall' if 'wall' in match[0].lower() else
             'ceiling' if match[0].lower().startswith('ceiling') else 'floor')
            for match in _DIRECTION.finditer(value)}


def _classified_text(value, fallback=(), *, force_types=False):
    """Read only a construction clause supplied by a trusted evidence caller."""
    value = _text(value)
    value = re.sub(r'\b(?:not\s+(?:(?:approved|suitable|permitted|assessed|tested)\s+)?for|excluding|except)\b[^.;]*', '', value, flags=re.I)
    # A non-penetrated supporting wall is not an alternative penetrated barrier.
    value = re.split(r'(?:Secondary\s+)?Support\s+Construction\s*\([^)]*non[- ]*penetrated', value, flags=re.I)[0]
    # Local board thickening describes the seal; it does not replace its barrier.
    value = re.split(r'\b(?:locally\s+thicken\b|local\s+thickening\b|thicken+ed\s+on\s+the\s+underside\b|w\s*/\s*local(?=\s*\d|\b))', value, flags=re.I)[0]
    result = set()
    for clause in re.split(r'\bSource option\s+\d+\s*:|\bOr\s+(?=Min(?:imum)?\b)|(?<=\.)\s+(?=Separating Element)', value, flags=re.I):
        directions = [(match.start(), match.end(), next(iter(_types(match[0])))) for match in _DIRECTION.finditer(clause)]
        found = [(family, match) for family, pattern in _MATERIALS for match in re.finditer(pattern, clause, re.I)]
        families = {family for family, _ in found}
        for family, match in found:
            before = clause[:match.start()].lower()
            if family == 'Concrete/masonry':
                if re.search(r'(?:aerated|autoclaved\s+aerated)\s*$', before):
                    continue
                if families & {'Ritek X-Plus', 'Steel deck', 'Bondek'} and not re.search(r'\bor\b', clause, re.I):
                    continue
            if family == 'Plasterboard' and families & {'CLT', 'AlphaPanel', 'FIREFLYBatt'}:
                if re.search(r'\b(?:lined|encapsulated|underside|fixed|protected)\b', before) or re.search(r'\bunderside\b', clause[match.end():], re.I) or 'AlphaPanel' in families and not re.search(r'\bor\b', before):
                    continue
            if family == 'FIREFLYBatt' and 'Concrete/masonry' in families and re.search(r'protected\s+structural\s+concrete', clause, re.I):
                continue
            # Material names before a shared wall/floor noun share that noun.
            following = next((direction for start, _, direction in directions if start >= match.end()), None)
            preceding = next((direction for _, end, direction in reversed(directions) if end <= match.start()), None)
            kinds = _types(match[0]) or ({following or preceding} if following or preceding else set(fallback))
            if re.search(r'\b(?:combined\s+)?wall\s*/\s*floor\b', clause, re.I):
                kinds = {'wall', 'floor'}
            if re.search(r'\bfloor\s*/\s*ceiling\b|\bceiling\s*/\s*floor\b', clause, re.I):
                kinds = {'ceiling' if family in {'Plasterboard', 'COREX'} else 'floor'}
            if force_types:
                kinds = set(fallback)
            for kind in kinds:
                if kind == 'horizontal':
                    kind = 'ceiling' if family in {'Plasterboard', 'COREX'} else 'floor'
                if kind in {'wall', 'floor', 'ceiling'}:
                    result.add(f'{family} {kind}')
    return result


def _fallback_types(item):
    fields = item.get('fields', [])
    explicit = set().union(*(_types(_text(field.get('value'))) for field in fields if field.get('label') in _TYPE_FIELDS))
    if explicit:
        return explicit
    values = [_text(field.get('value')) for field in fields if field.get('label') in {'Orientation', 'Substrate Orientation'}]
    values += item.get('filter_values', {}).get('orientation', [])
    result = set()
    for value in values:
        if re.search(r'\bvertical\b', value, re.I):
            result.add('wall')
        if re.search(r'\bhorizontal\b', value, re.I):
            result.add('horizontal')
    return result


def _selector_evidence(source, selector_capture):
    if not source.get('id', '').startswith('trafalgar-') or not source.get('selector_provenance') or selector_capture is None:
        return []
    context = prepare_selector_orientation_context(selector_capture)
    # Reuse capture hash, complete membership and selected-type conflict checks.
    trafalgar_orientations(source, context)
    provenance = source['selector_provenance']
    queries = context.capture['queries'][provenance['category']]
    evidence = []
    for key in provenance['record']['query_ids']:
        options = queries[key].get('selected_options', {})
        selected = {name: choice['label'] for name, choice in options.items()
                    if isinstance(choice, dict) and isinstance(choice.get('label'), str)
                    and not any(choice.get(flag) for flag in ('is_all', 'is_placeholder', 'disabled'))}
        kinds = set().union(*(_types(label) for name, label in selected.items() if name.endswith('fire-barrier-type')))
        for name, label in selected.items():
            if name.endswith(('fire-barrier', 'fire-barrier-spec')):
                evidence.append((f'selector query {key}', label, kinds))
    return evidence


def _table_evidence(source, fields, fallback=(), source_documents=None):
    evidence = []
    for field in fields:
        if field.get('label') != 'Barrier Construction':
            continue
        tables = ([field['table']] if field.get('table') else []) + field.get('tables', [])
        for index, table in enumerate(tables):
            columns = table.get('columns', [])
            reviewed_rows = _REVIEWED_TABLE['rows'] if (_fingerprint(table) == _REVIEWED_TABLE['sha256'] and _document_matches(source, _REVIEWED_TABLE['document_id'], _REVIEWED_TABLE['document_sha256'], source_documents)) else {}
            # Fixing alternatives do not establish approved substrate scope.
            if not any(re.search(r'\bfrl\b|approved\s+wall', str(column), re.I) for column in columns):
                continue
            for column_index, column in enumerate(columns):
                if not re.fullmatch(r'(?:approved\s+walls?(?:\s+systems?)?|type\s+of\s+wall|wall\s+thickness|ceiling\s+construction|supporting\s+(?:wall|floor)\s+construction|floor\s+scope|substrate|barrier|separating\s+element)', _text(column), re.I):
                    continue
                row_types = set().union(*(_types(str(row[column_index])) for row in table.get('rows', [])))
                context = row_types if row_types else set(fallback)
                kinds = _types(str(column)) or (context if len(context) == 1 else set())
                for row_index, row in enumerate(table.get('rows', [])):
                    ratings = [str(row[position]).strip() for position, heading in enumerate(columns) if re.search(r'\bfrl\b', str(heading), re.I)]
                    if ratings and all(re.fullmatch(r'(?:not\s+(?:approved|permitted|tested|assessed)|n\s*/?\s*a)', rating, re.I) for rating in ratings):
                        continue
                    evidence.append((f'Barrier Construction table {index + 1}, row {row_index + 1}', row[column_index], reviewed_rows.get(row_index, kinds), row_index in reviewed_rows))
    return evidence


def _penetration_bullets(source, projected):
    fields = projected.get('fields', [])
    current = {field.get('label'): field.get('value', '') for field in fields}
    item_text = current.get('Item(s)', '')
    original = source.get('estimate', {}).get('draft', {}).get('rows', [])
    inputs = original[0].get('inputs', {}) if original else {}
    original_tags = _classified_text(inputs.get('P', ''))
    current_tags = _classified_text(current.get('Substrate', ''))
    same_substrate = _text(current.get('Substrate')).casefold() == _text(inputs.get('P')).casefold() or bool(original_tags and original_tags == current_tags)
    if 'P' in inputs and not same_substrate and item_text == inputs.get('T', ''):
        return []
    # First paragraph is service description. Only explicit construction bullets
    # are eligible; System/installation instructions are deliberately excluded.
    fallback = _types(_text(current.get('Substrate'))) or _fallback_types(projected)
    return [('Item(s) construction clause', match.group(1), fallback)
            for match in re.finditer(r'^\s*[-•]\s*(.+?)(?=\n\s*[-•]\s*|\Z)', str(item_text), re.M | re.S)
            if _construction_bullet(match.group(1))]


def _construction_bullet(value):
    matches = [match for _, pattern in _MATERIALS if (match := re.search(pattern, value, re.I))]
    if not matches:
        return False
    prefix = value[:min(match.start() for match in matches)]
    prefix = re.sub(r'\d+(?:\.\d+)?', ' ', prefix)
    prefix = re.sub(r'\b(?:min(?:imum)?|thick|fr|fire|rated|grade|single|double|triple|layers?|of|and|mm|x|hours?|hr|solid)\b', ' ', prefix, flags=re.I)
    return not re.search(r'[a-z]', prefix, re.I)


def classification_evidence(source, projected, *, selector_capture=None, source_documents=None):
    """Return classified evidence for diagnostics without changing any record."""
    fields = projected.get('fields', [])
    fallback = _fallback_types(projected)
    reviewed = _reviewed_evidence(source, source_documents)
    evidence = [(origin, text, kinds, False) for origin, text, kinds in _selector_evidence(source, selector_capture)]
    field_fallback = fallback if len(fallback) <= 1 or not evidence else set()
    evidence += [(field['label'], field.get('value', ''), field_fallback, False)
                 for field in fields if field.get('label') in _BARRIER_FIELDS and not reviewed]
    # Exact reviewed facts also cover source columns that describe perimeter
    # supports. Moving those cells into a display table must not turn them into
    # an additional penetrated substrate.
    if not reviewed:
        evidence += _table_evidence(source, fields, fallback, source_documents)
    if any(field.get('label') == 'Substrate' for field in fields):
        evidence += [(origin, text, kinds, False) for origin, text, kinds in _penetration_bullets(source, projected)]
    if source.get('id', '').startswith('fas190235-') and not any(field.get('label') in _BARRIER_FIELDS for field in fields) and _document_matches(source, 'fas190235', 'a61e53af7ad9d54fbec0302ddc90ee261248ac8e73d54504cef5319295722819', source_documents):
        # FAS190235's direct penetrated element is FIREFLYBatt. Its supporting
        # construction comes from separate assessments and is not inferred here.
        evidence.append(('FAS190235 direct barrier', 'FIREFLYBatt', fallback, False))
    result = reviewed
    for origin, text, kinds, force_types in evidence:
        for label in sorted(_classified_text(text, kinds, force_types=force_types), key=str.casefold):
            result.append({'substrate': label, 'source': origin, 'text': _text(text)})
    return result


def classify_substrates(source, projected, *, selector_capture=None, source_documents=None):
    """Return stable, unique search categories from record-bound evidence."""
    labels = {row['substrate'] for row in classification_evidence(source, projected, selector_capture=selector_capture, source_documents=source_documents)}
    return sorted(labels, key=lambda label: (_LABELS.index(label) if label in _LABELS else len(_LABELS), label.casefold()))
