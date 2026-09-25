"""Source-bound presentation of Trafalgar installation information.

Raw transcripts remain import evidence. Display text must be either the source's
own instructions or a separately reviewed summary, never a raw OCR fallback.
"""

import re


def is_installation_field(label):
    return bool(re.match(r'^(?:installation (?:instructions|details)|application text extract|'
                         r'source (?:diagram|document) details|source image text)\b', label, re.I))


def is_hidden_field(label):
    return (is_installation_field(label)
            or bool(re.match(r'^t[ -]?card (?:number|no\b)', label, re.I))
            # Composite title-block extracts include the removed T-card/date
            # metadata; the selector FRL and original figure remain intact.
            or bool(re.match(r'^drawing identification\s*/\s*frl\b', label, re.I))
            or label.casefold() == 'selector search context')


def clean_instructions(text):
    """Join PDF line wraps, retaining every numbered step and technical value."""
    text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
    paragraphs = re.split(r'\n\s*\n|\n(?=\s*\d+[.)](?!\d)\s*\S)', text)
    return '\n'.join(re.sub(r'\s+', ' ', part).strip() for part in paragraphs if part.strip())


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


def document_installation_details(document, product_id):
    """Prefer only explicit instructions from this linked document, if present."""
    parts = []
    for field in document.get('fields', []):
        if not re.match(r'^installation instructions\b', field['label'], re.I):
            continue
        allowed = field.get('source_product_ids')
        if allowed is not None and product_id not in allowed:
            continue
        if allowed is None and len(document['pages']) != 1 and field.get('scope') != 'reference':
            continue
        text = clean_instructions(field['value'])
        if not text:
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
            parts.append((int(number), clean_instructions(page['text'])))
    if not parts:
        for page in document['pages']:
            number = page['page']
            review = reviewed.get(number)
            if review is None:
                raise ValueError(f'Missing reviewed installation summary: {document["document_id"]}, page {number}')
            if review['kind'] == 'summary':
                parts.append((number, review['text'].strip()))
    grouped = {}
    for number, text in sorted(parts, key=lambda part: part[0]):
        if not text:
            continue
        # Repeated steps on source pages are kept once, with every page locator.
        identity = re.sub(r'\s+', ' ', text).casefold()
        if identity not in grouped:
            grouped[identity] = {'text': text, 'pages': []}
        if number not in grouped[identity]['pages']:
            grouped[identity]['pages'].append(number)
    return list(grouped.values())


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
