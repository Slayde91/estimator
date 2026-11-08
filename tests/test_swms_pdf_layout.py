"""Actual SWMS output geometry, chosen-risk pagination and readable custom content."""
from copy import deepcopy
from io import BytesIO
import unittest

import pdfplumber

from estimator.company_settings import DEFAULTS, validate_company_settings
from estimator.swms import default_fields, template_options
from estimator.swms_pdf import render_swms_pdf

INK = {'version': 1, 'ratio': 3, 'strokes': [[[.1, .4], [.5, .2], [.8, .7]]]}
PAGE_RIGHT = 802.8897637795277


class SwmsPdfLayoutTests(unittest.TestCase):
    def pdf(self, fields=None, company=None):
        return pdfplumber.open(BytesIO(render_swms_pdf(
            {'version': 1, 'reference': 'SWMS-GRID', 'fields': fields or default_fields()}, company=company or DEFAULTS)))

    def test_first_page_uses_aligned_project_columns_and_a_separate_contact_signature(self):
        fields = default_fields()
        fields['details'].update(contact_person='ContactNameUnique', position='PositionUnique', phone='PhoneUnique')
        fields['contact_signature'] = deepcopy(INK)
        with self.pdf(fields) as document:
            page = document.pages[0]
            def heading(text, occurrence=0):
                return [hit for hit in page.search(text, regex=False) if hit['top'] >= 70][occurrence]
            for upper, lower in [('SWMS Reference', 'Project Name'), ('Contact Person', 'Date:'),
                                 ('Position', 'Project Manager (PM)'), ('Phone:', 'Contact')]:
                top = heading(upper)
                # Contact also occurs in the first row; the final one is the lower row.
                bottom = page.search(lower, regex=False)[-1] if lower == 'Contact' else heading(lower)
                self.assertAlmostEqual(top['x0'], bottom['x0'], places=2, msg=(upper, lower))
            contact = heading('ContactNameUnique')
            signature = heading('Signature:')
            position = heading('PositionUnique')
            self.assertLess(contact['x1'], signature['x0'])
            self.assertEqual(len(page.curves), 1, 'The synthetic contact signature must render as real vector ink.')
            ink = page.curves[0]
            self.assertGreaterEqual(ink['x0'], signature['x0'])
            self.assertLess(ink['x1'], position['x0'])
            title = page.search('SAFE WORK METHOD STATEMENT', regex=False)[0]
            self.assertAlmostEqual((title['x0'] + title['x1']) / 2, page.width / 2, places=2)
            self.assertFalse(any('SAFE WORK METHOD STATEMENT' in (p.extract_text() or '') for p in document.pages[1:]))

    def test_communication_is_two_columns_with_the_principal_contractor_label_width(self):
        fields = default_fields()
        fields['toolbox'] = 'ToolboxUnique relevant controls must remain complete.'
        fields['compliance'] = 'ComplianceUnique relevant people remain complete.'
        with self.pdf(fields) as document:
            page = document.pages[0]
            project = page.search('Project Name', regex=False)[0]
            principal = page.search('Principal Contractor (PC)', regex=False)[0]
            toolbox = page.search('ToolboxUnique', regex=False)[0]
            compliance = page.search('ComplianceUnique', regex=False)[0]
            self.assertAlmostEqual(toolbox['x0'], project['x0'], places=2)
            self.assertAlmostEqual(compliance['x0'], project['x0'], places=2)
            label = page.search('Person/s responsible for ensuring', regex=False)[0]
            self.assertAlmostEqual(label['x0'], principal['x0'], places=2)
            self.assertLess(label['x1'], project['x0'])
            self.assertTrue(all('Bold' in char['fontname'] for char in label['chars']))
            self.assertTrue(all('Bold' not in char['fontname'] for char in compliance['chars']))

    def test_every_chosen_high_risk_item_starts_a_fresh_page_including_zero_step_choices(self):
        choices = ['Risk of falls from greater than 2 metres',
                   'Work in an area with movement of powered mobile plant',
                   'Work on or near energised electrical installations or services']
        fields = default_fields()
        fields['high_risk_work'] = '\n'.join(choices)
        with self.pdf(fields) as document:
            headings = {}
            for index, page in enumerate(document.pages):
                words = page.extract_words(extra_attrs=['fontname', 'size'])
                section = [word for word in words if 'Bold' in word['fontname'] and abs(word['size'] - 8) < .01]
                text = ' '.join(word['text'] for word in section)
                for choice in choices:
                    if choice in text:
                        headings[choice] = (index, section)
            self.assertEqual(set(headings), set(choices))
            pages = [headings[choice][0] for choice in choices]
            self.assertEqual(len(set(pages)), 3)
            self.assertEqual(pages, sorted(pages))
            for choice, (index, words) in headings.items():
                self.assertAlmostEqual(min(word['top'] for word in words), 78.008, delta=.1, msg=choice)
                self.assertIn('Controls to Eliminate/Reduce Hazard', document.pages[index].extract_text())
            zero_step_page = document.pages[pages[1]].extract_text()
            self.assertNotIn('Access workface', zero_step_page)
            self.assertNotIn('Electrical Review', zero_step_page)

    def test_empty_people_and_unselected_work_types_do_not_create_placeholder_content(self):
        fields = default_fields()
        self.assertEqual(fields['reviewers'], [])
        self.assertEqual(fields['consultation'], [])
        self.assertEqual(fields['work_types'], [])
        with self.pdf(fields) as document:
            text = '\n'.join(page.extract_text() or '' for page in document.pages)
            self.assertNotIn('Person/s responsible for reviewing SWMS:', text)
            self.assertNotIn('This SWMS has been developed in consultation with:', text)
            self.assertNotIn('Type of Works', text)
            self.assertNotIn('Cutting sheets and angles', text)
        # An explicitly added blank person is still a real user-owned row.
        fields['reviewers'] = [{'name': '', 'position': '', 'signature': None}]
        with self.pdf(fields) as document:
            self.assertIn('Person/s responsible for reviewing SWMS:', document.pages[0].extract_text())

    def test_default_acknowledgement_is_one_line_and_long_custom_text_stays_readable(self):
        fields = default_fields()
        with self.pdf(fields) as document:
            hits = [hit for page in document.pages for hit in page.search(fields['acknowledgement'], regex=False)]
            self.assertEqual(len(hits), 1)
            self.assertEqual(len({round(char['top'], 2) for char in hits[0]['chars']}), 1)
            self.assertGreaterEqual(min(char['size'] for char in hits[0]['chars']), 7.1)
            for page in document.pages:
                footer = page.search('This PDF was created at', regex=False)[0]
                self.assertAlmostEqual(footer['x1'], PAGE_RIGHT, places=2)
        fields['acknowledgement'] = 'Custom acknowledgement remains readable and complete. ' * 60 + 'CUSTOM-ACK-END'
        with self.pdf(fields) as document:
            text = '\n'.join(page.extract_text() for page in document.pages)
            self.assertEqual(text.count('CUSTOM-ACK-END'), 1)
            hit = next(hit for page in document.pages for hit in page.search('CUSTOM-ACK-END', regex=False))
            self.assertGreaterEqual(min(char['size'] for char in hit['chars']), 7.1)

    def test_maximum_company_profile_remains_above_project_rows_without_title_overlap(self):
        company = {**DEFAULTS, **{key: 'W' * 120 for key in ('name', 'abn', 'phone', 'email')}}
        validate_company_settings(company)
        with self.pdf(company=company) as document:
            page = document.pages[0]
            company_chars = [char for char in page.chars if abs(char['size'] - 4.5) < .01]
            self.assertEqual(sum(char['text'] == 'W' for char in company_chars), 480)
            project_top = page.search('Job Reference', regex=False)[0]['top']
            title = page.search('SAFE WORK METHOD STATEMENT', regex=False)[0]
            self.assertLess(max(char['bottom'] for char in company_chars) + 15, project_top)
            self.assertGreater(min(char['x0'] for char in company_chars), title['x1'])
            self.assertTrue(all(0 <= char['top'] < char['bottom'] < project_top for char in company_chars))


if __name__ == '__main__':
    unittest.main()
