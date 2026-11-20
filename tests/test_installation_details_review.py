import unittest

from estimator.installation_details_review import reviewed_installation_details
from estimator.trafalgar_fyreflex_installation import _SCOPE


class InstallationDetailsReviewTests(unittest.TestCase):
    def test_fyreflex_summary_honours_the_assessed_nb40_scope(self):
        record = {'id': 'trafalgar-selector-8653'}
        original = [{'label': label, 'value': value} for label, value in _SCOPE.items()]
        fields = reviewed_installation_details(record, original)
        review = {field['label']: field['value'] for field in fields}
        instructions = review['Installation Details']
        self.assertIn('medium-grade NB40 steel pipe', instructions)
        self.assertIn('minimum 40 × 40 mm', instructions)
        self.assertIn('both faces', instructions)
        self.assertNotRegex(instructions, r'\b(?:Table|Figure|Page)\b')
        self.assertIn('specifically lists NB40', review['Assessment Scope'])
        self.assertEqual(review['Service Size / Configuration'], 'Up to NB40')
        self.assertIs(reviewed_installation_details(record, fields), fields)

        other = [{**field, 'value': 'Hebel 100mm'} if field['label'] == 'Barrier Construction' else field
                 for field in original]
        self.assertIs(reviewed_installation_details(record, other), other)
