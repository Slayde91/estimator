"""Small library presentation rules; original source records stay unchanged."""

import re

from .technical_table_navigation import field_tables


def display_subtitle(value):
    """Hide standalone source-table segments, retaining the other metadata."""
    return ' · '.join(part.strip() for part in value.split('·')
                      if part.strip() and not re.fullmatch(
                          r'Tables?\s+\d+[A-Za-z]?(?:\s*(?:[-–,/]|and)\s*\d+[A-Za-z]?)*',
                          part.strip(), re.I))


_SELECTOR_ONLY = re.compile(
    r'^\S+\.(?:pdf|jpg|png): the available diagram does not verify a '
    r'service/wrap configuration table for this entry\. The service and wrap '
    r'summary remains attributed to the selector; no missing values have been inferred\.$', re.I)
_ROUTINE_PARAGRAPHS = {
    "No service-size / wrap-length configuration table appears in the available source image. "
    "The entry's service and wrap configurations remain selector summaries, not diagram table transcriptions.",
    "No actual service configuration table is printed on this image. Selector size bands, wrap lengths "
    "and their FRL associations cannot be verified or completed from this sheet.",
    "Do not infer numeric service dimensions, layer counts, wrap lengths, fixing counts or ratings "
    "from the drawing scale or illustration alone.",
}
_RESOLVED_PARAGRAPHS = {
    'Source image has clipped edges: Left drawing-title labels clipped. '
    'The missing text was not reconstructed.',
    'The publisher wrap text contains an unrecognised <gt/> element. '
    'The comparison symbol is unresolved; verify the wrap length against the approval.',
}


def _notice_text(value):
    return ' '.join(value.split())


_SEAL_NOTICE = ('The selector and source installation instruction use different seal-depth '
                'descriptions. Both are attributed in Seal Depth / Fillet Size; neither overrides the other.')
_SEAL_PREFIX = 'Fill FyreFLEX sealant in the annular gap to '
_SEAL_SOURCE_DEPTHS = {
    'full depth, on both sides of the wall.',
    '20mm depth on both sides of the wall + Maxilite.',
    'full depth of plasterboard, on both sides of the wall.',
    'full depth of plasterboard and shaftliner.',
    'full depth of shaftliner and plasterboard on both sides of the wall.',
    'full depth of wall.',
    'full depth of plasterboard on both sides of wall.',
    'full depth of shaftliner and plasterboard.',
}


def _resolve_selector_seal_depth(item):
    """Apply the user's selector precedence to the reviewed SuperSTOPPER summaries."""
    if not item.get('id', '').startswith('trafalgar-'):
        return False
    fields = item.get('fields', [])
    if not any(f['label'] == 'Source Issues' and _SEAL_NOTICE in f['value'] for f in fields):
        return False
    for field in fields:
        if field['label'] != 'Seal Depth / Fillet Size':
            continue
        parts = field['value'].split('\n\nSource installation instruction: ')
        if len(parts) != 2 or not parts[0].startswith('Selector: '):
            continue
        selector, instruction = parts[0][len('Selector: '):], parts[1]
        if not instruction.startswith(_SEAL_PREFIX):
            continue
        if instruction[len(_SEAL_PREFIX):].lower() not in {s.lower() for s in _SEAL_SOURCE_DEPTHS}:
            continue
        if selector == '20mm (Both Sides) / No Fillet':
            summary = _SEAL_PREFIX + 'max ' + selector
        elif selector == 'Full depth of Plasterboard (Both Sides) / No Fillet':
            summary = _SEAL_PREFIX + 'full depth of Plasterboard (Both Sides) / No Fillet'
        else:
            continue
        if instruction.endswith(' + Maxilite.'):
            # The selector controls plasterboard depth; the separate Maxilite
            # instruction supplies its own depth and remains applicable.
            summary += '. At the Maxilite, apply FyreFLEX sealant to 20mm depth on both sides.'
        field['value'] = summary
        return True
    return False


def _clean_notice(value, resolved_seal=False):
    paragraphs = re.split(r'\n\s*\n|\n(?=Source (?:image|conflict|ambiguity):?\s)', value.strip())
    has_selector_notice = any(_SELECTOR_ONLY.fullmatch(_notice_text(p)) for p in paragraphs)
    retained = [p for p in paragraphs
                if not _SELECTOR_ONLY.fullmatch(_notice_text(p))
                and _notice_text(p) not in _RESOLVED_PARAGRAPHS
                and not (resolved_seal and _notice_text(p) == _SEAL_NOTICE)
                and not (has_selector_notice and _notice_text(p) in _ROUTINE_PARAGRAPHS)]
    return '\n\n'.join(retained) if len(retained) != len(paragraphs) else value


def remove_resolved_source_notices(item):
    """Remove specifically resolved notices, retaining separate discrepancies.

    Runs after fingerprint validation on the projected copy. Mixed issue fields
    retain their other paragraphs, and the imported evidence is not rewritten.
    """
    resolved_seal = _resolve_selector_seal_depth(item)
    # Configuration rows can carry their own Source Issues column. Preserve
    # row order, identities and table indices while removing resolved cells.
    for field in item.get('fields', []):
        for table in field_tables(field):
            for index in reversed(range(len(table['columns']))):
                if table['columns'][index] != 'Source Issues':
                    continue
                for row in table['rows']:
                    row[index] = _clean_notice(row[index], resolved_seal)
                if len(table['columns']) > 1 and not any(row[index].strip() for row in table['rows']):
                    table['columns'].pop(index)
                    for row in table['rows']:
                        row.pop(index)
    by_label = {f['label']: f for f in item.get('fields', [])}
    fields = []
    for field in item.get('fields', []):
        if field['label'] == 'Source Issues':
            field['value'] = _clean_notice(field['value'], resolved_seal)
            if 'table_links' in field:
                field['table_links'] = [link for link in field['table_links']
                    if 'Source Issues' in field_tables(by_label[link['field']])[link['table_index']]['columns']]
                if not field['table_links']:
                    field.pop('table_links')
            if not any(field.get(key) for key in ('value', 'images', 'table', 'tables', 'table_links')):
                continue
        fields.append(field)
    item['fields'] = fields
