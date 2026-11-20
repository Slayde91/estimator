"""Suppress single configuration rows already represented by the detail fields."""
import re

from .technical_configuration_text import (BARRIER, SERVICE_SIZE, SIZE_COLUMNS, WRAP_COLUMNS,
                                           clean_configuration_text, same_words, size_value, wrap_value)
from .technical_fields import FIELD_ORDER
from .technical_table_navigation import TABLE_TARGET_FIELDS, field_tables


_RATING = re.compile(r'(?<![\w/])(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)\s*/\s*(?:-|[0-9]+)(?![\w/])')
_BLANK_SEAL_COLUMNS = {'Max Aperture Size', 'Separating Element', 'FRL'}
_SELECTED_SERVICE_COLUMNS = {BARRIER, 'Service', SERVICE_SIZE, 'Service Wrap', 'FRL'}
_OPENING_SIZE_LABELS = {'Maximum Opening Size', 'Max. Opening Size', 'Max Opening Size'}
# Report and diagram fields have specialised rendering. Other canonical text
# fields expose their scalar value, or in the case of selector IDs both
# renderers already hide their table column.
_SCALAR_FIELDS = (set(FIELD_ORDER) - {'Diagrams & Figures', 'Report Number'}) | _OPENING_SIZE_LABELS
_TABLE_POINTERS = {
    label: re.compile(re.escape(label) + r'\s+table\s+1\b', re.I) for label in TABLE_TARGET_FIELDS
}
_REFERENCED_TABLE = {
    label: re.compile(re.escape(label) + r'\s+table\s+[1-9]\d*\b', re.I) for label in TABLE_TARGET_FIELDS
}
_SIZE_CAPTIONS = re.compile(
    r'Source table: [^\r\n]+\.pdf, page \d+\. Pipe size and TWrap length\.', re.I)
_SELECTED_BARRIER = re.compile(
    r'Selected reviewed substrate configuration; the stated rating and limits apply to this row and its '
    r'installation conditions\. Source: [^\r\n]+\.pdf, page \d+\. Source substrate and rating alternatives\.', re.I)
_RISF = re.compile(r'(?P<base>(?:-|\d+)/(?:-|\d+)/(?:-|\d+))\s*\+\s*(?P<risf>\d+)\s+RISF', re.I)
_PIPE_CEILING_REFERENCE = ('Use the pipe/wrap options together with the ceiling-substrate rating table and '
                           'the applicable wall-fixing conditions.')


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


def _remove_table(fields, owner, index, represented_labels):
    label = owner['label']
    # Numeric prose references and links can carry a condition absent from
    # the scalar fields. Preserve the whole table sequence in that case.
    if any(_REFERENCED_TABLE[label].search(field['value']) for field in fields):
        return False
    target = {'field': label, 'table_index': index}
    if any(target in field.get('table_links', []) and field['label'] not in represented_labels
           for field in fields):
        return False
    tables = field_tables(owner)
    tables.pop(index)
    owner.pop('table', None)
    owner.pop('tables', None)
    if tables:
        owner['table'] = tables[0]
    if len(tables) > 1:
        owner['tables'] = tables[1:]
    for key in ('table_row_ids', 'table_captions'):
        if key in owner:
            remaining = owner[key][:index] + owner[key][index + 1:]
            if remaining:
                owner[key] = remaining
            else:
                del owner[key]
    for field in fields:
        if 'table_links' not in field:
            continue
        links = [{**link, 'table_index': link['table_index'] - 1}
                 if link['field'] == label and link['table_index'] > index else link
                 for link in field['table_links'] if link != target]
        if links:
            field['table_links'] = links
        else:
            del field['table_links']
    return True


def _service_size_matches(table, size, wrap):
    if len(table['rows']) != 1:
        return False
    columns = [column.casefold() for column in table['columns']]
    cells = dict(zip(columns, table['rows'][0]))
    if len(cells) != len(columns):
        return False
    configuration = cells.pop('configuration', None)
    if configuration is not None and not re.fullmatch(r'Wrap configuration [1-9]\d*', configuration):
        return False
    sizes, wraps = cells.keys() & SIZE_COLUMNS, cells.keys() & WRAP_COLUMNS
    if len(cells) != 2 or len(sizes) != 1 or len(wraps) != 1:
        return False
    return (same_words(size_value(cells[sizes.pop()]), size_value(size))
            and same_words(wrap_value(cells[wraps.pop()]), wrap_value(wrap)))


def _barrier_value(value):
    value = re.sub(r'(?<=\d)\s*[×x]\s*(?=\d)', 'x', value, flags=re.I)
    return re.sub(r'(?<=\d)\s+(?=mm\b)', '', value, flags=re.I)


def _selected_construction_rating(table, construction):
    columns = [column.casefold() for column in table['columns']]
    if columns not in (['substrate', 'frl'], ['barrier construction', 'frl']):
        return ()
    return tuple(_value(row[1]) for row in table['rows']
                 if same_words(_barrier_value(row[0]), _barrier_value(construction)))


def _present_selected_configurations(fields, by_label):
    values = clean_configuration_text({label: field['value'] for label, field in by_label.items()})
    for label in (BARRIER, SERVICE_SIZE):
        if label in values:
            by_label[label]['value'] = values[label]

    size = by_label.get(SERVICE_SIZE, {})
    wrap = by_label.get('Service Wrap', {})
    size_tables = field_tables(size)
    size_captions = size.get('table_captions', [''] * len(size_tables))
    removed_size = False
    if size.get('value') and wrap.get('value') and not field_tables(wrap):
        for index in reversed(range(len(size_tables))):
            caption = size_captions[index]
            if (caption in ('', 'Reviewed source configuration', 'Selector summary; not a verified diagram configuration table.')
                    or _SIZE_CAPTIONS.fullmatch(caption)) and _service_size_matches(
                        size_tables[index], size['value'], wrap['value']):
                removed_size |= _remove_table(fields, size, index, {SERVICE_SIZE, 'Service Wrap'})

    barrier = by_label.get(BARRIER, {})
    frl = by_label.get('FRL', {})
    if not barrier.get('value') or not frl.get('value') or field_tables(frl):
        return
    barrier_tables = field_tables(barrier)
    candidates = [_selected_construction_rating(table, barrier['value']) for table in barrier_tables]
    distinct_ratings = {value for values in candidates for value in values}
    if len(distinct_ratings) != 1:
        return
    captions = barrier.get('table_captions', [''] * len(barrier_tables))
    for index in reversed(range(len(barrier_tables))):
        table, caption = barrier_tables[index], captions[index]
        if len(table['rows']) != 1 or not candidates[index]:
            continue
        selected = candidates[index][0]
        scoped = _SELECTED_BARRIER.fullmatch(caption)
        risf = _RISF.fullmatch(selected) if scoped else None
        previous = _value(frl['value'])
        if not scoped:
            continue
        if selected != previous and not (risf and risf['base'] == previous):
            continue
        if _remove_table(fields, barrier, index, {BARRIER, 'FRL'}):
            frl['value'] = selected
            if removed_size and 'Source Options' in by_label:
                options = by_label['Source Options']
                options['value'] = '\n\n'.join(part for part in options['value'].split('\n\n')
                                             if part != _PIPE_CEILING_REFERENCE)


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
    _present_selected_configurations(fields, by_label)
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
        if label == SERVICE_SIZE and values.keys() == _SELECTED_SERVICE_COLUMNS:
            # Compare this generated row using the same repeat-only cleanup as
            # its scalar fields. The source table and any differing cell stay intact.
            values = clean_configuration_text(values)
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
