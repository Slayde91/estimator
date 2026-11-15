"""Suppress single configuration rows already represented by the detail fields."""
import re

from .technical_fields import FIELD_ORDER
from .technical_table_navigation import TABLE_TARGET_FIELDS, field_tables


_RATING = re.compile(r'(?<![\w/])(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)(?![\w/])')
_BLANK_SEAL_COLUMNS = {'Max Aperture Size', 'Separating Element', 'FRL'}
_OPENING_SIZE_LABELS = {'Maximum Opening Size', 'Max. Opening Size', 'Max Opening Size'}
# Report and diagram fields have specialised rendering. Other canonical text
# fields expose their scalar value, or in the case of selector IDs both
# renderers already hide their table column.
_SCALAR_FIELDS = (set(FIELD_ORDER) - {'Diagrams & Figures', 'Report Number'}) | _OPENING_SIZE_LABELS
_TABLE_POINTERS = {
    label: re.compile(re.escape(label) + r'\s+table\s+1\b', re.I) for label in TABLE_TARGET_FIELDS
}


def _value(text):
    """Ignore line wrapping, including around slashes inside a complete FRL."""
    return ' '.join(_RATING.sub(lambda match: ''.join(match[0].split()), text).split())


def _repeats(field, cell, owner):
    if field is None or (field is not owner and field_tables(field)):
        return False
    if not cell.strip():
        # An unspecified optional attribute contributes no extra detail when
        # the same field is also empty. The service size and ID must match.
        return field is not owner and field['label'] != 'ID' and not field['value'].strip()
    scalar, cell = _value(field['value']), _value(cell)
    if field['label'] == 'Installation Details':
        # Promat stores the fixing details as a standalone paragraph under the
        # full installation method and repeats that paragraph in the size row.
        return scalar == cell or any(_value(paragraph) == cell for paragraph in re.split(r'\n\s*\n', field['value']))
    return scalar == cell


def _blank_seal_values(by_label, owner, values):
    openings = _OPENING_SIZE_LABELS.intersection(by_label)
    if len(openings) != 1 or 'Blank Seal FRL' not in by_label:
        return None
    opening_label = openings.pop()
    opening = by_label[opening_label]
    rating = by_label['Blank Seal FRL']
    if field_tables(opening) or field_tables(rating):
        return None
    construction = values['Separating Element'].strip()
    if not construction or (owner['value'].strip() and not _repeats(owner, construction, owner)):
        return None
    aperture = values['Max Aperture Size'].strip()
    # Some scalar sizes omit an equivalent area or a source condition that
    # follows the identical dimensions. Transfer the complete source cell.
    scalar_size, row_size = (_value(text).replace(' × ', ' x ').replace(' ✕ ', ' x ')
                             for text in (opening['value'], aperture))
    if not scalar_size or not row_size.startswith(scalar_size):
        return None
    qualification = row_size[len(scalar_size):]
    if qualification and not re.fullmatch(r'[.,;](?:\s.*)?| (?:or|subject to)\b.*', qualification, re.I):
        return None
    row_rating = _value(values['FRL'])
    ratings = list(_RATING.finditer(row_rating))
    if len(ratings) != 1 or ratings[0].start() or ratings[0][0] != _value(rating['value']):
        return None
    if ratings[0].end() < len(row_rating):
        construction = f'{construction} ({row_rating})'
    return {opening_label: aperture, owner['label']: construction, 'Blank Seal FRL': rating['value']}


def present_redundant_tables(fields):
    """Modify the detail copy only, after variant selection and evidence checks.

    Compare the complete row to uniquely named scalar fields on this record.
    A multi-row table or a table alongside another table can represent separate
    options. A source caption or a link from an unrelated field can scope the
    row. Keep those intact, including their original indices.
    """
    by_label = {field['label']: field for field in fields}
    if len(by_label) != len(fields):
        return
    for owner in fields:
        label = owner['label']
        tables = field_tables(owner)
        if label not in TABLE_TARGET_FIELDS or len(tables) != 1:
            continue
        table = tables[0]
        columns = table['columns']
        rows = table['rows']
        if (len(rows) != 1 or not columns or len(rows[0]) != len(columns)
                or len(set(columns)) != len(columns)
                or owner.get('table_captions', []) not in ([], ['Reviewed source configuration'])):
            continue
        values = dict(zip(columns, rows[0]))
        blank_seal = label == 'Barrier Construction' and set(columns) == _BLANK_SEAL_COLUMNS
        if blank_seal:
            values = _blank_seal_values(by_label, owner, values)
            if values is None:
                continue
        elif not values.keys() <= _SCALAR_FIELDS or not all(
                _repeats(by_label.get(name), cell, owner) for name, cell in values.items()):
            continue
        target = {'field': label, 'table_index': 0}
        linked = [field for field in fields if target in field.get('table_links', [])]
        if (any(field['label'] not in values for field in linked)
                or any(_TABLE_POINTERS[label].search(field['value']) for field in fields)):
            continue
        if blank_seal:
            for name, value in values.items():
                by_label[name]['value'] = value
        for key in ('table', 'tables', 'table_captions', 'table_row_ids'):
            owner.pop(key, None)
        for field in linked:
            field['table_links'].remove(target)
            if not field['table_links']:
                del field['table_links']
