import unittest

from estimator.revision_filenames import has_revision_filename, is_numbered_revision_filename, revision_filename


class RevisionFilenameTests(unittest.TestCase):
    def test_inspections_and_registers_have_fixed_stems_and_numeric_revisions(self):
        expected = {
            'passive_fire_register.pdf': 'PASSIVE_FIRE_INSPECTIONS',
            'passive_fire_registers.pdf': 'PASSIVE_FIRE_REGISTER',
            'duct_inspections.pdf': 'DUCT_INSPECTIONS',
            'duct_register.pdf': 'DUCT_REGISTER',
            'structural_steel_inspections.pdf': 'STEEL_INSPECTIONS',
            'structural_steel_register.pdf': 'STEEL_REGISTER',
        }
        for kind, stem in expected.items():
            with self.subTest(kind=kind):
                self.assertEqual(revision_filename(kind, 'previous.pdf'), f'{stem}.pdf')
                self.assertEqual(revision_filename(kind, 'previous-R9.pdf', 12), f'{stem}-12.pdf')
                self.assertTrue(has_revision_filename(kind, f'{stem}-12.pdf', 12))
                self.assertFalse(has_revision_filename(kind, f'{stem}-12.pdf', 11))
                self.assertFalse(has_revision_filename(kind, f'{stem}-R12.pdf', 12))

    def test_numbered_documents_use_the_actual_document_number_and_archive_revision(self):
        cases = (
            ('commercial.quote', 'BID-040', 'Quote-BID-040.pdf'),
            ('commercial.work_order', 'INSTALL-89', 'Work-Order-INSTALL-89-R7.pdf'),
            ('commercial.purchase_order', 'SUPPLY-021', 'Purchase-Order-SUPPLY-021-R7.pdf'),
            ('swms', 'SAFEWORK-01', 'SAFE-WORK-METHOD-STATEMENT-SAFEWORK-01-R7.pdf'),
        )
        for kind, reference, legacy in cases:
            with self.subTest(kind=kind):
                issued = f'{reference}-7.pdf'
                self.assertEqual(revision_filename(kind, issued), issued)
                self.assertEqual(revision_filename(kind, issued, 3), f'{reference}-3.pdf')
                self.assertEqual(revision_filename(kind, legacy, 3), f'{reference}-3.pdf')
                self.assertTrue(has_revision_filename(kind, issued, 7))
                self.assertFalse(has_revision_filename(kind, issued, 3))
                self.assertFalse(has_revision_filename(kind, legacy, 7))

    def test_unrelated_files_and_unrecognizable_legacy_numbers_keep_their_names(self):
        self.assertEqual(revision_filename('estimate.summary.pdf', 'BREAKDOWN-R2.pdf', 2), 'BREAKDOWN-R2.pdf')
        legacy = 'SAFE-WORK-METHOD-STATEMENT-123abcde-R9.pdf'
        self.assertEqual(revision_filename('swms', legacy, 2), legacy)
        self.assertFalse(has_revision_filename('swms', legacy, 9))
        self.assertTrue(is_numbered_revision_filename('CEASEFIRE-014-7.pdf'))
        self.assertFalse(is_numbered_revision_filename('CEASEFIRE-014-R7.pdf'))
        self.assertFalse(is_numbered_revision_filename('CEASEFIRE-000-7.pdf'))

    def test_numbered_revisions_require_a_positive_integer(self):
        for revision in (0, -1, True, '2'):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                revision_filename('duct_inspections.pdf', 'previous.pdf', revision)
