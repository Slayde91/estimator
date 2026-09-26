"""Build private barrier-table reviews from explicitly reviewed source rows.

This is an import helper, not a runtime inference engine. The caller reviews PDF
cell spans, supplies every corresponding row, and chooses one stated maximum
opening. Original source fields and assets are never changed. A combined table
is bound to its attached PDF and first source page; the import receipt retains
the remaining per-row page and geometry evidence.
"""

from copy import deepcopy
import re

from .technical_configuration_review import validate_configuration_review
from .technical_field_reviewed import review_fingerprint
from .technical_rating_summary import summarize_ratings
from .technical_table_navigation import field_tables, validate_table_navigation


_COLUMNS = ['Max Aperture Size', 'Separating Element', 'FRL']
_TARGET = 'Barrier Construction'
_TRIPLE = re.compile(r'(?<![\w/])(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)(?![\w/])')


def _flow(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Reviewed barrier values must be nonempty strings')
    return ' '.join(value.split())


def _fingerprint(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValueError('Invalid reviewed barrier fingerprint')
    return value


def _stated_phrase(phrase, cell):
    # A reviewed "300 mm" cannot match the tail of "1300 mm".
    return re.search(r'(?<![\w.])' + re.escape(phrase) + r'(?!\w|\.[0-9])', cell, re.I) is not None


def _add_link(field, target):
    links = field.setdefault('table_links', [])
    if target not in links:
        links.append(deepcopy(target))


def build_barrier_review(source, projected_fields, *, rows, row_ids,
                         source_document_id, source_page, source_sha256,
                         source_fields_sha256, pre_review_fields_sha256,
                         source_documents, maximum_opening,
                         reviewed_ratings=None, supporting_ratings=None,
                         preserved_conditions=()):
    """Return a source-bound review without modifying any argument.

    ``rows`` and ``row_ids`` are the complete source-review inventory, not
    independent lists inferred from flattened text. ``reviewed_ratings`` may
    select the literal blank-seal rating in each qualified FRL cell. Optional
    ``supporting_ratings`` explicitly inventories differently labelled support
    ratings in each row; these never increase the blank-seal summary. Every
    source rating must be accounted for and conditions stay in the cell. No fire
    rating or maximum dimension is calculated from separate components.

    Existing unrelated fields, tables, editorial metadata and proofs survive.
    Callers must also load the resulting candidate with ReferenceLibrary and
    independently compare it with the PDF review before installing it.
    """
    if source_fields_sha256 != review_fingerprint(source.get('fields')):
        raise ValueError('Barrier source fields changed; review must be updated')
    _fingerprint(source_sha256)
    _fingerprint(pre_review_fields_sha256)
    if (not isinstance(rows, list) or not rows or len(rows) > 2000
            or any(not isinstance(row, list) or len(row) != 3 for row in rows)
            or not isinstance(row_ids, list) or len(row_ids) != len(rows)
            or any(not isinstance(value, str) or not value.strip() or len(value) > 500
                   for value in row_ids) or len(set(row_ids)) != len(row_ids)):
        raise ValueError('Invalid complete barrier row inventory')
    flowed = [[_flow(cell) for cell in row] for row in rows]
    if len({tuple(row) for row in flowed}) != len(flowed):
        raise ValueError('Duplicate barrier relationships must be resolved by the source review')
    if any(re.search(r'\bSource\s+option\s+\d+\s*:', cell, re.I)
           for row in flowed for cell in row):
        raise ValueError('Source option labels must be resolved before table review')
    maxima = maximum_opening if isinstance(maximum_opening, list) else [maximum_opening]
    if not maxima:
        raise ValueError('Maximum opening requires a reviewed source value')
    maxima = list(dict.fromkeys(_flow(value) for value in maxima))
    if any(not any(_stated_phrase(value, row[0]) for row in flowed) for value in maxima):
        raise ValueError('Maximum opening must be stated in a reviewed aperture cell')
    maximum_opening = '; '.join(maxima)
    if reviewed_ratings is None:
        if supporting_ratings is not None:
            raise ValueError('Supporting ratings require an explicit blank-seal rating per row')
        ratings = [row[2] for row in flowed]
    else:
        if not isinstance(reviewed_ratings, list) or len(reviewed_ratings) != len(flowed):
            raise ValueError('Reviewed ratings must align with every barrier row')
        ratings = [_flow(value) for value in reviewed_ratings]
        supports = supporting_ratings if supporting_ratings is not None else [[] for _ in flowed]
        if (not isinstance(supports, list) or len(supports) != len(flowed)
                or any(not isinstance(values, list) for values in supports)):
            raise ValueError('Supporting ratings must align with every barrier row')
        for row, rating, other_ratings in zip(flowed, ratings, supports):
            if any(not isinstance(value, str) or not _TRIPLE.fullmatch(value) for value in other_ratings):
                raise ValueError('Invalid reviewed supporting rating')
            matches = {re.sub(r'\s+', '', match.group()) for match in _TRIPLE.finditer(row[2])}
            if matches != {rating, *other_ratings} or not _TRIPLE.fullmatch(rating):
                raise ValueError('Reviewed summary rating must match its source table cell')
    rating_summary = summarize_ratings(ratings)
    if not rating_summary['summary']:
        raise ValueError('Barrier FRL summary requires reviewed, complete source ratings')

    review = deepcopy(source.get('technical_field_review', {}))
    if review and (review.get('source_fields_sha256') != source_fields_sha256
                   or review.get('pre_review_fields_sha256') != pre_review_fields_sha256):
        raise ValueError('Existing editorial review changed; update the row review')
    fields = deepcopy(projected_fields)
    if (not isinstance(fields, list)
            or any(not isinstance(field, dict) or not isinstance(field.get('label'), str)
                   or not isinstance(field.get('value'), str) for field in fields)
            or len({field['label'] for field in fields}) != len(fields)):
        raise ValueError('Barrier projection requires unique, valid field labels')
    validate_table_navigation(fields)
    by_label = {field['label']: field for field in fields}
    for label in (_TARGET, 'Blank Seal FRL', 'Maximum Opening Size'):
        if label not in by_label:
            raise ValueError(f'Missing barrier source field: {label}')
    owner = by_label[_TARGET]
    index = len(field_tables(owner))
    table = {'columns': list(_COLUMNS), 'rows': flowed}
    if table in field_tables(owner):
        raise ValueError('This barrier table already has a review; do not duplicate the import')
    if index:
        # Do not discard other reviewed source tables to add the new inventory.
        owner.setdefault('tables', []).append(table)
        if 'table_row_ids' not in owner:
            raise ValueError('Existing barrier tables need explicit row inventories')
        owner['table_row_ids'].append(deepcopy(row_ids))
        if 'table_captions' in owner:
            owner['table_captions'].append('Barrier construction alternatives')
    else:
        owner['table'] = table
        owner['table_row_ids'] = [deepcopy(row_ids)]
    owner['value'] = ''
    link = {'field': _TARGET, 'table_index': index}
    by_label['Blank Seal FRL']['value'] = rating_summary['summary']
    by_label['Maximum Opening Size']['value'] = maximum_opening
    for label in ('Blank Seal FRL', 'Maximum Opening Size'):
        _add_link(by_label[label], link)

    if preserved_conditions:
        if not isinstance(preserved_conditions, (list, tuple)):
            raise ValueError('Preserved barrier conditions must be a list')
        field = by_label.get('Installation Details')
        if field is None:
            field = {'label': 'Installation Details', 'value': ''}
            fields.append(field)
        for condition in preserved_conditions:
            condition = _flow(condition)
            if condition.casefold() not in ' '.join(field['value'].split()).casefold():
                field['value'] = '\n\n'.join(filter(None, [field['value'], condition]))
        _add_link(field, link)

    review.update(fields=fields, source_fields_sha256=source_fields_sha256,
                  pre_review_fields_sha256=pre_review_fields_sha256)
    proof = {'row_ids': deepcopy(row_ids), 'tables': [{
        'label': _TARGET, 'table_index': index, 'sha256': review_fingerprint(table)}]}
    sources = review.setdefault('configuration_sources', [])
    existing = next((entry for entry in sources if entry['asset_id'] == source_document_id
                     and entry['page'] == source_page), None)
    if existing is not None:
        if existing['sha256'] != source_sha256:
            raise ValueError('Configuration source changed; review must be updated')
        existing['groups'].append(proof)
    else:
        sources.append({'asset_id': source_document_id, 'sha256': source_sha256,
                        'page': source_page, 'groups': [proof]})
    validate_table_navigation(fields)
    validate_configuration_review(review, source, source_documents)
    return review
