import unittest

from estimator.calculator import specification
from estimator.presentation import calculation_error_details, calculation_labels


class PresentationTests(unittest.TestCase):
    def test_all_calculated_outputs_have_plain_labels(self):
        labels = calculation_labels()
        self.assertFalse(set(specification()["formulas"]) - labels.keys())
        for cell in specification()["formulas"]:
            self.assertNotRegex(labels[cell], r"\b[A-Z]{1,3}[0-9]+\b")

    def test_duplicate_outputs_have_one_error_message(self):
        self.assertEqual(calculation_error_details({"errors": {"F7": "#N/A", "D28": "#N/A"}}),
                         [{"label": "Grand total", "code": "#N/A"}])
