"""Commercial PDF presentation keeps the issued Quote snapshot and all notes."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import pdfplumber
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4

from estimator.commercial_documents import default_fields
from estimator.commercial_estimates import derive_estimates
from estimator.commercial_pdf import _terms_pdf, render_commercial_pdf
from estimator.company_settings import DEFAULTS
from estimator.project_reports import build_project_report
from estimator.quote_schedule import SCOPE_SCHEDULE_TITLES
from estimator.storage import Store
from estimator.work_order_tracking import template
from tests.test_quote_pdf_refinements import brand_red, compact
from tests.test_quote_schedule_layout import calculators, fire_draft, references, REFERENCE


PROJECT_ID = '10000000-0000-4000-8000-000000000001'
QUOTE_ID = '20000000-0000-4000-8000-000000000001'
INK = {'version': 1, 'ratio': 3, 'strokes': [[[0, 0], [.5, 1], [1, 0]]]}


def work_order_fields(*, long_notes=False):
    fields = default_fields('work_order', {
        'project_no': 'PN-01', 'client': 'Synthetic company', 'contact': 'Example contact',
        'phone': '0400 000 000', 'email': 'qa@example.test',
        'site_address': '1 Synthetic Street', 'date': '2026-11-09'}, DEFAULTS)
    fields['order'].update(quote_id=QUOTE_ID, quote_reference='QU-04', start_date='2026-11-10',
        end_date='2026-11-12', urgency='Normal', description='Synthetic QA work request.',
        estimated_cost='1399224.25', approval='Approved', justification='Synthetic QA approval.',
        reviewed_by='Reviewer fixture', review_date='2026-11-09', prepared_by='Preparer fixture',
        prepared_date='2026-11-09', client_approved_by='Approver fixture', client_approval_date='2026-11-09',
        progress_by='Progress fixture', progress_date='2026-11-09', certification='Certification issued',
        completion='Ongoing', closed_by='Closer fixture', closed_date='2026-11-09')
    lines = [{'estimate_id': '', 'description': label, 'quantity': '1', 'unit_price': price,
              'size': '', 'comments': ''}
             for label, price in [('Paid item fixture', '1399224.25'), ('Free item fixture', '0'),
                                  ('Credit item fixture', '-50')]]
    fields['work_tracking'] = template(PROJECT_ID, QUOTE_ID, 'QU-04', lines)
    for row in fields['work_tracking']['rows']:
        row.update(completed_percent='50', claimed_percent='25', notes='Site note fixture.')
    if long_notes:
        fields['work_tracking']['rows'][0]['notes'] = ' '.join(f'N{index:03} Retained.' for index in range(90))
    fields['signatures'] = {key: deepcopy(INK) for key in
                            ('reviewed_by', 'prepared_by', 'client_approved_by', 'progress_by', 'closed_by')}
    return fields


class OrderQuotePdfPresentationTests(unittest.TestCase):
    def test_work_order_claim_signer_name_date_and_vector_signature_are_rendered_together(self):
        fields = work_order_fields()
        fields['order'].update(claimed_by='Claim signer fixture', claim_date='2026-11-10')
        fields['signatures']['claimed_by'] = deepcopy(INK)
        payload = render_commercial_pdf({'kind': 'work_order', 'fields': fields}, 'WO-CLAIM', company=DEFAULTS)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            for title, signer in [('WORK ORDER REVIEW', 'Reviewer fixture'),
                                  ('OHS DOCUMENTATION', 'Preparer fixture'),
                                  ('CLIENT APPROVAL', 'Approver fixture'),
                                  ('WORK ORDER COMPLETION', 'Closer fixture')]:
                section_page = next(page for page in pdf.pages if title in page.extract_text())
                self.assertIn(signer, section_page.extract_text(), title)
            page = next(page for page in pdf.pages if 'Claim signer fixture' in page.extract_text())
            for retained in ('Claim signed by', 'Claim signer fixture', '2026-11-10'):
                self.assertIn(retained, page.extract_text())
            label = page.search('Claim signed by', regex=False)[0]
            signer = page.search('Claim signer fixture', regex=False)[0]
            date = page.search('2026-11-10', regex=False)[0]
            self.assertTrue(any(label['top'] - 6 <= ink['top'] and ink['bottom'] <= signer['top']
                                for ink in page.curves + page.lines if ink['stroking_color'] == (0, 0, 0)))
            self.assertLess(label['top'], signer['top'])
            self.assertLess(signer['top'], date['top'])

    def test_work_order_centered_header_and_consistent_red_key_value_tables(self):
        fields = work_order_fields()
        before = deepcopy(fields)
        payload = render_commercial_pdf({'kind': 'work_order', 'fields': fields}, 'WO-03', company=DEFAULTS)
        self.assertEqual(fields, before)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            first = pdf.pages[0]
            title = [word for word in first.extract_words() if word['text'] in {'WORK', 'ORDER'} and word['top'] < 70]
            self.assertEqual([word['text'] for word in title], ['WORK', 'ORDER'])
            self.assertAlmostEqual((title[0]['x0'] + title[-1]['x1']) / 2, A4[0] / 2, delta=1)
            all_text = '\n'.join(page.extract_text() for page in pdf.pages)
            self.assertNotIn('Field Details', all_text)
            self.assertIn('Notes % completed', all_text)
            self.assertIn('Unit price % claimed', all_text)
            self.assertIn('$1,399,224.25', all_text)
            for page in pdf.pages:
                self.assertTrue(all(brand_red(line['stroking_color']) for line in page.lines))
                for word in page.extract_words():
                    # Every key/value label occupies the same 125pt column.
                    if 42 < word['x0'] < word['x1'] < 160 and word['top'] > 90:
                        fills = [rect for rect in page.rects if brand_red(rect['non_stroking_color'])
                                 and rect['x0'] < word['x0'] < word['x1'] < rect['x1']
                                 and rect['top'] < word['top'] < word['bottom'] < rect['bottom']]
                        if fills:
                            chars = page.crop((word['x0'] - .1, word['top'] - .1,
                                               word['x1'] + .1, word['bottom'] + .1)).chars
                            self.assertTrue(all(char['non_stroking_color'] == (1, 1, 1) for char in chars))
            # The initial and completion key/value labels are visibly branded.
            for label in ('Customer', 'Certification', 'Completion', 'Closed'):
                page, word = next((page, word) for page in pdf.pages for word in page.extract_words()
                                  if word['text'] == label and word['x0'] < 160)
                self.assertTrue(any(brand_red(rect['non_stroking_color'])
                                    and rect['x0'] < word['x0'] < rect['x1']
                                    and rect['top'] < word['top'] < rect['bottom'] for rect in page.rects))

    def test_long_progress_notes_paginate_without_losing_quote_rows_or_provenance(self):
        fields = work_order_fields(long_notes=True)
        payload = render_commercial_pdf({'kind': 'work_order', 'fields': fields}, 'WO-03', company=DEFAULTS)
        reader = PdfReader(BytesIO(payload))
        combined = compact('\n'.join(page.extract_text() for page in reader.pages))
        for index in range(90):
            self.assertEqual(combined.count(f'N{index:03}'), 1)
        for label in ('Paid item fixture', 'Free item fixture', 'Credit item fixture'):
            self.assertEqual(combined.count(label), 2)
        progress, claim = combined.split('WORKS IN PROGRESS', 1)[1].split('WORK ORDER CLAIM', 1)
        self.assertNotIn('Unit price', progress)
        self.assertNotIn('$1,399,224.25', progress)
        self.assertIn('$1,399,224.25', claim)
        self.assertIn('$0.00', claim)
        self.assertIn('-$50.00', claim)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            note_pages = [page for page in pdf.pages if re.search(r'N\d{3}', page.extract_text())]
            self.assertGreater(len(note_pages), 1)
            for page in note_pages:
                # Tables stay between the reserved company header and footer.
                body = [char for char in page.chars if re.match(r'[A-Za-z0-9]', char['text']) and char['x0'] > 36]
                for char in body:
                    if 85 < char['top'] < 810:
                        self.assertLessEqual(char['x1'], A4[0] - 36)
                notes = next(word for word in page.extract_words() if word['text'] == 'Notes')
                percent = next(word for word in page.extract_words() if word['text'] == '%')
                self.assertAlmostEqual(percent['x0'] - notes['x0'], (A4[0] - 72) * .15, delta=1)

    def test_purchase_order_site_contact_fields_keep_existing_table_presentation(self):
        fields = default_fields('purchase_order', {'project_no': 'PN-01'}, DEFAULTS)
        fields['order'].update(ship_to_name='Site contact fixture', site_contact_number='+61 400 111 222',
                               ship_to_address='Delivery address fixture')
        payload = render_commercial_pdf({'kind': 'purchase_order', 'status': 'Draft', 'fields': fields},
                                         'PO-01', company=DEFAULTS)
        text = compact('\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages))
        for retained in ('Site contact', 'Site contact number', '+61 400 111 222', 'Delivery address fixture', 'Field Details'):
            self.assertIn(retained, text)
        self.assertNotIn('Ship to', text)

    def test_purchase_order_request_approval_sent_and_final_verification_keep_separate_sections(self):
        fields = default_fields('purchase_order', {'project_no': 'PN-01'}, DEFAULTS)
        values = {'requested_by': 'Legacy requester fixture', 'requested_date': '2026-11-09',
                  'approval': 'Legacy approval fixture', 'reviewed_by': 'Legacy reviewer fixture', 'review_date': '2026-11-10',
                  'sent_by': 'Legacy sender fixture', 'sent_date': '2026-11-11',
                  'verification': 'Legacy verification method fixture', 'verified_by': 'Legacy verifier fixture',
                  'verified_date': '2026-11-12'}
        fields['order'].update(values)
        payload = render_commercial_pdf({'kind': 'purchase_order', 'status': 'Draft', 'fields': fields},
                                         'PO-01', company=DEFAULTS)
        text = compact('\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages))
        headings = ['REQUESTED BY', 'PURCHASE ORDER APPROVAL', 'SENT BY', 'PROCUREMENT VERIFICATION']
        self.assertEqual([text.index(heading) for heading in headings], sorted(text.index(heading) for heading in headings))
        request, approval, sent, verification = re.split('|'.join(headings), text)[1:]
        self.assertIn(values['requested_by'], request)
        self.assertIn(values['reviewed_by'], approval)
        self.assertIn(values['sent_by'], sent)
        self.assertIn(values['sent_date'], sent)
        for key in ('verification', 'verified_by', 'verified_date'):
            self.assertIn(values[key], verification)
        self.assertNotIn(values['sent_by'], verification)
        self.assertEqual(fields['order']['sent_by'], values['sent_by'])

    def test_quote_schedule_titles_match_estimate_size_and_have_no_scope_boilerplate(self):
        with patch('estimator.calculator_report.schedule_report_references', return_value=[REFERENCE]), \
             patch('estimator.penetration_report.resolve_schedule_references', side_effect=references):
            payload = build_project_report(calculators(), fire_draft(), {}, {}, company=DEFAULTS,
                quote_scope=True, scope_intro={'name': 'Estimate fixture', 'heading': True})
        with pdfplumber.open(BytesIO(payload)) as pdf:
            text = compact('\n'.join(page.extract_text() for page in pdf.pages))
            self.assertNotIn('The following Full Schedules', text)
            estimate_chars = pdf.pages[0].search('Estimate fixture')[0]['chars']
            size = estimate_chars[0]['size']
            for title in SCOPE_SCHEDULE_TITLES.values():
                page = next(page for page in pdf.pages if title in page.extract_text())
                chars = page.search(re.escape(title))[0]['chars']
                self.assertTrue(all(abs(char['size'] - size) < .01 for char in chars), title)

    def test_older_partial_generated_preamble_is_not_printed_after_selection_change(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / 'source.sqlite3')
            workspace = {'estimate': {'title': 'Synthetic project'},
                         'calculators': {'steel_board': calculators()['steel_board']}}
            request = {'estimates': [
                {'id': 'first', 'name': 'Estimate 1', 'workspace': workspace},
                {'id': 'second', 'name': 'Estimate 2', 'workspace': workspace}],
                'selected_ids': ['first', 'second'],
                'fields': {'scope': '<p><b>Estimate 1</b></p><p>Custom exclusion retained.</p>'}}
            derived = derive_estimates(store, request, include_pdfs=True, company=DEFAULTS)
            text = compact('\n'.join(page.extract_text() for item in derived['scope_documents']
                                      for page in PdfReader(BytesIO(item['pdf'])).pages))
            self.assertEqual(text.count('Estimate 1'), 1)
            self.assertEqual(text.count('Estimate 2'), 1)
            self.assertEqual(text.count('Custom exclusion retained.'), 1)
            self.assertNotIn('The following Full Schedules', text)

    def test_terms_are_eight_point_and_keep_custom_text_and_bold_opening(self):
        fields = default_fields('quote', {}, DEFAULTS)
        fields['terms'] += '<p>Custom final clause fixture.</p>'
        payload = _terms_pdf(fields['terms'], {'kind': 'quote', 'fields': fields}, 'QU-04', DEFAULTS)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            body = [char for page in pdf.pages for char in page.chars if 95 < char['top'] < A4[1] - 48]
            self.assertTrue(body)
            self.assertTrue(all(abs(char['size'] - 8) < .01 for char in body))
            text = compact('\n'.join(page.extract_text() for page in pdf.pages))
            self.assertIn('Custom final clause fixture.', text)
            opening = pdf.pages[0].search('These terms and conditions are between')[0]['chars']
            self.assertTrue(all('Bold' in char['fontname'] for char in opening))


if __name__ == '__main__':
    unittest.main()
