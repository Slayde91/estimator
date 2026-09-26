"""Source-bound presentation of Trafalgar installation information.

Raw transcripts remain import evidence. Display text must be either the source's
own instructions or a separately reviewed summary, never a raw OCR fallback.
"""

import hashlib
import json
import re


_STEP_MARKER = re.compile(r'^(\d+)[.)](?!\d)\s*')


def is_installation_field(label):
    return bool(re.match(r'^(?:installation (?:instructions|details)|application text extract|'
                         r'source (?:diagram|document) details|source image text)\b', label, re.I))


def is_hidden_field(label):
    return (is_installation_field(label)
            or bool(re.match(r'^t[ -]?card (?:number|no\b)', label, re.I))
            # Composite title-block extracts include the removed T-card/date
            # metadata; the selector FRL and original figure remain intact.
            or bool(re.match(r'^drawing identification\s*/\s*frl\b', label, re.I))
            or bool(re.match(r'^document\s+revision\b', label, re.I))
            or label.casefold() == 'selector search context')


def clean_instructions(text):
    """Join PDF line wraps, retaining every numbered step and technical value."""
    text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
    paragraphs = re.split(r'\n\s*\n|\n(?=\s*\d+[.)](?!\d)\s*\S)', text)
    return '\n'.join(_STEP_MARKER.sub(r'\1. ', re.sub(r'\s+', ' ', part).strip())
                     for part in paragraphs if part.strip())


def _instruction_identity(text):
    """Ignore layout spacing, never words, values, units or punctuation tokens."""
    # In particular, 1.5 and 15, 10-20 and 1020, and "do not" and "do" must
    # remain different. Token comparison also handles a missing space after a
    # comma/full stop without a fuzzy threshold that could erase a condition.
    return tuple(re.findall(r'\w+|[^\w\s]', clean_instructions(text).casefold()))


def _numbered_steps(text):
    """Only split an unambiguous, strictly increasing numbered instruction list."""
    result = []
    for line in text.splitlines():
        marker = _STEP_MARKER.match(line)
        if marker is None or len(re.findall(r'(?:^|\s)\d+[.)](?!\d)', line)) != 1:
            return None
        number = int(marker[1])
        if result and number <= result[-1][0]:
            return None
        result.append((number, line))
    return result or None


def _deduplicate_passages(parts):
    groups = []
    for page, text in sorted(parts, key=lambda part: part[0]):
        if not text:
            continue
        identity = _instruction_identity(text)
        repeated = next((group for group in groups if group.get('identity') == identity), None)
        if repeated is not None:
            for part in repeated['parts']:
                if page not in part['pages']:
                    part['pages'].append(page)
            continue

        steps = _numbered_steps(text)
        identities = {number: _instruction_identity(value) for number, value in steps or []}
        compatible = []
        combined = dict(identities)
        if steps:
            for group in groups:
                shared = combined.keys() & group.get('steps', {}).keys()
                # A different action at any shared step means a distinct
                # installation variant: retain the entire sequence and context.
                if shared and all(combined[number] == group['steps'][number] for number in shared):
                    compatible.append(group)
                    combined.update(group['steps'])
        if not compatible:
            groups.append({'identity': identity, 'steps': identities,
                           'parts': [{'text': value, 'pages': [page], 'number': number}
                                     for number, value in steps] if steps else
                                    [{'text': text, 'pages': [page]}]})
            continue
        target = compatible[0]
        target.pop('identity', None)
        incoming = [part for group in compatible[1:] for part in group['parts']]
        incoming.extend({'number': number, 'text': value, 'pages': [page]} for number, value in steps)
        for part in incoming:
            number = part['number']
            existing = next((value for value in target['parts'] if value['number'] == number), None)
            if existing is None:
                target['parts'].append(part)
            else:
                existing['pages'] = sorted(set(existing['pages']) | set(part['pages']))
        target['steps'] = combined
        target['parts'].sort(key=lambda part: part['number'])
        for merged in compatible[1:]:
            groups.remove(merged)

    result = []
    for group in groups:
        passages = []
        for part in group['parts']:
            pages = sorted(part['pages'])
            if passages and passages[-1]['pages'] == pages:
                passages[-1]['text'] += '\n' + part['text']
            else:
                passages.append({'text': part['text'], 'pages': pages})
        result.extend(passages)
    return result


def validate_installation_reviews(review, documents, capture_hash):
    if review.get('source_capture_sha256', capture_hash) != capture_hash:
        raise ValueError('Installation details belong to a different selector capture.')
    result = {}
    for row in review.get('documents', []):
        key = row['document_id'].casefold()
        if key in result:
            raise ValueError(f'Duplicate installation details document: {key}')
        source = documents.get(key)
        if (source is None or not row.get('source_sha256')
                or row['source_sha256'] != source.get('sha256')):
            raise ValueError(f'Installation details source fingerprint mismatch: {key}')
        pages = {page['page']: page for page in source.get('pages', [])}
        reviewed = {}
        for page in row.get('pages', []):
            number = page.get('page')
            if type(number) is not int or number not in pages:
                raise ValueError(f'Installation details reference an unavailable source page: {key}')
            if number in reviewed:
                raise ValueError(f'Duplicate installation details page: {key}, {number}')
            if page.get('image_sha256') != pages[number]['image_sha256']:
                raise ValueError(f'Installation details image fingerprint mismatch: {key}')
            kind, text = page.get('kind'), page.get('text')
            if kind not in {'instructions', 'summary', 'not_provided'} or not isinstance(text, str):
                raise ValueError(f'Invalid installation details review: {key}, {number}')
            if kind == 'not_provided':
                if text.strip() or not isinstance(page.get('reason'), str) or not page['reason'].strip():
                    raise ValueError('An empty installation review needs its evidence reason.')
            elif not text.strip():
                raise ValueError('Installation details must not contain an empty instruction or summary.')
            reviewed[number] = page
        result[key] = reviewed
    return result


