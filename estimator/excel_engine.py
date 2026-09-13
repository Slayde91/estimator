"""Bounded scalar Excel formula interpreter for the imported calculator models.

Only the functions actually present in the three source workbooks are accepted.
Formula text is parsed, never executed as Python. Source caches are not results:
every requested value follows the original formula and its current inputs.
"""

from decimal import Decimal, ROUND_HALF_UP, localcontext
from functools import lru_cache
import math
import re


class FormulaError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def column_number(text):
    value = 0
    for character in text.upper():
        value = value * 26 + ord(character) - 64
    return value


def column_name(value):
    result = ""
    while value:
        value, digit = divmod(value - 1, 26)
        result = chr(65 + digit) + result
    return result


def coordinates(address):
    match = re.fullmatch(r"\$?([A-Z]{1,3})\$?([1-9]\d*)", address.upper())
    if not match:
        raise FormulaError("#REF!")
    return int(match[2]), column_number(match[1])


_ADDRESS = re.compile(r"(?<![A-Za-z0-9_.])(?P<col>\$?[A-Z]{1,3})(?P<row>\$?[1-9]\d*)(?![A-Za-z0-9_.]|\s*\()")
_STRINGS = re.compile(r'("(?:[^"]|"")*")')


def relative_formula(formula, row, column):
    """Share one syntax tree for copied rows without changing quoted literals."""
    def replace(match):
        col, r = match['col'], match['row']
        rr = r[1:] if r.startswith('$') else '[' + str(int(r) - row) + ']'
        cc = str(column_number(col[1:])) if col.startswith('$') else '[' + str(column_number(col) - column) + ']'
        return 'R' + rr + 'C' + cc
    return ''.join(part if index % 2 else _ADDRESS.sub(replace, part)
                   for index, part in enumerate(_STRINGS.split(formula.lstrip('='))))


_TOKEN = re.compile(
    r'\s*(?:'
    r'(?P<string>"(?:[^"]|"")*")|'
    r"(?P<sheet>'(?:[^']|'')+'!)|"
    r'(?P<reference>R(?:\[-?\d+\]|\d+)C(?:\[-?\d+\]|\d+))|'
    r'(?P<number>(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)|'
    r'(?P<error>\#(?:DIV/0!|N/A|NAME\?|NULL!|NUM!|REF!|VALUE!))|'
    r'(?P<word>[A-Za-z_][A-Za-z_0-9.]*)|'
    r'(?P<operator><>|<=|>=|[+\-*/^&=<>%,():!]))'
)
_PRIORITY = {'=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10,
             '&': 20, '+': 30, '-': 30, '*': 40, '/': 40, '^': 50, '%': 60, ':': 80}


@lru_cache(maxsize=16384)
def parse_formula(formula):
    tokens = []
    cursor = 0
    while cursor < len(formula):
        match = _TOKEN.match(formula, cursor)
        if not match:
            if not formula[cursor:].strip():
                break
            raise ValueError(f'Unsupported formula syntax near {formula[cursor:cursor + 60]!r}')
        tokens.append((match.lastgroup, match.group(match.lastgroup)))
        cursor = match.end()
    tokens.append(('end', ''))
    position = 0

    def peek():
        return tokens[position]

    def take():
        nonlocal position
        token = tokens[position]
        position += 1
        return token

    def expect(text):
        token = take()
        if token[1] != text:
            raise ValueError(f'Expected {text!r}, found {token!r} in formula')

    def reference(text, sheet=None):
        match = re.fullmatch(r'R(\[-?\d+\]|\d+)C(\[-?\d+\]|\d+)', text)
        return ('ref', sheet, match[1], match[2])

    def expression(minimum=0):
        kind, text = take()
        if kind == 'number':
            left = ('value', float(text))
        elif kind == 'string':
            left = ('value', text[1:-1].replace('""', '"'))
        elif kind == 'error':
            left = ('error', text)
        elif text in ('+', '-'):
            left = ('unary', text, expression(70))
        elif text == '(':
            left = expression()
            expect(')')
        elif kind == 'reference':
            left = reference(text)
        elif kind == 'sheet':
            sheet = text[1:-2].replace("''", "'")
            ref_kind, ref_text = take()
            if ref_kind != 'reference':
                raise ValueError('Expected a cell after worksheet name')
            left = reference(ref_text, sheet)
        elif kind == 'word':
            if peek()[1] == '!':
                take()
                ref_kind, ref_text = take()
                if ref_kind != 'reference':
                    raise ValueError('Expected a cell after worksheet name')
                left = reference(ref_text, text)
            elif peek()[1] == '(':
                take()
                arguments = []
                if peek()[1] != ')':
                    while True:
                        arguments.append(('value', None) if peek()[1] in (',', ')') else expression())
                        if peek()[1] != ',':
                            break
                        take()
                expect(')')
                left = ('call', text.upper(), tuple(arguments))
            elif text.upper() in ('TRUE', 'FALSE'):
                left = ('value', text.upper() == 'TRUE')
            else:
                left = ('name', text)
        else:
            raise ValueError(f'Unexpected formula token {kind}:{text}')
        while peek()[1] in _PRIORITY and _PRIORITY[peek()[1]] >= minimum:
            operator = take()[1]
            if operator == '%':
                left = ('unary', '%', left)
            else:
                right = expression(_PRIORITY[operator] + 1)
                left = ('binary', operator, left, right)
        return left

    result = expression()
    if peek()[0] != 'end':
        raise ValueError(f'Unexpected formula remainder {peek()!r}')
    return result


