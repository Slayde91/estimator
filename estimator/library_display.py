"""Small library presentation rules; original source records stay unchanged."""

import re


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


def remove_resolved_source_notices(item):
    """Remove specifically resolved notices, retaining separate discrepancies.

    Runs after fingerprint validation on the projected copy. Mixed issue fields
    retain their other paragraphs, and the imported evidence is not rewritten.
    """
    fields = []
    for field in item.get('fields', []):
        if field['label'] == 'Source Issues':
            paragraphs = re.split(r'\n\s*\n|\n(?=Source (?:image|conflict|ambiguity):?\s)',
                                  field['value'].strip())
            has_selector_notice = any(_SELECTOR_ONLY.fullmatch(_notice_text(p)) for p in paragraphs)
            retained = [p for p in paragraphs
                        if not _SELECTOR_ONLY.fullmatch(_notice_text(p))
                        and _notice_text(p) not in _RESOLVED_PARAGRAPHS
                        and not (has_selector_notice and _notice_text(p) in _ROUTINE_PARAGRAPHS)]
            if len(retained) != len(paragraphs):
                field['value'] = '\n\n'.join(retained)
                if not field['value'] and not field.get('images') and not field.get('table') and not field.get('tables'):
                    continue
        fields.append(field)
    item['fields'] = fields
