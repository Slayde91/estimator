"""Build a private, verified Technical Library bundle from a Trafalgar capture.

This command does not download files, install a bundle, edit SQLite or infer fire
ratings. Captured selector IDs remain distinct even when their displayed values
are identical. Only this importer's previously recorded objects are replaced.
"""

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from estimator.reference_library import MAX_INDEX, ReferenceLibrary, identifier

IMPORT_KEY = 'trafalgar_selector_import'
SCHEMA_VERSION = 1
CATEGORIES = {'fire-protection', 'access-panel', 'fire-collar-selector', 'ryanbatt'}
FIELD_LABELS = {
    'trafalgar system recommendation': 'System Recommendation',
    'services': 'Service', 'service size': 'Service Size',
    'twrap length': 'Service Wrap', 'wrap length': 'Service Wrap',
    'report number': 'Report Number', 'frl': 'FRL',
    'max opening size': 'Max Opening Size',
    'fill depth / fillet size': 'Fill Depth / Fillet Size',
    'collar': 'Collar', 'edge profile': 'Edge Profile', 'lead time': 'Lead Time',
}


def digest(content):
    return hashlib.sha256(content).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                       allow_nan=False) + '\n').encode('utf-8')


def read_json(path):
    payload = Path(path).read_bytes()
    return json.loads(payload.decode('utf-8-sig')), digest(payload)


def checked_path(root, filename, folder):
    """Accept a prepared-root relative filename or a basename in its asset folder."""
    if not isinstance(filename, str) or not filename:
        raise ValueError('An available source asset needs a filename.')
    relative = Path(filename)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Prepared asset filenames must remain inside their directory.')
    if len(relative.parts) == 1:
        relative = Path(folder) / relative
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Prepared asset is outside its directory.')
    return path


def unique(values, key, label):
    result = {}
    for value in values:
        identity = value[key]
        if identity in result:
            raise ValueError(f'Duplicate {label}: {identity}')
        result[identity] = value
    return result


def public_data(library):
    data = library._load()
    if data is None:
        raise ValueError('The base bundle does not contain library.json.')
    return deepcopy({key: value for key, value in data.items() if not key.startswith('_')})


def capture_queries(section):
    queries = unique(section.get('queries', []), 'query_id', 'selector query')
    evidence = {}
    for key, query in queries.items():
        evidence[key] = {name: deepcopy(value) for name, value in query.items()
                         if name != 'response_html'}
        if 'response_html' in query:
            evidence[key]['response_html_sha256'] = digest(query['response_html'].encode('utf-8'))
    return queries, evidence


def query_context(section, matched_queries):
    """Display source search tuples without converting them into technical rules."""
    definitions = {field['field_name']: field['label']
                   for field in section.get('field_definitions', [])}
    names = list(dict.fromkeys(name for query in matched_queries
                              for name in query.get('selected_options', {})))
    labels = [definitions.get(name, name.replace('_', ' ').replace('-', ' ').title()) for name in names]
    rows = [[query['query_id']] + [query.get('selected_options', {}).get(name, {}).get('label', '')
                                  for name in names] for query in matched_queries]
    fields = []
    for name in names:
        if name.endswith(('fire-barrier', 'fire-barrier-spec')) or name == 'pa_fire-barrier':
            label = 'Substrate (Selector Search)'
        elif name.endswith('fire-barrier-type') or name == 'pa_fire-barrier-type':
            label = 'Fire Barrier Type (Selector Search)'
        else:
            continue
        choices = [query.get('selected_options', {}).get(name) for query in matched_queries]
        if choices and all(choice and not choice.get('is_all') and not choice.get('is_placeholder')
                           and not choice.get('disabled') and choice.get('label')
                           and choice['label'].casefold() != 'all' for choice in choices):
            if len({choice['label'] for choice in choices}) == 1:
                fields.append({'label': label, 'value': choices[0]['label']})
    if rows:
        fields.append({'label': 'Selector Search Context',
                       'value': 'These are the exact searches that returned this record. '
                                'Search options, including All, are not additional system requirements.',
                       'table': {'columns': ['Search ID'] + labels, 'rows': rows}})
    return fields