def _installation_inputs(document, product_id):
    """Keep exact applicable source text for review binding before presentation."""
    parts = []
    for field in document.get('fields', []):
        if not re.match(r'^installation instructions\b', field['label'], re.I):
            continue
        allowed = field.get('source_product_ids')
        if allowed is not None and product_id not in allowed:
            continue
        if allowed is None and len(document['pages']) != 1 and field.get('scope') != 'reference':
            continue
        text = field['value']
        if not text.strip():
            continue
        page = field.get('source_page')
        if page is None and len(document['pages']) == 1:
            page = 1
        if page is None:
            raise ValueError('Multi-page installation instructions need a source page.')
        if type(page) is not int or page not in {value['page'] for value in document['pages']}:
            raise ValueError('Installation instructions reference an unavailable source page.')
        parts.append((page, text))
    reviewed = document.get('installation_review', {})
    for number, page in reviewed.items():
        if page['kind'] == 'instructions':
            parts.append((int(number), page['text']))
    if not parts:
        for page in document['pages']:
            number = page['page']
            review = reviewed.get(number)
            if review is None:
                raise ValueError(f'Missing reviewed installation summary: {document["document_id"]}, page {number}')
            if review['kind'] == 'summary':
                parts.append((number, review['text']))
    return parts


def _input_sha256(parts):
    payload = json.dumps(sorted(parts, key=lambda part: part[0]), ensure_ascii=False,
                         separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


def installation_input_sha256(document, product_id):
    """Fingerprint the exact instructions/summaries a record would display."""
    return _input_sha256(_installation_inputs(document, product_id))


def _reviewed_display_passages(document, parts):
    review = document['installation_display_review']
    if (not isinstance(review, dict) or not review.get('source_sha256')
            or review['source_sha256'] != document.get('sha256')):
        raise ValueError('Installation display review source fingerprint mismatch.')
    if review.get('input_sha256') != _input_sha256(parts):
        raise ValueError('Installation display review input fingerprint mismatch.')
    if not isinstance(review.get('reason'), str) or not review['reason'].strip():
        raise ValueError('Installation display review needs its source review reason.')
    source_pages = {page['page']: page for page in document['pages']}
    input_pages = {page for page, text in parts if text.strip()}
    reviewed_pages = set()
    if not isinstance(review.get('pages'), list):
        raise ValueError('Installation display review needs page/image bindings.')
    for page in review['pages']:
        number = page.get('page') if isinstance(page, dict) else None
        if type(number) is not int or number not in input_pages or number in reviewed_pages:
            raise ValueError('Installation display review has an invalid or repeated source page.')
        if (not page.get('image_sha256')
                or page['image_sha256'] != source_pages[number].get('image_sha256')):
            raise ValueError('Installation display review image fingerprint mismatch.')
        reviewed_pages.add(number)
    if not input_pages or reviewed_pages != input_pages:
        raise ValueError('Installation display review omits an applicable source page.')
    passages = review.get('passages')
    if not isinstance(passages, list) or not passages:
        raise ValueError('Installation display review needs nonempty passages.')
    displayed_pages, result = set(), []
    for passage in passages:
        if not isinstance(passage, dict):
            raise ValueError('Invalid installation display passage.')
        pages, text = passage.get('pages'), passage.get('text')
        if (not isinstance(pages, list) or not pages
                or any(type(page) is not int or page not in input_pages for page in pages)
                or pages != sorted(set(pages)) or not isinstance(text, str) or not text.strip()):
            raise ValueError('Invalid installation display passage text or source pages.')
        displayed_pages.update(pages)
        result.append({'text': text.strip(), 'pages': list(pages)})
    if displayed_pages != input_pages:
        raise ValueError('Installation display passages omit an applicable source page.')
    return result


def document_installation_details(document, product_id):
    """Prefer only explicit instructions from this linked document, if present."""
    parts = _installation_inputs(document, product_id)
    if 'installation_display_review' in document:
        return _reviewed_display_passages(document, parts)
    return _deduplicate_passages([(page, clean_instructions(text)) for page, text in parts])


def installation_field(documents, product_id):
    parts = []
    seen = set()
    for document in documents:
        # URL aliases for the same source bytes do not repeat the instructions.
        if document['sha256'] in seen:
            continue
        seen.add(document['sha256'])
        for passage in document_installation_details(document, product_id):
            text = passage['text']
            if len(documents) > 1 or len(document['pages']) > 1:
                pages = ', '.join(map(str, passage['pages']))
                label = f'Source page {pages}'
                if len(documents) > 1:
                    label = f'{document["source_filename"]} — {label.lower()}'
                text = f'{label}\n{text}'
            parts.append(text)
    return {'label': 'Installation Details', 'value': '\n\n'.join(parts)} if parts else None
