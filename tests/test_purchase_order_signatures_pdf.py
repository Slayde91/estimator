"""PO exports retain role-specific signatures and historical text without inferred times."""
from copy import deepcopy
from io import BytesIO
import re
import unittest

import pdfplumber
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4

from estimator.commercial_documents import default_fields
from estimator.commercial_pdf import render_commercial_pdf
from estimator.company_settings import DEFAULTS


INK = {'version': 1, 'ratio': 3, 'strokes': [[[0, 0], [.5, 1], [1, 0]]]}
SIGNERS = (
    ('REQUESTED BY', 'Requested by', 'requested_by', 'Request date', 'requested_date', 'Requester fixture', '2026-11-10'),
    ('PURCHASE ORDER APPROVAL', 'Approved by', 'reviewed_by', 'Approval date', 'review_date', 'Approver fixture', '2026-11-11'),
    ('SENT BY', 'Sent by', 'sent_by', 'Sent date', 'sent_date', 'Sender fixture', '2026-11-12'),
    ('PROCUREMENT VERIFICATION', 'Verified by', 'verified_by', 'Verification date', 'verified_date', 'Verifier fixture', '2026-11-13'),
)


def purchase_order_fields(*, signed=True, rejected=False, legacy=False):
    fields = default_fields('purchase_order', {
        'project_no': 'PN-QA', 'client': 'Synthetic customer fixture',
        'contact': 'Project contact fixture', 'site_address': 'Project site fixture',
        'date': '2026-11-09'}, DEFAULTS)
    fields['lines'] = [
        {'estimate_id': '', 'description': 'Synthetic purchased item', 'quantity': '2',
         'unit_price': '125.50', 'size': '', 'comments': 'Synthetic request fixture.'}]
    fields['order'].update(
        supplier='Supplier fixture', supplier_contact='Supplier contact fixture',
        supplier_email='supplier@example.test', payment_terms='Thirty days fixture',
        ship_to_name='Site contact fixture', site_contact_number='0400 000 000',
        ship_to_address='Delivery site fixture', delivery_date='2026-11-14',
        delivery_time='14:35', expense_type='Hire', delivery_method='Delivery',
        approval='Rejected' if rejected else 'Approved',
        rejection_reason='Rejection reason fixture: incorrect delivery specification.',
        verification='Verification procedure fixture: inspected against the purchase specification.')
    for _, _, key, _, date_key, name, date in SIGNERS:
        fields['order'][key] = name
        fields['order'][date_key] = date
    if signed:
        fields['signatures'] = {key: deepcopy(INK) for _, _, key, _, _, _, _ in SIGNERS}
    if legacy:
        fields.pop('signatures', None)
        fields['order'].pop('delivery_time')
        fields['order'].pop('rejection_reason')
        fields['order']['approval'] = 'Legacy approval narrative remains intact.'
        for _, _, key, _, _, name, _ in SIGNERS:
            fields['order'][key] = name + ' - retained legacy narrative.'
    return fields


def render(fields):
    return render_commercial_pdf({'kind': 'purchase_order', 'status': 'Draft', 'fields': fields},
                                 'PO-QA', company={**DEFAULTS, 'name': 'SYNTHETIC QA COMPANY'})


