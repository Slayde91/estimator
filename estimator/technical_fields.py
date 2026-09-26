"""Deterministic presentation of imported Technical Library evidence.

The installed index remains the source of truth. This projection never changes
source files or assigns one source option's properties to another option.
"""

from copy import deepcopy
import json
import re
import unicodedata

from .technical_field_content import normalize_content
from .technical_field_options import normalize_options
from .technical_field_reviewed import normalize_reviewed_content


PROJECTION_VERSION = 1

# Every label in the reviewed 6,020-record library is handled explicitly. None
# means supporting provenance retained in technical_basis, not discarded data.
FIELD_LABELS = {
    'Aperture Seal Joints': 'Joint Treatment',
    'Collar': 'Collar',
    'Drawing number (diagram page 1) (Source Reference)': None,
    'Edge Profile': 'Edge Profile',
    'Fill Depth / Fillet Size': 'Seal Depth / Fillet Size',
    'Fire Barrier Type (Selector Search)': 'Barrier Type',
    'FRL': 'FRL',
    'FRL (Source Reference)': 'FRL',
    'FRL when Blank': 'Blank Seal FRL',
    'ID': 'ID',
    'Install Notes': 'Installation Details',
    'Installation Concept': 'Diagrams & Figures',
    'Installation concept': 'Diagrams & Figures',
    'Installation Details': 'Installation Details',
    'Lead Time': None,
    'Local Protection': 'Local Protection',
    'Local Protection (Source Reference)': 'Local Protection',
    'Local Protection - installation instruction (Source Reference)': 'Local Protection',
    'Local Protection - source callout (Source Reference)': 'Local Protection',
    'Local Protection - source callouts (Source Reference)': 'Local Protection',
    'Manufacturer': 'Manufacturer',
    'Max Aperture Size': 'Maximum Opening Size',
    'Max Opening Size': 'Maximum Opening Size',
    'Penetration seal description': 'Installation Details',
    'Product': 'System Products',
    # Protection contains wrap, sealing or both; content classification follows.
    'Protection': 'Protection',
    'Refer Figure': 'Diagrams & Figures',
    'Reference figure': 'Diagrams & Figures',
    'Report Number': 'Report Number',
    'Separating Element': 'Barrier Construction',
    'Service': 'Service',
    'Service (Source Reference)': 'Service',
    'Service - source footnote (Source Reference)': 'Service',
    'Service / core hole / annular gap (Source Reference)': 'Installation Details',
    'Service Description': 'Service',
    'Service Size': 'Service Size / Configuration',
    'Service spacing (Source Reference)': 'Service Spacing',
    'Service Wrap': 'Service Wrap',
    'Service Wrap (Source Reference)': 'Service Wrap',
    'Source / selector discrepancy (Source Reference)': 'Source Issues',
    'Source alternatives - approved services (Source Reference)': 'Source Options',
    'Source alternatives - collar fixing table (Source Reference)': 'Source Options',
    'Source alternatives - local protection configurations (Source Reference)': 'Source Options',
    'Source discrepancy': 'Source Issues',
    'Source discrepancy (diagram page 1) (Source Reference)': 'Source Issues',
    'Source Document Coverage': None,
    'Source numbering note (diagram page 1) (Source Reference)': None,
    'Source option alignment': None,
    'Source Reference Discrepancy (Source Reference)': 'Source Issues',
    'Source Reference Review': 'Source Issues',
    'Source table notes': None,
    'Substrate (Selector Search)': 'Barrier Construction',
    'Substrate / opening (Source Reference)': 'Installation Details',
    'Support Construction': 'Barrier Construction',
    'System Recommendation': 'System Products',
    'Type': 'Installation Type',
    'Wrap - drawing name (Source Reference)': 'Service Wrap',
    'Wrap - installation instruction (Source Reference)': 'Service Wrap',
    'Wrap - source callout (Source Reference)': 'Service Wrap',
}

# Historic import spellings use the same rules if an older bundle is installed.
LEGACY_LABELS = {
    'Report reference': 'Report Number',
    'Report Reference': 'Report Number',
    'Report number': 'Report Number',
    'Installation instructions': 'Installation Details',
    'Installation Instructions': 'Installation Details',
    'Application text extract': 'Installation Details',
    'Source diagram details': 'Installation Details',
    'T-card number': None,
    'T-Card Number': None,
    'Selector Search Context': None,
    'Document Revision': None,
    'Technical Basis': None,
}

_HIDDEN_LABELS = frozenset(label.strip().casefold()
                         for label, destination in {**FIELD_LABELS, **LEGACY_LABELS}.items()
                         if destination is None)


def is_hidden_technical_label(label):
    """Shared boundary for display, review validation and search exclusion."""
    return str(label).strip().casefold() in _HIDDEN_LABELS

