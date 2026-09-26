"""Synthetic evidence fixtures for Technical Library field presentation."""

from copy import deepcopy
import unittest
from unittest.mock import patch

from estimator.technical_fields import FIELD_LABELS, normalize_technical_item
from estimator.technical_field_reviewed import review_fingerprint


def item(*fields, **metadata):
    return {'id': 'synthetic-system', 'title': 'Synthetic system',
            'fields': [{'label': label, 'value': value} for label, value in fields],
            **metadata}


def values(projected):
    return {field['label']: field['value'] for field in projected['fields']}


class TechnicalFieldsTests(unittest.TestCase):
    def test_all_reviewed_label_families_are_accounted_for(self):
        # This set is the reviewed public field inventory, independent of the
        # private supplier bundle so CI can detect omissions without that data.
        reviewed = {
            'Aperture Seal Joints', 'Collar', 'Drawing number (diagram page 1) (Source Reference)',
            'Edge Profile', 'Fill Depth / Fillet Size', 'Fire Barrier Type (Selector Search)',
            'FRL', 'FRL (Source Reference)', 'FRL when Blank', 'ID', 'Install Notes',
            'Installation Concept', 'Installation concept', 'Installation Details', 'Lead Time',
            'Local Protection', 'Local Protection (Source Reference)',
            'Local Protection - installation instruction (Source Reference)',
            'Local Protection - source callout (Source Reference)',
            'Local Protection - source callouts (Source Reference)', 'Manufacturer',
            'Max Aperture Size', 'Max Opening Size', 'Penetration seal description', 'Product',
            'Protection', 'Refer Figure', 'Reference figure', 'Report Number', 'Separating Element',
            'Service', 'Service (Source Reference)', 'Service - source footnote (Source Reference)',
            'Service / core hole / annular gap (Source Reference)', 'Service Description',
            'Service Size', 'Service spacing (Source Reference)', 'Service Wrap',
            'Service Wrap (Source Reference)', 'Source / selector discrepancy (Source Reference)',
            'Source alternatives - approved services (Source Reference)',
            'Source alternatives - collar fixing table (Source Reference)',
            'Source alternatives - local protection configurations (Source Reference)',
            'Source discrepancy', 'Source discrepancy (diagram page 1) (Source Reference)',
            'Source Document Coverage', 'Source numbering note (diagram page 1) (Source Reference)',
            'Source option alignment', 'Source Reference Discrepancy (Source Reference)',
            'Source Reference Review', 'Source table notes', 'Substrate (Selector Search)',
            'Substrate / opening (Source Reference)', 'Support Construction',
            'System Recommendation', 'Type', 'Wrap - drawing name (Source Reference)',
            'Wrap - installation instruction (Source Reference)',
            'Wrap - source callout (Source Reference)',
        }
        self.assertEqual(set(FIELD_LABELS), reviewed)
        self.assertEqual(len(reviewed), 59)

    def test_canonical_labels_merge_exact_equivalents_and_preserve_conditions(self):
        source = item(('Max Aperture Size', '400 mm wide x 300 mm high, or equivalent area'),
                      ('Max Opening Size', '400 mm wide x 300 mm high, or equivalent area'),
                      ('Separating Element', 'Concrete wall, minimum 100 mm'),
                      ('Fire Barrier Type (Selector Search)', 'Wall'),
                      ('Type', 'Aperture Seal - Friction fit'),
                      ('Product', 'Two layers of sample board'),
                      ('System Recommendation', 'Two layers of sample board'))
        actual = values(normalize_technical_item(source))
        self.assertEqual(actual['Maximum Opening Size'], '400 mm wide x 300 mm high, or equivalent area')
        self.assertEqual(actual['Barrier Construction'], 'Concrete wall, minimum 100 mm')
        self.assertEqual(actual['Barrier Type'], 'Wall')
        self.assertEqual(actual['Installation Type'], 'Aperture Seal - Friction fit')
        self.assertEqual(actual['System Products'], 'Two layers of sample board')

    def test_blank_seal_rating_is_not_the_service_rating(self):
        actual = values(normalize_technical_item(item(('FRL', '-/60/60'), ('FRL when Blank', '-/120/120'))))
        self.assertEqual(actual['FRL'], '-/60/60')
        self.assertEqual(actual['Blank Seal FRL'], '-/120/120')
        self.assertNotIn('Source Issues', actual)

    def test_conflicting_ratings_remain_visible_with_attribution(self):
        actual = values(normalize_technical_item(item(('FRL', '-/60/60'), ('FRL (Source Reference)', '-/120/120'))))
        self.assertIn('-/60/60', actual['FRL'])
        self.assertIn('-/120/120', actual['FRL'])
        self.assertIn('Source reference: -/120/120', actual['FRL'])
        self.assertIn('disagree', actual['Source Issues'])
        self.assertNotIn('-/120/120', actual['Source Issues'])

    def test_unqualified_duplicate_rating_does_not_remove_qualification_or_create_conflict(self):
        actual = values(normalize_technical_item(item(('FRL', '-/120/120 (Minimum 90 mm board)'),
                        ('FRL (Source Reference)', '-/120/120'))))
        self.assertEqual(actual['FRL'], '-/120/120 (Minimum 90 mm board)')
        self.assertNotIn('Source Issues', actual)

    def test_lead_time_and_provenance_are_hidden_but_originals_untouched(self):
        source = item(('ID', 'S-1'), ('Lead Time', 'Three weeks'),
                      ('Source option alignment', 'Pair source option A with row A.'),
                      ('Source Document Coverage', 'One linked diagram is unavailable.'),
                      ('Source numbering note (diagram page 1) (Source Reference)', 'Repeated step numbers.'),
                      sources=[{'document_id': 'sample-report', 'page': 2}])
        original = deepcopy(source)
        projected = normalize_technical_item(source)
        self.assertEqual(source, original)
        self.assertEqual(values(projected), {'ID': 'S-1'})
        self.assertEqual(projected['diagram_status'], 'One linked diagram is unavailable.')
        self.assertEqual(projected['technical_basis']['source_fields'], original['fields'])
        self.assertEqual(projected['sources'], original['sources'])
        projected['technical_basis']['source_fields'][0]['value'] = 'Modified copy'
        self.assertEqual(source, original)

    def test_hidden_labels_ignore_case_and_surrounding_space(self):
        source = item((' Technical Basis ', 'Hidden evidence'),
                      ('technical basis', 'Hidden evidence two'),
                      (' LEAD TIME ', 'Never displayed'),
                      ('Document Revision', 'Old revision'))
        projected = normalize_technical_item(source)
        self.assertEqual(projected['fields'], [])
        self.assertEqual(projected['technical_basis']['source_fields'], source['fields'])

    def test_source_conflicts_and_clipped_text_are_not_hidden_as_provenance(self):
        routine = ('Selected source-reference fields were visually transcribed. '
                   'This is not a complete transcription or technical suitability approval; '
                   'retain the original diagram and all its conditions.')
        actual = values(normalize_technical_item(item(('Source Reference Review', routine),
                      ('Source Reference Review', 'Source image has clipped edges: opening size is unreadable.'),
                      ('Source / selector discrepancy (Source Reference)', 'Drawing says two collars; selector says one.'))))
        self.assertNotIn(routine, actual['Source Issues'])
        self.assertIn('opening size is unreadable', actual['Source Issues'])
        self.assertIn('selector says one', actual['Source Issues'])

    def test_diagram_merge_retains_roles_captions_and_figure_options(self):
        source = item()
        source['fields'] = [
            {'label': 'Installation Concept', 'value': 'Source option A: Figure 1; option B: Figure 2',
             'images': [{'id': 'diagram-1', 'caption': 'Option A, PDF page 3'}]},
            {'label': 'Reference figure', 'value': 'Figure 8',
             'images': [{'id': 'diagram-1', 'caption': 'Reference detail on PDF page 3'},
                        {'id': 'diagram-2', 'caption': 'Option B, PDF page 4'}]},
        ]
        diagrams = normalize_technical_item(source)['fields'][0]
        self.assertEqual(diagrams['label'], 'Diagrams & Figures')
        self.assertIn('option B: Figure 2', diagrams['value'])
        self.assertIn('Figure 8', diagrams['value'])
        self.assertEqual(len(diagrams['images']), 2)
        shared = diagrams['images'][0]
        self.assertIn('Option A, PDF page 3', shared['caption'])
        self.assertIn('Reference detail on PDF page 3', shared['caption'])
        self.assertEqual(shared['roles'], ['Installation concept', 'Reference figure'])

    def test_variant_table_rows_remain_paired_when_fields_are_merged(self):
        table_a = {'columns': ['Service', 'Wrap', 'FRL'],
                   'rows': [['Pipe A', '300 mm', '-/60/60'], ['Pipe B', '600 mm', '-/120/120']]}
        table_b = {'columns': ['Service', 'Wrap', 'FRL'],
                   'rows': [['Pipe C', '900 mm', '-/180/180']]}
        source = item()
        source['fields'] = [{'label': 'Service', 'value': '', 'table': table_a},
                            {'label': 'Service Description', 'value': '', 'table': table_b}]
        field = normalize_technical_item(source)['fields'][0]
        self.assertEqual(field['tables'], [table_a, table_b])
        self.assertNotIn('table', field)
        self.assertEqual(source['fields'][0]['table'], table_a)

    def test_conditional_source_options_are_not_flattened_into_unconditional_values(self):
        source = item(('Source alternatives - collar fixing table (Source Reference)',
                       'Pipe size | Tabs\n40 mm | 2\nUp to 100 mm | 3'))
        actual = values(normalize_technical_item(source))
        self.assertIn('Pipe size | Tabs\n40 mm | 2\nUp to 100 mm | 3', actual['Source Options'])
        self.assertNotIn('Service Size / Configuration', actual)

    def test_empty_fields_are_omitted_but_explicit_none_and_wrap_free_remain(self):
        actual = values(normalize_technical_item(item(('Collar', ''), ('Service', '  '),
                        ('Local Protection', 'None'), ('Service Wrap', 'Wrap Free'))))
        self.assertEqual(actual, {'Local Protection': 'None', 'Service Wrap': 'Wrap Free'})

    def test_explicit_legacy_instructions_take_precedence_over_unstructured_extract(self):
        source = item(('Installation instructions', 'Apply sample sealant continuously.'),
                      ('Application text extract', 'Duplicated extraction and contact information.'),
                      ('Source diagram details', 'Irrelevant title block.'))
        actual = values(normalize_technical_item(source))
        self.assertEqual(actual['Installation Details'], 'Apply sample sealant continuously.')
        self.assertEqual(len(normalize_technical_item(source)['technical_basis']['source_fields']), 3)

    def test_report_and_manufacturer_can_use_verified_structured_filter_values(self):
        source = item(filter_values={'document': ['SYN123456'], 'manufacturer': ['Sample supplier']})
        actual = values(normalize_technical_item(source))
        self.assertEqual(actual['Report Number'], 'SYN123456')
        self.assertEqual(actual['Manufacturer'], 'Sample supplier')
        self.assertNotIn('Manufacturer', values(normalize_technical_item(item(title='Sample supplier product'))))

    def test_projection_is_idempotent_and_unknown_fields_remain_visible(self):
        source = item(('Future installation constraint', 'Retain this condition.'))
        projected = normalize_technical_item(source)
        self.assertEqual(normalize_technical_item(projected), projected)
        self.assertEqual(values(projected)['Future installation constraint'], 'Retain this condition.')

    def test_private_review_metadata_is_hidden_and_reviewed_fields_are_used(self):
        source = item(('Service Description', 'Sample cable'))
        captured = []
        def capture(fields, review, original_fields):
            captured.extend(deepcopy(fields))
            return fields
        with patch('estimator.technical_fields.normalize_reviewed_content', side_effect=capture):
            normalize_technical_item(source)
        review = {'source_fields_sha256': review_fingerprint(source['fields']),
                  'pre_review_fields_sha256': review_fingerprint(captured),
                  'fields': [{'label': 'Service', 'value': 'Reviewed sample cable'}]}
        source['technical_field_review'] = review
        projected = normalize_technical_item(source)
        self.assertEqual(values(projected), {'Service': 'Reviewed sample cable'})
        self.assertNotIn('technical_field_review', projected)
        self.assertEqual(projected['technical_basis']['review'], review)
        self.assertEqual(source['technical_field_review'], review)


if __name__ == '__main__':
    unittest.main()
