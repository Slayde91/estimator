from copy import deepcopy
import unittest

from estimator.library_display import display_subtitle, remove_resolved_source_notices


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


if __name__ == '__main__':
    unittest.main()