FIELD_ORDER = (
    'ID', 'Manufacturer', 'System Products', 'Installation Type',
    'Barrier Type', 'Barrier Construction', 'Service',
    'Service Size / Configuration', 'Service Spacing', 'FRL',
    'Blank Seal FRL', 'Maximum Opening Size', 'Core Hole Diameter',
    'Annular Gap', 'Service Wrap',
    'Local Protection', 'Seal Depth / Fillet Size', 'Joint Treatment',
    'Collar', 'Edge Profile', 'Installation Details', 'Source Options',
    'Source Issues', 'Diagrams & Figures', 'Report Number',
)

_ROUTINE_REVIEW = (
    'Selected source-reference fields were visually transcribed. '
    'This is not a complete transcription or technical suitability approval; '
    'retain the original diagram and all its conditions.'
)
_RATING = re.compile(r'(?:-|\d+)\s*/\s*(?:-|\d+)\s*/\s*(?:-|\d+)')


def _key(value):
    """Ignore typography/spacing only; technical punctuation remains significant."""
    return ' '.join(unicodedata.normalize('NFKC', value).split()).casefold()


def _unique(values):
    seen = set()
    result = []
    for value in values:
        key = json.dumps(value, sort_keys=True, ensure_ascii=False)
        if key not in seen:
            result.append(value)
            seen.add(key)
    return result


def _meaningful(field):
    return bool(str(field.get('value', '')).strip() or field.get('images')
                or field.get('table') or field.get('tables') or field.get('table_links'))


def _merge_images(images):
    """One thumbnail per asset, with every caption and diagram role retained."""
    merged = {}
    for image in images:
        key = image['id']
        if key not in merged:
            merged[key] = deepcopy(image)
            merged[key]['roles'] = list(dict.fromkeys(image.get('roles', []) + ([image['role']] if image.get('role') else [])))
            merged[key]['captions'] = list(dict.fromkeys(image.get('captions', []) + ([image['caption']] if image.get('caption') else [])))
            continue
        previous = merged[key]
        previous['captions'] = list(dict.fromkeys(previous['captions'] + image.get('captions', []) + ([image['caption']] if image.get('caption') else [])))
        previous['caption'] = '\n'.join(previous['captions'])
        previous['roles'] = list(dict.fromkeys(previous.get('roles', []) + image.get('roles', []) + ([image['role']] if image.get('role') else [])))
        for name, value in image.items():
            if name not in {'caption', 'captions', 'role', 'roles'} and name not in previous:
                previous[name] = deepcopy(value)
    for image in merged.values():
        if len(image.get('roles', [])) > 1:
            image['role'] = ' / '.join(image['roles'])
        if not image.get('roles'):
            image.pop('roles', None)
        if not image.get('captions'):
            image.pop('captions', None)
    return list(merged.values())


def _merge_fields(fields):
    """Merge labels without flattening tables or losing source image captions."""
    referenced_table_fields = {
        link['field'] for field in fields for link in field.get('table_links', [])
        if isinstance(link, dict) and isinstance(link.get('field'), str)
    }
    groups = {}
    for field in fields:
        if not _meaningful(field):
            continue
        group = groups.setdefault(field['label'], [])
        group.append(field)
    merged = []
    for label, group in groups.items():
        field = {'label': label, 'value': ''}
        parts, seen_values, images, tables, source_labels = [], set(), [], [], []
        for source in group:
            value = source.get('value', '').strip()
            # A bare rating repeated beside the same qualified rating adds no
            # information. The qualification must remain with its rating.
            redundant_rating = label in {'FRL', 'Blank Seal FRL'} and _RATING.fullmatch(value) and any(
                _key(other.get('value', '')).startswith(_key(value) + ' (') for other in group)
            if value and not redundant_rating and _key(value) not in seen_values:
                parts.append(value)
                seen_values.add(_key(value))
            source_labels.extend(source.get('source_labels', [source['label']]))
            images.extend(deepcopy(source.get('images', [])))
            if source.get('table'):
                tables.append(deepcopy(source['table']))
            tables.extend(deepcopy(source.get('tables', [])))
            # Retain any future field metadata instead of silently dropping it.
            for name, value in source.items():
                if name not in {'label', 'value', 'images', 'table', 'tables', 'source_labels'}:
                    if name not in field:
                        field[name] = deepcopy(value)
                    elif field[name] != value:
                        field.setdefault('source_metadata', []).append({name: deepcopy(value)})
        field['value'] = '\n\n'.join(parts)
        field['source_labels'] = list(dict.fromkeys(source_labels))
        if images:
            field['images'] = _merge_images(images)
        # Captions identify source-specific table positions. Equal cell contents
        # can have different provenance; dropping one would redirect its links.
        if ('table_captions' not in field and 'table_row_ids' not in field
                and label not in referenced_table_fields):
            tables = _unique(tables)
        if len(tables) == 1:
            field['table'] = tables[0]
        elif tables:
            field['tables'] = tables
        merged.append(field)
    order = {label: i for i, label in enumerate(FIELD_ORDER)}
    return sorted(merged, key=lambda field: order.get(field['label'], len(order)))