def build_bundle(capture_path, manifest_path, prepared_directory, base_directory, output_directory):
    """Return an audit receipt; an identical existing output is a verified no-op."""
    capture_path, manifest_path = Path(capture_path), Path(manifest_path)
    prepared, base, output = map(lambda value: Path(value).resolve(),
                                 (prepared_directory, base_directory, output_directory))
    for source in (base, prepared):
        if source == output or output.is_relative_to(source) or source.is_relative_to(output):
            raise ValueError('Base, prepared and output bundles must be separate directories.')
    capture, capture_hash = read_json(capture_path)
    manifest, manifest_hash = read_json(manifest_path)
    document_index, index_hash = read_json(prepared / 'documents-index.json')
    if document_index.get('source_capture_sha256', capture_hash) != capture_hash:
        raise ValueError('The prepared document index belongs to a different selector capture.')
    if document_index.get('manifest_sha256', manifest_hash) != manifest_hash:
        raise ValueError('The prepared document index belongs to a different source manifest.')
    ocr_index, ocr_hash = read_json(prepared / 'ocr-index.json') if (prepared / 'ocr-index.json').exists() else ({}, None)
    if ocr_index.get('source_capture_sha256', capture_hash) != capture_hash:
        raise ValueError('The OCR evidence belongs to a different selector capture.')
    ocr_images = unique(ocr_index.get('images', []), 'image_sha256', 'OCR image fingerprint')
    enrichment_path = prepared / 'document-enrichment.json'
    enrichment, enrichment_hash = read_json(enrichment_path) if enrichment_path.exists() else ({'documents': []}, None)
    enrichment_rows = enrichment.get('documents', enrichment.get('rows', [])) if isinstance(enrichment, dict) else enrichment
    reviewed_documents = unique([dict(value, document_id=value['document_id'].casefold())
                                 for value in enrichment_rows], 'document_id', 'document enrichment')
    declared_capture = manifest.get('metadata', {}).get('source_capture_sha256')
    if declared_capture and declared_capture != capture_hash:
        raise ValueError('The manifest belongs to a different selector capture.')
    manifest_documents = unique(manifest['documents'], 'source_url', 'manifest source URL')
    unique(manifest['documents'], 'document_id', 'manifest document ID')
    prepared_documents = unique(document_index['documents'], 'document_id', 'prepared document ID')
    # Accept case changes to external document IDs, but never ambiguous matches.
    by_document_id = unique([dict(value, document_id=value['document_id'].casefold())
                             for value in prepared_documents.values()], 'document_id',
                            'case-insensitive prepared document ID')
    base_library = ReferenceLibrary(base)
    data = public_data(base_library)
    previous = data.get(IMPORT_KEY, {})
    if previous and previous.get('schema_version') != SCHEMA_VERSION:
        raise ValueError('Unsupported prior Trafalgar import ownership metadata.')
    old_records = set(previous.get('owned_technical_ids', []))
    old_documents = set(previous.get('owned_document_ids', []))
    old_images = set(previous.get('owned_image_ids', []))
    data['libraries']['technical']['items'] = [item for item in data['libraries']['technical']['items']
                                               if item['id'] not in old_records]
    data['documents'] = [item for item in data['documents'] if item['id'] not in old_documents]
    data['images'] = [item for item in data.get('images', []) if item['id'] not in old_images]
    foreign_records = {item['id'] for item in data['libraries']['technical']['items']}
    foreign_assets = {item['id'] for item in data['documents'] + data['images']}
    new_documents, new_images, asset_files, document_details = {}, {}, {}, {}

    def add_asset(asset, source, pdf):
        key = identifier(asset['id'])
        if key in foreign_assets:
            raise ValueError(f'Trafalgar source asset conflicts with a foreign asset: {key}')
        payload = source.read_bytes()
        if digest(payload) != asset['sha256']:
            raise ValueError(f'Prepared source fingerprint mismatch: {source.name}')
        target = new_documents if pdf else new_images
        if key in target and target[key] != asset:
            raise ValueError(f'Conflicting prepared asset registration: {key}')
        other = new_images if pdf else new_documents
        if key in other:
            raise ValueError(f'Conflicting asset type: {key}')
        target[key] = asset
        asset_files[key] = source

    for source_url, entry in sorted(manifest_documents.items()):
        prepared_doc = by_document_id.get(entry['document_id'].casefold())
        if prepared_doc is None or prepared_doc.get('status') == 'missing':
            document_details[source_url] = {'document_id': entry['document_id'], 'status': 'missing',
                                            'source_url': source_url, 'pages': []}
            continue
        if prepared_doc.get('source_url', source_url) != source_url:
            raise ValueError(f'Prepared document URL mismatch: {entry["document_id"]}')
        document = deepcopy(prepared_doc)
        if entry.get('file_sha256') and entry['file_sha256'] != document.get('sha256'):
            raise ValueError(f'Prepared source hash disagrees with the manifest: {entry["document_id"]}')
        reviewed = reviewed_documents.get(entry['document_id'].casefold(), {})
        document.setdefault('fields', []).extend(deepcopy(reviewed.get('fields', [])))
        if reviewed.get('review_notes'):
            notes = reviewed['review_notes']
            document['review_notes'] = notes if isinstance(notes, str) else '\n'.join(notes)
        document['source_url'] = source_url
        pages = document.get('pages', [])
        if not pages:
            raise ValueError(f'Available document has no rendered pages: {entry["document_id"]}')
        if [page['page'] for page in pages] != list(range(1, len(pages) + 1)):
            raise ValueError(f'Source pages are missing, duplicated or out of order: {entry["document_id"]}')
        document['status'] = 'available'
        document['registered_pdf_id'] = None
        if document.get('pdf_filename'):
            path = checked_path(prepared, document['pdf_filename'], 'documents')
            if path.suffix.lower() != '.pdf':
                raise ValueError('Registered documents must be PDFs.')
            asset = {'id': path.stem, 'filename': path.name,
                     'sha256': document['sha256'], 'pages': len(pages)}
            add_asset(asset, path, True)
            document['registered_pdf_id'] = asset['id']
        for page in pages:
            path = checked_path(prepared, page['image_filename'], 'images')
            asset = {'id': path.stem, 'filename': path.name, 'extension': path.suffix.lower(),
                     'sha256': page['image_sha256']}
            add_asset(asset, path, False)
            page['registered_image_id'] = asset['id']
        document_details[source_url] = document

    sections_audit, query_evidence = [], {}
    new_records, seen_products, seen_records = [], set(), set()
    counts = Counter()
    sections = unique(capture['sections'], 'category', 'capture section')
    if set(sections) - CATEGORIES:
        raise ValueError('The capture contains an unsupported selector category.')
    for category, section in sorted(sections.items()):
        queries, evidence = capture_queries(section)
        query_evidence[category] = evidence
        section_count = Counter()
        for record in section['records']:
            product_id = record['source_product_id']
            if type(product_id) is not int or product_id < 1 or product_id in seen_products:
                raise ValueError(f'Invalid or duplicate source product ID: {product_id}')
            record_identity = (category, record['record_id'])
            if record_identity in seen_records:
                raise ValueError(f'Duplicate source record ID: {record_identity}')
            seen_products.add(product_id)
            seen_records.add(record_identity)
            key = f'trafalgar-selector-{product_id}'
            if key in foreign_records:
                raise ValueError(f'Trafalgar record conflicts with a foreign record: {key}')
            query_ids = record.get('query_ids', [])
            if len(query_ids) != len(set(query_ids)):
                raise ValueError(f'Duplicate query association for source product {product_id}')
            matched_queries = []
            for query_id in query_ids:
                if query_id not in queries:
                    raise ValueError(f'Missing query {query_id} for source product {product_id}')
                query = queries[query_id]
                if record['record_id'] not in query.get('record_ids', []):
                    raise ValueError(f'Query does not contain source record: {product_id}, {query_id}')
                matched_queries.append(query)
            fields = [{'label': 'ID', 'value': str(product_id)},
                      {'label': 'Manufacturer', 'value': 'Trafalgar'}]
            raw_fields = record.get('result_fields', [])
            values = {}
            for field in raw_fields:
                name, value = field['name'], field['value']
                if not isinstance(name, str) or not isinstance(value, str):
                    raise ValueError('Selector field labels and values must be source strings.')
                normalized = name.casefold()
                values.setdefault(normalized, []).append(value)
                if normalized != 'technical diagram':
                    fields.append({'label': FIELD_LABELS.get(normalized, name), 'value': value})
            context_fields = query_context(section, matched_queries)
            fields.extend(field for field in context_fields if 'table' not in field)
            figure_position = len(fields)
            sources, images, missing, linked = [], [], [], []
            urls = record.get('technical_diagram_urls', [])
            if len(urls) != len(set(urls)):
                raise ValueError(f'Duplicate source URL for source product {product_id}')
            for source_url in urls:
                document = document_details.get(source_url)
                if document is None or document['status'] == 'missing':
                    missing.append(source_url)
                    sources.append({'label': 'Linked source document unavailable in the supplied files',
                                    'source_url': source_url})
                    continue
                linked.append(document['document_id'])
                for field in document.get('fields', []):
                    allowed = field.get('source_product_ids')
                    if allowed is not None and product_id not in allowed:
                        continue
                    reference = field.get('scope') == 'reference'
                    if allowed is None and len(document['pages']) != 1 and not reference:
                        continue
                    label = field['label'] + (' (Source Reference)' if reference else '')
                    fields.append({'label': label, 'value': field['value']})
                if document.get('review_notes'):
                    fields.append({'label': 'Source Reference Review', 'value': document['review_notes']})
                for page in document['pages']:
                    caption = f'{document["source_filename"]} — source page {page["page"]}'
                    images.append({'id': page['registered_image_id'], 'caption': caption})
                    source = {'label': caption, 'filename': document['source_filename'],
                              'sha256': document['sha256'], 'source_url': source_url}
                    if document['registered_pdf_id']:
                        source.update(document_id=document['registered_pdf_id'], page=page['page'])
                    sources.append(source)
                    if page.get('text', '').strip():
                        text = page['text']
                        label = ('Source Diagram Details' if len(document['pages']) == 1 else
                                 f'Source Document Details — Page {page["page"]} '
                                 '(contains source alternatives; use matching selector context)')
                        for start in range(0, len(text), 90000):
                            fields.append({'label': label, 'value': text[start:start + 90000]})
                    ocr = ocr_images.get(page['image_sha256'])
                    if ocr and ocr.get('status') == 'ocr_complete' and ocr.get('text', '').strip():
                        confidence = ocr.get('confidence', 'not recorded')
                        text = (f'{caption}\nUnverified OCR transcript; check the diagram. '
                                f'OCR engine confidence: {confidence}.\n\n{ocr["text"]}')
                        for start in range(0, len(text), 90000):
                            fields.append({'label': f'Source Image Text — Page {page["page"]} (OCR; check diagram)',
                                           'value': text[start:start + 90000]})
            if not urls:
                status = 'No diagram link was present in the supplied selector record.'
                section_count['records_without_diagram_link'] += 1
            elif missing:
                status = f'{len(missing)} linked source document(s) were unavailable in the supplied files.'
                section_count['records_with_missing_documents'] += 1
            else:
                status = 'All linked source documents are available below.'
                section_count['records_with_all_documents'] += 1
            if linked:
                section_count['records_with_images'] += 1
            if any(len(document_details[url]['pages']) > 1 for url in urls if url in document_details):
                status += ' Multi-page references may contain several variants; all pages are retained without assigning other variants to this record.'
            fields.append({'label': 'Source Document Coverage', 'value': status})
            if images:
                fields.insert(figure_position, {'label': 'Refer Figure',
                                               'value': 'Full linked source pages; open an image to inspect it at full size.',
                                               'images': images})
            fields.extend(field for field in context_fields if 'table' in field)
            recommendation = record.get('recommendation', '')
            service = '; '.join(values.get('services', []))
            frl = '; '.join(values.get('frl', []))
            record_data = {
                'id': key, 'title': f'Trafalgar {product_id} — {recommendation}',
                'subtitle': ' · '.join(filter(None, [section['label'], service, frl])),
                'summary': recommendation, 'source_label': f'Trafalgar selector · {section["label"]}',
                'fields': fields, 'sources': sources,
                'filter_values': {'trafalgar_category': [section['label']], 'manufacturer': ['Trafalgar']},
                'selector_provenance': {'category': category, 'record': deepcopy(record),
                                        'capture_sha256': capture_hash, 'document_ids': linked,
                                        'unavailable_source_urls': missing},
            }
            if values.get('report number'):
                record_data['filter_values']['document'] = list(dict.fromkeys(values['report number']))
            new_records.append(record_data)
            section_count['records'] += 1
        counts.update(section_count)
        sections_audit.append({'category': category, 'label': section['label'],
                               'status': section.get('status'), 'coverage': deepcopy(section.get('coverage')),
                               'field_definitions': deepcopy(section.get('field_definitions', [])),
                               'complete_backend_database': section.get('complete_backend_database', False),
                               **dict(section_count)})
    new_records.sort(key=lambda item: int(item['selector_provenance']['record']['source_product_id']))
    data['libraries']['technical']['items'].extend(new_records)
    filters = data['libraries']['technical'].setdefault('filters', [])
    filter_names = {field['key'] for field in filters}
    for name, label in [('manufacturer', 'Manufacturer'), ('trafalgar_category', 'Trafalgar Category'), ('document', 'Report')]:
        if name not in filter_names:
            filters.append({'key': name, 'label': label})
    data['documents'].extend(new_documents[key] for key in sorted(new_documents))
    data['images'].extend(new_images[key] for key in sorted(new_images))
    audit = {'schema_version': SCHEMA_VERSION, 'capture_sha256': capture_hash,
             'manifest_sha256': manifest_hash, 'prepared_index_sha256': index_hash,
             'ocr_index_sha256': ocr_hash, 'document_enrichment_sha256': enrichment_hash,
             'owned_technical_ids': [item['id'] for item in new_records],
             'owned_document_ids': sorted(new_documents), 'owned_image_ids': sorted(new_images),
             'counts': dict(counts), 'sections': sections_audit, 'queries': query_evidence,
             'source_documents': {value['document_id']: value for value in document_details.values()},
             'ocr_evidence': {**ocr_index, 'images': [
                 {key: value for key, value in item.items() if key != 'words'}
                 for item in ocr_index.get('images', [])]},
             'complete_backend_database': False, 'technical_review_complete': False}
    data[IMPORT_KEY] = audit
    payload = json_bytes(data)
    if len(payload) > MAX_INDEX:
        raise ValueError('The generated index exceeds the reference-library size limit.')
    # Validate records, links and all assets before exposing a candidate output.
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.trafalgar-build-', dir=output.parent))
    try:
        (stage / 'documents').mkdir()
        (stage / 'images').mkdir()
        (stage / 'library.json').write_bytes(payload)
        assets = [(asset, True) for asset in data['documents']] + [(asset, False) for asset in data['images']]
        for asset, pdf in assets:
            extension = '.pdf' if pdf else asset['extension']
            destination = stage / ('documents' if pdf else 'images') / (asset['id'] + extension)
            if asset['id'] in asset_files:
                shutil.copyfile(asset_files[asset['id']], destination)
            else:
                content, _, _ = base_library.asset(asset['id'], pdf)
                destination.write_bytes(content)
        candidate = ReferenceLibrary(stage)
        overview = candidate.overview()
        for asset, pdf in assets:
            candidate.asset(asset['id'], pdf)
        unchanged = False
        if output.exists():
            if not (output / 'library.json').is_file() or (output / 'library.json').read_bytes() != payload:
                raise ValueError('Output already exists with different content; choose a new output directory.')
            existing = ReferenceLibrary(output)
            existing.overview()
            for asset, pdf in assets:
                existing.asset(asset['id'], pdf)
            unchanged = True
        else:
            stage.rename(output)
        return {'output_directory': str(output), 'unchanged': unchanged,
                'index_sha256': digest(payload), 'index_bytes': len(payload),
                'counts': dict(counts), 'pdfs': len(new_documents), 'images': len(new_images),
                'missing_documents': sum(value['status'] == 'missing' for value in document_details.values()),
                'libraries': overview['libraries'], 'capture_sha256': capture_hash,
                'manifest_sha256': manifest_hash, 'prepared_index_sha256': index_hash}
    finally:
        if (stage.exists() and stage.parent == output.parent and stage.name.startswith('.trafalgar-build-')
                and stage.resolve().is_relative_to(output.parent.resolve())):
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--prepared-documents', required=True, type=Path)
    parser.add_argument('--base-bundle', required=True, type=Path)
    parser.add_argument('--output-bundle', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build_bundle(args.capture, args.manifest, args.prepared_documents,
                                  args.base_bundle, args.output_bundle), ensure_ascii=False))


if __name__ == '__main__':
    main()
