"""Public Technical Library wording; source documents and record identities retain their text."""
import re

from .technical_brand_presentation import manufacturer_names
from .technical_discovery import SNAP_FILTER_SOURCE


_PVC_CAVEAT = re.compile(
    r'Confirm pipe wall thickness against FCO3520 Table \d+; the printed 50 mm PVC range is unclear\.[ \t]*')
_REPORT_REFERENCE = re.compile(r'\bTable 3 of ([A-Z]{2,}[- ]?\d+[A-Z0-9-]*)\b')
_FLOOR_SUPPORT = re.compile(
    r'Keep the stack straight below the floor\. Support the pipe above it within 500 mm along the service, '
    r'with a second support about 1,000 mm from the first where required\.'
    r'(?: See FCO3520 Rev D, Table (?:[6-9]|10)\.)?[ \t]*')
_SNAP_SENTENCES = (
    'Apply the specified annular seal at the top of the slab in accordance with FCO3520.',
    'Apply the specified annular seal at both wall faces in accordance with FCO3520.',
    'Refer to Table 4 of FCO3520 for the general fixing requirements (excl. HDPE pipes).',
    'Refer to Table 5 of FCO3520 for the general fixing requirements with HDPE pipes.',
    'Support the pipe above the slab and keep the stack straight beneath the slab in the assessed configuration.',
    'Support the stack above the slab.',
)
_SNAP_SENTENCE = re.compile(r'(?:' + '|'.join(map(re.escape, _SNAP_SENTENCES)) + r')[ \t]*')
_GULLY_INSTRUCTION = 'Use a P-trap, 4-way gully or gully trap on the exposed side'


def _value(value, snap, reports):
    # A relative reference ("Table 3 of this report") can be the sole identifier
    # of a tested condition. Only shorten a reference with an actual report ID.
    result = value
    if 'Table 3 of ' in value:
        result = _REPORT_REFERENCE.sub(
            lambda match: match[1] if any(re.match(re.escape(match[1]) + r'\b', report) for report in reports)
            else match[0], result)
    if 'the printed 50 mm PVC range is unclear.' in result:
        result = _PVC_CAVEAT.sub('', result)
    if snap:
        result = _FLOOR_SUPPORT.sub('', result)
        result = _SNAP_SENTENCE.sub('', result)
        result = result.replace(_GULLY_INSTRUCTION + ', with the pipe supported above the slab.', _GULLY_INSTRUCTION + '.')
    if result == value:
        return value
    result = re.sub(r'[ \t]+(?=\r?$)', '', result, flags=re.M)
    return re.sub(r'(\r?\n)(?:[ \t]*\r?\n){2,}', r'\1\1', result).strip()


def public_prose_fields(record):
    """Return public field values without mutating fields, tables, links or captions."""
    snap = (record.get('source_label') == SNAP_FILTER_SOURCE
            or bool(manufacturer_names(record) & {'snap', 'snap fire systems'}))
    original = record.get('fields', [])
    reports = [line.strip() for field in original if field['label'] == 'Report Number'
               for line in field.get('value', '').splitlines()]
    reports.extend(record.get('filter_values', {}).get('report', []))
    fields = []
    for field in original:
        if field['label'] in {'ID', 'Report Number', 'Diagrams & Figures'}:
            fields.append(field)
            continue
        value = field.get('value', '')
        public = _value(value, snap, reports)
        fields.append(field if public == value else {**field, 'value': public})
    return fields
