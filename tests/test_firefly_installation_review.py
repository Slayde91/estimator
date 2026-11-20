from copy import deepcopy
import unittest

from estimator.firefly_installation_review import firefly_reviewed_installation_fields, _BATT_SHA, _CORE_SHA


def case(system, fields, document='fas190235', page=44, sha=_BATT_SHA):
    fields = [{'label': 'ID', 'value': system}, *fields, {'label': 'Report Number', 'value': document.upper()}]
    record = {
        'filter_values': {'manufacturer': ['Firefly']},
        'fields': fields,
        'sources': [{'document_id': document, 'page': page, 'sha256': sha,
                     'label': f'{document.upper()}, Table 1, {system}, PDF page {page}'}],
    }
    return record, fields


def output(record, fields):
    return {field['label']: field for field in firefly_reviewed_installation_fields(record, fields)}


class FireflyInstallationReviewTests(unittest.TestCase):
    def test_moves_procedure_and_preserves_plain_wrap_status_and_provenance(self):
        record, fields = case('V16', [
            {'label': 'Service Wrap', 'value': 'None.'},
            {'label': 'Local Protection', 'value': '1. Maintain a 5 mm gap.\n2. Apply FIREFLYMastic HP (Item 74) '
                                                  'to the full\ndepth of the batt.',
             'source_labels': ['Local Protection']},
        ])
        before = deepcopy(record)
        result = output(record, fields)
        self.assertNotIn('Local Protection', result)
        self.assertEqual(result['Service Wrap']['value'], 'None.')
        self.assertEqual(result['Installation Details']['value'], '1. Maintain a 5 mm gap.\n'
                         '2. Apply FIREFLYMastic HP to the full depth of the batt.')
        self.assertEqual(result['Installation Details']['source_labels'], ['Local Protection'])
        self.assertEqual(record, before)
        self.assertEqual(output(record, list(result.values())), result)

    def test_keeps_scope_separate_from_wrap_and_protection_procedure(self):
        record, fields = case('V118 B', [
            {'label': 'Service Wrap', 'value': 'Secure the wrap with stainless steel cable ties.\n'
                                              'This service can be installed in wall constructions against Floors or ceilings '
                                              '(see\nTable 21, Item 9 for 3 sided Penowrap installation and cable sizes/cable bundle\n'
                                              'dimensions).'},
            {'label': 'Local Protection', 'value': 'Apply FIREFLYMastic to the cut edges, full depth of the batt.'},
        ])
        result = output(record, fields)
        self.assertEqual(result['Installation Details']['value'],
                         'Apply FIREFLYMastic to the cut edges, full depth of the batt.\n\n'
                         'Secure the wrap with stainless steel cable ties.')
        self.assertIn('three-sided wrap', result['Assessment Scope']['value'])

    def test_paper_wrap_is_preparation_before_sealant_and_keeps_no_service_wrap(self):
        record, fields = case('V53', [
            {'label': 'Service Wrap', 'value': 'None.\nPipe to be wrapped locally with grease proof paper prior to '
                                              'installation of the sealant.'},
            {'label': 'Local Protection', 'value': 'Fill the gap to the full depth with FIREFLYMastic HP.'},
        ])
        result = output(record, fields)
        self.assertEqual(result['Service Wrap']['value'], 'None')
        self.assertTrue(result['Installation Details']['value'].startswith('Pipe to be wrapped locally'))

    def test_core_continuation_sources_keep_plasterboard_and_masonry_fixings_distinct(self):
        for system, page, use, exclude in (
                ('V558C', 200, '38 mm plasterboard screws', '75 mm masonry screws'),
                ('V559B', 201, '75 mm masonry screws', '38 mm plasterboard screws')):
            with self.subTest(system=system):
                record, fields = case(system, [], 'fas190236', page, _CORE_SHA)
                result = output(record, fields)
                installation = result['Installation Details']
                self.assertIn(use, installation['value'])
                self.assertNotIn(exclude, installation['value'])
                self.assertNotIn('page', installation['value'])
                self.assertIn(f'PDF page {page - 1}', installation['source_labels'][0])
                self.assertIn('80%', result['Assessment Scope']['value'])
                record['sources'][0]['sha256'] = 'other edition'
                self.assertEqual(firefly_reviewed_installation_fields(record, fields), fields)

    def test_preexisting_installation_and_unknown_cross_reference_are_retained(self):
        record, fields = case('V1', [{'label': 'Installation Details', 'value': 'Existing reviewed installation.'},
                                     {'label': 'Local Protection', 'value': 'Fill the annular gap.'}])
        self.assertEqual(firefly_reviewed_installation_fields(record, fields), fields)
        record, fields = case('V1', [{'label': 'Local Protection', 'value': 'Install the seal as shown in Figure 4.'}])
        self.assertEqual(firefly_reviewed_installation_fields(record, fields), fields)

    def test_source_conflicts_cannot_be_promoted_into_instructions(self):
        record, fields = case('H115', [{'label': 'Local Protection', 'value':
            'Seal the annular gap with FIREFLYMastic HP. A 25 × 25 mm fillet of FIREFLYMastic HP (Item 6).'}])
        result = output(record, fields)
        self.assertNotIn('Installation Details', result)
        self.assertNotIn('Local Protection', result)
        self.assertIn('topside fillet', result['Assessment Scope']['value'])
        record, fields = case('H127', [{'label': 'Local Protection', 'value':
            'Seal the annular gap with FIREFLYMastic HP (Item 6).'}])
        result = output(record, fields)
        self.assertNotIn('Installation Details', result)
        self.assertNotIn('Local Protection', result)
        self.assertIn('Confirm the sealant', result['Assessment Scope']['value'])
        self.assertEqual(output(record, list(result.values())), result)


if __name__ == '__main__':
    unittest.main()
