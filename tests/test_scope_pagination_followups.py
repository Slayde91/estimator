"""Quoted scope headings remain attached to large schedules and estimates."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader

from estimator.commercial_documents import default_fields
from estimator.commercial_estimates import derive_estimates
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS
from estimator.storage import Store
from tests.test_quote_schedule_layout import calculators


def large_scope_request():
    values = calculators()
    base = {re.fullmatch(r'([A-Z]+)10', cell)[1]: value
            for cell, value in values['steel_vermiculite']['inputs']['SCHEDULE'].items()
            if re.fullmatch(r'([A-Z]+)10', cell)}
    rows = {}
    for index in range(1000):
        row = index + 10
        rows.update({f'{column}{row}': value for column, value in base.items()})
        rows[f'A{row}'] = f'ScopeMember{index:04}'
    values['steel_vermiculite']['inputs']['SCHEDULE'].update(rows)
    first = {key: values[key] for key in ('steel_vermiculite', 'steel_board')}
    second = {'steel_board': deepcopy(values['steel_board']), 'ductwork': values['ductwork']}
    first['steel_board']['inputs']['CALCULATOR']['A9'] = 'FirstEstimateBoard'
    second['steel_board']['inputs']['CALCULATOR']['A9'] = 'SecondEstimateBoard'
    return {'estimates': [
        {'id': 'first', 'name': 'Large estimate fixture', 'workspace': {
            'estimate': {'title': 'Synthetic project'}, 'calculators': first}},
        {'id': 'second', 'name': 'Second estimate fixture', 'workspace': {
            'estimate': {'title': 'Synthetic project'}, 'calculators': second}},
    ], 'selected_ids': ['first', 'second']}


def large_scope_quote(store):
    request = large_scope_request()
    derived = derive_estimates(store, request, include_pdfs=True, company=DEFAULTS)
    fields = default_fields('quote', {}, DEFAULTS)
    fields.update(lines=derived['lines'], sources=derived['sources'], terms='<p>Synthetic QA terms.</p>')
    payload = render_commercial_pdf({'kind': 'quote', 'fields': fields}, 'QU-SCOPE', company=DEFAULTS,
                                   scope_documents=[item['pdf'] for item in derived['scope_documents']])
    return payload, request


class ScopePaginationFollowupTests(unittest.TestCase):
    def test_legacy_visible_tables_start_later_schedules_on_fresh_pages(self):
        fields = default_fields('quote', {}, DEFAULTS)
        fields.update(scope='<p><b>Legacy estimate fixture</b></p>', terms='<p>QA terms.</p>', scope_tables=[
            {'title': 'First schedule fixture', 'headers': ['Item', 'Quantity'], 'rows': [['First row fixture', '1']]},
            {'title': 'Second schedule fixture', 'headers': ['Item', 'Quantity'], 'rows': [['Second row fixture', '2']]},
        ])
        payload = render_commercial_pdf({'kind': 'quote', 'fields': fields}, 'QU-LEGACY', company=DEFAULTS)
        pages = [' '.join(page.extract_text().split()) for page in PdfReader(BytesIO(payload)).pages]
        first = next(index for index, page in enumerate(pages) if 'First schedule fixture' in page)
        second = next(index for index, page in enumerate(pages) if 'Second schedule fixture' in page)
        self.assertGreater(second, first)
        for retained in ('SCOPE OF WORKS', 'Legacy estimate fixture', 'First row fixture'):
            self.assertIn(retained, pages[first])

    def test_thousand_row_schedule_keeps_scope_and_each_estimate_with_first_rows(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch('estimator.calculator_report.schedule_report_references', return_value=[]):
            store = Store(Path(folder) / 'source.sqlite3')
            payload, request = large_scope_quote(store)
        pages = [' '.join(page.extract_text().split()) for page in PdfReader(BytesIO(payload)).pages]
        scope = next(page for page in pages if 'SCOPE OF WORKS' in page)
        for text in ('Large estimate fixture', 'STEEL | SPRAY', 'ScopeMember0000', 'Line', 'Report'):
            self.assertIn(text.replace(' ', ''), scope.replace(' ', ''))
        self.assertEqual(sum('SCOPE OF WORKS' in page for page in pages), 1)
        # Every source item is retained exactly once even across 1,000 rows.
        combined = ''.join(pages).replace(' ', '')
        for index in range(1000):
            self.assertEqual(combined.count(f'ScopeMember{index:04}'), 1)
        expected = [('Large estimate fixture', 'STEEL | SPRAY', 'ScopeMember0000'),
                    ('Second estimate fixture', 'STEEL | BOARD', 'SecondEstimateBoard')]
        scope_start = next(index for index, page in enumerate(pages) if 'SCOPE OF WORKS' in page)
        scope_end = next(index for index in range(scope_start + 1, len(pages)) if 'ALLOWANCES' in pages[index])
        scope_pages = pages[scope_start:scope_end]
        for estimate, title, row in expected:
            # Quote Summary also lists each estimate. Only the actual scope
            # heading must occur once and remain with its first schedule.
            matches = [page for page in scope_pages if estimate in page]
            self.assertEqual(len(matches), 1)
            self.assertIn(title, matches[0])
            self.assertIn(row, matches[0].replace(' ', ''))
        # Each later schedule is its own document/page, never appended after
        # the previous schedule's final table, even if that page has room.
        starts = [(index, page) for index, page in enumerate(scope_pages)
                  if any(title in page for title in ('STEEL | SPRAY', 'STEEL | BOARD', 'DUCT | SPRAY / WRAP'))]
        self.assertEqual(len(starts), 4)
        self.assertEqual(len({index for index, _ in starts}), 4)
        self.assertEqual(len(request['estimates']), 2)


if __name__ == '__main__':
    unittest.main()