class CellRange:
    __slots__ = ('engine', 'sheet', 'r1', 'c1', 'r2', 'c2')

    def __init__(self, engine, sheet, r1, c1, r2=None, c2=None):
        self.engine, self.sheet = engine, sheet
        self.r1, self.c1 = r1, c1
        self.r2, self.c2 = r1 if r2 is None else r2, c1 if c2 is None else c2
        if min(self.r1, self.c1, self.r2, self.c2) < 1 or max(self.r1, self.r2) > 1048576 or max(self.c1, self.c2) > 16384:
            raise FormulaError('#REF!')

    @property
    def shape(self):
        return self.r2 - self.r1 + 1, self.c2 - self.c1 + 1

    def at(self, row, column):
        if not 0 <= row < self.shape[0] or not 0 <= column < self.shape[1]:
            raise FormulaError('#REF!')
        return self.engine.cell(self.sheet, self.r1 + row, self.c1 + column)

    def values(self):
        if self.shape[0] * self.shape[1] > 2_000_000:
            raise FormulaError('#NUM!')
        for row in range(self.shape[0]):
            for column in range(self.shape[1]):
                yield self.at(row, column)


def scalar(value):
    return value.at(0, 0) if isinstance(value, CellRange) else value


def numeric(value):
    value = scalar(value)
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            text = value.strip().replace(',', '')
            number = float(text[:-1]) / 100 if text.endswith('%') else float(text)
            if math.isfinite(number):
                return number
        except ValueError:
            pass
    raise FormulaError('#VALUE!')


def text_value(value):
    value = scalar(value)
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int, float)):
        if value == 0:
            return '0'
        return format(value, '.15g').replace('e+', 'E+').replace('e-', 'E-')
    return str(value)


def logical(value):
    value = scalar(value)
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str) and value.upper() in ('TRUE', 'FALSE'):
        return value.upper() == 'TRUE'
    raise FormulaError('#VALUE!')


def comparison(left, right):
    left, right = scalar(left), scalar(right)
    if left is None:
        left = '' if isinstance(right, str) else False if isinstance(right, bool) else 0
    if right is None:
        right = '' if isinstance(left, str) else False if isinstance(left, bool) else 0
    def key(value):
        if isinstance(value, bool):
            return 2, value
        if isinstance(value, (int, float)):
            return 0, value
        return 1, str(value).casefold()
    lkey, rkey = key(left), key(right)
    return (lkey > rkey) - (lkey < rkey)