def _source_options_title(label):
    title = re.sub(r'^Source alternatives - | \(Source Reference\)$', '', label)
    return title[:1].upper() + title[1:]


def _report_numbers(item):
    """Use structured report identifiers; do not parse dates/revisions from prose."""
    values = item.get('filter_values', {}).get('document', [])
    return [value for value in values if re.fullmatch(r'[A-Za-z]{2,}\s*[-/]?\s*\d[\w ./-]*', value)]


def normalize_technical_item(item):
    """Return a canonical deep copy, retaining original evidence out of the UI."""
    projected = deepcopy(item)
    existing_basis = projected.get('technical_basis', {})
    if existing_basis.get('projection_version') == PROJECTION_VERSION:
        return projected
    original_fields = deepcopy(projected.get('fields', []))
    technical_basis = deepcopy(existing_basis)
    technical_basis.update(projection_version=PROJECTION_VERSION,
                           source_fields=original_fields)
    review = projected.pop('technical_field_review', None)
    if review is not None:
        technical_basis['review'] = deepcopy(review)
    projected['technical_basis'] = technical_basis
    fields, ratings = [], []
    explicit_instructions = any(field['label'] in {
        'Installation Details', 'Install Notes', 'Penetration seal description',
        'Installation instructions', 'Installation Instructions',
    } and field.get('value', '').strip() for field in original_fields)
    for original in original_fields:
        old_label = original['label']
        new_label = None if is_hidden_technical_label(old_label) else FIELD_LABELS.get(old_label, LEGACY_LABELS.get(old_label, old_label))
        if old_label == 'Source Document Coverage':
            projected['diagram_status'] = original.get('value', '')
        if new_label is None:
            continue
        if explicit_instructions and old_label in {'Application text extract', 'Source diagram details'}:
            continue
        field = deepcopy(original)
        field['label'] = new_label
        field['source_labels'] = [old_label]
        if old_label == 'Source Reference Review':
            # Only the exact provenance-only boilerplate is hidden. Any novel
            # review note, clipping or ambiguity remains visible for review.
            field['value'] = field.get('value', '').replace(_ROUTINE_REVIEW, '').strip()
        if old_label.startswith('Source alternatives - ') and field.get('value', '').strip():
            field['value'] = _source_options_title(old_label) + ':\n' + field['value'].strip()
        if new_label == 'Diagrams & Figures':
            for image in field.get('images', []):
                image.setdefault('role', 'Installation concept' if old_label.lower() == 'installation concept' else 'Reference figure')
            if field.get('value', '').strip() == 'Full linked source pages; open an image to inspect it at full size.':
                field['value'] = ''
            elif field.get('value', '').strip():
                field['value'] = ('Installation concept' if old_label.lower() == 'installation concept' else 'Reference figures') + ': ' + field['value'].strip()
        if new_label == 'FRL' and field.get('value', '').strip():
            ratings.append((old_label, field['value'].strip()))
        fields.append(field)
    rating_sets = {tuple(sorted({re.sub(r'\s+', '', match) for match in _RATING.findall(value)})) for _, value in ratings}
    rating_sets.discard(())
    if len(rating_sets) > 1:
        for field in fields:
            if field['label'] == 'FRL' and field.get('value', '').strip():
                source = 'Source reference' if '(Source Reference)' in field['source_labels'][0] else ('Selector' if item.get('id', '').startswith('trafalgar-') else 'Record')
                field['value'] = source + ': ' + field['value']
        fields.append({'label': 'Source Issues', 'value': 'The recorded FRL values disagree. See the separately attributed values in FRL; their source conditions remain unresolved.', 'source_labels': [label for label, _ in ratings]})
    if not any(field['label'] == 'Report Number' and _meaningful(field) for field in fields):
        report_numbers = _report_numbers(item)
        if report_numbers:
            fields.append({'label': 'Report Number', 'value': '\n'.join(report_numbers), 'source_labels': ['Report filter']})
    if not any(field['label'] == 'Manufacturer' and _meaningful(field) for field in fields):
        manufacturers = item.get('filter_values', {}).get('manufacturer', [])
        if manufacturers:
            fields.append({'label': 'Manufacturer', 'value': '\n'.join(manufacturers), 'source_labels': ['Manufacturer filter']})
    # Content rules see individual source fields and their original labels before
    # merging, so mixed source callouts remain attributable to the right field.
    projected['fields'] = _merge_fields(normalize_reviewed_content(
        normalize_options(normalize_content(fields)), review, original_fields))
    return projected
