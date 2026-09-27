from copy import deepcopy
import unittest

from estimator.library_display import display_subtitle, remove_resolved_source_notices
from estimator.technical_table_navigation import validate_table_navigation


class LibraryDisplayTests(unittest.TestCase):
    def test_subtitle_removes_only_standalone_table_metadata(self):
        self.assertEqual(display_subtitle('Report · Rev 2 · Table 3 · Vertical'),
                         'Report · Rev 2 · Vertical')
        self.assertEqual(display_subtitle('Tables 1–3 · Horizontal'), 'Horizontal')
        self.assertEqual(display_subtitle('Table-mounted equipment · Report'),
                         'Table-mounted equipment · Report')
        self.assertEqual(display_subtitle('Report · Table 4A'), 'Report')

    def test_resolved_selector_paragraph_does_not_hide_a_separate_issue(self):
        routine = ('example.pdf: the available diagram does not verify a service/wrap '
                   'configuration table for this entry. The service and wrap summary '
                   'remains attributed to the selector; no missing values have been inferred.')
        issue = 'The source and selector specify different pipe dimensions.'
        source = {'id': 'trafalgar-example', 'fields': [
            {'label': 'Source Issues', 'value': routine + '\n\n' + issue},
            {'label': 'Service Wrap', 'value': '100 mm'},
        ]}
        item = deepcopy(source)
        remove_resolved_source_notices(item)
        self.assertEqual(item['fields'][0]['value'], issue)
        self.assertEqual(item['fields'][1], source['fields'][1])
        self.assertIn(routine, source['fields'][0]['value'])
        item['fields'][0]['value'] = routine
        remove_resolved_source_notices(item)
        self.assertEqual([f['label'] for f in item['fields']], ['Service Wrap'])

    def test_unrelated_notices_are_retained(self):
        item = {'id': 'firefly-example', 'fields': [
            {'label': 'Source Issues', 'value': 'No matching diagram.'}]}
        original = deepcopy(item)
        remove_resolved_source_notices(item)
        self.assertEqual(item, original)
        item['id'] = 'trafalgar-example'
        original = deepcopy(item)
        remove_resolved_source_notices(item)
        self.assertEqual(item, original)

    def test_resolved_wrap_notice_preserves_lengths_scope_and_configuration_tables(self):
        notice = ('The publisher wrap text contains an unrecognised <gt/> element. '
                  'The comparison symbol is unresolved; verify the wrap length against the approval.')
        for length in (300, 400):
            with self.subTest(length=length):
                source = {'id': 'promat-example', 'fields': [
                    {'label': 'Source Issues', 'value': notice.replace('. The', '.\nThe')},
                    {'label': 'Service Wrap', 'value': f'SupaWrap; LI ({length}mm on top side)'},
                    {'label': 'Service Size / Configuration', 'value': '', 'table': {
                        'columns': ['Service', 'Service Wrap'],
                        'rows': [['Pipe A', '300mm'], ['Pipe B', '400mm']]}}
                ]}
                item = deepcopy(source)
                remove_resolved_source_notices(item)
                self.assertEqual(item['fields'], source['fields'][1:])
                self.assertEqual(source['fields'][0]['value'], notice.replace('. The', '.\nThe'))

    def test_title_clipping_resolution_preserves_adjacent_conflict_and_unreadable_dimensions(self):
        title = ('Source image has clipped edges: Left drawing-title labels clipped. '
                 'The missing text was not reconstructed.')
        conflict = 'Source conflict: wall material differs between the title and drawing.'
        dimensions = 'Source image has clipped edges: opening size is unreadable.'
        item = {'id': 'trafalgar-example', 'fields': [
            {'label': 'Source Issues', 'value': conflict + '\n' + title + '\n\n' + dimensions}]}
        remove_resolved_source_notices(item)
        self.assertEqual(item['fields'][0]['value'], conflict + '\n\n' + dimensions)

    def test_selector_resolution_applies_without_manufacturer_prefix(self):
        item = {'id': 'example', 'fields': [{'label': 'Source Issues', 'value':
            'drawing.pdf: the available diagram does not verify a service/wrap\n'
            'configuration table for this entry. The service and wrap summary remains '
            'attributed to the selector; no missing values have been inferred.'}]}
        remove_resolved_source_notices(item)
        self.assertEqual(item['fields'], [])

    def test_resolved_table_column_and_issue_link_removed_without_changing_row_pairings(self):
        notice = ('The publisher wrap text contains an unrecognised <gt/> element. '
                  'The comparison symbol is unresolved; verify the wrap length against the approval.')
        link = {'field': 'Service Size / Configuration', 'table_index': 0}
        source = {'id': 'promat-example', 'fields': [
            {'label': 'Service Size / Configuration', 'value': '', 'table': {
                'columns': ['FRL', 'Service Wrap', 'Source Issues'],
                'rows': [['-/120/120', '', ''], ['-/90/90', 'LI (300mm on top side)', notice]]},
                'table_row_ids': [['variant-a', 'variant-b']], 'table_captions': ['Source table']},
            {'label': 'FRL', 'value': '', 'table_links': [link]},
            {'label': 'Service Wrap', 'value': '', 'table_links': [link]},
            {'label': 'Source Issues', 'value': '', 'table_links': [link]},
        ]}
        item = deepcopy(source)
        remove_resolved_source_notices(item)
        table = item['fields'][0]['table']
        self.assertEqual(table['columns'], ['FRL', 'Service Wrap'])
        self.assertEqual(table['rows'], [['-/120/120', ''], ['-/90/90', 'LI (300mm on top side)']])
        self.assertEqual(item['fields'][0]['table_row_ids'], [['variant-a', 'variant-b']])
        self.assertEqual([f['label'] for f in item['fields']], ['Service Size / Configuration', 'FRL', 'Service Wrap'])
        self.assertEqual(source['fields'][0]['table']['rows'][1][-1], notice)
        validate_table_navigation(item['fields'])
        after = deepcopy(item)
        remove_resolved_source_notices(item)
        self.assertEqual(item, after)

    def test_mixed_table_issues_keep_the_column_and_link(self):
        resolved = ('Source image has clipped edges: Left drawing-title labels clipped. '
                    'The missing text was not reconstructed.')
        item = {'fields': [
            {'label': 'Service Size / Configuration', 'value': '', 'tables': [{
                'columns': ['FRL', 'Source Issues'],
                'rows': [['-/60/60', resolved], ['-/90/90', 'A separate unresolved discrepancy.']]}]},
            {'label': 'Source Issues', 'value': '', 'table_links': [
                {'field': 'Service Size / Configuration', 'table_index': 0}]}]}
        remove_resolved_source_notices(item)
        self.assertEqual(item['fields'][0]['tables'][0]['rows'],
                         [['-/60/60', ''], ['-/90/90', 'A separate unresolved discrepancy.']])
        self.assertEqual(len(item['fields']), 2)
        validate_table_navigation(item['fields'])

    def test_selector_depth_replaces_attributed_conflict_with_requested_summary(self):
        notice = ('The selector and source installation instruction use different seal-depth '
                  'descriptions. Both are attributed in Seal Depth / Fillet Size; neither overrides the other.')
        other = 'The source names TPS cables, not a general fire-cable class.'
        source = {'id': 'trafalgar-example', 'fields': [
            {'label': 'Seal Depth / Fillet Size', 'value':
                'Selector: 20mm (Both Sides) / No Fillet\n\nSource installation instruction: '
                'Fill FyreFLEX sealant in the annular gap to full depth, on both sides of the wall.'},
            {'label': 'Source Issues', 'value': notice + '\n\n' + other}]}
        item = deepcopy(source)
        remove_resolved_source_notices(item)
        self.assertEqual(item['fields'][0]['value'],
                         'Fill FyreFLEX sealant in the annular gap to max 20mm (Both Sides) / No Fillet')
        self.assertEqual(item['fields'][1]['value'], other)
        self.assertIn('Source installation instruction:', source['fields'][0]['value'])
        # Do not hide the notice when the depth or source instruction is unreviewed.
        for replacement in ('30mm (Both Sides) / No Fillet', '20mm (One Side) / No Fillet'):
            item = deepcopy(source)
            item['fields'][0]['value'] = item['fields'][0]['value'].replace('20mm (Both Sides) / No Fillet', replacement)
            original = deepcopy(item)
            remove_resolved_source_notices(item)
            self.assertEqual(item, original)

    def test_plasterboard_selector_depth_preserves_separate_maxilite_instruction(self):
        item = {'id': 'trafalgar-example', 'fields': [
            {'label': 'Seal Depth / Fillet Size', 'value':
                'Selector: Full depth of Plasterboard (Both Sides) / No Fillet\n\n'
                'Source installation instruction: Fill FyreFLEX sealant in the annular gap '
                'to 20mm depth on both sides of the wall + Maxilite.'},
            {'label': 'Source Issues', 'value':
                'The selector and source installation instruction use different seal-depth descriptions. '
                'Both are attributed in Seal Depth / Fillet Size; neither overrides the other.'}]}
        remove_resolved_source_notices(item)
        self.assertEqual(len(item['fields']), 1)
        self.assertEqual(item['fields'][0]['value'],
            'Fill FyreFLEX sealant in the annular gap to full depth of Plasterboard (Both Sides) / No Fillet. '
            'At the Maxilite, apply FyreFLEX sealant to 20mm depth on both sides.')


if __name__ == '__main__':
    unittest.main()