def text(payload):
    return re.sub(r'\s+', ' ', '\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages))


class PurchaseOrderSignaturesPdfTests(unittest.TestCase):
    def test_four_vector_signatures_stay_beside_their_own_name_and_date(self):
        fields = purchase_order_fields()
        before = deepcopy(fields)
        payload = render(fields)
        self.assertEqual(fields, before)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            totals_page = next(page for page in pdf.pages if 'Grand total' in page.extract_text())
            self.assertIn('Subtotal', totals_page.extract_text())
            self.assertIn('GST (10%)', totals_page.extract_text())
            for heading, label, _, date_label, _, name, date in SIGNERS:
                page = next(page for page in pdf.pages if name in page.extract_text())
                self.assertIn(heading, page.extract_text())
                signature_label = page.search(label, regex=False)[0]
                name_position = page.search(name, regex=False)[0]
                date_position = page.search(date, regex=False)[0]
                date_heading = page.search(date_label, regex=False)[0]
                self.assertAlmostEqual(signature_label['top'], date_heading['top'], delta=.1)
                self.assertAlmostEqual(name_position['top'], date_position['top'], delta=.1)
                self.assertLess(signature_label['x0'], name_position['x0'])
                self.assertLess(name_position['x1'], date_position['x0'])
                ink = [curve for curve in page.curves if curve['stroking_color'] == (0, 0, 0)
                       and curve['x0'] >= signature_label['x0']
                       and curve['x1'] < name_position['x0']
                       and signature_label['bottom'] < curve['top']
                       and curve['bottom'] < name_position['top'] + 65]
                self.assertEqual(len(ink), 1, label)
            self.assertNotIn('Reviewed by', text(payload))
            self.assertNotIn('Review date', text(payload))

    def test_rejection_reason_is_printed_only_for_rejected_approval(self):
        fields = purchase_order_fields(rejected=True)
        reason = fields['order']['rejection_reason']
        rejected = text(render(fields))
        self.assertIn('Approval Rejected', rejected)
        self.assertIn(reason, rejected)
        for approval in ('Approved', 'Legacy approval narrative'):
            fields['order']['approval'] = approval
            approved = text(render(fields))
            self.assertIn(approval, approved)
            self.assertNotIn('Rejection reason', approved)
            self.assertNotIn(reason, approved)
        self.assertEqual(fields['order']['rejection_reason'], reason)

    def test_legacy_signer_narratives_and_date_only_delivery_survive(self):
        fields = purchase_order_fields(legacy=True)
        before = deepcopy(fields)
        output = text(render(fields))
        self.assertEqual(fields, before)
        for _, _, key, _, date_key, _, _ in SIGNERS:
            self.assertIn(fields['order'][key], output)
            self.assertIn(fields['order'][date_key], output)
        self.assertIn(fields['order']['approval'], output)
        self.assertIn(fields['order']['verification'], output)
        self.assertIn('Delivery date and time 2026-11-14 Type of expense', output)
        self.assertNotIn('00:00', output)
        self.assertNotIn('14:35', output)
        self.assertEqual(output.count('Not signed'), 4)

    def test_delivery_time_and_project_site_are_retained_without_timezone_conversion(self):
        output = text(render(purchase_order_fields()))
        header, purchase_details = output.split('PURCHASE ORDER DETAILS', 1)
        self.assertIn('Supplier Supplier fixture Contact Supplier contact fixture', header)
        self.assertNotIn('Synthetic customer fixture', output)
        self.assertNotIn('Project contact fixture', output)
        self.assertIn('Site address Project site fixture', output)
        self.assertIn('Delivery address Delivery site fixture', output)
        self.assertIn('Delivery date and time 2026-11-14 14:35', output)
        self.assertNotIn('T14:35', output)
        self.assertLess(purchase_details.index('Supplier Supplier fixture'), purchase_details.index('Payment terms Thirty days fixture'))
        self.assertLess(output.index('Payment terms Thirty days fixture'), output.index('Supplier contact Supplier contact fixture'))
        self.assertLess(output.index('Supplier contact Supplier contact fixture'), output.index('Supplier email supplier@example.test'))

    def test_long_rejection_and_legacy_verification_paginate_without_loss_or_orphan_signers(self):
        fields = purchase_order_fields(rejected=True)
        fields['order']['rejection_reason'] = ' '.join(f'R{index:03} detail.' for index in range(60))
        fields['order']['verification'] = ' '.join(f'V{index:03} preserved verification.' for index in range(200))
        payload = render(fields)
        output = text(payload)
        for prefix, count in [('R', 60), ('V', 200)]:
            for index in range(count):
                self.assertEqual(output.count(f'{prefix}{index:03}'), 1)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            self.assertGreater(len(pdf.pages), 2)
            for _, label, _, date_label, _, name, date in SIGNERS:
                page = next(page for page in pdf.pages if name in page.extract_text())
                self.assertIn(label, page.extract_text())
                self.assertIn(date_label, page.extract_text())
                self.assertIn(date, page.extract_text())
            for page in pdf.pages:
                for char in page.chars:
                    if 90 < char['top'] < 800:
                        self.assertGreaterEqual(char['x0'], 35)
                        self.assertLessEqual(char['x1'], A4[0] - 35)

    def test_long_legacy_signer_value_remains_complete_when_it_spans_pages(self):
        fields = purchase_order_fields(legacy=True)
        fields['order']['requested_by'] = ' '.join(f'N{index:03} legacy detail.' for index in range(250))
        payload = render(fields)
        output = text(payload)
        for index in range(250):
            self.assertEqual(output.count(f'N{index:03}'), 1)
        with pdfplumber.open(BytesIO(payload)) as pdf:
            heading_page = next(page for page in pdf.pages if 'REQUESTED BY' in page.extract_text())
            self.assertIn('N000', heading_page.extract_text())


if __name__ == '__main__':
    unittest.main()
