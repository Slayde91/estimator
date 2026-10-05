"""Read-only steel surface quantities, separate from boxed board purchasing.

Reuse the retained nominal exposed-profile girths in the steel catalogue.
Neither a boxed section factor nor a board girth is a steel-profile perimeter.
Missing geometry/exposure stays unavailable, never a partial numeric total.
"""

from functools import lru_cache
import math
import re

from .excel_engine import WorkbookEngine
from .workbook_catalog import load_workbook_catalog


AREA_BASIS = (
    'Net Steel sqm uses the retained nominal exposed steel-profile girth times '
    'total lineal metres. Each schedule line counts once per product/thickness, '
    'including when both board layers have that thickness. Board layers, waste '
    'and additional-board allowances do not multiply steel area. Different '
    'thickness rows can include the same member; do not sum them as unique steel area.'
)


def _positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def _section_key(value):
    # Only typographic spaces/case differ between the two retained catalogues.
    # Keep every digit, decimal and suffix: no rounded-mass or guessed aliases.
    return re.sub(r'\s+', '', value).casefold() if isinstance(value, str) else ''


@lru_cache(maxsize=1)
def _profile_catalogue():
    model = load_workbook_catalog('steel_vermiculite')
    engine = WorkbookEngine(model, {})
    cells = next(sheet['cells'] for sheet in model['sheets'] if sheet['name'] == 'SECTIONS')
    profiles = {}
    # This is the source's named geometry range, not the later fire-factor tables.
    for row in range(6, 561):
        section = cells.get(f'A{row}', {}).get('value')
        key = _section_key(section)
        if not key:
            continue
        if key in profiles:
            raise ValueError('Duplicate retained steel-profile identity.')
        profiles[key] = {
            'section': section,
            'depth': engine.value('SECTIONS', f'C{row}'),
            'width': engine.value('SECTIONS', f'D{row}'),
            'girths': {sides: engine.value('SECTIONS', f'{column}{row}')
                      for sides, column in ((3, 'E'), (4, 'F'))},
            'holds': {sides: engine.value('SECTIONS', f'{column}{row}')
                     for sides, column in ((3, 'BA'), (4, 'BB'))},
        }
    return profiles, model['source']


def _line_area(engine, row, profiles):
    def value(column):
        return engine.value('CALCULATOR', f'{column}{row}')

    if not _positive(value('F')):
        return None, 'Enter positive total lineal metres.'
    section = value('D')
    if not isinstance(section, str) or not section:
        return None, 'Choose a Steel ID with retained exposed-profile data.'
    if value('BB'):
        return None, 'Steel source geometry is flagged; review the section data.'
    if any(value(column) not in (None, '') for column in ('R', 'S', 'T', 'U')):
        return None, 'Custom steel geometry needs a verified exposed-profile girth.'
    sides, layout = value('G'), value('BJ')
    if layout != 'Standard' or sides not in (3, 4):
        return None, 'Retained profile girths cover Standard exposure with 3 or 4 sides.'
    profile = profiles.get(_section_key(section))
    if profile is None:
        return None, f'No retained exposed-profile girth for Steel ID {section}.'
    # A typographic ID match cannot silently substitute different source geometry.
    for column, property_name in (('BL', 'depth'), ('BM', 'width')):
        actual, retained = value(column), profile[property_name]
        if not _positive(actual) or not _positive(retained) or not math.isclose(actual, retained, rel_tol=0, abs_tol=1e-9):
            return None, 'Board and steel-profile dimensions differ; review the section data.'
    girth = profile['girths'][sides]
    if profile['holds'][sides] or not _positive(girth):
        return None, f'No usable retained {sides}-side profile girth for Steel ID {section}.'
    area = girth * value('F')
    if not math.isfinite(area):
        return None, 'Steel surface area exceeds the supported numeric range.'
    return area, None


def board_net_steel_areas(engine):
    """Group each schedule line once in each stock thickness it actually uses."""
    profiles, source = _profile_catalogue()
    rows = []
    groups = {}
    for row in range(12, 30):
        product = engine.value('BOARD SUMMARY', f'A{row}')
        thickness = engine.value('BOARD SUMMARY', f'B{row}')
        result = {'row': row, 'product': product, 'thickness_mm': thickness,
                  'net_steel_sqm': 0, 'issues': []}
        rows.append(result)
        groups[(product.casefold(), thickness)] = (result, [])
    unassigned = []
    schedule = engine.model['schedule']
    for row in range(schedule['first_row'], schedule['last_row'] + 1):
        if engine.value('CALCULATOR', f'BD{row}') != 1:
            continue
        line = row - schedule['first_row'] + 1
        product = engine.value('CALCULATOR', f'C{row}')
        # A set removes the duplicate when two layers have the same thickness.
        thicknesses = {engine.value('CALCULATOR', f'{column}{row}') for column in ('AJ', 'AK')}
        targets = [groups[(product.casefold(), thickness)] for thickness in thicknesses
                   if isinstance(product, str) and _positive(thickness)
                   and (product.casefold(), thickness) in groups]
        if not targets:
            unassigned.append({'line': line, 'message': 'Choose a valid product and resolve its board thickness.'})
            continue
        area, issue = _line_area(engine, row, profiles)
        for result, areas in targets:
            if issue:
                result['issues'].append({'line': line, 'message': issue})
            else:
                areas.append((line, area))
    for result, areas in groups.values():
        try:
            result['net_steel_sqm'] = None if result['issues'] else math.fsum(area for _, area in areas)
        except OverflowError:
            result['net_steel_sqm'] = None
            result['issues'].extend({'line': line, 'message': 'Combined steel area exceeds the supported numeric range.'}
                                    for line, _ in areas)
    notes = []
    for result in rows:
        notes.extend(_issue_notes(result['issues'], f"{result['product']} {result['thickness_mm']:g} mm"))
    notes.extend(_issue_notes(unassigned, 'Unassigned steel area'))
    return {'rows': rows, 'unassigned': unassigned, 'basis': AREA_BASIS, 'notes': notes,
            'profile_source': {'filename': source['filename'], 'sha256': source['sha256']}}


def steel_area_display(result):
    """Consistent explanatory text in the browser, PDF and values-only register."""
    if not result['issues']:
        return result['net_steel_sqm']
    count = len(result['issues'])
    return f"Unavailable ({count} {'line' if count == 1 else 'lines'})"


def _issue_notes(issues, label):
    reasons = {}
    for issue in issues:
        reasons.setdefault(issue['message'], []).append(issue['line'])
    notes = []
    for reason, lines in reasons.items():
        ranges = []
        for line in sorted(set(lines)):
            if ranges and line == ranges[-1][1] + 1:
                ranges[-1][1] = line
            else:
                ranges.append([line, line])
        # Bound paragraphs for exports even when unrelated lines alternate.
        for offset in range(0, len(ranges), 30):
            text = ', '.join(str(start) if start == end else f'{start}-{end}'
                             for start, end in ranges[offset:offset + 30])
            notes.append(f'{label}, lines {text}: {reason}')
    return notes
