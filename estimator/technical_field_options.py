"""Keep conditional service dimensions in one place without losing wrap pairing."""

from copy import deepcopy
import re


_SIZE = r'(?:\d+(?:\.\d+)?\s*(?:mm|DN|NB)|(?:DN|NB)\s*\d+)'
_NEXT_REQUIREMENT = r'(?=(?:\d+(?:\.\d+)?\s*(?:x\s*)?\d*\s*mm|[A-Z][\w-]*\s+for\b))'
_SPLIT = re.compile(r'(?:,\s*|\.\s+|\s+and\s+)' + _NEXT_REQUIREMENT, re.I)


def _identity(value):
    # NB and DN, diameter and wall thickness are deliberately not synonyms.
    return re.sub(r'\s+', '', value).casefold().rstrip('.')


def _tiers(value):
    """Parse only complete, explicit requirement/condition clauses.

    No sorting, range interpolation, inferred lower bound or FRL selection.
    Parenthesised exceptions and installation sentences remain intact.
    """
    if '\n' in value or any(c in value for c in '()'):
        return None
    clauses = _SPLIT.split(value.strip())
    result = []
    for clause in clauses:
        if not clause:
            return None
        # The first 'for' belongs to the service condition; otherwise the
        # explicitly written 'up to' starts the condition.
        split = re.search(r'\s+for\s+|\s+(?=up to\s+)', clause, re.I)
        if split is None:
            return None
        requirement, condition = clause[:split.start()].strip(), clause[split.end():].strip()
        if not requirement or not re.search(_SIZE, condition, re.I):
            return None
        if ',' in requirement or not re.search(r'\b(?:up to|pipes?|PEX|DN\s*\d+|NB\s*\d+)\b', condition, re.I):
            return None
        if not re.search(r'\d\s*mm\b|\b(?:guard|wrap)\b', requirement, re.I):
            # A named protection such as a guard is allowed only alongside
            # measured clauses, never interpreted as a length.
            if not re.fullmatch(r'[A-Za-z][\w-]*', requirement):
                return None
        if re.search(r'\b(?:floor|wall|foam|penetration|layer|FRL)\b', condition, re.I):
            return None
        result.append((condition, requirement))
    return result


def normalize_options(fields):
    """Give every service-size condition an explicit wrap cross-reference.

    Conditions are stored in Service Size / Configuration. A separate wrap
    table refers to stable row labels, so dimensions are not copied into both
    fields. Existing source tables and their associations are never flattened.
    """
    fields = deepcopy(fields)
    configurations = next((field for field in fields if field['label'] == 'Service Size / Configuration'
                           and not field.get('table') and not field.get('tables')), None)
    if configurations is None:
        return fields
    count = 0
    for field in fields:
        if field['label'] != 'Service Wrap' or field.get('table') or field.get('tables'):
            continue
        tiers = _tiers(field.get('value', ''))
        if not tiers:
            continue
        conditions, requirements = [], []
        for condition, requirement in tiers:
            count += 1
            name = f'Wrap configuration {count}'
            conditions.append([name, condition])
            requirements.append([name, requirement])
        size_table = {'columns': ['Configuration', 'Service size / condition'], 'rows': conditions}
        configurations.setdefault('tables', []).append(size_table)
        if any(_identity(configurations['value']) == _identity(condition) for condition, _ in tiers):
            configurations['value'] = ''
        field['value'] = 'Use the matching service configuration.'
        field['table'] = {'columns': ['Configuration', 'Wrap requirement'], 'rows': requirements}
    return fields
