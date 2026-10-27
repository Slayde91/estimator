"""Narrow reviewed display decisions; immutable supplier evidence is retained.

Report captions are bound to an exact manufacturer, old caption and public URL.
They identify the document at that URL, not approval of a saved configuration.
Construction and merged-cell decisions are bound to complete source fingerprints.
"""
from copy import deepcopy
import hashlib
import json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


# Public report covers and revision histories reviewed 28 October 2026.
# Some publishers have replaced a PDF without changing its historical URL.
REPORT_CAPTION_CORRECTIONS = (
    ('BOSS', 'FAS190039 R2.0', 'https://bossfire.com/documents/test-reports/WF-FAS-190039.pdf', 'FAS190039 R3.0'),
    ('BOSS', 'FRT180472 R2.0', 'https://bossfire.com/documents/test-reports/WF-FRT180472.1-RIR.pdf', 'FRT180472 R1.0'),
    ('BOSS', 'FRT180474 R3.0', 'https://bossfire.com/documents/test-reports/WF-FRT180474-RIR.pdf', 'FRT180474 R1.0'),
    ('Promat', '190202 R4.4', 'https://etex.azureedge.net/pi634058/original/-873576295/~bulkhead-batt-promat---2022-foa-assessment---walls-and-floor-20220905-fas190202-rir4.4.pdf', 'FAS190202 R5.1'),
    ('Promat', 'FAS190202', 'https://etex.azureedge.net/pi634058/original/-873576295/~bulkhead-batt-promat---2022-foa-assessment---walls-and-floor-20220905-fas190202-rir4.4.pdf', 'FAS190202 R5.1'),
    ('Promat', 'CERTIFIRE AC101.1', 'https://etex.azureedge.net/pi635954/original/-873576295/uc---certifire-20220804-cer200014_ac101.1.pdf', 'FAS200037 R6.5'),
    ('Promat', '29595300', 'https://media.promat.com/cert_371549_au/original/852736286/29592300-fas190113-r9.1-2025-fc-fcs-update.pdf?brand=promatconstruction&market=au', 'FAS190113 R9.11'),
    ('Trafalgar', '146236', 'https://tfire.com.au/documents/TR001-3-0623-Trafalgar-BladeRUNNER-and-MINI-AS1530-4-Assessment-Report', '146236.00 R2.0'),
    ('Trafalgar', 'TR001.3 0623', 'https://tfire.com.au/documents/TR001-3-0623-Trafalgar-BladeRUNNER-and-MINI-AS1530-4-Assessment-Report', '146236.00 R2.0'),
    ('Trafalgar', 'FC 10266', 'https://tfire.com.au/documents/Superstopper-orange-box-Range-Test-Report', 'FC10266-01-5'),
    ('Trafalgar', 'FC 11190', 'https://tfire.com.au/documents/FyreCOLLAR-Premium-Hinged-Retrofit-Conduits-Test-Report', 'FC11190-01-3'),
)
_REPORTS = {(brand.casefold(), caption, url): corrected
            for brand, caption, url, corrected in REPORT_CAPTION_CORRECTIONS}


def correct_report_captions(item):
    """Return a changed public copy only for an exact reviewed outbound link."""
    brands = item.get('filter_values', {}).get('manufacturer', [])
    if len(brands) != 1:
        return item
    changes = {}
    for field in item.get('fields', []):
        if field.get('label') != 'Report Number':
            continue
        captions = {line.strip() for line in field.get('value', '').splitlines()}
        for link in field.get('report_links', []):
            old, url = link.get('label'), link.get('url')
            corrected = _REPORTS.get((brands[0].casefold(), old, url))
            if old in captions and corrected:
                changes[old] = corrected
    if not changes:
        return item
    result = deepcopy(item)
    for field in result.get('fields', []):
        if field.get('label') != 'Report Number':
            continue
        field['value'] = '\n'.join(dict.fromkeys(changes.get(line.strip(), line.strip())
            for line in field.get('value', '').splitlines() if line.strip()))
        seen, links = set(), []
        for link in field.get('report_links', []):
            link['label'] = changes.get(link['label'], link['label'])
            if link['label'] not in seen:
                links.append(link)
                seen.add(link['label'])
        if links:
            field['report_links'] = links
    for name in ('report', 'document'):
        values = result.get('filter_values', {}).get(name)
        if values is not None:
            result['filter_values'][name] = list(dict.fromkeys(changes.get(value, value) for value in values))
    if result.get('subtitle') in changes:
        result['subtitle'] = changes[result['subtitle']]
    return result


BOSS_3391_CONSTRUCTION = 'Double Layer Fire Rated Plasterboard System — min. substrate thickness 116mm'
_BOSS_3391_SOURCE = '3b962550644f9cbe20648abe759063d4a3a6e6edc86c204ba2b1d7fb804d2936'


def reviewed_boss_construction(item):
    """The user's explicit BF-3391 correction, bound to the retained source."""
    if item.get('id') != 'boss-bf-3391' or item.get('filter_values', {}).get('manufacturer') != ['BOSS']:
        return None
    source = item.get('technical_basis', {}).get('source_fields', item.get('fields', []))
    return BOSS_3391_CONSTRUCTION if fingerprint(source) == _BOSS_3391_SOURCE else None


_PROMAT_MERGED_CELLS = {
    '674f0c5b5fd79e6b7bd5cab51b1669d3d6aad6194cf2fb038f9758b4c7ad4789',
    'be045dde5abc5413f91a163cb241837a2e3ffedd51fb308eb6e237d02a5df575',
}


def reviewed_promat_table(table):
    """Complete the two user-reviewed shared cells, never a generic fill-down.

Only plasterboard host rows share these values. The aperture-infill product
rows are not alternate host substrates and must not acquire these conditions.
"""
    if fingerprint(table) not in _PROMAT_MERGED_CELLS:
        return table
    result = deepcopy(table)
    columns = result['columns']
    barrier, gap, installation = (columns.index(label) for label in
                                ('Barrier Construction', 'Annular Gap', 'Installation Details'))
    for row in result['rows']:
        if row[barrier].startswith('FR Plasterboard '):
            if not row[gap].strip():
                row[gap] = 'Width: 10 mm - 20 mm'
            if not row[installation].strip():
                row[installation] = 'Batt Location: Both in Wall or One each Face'
    return result
