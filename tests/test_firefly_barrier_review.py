"""Synthetic source geometry plans; no supplier transcriptions are embedded."""

from copy import deepcopy
import unittest

from estimator.firefly_barrier_review import build_barrier_review
from estimator.technical_configuration_review import validate_configuration_review
from estimator.technical_field_reviewed import review_fingerprint


class BarrierReviewTests(unittest.TestCase):
    def setUp(self):
        self.source = {
            'id': 'sample-blank-seal',
            'fields': [{'label': 'Separating Element', 'value': 'Original evidence'},
                       {'label': 'Max Aperture Size', 'value': 'Original aperture'},
                       {'label': 'FRL when Blank', 'value': 'Original blank-seal ratings'}],
            'sources': [{'document_id': 'report', 'page': 3},
                        {'document_id': 'report', 'page': 4}],
        }
        self.fields = [
            {'label': 'Barrier Construction', 'value': 'Flattened source options',
             'source_labels': ['Separating Element']},
            {'label': 'Blank Seal FRL', 'value': 'Original rating'},
            {'label': 'Maximum Opening Size', 'value': 'Original sizes'},
            {'label': 'Installation Details', 'value': 'Retain the source installation steps.'},
            {'label': 'Diagrams & Figures', 'value': 'Source figure',
             'images': [{'id': 'figure-a'}]},
        ]
        self.args = {
            'rows': [['300 mm x 500 mm', 'Panel\nwall', '-/180/180'],
                     ['900 mm x 1200 mm', 'Framed\nwall', '-/60/60']],
            'row_ids': ['page3-row1', 'page4-row1'],
            'source_document_id': 'report', 'source_page': 3,
            'source_sha256': 'a' * 64,
            'source_fields_sha256': review_fingerprint(self.source['fields']),
            'pre_review_fields_sha256': 'b' * 64,
            'source_documents': {'report': {'sha256': 'a' * 64, 'pdf': True, 'pages': 4}},
            'maximum_opening': '900 mm x 1200 mm',
        }

    def build(self, **changes):
        return build_barrier_review(self.source, self.fields, **dict(self.args, **changes))

    def test_source_correspondence_summaries_links_and_images_survive_without_mutation(self):
        before = deepcopy((self.source, self.fields, self.args))
        result = self.build()
        fields = {field['label']: field for field in result['fields']}
        self.assertEqual(fields['Barrier Construction']['table'], {
            'columns': ['Max Aperture Size', 'Separating Element', 'FRL'],
            'rows': [['300 mm x 500 mm', 'Panel wall', '-/180/180'],
                     ['900 mm x 1200 mm', 'Framed wall', '-/60/60']],
        })
        self.assertEqual(fields['Barrier Construction']['value'], '')
        self.assertEqual(fields['Barrier Construction']['source_labels'], ['Separating Element'])
        self.assertEqual(fields['Blank Seal FRL']['value'], '-/60/60 to -/180/180')
        self.assertEqual(fields['Maximum Opening Size']['value'], '900 mm x 1200 mm')
        for label in ('Blank Seal FRL', 'Maximum Opening Size'):
            self.assertEqual(fields[label]['table_links'], [{'field': 'Barrier Construction', 'table_index': 0}])
        self.assertEqual(result['fields'][3:], self.fields[3:])
        validate_configuration_review(result, self.source, self.args['source_documents'])
        self.assertEqual((self.source, self.fields, self.args), before)

    def test_reviewed_merged_aperture_can_restore_a_missing_projected_summary(self):
        self.fields = [field for field in self.fields if field['label'] != 'Maximum Opening Size']
        with self.assertRaisesRegex(ValueError, 'nonempty aperture'):
            self.build()
        self.source['fields'][1]['value'] = ''
        self.args['source_fields_sha256'] = review_fingerprint(self.source['fields'])
        before = deepcopy(self.fields)
        result = self.build()
        field = next(f for f in result['fields'] if f['label'] == 'Maximum Opening Size')
        self.assertEqual(field['value'], '900 mm x 1200 mm')
        self.assertEqual(field['table_links'], [{'field': 'Barrier Construction', 'table_index': 0}])
        self.assertEqual(self.fields, before)

    def test_service_penetration_without_original_blank_seal_fields_is_ineligible(self):
        self.source['fields'] = [self.source['fields'][0]]
        self.args['source_fields_sha256'] = review_fingerprint(self.source['fields'])
        with self.assertRaisesRegex(ValueError, 'original blank-seal'):
            self.build()

    def test_qualified_ratings_keep_row_specific_scope_and_bare_summary(self):
        rows = deepcopy(self.args['rows'])
        rows[0][2] = '-/180/180\nFire from below only; self-weight only.'
        result = self.build(rows=rows, reviewed_ratings=['-/180/180', '-/60/60'])
        self.assertEqual(result['fields'][0]['table']['rows'][0][2],
                         '-/180/180 Fire from below only; self-weight only.')
        self.assertEqual(result['fields'][1]['value'], '-/60/60 to -/180/180')
        with self.assertRaisesRegex(ValueError, 'source ratings'):
            self.build(rows=rows)
        with self.assertRaisesRegex(ValueError, 'match its source'):
            self.build(rows=rows, reviewed_ratings=['-/240/240', '-/60/60'])

    def test_incomparable_ratings_are_listed_without_inventing_endpoints(self):
        rows = deepcopy(self.args['rows'])
        rows[0][2], rows[1][2] = '-/180/60', '-/120/120'
        self.assertEqual(self.build(rows=rows)['fields'][1]['value'], '-/180/60; -/120/120')
        rows[1][2] = '120/120/120'
        self.assertEqual(self.build(rows=rows)['fields'][1]['value'], '-/180/60; 120/120/120')

    def test_explicit_supporting_rating_inventory_does_not_raise_the_blank_seal_rating(self):
        rows = [['300 mm x 500 mm', 'Panel wall',
                 'Blank seal: -/120/120. Supporting wall: 180/180/180; lower governs.']]
        args = dict(rows=rows, row_ids=['page3-row1'], maximum_opening='300 mm x 500 mm',
                    reviewed_ratings=['-/120/120'])
        with self.assertRaisesRegex(ValueError, 'match its source'):
            self.build(**args)
        result = self.build(**args, supporting_ratings=[['180/180/180']])
        self.assertEqual(result['fields'][1]['value'], '-/120/120')
        self.assertEqual(result['fields'][0]['table']['rows'], rows)
        with self.assertRaisesRegex(ValueError, 'match its source'):
            self.build(**args, supporting_ratings=[['240/240/240']])

    def test_unstated_maximum_blank_source_cells_and_incomplete_inventory_reject(self):
        for change in ({'maximum_opening': '900 mm x 500 mm'},
                       {'row_ids': ['page3-row1']}, {'row_ids': ['same', 'same']},
                       {'rows': [['300 mm', 'Panel wall', '']]},
                       {'rows': [['300 mm', 'Panel wall']]},
                       {'reviewed_ratings': ['-/180/180']}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build(**change)

    def test_conditional_maxima_retain_source_values_and_cannot_match_numeric_tails(self):
        rows = deepcopy(self.args['rows'])
        rows[0][0] = '1300 mm x 1500 mm before lining'
        rows[1][0] = '1400 mm x 1200 mm after lining'
        with self.assertRaisesRegex(ValueError, 'stated in'):
            self.build(rows=rows, maximum_opening='300 mm x 1500 mm')
        result = self.build(rows=rows, maximum_opening=[row[0] for row in rows])
        self.assertEqual(result['fields'][2]['value'],
                         '1300 mm x 1500 mm before lining; 1400 mm x 1200 mm after lining')
        with self.assertRaisesRegex(ValueError, 'Duplicate barrier'):
            self.build(rows=[rows[0], rows[0]], maximum_opening=rows[0][0])

    def test_source_options_and_unreviewed_extra_rating_cannot_leak_or_be_dropped(self):
        rows = deepcopy(self.args['rows'])
        for prefix in ('Source option 1:', 'Source options 1, 2:', 'Source options 1 and 2:'):
            rows[0][1] = prefix + ' Panel wall'
            with self.subTest(prefix=prefix), self.assertRaisesRegex(ValueError, 'Source option'):
                self.build(rows=rows)
        rows[0][1] = 'Panel wall'
        rows[0][2] = '-/180/180 or -/90/90 for another construction'
        with self.assertRaisesRegex(ValueError, 'match its source'):
            self.build(rows=rows, reviewed_ratings=['-/180/180', '-/60/60'])

    def test_source_fingerprints_attached_pages_and_existing_editorial_binding_reject_drift(self):
        for change in ({'source_fields_sha256': 'c' * 64},
                       {'source_sha256': 'c' * 64}, {'source_page': 2},
                       {'pre_review_fields_sha256': 'bad'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build(**change)
        self.source['technical_field_review'] = {
            'fields': deepcopy(self.fields),
            'source_fields_sha256': self.args['source_fields_sha256'],
            'pre_review_fields_sha256': 'c' * 64,
        }
        with self.assertRaisesRegex(ValueError, 'editorial review changed'):
            self.build()

    def test_conditions_remain_in_existing_installation_details_without_exact_repetition(self):
        original = self.fields[3]['value']
        result = self.build(preserved_conditions=[original, 'Use the lower seal or support rating.',
                                                 'Use the lower seal or support rating.'])
        field = result['fields'][3]
        self.assertEqual(field['value'], original + '\n\nUse the lower seal or support rating.')
        self.assertEqual(field['table_links'], [{'field': 'Barrier Construction', 'table_index': 0}])

    def test_existing_tables_proofs_and_editorial_metadata_are_not_replaced(self):
        first = self.build()
        first['review_note'] = 'Existing private review metadata'
        other = deepcopy(first['fields'][0])
        other['label'] = 'Service Size / Configuration'
        first['fields'] = deepcopy(self.fields) + [other]
        first['configuration_sources'][0]['groups'][0]['tables'][0]['label'] = other['label']
        self.source['technical_field_review'] = deepcopy(first)
        self.fields = deepcopy(first['fields'])
        before = deepcopy((self.source, self.fields))
        result = self.build(rows=[['100 mm x 200 mm', 'Other wall', '-/90/90']],
                            row_ids=['page4-row2'], maximum_opening='100 mm x 200 mm')
        self.assertEqual(result['fields'][-1], other)
        self.assertEqual(result['fields'][0]['table']['rows'], [['100 mm x 200 mm', 'Other wall', '-/90/90']])
        self.assertEqual(result['configuration_sources'][0]['groups'][0],
                         first['configuration_sources'][0]['groups'][0])
        self.assertEqual(result['configuration_sources'][0]['groups'][1]['tables'][0]['table_index'], 0)
        self.assertEqual(result['review_note'], 'Existing private review metadata')
        self.assertEqual((self.source, self.fields), before)

    def test_modified_rows_are_rejected_by_existing_configuration_proof(self):
        result = self.build()
        result['fields'][0]['table']['rows'][0][2] = '-/60/60'
        with self.assertRaisesRegex(ValueError, 'table changed'):
            validate_configuration_review(result, self.source, self.args['source_documents'])

    def test_repeated_identical_import_rejects_without_duplicating_table_or_links(self):
        first = self.build()
        self.source['technical_field_review'] = deepcopy(first)
        self.fields = deepcopy(first['fields'])
        before = deepcopy((self.source, self.fields))
        with self.assertRaisesRegex(ValueError, 'do not duplicate'):
            self.build()
        self.assertEqual((self.source, self.fields), before)
        with self.assertRaisesRegex(ValueError, 'partially replace'):
            self.build(rows=[['100 mm x 200 mm', 'Other wall', '-/90/90']],
                       row_ids=['page4-row2'], maximum_opening='100 mm x 200 mm')


if __name__ == '__main__':
    unittest.main()