def rounded(value, digits, up=False):
    value, digits = numeric(value), int(numeric(digits))
    if abs(digits) > 308:
        return value if digits > 0 else 0.0
    if up:
        scale = 10.0 ** digits
        scaled = abs(value) * scale
        if not math.isfinite(scaled):
            return value
        return math.copysign(math.ceil(scaled) / scale, value)
    with localcontext() as context:
        context.prec = max(35, abs(digits) + 325)
        return float(Decimal(str(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


class _WildcardPattern:
    __slots__ = ('tokens',)

    def __init__(self, pattern):
        tokens = []
        index = 0
        while index < len(pattern):
            character = pattern[index]
            if character == '~' and index + 1 < len(pattern):
                index += 1
                tokens.append(re.compile(re.escape(pattern[index]), re.I | re.S))
            elif character == '*':
                if not tokens or tokens[-1] != '*':
                    tokens.append('*')
            elif character == '?':
                tokens.append('?')
            else:
                # A literal token matches exactly one character. Retain the
                # existing case-insensitive behavior without regex repetition.
                tokens.append(re.compile(re.escape(character), re.I | re.S))
            index += 1
        self.tokens = tuple(tokens)

    def fullmatch(self, text):
        position = token_index = 0
        last_star = None
        star_position = 0
        while position < len(text):
            token = self.tokens[token_index] if token_index < len(self.tokens) else None
            if token == '*':
                last_star, star_position = token_index, position
                token_index += 1
            elif token == '?' or token is not None and token.fullmatch(text[position]):
                position += 1
                token_index += 1
            elif last_star is not None:
                # Retry only the most recent star, advancing its text boundary.
                # This bounds work by pattern length times text length instead
                # of the exponential backtracking of repeated regex .* tokens.
                star_position += 1
                position, token_index = star_position, last_star + 1
            else:
                return None
        while token_index < len(self.tokens) and self.tokens[token_index] == '*':
            token_index += 1
        return True if token_index == len(self.tokens) else None


@lru_cache(maxsize=256)
def wildcard(pattern):
    return _WildcardPattern(pattern)


def criteria_matches(value, criterion):
    value, criterion = scalar(value), scalar(criterion)
    if criterion is None:
        criterion = 0
    if not isinstance(criterion, str):
        return comparison(value, criterion) == 0
    match = re.match(r'^(<>|<=|>=|=|<|>)(.*)$', criterion, re.S)
    operator, wanted = (match[1], match[2]) if match else ('=', criterion)
    try:
        numeric_wanted = float(wanted) if wanted.strip() else None
    except ValueError:
        numeric_wanted = None
    if numeric_wanted is not None:
        if value is None:
            value = 0
        if isinstance(value, str):
            try:
                value = float(value)
            except ValueError:
                return operator == '<>'
        if isinstance(value, bool):
            return operator == '<>'
        difference = comparison(value, numeric_wanted)
    elif operator in ('=', '<>'):
        matches = wildcard(wanted).fullmatch('' if value is None else value) is not None if isinstance(value, str) or value is None else False
        return matches if operator == '=' else not matches
    else:
        if not isinstance(value, str):
            return False
        difference = comparison(value, wanted)
    return {'=': difference == 0, '<>': difference != 0, '<': difference < 0,
            '>': difference > 0, '<=': difference <= 0, '>=': difference >= 0}[operator]


class WorkbookEngine:
    """One immutable source model and one set of input overlays per evaluation."""

    def __init__(self, model, inputs=None, formula_overrides=None):
        self.model = model
        self.sheets = {sheet['name']: sheet for sheet in model['sheets']}
        self.sheet_names = {name.casefold(): name for name in self.sheets}
        self.inputs = inputs or {}
        self.formula_overrides = formula_overrides or {}
        self.cache = {}
        self.visiting = set()
        self.lookup_cache = {}
        self.lookup_indexes = {}
        self.evaluated_count = 0

    def cell(self, sheet, row, column):
        sheet = self.sheet_names.get(sheet.casefold(), sheet)
        if sheet not in self.sheets:
            raise FormulaError('#REF!')
        key = sheet, row, column
        if key in self.cache:
            value = self.cache[key]
            if isinstance(value, FormulaError):
                raise value
            return value
        if key in self.visiting:
            raise FormulaError('#REF!')
        address = column_name(column) + str(row)
        cell = self.sheets[sheet]['cells'].get(address, {})
        self.visiting.add(key)
        try:
            if address in self.inputs.get(sheet, {}):
                value = self.inputs[sheet][address]
            elif 'formula' in cell:
                formula = self.formula_overrides.get(sheet, {}).get(address, cell['formula'])
                tree = parse_formula(relative_formula(self.expand_tables(formula), row, column))
                value = scalar(self.evaluate(tree, sheet, row, column))
                # A formula referring to a genuinely empty cell yields zero.
                if value is None:
                    value = 0.0
                self.evaluated_count += 1
            elif cell.get('data_type') == 'e':
                raise FormulaError(cell.get('value', '#VALUE!'))
            else:
                value = cell.get('value')
            if isinstance(value, float) and not math.isfinite(value):
                raise FormulaError('#NUM!')
            self.cache[key] = value
            return value
        except FormulaError as error:
            self.cache[key] = error
            raise
        except (ZeroDivisionError, OverflowError) as exception:
            error = FormulaError('#DIV/0!' if isinstance(exception, ZeroDivisionError) else '#NUM!')
            self.cache[key] = error
            raise error
        finally:
            self.visiting.remove(key)

    def value(self, sheet, address):
        try:
            return self.cell(sheet, *coordinates(address))
        except FormulaError as error:
            return error.code

    def expand_tables(self, formula):
        """Resolve source Excel table columns to their exact data-row range."""
        def replace(match):
            table = next((table for name, table in self.model.get('tables', {}).items() if name.casefold() == match[1].casefold()), None)
            if table is None:
                raise ValueError(f'Unknown source table {match[1]}')
            first, last = table['ref'].split(':')
            r1, c1 = coordinates(first)
            r2, _ = coordinates(last)
            index = next((i for i, col in enumerate(table['columns']) if col['name'].casefold() == match[2].casefold()), None)
            if index is None:
                raise ValueError(f'Unknown source table column {match[2]}')
            column = column_name(c1 + index)
            sheet = table['sheet'].replace("'", "''")
            return f"'{sheet}'!${column}${r1 + table['header_row_count']}:${column}${r2 - table['totals_row_count']}"
        return ''.join(part if index % 2 else re.sub(r'([A-Za-z_][A-Za-z_0-9.]*)\[([^\[\]]+)\]', replace, part)
                       for index, part in enumerate(_STRINGS.split(formula)))

    def lookup_index(self, table, horizontal):
        key = (table.sheet, table.r1, table.c1, table.r2 if not horizontal else table.r1,
               table.c2 if horizontal else table.c1)
        if key in self.lookup_indexes:
            return self.lookup_indexes[key]
        values, exact, ordered_numbers, ordered_text = [], {}, [], []
        for index in range(table.shape[1] if horizontal else table.shape[0]):
            try:
                value = table.at(0, index) if horizontal else table.at(index, 0)
            except FormulaError:
                value = FormulaError('#N/A')
            values.append(value)
            if isinstance(value, FormulaError):
                continue
            if value is None:
                for blank_key in (('number', 0.0), ('text', ''), ('bool', False), ('blank', None)):
                    exact.setdefault(blank_key, index)
            elif isinstance(value, bool):
                exact.setdefault(('bool', value), index)
            elif isinstance(value, (int, float)):
                exact.setdefault(('number', float(value)), index)
                ordered_numbers.append((float(value), index))
            else:
                exact.setdefault(('text', value.casefold()), index)
                ordered_text.append((value.casefold(), index))
        data = values, exact, ordered_numbers, ordered_text
        self.lookup_indexes[key] = data
        return data

    def evaluate(self, node, sheet, row, column):
        kind = node[0]
        if kind == 'value':
            return node[1]
        if kind == 'error':
            raise FormulaError(node[1])
        if kind == 'ref':
            def position(text, origin):
                return origin + int(text[1:-1]) if text.startswith('[') else int(text)
            return CellRange(self, node[1] or sheet, position(node[2], row), position(node[3], column))
        if kind == 'name':
            formula = next((formula for name, formula in self.model.get('defined_names', {}).items() if name.casefold() == node[1].casefold()), None)
            if formula is None:
                raise FormulaError('#NAME?')
            return self.evaluate(parse_formula(relative_formula(formula, row, column)), sheet, row, column)
        if kind == 'unary':
            value = numeric(self.evaluate(node[2], sheet, row, column))
            return -value if node[1] == '-' else value / 100 if node[1] == '%' else value
        if kind == 'binary':
            operator = node[1]
            left = self.evaluate(node[2], sheet, row, column)
            right = self.evaluate(node[3], sheet, row, column)
            if operator == ':':
                if not isinstance(left, CellRange) or not isinstance(right, CellRange):
                    raise FormulaError('#VALUE!')
                # The second endpoint inherits the first endpoint's worksheet.
                return CellRange(self, left.sheet, left.r1, left.c1, right.r2, right.c2)
            if operator == '&':
                return text_value(left) + text_value(right)
            if operator in ('=', '<>', '<', '>', '<=', '>='):
                difference = comparison(left, right)
                return {'=': difference == 0, '<>': difference != 0, '<': difference < 0,
                        '>': difference > 0, '<=': difference <= 0, '>=': difference >= 0}[operator]
            left, right = numeric(left), numeric(right)
            if operator == '+':
                return left + right
            if operator == '-':
                return left - right
            if operator == '*':
                return left * right
            if operator == '/':
                if right == 0:
                    raise FormulaError('#DIV/0!')
                return left / right
            if operator == '^':
                try:
                    value = left ** right
                    if isinstance(value, complex):
                        raise FormulaError('#NUM!')
                    return value
                except (OverflowError, ZeroDivisionError):
                    raise FormulaError('#NUM!') from None
        if kind == 'call':
            return self.function(node[1], node[2], sheet, row, column)
        raise ValueError(f'Unsupported expression node {kind}')

    def function(self, name, nodes, sheet, row, column):
        def argument(index):
            return self.evaluate(nodes[index], sheet, row, column)
        def val(index):
            return scalar(argument(index))
        def num(index):
            return numeric(argument(index))
        def txt(index):
            return text_value(argument(index))
        if name == 'IF':
            if logical(argument(0)):
                return argument(1) if len(nodes) > 1 else 0
            return argument(2) if len(nodes) > 2 else False
        if name == 'IFERROR':
            try:
                value = argument(0)
                scalar(value)
                return value
            except FormulaError:
                return argument(1)
        if name == 'ISNUMBER':
            try:
                value = val(0)
                return isinstance(value, (int, float)) and not isinstance(value, bool)
            except FormulaError:
                return False
        if name == 'N':
            value = val(0)
            return float(value) if isinstance(value, (int, float)) else 0.0
        if name in ('AND', 'OR'):
            values = []
            for index in range(len(nodes)):
                value = argument(index)
                if isinstance(value, CellRange):
                    values.extend(logical(item) for item in value.values() if item is not None and not isinstance(item, str))
                else:
                    values.append(logical(value))
            if not values:
                raise FormulaError('#VALUE!')
            return all(values) if name == 'AND' else any(values)
        if name == 'NOT':
            return not logical(argument(0))
        if name in ('SUM', 'MIN', 'MAX', 'COUNTA'):
            values = []
            count = 0
            for index in range(len(nodes)):
                item = argument(index)
                if isinstance(item, CellRange):
                    for r in range(item.shape[0]):
                        for c in range(item.shape[1]):
                            try:
                                value = item.at(r, c)
                            except FormulaError:
                                if name == 'COUNTA':
                                    count += 1
                                    continue
                                raise
                            count += value is not None
                            if isinstance(value, (int, float)) and not isinstance(value, bool):
                                values.append(float(value))
                else:
                    count += item is not None
                    if name != 'COUNTA':
                        values.append(numeric(item))
            if name == 'COUNTA':
                return float(count)
            if name == 'SUM':
                return sum(values)
            return (min(values) if name == 'MIN' else max(values)) if values else 0.0
        if name in ('COUNTIF', 'COUNTIFS', 'SUMIF', 'SUMIFS'):
            args = [argument(i) for i in range(len(nodes))]
            if name == 'SUMIF':
                pairs, sum_range = [(args[0], scalar(args[1]))], args[2] if len(args) > 2 else args[0]
            elif name == 'SUMIFS':
                sum_range, pairs = args[0], [(args[i], scalar(args[i + 1])) for i in range(1, len(args), 2)]
            else:
                sum_range, pairs = None, [(args[i], scalar(args[i + 1])) for i in range(0, len(args), 2)]
            if not pairs or any(not isinstance(rng, CellRange) for rng, _ in pairs):
                raise FormulaError('#VALUE!')
            shape = pairs[0][0].shape
            if any(rng.shape != shape for rng, _ in pairs):
                raise FormulaError('#VALUE!')
            total = 0.0
            for r in range(shape[0]):
                for c in range(shape[1]):
                    matches = True
                    for rng, criterion in pairs:
                        try:
                            value = rng.at(r, c)
                        except FormulaError as error:
                            value = error.code
                        if not criteria_matches(value, criterion):
                            matches = False
                            break
                    if matches:
                        if sum_range is None:
                            total += 1
                        else:
                            value = sum_range.at(r, c)
                            if isinstance(value, (int, float)) and not isinstance(value, bool):
                                total += value
            return total
        if name in ('INDEX', 'MATCH', 'VLOOKUP'):
            if name == 'INDEX':
                table = argument(0)
                if not isinstance(table, CellRange):
                    raise FormulaError('#VALUE!')
                r = int(num(1)) if len(nodes) > 1 else 0
                c = int(num(2)) if len(nodes) > 2 else (r if table.shape[0] == 1 else 1)
                if len(nodes) < 3 and table.shape[0] == 1:
                    r = 1
                if r < 0 or c < 0 or r > table.shape[0] or c > table.shape[1]:
                    raise FormulaError('#REF!')
                if r == 0 or c == 0:
                    return CellRange(self, table.sheet, table.r1 + max(0, r - 1), table.c1 + max(0, c - 1),
                                     table.r2 if r == 0 else table.r1 + r - 1,
                                     table.c2 if c == 0 else table.c1 + c - 1)
                # INDEX returns a reference. A genuinely blank target remains
                # blank inside ISNUMBER/comparisons; a formula's final value is
                # converted to zero only by cell(). This matters to thickness
                # fallback and unsupported-case guards in the source models.
                return CellRange(self, table.sheet, table.r1 + r - 1, table.c1 + c - 1)
            lookup = val(0)
            table = argument(1)
            if not isinstance(table, CellRange):
                raise FormulaError('#VALUE!')
            if name == 'VLOOKUP':
                output_col = int(num(2)) - 1
                if not 0 <= output_col < table.shape[1]:
                    raise FormulaError('#REF!' if output_col >= table.shape[1] else '#VALUE!')
                mode = 1 if len(nodes) < 4 or logical(argument(3)) else 0
                count = table.shape[0]
                horizontal = False
            else:
                mode = int(num(2)) if len(nodes) > 2 else 1
                horizontal = table.shape[0] == 1
                if not horizontal and table.shape[1] != 1:
                    raise FormulaError('#N/A')
                count = table.shape[1] if horizontal else table.shape[0]
            found = None
            pattern = wildcard(lookup) if mode == 0 and isinstance(lookup, str) and any(x in lookup for x in '*?~') else None
            cache_key = (table.sheet, table.r1, table.c1, table.r2 if not horizontal else table.r1, table.c2 if horizontal else table.c1, type(lookup).__name__, lookup, mode)
            if cache_key in self.lookup_cache:
                found = self.lookup_cache[cache_key]
            else:
                values, exact, numbers, texts = self.lookup_index(table, horizontal)
                if mode == 0 and pattern is None:
                    lookup_key = ('blank', None) if lookup is None else ('bool', lookup) if isinstance(lookup, bool) else ('number', float(lookup)) if isinstance(lookup, (int, float)) else ('text', lookup.casefold())
                    found = exact.get(lookup_key)
                elif mode == 0:
                    found = next((index for index, item in enumerate(values) if isinstance(item, str) and pattern.fullmatch(item)), None)
                else:
                    entries = texts if isinstance(lookup, str) else numbers if isinstance(lookup, (int, float)) and not isinstance(lookup, bool) else []
                    wanted = lookup.casefold() if isinstance(lookup, str) else lookup
                    # Preserve source order, including the last eligible duplicate.
                    # Tables are memoized; no current-state lookup is frozen.
                    for item, index in entries:
                        if (mode > 0 and item <= wanted) or (mode < 0 and item >= wanted):
                            found = index
                self.lookup_cache[cache_key] = found
            if found is None:
                raise FormulaError('#N/A')
            if name == 'MATCH':
                return float(found + 1)
            value = table.at(found, output_col)
            return 0.0 if value is None else value
        if name == 'CHOOSE':
            index = int(num(0))
            if not 1 <= index < len(nodes):
                raise FormulaError('#VALUE!')
            return argument(index)
        if name == 'INDIRECT':
            # Used by source validation lists. Only workbook references/names
            # can be resolved; there is no filesystem or external workbook I/O.
            target = txt(0)
            if '[' in target or ']' in target:
                raise FormulaError('#REF!')
            try:
                result = self.evaluate(parse_formula(relative_formula(target, row, column)), sheet, row, column)
                if not isinstance(result, CellRange):
                    raise FormulaError('#REF!')
                return result
            except ValueError:
                raise FormulaError('#REF!') from None
        if name in ('ROUND', 'ROUNDUP'):
            return rounded(argument(0), argument(1), up=name == 'ROUNDUP')
        if name == 'ABS':
            return abs(num(0))
        if name == 'INT':
            return float(math.floor(num(0)))
        if name == 'MOD':
            value, divisor = num(0), num(1)
            if divisor == 0:
                raise FormulaError('#DIV/0!')
            return value - divisor * math.floor(value / divisor)
        if name == 'PI':
            return math.pi
        if name in ('SQRT', 'ATAN', 'SIN'):
            try:
                return {'SQRT': math.sqrt, 'ATAN': math.atan, 'SIN': math.sin}[name](num(0))
            except ValueError:
                raise FormulaError('#NUM!') from None
        if name == 'VALUE':
            return numeric(argument(0))
        if name in ('LEFT', 'RIGHT'):
            text = txt(0)
            length = int(num(1)) if len(nodes) > 1 else 1
            if length < 0:
                raise FormulaError('#VALUE!')
            return text[:length] if name == 'LEFT' else text[-length:] if length else ''
        if name == 'MID':
            text, start, length = txt(0), int(num(1)), int(num(2))
            if start < 1 or length < 0:
                raise FormulaError('#VALUE!')
            return text[start - 1:start - 1 + length]
        if name == 'FIND':
            wanted, text = txt(0), txt(1)
            start = int(num(2)) if len(nodes) > 2 else 1
            if start < 1 or start > len(text) + 1:
                raise FormulaError('#VALUE!')
            found = text.find(wanted, start - 1)
            if found < 0:
                raise FormulaError('#VALUE!')
            return float(found + 1)
        if name == 'LEN':
            return float(len(txt(0)))
        if name == 'LOWER':
            return txt(0).lower()
        if name == 'UPPER':
            return txt(0).upper()
        if name == 'TRIM':
            return re.sub(' +', ' ', txt(0)).strip(' ')
        if name == 'SUBSTITUTE':
            text, old, new = txt(0), txt(1), txt(2)
            if not old:
                return text
            if len(nodes) < 4:
                return text.replace(old, new)
            occurrence = int(num(3))
            if occurrence < 1:
                raise FormulaError('#VALUE!')
            start = -len(old)
            for _ in range(occurrence):
                start = text.find(old, start + len(old))
                if start < 0:
                    return text
            return text[:start] + new + text[start + len(old):]
        if name == 'CHAR':
            value = int(num(0))
            if not 1 <= value <= 255:
                raise FormulaError('#VALUE!')
            return bytes([value]).decode('cp1252', errors='replace')
        if name == 'TEXT':
            value, format_code = num(0), txt(1)
            # Source models use fixed decimal formats to construct lookup keys.
            if not re.fullmatch(r'(?:#,##)?[0#]+(?:\.[0#]+)?%?', format_code):
                raise ValueError(f'Unsupported source TEXT format {format_code!r}')
            percent = format_code.endswith('%')
            format_code = format_code.rstrip('%')
            decimals = len(format_code.split('.')[1]) if '.' in format_code else 0
            number = rounded(value * 100 if percent else value, decimals)
            text = format(number, f'{"," if "," in format_code else ""}.{decimals}f')
            if '.' in format_code and '#' in format_code.split('.')[1]:
                optional = len(format_code.split('.')[1]) - len(format_code.split('.')[1].rstrip('#'))
                for _ in range(optional):
                    if text.endswith('0'):
                        text = text[:-1]
                text = text.rstrip('.')
            return text + ('%' if percent else '')
        raise ValueError(f'Unsupported source formula function {name}')
