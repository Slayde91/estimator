"""Synthetic report strings only; supplier records remain private local data."""

import unittest

from scripts.trafalgar_reports import is_report_field, normalize_report_numbers, report_number_values


class TrafalgarReportTests(unittest.TestCase):
    def test_report_labels_accept_source_and_page_suffixes_only(self):
        for label in ('Report Number', 'report reference (diagram page 2) (Source Reference)',
                      'Report No.', 'Report no: source', 'Source Report Number',
                      'Based on Report No.', 'Test Report Number', 'Report #',
                      'Assessment Report Reference — source page 1', 'Report Numbers', 'Report'):
            with self.subTest(label=label):
                self.assertTrue(is_report_field(label))
        for label in ('Report Date', 'Report Revision', 'Source Report Revision',
                      'T-card number', 'Drawing number', 'Report Coverage', 'Installation Details', None):
            with self.subTest(label=label):
                self.assertFalse(is_report_field(label))

    def test_report_family_spacing_and_hyphens_are_deduplicated(self):
        self.assertEqual(report_number_values([
            'FC 54321 (Table 7)', 'fc54321 (Page 12)', 'FCO-4321 Table 9a',
            'FCO4321 (Table A2)', 'FAS345678', 'FAS 345678 (Table 2)',
        ]), ['FC 54321', 'FCO 4321', 'FAS 345678'])

    def test_multiple_reports_keep_source_order_across_separators(self):
        self.assertEqual(normalize_report_numbers([
            'FC 54321 (Table 6, 7, 11) & FAS 345678',
            '25SFR00123 / 24SFR00124, FCO4321\nFAR 4567',
            'FCO-4321 (Table 8)',
        ]), 'FC 54321; FAS 345678; 25SFR00123; 24SFR00124; FCO 4321; FAR 4567')

    def test_integral_suffixes_and_distinct_report_revisions_remain(self):
        self.assertEqual(report_number_values([
            'RTL FA 3456', 'RTL FA3456.02', 'RTL FA 3456.02',
            'TR-F67.03 (Specimen C)', 'IGNE-26011-02R', '223344 FTR02.4A',
        ]), ['RTL FA 3456', 'RTL FA 3456.02', 'TR-F67.03', 'IGNE-26011-02R', '223344 FTR02.4A'])

    def test_year_prefixes_and_leading_zeroes_are_preserved_without_typo_correction(self):
        self.assertEqual(normalize_report_numbers([
            '24SFR 00123 (Table 2)', '24SFR00123', '24FSR00123',
            'FTR 001 (Table 3)', 'PF34567', '223344 (Table 4)',
        ]), '24SFR00123; 24FSR00123; FTR 001; PF34567; 223344')

    def test_additional_report_families_keep_full_identifiers_and_suffixes(self):
        self.assertEqual(report_number_values([
            'RTLFT 2456', 'RTL FT2456 (Page 2)', 'RTLFA2456',
            'RT 300456', 'rt300456', 'TR002.4 0724', 'TR 002.4 0724 (Table 3)',
            'TR002.4 0824', 'TR002.5 0724',
        ]), ['RTL FT 2456', 'RTL FA 2456', 'RT 300456',
             'TR002.4 0724', 'TR002.4 0824', 'TR002.5 0724'])
        for value in ('RTLXX2456', 'TR002.4', 'RT300456 extra', 'TR002.4 0724 amended'):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, 'Unrecognized report'):
                    report_number_values(value)

    def test_locator_variants_and_irrelevant_dates_never_become_report_numbers(self):
        self.assertEqual(report_number_values([
            'FAR 4567 Clause 3.11.2', 'FAR 4567 3.11.3',
            'FCO 4321 (Table 13/14)', '26SFR00123\nSpecimen 17',
            'FC54321 (Table 10', 'FSP3456 Specimen 2',
            'Report date: 2026-09-26; Report No: FC 54321 (Page 223344)',
            'Date: 26/09/2026', 'Date: 26.09.2026', 'Date: 26 September 2026', 'Table 223344',
        ]), ['FAR 4567', 'FCO 4321', '26SFR00123', 'FC 54321', 'FSP 3456'])

    def test_known_unavailable_values_do_not_invent_an_identifier(self):
        self.assertEqual(normalize_report_numbers(['', '-', 'N/A', 'Contact Trafalgar', 'Not stated']), '')
        self.assertEqual(report_number_values('FC 54321'), ['FC 54321'])

    def test_unknown_report_formats_fail_instead_of_silently_disappearing(self):
        for value in ('XYZ-12345', 'FC 54321 & XYZ-12345', 'FC 54321 Rev 2',
                      'FCO 4321 and Report ABC-98765', 'Unspecified report pending review', '3.11.3'):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, 'Unrecognized report'):
                    report_number_values([value])
        with self.assertRaises(TypeError):
            report_number_values([123456])


if __name__ == '__main__':
    unittest.main()
