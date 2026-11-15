"""Suppress single configuration rows already represented by the detail fields."""
import re

from .technical_fields import FIELD_ORDER
from .technical_table_navigation import TABLE_TARGET_FIELDS, field_tables


_RATING = re.compile(r'(?<![\w/])(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)(?![\w/])')
_BLANK_SEAL_COLUMNS = {
    'Max Aperture Size': 'Maximum Opening Size',
    'Separating Element': 'Barrier Construction',
    'FRL': 'Blank Seal FRL',
}
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


def _repeats(field, cell, owner, blank_seal):
    if field is None or not cell.strip() or (field is not owner and field_tables(field)):
        return False
    # Blank-seal reviews sometimes store the construction only in the row.
    if blank_seal and field is owner and not field['value'].strip():
        return True
    scalar, cell = _value(field['value']), _value(cell)
    if blank_seal and field['label'] in _OPENING_SIZE_LABELS:
        # The reviewed opening uses both x and × as dimension separators.
        scalar, cell = (text.replace(' × ', ' x ').replace(' ✕ ', ' x ') for text in (scalar, cell))
    return scalar == cell


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
        blank_seal = label == 'Barrier Construction' and set(columns) == _BLANK_SEAL_COLUMNS.keys()
        values = dict(zip(columns, rows[0]))
        if blank_seal:
            openings = _OPENING_SIZE_LABELS.intersection(by_label)
            if len(openings) != 1 or not _RATING.fullmatch(values['FRL'].strip()):
                continue
            labels = {**_BLANK_SEAL_COLUMNS, 'Max Aperture Size': openings.pop()}
            values = {labels[name]: cell for name, cell in values.items()}
        if not values.keys() <= _SCALAR_FIELDS or not all(
                _repeats(by_label.get(name), cell, owner, blank_seal) for name, cell in values.items()):
            continue
        target = {'field': label, 'table_index': 0}
        linked = [field for field in fields if target in field.get('table_links', [])]
        if (any(field['label'] not in values for field in linked)
                or any(_TABLE_POINTERS[label].search(field['value']) for field in fields)):
            continue
        if blank_seal and not owner['value'].strip():
            owner['value'] = values[label]
        for key in ('table', 'tables', 'table_captions', 'table_row_ids'):
            owner.pop(key, None)
        for field in linked:
            field['table_links'].remove(target)
            if not field['table_links']:
                del field['table_links']
