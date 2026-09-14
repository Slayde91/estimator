import subprocess
import sys
import unittest

from estimator.excel_engine import WorkbookEngine, relative_formula, parse_formula, wildcard


def evaluate(formula, values=None):
    cells = {key: {'value': value} for key, value in (values or {}).items()}
    cells['Z99'] = {'formula': formula}
    return WorkbookEngine({'sheets': [{'name': 'Test', 'cells': cells}]}).value('Test', 'Z99')


class ExcelEngineTests(unittest.TestCase):
    def test_excel_operator_precedence_and_reference_coercion(self):
        self.assertEqual(evaluate('-2^2'), 4)
        self.assertEqual(evaluate('2^3^2'), 64)
        self.assertEqual(evaluate('2+3*4'), 14)
        self.assertEqual(evaluate('A1+1', {'A1': None}), 1)
        self.assertEqual(evaluate('A1+1', {'A1': ''}), '#VALUE!')
        self.assertEqual(evaluate('A1=""', {'A1': None}), True)
        self.assertEqual(evaluate('A1=0', {'A1': ''}), False)
        self.assertEqual(evaluate('"AbC"="abc"'), True)
        self.assertEqual(evaluate('"3"=3'), False)

    def test_lazy_if_and_error_propagation(self):
        self.assertEqual(evaluate('IF(TRUE,5,1/0)'), 5)
        self.assertEqual(evaluate('IF(FALSE,1/0,"ready")'), 'ready')
        self.assertEqual(evaluate('IFERROR(1/0,"missing")'), 'missing')
        self.assertEqual(evaluate('AND(FALSE,1/0)'), '#DIV/0!')
        self.assertEqual(evaluate('ISNUMBER(1/0)'), False)
        self.assertEqual(evaluate('ISNUMBER("1")'), False)
        self.assertEqual(evaluate('N("2")'), 0)

    def test_sums_ignore_reference_text_but_accept_direct_numeric_text(self):
        values = {'A1': 3, 'A2': '4', 'A3': True, 'A4': None, 'A5': ''}
        self.assertEqual(evaluate('SUM(A1:A5,"2",TRUE)', values), 6)
        self.assertEqual(evaluate('COUNTA(A1:A5)', values), 4)
        self.assertEqual(evaluate('MIN(A1:A5)', values), 3)
        self.assertEqual(evaluate('MAX(A1:A5)', values), 3)

    def test_exact_and_approximate_lookups_and_range_index(self):
        values = {'A1': 10, 'B1': 'first', 'A2': 20, 'B2': 'second', 'A3': 30, 'B3': 'third'}
        self.assertEqual(evaluate('VLOOKUP(25,A1:B3,2,TRUE)', values), 'second')
        self.assertEqual(evaluate('VLOOKUP(25,A1:B3,2,FALSE)', values), '#N/A')
        self.assertEqual(evaluate('VLOOKUP(5,A1:B3,2,TRUE)', values), '#N/A')
        self.assertEqual(evaluate('INDEX(B1:B3,MATCH(20,A1:A3,0))', values), 'second')
        self.assertEqual(evaluate('MATCH("SEC*",B1:B3,0)', values), 2)
        self.assertEqual(evaluate('SUM(INDEX(A1:B3,0,1))', values), 60)
        self.assertEqual(evaluate('INDEX(A1:A2,2)', {'A1': 5}), 0)
        self.assertEqual(evaluate('INDEX(A1:A2,2)=""', {'A1': 5}), True)
        self.assertEqual(evaluate('ISNUMBER(INDEX(A1:A2,2))', {'A1': 5}), False)

    def test_conditional_aggregates_keep_zero_blank_and_wildcards_distinct(self):
        values = {'A1': 'Steel', 'A2': 'steel', 'A3': 'Board', 'A4': None, 'A5': '',
                  'B1': 2, 'B2': 3, 'B3': 8, 'B4': 4, 'B5': 6}
        self.assertEqual(evaluate('SUMIF(A1:A5,"steel",B1:B5)', values), 5)
        self.assertEqual(evaluate('SUMIFS(B1:B5,A1:A5,"S*",B1:B5,">2")', values), 3)
        self.assertEqual(evaluate('COUNTIF(A1:A5,"")', values), 2)
        self.assertEqual(evaluate('COUNTIFS(A1:A5,"<>Board",B1:B5,">=4")', values), 2)

    def test_wildcard_matching_preserves_escapes_case_and_empty_text(self):
        cases = [('a?c', 'AbC', True), ('a?c', 'ac', False), ('*', '', True),
                 ('', '', True), ('', 'x', False), ('~*', '*', True),
                 ('~?', '?', True), ('~~', '~', True), ('end~', 'end~', True),
                 ('~a', 'A', True), ('a?b', 'a\nb', True),
                 ('*ab*bc', 'ababc', True), ('*ab*bc', 'ababd', False),
                 ('~*', 'ordinary', False), ('?*?', 'x', False)]
        for pattern, text, expected in cases:
            with self.subTest(pattern=pattern, text=text):
                self.assertEqual(wildcard(pattern).fullmatch(text) is not None, expected)

    def test_wildcards_in_lookups_and_aggregates(self):
        adjacent = '*' * 200 + 'no-match'
        values = {'A1': 'Steel*', 'A2': 'Steel?', 'A3': 'Steel~', 'A4': 'Steelwork',
                  'B1': 2, 'B2': 3, 'B3': 4, 'B4': 5}
        self.assertEqual(evaluate('MATCH("Steel~*",A1:A4,0)', values), 1)
        self.assertEqual(evaluate('VLOOKUP("Steel~?",A1:B4,2,FALSE)', values), 3)
        self.assertEqual(evaluate('COUNTIF(A1:A4,"Steel*")', values), 4)
        self.assertEqual(evaluate('COUNTIF(A1:A4,"Steel~~")', values), 1)
        self.assertEqual(evaluate('SUMIF(A1:A4,"Steel~?",B1:B4)', values), 3)
        self.assertEqual(evaluate('MATCH("' + adjacent + '",A1:A4,0)', values), '#N/A')
        self.assertEqual(evaluate('COUNTIF(A1:A4,"' + adjacent + '")', values), 0)

    def test_source_board_wildcard_input_finishes_in_an_isolated_process(self):
        # A timeout kills only this child if exponential regex matching returns.
        # The supplied value is valid input text and reaches the real CE9 lookup.
        script = '''
from estimator.workbook_calculators import source_model, normalize_calculator_inputs
from estimator.excel_engine import WorkbookEngine, wildcard
adjacent = '*' * 200 + 'no-match'
separated = '*a' * 200 + 'b'
assert wildcard(adjacent).fullmatch('310UB40.4') is None
assert wildcard(separated).fullmatch('a' * 400) is None
assert wildcard(separated).fullmatch('a' * 400 + 'b') is not None
inputs = normalize_calculator_inputs('steel_board', {'CALCULATOR': {'D9': '*' * 200 + 'no-match'}})
engine = WorkbookEngine(source_model('steel_board'), inputs)
assert engine.value('CALCULATOR', 'CE9') == ''
print('bounded source lookup')
'''
        completed = subprocess.run([sys.executable, '-c', script], capture_output=True,
                                   text=True, timeout=15)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('bounded source lookup', completed.stdout)

    def test_rounding_and_text_lookup_keys(self):
        self.assertEqual(evaluate('ROUND(2.675,2)'), 2.68)
        self.assertEqual(evaluate('ROUND(-2.675,2)'), -2.68)
        self.assertEqual(evaluate('ROUNDUP(-2.61,1)'), -2.7)
        self.assertEqual(evaluate('INT(-2.1)'), -3)
        self.assertEqual(evaluate('MOD(-3,2)'), 1)
        self.assertEqual(evaluate('TEXT(12.3456,"0.00")'), '12.35')
        self.assertEqual(evaluate('TEXT(12.3,"0.###")'), '12.3')
        self.assertEqual(evaluate('"P"&TEXT(12,"0")&"|"&TEXT(0.5,"0.000")'), 'P12|0.500')

    def test_source_text_functions_and_literal_reference_safety(self):
        self.assertEqual(evaluate('TRIM("  a  b  ")'), 'a b')
        self.assertEqual(evaluate('SUBSTITUTE("a|b|c","|","-",2)'), 'a|b-c')
        self.assertEqual(evaluate('MID("abcdef",2,3)'), 'bcd')
        self.assertEqual(evaluate('FIND("bc","abcdef")'), 2)
        self.assertEqual(evaluate('RIGHT("ABC",0)'), '')
        first = relative_formula('IF(A11=0,"AS4254 M6",$B$10+A11)', 11, 38)
        copied = relative_formula('IF(A12=0,"AS4254 M6",$B$10+A12)', 12, 38)
        self.assertEqual(first, copied)
        self.assertIn('AS4254 M6', first)
        self.assertEqual(parse_formula(first), parse_formula(copied))

    def test_original_cache_is_never_a_calculated_value(self):
        model = {'sheets': [{'name': 'Test', 'cells': {'A1': {'value': 3}, 'B1': {'formula': 'A1*2', 'cached_value': 999}}}]}
        self.assertEqual(WorkbookEngine(model).value('Test', 'B1'), 6)
        self.assertEqual(WorkbookEngine(model, {'Test': {'A1': 4}}).value('Test', 'B1'), 8)
        self.assertEqual(model['sheets'][0]['cells']['B1']['cached_value'], 999)


if __name__ == '__main__':
    unittest.main()
