"""Additional manufacturer discovery from the products named in a reviewed system."""
import re

from .technical_table_navigation import field_tables


RYANFIRE_TERMS = {
    'FyreBATT 50': re.compile(r'\bfyre\s*batt\s*50(?!\d)', re.I),
    'Ryan': re.compile(r'\bryan\b|\bryan\s*fire|\bryan\s*(?:span|batts?)(?:\b|(?=502))|\bryan\s*502\s*(?:batts?|board)\b', re.I),
    'FyreMASTIC A-R': re.compile(r'\bfyre\s*mastic\s*a\s*-?\s*r\b', re.I),
    'HP-X': re.compile(r'(?:\b|(?<=ryanfire))hp\s*-?\s*x\b', re.I),
    'Servowrap': re.compile(r'(?:\b|(?<=ryanfire))servo\s*wrap\b', re.I),
}
_EVIDENCE_FIELDS = {
    'System Products', 'Installation Details', 'Barrier Construction',
    'Service Size / Configuration', 'Service Wrap', 'Seal Depth / Fillet Size',
    'Maximum Opening Size', 'Source Options',
}
_DASHES = str.maketrans({dash: '-' for dash in '‐‑‒–—−'})


def ryanfire_terms(record):
    text = [record.get(name, '') for name in ('title', 'subtitle', 'summary')]
    for field in record.get('fields', []):
        if field['label'] not in _EVIDENCE_FIELDS:
            continue
        text.append(field.get('value', ''))
        for table in field_tables(field):
            text.extend(cell for row in table['rows'] for cell in row)
    evidence = '\n'.join(text).translate(_DASHES)
    return [term for term, pattern in RYANFIRE_TERMS.items() if pattern.search(evidence)]


def discovery_manufacturers(record, values):
    names = list(values)
    if 'ryanfire' not in {name.casefold() for name in names} and ryanfire_terms(record):
        names.append('Ryanfire')
    return names


def manufacturer_fields(fields, names):
    """Use the existing Manufacturer field while leaving stored supplier evidence intact."""
    if 'Ryanfire' not in names:
        return fields
    result = [{**field, 'value': '\n'.join(names)} if field['label'] == 'Manufacturer' else field
              for field in fields]
    if not any(field['label'] == 'Manufacturer' for field in fields):
        result.append({'label': 'Manufacturer', 'value': '\n'.join(names)})
    return result
