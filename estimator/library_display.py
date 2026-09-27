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


def remove_resolved_selector_notices(item):
    """Remove the resolved missing-table boilerplate, never real discrepancies.

    Runs after fingerprint validation on the projected copy. Mixed issue fields
    retain their other paragraphs, and the imported evidence is not rewritten.
    """
    if not item.get('id', '').startswith('trafalgar-'):
        return
    fields = []
    for field in item.get('fields', []):
        if field['label'] == 'Source Issues':
            paragraphs = re.split(r'\n\s*\n', field['value'].strip())
            has_resolved_notice = any(_SELECTOR_ONLY.fullmatch(p.strip()) for p in paragraphs)
            if has_resolved_notice:
                field['value'] = '\n\n'.join(p for p in paragraphs
                    if not _SELECTOR_ONLY.fullmatch(p.strip()) and p.strip() not in _ROUTINE_PARAGRAPHS)
                if not field['value'] and not field.get('images') and not field.get('table') and not field.get('tables'):
                    continue
        fields.append(field)
    item['fields'] = fields
